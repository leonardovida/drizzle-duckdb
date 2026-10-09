import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { duckDbList } from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import { transformSQL } from '../src/sql/ast-transformer.ts';

const items = pgTable('bounds items', {
  id: integer('id'),
  tags: duckDbList<string>('tags', 'TEXT'),
  n: integer('n'),
});
let instance: DuckDBInstance;
let db: DuckDBDatabase;

beforeEach(async () => {
  instance = await DuckDBInstance.create(':memory:');
  db = drizzle(await instance.connect());
  await db.execute(sql`create table ${items} (id int, tags text[], n int)`);
  await db.insert(items).values([
    { id: 1, tags: ['a', 'b'] },
    { id: 2, tags: [] },
    { id: 3, tags: null },
  ]);
});

afterEach(async () => {
  await db.close();
  instance.closeSync();
});

test('DELETE predicates and RETURNING preserve parameters and quoted tables', async () => {
  const deleted = await db
    .delete(items)
    .where(sql`array_upper(${items.tags}, 1) = ${2}`)
    .returning({ id: items.id, lo: sql`array_lower(${items.tags}, 1)` });
  expect(deleted).toEqual([{ id: 1, lo: 1 }]);
  expect(
    await db.select({ id: items.id }).from(items).orderBy(items.id)
  ).toEqual([{ id: 2 }, { id: 3 }]);
});

test('INSERT VALUES and RETURNING retain literals and empty/null semantics', async () => {
  const rows = await db.execute(sql`
    insert into ${items} (id, tags, n) values
      (4, ARRAY['a', 'b'], array_upper(ARRAY[${7}, ${8}], 1)),
      (5, ARRAY[], array_lower(ARRAY[]::int[], 1)),
      (6, NULL, array_upper(NULL::int[], 1))
    returning id, n, array_lower(tags, 1) as lo, array_upper(tags, 1) as hi
  `);
  expect(rows).toEqual([
    { id: 4, n: 2, lo: 1, hi: 2n },
    { id: 5, n: null, lo: null, hi: null },
    { id: 6, n: null, lo: null, hi: null },
  ]);
});

test('INSERT SELECT walks its CTE, expressions and bound predicate', async () => {
  await db.execute(sql`create table lengths (id int, n int)`);
  await db.execute(sql`
    insert into lengths
    with source as (
      select id, tags, array_upper(tags, 1) as hi from ${items}
    )
    select id, hi from source where array_lower(tags, 1) = ${1}
  `);
  expect(await db.execute(sql`select * from lengths`)).toEqual([
    { id: 1, n: 2 },
  ]);
});

test('UPDATE RETURNING rewrites bounds even without bounds in SET or WHERE', async () => {
  expect(
    await db
      .update(items)
      .set({ n: 9 })
      .returning({
        id: items.id,
        lo: sql`array_lower(${items.tags}, 1)`,
        hi: sql`array_upper(${items.tags}, 1)`,
      })
  ).toEqual([
    { id: 1, lo: 1, hi: 2n },
    { id: 2, lo: null, hi: null },
    { id: 3, lo: null, hi: null },
  ]);
});

test('INSERT VALUES evaluates volatile array expressions once per row', async () => {
  await db.execute(sql`create sequence bounds_sequence`);
  await db.execute(sql`
    insert into ${items} (id, n) values
      (4, array_upper(ARRAY[nextval('bounds_sequence')], 1)),
      (5, array_upper(ARRAY[nextval('bounds_sequence')], 1))
  `);
  expect(await db.execute(sql`select currval('bounds_sequence') as n`)).toEqual(
    [{ n: 2n }]
  );
});

test('UPDATE walks bounds in its CTE before applying a bound predicate', async () => {
  await db.execute(sql`
    with source as (select id, array_upper(tags, 1) as hi from ${items})
    update ${items} set n = ${9} where id in (select id from source where hi = ${2})
  `);
  expect(await db.select({ n: items.n }).from(items).orderBy(items.id)).toEqual(
    [{ n: 9 }, { n: null }, { n: null }]
  );
});

test('INSERT conflict updates walk both assignments and predicates', async () => {
  await db.execute(
    sql`create table upsert_items (id int primary key, tags text[], n int)`
  );
  await db.execute(sql`insert into upsert_items values (1, ARRAY['old'], 0)`);
  expect(
    await db.execute(sql`
    insert into upsert_items (id, tags, n) values (1, ARRAY[${'a'}, ${'b'}], 9)
    on conflict (id) do update set n = array_upper(excluded.tags, 1)
    where array_lower(upsert_items.tags, 1) = ${1}
    returning n
  `)
  ).toEqual([{ n: 2 }]);
});

test('write bounds keep the existing safe fallback for unsupported SQL', () => {
  for (const query of [
    'DELETE FROM "bounds items" WHERE array_upper(tags, 2) = $1',
    'DELETE FROM "bounds items" WHERE array_upper(tags, 1) IS DISTINCT FROM $1',
    "INSERT INTO lengths VALUES (1, array_upper(ARRAY['c:\\tmp'], 1))",
    'DELETE FROM "bounds items" USING lengths WHERE array_upper(tags, 1) = n',
  ]) {
    expect(transformSQL(query)).toEqual({ sql: query, transformed: false });
  }
});
