/**
 * MotherDuck Concurrent Writers Example
 *
 * Several parts of an application write to one MotherDuck database at the
 * same time. MotherDuck gives each database one writer: the read/write
 * Duckling of the account that owns it. Every connection made with that
 * account's read/write token runs on that Duckling, where DuckDB's optimistic
 * concurrency control applies. Independent pipelines that should not share a
 * Duckling write to separate databases instead.
 *
 * The script shows four patterns:
 *
 * 1. A batching writer that turns thousands of small events from many
 *    producers into a few inserts, each sent as one JSON parameter.
 * 2. Concurrent appends from pooled connections, which do not conflict.
 * 3. Concurrent updates to the same rows, which conflict, retried with
 *    backoff inside transactions.
 * 4. Two services with their own DuckDB instances, sharing the writer
 *    account and upserting the same keys idempotently.
 *
 * Prerequisites:
 * - MOTHERDUCK_TOKEN: a read/write token. Read scaling tokens cannot write.
 * - Optional MOTHERDUCK_EXAMPLE_DB: database to use, `drizzle_examples` by
 *   default. The script creates it if needed and replaces only the tables it
 *   owns, which all start with `writers_`.
 *
 * Run with:
 *   MOTHERDUCK_TOKEN=token bun example/motherduck-concurrent-writers.ts
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
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

const events = pgTable('writers_events', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  kind: text('kind').notNull(),
  amount: doublePrecision('amount').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

const inventory = pgTable('writers_inventory', {
  sku: text('sku').primaryKey(),
  onHand: integer('on_hand').notNull(),
  reserved: integer('reserved').notNull(),
});

const customers = pgTable('writers_customers', {
  id: integer('id').primaryKey(),
  plan: text('plan').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

type EventRow = typeof events.$inferInsert;

/**
 * Inserts a batch as one JSON parameter. A multi-row VALUES insert binds one
 * parameter per column per row, which costs several times longer to bind
 * than a single JSON string unnested on the Duckling.
 */
async function insertEvents(db: DuckDBDatabase, rows: EventRow[]) {
  await db.execute(sql`
    INSERT INTO ${events} (id, source, kind, amount, created_at)
    SELECT unnest(
      from_json(${JSON.stringify(rows)}, ${sql.raw(`'[{"id":"VARCHAR","source":"VARCHAR","kind":"VARCHAR","amount":"DOUBLE","createdAt":"TIMESTAMPTZ"}]'`)}),
      recursive := true
    )
  `);
}

/**
 * Collects rows from any number of producers and writes them with one
 * insert per batch. Each insert is one round trip to MotherDuck, so batching
 * matters far more than connection count for ingestion.
 */
class EventBatcher {
  private buffer: EventRow[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  batches = 0;
  rows = 0;

  constructor(
    private readonly db: DuckDBDatabase,
    private readonly maxRows: number,
    private readonly maxDelayMs: number
  ) {}

  push(row: EventRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.maxRows) {
      void this.flush();
    } else {
      this.timer ??= setTimeout(() => void this.flush(), this.maxDelayMs);
    }
  }

  /** Writes the buffered rows. Batches are written one at a time. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return this.flushing;
    this.flushing = this.flushing.then(async () => {
      await insertEvents(this.db, batch);
      this.batches += 1;
      this.rows += batch.length;
    });
    return this.flushing;
  }
}

/**
 * True for errors a retry can resolve. Concurrent updates to one row fail
 * with a write-write conflict. Concurrent upserts of a new key both take the
 * insert path, so the later one fails at commit with a duplicate key. Retried,
 * it finds the row and takes the update path.
 */
function isConflict(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (/conflict|duplicate key/i.test(e.message)) return true;
  }
  return false;
}

/** Runs `work` and retries it on write conflicts with jittered backoff. */
async function withConflictRetry<T>(
  work: () => Promise<T>,
  stats: { retries: number },
  maxAttempts = 8
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isConflict(error) || attempt === maxAttempts) throw error;
      stats.retries += 1;
      const delay = Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  console.log(`  ${label}: ${(performance.now() - start).toFixed(0)} ms`);
  return result;
}

