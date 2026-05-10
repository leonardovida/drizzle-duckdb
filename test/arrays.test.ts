import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  duckDbArray,
  duckDbArrayContains,
  duckDbArrayOverlaps,
  duckDbList,
  drizzle,
  arrayHasAll,
  arrayHasAny,
  arrayContainedBy,
  type DuckDBDatabase,
} from '../src';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { arrayContains, arrayOverlaps, sql } from 'drizzle-orm';

const ENABLE_LOGGING = false;

const items = pgTable('duckdb_array_items', {
  id: integer('id').primaryKey(),
  tags: duckDbList<string>('tags', 'TEXT'),
  numbers: duckDbArray<number>('numbers', 'INTEGER'),
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

  await db.execute(sql`drop table if exists ${items}`);
  await db.execute(sql`
    create table ${items} (
      id integer primary key,
      tags text[],
      numbers integer[]
    )
  `);
});

beforeEach(async () => {
  await ctx.db.execute(sql`delete from ${items}`);

  await ctx.db.insert(items).values([
    { id: 1, tags: ['ORM', 'Typescript'], numbers: [1, 2, 3] },
    { id: 2, tags: ['Database'], numbers: [4, 5, 6] },
    { id: 3, tags: ['ORM', 'Database'], numbers: [1, 4] },
  ]);
});

afterAll(() => {
  ctx.connection?.closeSync();
});

test('duckDbArrayContains/Overlaps use DuckDB list semantics', async () => {
  const containsOrm = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(duckDbArrayContains(items.tags, ['ORM']))
    .orderBy(items.id);

  const overlapsDb = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(duckDbArrayOverlaps(items.tags, ['Database', 'GraphQL']))
    .orderBy(items.id);

  expect(containsOrm).toEqual([{ id: 1 }, { id: 3 }]);
  expect(overlapsDb).toEqual([{ id: 2 }, { id: 3 }]);
});

test('native array operators share DuckDB list literal handling', async () => {
  const containsOrm = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(arrayHasAll(items.tags, ['ORM']))
    .orderBy(items.id);

  const overlapsDb = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(arrayHasAny(items.tags, ['Database', 'GraphQL']))
    .orderBy(items.id);

  const containedBy = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(arrayContainedBy(items.tags, ['ORM', 'Typescript']))
    .orderBy(items.id);

  expect(containsOrm).toEqual([{ id: 1 }, { id: 3 }]);
  expect(overlapsDb).toEqual([{ id: 2 }, { id: 3 }]);
  expect(containedBy).toEqual([{ id: 1 }]);
});

test('Postgres array operators are rewritten to DuckDB functions', async () => {
  const containsOrm = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(arrayContains(items.tags, ['ORM']))
    .orderBy(items.id);

  const overlapsOrm = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(arrayOverlaps(items.tags, ['ORM', 'Typescript']))
    .orderBy(items.id);

  expect(containsOrm).toEqual([{ id: 1 }, { id: 3 }]);
  expect(overlapsOrm).toEqual([{ id: 1 }, { id: 3 }]);
});
