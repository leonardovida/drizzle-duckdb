import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  duckDbArray,
  duckDbArrayContained,
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

test('array predicate names share their implementations', () => {
  expect(arrayHasAll).toBe(duckDbArrayContains);
  expect(arrayHasAny).toBe(duckDbArrayOverlaps);
  expect(arrayContainedBy).toBe(duckDbArrayContained);
});

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

test('Postgres array bounds functions are rewritten for first dimension', async () => {
  await ctx.db.execute(sql`
    insert into ${items} (id, tags, numbers)
    values (4, [], []), (5, NULL, NULL)
  `);

  const rows = await ctx.db.execute(sql`
    select
      id,
      array_lower(tags, 1) as lower_bound,
      array_upper(tags, 1) as upper_bound
    from ${items}
    where id in (1, 4, 5)
    order by id
  `);

  expect(rows).toEqual([
    { id: 1, lower_bound: 1, upper_bound: 2n },
    { id: 4, lower_bound: null, upper_bound: null },
    { id: 5, lower_bound: null, upper_bound: null },
  ]);
});

test('array bounds are rewritten in casts, ORDER BY, GROUP BY and UPDATE', async () => {
  await ctx.db.execute(sql`
    insert into ${items} (id, tags, numbers)
    values (4, [], []), (5, NULL, NULL)
  `);

  const casts = await ctx.db.execute(sql`
    select
      id,
      array_upper(tags, 1)::int as upper_bound,
      cast(array_lower(tags, 1) as bigint) as lower_bound
    from ${items}
    where id in (1, 4)
    order by id
  `);
  expect(casts).toEqual([
    { id: 1, upper_bound: 2, lower_bound: 1n },
    { id: 4, upper_bound: null, lower_bound: null },
  ]);

  const ordered = await ctx.db.execute(sql`
    select id from ${items}
    where id in (1, 2, 4)
    order by array_upper(tags, 1) desc nulls last, id
  `);
  expect(ordered.map((row) => row.id)).toEqual([1, 2, 4]);

  const grouped = await ctx.db.execute(sql`
    select array_upper(tags, 1) as upper_bound, count(*) as n
    from ${items}
    group by array_upper(tags, 1)
    order by 1 nulls last
  `);
  expect(grouped).toEqual([
    { upper_bound: 1n, n: 1n },
    { upper_bound: 2n, n: 2n },
    { upper_bound: null, n: 2n },
  ]);

  await ctx.db.execute(sql`
    update ${items} set numbers = array[array_upper(tags, 1)::int]
    where array_lower(tags, 1) = 1 and id = 1
  `);
  const updated = await ctx.db.execute(
    sql`select numbers from ${items} where id = 1`
  );
  expect(updated).toEqual([{ numbers: [2] }]);
});
