import { expect, expectTypeOf, test } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '../src/index.ts';
import {
  parquetRevenue,
  runParquetAnalytics,
} from '../example/parquet-analytics.ts';

test('composes file scans, schema union, partitions and null filtering', async () => {
  const rows = await runParquetAnalytics();
  expectTypeOf(rows).toEqualTypeOf<
    {
      region: string;
      orders: number;
      revenue: number;
    }[]
  >();
  expect(rows).toEqual([
    { region: 'east', orders: 1, revenue: 7 },
    { region: 'west', orders: 2, revenue: 15 },
  ]);
});

test('binds both a glob and file lists without injecting path text', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const db = drizzle(connection);
    for (const paths of [
      "/tmp/it's/*.parquet",
      ["x'); DROP TABLE sales; --.parquet"],
    ]) {
      const query = parquetRevenue(db, paths).toSQL();
      expect(query.params).toEqual([paths, true, true]);
      expect(query.sql).not.toContain(
        typeof paths === 'string' ? paths : paths[0]
      );
    }
  } finally {
    connection.closeSync();
  }
});
