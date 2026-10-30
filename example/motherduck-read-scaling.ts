/**
 * MotherDuck Read Scaling Example
 *
 * A customer-facing analytics backend serves dashboards to many users at
 * once. One writer loads data with a read/write token. Readers connect with
 * a read scaling token, which spreads them over a pool of read-only replica
 * Ducklings (4 by default, up to 16).
 *
 * The script:
 * - Seeds 2 million orders for 8 tenants with one CREATE TABLE AS statement.
 * - Routes each dashboard user to one of several reader instances, each with
 *   its own `session_name`. A user always lands on the same replica, which
 *   keeps that replica's cache warm, while users as a whole spread across
 *   replicas.
 * - Serves 96 dashboard requests from 24 users concurrently. Each request
 *   runs three typed queries in parallel on the reader's connection pool.
 * - Writes a new order and makes it visible to readers with
 *   CREATE SNAPSHOT on the writer and REFRESH DATABASE on the reader.
 *
 * Prerequisites:
 * - MOTHERDUCK_TOKEN: a read/write token, used for setup and writes.
 * - Optional MOTHERDUCK_READ_SCALING_TOKEN: a read scaling token for the
 *   readers. Without it, readers use the read/write token and every query
 *   runs on the single read/write Duckling.
 * - Optional MOTHERDUCK_EXAMPLE_DB: database to use, `drizzle_examples` by
 *   default. The script replaces only the `readers_orders` table.
 *
 * Run with:
 *   MOTHERDUCK_TOKEN=token MOTHERDUCK_READ_SCALING_TOKEN=rs_token \
 *     bun example/motherduck-read-scaling.ts
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import {
  createDuckDBConnectionPool,
  drizzle,
  type DuckDBDatabase,
} from '../src/index.ts';

type ConnectionPool = ReturnType<typeof createDuckDBConnectionPool>;

const orders = pgTable('readers_orders', {
  id: integer('id').notNull(),
  tenantId: integer('tenant_id').notNull(),
  region: text('region').notNull(),
  product: text('product').notNull(),
  amount: doublePrecision('amount').notNull(),
  orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull(),
});

const TENANTS = 8;
const USERS = 24;
const REQUESTS = 96;

type Reader = {
  name: string;
  db: DuckDBDatabase;
  pool: ConnectionPool;
  instance: DuckDBInstance;
  latencies: number[];
};

/**
 * Keeps one reader per replica slot. Each slot has a fixed `session_name`,
 * so MotherDuck pins it to one replica Duckling. Hashing the user ID picks
 * the slot, which gives every user a stable replica.
 */
class ReaderRouter {
  private constructor(private readonly readers: Reader[]) {}

  static async connect(
    database: string,
    token: string,
    slots: number,
    connectionsPerSlot: number
  ): Promise<ReaderRouter> {
    const readers = await Promise.all(
      Array.from({ length: slots }, async (_, slot) => {
        const name = `dashboard-replica-${slot}`;
        // The session name goes in the path, so the instance cache keeps one
        // instance per slot. The cache also lets other modules in the same
        // process reuse these instances instead of opening new ones.
        const instance = await DuckDBInstance.fromCache(
          `md:${database}?attach_mode=single&session_name=${name}`,
          {
            motherduck_token: token,
            // Release the replica soon after the last connection closes.
            motherduck_dbinstance_inactivity_ttl: '5m',
          }
        );
        const pool = createDuckDBConnectionPool(instance, {
          size: connectionsPerSlot,
          // Requests beyond the pool size wait in a bounded queue. A backend
          // should shed load once the queue is full rather than pile up work.
          acquireTimeout: 30_000,
          maxWaitingRequests: 100,
        });
        return {
          name,
          db: drizzle({ client: pool }),
          pool,
          instance,
          latencies: [],
        };
      })
    );
    return new ReaderRouter(readers);
  }

  forUser(userId: string): Reader {
    let hash = 0;
    for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return this.readers[hash % this.readers.length]!;
  }

  all(): readonly Reader[] {
    return this.readers;
  }

  async close(): Promise<void> {
    await Promise.all(this.readers.map((reader) => reader.pool.close()));
    for (const reader of this.readers) reader.instance.closeSync();
  }
}

