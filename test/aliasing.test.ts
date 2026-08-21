import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { drizzle, type DuckDBDatabase } from '../src';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const ENABLE_LOGGING = false;

const users = pgTable('alias_users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  addressId: integer('address_id'),
});

const addresses = pgTable('alias_addresses', {
  id: integer('id').primaryKey(),
  line1: text('line1').notNull(),
  city: text('city').notNull(),
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

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(sql`drop table if exists ${addresses}`);

  await db.execute(sql`
    create table ${addresses} (
      id integer primary key,
      line1 text not null,
      city text not null
    )
  `);
  await db.execute(sql`
    create table ${users} (
      id integer primary key,
      name text not null,
      address_id integer references ${addresses} (id)
    )
  `);
});

beforeEach(async () => {
  await ctx.db.execute(sql`delete from ${users}`);
  await ctx.db.execute(sql`delete from ${addresses}`);

  await ctx.db.insert(addresses).values([
    { id: 10, line1: '1 Main St', city: 'Paris' },
    { id: 11, line1: '2 Main St', city: 'London' },
  ]);

  await ctx.db.insert(users).values([
    { id: 1, name: 'Neo', addressId: 10 },
    { id: 2, name: 'Trinity', addressId: 11 },
  ]);
});

afterAll(() => {
  ctx.connection?.closeSync();
});

test('nested selections alias deeply without collisions', async () => {
  const rows = await ctx.db
    .select({
      user: {
        id: users.id,
        name: users.name,
      },
      location: {
        line1: addresses.line1,
        city: addresses.city,
      },
    })
    .from(users)
    .leftJoin(addresses, eq(users.addressId, addresses.id))
    .orderBy(users.id);

  expect(rows).toEqual([
    {
      user: { id: 1, name: 'Neo' },
      location: { line1: '1 Main St', city: 'Paris' },
    },
    {
      user: { id: 2, name: 'Trinity' },
      location: { line1: '2 Main St', city: 'London' },
    },
  ]);
});

test('duplicate column aliases preserve ordering', async () => {
  const rows = await ctx.db
    .select({
      first: sql<number>`1`.as('dup'),
      second: sql<number>`2`.as('dup'),
    })
    .from(sql`(select 1) as t`);

  expect(rows).toEqual([{ first: 1, second: 2 }]);
});

test('raw duplicate aliases avoid generated name collisions', async () => {
  const rows = await ctx.db.execute(sql`select 1 as a, 2 as a, 3 as a_1`);

  expect(rows).toEqual([{ a: 1, a_1: 2, a_1_1: 3 }]);
});
