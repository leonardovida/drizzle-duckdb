import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

// Both tables have `id` and `name`. Without aliases, DuckDB resolves the outer
// reference to the first `id` column of the subquery or CTE.
const a = pgTable('alias_entry_a', {
  id: integer('id'),
  name: text('name'),
});
const b = pgTable('alias_entry_b', {
  id: integer('id'),
  aId: integer('a_id'),
  name: text('name'),
});

const expected = [{ aId: 1, bId: 10 }];

let db: DuckDBDatabase;

beforeAll(async () => {
  db = await drizzle(':memory:');
  await db.execute(sql`
    create table alias_entry_a (id integer, name text);
    create table alias_entry_b (id integer, a_id integer, name text);
    insert into alias_entry_a values (1, 'A');
    insert into alias_entry_b values (10, 1, 'B');
  `);
});

afterAll(async () => {
  await db?.close();
});

test('tx.select aliases subquery fields', async () => {
  await db.transaction(async (tx) => {
    const sq = tx
      .select({ aId: a.id, bId: b.id })
      .from(a)
      .innerJoin(b, eq(a.id, b.aId))
      .as('sq');
    expect(await tx.select().from(sq)).toEqual(expected);
  });
});

test('selectDistinct and selectDistinctOn alias subquery fields', async () => {
  const distinct = db
    .selectDistinct({ aId: a.id, bId: b.id })
    .from(a)
    .innerJoin(b, eq(a.id, b.aId))
    .as('sq');
  expect(await db.select().from(distinct)).toEqual(expected);

  const distinctOn = db
    .selectDistinctOn([a.id], { aId: a.id, bId: b.id })
    .from(a)
    .innerJoin(b, eq(a.id, b.aId))
    .as('sq');
  expect(await db.select().from(distinctOn)).toEqual(expected);

  await db.transaction(async (tx) => {
    const txDistinct = tx
      .selectDistinct({ aId: a.id, bId: b.id })
      .from(a)
      .innerJoin(b, eq(a.id, b.aId))
      .as('sq');
    expect(await tx.select().from(txDistinct)).toEqual(expected);
  });
});

test('$with query builders and with().select alias CTE fields', async () => {
  const cte = db
    .$with('cte')
    .as((qb) =>
      qb.select({ aId: a.id, bId: b.id }).from(a).innerJoin(b, eq(a.id, b.aId))
    );
  expect(await db.with(cte).select().from(cte)).toEqual(expected);

  const cteFromDb = db
    .$with('cte_db')
    .as(
      db.select({ aId: a.id, bId: b.id }).from(a).innerJoin(b, eq(a.id, b.aId))
    );
  const nested = db
    .with(cteFromDb)
    .select({ aId: cteFromDb.aId, bId: cteFromDb.bId })
    .from(cteFromDb)
    .as('nested');
  expect(await db.select().from(nested)).toEqual(expected);

  await db.transaction(async (tx) => {
    const txCte = tx
      .$with('tx_cte')
      .as((qb) =>
        qb
          .selectDistinct({ aId: a.id, bId: b.id })
          .from(a)
          .innerJoin(b, eq(a.id, b.aId))
      );
    expect(await tx.with(txCte).select().from(txCte)).toEqual(expected);
  });
});
