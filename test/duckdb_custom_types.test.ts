import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  duckDbArray,
  duckDbArrayContains,
  duckDbArrayOverlaps,
  duckDbList,
  duckDbStruct,
  duckDbTimestamp,
  drizzle,
  type DuckDBDatabase,
} from '../src';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const ENABLE_LOGGING = false;

const listTable = pgTable('duck_list_types', {
  id: integer('id').primaryKey(),
  tags: duckDbList<string>('tags', 'VARCHAR'),
  fixed: duckDbArray<number>('fixed', 'INTEGER', 3),
  info: duckDbStruct<{ name: string; flags: string[] }>('info', {
    name: 'TEXT',
    flags: 'TEXT[]',
  }),
  createdAt: duckDbTimestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  }),
  createdLabel: duckDbTimestamp('created_label', { mode: 'string' }),
});

const nestedStructTable = pgTable('duck_nested_struct_types', {
  id: integer('id').primaryKey(),
  profile: duckDbStruct<{
    name: string;
    address: { city: string; zip: number; tags: string[] };
  }>('profile', {
    name: 'TEXT',
    address: 'STRUCT (city TEXT, zip INTEGER, tags TEXT[])',
  }),
});

interface Context {
  db: DuckDBDatabase;
  connection: DuckDBConnection;
}

let ctx: Context;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection, { logger: ENABLE_LOGGING });

  ctx = { db, connection };

  await db.execute(sql`drop table if exists ${listTable}`);
  await db.execute(sql`
    create table ${listTable} (
      id integer primary key,
      tags varchar[],
      fixed integer[3],
      info struct(name text, flags text[]),
      created_at timestamptz,
      created_label timestamp
    )
  `);

  await db.execute(sql`drop table if exists ${nestedStructTable}`);
  await db.execute(sql`
    create table ${nestedStructTable} (
      id integer primary key,
      profile struct(
        name text,
        address struct(city text, zip integer, tags text[])
      )
    )
  `);
});

beforeEach(async () => {
  await ctx.db.execute(sql`delete from ${listTable}`);
  await ctx.db.execute(sql`delete from ${nestedStructTable}`);
});

afterAll(() => {
  ctx.connection?.closeSync();
});

test('duckdb struct/list/array roundtrip', async () => {
  const now = new Date('2024-01-02T12:00:00Z');

  await ctx.db.insert(listTable).values({
    id: 1,
    tags: ['ORM', 'Typescript'],
    fixed: [1, 2, 3],
    info: { name: 'Neo', flags: ['red', 'blue'] },
    createdAt: now,
    createdLabel: '2024-01-02 12:00:00',
  });

  const rows = await ctx.db.select().from(listTable).where(eq(listTable.id, 1));

  expect(rows[0]!.id).toBe(1);
  expect(rows[0]!.tags).toEqual(['ORM', 'Typescript']);
  expect(rows[0]!.fixed).toEqual([1, 2, 3]);
  expect(rows[0]!.info).toEqual({ name: 'Neo', flags: ['red', 'blue'] });
  expect(rows[0]!.createdAt instanceof Date).toBe(true);
  expect(String(rows[0]!.createdLabel)).toContain('2024-01-02 12:00:00');
});

test('array helpers use DuckDB list semantics', async () => {
  await ctx.db.insert(listTable).values([
    {
      id: 1,
      tags: ['ORM', 'Typescript'],
      fixed: [1, 2, 3],
      info: { name: 'Neo', flags: ['red', 'blue'] },
    },
    {
      id: 2,
      tags: ['Database'],
      fixed: [4, 5, 6],
      info: { name: 'Morpheus', flags: [] },
    },
  ]);

  const containsOrm = await ctx.db
    .select({ id: listTable.id })
    .from(listTable)
    .where(duckDbArrayContains(listTable.tags, ['ORM']));

  const overlapsDb = await ctx.db
    .select({ id: listTable.id })
    .from(listTable)
    .where(duckDbArrayOverlaps(listTable.tags, ['Database', 'GraphQL']));

  expect(containsOrm).toEqual([{ id: 1 }]);
  expect(overlapsDb).toEqual([{ id: 2 }]);
});

test('duckdb nested struct roundtrip', async () => {
  await ctx.db.insert(nestedStructTable).values({
    id: 1,
    profile: {
      name: 'Ada',
      address: { city: 'Brussels', zip: 1000, tags: ['eu', 'be'] },
    },
  });

  const rows = await ctx.db
    .select()
    .from(nestedStructTable)
    .where(eq(nestedStructTable.id, 1));

  expect(rows[0]?.profile).toEqual({
    name: 'Ada',
    address: { city: 'Brussels', zip: 1000, tags: ['eu', 'be'] },
  });
});
