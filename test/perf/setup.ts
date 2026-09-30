import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { drizzle, type DuckDBDatabase } from '../../src/index.ts';
import {
  closeClientConnection,
  type DuckDBConnectionPool,
} from '../../src/client.ts';
import { createDuckDBConnectionPool } from '../../src/pool.ts';
import type { PrepareCacheOption } from '../../src/options.ts';

export interface PerfHarness {
  connection: DuckDBConnection;
  db: DuckDBDatabase;
  instance: DuckDBInstance;
  mode: 'single';
}

export interface PooledPerfHarness {
  pool: DuckDBConnectionPool & { close(): Promise<void> };
  db: DuckDBDatabase;
  instance: DuckDBInstance;
  mode: 'pooled';
  poolSize: number;
}

export type AnyPerfHarness = PerfHarness | PooledPerfHarness;

export interface PerfHarnessOptions {
  /** Use connection pooling instead of single connection */
  pooled?: boolean;
  /** Pool size (default: 4) */
  poolSize?: number;
  /** Exact DECIMAL output for precision benchmarks. */
  decimalMode?: 'number' | 'string';
  /** Prepared statement cache configuration */
  prepareCache?: PrepareCacheOption;
}

export function createPerfHarness(
  options?: PerfHarnessOptions & { pooled?: false }
): Promise<PerfHarness>;
export function createPerfHarness(
  options: PerfHarnessOptions & { pooled: true }
): Promise<PooledPerfHarness>;
export function createPerfHarness(
  options: PerfHarnessOptions
): Promise<AnyPerfHarness>;
export async function createPerfHarness(
  options?: PerfHarnessOptions
): Promise<AnyPerfHarness> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  const drizzleConfig = {
    decimalMode: options?.decimalMode,
    prepareCache: options?.prepareCache,
  } as const;

  await seedFactTable(connection);
  await seedNarrowWide(connection);
  await seedArrayTable(connection);
  await createInsertTable(connection);
  await createPreparedTable(connection);
  await createComplexTable(connection);

  if (options?.pooled) {
    const poolSize = options.poolSize ?? 4;
    const pool = createDuckDBConnectionPool(instance, { size: poolSize });
    const db = drizzle({ client: pool, ...drizzleConfig });
    // Close the seeding connection - pool will create its own
    await closeClientConnection(connection);
    return { pool, db, instance, mode: 'pooled', poolSize };
  }

  const db = drizzle(connection, drizzleConfig);
  return { connection, db, instance, mode: 'single' };
}

export async function closePerfHarness(harness: AnyPerfHarness): Promise<void> {
  try {
    await harness.db.close();
  } finally {
    harness.instance.closeSync();
  }
}

async function seedFactTable(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    create table fact_large as
    select
      i as id,
      i % 100 as mod100,
      i % 10 as cat,
      (i * 0.1)::double as value,
      concat('payload-', i) as payload
    from range(0, 100000) as t(i);
  `);

  await connection.run(
    'create index fact_large_mod_idx on fact_large(mod100);'
  );
}

async function seedNarrowWide(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    create table narrow_wide as
    select
      i as id,
      i % 5 as flag,
      concat('txt-', i % 20) as t1,
      concat('txt-', (i + 1) % 20) as t2,
      (i * 1.5)::double as m1,
      ((i % 7) * 3)::double as m2,
      (i % 11) as small_int,
      (i % 3 = 0) as is_multiple_of_3
    from range(0, 2000) as t(i);
  `);
}

async function seedArrayTable(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    create table array_table as
    select
      i as id,
      [i, i + 1, i + 2]::integer[] as seq_array,
      [concat('a-', i), concat('b-', i)] as tag_list
    from range(0, 5000) as t(i);
  `);
}

async function createInsertTable(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    drop table if exists bench_insert;
    create table bench_insert (
      id integer primary key,
      val text
    );
  `);
}

async function createPreparedTable(
  connection: DuckDBConnection
): Promise<void> {
  await connection.run(`
    drop table if exists bench_prepared;
    create table bench_prepared as
    select i as id, concat('val-', i) as val
    from range(0, 200) as t(i);
  `);
}

async function createComplexTable(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    drop table if exists bench_complex;
    create table bench_complex (
      id integer,
      meta struct(version integer, tag text),
      attrs map(text, text),
      nums integer[],
      tags text[]
    );
  `);
}
