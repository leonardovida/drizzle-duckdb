import { DuckDBInstance } from '@duckdb/node-api';
import { desc, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';

let db: DuckDBDatabase;
let instance: DuckDBInstance;
let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;

const a = pgTable('a', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

const b = pgTable('b', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  relevanceRank: integer('relevance_rank'),
});

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);

  await db.execute(sql`create table a (id integer, name text)`);
  await db.execute(
    sql`create table b (id integer, name text, relevance_rank integer)`
  );

  await db.execute(sql`insert into a values (1, 'x'), (2, 'y')`);
  await db.execute(sql`insert into b values (3, 'z', 5), (2, 'y', 10)`);
});

afterAll(async () => {
  connection.closeSync();
});

describe('union with per arm WITH clauses', () => {
  test('hoists WITH to avoid DuckDB internal error', async () => {
    const at = db.$with('at').as(
      db
        .selectDistinct({
          id: a.id,
          name: a.name,
          relevanceRank: sql<number | null>`null::int`.as('relevanceRank'),
        })
        .from(a)
    );

    const bt = db.$with('bt').as(
      db
        .selectDistinct({
          id: b.id,
          name: b.name,
          relevanceRank: b.relevanceRank,
        })
        .from(b)
    );

    const result = await db
      .with(at)
      .select()
      .from(at)
      .union(db.with(bt).select().from(bt))
      .orderBy((cols) => [desc(cols.relevanceRank), cols.id]);

    expect(result.map((r) => Number(r.relevanceRank))).toEqual([10, 5, 0, 0]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 1, 2]);
  });

  test('keeps arm parentheses when an arm has ORDER BY and LIMIT', async () => {
    const first = db
      .$with('first_arm')
      .as(db.select({ id: a.id, name: a.name }).from(a));
    const second = db
      .$with('second_arm')
      .as(db.select({ id: b.id, name: b.name }).from(b));

    const result = await db
      .with(first)
      .select()
      .from(first)
      .orderBy(desc(first.id))
      .limit(1)
      .unionAll(db.with(second).select().from(second));

    expect(result.map((r) => r.id).sort()).toEqual([2, 2, 3]);
  });

  test('does not let a hoisted CTE shadow a table used by another arm', async () => {
    const shadow = db.$with('a').as(
      db
        .select({
          id: sql<number>`99`.as('id'),
          name: sql<string>`'shadow'`.as('name'),
        })
        .from(sql`(select 1)`)
    );

    const result = await db
      .select({ id: a.id, name: a.name })
      .from(a)
      .unionAll(db.with(shadow).select().from(shadow));

    expect(result.map((r) => r.id).sort()).toEqual([1, 2, 99]);
  });
});