async function ensureDatabase(token: string, name: string): Promise<void> {
  const instance = await DuckDBInstance.create('md:', {
    motherduck_token: token,
  });
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE DATABASE IF NOT EXISTS "${name}"`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** One writer service: its own DuckDB instance, pool and session name. */
async function connectWriter(
  token: string,
  database: string,
  service: string,
  poolSize: number
) {
  const instance = await DuckDBInstance.create(
    `md:${database}?attach_mode=single`,
    { motherduck_token: token, motherduck_session_name: service }
  );
  const pool = createDuckDBConnectionPool(instance, { size: poolSize });
  const db = drizzle({ client: pool });
  return {
    db,
    pool,
    async close() {
      await pool.close();
      instance.closeSync();
    },
  };
}

async function main() {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) {
    console.error('Set MOTHERDUCK_TOKEN to a read/write MotherDuck token.');
    process.exit(1);
  }
  const database = process.env.MOTHERDUCK_EXAMPLE_DB ?? 'drizzle_examples';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('MOTHERDUCK_EXAMPLE_DB must be a plain identifier');
  }

  await ensureDatabase(token, database);
  const ingest = await connectWriter(token, database, 'writers-ingest', 4);
  const billing = await connectWriter(token, database, 'writers-billing', 2);
  const { db } = ingest;

  try {
    await db.execute(sql`
      CREATE OR REPLACE TABLE writers_events (
        id VARCHAR PRIMARY KEY,
        source VARCHAR NOT NULL,
        kind VARCHAR NOT NULL,
        amount DOUBLE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE OR REPLACE TABLE writers_inventory (
        sku VARCHAR PRIMARY KEY,
        on_hand INTEGER NOT NULL,
        reserved INTEGER NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE OR REPLACE TABLE writers_customers (
        id INTEGER PRIMARY KEY,
        plan VARCHAR NOT NULL,
        updated_by VARCHAR NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);

    console.log(`Writing to MotherDuck database "${database}"\n`);

    // 1. Row-at-a-time inserts pay one network round trip each. A batcher
    // lets many producers share a few large inserts instead.
    console.log('1. Batched ingestion from 8 producers');
    await timed('20 single-row inserts', async () => {
      for (let i = 0; i < 20; i += 1) {
        await db.insert(events).values({
          id: `single-${i}`,
          source: 'single',
          kind: 'page_view',
          amount: 0,
          createdAt: new Date(),
        });
      }
    });
    const batcher = new EventBatcher(db, 2_000, 50);
    await timed('8 producers x 2,000 events through the batcher', async () => {
      await Promise.all(
        Array.from({ length: 8 }, async (_, producer) => {
          for (let i = 0; i < 2_000; i += 1) {
            batcher.push({
              id: `p${producer}-${i}`,
              source: `producer-${producer}`,
              kind: i % 10 === 0 ? 'purchase' : 'page_view',
              amount: i % 10 === 0 ? 10 + (i % 90) : 0,
              createdAt: new Date(),
            });
            // Producers yield like request handlers would.
            if (i % 250 === 0) await new Promise((r) => setImmediate(r));
          }
        })
      );
      await batcher.flush();
    });
    console.log(
      `  ${batcher.rows.toLocaleString()} rows in ${batcher.batches} inserts`
    );

    // 2. Appends from different connections touch different rows, so
    // concurrent transactions commit without conflicts.
    console.log('\n2. Concurrent appends from pooled connections');
    await timed('4 transactions appending 5,000 rows each', () =>
      Promise.all(
        Array.from({ length: 4 }, (_, worker) =>
          db.transaction(async (tx) => {
            await tx.execute(sql`
              INSERT INTO writers_events
              SELECT
                'bulk-' || ${worker} || '-' || i,
                'bulk-' || ${worker},
                'import',
                (i % 100)::DOUBLE,
                now()
              FROM range(5000) AS t(i)
            `);
          })
        )
      )
    );
    console.log('  Pool after the burst:', ingest.pool.stats());

    // 3. Updates to the same row from concurrent transactions conflict.
    // The losing transaction rolls back and is retried, so no update is lost.
    console.log('\n3. Conflicting updates retried with backoff');
    await db.insert(inventory).values([
      { sku: 'duck-plush', onHand: 500, reserved: 0 },
      { sku: 'duck-mug', onHand: 200, reserved: 0 },
    ]);
    const retryStats = { retries: 0 };
    const reservations = 24;
    await timed(`${reservations} concurrent reservations`, () =>
      Promise.all(
        Array.from({ length: reservations }, (_, i) =>
          withConflictRetry(
            () =>
              db.transaction(async (tx) => {
                const sku = i % 3 === 0 ? 'duck-mug' : 'duck-plush';
                const [row] = await tx
                  .select()
                  .from(inventory)
                  .where(eq(inventory.sku, sku));
                if (!row || row.onHand - row.reserved < 1) {
                  throw new Error(`${sku} is sold out`);
                }
                await tx
                  .update(inventory)
                  .set({ reserved: sql`${inventory.reserved} + 1` })
                  .where(eq(inventory.sku, sku));
              }),
            retryStats
          )
        )
      )
    );
    console.table(await db.select().from(inventory).orderBy(inventory.sku));
    console.log(
      `  ${retryStats.retries} retries. Reserved totals match the ${reservations} requests.`
    );

    // 4. Two services with separate DuckDB instances write the same keys
    // through the same writer account. Upserts make each write idempotent,
    // and the retry helper absorbs conflicts between the services. The last
    // committed write wins.
    console.log('\n4. Idempotent upserts from two writer services');
    const upsertStats = { retries: 0 };
    const upsert = (service: string, writer: DuckDBDatabase, id: number) =>
      withConflictRetry(
        () =>
          writer
            .insert(customers)
            .values({
              id,
              plan: id % 2 === 0 ? 'business' : 'lite',
              updatedBy: service,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: customers.id,
              set: {
                plan: sql`excluded.plan`,
                updatedBy: sql`excluded.updated_by`,
                updatedAt: sql`excluded.updated_at`,
              },
            }),
        upsertStats
      );
    await timed('2 services x 10 upserts over the same 10 customers', () =>
      Promise.all([
        ...Array.from({ length: 10 }, (_, id) =>
          upsert('ingest', ingest.db, id)
        ),
        ...Array.from({ length: 10 }, (_, id) =>
          upsert('billing', billing.db, id)
        ),
      ])
    );
    const owners = await db
      .select({
        updatedBy: customers.updatedBy,
        rows: sql<number>`count(*)::int`,
      })
      .from(customers)
      .groupBy(customers.updatedBy)
      .orderBy(customers.updatedBy);
    console.table(owners);
    console.log(
      `  ${upsertStats.retries} retries. Every customer exists exactly once.`
    );

    const [totals] = await db
      .select({
        rows: sql<number>`count(*)::int`,
        purchases: sql<number>`count(*) filter (where ${events.kind} = 'purchase')::int`,
      })
      .from(events);
    console.log(
      `\nwriters_events holds ${totals!.rows.toLocaleString()} rows, ${totals!.purchases.toLocaleString()} purchases.`
    );
  } finally {
    await billing.close();
    await ingest.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