/** One dashboard page: three independent queries run in parallel. */
async function loadDashboard(db: DuckDBDatabase, tenantId: number) {
  const since = sql`now() - INTERVAL 30 DAY`;
  const scope = and(
    eq(orders.tenantId, tenantId),
    gte(orders.orderedAt, since)
  );
  const [kpis, byRegion, topProducts] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*)::int`,
        revenue: sql<number>`round(sum(${orders.amount}), 2)`,
        averageOrder: sql<number>`round(avg(${orders.amount}), 2)`,
      })
      .from(orders)
      .where(scope),
    db
      .select({
        region: orders.region,
        revenue: sql<number>`round(sum(${orders.amount}), 2)`,
      })
      .from(orders)
      .where(scope)
      .groupBy(orders.region)
      .orderBy(desc(sql`2`)),
    db
      .select({
        product: orders.product,
        units: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(scope)
      .groupBy(orders.product)
      .orderBy(desc(sql`2`))
      .limit(5),
  ]);
  return { kpis: kpis[0]!, byRegion, topProducts };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

async function main() {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) {
    console.error('Set MOTHERDUCK_TOKEN to a read/write MotherDuck token.');
    process.exit(1);
  }
  const readToken = process.env.MOTHERDUCK_READ_SCALING_TOKEN;
  const database = process.env.MOTHERDUCK_EXAMPLE_DB ?? 'drizzle_examples';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('MOTHERDUCK_EXAMPLE_DB must be a plain identifier');
  }

  // The writer creates the database, because read scaling tokens cannot
  // create or attach databases.
  const writer = await drizzle({
    connection: { path: 'md:', options: { motherduck_token: token } },
    pool: { size: 2 },
  });

  let router: ReaderRouter | undefined;
  try {
    await writer.execute(sql.raw(`CREATE DATABASE IF NOT EXISTS ${database}`));
    await writer.execute(sql.raw(`USE ${database}`));

    console.log(`Seeding 2,000,000 orders in "${database}"...`);
    const seedStart = performance.now();
    await writer.execute(sql`
      CREATE OR REPLACE TABLE readers_orders AS
      SELECT
        i::INTEGER AS id,
        (i % ${TENANTS} + 1)::INTEGER AS tenant_id,
        ['us-east', 'us-west', 'eu-central', 'ap-south'][(i // ${TENANTS}) % 4 + 1] AS region,
        'product-' || lpad((((i // 32) * 7919) % 40)::VARCHAR, 2, '0') AS product,
        round(5 + ((i * 104729) % 50000) / 100.0, 2) AS amount,
        now() - to_seconds(((i * 15485863) % (90 * 86400))::BIGINT) AS ordered_at
      FROM range(2000000) AS t(i)
    `);
    // Replicas sync on their own within minutes. A snapshot publishes the
    // new table to them right away.
    await writer.execute(sql.raw(`CREATE SNAPSHOT OF ${database}`));
    console.log(
      `  Seeded and snapshotted in ${(performance.now() - seedStart).toFixed(0)} ms\n`
    );

    if (!readToken) {
      console.log(
        'MOTHERDUCK_READ_SCALING_TOKEN is not set, so readers use the read/write token.'
      );
      console.log(
        'Every reader then runs on the read/write Duckling instead of replicas.\n'
      );
    }
    router = await ReaderRouter.connect(database, readToken ?? token, 4, 3);
    // Only replicas need a refresh. The read/write Duckling already has
    // every committed write, and rejects REFRESH DATABASE.
    const refresh = async (reader: Reader) => {
      if (readToken) {
        await reader.db.execute(sql.raw(`REFRESH DATABASE ${database}`));
      }
    };
    await Promise.all(router.all().map(refresh));

    // Serve dashboards. Requests run concurrently. Each reader pool limits
    // how many queries its replica receives at once and queues the rest.
    console.log(
      `Serving ${REQUESTS} dashboard requests from ${USERS} users concurrently...`
    );
    const users = Array.from({ length: USERS }, (_, i) => ({
      id: `user-${i}`,
      tenantId: (i % TENANTS) + 1,
    }));
    // Each user opens pages one after another, like a person clicking
    // through a dashboard. All users browse at the same time.
    const serveStart = performance.now();
    const pages = (
      await Promise.all(
        users.map(async (user) => {
          const reader = router!.forUser(user.id);
          const visits = [];
          for (let i = 0; i < REQUESTS / USERS; i += 1) {
            const start = performance.now();
            const page = await loadDashboard(reader.db, user.tenantId);
            reader.latencies.push(performance.now() - start);
            visits.push({ user, page });
          }
          return visits;
        })
      )
    ).flat();
    const elapsed = performance.now() - serveStart;
    console.log(
      `  ${REQUESTS} pages (${REQUESTS * 3} queries) in ${elapsed.toFixed(0)} ms\n`
    );

    console.table(
      router.all().map((reader) => {
        const stats = reader.pool.stats();
        return {
          session: reader.name,
          requests: reader.latencies.length,
          p50Ms: Math.round(percentile(reader.latencies, 0.5)),
          p95Ms: Math.round(percentile(reader.latencies, 0.95)),
          connections: stats.created,
          queued: stats.queued,
          queueWaitMs: Math.round(stats.queueWaitMs),
        };
      })
    );

    const sample = pages.find((p) => p.user.tenantId === 1)!;
    console.log(`\nDashboard for tenant 1 (${sample.user.id}):`);
    console.log('  KPIs:', sample.page.kpis);
    console.table(sample.page.byRegion);

    // Read after write. The writer adds an order, then publishes a snapshot.
    // A reader sees it after REFRESH DATABASE. Without both steps, replicas
    // catch up on their own schedule.
    console.log('\nRead after write');
    const reader = router.forUser('user-0');
    const countBigOrders = async () => {
      const [row] = await reader.db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(eq(orders.tenantId, 1), gte(orders.amount, 10_000)));
      return row!.n;
    };
    console.log(`  Orders over 10,000 before: ${await countBigOrders()}`);
    await writer.insert(orders).values({
      id: 2_000_000,
      tenantId: 1,
      region: 'eu-central',
      product: 'product-enterprise',
      amount: 25_000,
      orderedAt: new Date(),
    });
    await writer.execute(sql.raw(`CREATE SNAPSHOT OF ${database}`));
    await refresh(reader);
    console.log(
      `  Orders over 10,000 after refresh: ${await countBigOrders()}`
    );
  } finally {
    await router?.close();
    await writer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
