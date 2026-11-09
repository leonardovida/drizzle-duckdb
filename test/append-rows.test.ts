import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  numeric,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  duckDbJson,
  duckDbList,
  duckDbStruct,
  duckDbTimestamp,
} from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

const items = pgTable('append_items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  score: doublePrecision('score'),
  amount: numeric('amount', { precision: 20, scale: 4 }),
  big: bigint('big', { mode: 'bigint' }),
  active: boolean('active').default(true),
  day: date('day'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  seenAt: duckDbTimestamp('seen_at'),
  ref: uuid('ref'),
  tags: duckDbList<string>('tags', 'VARCHAR'),
  meta: duckDbJson<{ a: number }>('meta'),
  token: text('token').$defaultFn(() => 'generated'),
});

const analytics = pgSchema('append_analytics');
const hits = analytics.table('hits', { id: integer('id'), path: text('path') });

const structs = pgTable('append_structs', {
  id: integer('id'),
  point: duckDbStruct<{ x: number }>('point', { x: 'INTEGER' }),
});

describe('appendRows', () => {
  let db: DuckDBDatabase;

  beforeEach(async () => {
    const instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect());
    // Session zone differs from UTC, so instants must not shift.
    await db.execute(sql`set timezone = 'America/New_York'`);
    await db.execute(sql`create table append_items(
      id integer primary key, name varchar not null, score double, amount decimal(20,4), big bigint,
      active boolean default true, day date, created_at timestamptz, seen_at timestamp, ref uuid,
      tags varchar[], meta json, token varchar, extra integer default 7);
      create schema append_analytics;
      create table append_analytics.hits(id integer, path varchar);
      create table append_structs(id integer, point struct(x integer))`);
  });

  afterEach(async () => {
    await db.close();
  });

  test('appends typed rows, defaults and nulls', async () => {
    const at = new Date('2024-01-01T10:00:00.123Z');
    const count = await db.appendRows(items, [
      {
        id: 1,
        name: "it's",
        score: 1.5,
        amount: '1234567890123456.7891',
        big: 9007199254740993n,
        active: false,
        day: '2024-02-29',
        createdAt: at,
        seenAt: at,
        ref: '0f0e0d0c-0b0a-4908-8706-050403020100',
        tags: ['a', 'b'],
        meta: { a: 1 },
        token: 'given',
      },
      { id: 2, name: 'defaults', score: null },
    ]);
    expect(count).toBe(2);

    expect(await db.select().from(items).orderBy(items.id)).toEqual([
      {
        id: 1,
        name: "it's",
        score: 1.5,
        amount: '1234567890123456.7891',
        big: 9007199254740993n,
        active: false,
        day: '2024-02-29',
        createdAt: at,
        seenAt: at,
        ref: '0f0e0d0c-0b0a-4908-8706-050403020100',
        tags: ['a', 'b'],
        meta: { a: 1 },
        token: 'given',
      },
      {
        id: 2,
        name: 'defaults',
        score: null,
        amount: null,
        big: null,
        active: true,
        day: null,
        createdAt: null,
        seenAt: null,
        ref: null,
        tags: null,
        meta: null,
        token: 'generated',
      },
    ]);
    // A column the Drizzle table does not declare takes its default.
    expect(
      await db.execute(sql`select extra from append_items order by id`)
    ).toEqual([{ extra: 7 }, { extra: 7 }]);
  });

  test('appends many rows and to a table in another schema', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      id: index,
      name: `row ${index}`,
    }));
    expect(await db.appendRows(items, rows)).toBe(5000);
    expect(
      await db.execute(
        sql`select count(*)::int as n, max(id) as last from append_items`
      )
    ).toEqual([{ n: 5000, last: 4999 }]);

    expect(await db.appendRows(hits, [{ id: 1, path: '/' }])).toBe(1);
    expect(await db.select().from(hits)).toEqual([{ id: 1, path: '/' }]);
    expect(await db.appendRows(hits, [])).toBe(0);
  });

  test('joins the transaction and rolls back with it', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.appendRows(items, [{ id: 1, name: 'a' }]);
        expect(await tx.select({ id: items.id }).from(items)).toEqual([
          { id: 1 },
        ]);
        throw new Error('undo');
      })
    ).rejects.toThrow('undo');
    expect(await db.select().from(items)).toEqual([]);

    await db.transaction(async (tx) => {
      await tx.appendRows(items, [{ id: 2, name: 'b' }]);
    });
    expect(await db.select({ id: items.id }).from(items)).toEqual([{ id: 2 }]);
  });

  test('reports constraint failures and values the appender cannot take', async () => {
    await expect(
      db.appendRows(items, [
        { id: 1, name: 'a' },
        { id: 1, name: 'duplicate' },
      ])
    ).rejects.toThrow(/constraint|duplicate/i);

    await expect(
      db.appendRows(structs, [{ id: 1, point: { x: 1 } }])
    ).rejects.toThrow(/Use db\.insert\(\)/);
    expect(await db.select().from(structs)).toEqual([]);
  });

  test('works through a connection pool', async () => {
    const pooled = await drizzle(':memory:');
    try {
      await pooled.execute(
        sql`create table append_analytics_free(id integer, path varchar)`
      );
      const free = pgTable('append_analytics_free', {
        id: integer('id'),
        path: text('path'),
      });
      await Promise.all(
        [0, 1, 2, 3, 4, 5].map((batch) =>
          pooled.appendRows(
            free,
            Array.from({ length: 100 }, (_, index) => ({
              id: batch * 100 + index,
              path: '/p',
            }))
          )
        )
      );
      expect(
        await pooled.execute(
          sql`select count(*)::int as n, count(distinct id)::int as d from append_analytics_free`
        )
      ).toEqual([{ n: 600, d: 600 }]);
    } finally {
      await pooled.close();
    }
  });
});
