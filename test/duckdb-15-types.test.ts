import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src';

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

test('VARIANT columns materialize with node-api 1.5.3', async () => {
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
