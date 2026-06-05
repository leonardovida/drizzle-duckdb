import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  anyValue,
  avgN,
  denseRank,
  drizzle,
  lag,
  lanceFts,
  lanceHybridSearch,
  lanceVectorSearch,
  lead,
  median,
  motherDuckReadCsvAuto,
  motherDuckReadJsonAuto,
  motherDuckReadParquet,
  motherDuckTableFunction,
  olap,
  percentileCont,
  rank,
  rowNumber,
  sumDistinctN,
  sumN,
} from '../src';
import type { DuckDBDatabase } from '../src';
import { DuckDBDialect } from '../src/dialect.ts';

const numbers = pgTable('olap_numbers', {
  id: integer('id').primaryKey(),
  val: integer('val').notNull(),
});

const windowed = pgTable('olap_windowed', {
  id: integer('id').primaryKey(),
  amount: integer('amount').notNull(),
});

const sales = pgTable('olap_sales', {
  region: text('region').notNull(),
  product: text('product').notNull(),
  qty: integer('qty').notNull(),
});

let connection: DuckDBConnection;
let db: DuckDBDatabase;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);

  await db.execute(sql`
    create table if not exists ${numbers} (
      id integer primary key,
      val integer not null
    )
  `);

  await db.execute(sql`
    create table if not exists ${windowed} (
      id integer primary key,
      amount integer not null
    )
  `);

  await db.execute(sql`
    create table if not exists ${sales} (
      region text not null,
      product text not null,
      qty integer not null
    )
  `);
});

beforeEach(async () => {
  await db.execute(sql`delete from ${numbers}`);
  await db.execute(sql`delete from ${windowed}`);
  await db.execute(sql`delete from ${sales}`);
});

afterAll(() => {
  connection?.closeSync();
});

test('percentileCont and median return numbers', async () => {
  await db.insert(numbers).values([
    { id: 1, val: 10 },
    { id: 2, val: 20 },
    { id: 3, val: 30 },
    { id: 4, val: 40 },
    { id: 5, val: 50 },
  ]);

  const [row] = await db
    .select({
      p50: percentileCont(0.5, numbers.val),
      med: median(numbers.val),
    })
    .from(numbers);

  expect(row.p50).toBe(30);
  expect(row.med).toBe(30);
});

test('window helpers: rowNumber, denseRank, lag', async () => {
  await db.insert(windowed).values([
    { id: 1, amount: 5 },
    { id: 2, amount: 10 },
    { id: 3, amount: 10 },
    { id: 4, amount: 20 },
  ]);

  const rows = await db
    .select({
      id: windowed.id,
      rn: rowNumber({ orderBy: windowed.id }),
      dr: denseRank({ orderBy: windowed.amount }),
      prevAmount: lag<number>(windowed.amount, 1, sql`-1`, {
        orderBy: windowed.id,
      }),
    })
    .from(windowed)
    .orderBy(windowed.id);

  expect(rows.map((r) => r.rn)).toEqual([1, 2, 3, 4]);
  expect(rows.map((r) => r.dr)).toEqual([1, 2, 2, 3]);
  expect(rows.map((r) => r.prevAmount)).toEqual([-1, 5, 10, 10]);
});

test('olap builder injects any_value for non-aggregated selections', async () => {
  await db.insert(sales).values([
    { region: 'west', product: 'widget', qty: 2 },
    { region: 'west', product: 'gadget', qty: 3 },
    { region: 'east', product: 'widget', qty: 1 },
  ]);

  const rows = await olap(db)
    .from(sales)
    .groupBy([sales.region])
    .selectNonAggregates({ sampleProduct: sales.product }, { anyValue: true })
    .measures({
      totalQty: sumN(sales.qty),
      avgQty: avgN(sales.qty),
    })
    .orderBy(sales.region)
    .run();

  expect(rows).toHaveLength(2);

  const west = rows.find((r) => r['olap_sales.region'] === 'west');
  const east = rows.find((r) => r['olap_sales.region'] === 'east');

  expect(west?.totalQty).toBe(5);
  expect(east?.totalQty).toBe(1);
  expect(west?.sampleProduct).toBeDefined();
  expect(east?.sampleProduct).toBeDefined();
});

