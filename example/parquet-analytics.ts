import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { isNotNull, sql } from 'drizzle-orm';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countN,
  drizzle,
  motherDuckReadParquet,
  sumN,
  type DuckDBDatabase,
} from '../src/index.ts';

// These selections declare the expected file schema, not runtime validation.
export function parquetRevenue(db: DuckDBDatabase, paths: string | string[]) {
  const sales = db
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

export async function runParquetAnalytics() {
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
    return await parquetRevenue(db, paths);
  } finally {
    try {
      connection?.closeSync();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  runParquetAnalytics()
    .then(console.table)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
