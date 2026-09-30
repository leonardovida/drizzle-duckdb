import { expect, expectTypeOf, test } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, motherDuckReadParquet, sumN } from '../src/index.ts';
import { sql } from 'drizzle-orm';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parquetRevenue,
  parquetReconciliation,
  runParquetAnalytics,
  runParquetDimensionAnalytics,
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

test('reconciles accepted, invalid and missing amounts across real files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drizzle-parquet-audit-'));
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const db = drizzle(connection);
    const west = join(directory, 'region=west');
    const east = join(directory, 'region=east');
    await mkdir(west);
    await mkdir(east);
    const numeric = join(west, 'numeric.parquet');
    const invalid = join(west, 'invalid.parquet');
    const missing = join(west, 'missing.parquet');
    const eastInvalid = join(east, 'invalid.parquet');
    await db.execute(
      sql`COPY (SELECT '10.50' AS amount UNION ALL SELECT '4.50') TO ${numeric} (FORMAT PARQUET)`
    );
    await db.execute(
      sql`COPY (SELECT 'bad' AS amount) TO ${invalid} (FORMAT PARQUET)`
    );
    await db.execute(
      sql`COPY (SELECT 'pending' AS status) TO ${missing} (FORMAT PARQUET)`
    );
    await db.execute(
      sql`COPY (SELECT 'too large' AS amount) TO ${eastInvalid} (FORMAT PARQUET)`
    );

    const rows = await parquetReconciliation(db, [
      numeric,
      invalid,
      missing,
      eastInvalid,
    ]);
    expectTypeOf(rows).toEqualTypeOf<
      {
        region: string;
        scanned: number;
        accepted: number;
        invalid: number;
        missing: number;
        revenue: number;
      }[]
    >();
    expect(rows).toEqual([
      {
        region: 'east',
        scanned: 1,
        accepted: 0,
        invalid: 1,
        missing: 0,
        revenue: 0,
      },
      {
        region: 'west',
        scanned: 4,
        accepted: 2,
        invalid: 1,
        missing: 1,
        revenue: 15,
      },
    ]);
    expect(
      rows.every(
        (row) => row.accepted + row.invalid + row.missing === row.scanned
      )
    ).toBe(true);
  } finally {
    try {
      connection.closeSync();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('joins file sales to unique region keys without losing unmatched revenue', async () => {
  const rows = await runParquetDimensionAnalytics();
  expectTypeOf(rows).toEqualTypeOf<
    { region: string; label: string | null; orders: number; revenue: number }[]
  >();
  expect(rows).toEqual([
    { region: 'east', label: null, orders: 1, revenue: 7 },
    { region: 'west', label: 'Western region', orders: 2, revenue: 15 },
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

test('diagnoses missing and text amounts and recovers with an explicit numeric contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drizzle-parquet-schema-'));
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const db = drizzle(connection);
    const missing = join(directory, 'missing.parquet');
    const numericText = join(directory, 'numeric-text.parquet');
    const invalidText = join(directory, 'invalid-text.parquet');
    await db.execute(
      sql`COPY (SELECT 'west' AS region, 'pending' AS status) TO ${missing} (FORMAT PARQUET)`
    );
    await db.execute(
      sql`COPY (SELECT 'west' AS region, '10.50' AS amount UNION ALL SELECT 'west', '4.50') TO ${numericText} (FORMAT PARQUET)`
    );
    await db.execute(
      sql`COPY (SELECT 'west' AS region, 'invalid' AS amount) TO ${invalidText} (FORMAT PARQUET)`
    );

    // union_by_name cannot synthesize a column absent from every file.
    await expect(parquetRevenue(db, [missing])).rejects.toThrow(/amount/i);
    // mapWith(Number) maps results, not the input to DuckDB's SUM.
    await expect(parquetRevenue(db, [numericText])).rejects.toThrow(
      /sum\(VARCHAR\)/i
    );
    const source = motherDuckReadParquet([numericText], {
      named: { union_by_name: true, hive_partitioning: true },
    });
    const schema = await db.execute(sql`DESCRIBE SELECT * FROM ${source}`);
    expect(schema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column_name: 'amount',
          column_type: 'VARCHAR',
        }),
      ])
    );

    const numericRevenue = (path: string) =>
      db
        .select({ revenue: sumN(sql`CAST(amount AS DECIMAL(18, 2))`) })
        .from(motherDuckReadParquet(path));
    expect(await numericRevenue(numericText)).toEqual([{ revenue: 15 }]);
    // Reject malformed data rather than silently dropping it via TRY_CAST.
    await expect(numericRevenue(invalidText)).rejects.toThrow(
      /convert.*invalid/i
    );
    expect(await db.execute(sql`SELECT 1 AS ok`)).toEqual([{ ok: 1 }]);
  } finally {
    try {
      connection.closeSync();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
