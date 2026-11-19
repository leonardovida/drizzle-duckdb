import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../../src/driver.ts';
import { createDuckDBConnectionPool } from '../../src/pool.ts';
import {
  clearTransformCache,
  transformSQL,
} from '../../src/sql/ast-transformer.ts';
import {
  closePerfHarness,
  createPerfHarness,
  perfBench,
  type PerfHarness,
} from './setup.ts';
import { factLarge } from './schema.ts';

let harness: PerfHarness;
let pooled: DuckDBDatabase;
let precise: DuckDBDatabase;
let precisionInstance: DuckDBInstance;
const expectedChecksum = 4_999_950_000;
const scan = 'select * from fact_large';
const lookup = sql`select sum(id) as checksum from fact_large where mod100 = ${42}`;
const count = sql`select count(*)::integer as n from fact_large`;
const decimalQuery = sql`select (i / 10)::decimal(38,10) as amount from range(10000) t(i)`;

function checkRows(rows: unknown[][]) {
  if (
    rows.length !== 100000 ||
    rows.reduce((sum, row) => sum + Number(row[0]), 0) !== expectedChecksum
  )
    throw new Error('Scan checksum mismatch');
}

beforeAll(async () => {
  harness = await createPerfHarness();
  pooled = drizzle(createDuckDBConnectionPool(harness.instance, { size: 4 }));
  precisionInstance = await DuckDBInstance.create(':memory:');
  precise = drizzle(await precisionInstance.connect(), {
    decimalMode: 'string',
  });
});
afterAll(async () => {
  await pooled.close();
  await precise.close();
  precisionInstance.closeSync();
  await closePerfHarness(harness);
});

describe('paired execution paths', () => {
  perfBench('paired scan native rows', 700, async () => {
    checkRows(await (await harness.connection.run(scan)).getRowsJS());
  });
  perfBench('paired scan raw objects', 700, async () => {
    const rows = await harness.db.execute(sql.raw(scan));
    if (
      rows.length !== 100000 ||
      rows.reduce((sum, row) => sum + Number(row.id), 0) !== expectedChecksum
    )
      throw new Error('Raw checksum mismatch');
  });
  perfBench('paired scan builder', 700, async () => {
    const rows = await harness.db.select().from(factLarge);
    if (
      rows.length !== 100000 ||
      rows.reduce((sum, row) => sum + Number(row.id), 0) !== expectedChecksum
    )
      throw new Error('Builder checksum mismatch');
  });
  perfBench('paired lookup query', 700, async () => {
    const rows = await harness.db.execute(lookup);
    if (rows.length !== 1 || rows[0]?.checksum !== 49_992_000n)
      throw new Error('Lookup checksum mismatch');
  });
  for (const mode of ['single', 'pool-4'] as const) {
    perfBench(`paired concurrency-8 ${mode}`, 700, async () => {
      const db = mode === 'single' ? harness.db : pooled;
      const results = await Promise.all(
        Array.from({ length: 8 }, () => db.execute(count))
      );
      if (results.some((rows) => rows[0]?.n !== 100000))
        throw new Error('Concurrent count mismatch');
    });
  }
  perfBench('paired decimal approximate', 700, async () => {
    const rows = await harness.db.execute(decimalQuery);
    if (rows.length !== 10000 || rows[9999]?.amount !== 999.9)
      throw new Error('Decimal conversion mismatch');
  });
  perfBench('paired decimal exact strings', 700, async () => {
    const rows = await precise.execute(decimalQuery);
    if (rows.length !== 10000 || rows[9999]?.amount !== '999.9000000000')
      throw new Error('Exact decimal conversion mismatch');
  });
});

describe('paired AST rewriting', () => {
  const query = "select array_upper(ARRAY['a','b'],1) as n";
  perfBench('paired AST cold', 400, () => {
    clearTransformCache();
    if (!transformSQL(query, { qualifyJoinColumns: false }).transformed)
      throw new Error('AST rewrite failed');
  });
  perfBench('paired AST warm', 400, () => {
    if (!transformSQL(query, { qualifyJoinColumns: false }).transformed)
      throw new Error('AST rewrite failed');
  });
});
