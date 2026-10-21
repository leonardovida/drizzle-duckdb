import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { eq, isNotNull, sql, type SQLWrapper } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  countN,
  drizzle,
  motherDuckReadParquet,
  sumN,
  type DuckDBDatabase,
} from '../src/index.ts';

// These selections declare the expected file schema, not runtime validation.
function parquetSales(db: DuckDBDatabase, paths: string | string[]) {
  return db
    .select({
      region: sql<string>`region`.as('region'),
      amount: sql<number | null>`amount`.mapWith(Number).as('amount'),
    })
    .from(
      motherDuckReadParquet(paths, {
        named: { union_by_name: true, hive_partitioning: true },
      })
    )
    .as('sales');
}

export function parquetRevenue(db: DuckDBDatabase, paths: string | string[]) {
  const sales = parquetSales(db, paths);

  return db
    .select({
      region: sales.region,
      orders: countN(),
      revenue: sumN(sales.amount),
    })
    .from(sales)
    .where(isNotNull(sales.amount))
    .groupBy(sales.region)
    .orderBy(sales.region);
}

// Keep all scanned rows visible when an export mixes numeric text and bad data.
function reconciliationMeasures(
  rawAmount: SQLWrapper,
  parsedAmount: SQLWrapper
) {
  return {
    scanned: countN().as('scanned'),
    accepted: countN(
      sql`CASE WHEN ${rawAmount} IS NOT NULL AND ${parsedAmount} IS NOT NULL THEN 1 END`
    ).as('accepted'),
    invalid: countN(
      sql`CASE WHEN ${rawAmount} IS NOT NULL AND ${parsedAmount} IS NULL THEN 1 END`
    ).as('invalid'),
    missing: countN(sql`CASE WHEN ${rawAmount} IS NULL THEN 1 END`).as(
      'missing'
    ),
    revenue: sql<number>`COALESCE(SUM(${parsedAmount}), 0)`
      .mapWith(Number)
      .as('revenue'),
  };
}

export function parquetReconciliation(
  db: DuckDBDatabase,
  paths: string | string[]
) {
  const sales = db
    .select({
      region: sql<string | null>`region`.as('region'),
      rawAmount: sql<string | null>`amount`.as('raw_amount'),
      parsedAmount: sql<string | null>`TRY_CAST(amount AS DECIMAL(18, 2))`.as(
        'parsed_amount'
      ),
    })
    .from(
      motherDuckReadParquet(paths, {
        named: { union_by_name: true, hive_partitioning: true },
      })
    )
    .as('sales');

  return db
    .select({
      region: sales.region,
      ...reconciliationMeasures(sales.rawAmount, sales.parsedAmount),
    })
    .from(sales)
    .groupBy(sales.region)
    .orderBy(sales.region);
}

// Attribute rejected rows to a file without changing the region-only report.
export function parquetReconciliationByFile(
  db: DuckDBDatabase,
  paths: string | string[]
) {
  const sales = db
    .select({
      region: sql<string | null>`region`.as('region'),
      sourceFile: sql<string>`_export_file`.as('source_file'),
      rawAmount: sql<string | null>`amount`.as('raw_amount'),
      parsedAmount: sql<string | null>`TRY_CAST(amount AS DECIMAL(18, 2))`.as(
        'parsed_amount'
      ),
    })
    .from(
      motherDuckReadParquet(paths, {
        named: {
          union_by_name: true,
          hive_partitioning: true,
          filename: '_export_file',
        },
      })
    )
    .as('sales');

  return db
    .select({
      region: sales.region,
      sourceFile: sales.sourceFile,
      ...reconciliationMeasures(sales.rawAmount, sales.parsedAmount),
    })
    .from(sales)
    .groupBy(sales.region, sales.sourceFile)
    .orderBy(sales.region, sales.sourceFile);
}

export const regions = pgTable('regions', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
});

export function parquetRevenueByRegion(
  db: DuckDBDatabase,
  paths: string | string[]
) {
  const sales = parquetSales(db, paths);
  return db
    .select({
      region: sales.region,
      label: regions.label,
      orders: countN(),
      revenue: sumN(sales.amount),
    })
    .from(sales)
    .leftJoin(regions, eq(sales.region, regions.code))
    .where(isNotNull(sales.amount))
    .groupBy(sales.region, regions.label)
    .orderBy(sales.region);
}

async function withParquetFixtures<T>(
  report: (db: DuckDBDatabase, paths: string[]) => PromiseLike<T>
) {
  const directory = await mkdtemp(join(tmpdir(), 'drizzle-parquet-'));
  let connection: DuckDBConnection | undefined;
  try {
    const instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    const db = drizzle(connection);
    const west = join(directory, 'region=west');
    const east = join(directory, 'region=east');
    await mkdir(west);
    await mkdir(east);
    const paths = [
      join(west, "first's.parquet"),
      join(west, 'second.parquet'),
      join(east, 'third.parquet'),
    ];
    await db.execute(
      sql`COPY (SELECT 10.5 AS amount UNION ALL SELECT 4.5) TO ${paths[0]} (FORMAT PARQUET)`
    );
    // The newer export lacks amount. union_by_name fills it with NULL.
    await db.execute(
      sql`COPY (SELECT 'pending' AS status) TO ${paths[1]} (FORMAT PARQUET)`
    );
    await db.execute(
      sql`COPY (SELECT 7 AS amount) TO ${paths[2]} (FORMAT PARQUET)`
    );
    return await report(db, paths);
  } finally {
    try {
      connection?.closeSync();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function runParquetAnalytics() {
  return withParquetFixtures(parquetRevenue);
}

export function runParquetDimensionAnalytics() {
  return withParquetFixtures(async (db, paths) => {
    await db.execute(
      sql`CREATE TABLE regions (code TEXT PRIMARY KEY, label TEXT NOT NULL)`
    );
    // East is intentionally unmatched. North has no sales and must not appear.
    await db.insert(regions).values([
      { code: 'west', label: 'Western region' },
      { code: 'north', label: 'Northern region' },
    ]);
    return await parquetRevenueByRegion(db, paths);
  });
}

export function runParquetReconciliation() {
  return withParquetFixtures(async (db, paths) => {
    const rejected = join(dirname(paths[0]!), 'rejected.parquet');
    await db.execute(
      sql`COPY (SELECT 'bad' AS amount) TO ${rejected} (FORMAT PARQUET)`
    );
    return await parquetReconciliationByFile(db, [...paths, rejected]);
  });
}

if (import.meta.main) {
  const run = process.argv.includes('--reconcile')
    ? runParquetReconciliation
    : runParquetDimensionAnalytics;
  run()
    .then(console.table)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