test('sumDistinctN deduplicates before summing', async () => {
  await db.insert(numbers).values([
    { id: 1, val: 10 },
    { id: 2, val: 10 },
    { id: 3, val: 20 },
    { id: 4, val: 20 },
    { id: 5, val: 30 },
  ]);

  const [row] = await db
    .select({
      regularSum: sumN(numbers.val),
      distinctSum: sumDistinctN(numbers.val),
    })
    .from(numbers);

  expect(row.regularSum).toBe(90); // 10 + 10 + 20 + 20 + 30
  expect(row.distinctSum).toBe(60); // 10 + 20 + 30
});

test('rank vs denseRank differ on ties', async () => {
  await db.insert(windowed).values([
    { id: 1, amount: 5 },
    { id: 2, amount: 10 },
    { id: 3, amount: 10 },
    { id: 4, amount: 20 },
  ]);

  const rows = await db
    .select({
      id: windowed.id,
      r: rank({ orderBy: windowed.amount }),
      dr: denseRank({ orderBy: windowed.amount }),
    })
    .from(windowed)
    .orderBy(windowed.id);

  // rank skips after ties: [1, 2, 2, 4]
  // denseRank does not skip: [1, 2, 2, 3]
  expect(rows.map((r) => r.r)).toEqual([1, 2, 2, 4]);
  expect(rows.map((r) => r.dr)).toEqual([1, 2, 2, 3]);
});

test('lead returns next row value', async () => {
  await db.insert(windowed).values([
    { id: 1, amount: 100 },
    { id: 2, amount: 200 },
    { id: 3, amount: 300 },
    { id: 4, amount: 400 },
  ]);

  const rows = await db
    .select({
      id: windowed.id,
      nextAmount: lead<number>(windowed.amount, 1, sql`-1`, {
        orderBy: windowed.id,
      }),
    })
    .from(windowed)
    .orderBy(windowed.id);

  expect(rows.map((r) => r.nextAmount)).toEqual([200, 300, 400, -1]);
});

test('lead with default value for last row', async () => {
  await db.insert(windowed).values([
    { id: 1, amount: 10 },
    { id: 2, amount: 20 },
  ]);

  const rows = await db
    .select({
      id: windowed.id,
      nextAmount: lead<number>(windowed.amount, 1, sql`999`, {
        orderBy: windowed.id,
      }),
    })
    .from(windowed)
    .orderBy(windowed.id);

  expect(rows[1]?.nextAmount).toBe(999);
});

test('MotherDuck Lance helpers emit table functions with named parameters', () => {
  const dialect = new DuckDBDialect();

  const vector = dialect.sqlToQuery(
    lanceVectorSearch('documents', 'embedding', [0.1, 0.2], {
      k: 5,
      useIndex: false,
      nprobs: 12,
      refineFactor: 2,
      prefilter: true,
      explainVerbose: true,
    })
  );
  const fts = dialect.sqlToQuery(
    lanceFts('documents', 'body', 'duckdb', {
      k: 3,
      prefilter: false,
    })
  );
  const hybrid = dialect.sqlToQuery(
    lanceHybridSearch('documents', 'embedding', [0.1], 'body', 'duckdb', {
      k: 10,
      nprobs: 20,
      refineFactor: 4,
      prefilter: true,
      useIndex: true,
      alpha: 0.75,
      oversampleFactor: 8,
    })
  );

  expect(vector.sql).toContain(
    'lance_vector_search($1, $2, $3, k = $4, use_index = $5, nprobs = $6, refine_factor = $7, prefilter = $8, explain_verbose = $9)'
  );
  expect(vector.params).toEqual([
    'documents',
    'embedding',
    [0.1, 0.2],
    5,
    false,
    12,
    2,
    true,
    true,
  ]);
  expect(fts.sql).toContain('lance_fts($1, $2, $3, k = $4, prefilter = $5)');
  expect(fts.params).toEqual(['documents', 'body', 'duckdb', 3, false]);
  expect(hybrid.sql).toContain(
    'lance_hybrid_search($1, $2, $3, $4, $5, k = $6, nprobs = $7, refine_factor = $8, prefilter = $9, use_index = $10, alpha = $11, oversample_factor = $12)'
  );
  expect(hybrid.params).toEqual([
    'documents',
    'embedding',
    [0.1],
    'body',
    'duckdb',
    10,
    20,
    4,
    true,
    true,
    0.75,
    8,
  ]);
});

