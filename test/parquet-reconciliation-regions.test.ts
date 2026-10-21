import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, expectTypeOf, test } from 'vitest';
import {
  parquetReconciliationByFile,
  regions,
} from '../example/parquet-analytics.ts';
import {
  parquetReconciliationWithRegions,
  runParquetDimensionReconciliation,
} from '../example/parquet-reconciliation-regions.ts';
import { drizzle } from '../src/index.ts';

test('labels mixed-region exports without dropping rejected or unmatched groups', async () => {
  const rows = await runParquetDimensionReconciliation();
  expectTypeOf(rows).toEqualTypeOf<
    {
      region: string | null;
      sourceFile: string;
      label: string | null;
      scanned: number;
      accepted: number;
      invalid: number;
      missing: number;
      revenue: number;
    }[]
  >();
  expect(
    rows.map((row) => ({ ...row, sourceFile: basename(row.sourceFile) }))
  ).toEqual([
    {
      region: 'east',
      sourceFile: 'mixed.parquet',
      label: 'Eastern region',
      scanned: 1,
      accepted: 0,
      invalid: 0,
      missing: 1,
      revenue: 0,
    },
    {
      region: 'unknown',
      sourceFile: 'mixed.parquet',
      label: null,
      scanned: 1,
      accepted: 0,
      invalid: 1,
      missing: 0,
      revenue: 0,
    },
    {
      region: 'west',
      sourceFile: 'missing.parquet',
      label: 'Western region',
      scanned: 1,
      accepted: 0,
      invalid: 0,
      missing: 1,
      revenue: 0,
    },
    {
      region: 'west',
      sourceFile: 'mixed.parquet',
      label: 'Western region',
      scanned: 2,
      accepted: 1,
      invalid: 1,
      missing: 0,
      revenue: 10.5,
    },
    {
      region: null,
      sourceFile: 'mixed.parquet',
      label: null,
      scanned: 2,
      accepted: 1,
      invalid: 0,
      missing: 1,
      revenue: 2.5,
    },
  ]);
  for (const row of rows) {
    expect(row.accepted + row.invalid + row.missing).toBe(row.scanned);
  }
  expect(rows.reduce((total, row) => total + row.scanned, 0)).toBe(7);
});

test('preserves source totals with duplicate labels or an empty lookup and rejects duplicate keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drizzle-parquet-join-'));
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const db = drizzle(connection);
    const path = join(directory, "mixed's.parquet");
    const missing = join(directory, 'missing.parquet');
    await db.execute(sql`COPY (SELECT * FROM (VALUES
      ('west', '1'), ('east', 'bad'), ('unknown', NULL), (NULL, '2')
    ) AS input(region, amount)) TO ${path} (FORMAT PARQUET)`);
    await db.execute(
      sql`CREATE TABLE regions (code TEXT PRIMARY KEY, label TEXT NOT NULL)`
    );
    await db.insert(regions).values([
      { code: 'west', label: 'Shared label' },
      { code: 'east', label: 'Shared label' },
      { code: 'north', label: 'Unused' },
    ]);
    const before = await parquetReconciliationByFile(db, path);
    const rows = await parquetReconciliationWithRegions(db, path);
    expect(rows.map(({ label, ...row }) => row)).toEqual(before);
    expect(rows.map(({ region, label }) => ({ region, label }))).toEqual([
      { region: 'east', label: 'Shared label' },
      { region: 'unknown', label: null },
      { region: 'west', label: 'Shared label' },
      { region: null, label: null },
    ]);
    await expect(
      db.insert(regions).values({ code: 'west', label: 'Duplicate' })
    ).rejects.toThrow(/duplicate key|primary key/i);
    expect(await parquetReconciliationWithRegions(db, path)).toEqual(rows);
    await db.delete(regions);
    const unlabelled = await parquetReconciliationWithRegions(db, path);
    expect(unlabelled.map(({ label, ...row }) => row)).toEqual(before);
    expect(unlabelled.every((row) => row.label === null)).toBe(true);
    await db.execute(
      sql`COPY (SELECT 'west' AS region) TO ${missing} (FORMAT PARQUET)`
    );
    await expect(parquetReconciliationWithRegions(db, missing)).rejects.toThrow(
      /amount/i
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
