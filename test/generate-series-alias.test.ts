import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';
import { transformSQL } from '../src/sql/ast-transformer.ts';

let db: DuckDBDatabase;
let instance: DuckDBInstance;
let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);

  await db.execute(sql`create table offers (start_date date, end_date date)`);
  await db.execute(
    sql`insert into offers values (date '2024-01-02', date '2024-01-02')`
  );
});

afterAll(async () => {
  connection.closeSync();
});

describe('generate_series alias compatibility', () => {
  test.each([
    {
      name: 'ordinary queries',
      query: 'select gs from generate_series(1, 3) as gs order by gs',
    },
    {
      name: 'compound queries',
      query:
        '(select gs from generate_series(1, 3) as gs) union all (select gs from generate_series(1, 3) as gs) order by gs',
    },
  ])('rewrites ORDER BY aliases in $name', ({ query }) => {
    const result = transformSQL(query);

    expect(result.transformed).toBe(true);
    expect(result.sql).toMatch(/ORDER BY "gs"\.generate_series ASC$/);
  });

  test('rewrites gs::date to gs.generate_series::date', async () => {
    const result = await db
      .select({
        date: sql<string>`gs::date`.as('date'),
        outletCount: sql<number>`count(offers.start_date)`.as('outletCount'),
      })
      .from(
        sql`generate_series(
          date '2024-01-01',
          date '2024-01-03',
          '1 day'::interval
        ) as gs`
      )
      .leftJoin(
        sql`offers`,
        sql`gs::date between offers.start_date and offers.end_date`
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    expect(result).toHaveLength(3);
    expect(
      result.map((r) => (r.date as Date).toISOString().slice(0, 10))
    ).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    expect(result.map((r) => Number(r.outletCount))).toEqual([0, 1, 0]);
  });
});
