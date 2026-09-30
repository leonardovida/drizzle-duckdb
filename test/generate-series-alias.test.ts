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
        date: sql<Date>`gs::date`.as('date'),
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
    expect(result.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ]);
    expect(result.map((r) => Number(r.outletCount))).toEqual([0, 1, 0]);
  });

  test('rewrites GROUP BY and FILTER references', async () => {
    const grouped = transformSQL(
      'select gs as v, count(*) as c from generate_series(1, 3) gs group by gs order by 1'
    );
    expect(grouped.sql).toMatch(/GROUP BY "gs"\.generate_series/);
    expect(await db.execute(sql.raw(grouped.sql))).toEqual([
      { v: 1n, c: 1n },
      { v: 2n, c: 1n },
      { v: 3n, c: 1n },
    ]);

    const filtered = transformSQL(
      'select max(gs) filter (where gs > 1) as m from generate_series(1, 3) gs'
    );
    expect(filtered.sql).toContain('WHERE "gs".generate_series > 1');
    expect(await db.execute(sql.raw(filtered.sql))).toEqual([{ m: 3n }]);
  });

  test('keeps the output name of a bare alias reference', async () => {
    const result = transformSQL(
      'select gs from generate_series(1, 2) as gs order by gs'
    );
    expect(await db.execute(sql.raw(result.sql))).toEqual([
      { gs: 1n },
      { gs: 2n },
    ]);
  });

  test('rewrites the alias in a JOIN condition before qualifying it', async () => {
    await db.execute(sql`
      create table gs_events (id integer, n integer);
      insert into gs_events values (1, 1), (2, 2), (3, 2);
    `);
    const result = transformSQL(
      'select gs as v, count(gs_events.id) as c from generate_series(1, 3) gs left join gs_events on gs_events.n = gs group by gs order by gs'
    );
    expect(result.sql).toContain('ON "gs_events".n = "gs".generate_series');
    expect(await db.execute(sql.raw(result.sql))).toEqual([
      { v: 1n, c: 1n },
      { v: 2n, c: 2n },
      { v: 3n, c: 0n },
    ]);
  });
});
