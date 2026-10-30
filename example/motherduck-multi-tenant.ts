/**
 * MotherDuck Multi-Tenant Example
 *
 * A SaaS backend keeps each customer's data in its own MotherDuck database.
 * The script:
 *
 * - Provisions one database per tenant and runs the same Drizzle migrations
 *   on each of them (`example/migrations/tenant`).
 * - Routes requests through a tenant registry. It opens a tenant's
 *   connection on first use with `attach_mode=single`, so the connection
 *   attaches only that tenant's database, and `saas_mode=true`, which blocks
 *   access to the server's local files. It closes the least recently used
 *   tenant when too many are open.
 * - Serves concurrent requests for several tenants and enforces a per-tenant
 *   usage limit inside a transaction.
 * - Builds an internal cross-tenant report from the admin connection.
 *
 * For strict isolation, MotherDuck recommends one service account per
 * customer. Each service account has its own Duckling, so one tenant's load
 * cannot slow another. Pass their tokens in MOTHERDUCK_TENANT_TOKENS and the
 * registry connects each tenant with its own token. Without it, every tenant
 * database lives in the account of MOTHERDUCK_TOKEN and shares its Duckling.
 *
 * Prerequisites:
 * - MOTHERDUCK_TOKEN: a read/write token for the admin account.
 * - Optional MOTHERDUCK_TENANT_TOKENS: JSON such as
 *   {"acme":"token","globex":"token","initech":"token"}.
 * - Optional KEEP_TENANT_DATABASES=1 keeps the tenant databases. By default
 *   the script drops the `drizzle_examples_tenant_*` databases it created.
 *
 * Run with:
 *   MOTHERDUCK_TOKEN=token bun example/motherduck-multi-tenant.ts
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { and, eq, gte, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { fileURLToPath } from 'node:url';
import {
  createDuckDBConnectionPool,
  drizzle,
  migrate,
  type DuckDBDatabase,
} from '../src/index.ts';

type ConnectionPool = ReturnType<typeof createDuckDBConnectionPool>;

const accounts = pgTable('accounts', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull(),
  monthlyLimit: integer('monthly_limit').default(10_000),
});

const usageEvents = pgTable('usage_events', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  feature: text('feature').notNull(),
  units: integer('units').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

const TENANTS = ['acme', 'globex', 'initech'] as const;
type Tenant = (typeof TENANTS)[number];

const migrationsFolder = fileURLToPath(
  new URL('./migrations/tenant', import.meta.url)
);

function tenantDatabase(tenant: Tenant): string {
  return `drizzle_examples_tenant_${tenant}`;
}

type TenantConnection = {
  ready: Promise<{
    db: DuckDBDatabase;
    pool: ConnectionPool;
    instance: DuckDBInstance;
  }>;
  /** Requests currently using this tenant. Only idle tenants are closed. */
  active: number;
};

/**
 * Opens tenant connections on demand and keeps about `maxOpen` of them.
 * Each tenant gets its own DuckDB instance, so its settings and attached
 * database never mix with another tenant's. When more tenants are open than
 * allowed, the least recently used idle tenant is closed. Tenants with
 * requests in flight stay open until those requests finish.
 */
class TenantRegistry {
  private readonly open = new Map<Tenant, TenantConnection>();
  opened = 0;
  closed = 0;

  constructor(
    private readonly tokenFor: (tenant: Tenant) => string,
    private readonly maxOpen: number
  ) {}

  /** Runs `work` with the tenant's database and releases it afterwards. */
  async use<T>(
    tenant: Tenant,
    work: (db: DuckDBDatabase) => Promise<T>
  ): Promise<T> {
    let connection = this.open.get(tenant);
    if (connection) {
      // Move the tenant to the most recently used position.
      this.open.delete(tenant);
    } else {
      connection = { ready: this.connect(tenant), active: 0 };
      this.opened += 1;
    }
    this.open.set(tenant, connection);
    connection.active += 1;
    try {
      return await work((await connection.ready).db);
    } finally {
      connection.active -= 1;
      await this.evictIdle();
    }
  }

  private async connect(tenant: Tenant) {
    const instance = await DuckDBInstance.create(
      `md:${tenantDatabase(tenant)}?attach_mode=single&saas_mode=true`,
      {
        motherduck_token: this.tokenFor(tenant),
        motherduck_session_name: `tenant-${tenant}`,
      }
    );
    const pool = createDuckDBConnectionPool(instance, { size: 2 });
    return { db: drizzle({ client: pool }), pool, instance };
  }

  private async evictIdle(): Promise<void> {
    for (const [tenant, connection] of this.open) {
      if (this.open.size <= this.maxOpen) return;
      if (connection.active > 0) continue;
      this.open.delete(tenant);
      this.closed += 1;
      await this.shutdown(connection);
    }
  }

  private async shutdown(connection: TenantConnection): Promise<void> {
    const { pool, instance } = await connection.ready;
    await pool.close();
    instance.closeSync();
  }

  async close(): Promise<void> {
    const connections = [...this.open.values()];
    this.open.clear();
    await Promise.all(connections.map((c) => this.shutdown(c)));
  }
}

