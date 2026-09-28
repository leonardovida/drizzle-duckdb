import { createRequire } from 'node:module';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src';

// @duckdb/node-api releases from 1.5.0-r.1 through 1.5.3-r.1 cannot read
// VARIANT result columns (type id 0 before 1.5.3, unhandled id 41 in
// 1.5.3-r.1). The library then throws its unsupported column error, which is
// the expected behavior on those releases. Materialization works from
// 1.5.3-r.2. DuckDB 1.4.x rejects the VARIANT column type, which the test
// handles below.
const nodeApiVersion = (
  createRequire(import.meta.url)('@duckdb/node-api/package.json') as {
    version: string;
  }
).version;
const nodeApiKey = nodeApiVersion
  .split(/[.-]r?\.?/)
  .map((part) => part.padStart(4, '0'))
  .join('.');
const testVariant = test.skipIf(
  nodeApiKey >= '0001.0005.0000.0001' && nodeApiKey < '0001.0005.0003.0002'
);

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let db: DuckDBDatabase;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);
});

afterAll(() => {
  connection?.closeSync();
  instance?.closeSync?.();
});

testVariant('VARIANT columns materialize with node-api 1.5.x', async () => {
  try {
    await db.execute(
      sql`create table duckdb_variant_test (id integer, data variant)`
    );
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/variant|syntax error|type/i);
    return;
  }

  await db.execute(sql`
    insert into duckdb_variant_test values
      (1, 42::variant),
      (2, {'name': 'Alice'}::variant)
  `);

  const variantRows = await db.execute(
    sql`select data from duckdb_variant_test order by id`
  );
  expect(variantRows).toEqual([{ data: 42 }, { data: { name: 'Alice' } }]);

  const rows = await db.execute(
    sql`select cast(data as varchar) as data_text from duckdb_variant_test order by id`
  );

  expect(rows[0]).toEqual({ data_text: '42' });
  expect(rows[1]?.data_text).toContain('Alice');
});
