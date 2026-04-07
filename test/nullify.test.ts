import { char, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, test } from 'vitest';
import * as nodeAssert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { drizzle, DuckDBDatabase } from '../src';

const ENABLE_LOGGING = false;

const citiesTable = pgTable('cities', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_cities')`),
  name: text('name').notNull(),
  state: char('state', { length: 2 }),
});

const users2Table = pgTable('users2', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_users2')`),
  name: text('name').notNull(),
  cityId: integer('city_id').references(() => citiesTable.id),
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

  ctx = {
    db,
    connection,
  };

  await db.execute(sql`CREATE SEQUENCE serial_users;`);
  await db.execute(sql`CREATE SEQUENCE serial_users2;`);
  await db.execute(sql`CREATE SEQUENCE serial_cities;`);

  await db.execute(
    sql`
    create table if not exists cities (
      id integer primary key default nextval('serial_cities'),
      name text not null,
      state char(2)
    )
  `
  );

  await db.execute(
    sql`
    create table if not exists users2 (
      id integer primary key default nextval('serial_users2'),
      name text not null,
      city_id integer references cities(id)
    )
  `
  );
});

afterAll(() => {
  ctx.connection?.closeSync();
});

test('return null instead of object if join has no match', async () => {
  const { id: cityId } = await ctx.db
    .insert(citiesTable)
    .values([
      { id: 1, name: 'Paris' },
      { id: 2, name: 'London' },
    ])
    .returning({ id: citiesTable.id })
    .then((rows) => rows[0]!);

  await ctx.db.insert(users2Table).values([
    { id: 1, name: 'John', cityId },
    { id: 2, name: 'Jane' },
  ]);

  const res = await ctx.db
    .select({
      id: users2Table.id,
      user: {
        name: users2Table.name,
        nameUpper: sql<string>`upper(${users2Table.name})`,
      },
      city: {
        id: citiesTable.id,
        name: citiesTable.name,
        nameUpper: sql<string>`upper(${citiesTable.name})`,
      },
    })
    .from(users2Table)
    .leftJoin(citiesTable, eq(users2Table.cityId, citiesTable.id));

  nodeAssert.deepEqual(res, [
    {
      id: 1,
      user: {
        name: 'John',
        nameUpper: 'JOHN',
      },
      city: {
        id: 1,
        name: 'Paris',
        nameUpper: 'PARIS',
      },
    },
    {
      id: 2,
      user: {
        name: 'Jane',
        nameUpper: 'JANE',
      },
      city: null,
    },
  ]);
});

test('return null for joined objects built only from aliased SQL fields', async () => {
  const { id: cityId } = await ctx.db
    .insert(citiesTable)
    .values({ id: 3, name: 'Rome' })
    .returning({ id: citiesTable.id })
    .then((rows) => rows[0]!);

  await ctx.db.insert(users2Table).values([
    { id: 3, name: 'Alice', cityId },
    { id: 4, name: 'Bob' },
  ]);

  const res = await ctx.db
    .select({
      id: users2Table.id,
      city: {
        upperName: sql<string>`upper(${citiesTable.name})`.as('upper_name'),
      },
    })
    .from(users2Table)
    .leftJoin(citiesTable, eq(users2Table.cityId, citiesTable.id))
    .where(sql`${users2Table.id} in (3, 4)`)
    .orderBy(users2Table.id);

  nodeAssert.deepEqual(res, [
    {
      id: 3,
      city: {
        upperName: 'ROME',
      },
    },
    {
      id: 4,
      city: null,
    },
  ]);
});
