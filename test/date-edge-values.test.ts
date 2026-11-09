import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { date, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { duckDbDate } from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

const edges = pgTable('date_edges', {
  id: integer('id'),
  text: date('text'),
  value: date('value', { mode: 'date' }),
  duck: duckDbDate('duck'),
  at: timestamp('seen'),
});

describe('DATE edge values', () => {
  let db: DuckDBDatabase;

  beforeAll(async () => {
    const instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect());
    await db.execute(sql`create table date_edges(id integer, text date, value date, duck date, seen timestamp);
      insert into date_edges values
        (1, '10000-01-01', '10000-01-01', '10000-01-01', '1969-12-31 23:59:59.999999'),
        (2, '0044-03-15 (BC)', '0044-03-15 (BC)', '0044-03-15 (BC)', '2024-01-01 10:00:00.123456'),
        (3, 'infinity', 'infinity', 'infinity', '2262-01-01 00:00:00.000001'),
        (4, '-infinity', '-infinity', '-infinity', '0001-01-01 00:00:00.5'),
        (5, '2024-02-29', '2024-02-29', '2024-02-29', null)`);
  });

  afterAll(async () => {
    await db.close();
  });

  const read = async (id: number) =>
    (
      await db
        .select()
        .from(edges)
        .where(sql`${edges.id} = ${id}`)
    )[0]!;

  test('string mode prints years past 9999 and BC years as DuckDB does', async () => {
    expect((await read(1)).text).toBe('10000-01-01');
    expect((await read(1)).duck).toBe('10000-01-01');
    expect((await read(2)).text).toBe('0044-03-15 (BC)');
    expect((await read(5)).text).toBe('2024-02-29');
    expect((await read(5)).value).toEqual(new Date('2024-02-29T00:00:00Z'));
  });

  test('infinite dates read as text instead of failing the query', async () => {
    const positive = await read(3);
    expect(positive.text).toBe('infinity');
    expect(positive.value).toBe('infinity');
    expect(positive.duck).toBe('infinity');
    const negative = await read(4);
    expect(negative.text).toBe('-infinity');
    expect(negative.value).toBe('-infinity');
    expect(
      await db.execute(
        sql`select 'infinity'::date as d, ['-infinity'::date] as l`
      )
    ).toEqual([{ d: 'infinity', l: ['-infinity'] }]);
  });

  test('timestamps floor to the millisecond inside and outside the fast path', async () => {
    expect((await read(1)).at).toEqual(new Date('1969-12-31T23:59:59.999Z'));
    expect((await read(2)).at).toEqual(new Date('2024-01-01T10:00:00.123Z'));
    expect((await read(3)).at).toEqual(new Date('2262-01-01T00:00:00.000Z'));
    expect((await read(4)).at).toEqual(new Date('0001-01-01T00:00:00.500Z'));
    expect(
      await db.execute(
        sql`select seen::varchar as text from date_edges where id = 1`
      )
    ).toEqual([{ text: '1969-12-31 23:59:59.999999' }]);
  });
});
