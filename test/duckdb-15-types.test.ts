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

test('VARIANT columns materialize native JavaScript values', async () => {
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

  const rawRows = await db.execute<{ data: unknown }>(
    sql`select data from duckdb_variant_test order by id`
  );

  expect(rawRows).toEqual([{ data: 42 }, { data: { name: 'Alice' } }]);

  const rows = await db.execute(
    sql`select cast(data as varchar) as data_text from duckdb_variant_test order by id`
  );

  expect(rows[0]).toEqual({ data_text: '42' });
  expect(rows[1]?.data_text).toContain('Alice');
});

test('GEOMETRY columns materialize as binary values', async () => {
  await db.execute(sql`
    create table duckdb_geometry_test (
      id integer,
      geom geometry
    )
  `);
  await db.execute(sql`
    insert into duckdb_geometry_test values
      (1, 'POINT(1 2)'::geometry)
  `);

  const rawRows = await db.execute<{ geom: Buffer }>(
    sql`select geom from duckdb_geometry_test`
  );

  expect(Buffer.isBuffer(rawRows[0]?.geom)).toBe(true);

  const textRows = await db.execute<{ geom_wkt: string }>(
    sql`select cast(geom as varchar) as geom_wkt from duckdb_geometry_test`
  );

  expect(textRows[0]).toEqual({ geom_wkt: 'POINT (1 2)' });
});
