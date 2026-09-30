import { eq, isNull, sql } from 'drizzle-orm';
import {
  QueryBuilder,
  integer,
  pgTable,
  pgView,
  text,
} from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';

// Both tables have an `id` column, so a bare "id" in the outer query is
// ambiguous. Subquery and CTE fields must render as "sq"."key".
const users = pgTable('sq_users', {
  id: integer('id'),
  name: text('name'),
});
const orders = pgTable('sq_orders', {
  id: integer('id'),
  userId: integer('user_id'),
  total: integer('total'),
});

let db: DuckDBDatabase;
const stock = new QueryBuilder();

beforeAll(async () => {
  db = await drizzle(':memory:');
  await db.execute(sql`
    create table sq_users (id integer, name text);
    insert into sq_users values (1, 'ann'), (2, 'bob'), (3, 'cid');
    create table sq_orders (id integer, user_id integer, total integer);
    insert into sq_orders values (1, 1, 50), (2, 1, 70), (3, 2, 10);
  `);
});

afterAll(async () => {
  await db?.close();
});

async function runStock(query: { toSQL(): { sql: string } }) {
  const rows = await db.execute(sql.raw(query.toSQL().sql));
  return rows.map((row) => Object.values(row));
}

describe('subquery and CTE fields stay qualified', () => {
  test('a subquery field that shares a name with the base table', async () => {
    const selection = {
      id: orders.id,
      userId: orders.userId,
      total: orders.total,
    };
    const bigOrders = (
      query:
        | ReturnType<typeof stock.select<typeof selection>>
        | ReturnType<typeof db.select<typeof selection>>
    ) =>
      query
        .from(orders)
        .where(sql`${orders.total} > 20`)
        .as('big');

    const sq = bigOrders(db.select(selection));
    const query = db
      .select({ user: users.name, orderId: sq.id })
      .from(users)
      .leftJoin(sq, eq(users.id, sq.userId))
      .orderBy(users.id, sq.id);

    expect(query.toSQL().sql).toContain('"big"."id"');
    const rows = await query;
    expect(rows).toEqual([
      { user: 'ann', orderId: 1 },
      { user: 'ann', orderId: 2 },
      { user: 'bob', orderId: null },
      { user: 'cid', orderId: null },
    ]);

    const stockSq = bigOrders(stock.select(selection));
    const stockRows = await runStock(
      stock
        .select({ user: users.name, orderId: stockSq.id })
        .from(users)
        .leftJoin(stockSq, eq(users.id, stockSq.userId))
        .orderBy(users.id, stockSq.id)
    );
    expect(rows.map((row) => Object.values(row))).toEqual(stockRows);
  });

  test('an anti join on a renamed subquery field keeps unmatched rows', async () => {
    const selection = { id: orders.userId, n: sql<number>`count(*)`.as('n') };
    const perUser = (
      query:
        | ReturnType<typeof stock.select<typeof selection>>
        | ReturnType<typeof db.select<typeof selection>>
    ) => query.from(orders).groupBy(orders.userId).as('agg');

    const agg = perUser(db.select(selection));
    const rows = await db
      .select({ user: users.name, aggId: agg.id })
      .from(users)
      .leftJoin(agg, eq(users.id, agg.id))
      .where(isNull(agg.id))
      .orderBy(users.id);
    expect(rows).toEqual([{ user: 'cid', aggId: null }]);

    const stockAgg = perUser(stock.select(selection));
    const stockRows = await runStock(
      stock
        .select({ user: users.name, aggId: stockAgg.id })
        .from(users)
        .leftJoin(stockAgg, eq(users.id, stockAgg.id))
        .where(isNull(stockAgg.id))
        .orderBy(users.id)
    );
    expect(rows.map((row) => Object.values(row))).toEqual(stockRows);
  });

  test('CTE fields from $with render qualified and keep column decoders', async () => {
    const totals = db
      .$with('totals')
      .as(db.select({ id: orders.userId, total: orders.total }).from(orders));
    const fromBuilder = db
      .$with('totals_qb')
      .as((qb) =>
        qb.select({ id: orders.userId, total: orders.total }).from(orders)
      );

    const query = db
      .with(totals)
      .select({ user: users.name, id: totals.id })
      .from(users)
      .innerJoin(totals, eq(users.id, totals.id))
      .orderBy(totals.total);
    expect(query.toSQL().sql).toContain('"totals"."id"');
    expect(await query).toEqual([
      { user: 'bob', id: 2 },
      { user: 'ann', id: 1 },
      { user: 'ann', id: 1 },
    ]);

    expect(
      await db
        .with(fromBuilder)
        .select()
        .from(fromBuilder)
        .innerJoin(users, eq(users.id, fromBuilder.id))
        .orderBy(fromBuilder.total)
    ).toEqual([
      { totals_qb: { id: 2, total: 10 }, sq_users: { id: 2, name: 'bob' } },
      { totals_qb: { id: 1, total: 50 }, sq_users: { id: 1, name: 'ann' } },
      { totals_qb: { id: 1, total: 70 }, sq_users: { id: 1, name: 'ann' } },
    ]);
  });

  test('full table subqueries and views join on qualified fields', async () => {
    const all = db.select().from(orders).as('all_orders');
    expect(
      await db
        .select({ user: users.name, total: all.total })
        .from(users)
        .leftJoin(all, eq(users.id, all.userId))
        .orderBy(users.id, all.total)
    ).toEqual([
      { user: 'ann', total: 50 },
      { user: 'ann', total: 70 },
      { user: 'bob', total: 10 },
      { user: 'cid', total: null },
    ]);

    const view = pgView('sq_order_view').as(
      db.select({ id: orders.userId, total: orders.total }).from(orders)
    );
    await db.execute(
      sql`create view sq_order_view as select user_id as id, total from sq_orders`
    );
    expect(
      await db
        .select({ user: users.name, id: view.id })
        .from(users)
        .innerJoin(view, eq(users.id, view.id))
        .orderBy(view.total)
    ).toEqual([
      { user: 'bob', id: 2 },
      { user: 'ann', id: 1 },
      { user: 'ann', id: 1 },
    ]);
  });
});
