import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';
import { parquetReconciliationByFile, regions } from './parquet-analytics.ts';

// Enrich after aggregation so every source/region group stays visible.
export function parquetReconciliationWithRegions(
  db: DuckDBDatabase,
  paths: string | string[]
) {
  const reconciled = parquetReconciliationByFile(db, paths).as('reconciled');
  return db
    .select({
      region: reconciled.region,
      sourceFile: reconciled.sourceFile,
      label: regions.label,
      scanned: reconciled.scanned,
      accepted: reconciled.accepted,
      invalid: reconciled.invalid,
      missing: reconciled.missing,
      revenue: reconciled.revenue,
    })
    .from(reconciled)
    .leftJoin(regions, eq(reconciled.region, regions.code))
    .orderBy(reconciled.region, reconciled.sourceFile);
}

export async function runParquetDimensionReconciliation() {
  const directory = await mkdtemp(join(tmpdir(), 'drizzle-parquet-regions-'));
  let connection: DuckDBConnection | undefined;
  try {
    const instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    const db = drizzle(connection);
    const mixed = join(directory, 'mixed.parquet');
    const missing = join(directory, 'missing.parquet');
    await db.execute(sql`
      COPY (SELECT * FROM (VALUES
        ('west', '10.50'), ('west', 'bad'), ('east', NULL),
        ('unknown', 'bad'), (NULL, '2.50'), (NULL, NULL)
      ) AS input(region, amount)) TO ${mixed} (FORMAT PARQUET)
    `);
    // union_by_name fills amount with NULL for this newer export.
    await db.execute(sql`COPY (SELECT 'west' AS region, 'pending' AS status)
      TO ${missing} (FORMAT PARQUET)`);
    await db.execute(
      sql`CREATE TABLE regions (code TEXT PRIMARY KEY, label TEXT NOT NULL)`
    );
    await db.insert(regions).values([
      { code: 'west', label: 'Western region' },
      { code: 'east', label: 'Eastern region' },
      { code: 'north', label: 'Northern region' },
    ]);
    return await parquetReconciliationWithRegions(db, [mixed, missing]);
  } finally {
    try {
      connection?.closeSync();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  runParquetDimensionReconciliation()
    .then(console.table)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