/** Records usage unless it would take the account over its monthly limit. */
async function recordUsage(
  db: DuckDBDatabase,
  event: { id: number; accountId: number; feature: string; units: number }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ limit: accounts.monthlyLimit })
      .from(accounts)
      .where(eq(accounts.id, event.accountId));
    const [used] = await tx
      .select({
        units: sql<number>`coalesce(sum(${usageEvents.units}), 0)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.accountId, event.accountId),
          gte(usageEvents.occurredAt, sql`date_trunc('month', now())`)
        )
      );
    const limit = account?.limit ?? 10_000;
    if (!account || used!.units + event.units > limit) return false;
    await tx.insert(usageEvents).values({ ...event, occurredAt: new Date() });
    return true;
  });
}

async function main() {
  const adminToken = process.env.MOTHERDUCK_TOKEN;
  if (!adminToken) {
    console.error('Set MOTHERDUCK_TOKEN to a read/write MotherDuck token.');
    process.exit(1);
  }
  const tenantTokens: Partial<Record<Tenant, string>> = process.env
    .MOTHERDUCK_TENANT_TOKENS
    ? JSON.parse(process.env.MOTHERDUCK_TENANT_TOKENS)
    : {};
  const tokenFor = (tenant: Tenant) => tenantTokens[tenant] ?? adminToken;
  const sharedAccount = TENANTS.every((tenant) => !tenantTokens[tenant]);

  // 1. Provision. Each tenant's database is created with that tenant's
  // token, so it lands in the tenant's own account when one is configured.
  console.log('1. Provisioning tenant databases and running migrations');
  for (const tenant of TENANTS) {
    const name = tenantDatabase(tenant);
    const setup = await drizzle({
      connection: {
        path: 'md:',
        options: { motherduck_token: tokenFor(tenant) },
      },
      pool: false,
    });
    try {
      await setup.execute(sql.raw(`CREATE DATABASE IF NOT EXISTS ${name}`));
      await setup.execute(sql.raw(`USE ${name}`));
      await migrate(setup, { migrationsFolder });
      await setup
        .insert(accounts)
        .values([
          {
            id: 1,
            name: `${tenant} analytics`,
            plan: 'business',
            monthlyLimit: 5_000,
          },
          { id: 2, name: `${tenant} sandbox`, plan: 'lite', monthlyLimit: 500 },
        ])
        .onConflictDoNothing();
      console.log(`  ${name}: migrated`);
    } finally {
      await setup.close();
    }
  }

  const registry = new TenantRegistry(tokenFor, 2);
  try {
    // 2. Concurrent requests for all tenants. The registry keeps two tenants
    // open, so the third one evicts the least recently used.
    console.log('\n2. Serving 60 usage requests across 3 tenants in 3 waves');
    // Tenants are served in parallel. Requests for one tenant run in order,
    // as a per-tenant queue would run them, so two limit checks for the same
    // account never race. Each wave brings in a tenant the previous wave did
    // not use, which makes the registry close the least recently used one.
    let nextId = Date.now() % 1_000_000_000;
    const outcomes: { tenant: Tenant; accepted: boolean }[] = [];
    const waves: Tenant[][] = [
      ['acme', 'globex'],
      ['initech', 'globex'],
      ['acme', 'initech'],
    ];
    for (const wave of waves) {
      await Promise.all(
        wave.map(async (tenant) => {
          for (let i = 0; i < 10; i += 1) {
            const accepted = await registry.use(tenant, (db) =>
              recordUsage(db, {
                id: nextId++,
                accountId: (i % 2) + 1,
                feature: i % 3 === 0 ? 'ai_prompt' : 'query',
                units: 40 + (i % 5) * 10,
              })
            );
            outcomes.push({ tenant, accepted });
          }
        })
      );
    }
    console.table(
      TENANTS.map((tenant) => ({
        tenant,
        accepted: outcomes.filter((o) => o.tenant === tenant && o.accepted)
          .length,
        rejectedOverLimit: outcomes.filter(
          (o) => o.tenant === tenant && !o.accepted
        ).length,
      }))
    );
    console.log(
      `  Opened ${registry.opened} tenant connections, closed ${registry.closed} idle ones.`
    );

    // 3. A tenant connection attaches only that tenant's database.
    const attached = await registry.use('acme', (db) =>
      db.execute<{ database_name: string }>(sql`
        SELECT database_name FROM duckdb_databases()
        WHERE NOT internal AND type = 'motherduck'
      `)
    );
    console.log(
      `\n3. Databases attached on the acme connection: ${attached.map((r) => r.database_name).join(', ')}`
    );
  } finally {
    await registry.close();
  }

  // 4. Internal reporting reads every tenant from the admin account. With
  // per-tenant service accounts, the admin would attach a share of each
  // tenant database instead.
  const admin = await drizzle({
    connection: { path: 'md:', options: { motherduck_token: adminToken } },
    pool: false,
  });
  try {
    if (sharedAccount) {
      console.log('\n4. Cross-tenant usage report from the admin connection');
      const report = await admin.execute(
        sql.join(
          TENANTS.map(
            (tenant) => sql`
              SELECT
                ${tenant} AS tenant,
                feature,
                count(*)::int AS events,
                sum(units)::int AS units
              FROM ${sql.raw(tenantDatabase(tenant))}.main.usage_events
              GROUP BY feature
            `
          ),
          sql` UNION ALL `
        )
      );
      console.table(report);
    } else {
      console.log(
        '\n4. Skipped the cross-tenant report. Tenant data lives in separate accounts.'
      );
    }

    if (process.env.KEEP_TENANT_DATABASES !== '1' && sharedAccount) {
      for (const tenant of TENANTS) {
        await admin.execute(
          sql.raw(`DROP DATABASE IF EXISTS ${tenantDatabase(tenant)}`)
        );
      }
      console.log('\nDropped the example tenant databases.');
    }
  } finally {
    await admin.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