test('MotherDuck scan helpers emit md_run overrides and named parameters', () => {
  const dialect = new DuckDBDialect();

  const parquet = dialect.sqlToQuery(
    motherDuckReadParquet('s3://bucket/events/*.parquet', {
      mdRun: 'remote',
      named: {
        hive_partitioning: true,
        filename: false,
      },
    })
  );
  const csv = dialect.sqlToQuery(
    motherDuckReadCsvAuto('https://example.com/data.csv', {
      mdRun: 'local',
      named: {
        header: true,
      },
    })
  );
  const json = dialect.sqlToQuery(
    motherDuckReadJsonAuto(sql`read_json_source`, {
      mdRun: 'auto',
    })
  );
  const delta = dialect.sqlToQuery(
    motherDuckTableFunction('delta_scan', ['s3://bucket/delta'], {
      mdRun: 'remote',
    })
  );

  expect(parquet.sql).toContain(
    'read_parquet($1, hive_partitioning = $2, filename = $3, md_run = $4)'
  );
  expect(parquet.params).toEqual([
    's3://bucket/events/*.parquet',
    true,
    false,
    'remote',
  ]);
  expect(csv.sql).toContain('read_csv_auto($1, header = $2, md_run = $3)');
  expect(csv.params).toEqual(['https://example.com/data.csv', true, 'local']);
  expect(json.sql).toContain('read_json_auto(read_json_source, md_run = $1)');
  expect(json.params).toEqual(['auto']);
  expect(delta.sql).toContain('delta_scan($1, md_run = $2)');
  expect(delta.params).toEqual(['s3://bucket/delta', 'remote']);
});

test('MotherDuck scan helpers support remote extension metadata functions', () => {
  const dialect = new DuckDBDialect();

  const avro = dialect.sqlToQuery(
    motherDuckTableFunction('read_avro', ['s3://bucket/events.avro'], {
      mdRun: 'remote',
    })
  );
  const parquetMetadata = dialect.sqlToQuery(
    motherDuckTableFunction('parquet_metadata', [
      's3://bucket/events.parquet',
    ])
  );
  const spatial = dialect.sqlToQuery(
    motherDuckTableFunction('st_read', ['s3://bucket/map.gpkg'])
  );
  const icebergStats = dialect.sqlToQuery(
    motherDuckTableFunction('iceberg_column_stats', [
      's3://bucket/warehouse/table',
    ])
  );
  const duckLakeOptions = dialect.sqlToQuery(
    motherDuckTableFunction('ducklake_options', ['ducklake:md:metadata'])
  );

  expect(avro.sql).toContain('read_avro($1, md_run = $2)');
  expect(avro.params).toEqual(['s3://bucket/events.avro', 'remote']);
  expect(parquetMetadata.sql).toContain('parquet_metadata($1)');
  expect(parquetMetadata.params).toEqual(['s3://bucket/events.parquet']);
  expect(spatial.sql).toContain('st_read($1)');
  expect(spatial.params).toEqual(['s3://bucket/map.gpkg']);
  expect(icebergStats.sql).toContain('iceberg_column_stats($1)');
  expect(icebergStats.params).toEqual(['s3://bucket/warehouse/table']);
  expect(duckLakeOptions.sql).toContain('ducklake_options($1)');
  expect(duckLakeOptions.params).toEqual(['ducklake:md:metadata']);
});

test('MotherDuck scan helpers reject unsafe named parameters', () => {
  expect(() =>
    motherDuckTableFunction('read_parquet', ['s3://bucket/file.parquet'], {
      named: {
        'header); drop table t; --': true,
      },
    }).getSQL()
  ).toThrow('Invalid MotherDuck table function parameter');
});

test('MotherDuck scan helpers reject invalid md_run modes', () => {
  expect(() =>
    motherDuckTableFunction('read_parquet', ['s3://bucket/file.parquet'], {
      mdRun: 'remote); drop table t; --' as 'remote',
    }).getSQL()
  ).toThrow('Invalid MotherDuck mdRun mode');
});

test('OlapBuilder throws when from() not called', () => {
  expect(() =>
    olap(db)
      .groupBy([numbers.id])
      .measures({ total: sumN(numbers.val) })
      .build()
  ).toThrow('olap: .from() is required');
});

test('OlapBuilder throws when groupBy() not called', () => {
  expect(() =>
    olap(db)
      .from(numbers)
      .measures({ total: sumN(numbers.val) })
      .build()
  ).toThrow('olap: .groupBy() is required');
});

test('OlapBuilder throws when measures() not called', () => {
  expect(() => olap(db).from(numbers).groupBy([numbers.id]).build()).toThrow(
    'olap: .measures() is required'
  );
});
