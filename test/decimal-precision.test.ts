import { DuckDBInstance } from '@duckdb/node-api';
import { sql, sum } from 'drizzle-orm';
import { integer, numeric, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';

const prices = pgTable('decimal_prices', {
  id: integer('id'),
  wide: numeric('wide', { precision: 38, scale: 10 }),
  narrow: numeric('narrow', { precision: 10, scale: 2 }),
});

const WIDE = '12345678901234567890.1234567891';

describe.each([
  { name: 'run', prepareCache: undefined },
  { name: 'prepared statement cache', prepareCache: true as const },
])('DECIMAL precision ($name)', ({ prepareCache }) => {
  let instance: DuckDBInstance;
  let db: DuckDBDatabase;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect(), { prepareCache });
    await db.execute(sql`
      create table decimal_prices (
        id integer, wide decimal(38, 10), narrow decimal(10, 2)
      )
    `);
    await db.insert(prices).values([
      { id: 1, wide: WIDE, narrow: '12.30' },
      { id: 2, wide: null, narrow: null },
    ]);
  });

  afterAll(async () => {
    await db.close();
    instance.closeSync();
  });

  test('numeric() columns keep every digit', async () => {
    const rows = await db.select().from(prices).orderBy(prices.id);
    expect(rows).toEqual([
      { id: 1, wide: WIDE, narrow: '12.30' },
      { id: 2, wide: null, narrow: null },
    ]);
  });

  test('numeric() columns keep every digit in partial and joined selects', async () => {
    const [row] = await db
      .select({ wide: prices.wide, id: prices.id })
      .from(prices)
      .where(sql`${prices.id} = 1`);
    expect(row).toEqual({ wide: WIDE, id: 1 });
  });

  test('SQL expressions over DECIMAL keep returning numbers', async () => {
    const [totals] = await db
      .select({ total: sql<number>`sum(${prices.narrow})` })
      .from(prices);
    expect(totals).toEqual({ total: 12.3 });

    const [row] = await db
      .select({ raw: sql<number>`${prices.narrow}` })
      .from(prices)
      .where(sql`${prices.id} = 1`);
    expect(row).toEqual({ raw: 12.3 });
  });

  test('drizzle aggregate helpers keep their own decoders', async () => {
    const [row] = await db.select({ total: sum(prices.narrow) }).from(prices);
    expect(row).toEqual({ total: '12.3' });
  });

  test('raw execute keeps returning numbers', async () => {
    const [row] = await db.execute<{ narrow: number }>(
      sql`select narrow from decimal_prices where id = 1`
    );
    expect(row).toEqual({ narrow: 12.3 });
  });
});
