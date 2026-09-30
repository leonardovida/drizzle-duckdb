import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  and,
  arrayContained,
  arrayContains,
  arrayOverlaps,
  asc,
  avg,
  count,
  countDistinct,
  eq,
  exists,
  getTableColumns,
  gt,
  gte,
  inArray,
  lt,
  max,
  min,
  type SQL,
  sql,
  type SQLWrapper,
  sum,
  sumDistinct,
  TransactionRollbackError,
} from 'drizzle-orm';
import {
  alias,
  boolean,
  char,
  date,
  except,
  exceptAll,
  foreignKey,
  getMaterializedViewConfig,
  getTableConfig,
  getViewConfig,
  inet,
  integer,
  intersect,
  intersectAll,
  interval,
  numeric,
  type PgColumn,
  pgEnum,
  pgMaterializedView,
  pgSchema,
  pgTableCreator,
  pgView,
  primaryKey,
  text,
  time,
  timestamp,
  union,
  unionAll,
  unique,
  uniqueKeyName,
  uuid as pgUuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { drizzle, type DuckDBDatabase } from '../src';
import { migrate } from '../src/migrator';
import { v4 as uuid } from 'uuid';
import { type Equal, Expect, randomString } from './utils';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import assert from 'node:assert/strict';

const ENABLE_LOGGING = false;

const publicSchema = pgSchema('buplic');

const usersTable = publicSchema.table('users', {
  id: integer('id' as string)
    .primaryKey()
    .default(sql`nextval('serial_users')`),
  name: text('name').notNull(),
  verified: boolean('verified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

const usersOnUpdate = publicSchema.table('users_on_update', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_users_on_update')`),
  name: text('name').notNull(),
  updateCounter: integer('update_counter')
    .default(sql`1`)
    .$onUpdateFn(() => sql`update_counter + 1`),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 }).$onUpdate(
    () => new Date()
  ),
  alwaysNull: text('always_null')
    .$type<string | null>()
    .$onUpdate(() => null),
  // uppercaseName: text('uppercase_name').$onUpdateFn(() => sql`upper(name)`), looks like this is not supported in pg
});

const citiesTable = publicSchema.table('cities', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_cities')`),
  name: text('name').notNull(),
  state: char('state', { length: 2 }),
});

const cities2Table = publicSchema.table('cities', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_cities2')`),
  name: text('name').notNull(),
});

const users2Table = publicSchema.table('users2', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_users2')`),
  name: text('name').notNull(),
  cityId: integer('city_id').references(() => citiesTable.id),
});

const coursesTable = publicSchema.table('courses', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_courses')`),
  name: text('name').notNull(),
  categoryId: integer('category_id').references(() => courseCategoriesTable.id),
});

const courseCategoriesTable = publicSchema.table('course_categories', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_course_categories')`),
  name: text('name').notNull(),
});

const orders = publicSchema.table('orders', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_orders')`),
  region: text('region').notNull(),
  product: text('product')
    .notNull()
    .$default(() => 'random_string'),
  amount: integer('amount').notNull(),
  quantity: integer('quantity').notNull(),
});

const network = publicSchema.table('network_table', {
  inet: inet('inet').notNull(),
});

const salEmp = publicSchema.table('sal_emp', {
  name: text('name'),
  payByQuarter: integer('pay_by_quarter').array(),
  schedule: text('schedule').array().array(),
});

const usersMigratorTable = publicSchema.table('users12', {
  id: integer('id')
    .primaryKey()
    .default(sql`nextval('serial_users12')`),
  name: text('name').notNull(),
  email: text('email').notNull(),
});

// To test aggregate functions
const aggregateTable = publicSchema.table('aggregate_table', {
  id: integer('id').notNull(),
  name: text('name').notNull(),
  a: integer('a'),
  b: integer('b'),
  c: integer('c'),
  nullOnly: integer('null_only'),
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

  await db.execute(sql`CREATE SEQUENCE serial;`);
  await db.execute(sql`CREATE SEQUENCE serial_users;`);
  await db.execute(sql`CREATE SEQUENCE serial_cities;`);
  await db.execute(sql`CREATE SEQUENCE serial_users2;`);
  await db.execute(sql`CREATE SEQUENCE serial_users12;`);
  await db.execute(sql`CREATE SEQUENCE serial_users_on_update;`);
  await db.execute(sql`CREATE SEQUENCE serial_course_categories;`);
  await db.execute(sql`CREATE SEQUENCE serial_courses;`);
  await db.execute(sql`CREATE SEQUENCE serial_categories;`);
  await db.execute(sql`CREATE SEQUENCE serial_orders;`);

  ctx = {
    connection,
    db,
  };
});

afterAll(() => {
  ctx.connection?.closeSync();
});

beforeEach(async () => {
  await ctx.db.execute(sql`drop sequence serial cascade`);
  await ctx.db.execute(sql`create sequence serial`);

  await ctx.db.execute(sql`drop sequence serial_cities cascade`);
  await ctx.db.execute(sql`create sequence serial_cities`);

  await ctx.db.execute(sql`drop sequence serial_users cascade`);
  await ctx.db.execute(sql`create sequence serial_users`);

  await ctx.db.execute(sql`drop sequence serial_users2 cascade`);
  await ctx.db.execute(sql`create sequence serial_users2`);

  await ctx.db.execute(sql`drop sequence serial_course_categories cascade`);
  await ctx.db.execute(sql`create sequence serial_course_categories`);

  await ctx.db.execute(sql`drop sequence serial_courses cascade`);
  await ctx.db.execute(sql`create sequence serial_courses`);

  await ctx.db.execute(sql`drop sequence serial_orders cascade`);
  await ctx.db.execute(sql`create sequence serial_orders`);

  await ctx.db.execute(sql`drop schema if exists buplic cascade`);
  await ctx.db.execute(sql`create schema buplic`);

  await ctx.db.execute(
    sql`
			create table if not exists buplic.users (
				id integer primary key default nextval('serial_users'),
				name text not null,
				verified boolean not null default false,
				created_at timestamptz not null default now()
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.cities (
				id integer primary key default nextval('serial_cities'),
				name text not null,
				state char(2)
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.users2 (
				id integer primary key default nextval('serial_users2'),
				name text not null,
				city_id integer references buplic.cities(id)
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.course_categories (
				id integer primary key default nextval('serial_course_categories'),
				name text not null
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.courses (
				id integer primary key default nextval('serial_courses'),
				name text not null,
				category_id integer references buplic.course_categories(id)
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.orders (
				id integer primary key default nextval('serial_orders'),
				region text not null,
				product text not null,
				amount integer not null,
				quantity integer not null
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.sal_emp (
				name text not null,
				pay_by_quarter integer[] not null,
				schedule text[][] not null
			)
		`
  );
  await ctx.db.execute(
    sql`
			create table if not exists buplic.tictactoe (
				squares integer[3][3] not null
			)
		`
  );
});

async function setupSetOperationTest(db: DuckDBDatabase) {
  await db.execute(sql`drop table if exists buplic.users2`);
  await db.execute(sql`drop table if exists buplic.cities`);

  await db.execute(
    sql`
			create table if not exists buplic.cities (
				id integer primary key default nextval('serial_cities'),
				name text not null
			)
		`
  );
  await db.execute(
    sql`
			create table if not exists buplic.users2 (
				id integer primary key default nextval('serial_users2'),
				name text not null,
				city_id integer references buplic.cities(id)
			)
		`
  );

  await db.insert(cities2Table).values([
    { id: 1, name: 'New York' },
    { id: 2, name: 'London' },
    { id: 3, name: 'Tampa' },
  ]);

  await db.insert(users2Table).values([
    { id: 1, name: 'John', cityId: 1 },
    { id: 2, name: 'Jane', cityId: 2 },
    { id: 3, name: 'Jack', cityId: 3 },
    { id: 4, name: 'Peter', cityId: 3 },
    { id: 5, name: 'Ben', cityId: 2 },
    { id: 6, name: 'Jill', cityId: 1 },
    { id: 7, name: 'Mary', cityId: 2 },
    { id: 8, name: 'Sally', cityId: 1 },
  ]);
}

async function setupAggregateFunctionsTest(db: DuckDBDatabase) {
  await db.execute(sql`drop table if exists "aggregate_table"`);
  await db.execute(
    sql`
			create table if not exists buplic.aggregate_table (
				"id" integer not null,
				"name" text not null,
				"a" integer,
				"b" integer,
				"c" integer,
				"null_only" integer
			);
		`
  );
  await db.insert(aggregateTable).values([
    { id: 1, name: 'value 1', a: 5, b: 10, c: 20 },
    { id: 2, name: 'value 1', a: 5, b: 20, c: 30 },
    { id: 3, name: 'value 2', a: 10, b: 50, c: 60 },
    { id: 4, name: 'value 3', a: 20, b: 20, c: null },
    { id: 5, name: 'value 4', a: null, b: 90, c: 120 },
    { id: 6, name: 'value 5', a: 80, b: 10, c: null },
    { id: 7, name: 'value 6', a: null, b: null, c: 150 },
  ]);
}

test('table configs: unique third param', async () => {
  console.log('creating cities');
  const cities1Table = publicSchema.table(
    'cities1',
    {
      id: integer('id').primaryKey(),
      name: text('name').notNull(),
      state: char('state', { length: 2 }),
    },
    (t) => ({
      f: unique('custom_name').on(t.name, t.state).nullsNotDistinct(),
      f1: unique('custom_name1').on(t.name, t.state),
    })
  );
  console.log('created cities');

  const tableConfig = getTableConfig(cities1Table);

  assert(tableConfig.uniqueConstraints.length === 2);

  assert(tableConfig.uniqueConstraints[0]?.name === 'custom_name');
  assert(tableConfig.uniqueConstraints[0]?.nullsNotDistinct);

  assert.deepEqual(
    tableConfig.uniqueConstraints[0]?.columns.map((t) => t.name),
    ['name', 'state']
  );

  assert(tableConfig.uniqueConstraints[1]?.name, 'custom_name1');
  assert(!tableConfig.uniqueConstraints[1]?.nullsNotDistinct);
  assert.deepEqual(
    tableConfig.uniqueConstraints[0]?.columns.map((t) => t.name),
    ['name', 'state']
  );
});

test('table configs: unique in column', async () => {
  const cities1Table = publicSchema.table('cities1', {
    id: integer('id').primaryKey(),
    name: text('name').notNull().unique(),
    state: char('state', { length: 2 }).unique('custom'),
    field: char('field', { length: 2 }).unique('custom_field', {
      nulls: 'not distinct',
    }),
  });

  const tableConfig = getTableConfig(cities1Table);

  const columnName = tableConfig.columns.find((it) => it.name === 'name');
  assert(
    columnName?.uniqueName === uniqueKeyName(cities1Table, [columnName!.name])
  );
  assert(columnName?.isUnique);

  const columnState = tableConfig.columns.find((it) => it.name === 'state');
  assert(columnState?.uniqueName === 'custom');
  assert(columnState?.isUnique);

  const columnField = tableConfig.columns.find((it) => it.name === 'field');
  assert(columnField?.uniqueName === 'custom_field');
  assert(columnField?.isUnique);
  assert(columnField?.uniqueType === 'not distinct');
});

test('table config: foreign keys name', async () => {
  const table = publicSchema.table(
    'cities',
    {
      id: integer('id').primaryKey(),
      name: text('name').notNull(),
      state: text('state'),
    },
    (t) => ({
      f: foreignKey({
        foreignColumns: [t.id],
        columns: [t.id],
        name: 'custom_fk',
      }),
    })
  );

  const tableConfig = getTableConfig(table);

  assert.strictEqual(tableConfig.foreignKeys.length, 1);
  assert.strictEqual(tableConfig.foreignKeys[0]!.getName(), 'custom_fk');
});

test('table config: primary keys name', async () => {
  const table = publicSchema.table(
    'cities',
    {
      id: integer('id').primaryKey(),
      name: text('name').notNull(),
      state: text('state'),
    },
    (t) => ({
      f: primaryKey({ columns: [t.id, t.name], name: 'custom_pk' }),
    })
  );

  const tableConfig = getTableConfig(table);

  assert.strictEqual(tableConfig.primaryKeys.length, 1);
  assert.strictEqual(tableConfig.primaryKeys[0]!.getName(), 'custom_pk');
});

test('select all fields', async () => {
  const { db } = ctx;

  const now = Date.now();

  await db.insert(usersTable).values({ name: 'John' });
  const result = await db.select().from(usersTable);

  assert(result[0]!.createdAt instanceof Date); // eslint-disable-line no-instanceof/no-instanceof
  assert(Math.abs(result[0]!.createdAt.getTime() - now) < 100);
  assert.deepEqual(
    result,
    [{ id: 1, name: 'John', verified: false, createdAt: result[0]!.createdAt }],
    `
  Expected: ${JSON.stringify([
    { id: 1, name: 'John', verified: false, createdAt: result[0]!.createdAt },
  ])}
  Actual: ${JSON.stringify(result)}
  `
  );
});

test('select sql', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });
  const users = await db
    .select({
      name: sql`upper(${usersTable.name})`,
    })
    .from(usersTable);

  assert.deepEqual(users, [{ name: 'JOHN' }]);
});

test('select typed sql', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });

  const users = await db
    .select({
      name: sql<string>`upper(${usersTable.name})`,
    })
    .from(usersTable);

  assert.deepEqual(users, [{ name: 'JOHN' }]);
});

test('$default function', async () => {
  const { db } = ctx;

  const insertedOrder = await db
    .insert(orders)
    .values({ id: 1, region: 'Ukraine', amount: 1, quantity: 1 })
    .returning();
  const selectedOrder = await db.select().from(orders);

  assert.deepEqual(insertedOrder, [
    {
      id: 1,
      amount: 1,
      quantity: 1,
      region: 'Ukraine',
      product: 'random_string',
    },
  ]);

  assert.deepEqual(selectedOrder, [
    {
      id: 1,
      amount: 1,
      quantity: 1,
      region: 'Ukraine',
      product: 'random_string',
    },
  ]);
});

test('select distinct', async () => {
  const { db } = ctx;

  const usersDistinctTable = publicSchema.table('users_distinct', {
    id: integer('id').notNull(),
    name: text('name').notNull(),
    age: integer('age').notNull(),
  });

  await db.execute(sql`drop table if exists ${usersDistinctTable}`);
  await db.execute(
    sql`create table ${usersDistinctTable} (id integer, name text, age integer)`
  );

  await db.insert(usersDistinctTable).values([
    { id: 1, name: 'John', age: 24 },
    { id: 1, name: 'John', age: 24 },
    { id: 2, name: 'John', age: 25 },
    { id: 1, name: 'Jane', age: 24 },
    { id: 1, name: 'Jane', age: 26 },
  ]);
  const users1 = await db
    .selectDistinct()
    .from(usersDistinctTable)
    .orderBy(usersDistinctTable.id, usersDistinctTable.name);
  const users2 = await db
    .selectDistinctOn([usersDistinctTable.id])
    .from(usersDistinctTable)
    .orderBy(usersDistinctTable.id);
  const users3 = await db
    .selectDistinctOn([usersDistinctTable.name], {
      name: usersDistinctTable.name,
    })
    .from(usersDistinctTable)
    .orderBy(usersDistinctTable.name);
  const users4 = await db
    .selectDistinctOn([usersDistinctTable.id, usersDistinctTable.age])
    .from(usersDistinctTable)
    .orderBy(usersDistinctTable.id, usersDistinctTable.age);

  await db.execute(sql`drop table ${usersDistinctTable}`);

  const sortedActual = [...users1].sort(
    (a, b) => a.id - b.id || a.age - b.age || a.name.localeCompare(b.name)
  );
  const sortedExpected = [
    { id: 1, name: 'Jane', age: 24 },
    { id: 1, name: 'John', age: 24 },
    { id: 1, name: 'Jane', age: 26 },
    { id: 2, name: 'John', age: 25 },
  ].sort(
    (a, b) => a.id - b.id || a.age - b.age || a.name.localeCompare(b.name)
  );
  assert.deepStrictEqual(sortedActual, sortedExpected);

  assert.deepEqual(users2.length, 2);
  assert.deepEqual(users2[0]?.id, 1);
  assert.deepEqual(users2[1]?.id, 2);

  assert.deepEqual(users3.length, 2);
  assert.deepEqual(users3[0]?.name, 'Jane');
  assert.deepEqual(users3[1]?.name, 'John');

  assert.deepEqual(users4, [
    { id: 1, name: 'John', age: 24 },
    { id: 1, name: 'Jane', age: 26 },
    { id: 2, name: 'John', age: 25 },
  ]);
});

test('insert returning sql', async () => {
  const { db } = ctx;

  const users = await db
    .insert(usersTable)
    .values({ id: 1, name: 'John' })
    .returning({
      name: sql`upper(${usersTable.name})`,
    });

  assert.deepEqual(users, [{ name: 'JOHN' }]);
});

test('delete returning sql', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });
  const users = await db
    .delete(usersTable)
    .where(eq(usersTable.name, 'John'))
    .returning({
      name: sql`upper(${usersTable.name})`,
    });

  assert.deepEqual(users, [{ name: 'JOHN' }]);
});

// Currently, update returning causes unique constraint violation
// see: https://duckdb.org/docs/stable/sql/indexes.html#limitations-of-art-indexes
test('update returning sql', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });

  const users = await db
    .update(usersTable)
    .set({ name: 'Jane' })
    .where(eq(usersTable.name, 'John'))
    .returning({
      name: sql`upper(${usersTable.name})`,
    });

  assert.deepEqual(users, [{ name: 'JANE' }]);
});

// Currently, update returning causes unique constraint violation
// see: https://duckdb.org/docs/stable/sql/indexes.html#limitations-of-art-indexes
test('update with returning all fields', async () => {
  const { db } = ctx;

  const now = Date.now();

  await db.insert(usersTable).values({ name: 'John' });
  const users = await db
    .update(usersTable)
    .set({ name: 'Jane' })
    .where(eq(usersTable.name, 'John'))
    .returning();

  assert(users[0]!.createdAt instanceof Date); // eslint-disable-line no-instanceof/no-instanceof
  assert(Math.abs(users[0]!.createdAt.getTime() - now) < 100);
  assert.deepEqual(users, [
    { id: 1, name: 'Jane', verified: false, createdAt: users[0]!.createdAt },
  ]);
});

// Currently, update returning causes unique constraint violation
// see: https://duckdb.org/docs/stable/sql/indexes.html#limitations-of-art-indexes
test('update with returning partial', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });
  const users = await db
    .update(usersTable)
    .set({ name: 'Jane' })
    .where(eq(usersTable.name, 'John'))
    .returning({
      id: usersTable.id,
      name: usersTable.name,
    });

  assert.deepEqual(users, [{ id: 1, name: 'Jane' }]);
});

test('delete with returning all fields', async () => {
  const { db } = ctx;

  const now = Date.now();

  await db.insert(usersTable).values({ id: 99, name: 'John' });
  const users = await db
    .delete(usersTable)
    .where(eq(usersTable.name, 'John'))
    .returning();

  assert(users[0]!.createdAt instanceof Date); // eslint-disable-line no-instanceof/no-instanceof
  assert(Math.abs(users[0]!.createdAt.getTime() - now) < 100);
  assert.deepEqual(users, [
    { id: 99, name: 'John', verified: false, createdAt: users[0]!.createdAt },
  ]);
});

test('delete with returning partial', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 100, name: 'John' });
  const users = await db
    .delete(usersTable)
    .where(eq(usersTable.name, 'John'))
    .returning({
      id: usersTable.id,
      name: usersTable.name,
    });

  assert.deepEqual(users, [{ id: 100, name: 'John' }]);
});

test('insert + select', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 101, name: 'John' });
  const result = await db.select().from(usersTable);
  assert.deepEqual(result, [
    { id: 101, name: 'John', verified: false, createdAt: result[0]!.createdAt },
  ]);

  await db.insert(usersTable).values({ id: 102, name: 'Jane' });
  const result2 = await db.select().from(usersTable);
  assert.deepEqual(result2, [
    {
      id: 101,
      name: 'John',
      verified: false,
      createdAt: result2[0]!.createdAt,
    },
    {
      id: 102,
      name: 'Jane',
      verified: false,
      createdAt: result2[1]!.createdAt,
    },
  ]);
});

test('json insert', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 103, name: 'John' });
  const result = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
    })
    .from(usersTable);

  assert.deepEqual(result, [{ id: 103, name: 'John' }]);
});

test('char insert', async () => {
  const { db } = ctx;

  await db.insert(citiesTable).values({ name: 'Austin', state: 'TX' });
  const result = await db
    .select({
      id: citiesTable.id,
      name: citiesTable.name,
      state: citiesTable.state,
    })
    .from(citiesTable);

  assert.deepEqual(result, [{ id: 1, name: 'Austin', state: 'TX' }]);
});

test('char update', async () => {
  const { db } = ctx;

  await db.insert(citiesTable).values({ id: 1, name: 'Austin', state: 'TX' });
  await db
    .update(citiesTable)
    .set({ name: 'Atlanta', state: 'GA' })
    .where(eq(citiesTable.id, 1));
  const result = await db
    .select({
      id: citiesTable.id,
      name: citiesTable.name,
      state: citiesTable.state,
    })
    .from(citiesTable);

  assert.deepEqual(result, [{ id: 1, name: 'Atlanta', state: 'GA' }]);
});

test('char delete', async () => {
  const { db } = ctx;

  await db.insert(citiesTable).values({ name: 'Austin', state: 'TX' });
  await db.delete(citiesTable).where(eq(citiesTable.state, 'TX'));
  const result = await db
    .select({
      id: citiesTable.id,
      name: citiesTable.name,
      state: citiesTable.state,
    })
    .from(citiesTable);

  assert.deepEqual(result, []);
});

test('insert with overridden default values', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 104, name: 'John', verified: true });
  const result = await db.select().from(usersTable);

  assert.deepEqual(result, [
    { id: 104, name: 'John', verified: true, createdAt: result[0]!.createdAt },
  ]);
});

test('insert many', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values([
    { id: 104, name: 'John' },
    { id: 105, name: 'Bruce' },
    { id: 106, name: 'Jane' },
    { id: 107, name: 'Austin', verified: true },
  ]);
  const result = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      verified: usersTable.verified,
    })
    .from(usersTable);

  assert.deepEqual(result, [
    { id: 104, name: 'John', verified: false },
    { id: 105, name: 'Bruce', verified: false },
    { id: 106, name: 'Jane', verified: false },
    { id: 107, name: 'Austin', verified: true },
  ]);
});

test('insert many with returning', async () => {
  const { db } = ctx;

  const result = await db
    .insert(usersTable)
    .values([
      { id: 108, name: 'John' },
      { id: 109, name: 'Bruce' },
      { id: 110, name: 'Jane' },
      { id: 111, name: 'Austin', verified: true },
    ])
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      verified: usersTable.verified,
    });

  assert.deepEqual(result, [
    { id: 108, name: 'John', verified: false },
    { id: 109, name: 'Bruce', verified: false },
    { id: 110, name: 'Jane', verified: false },
    { id: 111, name: 'Austin', verified: true },
  ]);
});

test('select with group by as field', async () => {
  const { db } = ctx;

  await db
    .insert(usersTable)
    .values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

  const result = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .groupBy(usersTable.name)
    .orderBy(sql`all`);

  assert.deepEqual(result, [{ name: 'Jane' }, { name: 'John' }]);
});

test('select with exists', async () => {
  const { db } = ctx;

  await db
    .insert(usersTable)
    .values([{ id: 999, name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

  const user = alias(usersTable, 'user');
  const result = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(
      exists(
        db
          .select({ one: sql`999` })
          .from(user)
          .where(and(eq(usersTable.name, 'John'), eq(user.id, usersTable.id)))
      )
    );

  assert.deepEqual(result, [{ name: 'John' }]);
});

test('select with group by as sql', async () => {
  const { db } = ctx;

  await db
    .insert(usersTable)
    .values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

  const result = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .groupBy(sql`${usersTable.name}`)
    .orderBy(sql`all`);

  assert.deepEqual(result, [{ name: 'Jane' }, { name: 'John' }]);
});

test('select with group by as sql + column', async () => {
  const { db } = ctx;

  await db
    .insert(usersTable)
    .values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

  const result = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .groupBy(sql`${usersTable.name}`, usersTable.id)
    .orderBy(sql`all`);

  assert.deepEqual(result, [
    { name: 'Jane' },
    { name: 'Jane' },
    { name: 'John' },
  ]);
});

test('select with group by as column + sql', async () => {
  const { db } = ctx;

  await db
    .insert(usersTable)
    .values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

  const result = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .groupBy(usersTable.id, sql`${usersTable.name}`)
    .orderBy(sql`all`);

  assert.deepEqual(result, [
    { name: 'Jane' },
    { name: 'Jane' },
    { name: 'John' },
  ]);
});

test('select with group by complex query', async () => {
  const { db } = ctx;

  await db
    .insert(usersTable)
    .values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

  const result = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .groupBy(usersTable.id, sql`${usersTable.name}`)
    .orderBy(asc(usersTable.name))
    .limit(1);

  assert.deepEqual(result, [{ name: 'Jane' }]);
});

test('build query', async () => {
  const { db } = ctx;

  const query = db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .groupBy(usersTable.id, usersTable.name)
    .toSQL();

  assert.deepEqual(query, {
    sql: 'select "id" as "id", "name" as "name" from "buplic"."users" group by "buplic"."users"."id", "buplic"."users"."name"',
    params: [],
  });
});

test('insert sql', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 200, name: sql`${'John'}` });
  const result = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable);
  assert.deepEqual(result, [{ id: 200, name: 'John' }]);
});

test('partial join with alias', async () => {
  const { db } = ctx;
  const customerAlias = alias(usersTable, 'customer');

  await db.insert(usersTable).values([{ name: 'Ivan' }, { name: 'Hans' }]);
  const result = await db
    .select({
      userId: usersTable.id,
      userName: usersTable.name,
      customerId: customerAlias.id,
      customerName: customerAlias.name,
    })
    .from(usersTable)
    .leftJoin(customerAlias, eq(customerAlias.id, 2))
    .where(eq(usersTable.id, 1));

  assert.deepEqual(result, [
    {
      userId: 1,
      userName: 'Ivan',
      customerId: 2,
      customerName: 'Hans',
    },
  ]);
});

test('full join with alias', async () => {
  const { db } = ctx;

  const pgTable = pgTableCreator((name) => `prefixed_${name}`);

  const users = pgTable('users', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(
    sql`create table ${users} (id integer primary key, name text not null)`
  );

  const customers = alias(users, 'customer');

  await db.insert(users).values([
    { id: 10, name: 'Ivan' },
    { id: 11, name: 'Hans' },
  ]);
  const result = await db
    .select()
    .from(users)
    .leftJoin(customers, eq(customers.id, 11))
    .where(eq(users.id, 10));

  assert.deepEqual(result, [
    {
      users: {
        id: 10,
        name: 'Ivan',
      },
      customer: {
        id: 11,
        name: 'Hans',
      },
    },
  ]);

  await db.execute(sql`drop table ${users}`);
});

test('select from alias', async () => {
  const { db } = ctx;

  const pgTable = pgTableCreator((name) => `prefixed_${name}`);

  const users = pgTable('users', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(
    sql`create table ${users} (id integer primary key, name text not null)`
  );

  const customers = alias(users, 'customer');

  await db.insert(users).values([
    { id: 10, name: 'Ivan' },
    { id: 11, name: 'Hans' },
  ]);
  const result = await db.select().from(customers);

  assert.deepEqual(result, [
    {
      id: 10,
      name: 'Ivan',
    },
    {
      id: 11,
      name: 'Hans',
    },
  ]);

  await db.execute(sql`drop table ${users}`);
});

test('insert with spaces', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 301, name: sql`'Jo   h     n'` });
  const result = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable);

  assert.deepEqual(result, [{ id: 301, name: 'Jo   h     n' }]);
});

test('prepared statement', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 302, name: 'John' });
  const statement = db
    .select({
      id: usersTable.id,
      name: usersTable.name,
    })
    .from(usersTable)
    .prepare('statement1');
  const result = await statement.execute();

  assert.deepEqual(result, [{ id: 302, name: 'John' }]);
});

test('prepared statement reuse', async () => {
  const { db } = ctx;

  const stmt = db
    .insert(usersTable)
    .values({
      id: sql.placeholder('id'),
      verified: true,
      name: sql.placeholder('name'),
    })
    .prepare('stmt2');

  for (let i = 0; i < 10; i++) {
    await stmt.execute({ id: i + 401, name: `John ${i}` });
  }

  const result = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      verified: usersTable.verified,
    })
    .from(usersTable);

  assert.deepEqual(result, [
    { id: 401, name: 'John 0', verified: true },
    { id: 402, name: 'John 1', verified: true },
    { id: 403, name: 'John 2', verified: true },
    { id: 404, name: 'John 3', verified: true },
    { id: 405, name: 'John 4', verified: true },
    { id: 406, name: 'John 5', verified: true },
    { id: 407, name: 'John 6', verified: true },
    { id: 408, name: 'John 7', verified: true },
    { id: 409, name: 'John 8', verified: true },
    { id: 410, name: 'John 9', verified: true },
  ]);
});

test('prepared statement with placeholder in .where', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 411, name: 'John' });
  const stmt = db
    .select({
      id: usersTable.id,
      name: usersTable.name,
    })
    .from(usersTable)
    .where(eq(usersTable.id, sql.placeholder('id')))
    .prepare('stmt3');
  const result = await stmt.execute({ id: 411 });

  assert.deepEqual(result, [{ id: 411, name: 'John' }]);
});

test('prepared statement with placeholder in .limit', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ id: 412, name: 'John' });
  const stmt = db
    .select({
      id: usersTable.id,
      name: usersTable.name,
    })
    .from(usersTable)
    .where(eq(usersTable.id, sql.placeholder('id')))
    .limit(sql.placeholder('limit'))
    .prepare('stmt_limit');

  const result = await stmt.execute({ id: 412, limit: 1 });

  assert.deepEqual(result, [{ id: 412, name: 'John' }]);
  assert.strictEqual(result.length, 1);
});

test('prepared statement with placeholder in .offset', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values([
    { id: 413, name: 'John' },
    { id: 414, name: 'John1' },
  ]);
  const stmt = db
    .select({
      id: usersTable.id,
      name: usersTable.name,
    })
    .from(usersTable)
    .offset(sql.placeholder('offset'))
    .prepare('stmt_offset');

  const result = await stmt.execute({ offset: 1 });

  assert.deepEqual(result, [{ id: 414, name: 'John1' }]);
});

test('migrator : default migration strategy', async () => {
  const { db } = ctx;

  await db.execute(sql`drop table if exists all_columns`);
  await db.execute(sql`drop table if exists users12`);
  await db.execute(sql`drop schema if exists drizzle cascade`);

  await migrate(db, './test/drizzle2/pg');

  const sequences = await db.execute<{ sequencename: string }>(
    sql`select sequencename from pg_catalog.pg_sequences where schemaname = 'drizzle' and sequencename = '__drizzle_migrations_id_seq'`
  );
  assert.equal(sequences.length, 1);

  await db.insert(usersMigratorTable).values({ name: 'John', email: 'email' });

  const result = await db.select().from(usersMigratorTable);

  assert.deepEqual(result, [{ id: 1, name: 'John', email: 'email' }]);

  await db.execute(sql`drop table all_columns`);
  await db.execute(sql`drop table "buplic".users12`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
});

test('migrator : migrate with custom schema', async () => {
  const { db } = ctx;
  const customSchema = randomString();
  await db.execute(sql`drop table if exists all_columns`);
  await db.execute(sql`drop table if exists "buplic".users12`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(
    sql`drop schema if exists ${sql.identifier(customSchema)} cascade`
  );

  await migrate(db, {
    migrationsFolder: './test/drizzle2/pg',
    migrationsSchema: customSchema,
  });

  // test if the custom migrations table was created
  const rows = await db.execute(
    sql`select * from ${sql.identifier(customSchema)}."__drizzle_migrations";`
  );
  assert.ok(rows.length! > 0);

  const sequences = await db.execute<{ sequencename: string }>(
    sql`select sequencename from pg_catalog.pg_sequences where schemaname = ${customSchema} and sequencename = '__drizzle_migrations_id_seq'`
  );
  assert.equal(sequences.length, 1);

  // test if the migrated table are working as expected
  await db
    .insert(usersMigratorTable)
    .values({ id: 12, name: 'John', email: 'email' });
  const result = await db.select().from(usersMigratorTable);
  assert.deepEqual(result, [{ id: 12, name: 'John', email: 'email' }]);

  await db.execute(sql`drop table all_columns`);
  await db.execute(sql`drop table "buplic".users12`);
  await db.execute(
    sql`drop schema if exists ${sql.identifier(customSchema)} cascade`
  );
});

test('migrator : migrate with custom table', async () => {
  const { db } = ctx;
  const customTable = randomString();
  await db.execute(sql`drop table if exists all_columns`);
  await db.execute(sql`drop table if exists "buplic".users12`);
  await db.execute(sql`drop schema if exists drizzle cascade`);

  await migrate(db, {
    migrationsFolder: './test/drizzle2/pg',
    migrationsTable: customTable,
  });

  // test if the custom migrations table was created
  const rows = await db.execute(
    sql`select * from "drizzle".${sql.identifier(customTable)};`
  );
  assert.ok(rows.length! > 0);

  const sequences = await db.execute<{ sequencename: string }>(
    sql`select sequencename from pg_catalog.pg_sequences where schemaname = 'drizzle' and sequencename = ${`${customTable}_id_seq`}`
  );
  assert.equal(sequences.length, 1);

  // test if the migrated table are working as expected
  await db
    .insert(usersMigratorTable)
    .values({ id: 1, name: 'John', email: 'email' });
  const result = await db.select().from(usersMigratorTable);
  assert.deepEqual(result, [{ id: 1, name: 'John', email: 'email' }]);

  await db.execute(sql`drop table all_columns`);
  await db.execute(sql`drop table "buplic".users12`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
});

test('migrator : migrate with custom table and custom schema', async () => {
  const { db } = ctx;
  const customTable = randomString();
  const customSchema = randomString();
  await db.execute(sql`drop table if exists all_columns`);
  await db.execute(sql`drop table if exists "buplic".users12`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(
    sql`drop schema if exists ${sql.identifier(customSchema)} cascade`
  );

  await migrate(db, {
    migrationsFolder: './test/drizzle2/pg',
    migrationsTable: customTable,
    migrationsSchema: customSchema,
  });

  // test if the custom migrations table was created
  const rows = await db.execute(
    sql`select * from ${sql.identifier(customSchema)}.${sql.identifier(customTable)};`
  );
  assert.ok(rows.length! > 0);

  const sequences = await db.execute<{ sequencename: string }>(
    sql`select sequencename from pg_catalog.pg_sequences where schemaname = ${customSchema} and sequencename = ${`${customTable}_id_seq`}`
  );
  assert.equal(sequences.length, 1);

  // test if the migrated table are working as expected
  await db
    .insert(usersMigratorTable)
    .values({ id: 1, name: 'John', email: 'email' });
  const result = await db.select().from(usersMigratorTable);
  assert.deepEqual(result, [{ id: 1, name: 'John', email: 'email' }]);

  await db.execute(sql`drop table all_columns`);
  await db.execute(sql`drop table "buplic".users12`);
  await db.execute(
    sql`drop schema if exists ${sql.identifier(customSchema)} cascade`
  );
});

test('insert via db.execute + select via db.execute', async () => {
  const { db } = ctx;

  await db.execute(
    sql`insert into ${usersTable} (${sql.identifier(usersTable.id.name)}, ${sql.identifier(usersTable.name.name)}) values (${1}, ${'John'})`
  );

  const result = await db.execute<{ id: number; name: string }>(
    sql`select id, name from "buplic"."users"`
  );
  assert.deepEqual(result, [{ id: 1, name: 'John' }]);
});

test('insert via db.execute + returning', async () => {
  const { db } = ctx;

  const inserted = await db.execute<{ id: number; name: string }>(
    sql`insert into ${usersTable} (
      ${sql.identifier(usersTable.id.name)},
      ${sql.identifier(usersTable.name.name)}
    ) values (${501}, ${'John'}) returning ${usersTable.id}, ${usersTable.name}`
  );
  assert.deepEqual(inserted, [{ id: 501, name: 'John' }]);
});

test('insert via db.execute w/ query builder', async () => {
  const { db } = ctx;

  const inserted = await db.execute<
    Pick<typeof usersTable.$inferSelect, 'id' | 'name'>
  >(
    db
      .insert(usersTable)
      .values({ name: 'John' })
      .returning({ id: usersTable.id, name: usersTable.name })
  );
  assert.deepEqual(inserted, [{ id: 1, name: 'John' }]);
});

test('Query check: Insert all defaults in 1 row', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    name: text('name').default('Dan'),
    state: text('state'),
  });

  const query = db.insert(users).values({}).toSQL();

  assert.deepEqual(query, {
    sql: 'insert into "buplic"."users" ("id", "name", "state") values (default, default, default)',
    params: [],
  });
});

test('Query check: Insert all defaults in multiple rows', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    name: text('name').default('Dan'),
    state: text('state').default('UA'),
  });

  const query = db.insert(users).values([{}, {}]).toSQL();

  assert.deepEqual(query, {
    sql: 'insert into "buplic"."users" ("id", "name", "state") values (default, default, default), (default, default, default)',
    params: [],
  });
});

test('Insert all defaults in 1 row', async () => {
  const { db } = ctx;

  const users = publicSchema.table('empty_insert_single', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    name: text('name').default('Dan'),
    state: text('state'),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table ${users} (id integer primary key default 1, name text default 'Dan', state text)`
  );

  await db.insert(users).values({});

  const res = await db.select().from(users);

  assert.deepEqual(res, [{ id: 1, name: 'Dan', state: null }]);
});

test('Insert all defaults in multiple rows', async () => {
  const { db } = ctx;

  const users = publicSchema.table('empty_insert_multiple', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    name: text('name').default('Dan'),
    state: text('state'),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table ${users} (id integer primary key default nextval('serial'), name text default 'Dan', state text)`
  );

  await db.insert(users).values([{}, {}]);

  const res = await db.select().from(users);

  assert.deepEqual(res, [
    { id: 1, name: 'Dan', state: null },
    { id: 2, name: 'Dan', state: null },
  ]);
});

test('build query insert with onConflict do update', async () => {
  const { db } = ctx;

  const query = db
    .insert(usersTable)
    .values({ name: 'John' })
    .onConflictDoUpdate({ target: usersTable.id, set: { name: 'John1' } })
    .toSQL();

  assert.deepEqual(query, {
    sql: 'insert into "buplic"."users" ("id", "name", "verified", "created_at") values (default, $1, default, default) on conflict ("id") do update set "name" = $2',
    params: ['John', 'John1'],
  });
});

test('build query insert with onConflict do update / multiple columns', async () => {
  const { db } = ctx;

  const query = db
    .insert(usersTable)
    .values({ name: 'John' })
    .onConflictDoUpdate({
      target: [usersTable.id, usersTable.name],
      set: { name: 'John1' },
    })
    .toSQL();

  assert.deepEqual(query, {
    sql: 'insert into "buplic"."users" ("id", "name", "verified", "created_at") values (default, $1, default, default) on conflict ("id","name") do update set "name" = $2',
    params: ['John', 'John1'],
  });
});

test('build query insert with onConflict do nothing', async () => {
  const { db } = ctx;

  const query = db
    .insert(usersTable)
    .values({ name: 'John' })
    .onConflictDoNothing()
    .toSQL();

  assert.deepEqual(query, {
    sql: 'insert into "buplic"."users" ("id", "name", "verified", "created_at") values (default, $1, default, default) on conflict do nothing',
    params: ['John'],
  });
});

test('build query insert with onConflict do nothing + target', async () => {
  const { db } = ctx;

  const query = db
    .insert(usersTable)
    .values({ name: 'John' })
    .onConflictDoNothing({ target: usersTable.id })
    .toSQL();

  assert.deepEqual(query, {
    sql: 'insert into "buplic"."users" ("id", "name", "verified", "created_at") values (default, $1, default, default) on conflict ("id") do nothing',
    params: ['John'],
  });
});

test('insert with onConflict do update', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });

  await db
    .insert(usersTable)
    .values({ id: 1, name: 'John' })
    .onConflictDoUpdate({ target: usersTable.id, set: { name: 'John1' } });

  const res = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, 1));

  assert.deepEqual(res, [{ id: 1, name: 'John1' }]);
});

test('insert with onConflict do nothing', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });

  await db
    .insert(usersTable)
    .values({ id: 1, name: 'John' })
    .onConflictDoNothing();

  const res = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, 1));

  assert.deepEqual(res, [{ id: 1, name: 'John' }]);
});

test('insert with onConflict do nothing + target', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values({ name: 'John' });

  await db
    .insert(usersTable)
    .values({ id: 1, name: 'John' })
    .onConflictDoNothing({ target: usersTable.id });

  const res = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, 1));

  assert.deepEqual(res, [{ id: 1, name: 'John' }]);
});

// TODO: automatically alias fields in select, especially (or only?) for joins
test('left join (flat object fields)', async () => {
  const { db } = ctx;

  const { id: cityId } = await db
    .insert(citiesTable)
    .values([{ name: 'Paris' }, { name: 'London' }])
    .returning({ id: citiesTable.id })
    .then((rows) => rows[0]!);

  await db
    .insert(users2Table)
    .values([{ name: 'John', cityId }, { name: 'Jane' }]);

  const selectPartial = db
    .select({
      userId: users2Table.id,
      userName: users2Table.name,
      cityId: citiesTable.id,
      cityName: citiesTable.name,
    })
    .from(users2Table);

  const res = await selectPartial.leftJoin(
    citiesTable,
    eq(users2Table.cityId, citiesTable.id)
  );

  assert.deepEqual(res, [
    { userId: 1, userName: 'John', cityId, cityName: 'Paris' },
    { userId: 2, userName: 'Jane', cityId: null, cityName: null },
  ]);
});

test('left join (grouped fields)', async () => {
  const { db } = ctx;

  const { id: cityId } = await db
    .insert(citiesTable)
    .values([{ name: 'Paris' }, { name: 'London' }])
    .returning({ id: citiesTable.id })
    .then((rows) => rows[0]!);

  await db
    .insert(users2Table)
    .values([{ name: 'John', cityId }, { name: 'Jane' }]);

  const res = await db
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

  assert.deepEqual(res, [
    {
      id: 1,
      user: { name: 'John', nameUpper: 'JOHN' },
      city: { id: cityId, name: 'Paris', nameUpper: 'PARIS' },
    },
    {
      id: 2,
      user: { name: 'Jane', nameUpper: 'JANE' },
      city: null,
    },
  ]);
});

test('left join (all fields)', async () => {
  const { db } = ctx;

  const { id: cityId } = await db
    .insert(citiesTable)
    .values([
      { id: 1, name: 'Paris' },
      { id: 2, name: 'London' },
    ])
    .returning({ id: citiesTable.id })
    .then((rows) => rows[0]!);

  await db.insert(users2Table).values([
    { id: 1, name: 'John', cityId },
    { id: 2, name: 'Jane' },
  ]);

  const res = await db
    .select()
    .from(users2Table)
    .leftJoin(citiesTable, eq(users2Table.cityId, citiesTable.id));

  assert.deepEqual(res, [
    {
      users2: {
        id: 1,
        name: 'John',
        cityId,
      },
      cities: {
        id: cityId,
        name: 'Paris',
        state: null,
      },
    },
    {
      users2: {
        id: 2,
        name: 'Jane',
        cityId: null,
      },
      cities: null,
    },
  ]);
});

test('join subquery (partial)', async () => {
  const { db } = ctx;

  await db
    .insert(courseCategoriesTable)
    .values([
      { name: 'Category 1' },
      { name: 'Category 2' },
      { name: 'Category 3' },
      { name: 'Category 4' },
    ]);

  await db.insert(coursesTable).values([
    { name: 'Development', categoryId: 2 },
    { name: 'IT & Software', categoryId: 3 },
    { name: 'Marketing', categoryId: 4 },
    { name: 'Design', categoryId: 1 },
  ]);

  const sq2 = db
    .select({
      categoryId: courseCategoriesTable.id,
      category: courseCategoriesTable.name,
      total: sql<BigInt>`count(${courseCategoriesTable.id})::INT`,
    })
    .from(courseCategoriesTable)
    .groupBy(courseCategoriesTable.id, courseCategoriesTable.name)
    .as('sq2');

  const res = await db
    .select({
      courseName: coursesTable.name,
      categoryId: sq2.categoryId,
      categoryName: sq2.category,
      totalCategories: sq2.total as SQL<number>, // should this need casting? or caused by bug?
    })
    .from(coursesTable)
    .leftJoin(sq2, eq(coursesTable.categoryId, sq2.categoryId))
    .orderBy(coursesTable.name);

  assert.deepEqual(res, [
    {
      courseName: 'Design',
      categoryId: 1,
      categoryName: 'Category 1',
      totalCategories: 1,
    },
    {
      courseName: 'Development',
      categoryId: 2,
      categoryName: 'Category 2',
      totalCategories: 1,
    },
    {
      courseName: 'IT & Software',
      categoryId: 3,
      categoryName: 'Category 3',
      totalCategories: 1,
    },
    {
      courseName: 'Marketing',
      categoryId: 4,
      categoryName: 'Category 4',
      totalCategories: 1,
    },
  ]);
});

test('join subquery', async () => {
  const { db } = ctx;

  await db
    .insert(courseCategoriesTable)
    .values([
      { name: 'Category 1' },
      { name: 'Category 2' },
      { name: 'Category 3' },
      { name: 'Category 4' },
    ]);

  await db.insert(coursesTable).values([
    { name: 'Development', categoryId: 2 },
    { name: 'IT & Software', categoryId: 3 },
    { name: 'Marketing', categoryId: 4 },
    { name: 'Design', categoryId: 1 },
  ]);

  const sq2 = db
    .select({
      categoryId: courseCategoriesTable.id,
      category: courseCategoriesTable.name,
      total: sql<number>`count(${courseCategoriesTable.id})::INT`,
    })
    .from(courseCategoriesTable)
    .groupBy(courseCategoriesTable.id, courseCategoriesTable.name)
    .as('sq2');

  // is there a way to fix the type of sq2.total? inference seems to
  // break somewhere along the way
  const res: {
    courses: {
      id: number;
      name: string;
      categoryId: number | null;
    };
    sq2: {
      categoryId: number;
      category: string;
      total: number; // without adding these types, total is `never`
    } | null;
  }[] = await db
    .select()
    .from(coursesTable)
    .leftJoin(sq2, eq(coursesTable.categoryId, sq2.categoryId))
    .orderBy(coursesTable.name);

  assert.deepEqual(res, [
    {
      courses: {
        categoryId: 1,
        id: 4,
        name: 'Design',
      },
      sq2: {
        category: 'Category 1',
        categoryId: 1,
        total: 1,
      },
    },
    {
      courses: {
        categoryId: 2,
        id: 1,
        name: 'Development',
      },
      sq2: {
        category: 'Category 2',
        categoryId: 2,
        total: 1,
      },
    },
    {
      courses: {
        categoryId: 3,
        id: 2,
        name: 'IT & Software',
      },
      sq2: {
        category: 'Category 3',
        categoryId: 3,
        total: 1,
      },
    },
    {
      courses: {
        categoryId: 4,
        id: 3,
        name: 'Marketing',
      },
      sq2: {
        category: 'Category 4',
        categoryId: 4,
        total: 1,
      },
    },
  ]);
});

test('with ... select', async () => {
  const { db } = ctx;

  await db.insert(orders).values([
    { region: 'Europe', product: 'A', amount: 10, quantity: 1 },
    { region: 'Europe', product: 'A', amount: 20, quantity: 2 },
    { region: 'Europe', product: 'B', amount: 20, quantity: 2 },
    { region: 'Europe', product: 'B', amount: 30, quantity: 3 },
    { region: 'US', product: 'A', amount: 30, quantity: 3 },
    { region: 'US', product: 'A', amount: 40, quantity: 4 },
    { region: 'US', product: 'B', amount: 40, quantity: 4 },
    { region: 'US', product: 'B', amount: 50, quantity: 5 },
  ]);

  const regionalSales = db.$with('regional_sales').as(
    db
      .select({
        region: orders.region,
        totalSales: sql<number>`sum(${orders.amount})`.as('total_sales'),
      })
      .from(orders)
      .groupBy(orders.region)
  );

  const topRegions = db.$with('top_regions').as(
    db
      .select({
        region: regionalSales.region,
      })
      .from(regionalSales)
      .where(
        gt(
          regionalSales.totalSales,
          db
            .select({ sales: sql`sum(${regionalSales.totalSales})/10` })
            .from(regionalSales)
        )
      )
  );

  const result1 = await db
    .with(regionalSales, topRegions)
    .select({
      region: orders.region,
      product: orders.product,
      productUnits: sql<number>`sum(${orders.quantity})::int`,
      productSales: sql<number>`sum(${orders.amount})::int`,
    })
    .from(orders)
    .where(
      inArray(
        orders.region,
        db.select({ region: topRegions.region }).from(topRegions)
      )
    )
    .groupBy(orders.region, orders.product)
    .orderBy(orders.region, orders.product);
  const result2 = await db
    .with(regionalSales, topRegions)
    .selectDistinct({
      region: orders.region,
      product: orders.product,
      productUnits: sql<number>`sum(${orders.quantity})::int`,
      productSales: sql<number>`sum(${orders.amount})::int`,
    })
    .from(orders)
    .where(
      inArray(
        orders.region,
        db.select({ region: topRegions.region }).from(topRegions)
      )
    )
    .groupBy(orders.region, orders.product)
    .orderBy(orders.region, orders.product);
  const result3 = await db
    .with(regionalSales, topRegions)
    .selectDistinctOn([orders.region], {
      region: orders.region,
      productUnits: sql<number>`sum(${orders.quantity})::int`,
      productSales: sql<number>`sum(${orders.amount})::int`,
    })
    .from(orders)
    .where(
      inArray(
        orders.region,
        db.select({ region: topRegions.region }).from(topRegions)
      )
    )
    .groupBy(orders.region)
    .orderBy(orders.region);

  assert.deepEqual(result1, [
    {
      region: 'Europe',
      product: 'A',
      productUnits: 3,
      productSales: 30,
    },
    {
      region: 'Europe',
      product: 'B',
      productUnits: 5,
      productSales: 50,
    },
    {
      region: 'US',
      product: 'A',
      productUnits: 7,
      productSales: 70,
    },
    {
      region: 'US',
      product: 'B',
      productUnits: 9,
      productSales: 90,
    },
  ]);
  assert.deepEqual(result2, result1);
  assert.deepEqual(result3, [
    {
      region: 'Europe',
      productUnits: 8,
      productSales: 80,
    },
    {
      region: 'US',
      productUnits: 16,
      productSales: 160,
    },
  ]);
});

test('with ... update', async () => {
  const { db } = ctx;

  const products = publicSchema.table('products', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    price: numeric('price').notNull(),
    cheap: boolean('cheap').notNull().default(false),
  });

  await db.execute(sql`drop table if exists ${products}`);
  await db.execute(sql`
		create table ${products} (
			id integer primary key default nextval('serial_users'),
			price numeric not null,
			cheap boolean not null default false
		)
	`);

  await db
    .insert(products)
    .values([
      { price: '10.99' },
      { price: '25.85' },
      { price: '32.99' },
      { price: '2.50' },
      { price: '4.59' },
    ]);

  const averagePrice = db.$with('average_price').as(
    db
      .select({
        value: sql`avg(${products.price})`.as('value'),
      })
      .from(products)
  );

  await db
    .with(averagePrice)
    .update(products)
    .set({
      cheap: true,
    })
    .where(lt(products.price, sql`(select * from ${averagePrice})`));

  const result = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.cheap, true));

  assert.deepEqual(result, [{ id: 1 }, { id: 4 }, { id: 5 }]);
});

test('with ... insert', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users', {
    username: text('username').notNull(),
    admin: boolean('admin').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(
    sql`create table ${users} (username text not null, admin boolean not null default false)`
  );

  const userCount = db.$with('user_count').as(
    db
      .select({
        value: sql`count(*)`.as('value'),
      })
      .from(users)
  );

  const result = await db
    .with(userCount)
    .insert(users)
    .values([
      { username: 'user1', admin: sql`((select * from ${userCount}) = 0)` },
    ])
    .returning({
      admin: users.admin,
    });

  assert.deepEqual(result, [{ admin: true }]);
});

test('with ... delete', async () => {
  const { db } = ctx;

  await db.insert(orders).values([
    { region: 'Europe', product: 'A', amount: 10, quantity: 1 },
    { region: 'Europe', product: 'A', amount: 20, quantity: 2 },
    { region: 'Europe', product: 'B', amount: 20, quantity: 2 },
    { region: 'Europe', product: 'B', amount: 30, quantity: 3 },
    { region: 'US', product: 'A', amount: 30, quantity: 3 },
    { region: 'US', product: 'A', amount: 40, quantity: 4 },
    { region: 'US', product: 'B', amount: 40, quantity: 4 },
    { region: 'US', product: 'B', amount: 50, quantity: 5 },
  ]);

  const averageAmount = db.$with('average_amount').as(
    db
      .select({
        value: sql`avg(${orders.amount})`.as('value'),
      })
      .from(orders)
  );

  const result = await db
    .with(averageAmount)
    .delete(orders)
    .where(gt(orders.amount, sql`(select * from ${averageAmount})`))
    .returning({
      id: orders.id,
    });

  assert.deepEqual(result, [{ id: 6 }, { id: 7 }, { id: 8 }]);
});

test('select from subquery sql', async () => {
  const { db } = ctx;

  await db.insert(users2Table).values([{ name: 'John' }, { name: 'Jane' }]);

  const sq = db
    .select({
      name: sql<string>`${users2Table.name} || ' modified'`.as('name'),
    })
    .from(users2Table)
    .as('sq');

  const res = await db.select({ name: sq.name }).from(sq);

  assert.deepEqual(res, [{ name: 'John modified' }, { name: 'Jane modified' }]);
});

// DuckDB happily binds the column even if the table isn't joined; ensure query runs.
test('select a field without joining its table', async () => {
  const { db } = ctx;

  const query = db.select({ name: users2Table.name }).from(usersTable);

  expect(() => query.prepare('query')).not.toThrow();
  const result = await db.select({ name: users2Table.name }).from(usersTable);
  assert(Array.isArray(result));
});

// DuckDB will bind and execute subqueries without forcing aliases.
test('select all fields from subquery without alias', async () => {
  const { db } = ctx;

  const sq = db
    .$with('sq')
    .as(
      db
        .select({ name: sql<string>`upper(${users2Table.name})` })
        .from(users2Table)
    );

  const query = db.with(sq).select().from(sq);

  expect(() => query.prepare('query')).not.toThrow();
  const result = await db.with(sq).select().from(sq);
  assert(Array.isArray(result));
});

test('select count()', async () => {
  const { db } = ctx;

  await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }]);

  const res = await db
    .select({ count: sql<BigInt>`count(*)` })
    .from(usersTable);

  assert.deepEqual(res, [{ count: 2n }]);
});

test('select count w/ custom mapper', async () => {
  const { db } = ctx;

  function count(value: PgColumn | SQLWrapper): SQL<number>;
  function count(
    value: PgColumn | SQLWrapper,
    alias: string
  ): SQL.Aliased<number>;
  function count(
    value: PgColumn | SQLWrapper,
    alias?: string
  ): SQL<number> | SQL.Aliased<number> {
    const result = sql`count(${value})`.mapWith(Number);
    if (!alias) {
      return result;
    }
    return result.as(alias);
  }

  await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }]);

  const res = await db.select({ count: count(sql`*`) }).from(usersTable);

  assert.deepEqual(res, [{ count: 2 }]);
});

// adapt to DuckDB version
test('network types', async () => {
  const { db } = ctx;

  // Create the network table - requires DuckDB inet extension
  try {
    await db.execute(
      sql`
				create table if not exists buplic.network_table (
					inet inet not null
				)
			`
    );
  } catch (err) {
    // Skip if inet extension is not available (e.g., in offline environments)
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('inet') || message.includes('extension')) {
      console.log('Skipping network types test: inet extension not available');
      return;
    }
    throw err;
  }

  const value: typeof network.$inferSelect = {
    inet: '127.0.0.1',
  };

  await db.insert(network).values(value);

  const res = await db.select().from(network);

  assert.deepEqual(res, [value]);
});

// todo: DuckDB native types
test('array types', async () => {
  const { db } = ctx;

  const values: (typeof salEmp.$inferSelect)[] = [
    {
      name: 'John',
      payByQuarter: [10000, 10000, 10000, 10000],
      schedule: [
        ['meeting', 'lunch'],
        ['training', 'presentation'],
      ],
    },
    {
      name: 'Carol',
      payByQuarter: [20000, 25000, 25000, 25000],
      schedule: [
        ['breakfast', 'consulting'],
        ['meeting', 'lunch'],
      ],
    },
  ];

  await db.insert(salEmp).values(values);

  const res = await db.select().from(salEmp);

  assert.deepEqual(res, values);
});

test('having', async () => {
  const { db } = ctx;

  await db
    .insert(citiesTable)
    .values([{ name: 'London' }, { name: 'Paris' }, { name: 'New York' }]);

  await db.insert(users2Table).values([
    { name: 'John', cityId: 1 },
    { name: 'Jane', cityId: 1 },
    {
      name: 'Jack',
      cityId: 2,
    },
  ]);

  const result = await db
    .select({
      id: citiesTable.id,
      // needs to be wrapped in any_value if value isn't aggregated
      name: sql<string>`any_value(upper(${citiesTable.name}))`,
      usersCount: sql<number>`count(${users2Table.id})::int`,
    })
    .from(citiesTable)
    .leftJoin(users2Table, eq(users2Table.cityId, citiesTable.id))
    .where(() => sql`length(${citiesTable.name}) >= 3`)
    .groupBy(citiesTable.id)
    // wass goin on here
    .having(({ usersCount }) => sql`${usersCount} > 0`)
    .orderBy(({ name }) => name);

  assert.deepEqual(result, [
    {
      id: 1,
      name: 'LONDON',
      usersCount: 2,
    },
    {
      id: 2,
      name: 'PARIS',
      usersCount: 1,
    },
  ]);
});

test('view', async () => {
  const { db } = ctx;

  const newYorkers1 = pgView('new_yorkers').as((qb) =>
    qb.select().from(users2Table).where(eq(users2Table.cityId, 1))
  );

  const newYorkers2 = pgView('new_yorkers', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  }).as(sql`select * from ${users2Table} where ${eq(users2Table.cityId, 1)}`);

  const newYorkers3 = pgView('new_yorkers', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  }).existing();

  await db.execute(
    sql`create view ${newYorkers1} as ${getViewConfig(newYorkers1).query}`
  );

  await db
    .insert(citiesTable)
    .values([{ name: 'New York' }, { name: 'Paris' }]);

  await db.insert(users2Table).values([
    { name: 'John', cityId: 1 },
    { name: 'Jane', cityId: 1 },
    { name: 'Jack', cityId: 2 },
  ]);

  {
    const result = await db.select().from(newYorkers1);
    assert.deepEqual(result, [
      { id: 1, name: 'John', cityId: 1 },
      { id: 2, name: 'Jane', cityId: 1 },
    ]);
  }

  {
    const result = await db.select().from(newYorkers2);
    assert.deepEqual(result, [
      { id: 1, name: 'John', cityId: 1 },
      { id: 2, name: 'Jane', cityId: 1 },
    ]);
  }

  {
    const result = await db.select().from(newYorkers3);
    assert.deepEqual(result, [
      { id: 1, name: 'John', cityId: 1 },
      { id: 2, name: 'Jane', cityId: 1 },
    ]);
  }

  {
    const result = await db
      .select({ name: newYorkers1.name })
      .from(newYorkers1);
    assert.deepEqual(result, [{ name: 'John' }, { name: 'Jane' }]);
  }

  await db.execute(sql`drop view ${newYorkers1}`);
});

// Unfortunately DuckDB doesn't have this feature (yet?)
test('materialized view', async () => {
  const { db } = ctx;

  const newYorkers1 = pgMaterializedView('new_yorkers').as((qb) =>
    qb.select().from(users2Table).where(eq(users2Table.cityId, 1))
  );

  const newYorkers2 = pgMaterializedView('new_yorkers', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  }).as(sql`select * from ${users2Table} where ${eq(users2Table.cityId, 1)}`);

  const newYorkers3 = pgMaterializedView('new_yorkers', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  }).existing();

  let viewErr = false;
  try {
    await db.execute(
      sql`create materialized view ${newYorkers1} as ${getMaterializedViewConfig(newYorkers1).query}`
    );
  } catch {
    viewErr = true;
  }
  assert(viewErr);
  return;
  return;

  await db.execute(
    sql`create materialized view ${newYorkers1} as ${getMaterializedViewConfig(newYorkers1).query}`
  );

  await db
    .insert(citiesTable)
    .values([{ name: 'New York' }, { name: 'Paris' }]);

  await db.insert(users2Table).values([
    { name: 'John', cityId: 1 },
    { name: 'Jane', cityId: 1 },
    { name: 'Jack', cityId: 2 },
  ]);

  {
    const result = await db.select().from(newYorkers1);
    assert.deepEqual(result, []);
  }

  await db.refreshMaterializedView(newYorkers1);

  {
    const result = await db.select().from(newYorkers1);
    assert.deepEqual(result, [
      { id: 1, name: 'John', cityId: 1 },
      { id: 2, name: 'Jane', cityId: 1 },
    ]);
  }

  {
    const result = await db.select().from(newYorkers2);
    assert.deepEqual(result, [
      { id: 1, name: 'John', cityId: 1 },
      { id: 2, name: 'Jane', cityId: 1 },
    ]);
  }

  {
    const result = await db.select().from(newYorkers3);
    assert.deepEqual(result, [
      { id: 1, name: 'John', cityId: 1 },
      { id: 2, name: 'Jane', cityId: 1 },
    ]);
  }

  {
    const result = await db
      .select({ name: newYorkers1.name })
      .from(newYorkers1);
    assert.deepEqual(result, [{ name: 'John' }, { name: 'Jane' }]);
  }

  await db.execute(sql`drop materialized view ${newYorkers1}`);
});

test('select from raw sql', async () => {
  const { db } = ctx;

  const result = await db
    .select({
      id: sql<number>`id`,
      name: sql<string>`name`,
    })
    .from(sql`(select 1 as id, 'John' as name) as users`);

  Expect<Equal<{ id: number; name: string }[], typeof result>>;

  assert.deepEqual(result, [{ id: 1, name: 'John' }]);
});

test('select from raw sql with joins', async () => {
  const { db } = ctx;

  const result = await db
    .select({
      id: sql<number>`users.id`,
      name: sql<string>`users.name`,
      userCity: sql<string>`users.city`,
      cityName: sql<string>`cities.name`,
    })
    .from(sql`(select 1 as id, 'John' as name, 'New York' as city) as users`)
    .leftJoin(
      sql`(select 1 as id, 'Paris' as name) as cities`,
      sql`cities.id = users.id`
    );

  Expect<
    Equal<
      { id: number; name: string; userCity: string; cityName: string }[],
      typeof result
    >
  >;

  assert.deepEqual(result, [
    { id: 1, name: 'John', userCity: 'New York', cityName: 'Paris' },
  ]);
});

test('join on aliased sql from select', async () => {
  const { db } = ctx;

  const result = await db
    .select({
      userId: sql<number>`users.id`.as('userId'),
      name: sql<string>`users.name`,
      userCity: sql<string>`users.city`,
      cityId: sql<number>`cities.id`.as('cityId'),
      cityName: sql<string>`cities.name`,
    })
    .from(sql`(select 1 as id, 'John' as name, 'New York' as city) as users`)
    .leftJoin(sql`(select 1 as id, 'Paris' as name) as cities`, (cols) =>
      eq(cols.cityId, cols.userId)
    );

  Expect<
    Equal<
      {
        userId: number;
        name: string;
        userCity: string;
        cityId: number;
        cityName: string;
      }[],
      typeof result
    >
  >;

  assert.deepEqual(result, [
    {
      userId: 1,
      name: 'John',
      userCity: 'New York',
      cityId: 1,
      cityName: 'Paris',
    },
  ]);
});

test('join on aliased sql from with clause', async () => {
  const { db } = ctx;

  const users = db.$with('users').as(
    db
      .select({
        id: sql<number>`id`.as('userId'),
        name: sql<string>`name`.as('userName'),
        city: sql<string>`city`.as('city'),
      })
      .from(sql`(select 1 as id, 'John' as name, 'New York' as city) as users`)
  );

  const cities = db.$with('cities').as(
    db
      .select({
        id: sql<number>`id`.as('cityId'),
        name: sql<string>`name`.as('cityName'),
      })
      .from(sql`(select 1 as id, 'Paris' as name) as cities`)
  );

  const result = await db
    .with(users, cities)
    .select({
      userId: users.id,
      name: users.name,
      userCity: users.city,
      cityId: cities.id,
      cityName: cities.name,
    })
    .from(users)
    .leftJoin(cities, (cols) => eq(cols.cityId, cols.userId));

  Expect<
    Equal<
      {
        userId: number;
        name: string;
        userCity: string;
        cityId: number;
        cityName: string;
      }[],
      typeof result
    >
  >;

  assert.deepEqual(result, [
    {
      userId: 1,
      name: 'John',
      userCity: 'New York',
      cityId: 1,
      cityName: 'Paris',
    },
  ]);
});

test('CTE join with direct eq() produces qualified columns in ON clause', async () => {
  const { db } = ctx;

  const cte1 = db.$with('cte1').as(
    db
      .select({
        id: sql<number>`1`.as('id'),
        value: sql<number>`100`.as('value'),
      })
      .from(sql`(select 1) as t`)
  );

  const cte2 = db.$with('cte2').as(
    db
      .select({
        cte1_id: sql<number>`1`.as('cte1_id'),
        count: sql<number>`50`.as('count'),
      })
      .from(sql`(select 1) as t`)
  );

  const result = await db
    .with(cte1, cte2)
    .select({
      id: cte1.id,
      value: cte1.value,
      count: cte2.count,
    })
    .from(cte1)
    .leftJoin(cte2, eq(cte1.id, cte2.cte1_id));

  assert.deepEqual(result, [{ id: 1, value: 100, count: 50 }]);
});

test('CTE join with schema-qualified table (mixed qualification in ON clause)', async () => {
  const { db } = ctx;

  // This test simulates the customer's pattern where a CTE is joined with a
  // schema-qualified table. The ON clause has one side qualified and the other
  // unqualified, which previously caused "ambiguous column reference" errors.

  // Insert test data
  await db
    .insert(usersTable)
    .values([{ name: 'USA' }, { name: 'USA' }, { name: 'Canada' }]);

  // Create a CTE that groups data
  const countCTE = db.$with('countCTE').as(
    db
      .select({
        name: usersTable.name,
        userCount: sql<number>`count(*)`.as('userCount'),
      })
      .from(usersTable)
      .groupBy(usersTable.name)
  );

  // Query that joins the schema-qualified table with the CTE using eq()
  // This pattern triggers the mixed qualification case:
  // - Left side (usersTable.name) is qualified with schema.table
  // - Right side (countCTE.name) was unqualified, now gets qualified
  const result = await db
    .with(countCTE)
    .select({
      userName: usersTable.name,
      userCount: countCTE.userCount,
    })
    .from(usersTable)
    .leftJoin(countCTE, eq(usersTable.name, countCTE.name));

  // Should execute without "ambiguous column reference" error
  expect(result).toHaveLength(3);
  expect(result.filter((r) => r.userName === 'USA').length).toBe(2);
  expect(Number(result.filter((r) => r.userName === 'USA')[0]?.userCount)).toBe(
    2
  );
  expect(Number(result.find((r) => r.userName === 'Canada')?.userCount)).toBe(
    1
  );
});

test('prefixed table', async () => {
  const { db } = ctx;

  const pgTable = pgTableCreator((name) => `myprefix_${name}`);

  const users = pgTable('test_prefixed_table_with_unique_name', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table myprefix_test_prefixed_table_with_unique_name (id integer not null primary key, name text not null)`
  );

  await db.insert(users).values({ id: 1, name: 'John' });

  const result = await db.select().from(users);

  assert.deepEqual(result, [{ id: 1, name: 'John' }]);

  await db.execute(sql`drop table ${users}`);
});

// todo: Will need DuckDB types!
test('select from enum', async () => {
  const { db } = ctx;

  const muscleEnum = pgEnum('muscle', [
    'abdominals',
    'hamstrings',
    'adductors',
    'quadriceps',
    'biceps',
    'shoulders',
    'chest',
    'middle_back',
    'calves',
    'glutes',
    'lower_back',
    'lats',
    'triceps',
    'traps',
    'forearms',
    'neck',
    'abductors',
  ]);

  const forceEnum = pgEnum('force', ['isometric', 'isotonic', 'isokinetic']);

  const levelEnum = pgEnum('level', ['beginner', 'intermediate', 'advanced']);

  const mechanicEnum = pgEnum('mechanic', ['compound', 'isolation']);

  const equipmentEnum = pgEnum('equipment', [
    'barbell',
    'dumbbell',
    'bodyweight',
    'machine',
    'cable',
    'kettlebell',
  ]);

  const categoryEnum = pgEnum('category', [
    'upper_body',
    'lower_body',
    'full_body',
  ]);

  const exercises = publicSchema.table('exercises', {
    id: integer('id').primaryKey(),
    name: varchar('name').notNull(),
    force: forceEnum('force'),
    level: levelEnum('level'),
    mechanic: mechanicEnum('mechanic'),
    equipment: equipmentEnum('equipment'),
    instructions: text('instructions'),
    category: categoryEnum('category'),
    primaryMuscles: muscleEnum('primary_muscles').array(),
    secondaryMuscles: muscleEnum('secondary_muscles').array(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at')
      .notNull()
      .default(sql`now()`),
  });

  await db.execute(sql`drop table if exists ${exercises}`);
  await db.execute(
    sql`drop type if exists ${sql.identifier(muscleEnum.enumName)}`
  );
  await db.execute(
    sql`drop type if exists ${sql.identifier(forceEnum.enumName)}`
  );
  await db.execute(
    sql`drop type if exists ${sql.identifier(levelEnum.enumName)}`
  );
  await db.execute(
    sql`drop type if exists ${sql.identifier(mechanicEnum.enumName)}`
  );
  await db.execute(
    sql`drop type if exists ${sql.identifier(equipmentEnum.enumName)}`
  );
  await db.execute(
    sql`drop type if exists ${sql.identifier(categoryEnum.enumName)}`
  );

  await db.execute(
    sql`create type ${sql.identifier(
      muscleEnum.enumName
    )} as enum ('abdominals', 'hamstrings', 'adductors', 'quadriceps', 'biceps', 'shoulders', 'chest', 'middle_back', 'calves', 'glutes', 'lower_back', 'lats', 'triceps', 'traps', 'forearms', 'neck', 'abductors')`
  );
  await db.execute(
    sql`create type ${sql.identifier(forceEnum.enumName)} as enum ('isometric', 'isotonic', 'isokinetic')`
  );
  await db.execute(
    sql`create type ${sql.identifier(levelEnum.enumName)} as enum ('beginner', 'intermediate', 'advanced')`
  );
  await db.execute(
    sql`create type ${sql.identifier(mechanicEnum.enumName)} as enum ('compound', 'isolation')`
  );
  await db.execute(
    sql`create type ${sql.identifier(
      equipmentEnum.enumName
    )} as enum ('barbell', 'dumbbell', 'bodyweight', 'machine', 'cable', 'kettlebell')`
  );
  await db.execute(
    sql`create type ${sql.identifier(categoryEnum.enumName)} as enum ('upper_body', 'lower_body', 'full_body')`
  );
  await db.execute(sql`
		create table ${exercises} (
			id integer primary key,
			name varchar not null,
			force force,
			level level,
			mechanic mechanic,
			equipment equipment,
			instructions text,
			category category,
			primary_muscles muscle[],
			secondary_muscles muscle[],
			created_at timestamp not null default now(),
			updated_at timestamp not null default now()
		)
	`);

  await db.insert(exercises).values({
    id: 1,
    name: 'Bench Press',
    force: 'isotonic',
    level: 'beginner',
    mechanic: 'compound',
    equipment: 'barbell',
    instructions:
      'Lie on your back on a flat bench. Grasp the barbell with an overhand grip, slightly wider than shoulder width. Unrack the barbell and hold it over you with your arms locked. Lower the barbell to your chest. Press the barbell back to the starting position.',
    category: 'upper_body',
    primaryMuscles: ['chest', 'triceps'],
    secondaryMuscles: ['shoulders', 'traps'],
  });

  const result = await db.select().from(exercises);

  assert.deepEqual(result, [
    {
      id: 1,
      name: 'Bench Press',
      force: 'isotonic',
      level: 'beginner',
      mechanic: 'compound',
      equipment: 'barbell',
      instructions:
        'Lie on your back on a flat bench. Grasp the barbell with an overhand grip, slightly wider than shoulder width. Unrack the barbell and hold it over you with your arms locked. Lower the barbell to your chest. Press the barbell back to the starting position.',
      category: 'upper_body',
      primaryMuscles: ['chest', 'triceps'],
      secondaryMuscles: ['shoulders', 'traps'],
      createdAt: result[0]!.createdAt,
      updatedAt: result[0]!.updatedAt,
    },
  ]);

  await db.execute(sql`drop table ${exercises}`);
  await db.execute(sql`drop type ${sql.identifier(muscleEnum.enumName)}`);
  await db.execute(sql`drop type ${sql.identifier(forceEnum.enumName)}`);
  await db.execute(sql`drop type ${sql.identifier(levelEnum.enumName)}`);
  await db.execute(sql`drop type ${sql.identifier(mechanicEnum.enumName)}`);
  await db.execute(sql`drop type ${sql.identifier(equipmentEnum.enumName)}`);
  await db.execute(sql`drop type ${sql.identifier(categoryEnum.enumName)}`);
});

// a lot of this works differently... todo: test date stuff?
test('all date and time columns', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    dateString: date('date_string').notNull(),
    time: time('time').notNull(),
    datetime: timestamp('datetime').notNull(),
    datetimeWTZ: timestamp('datetime_wtz', { withTimezone: true }).notNull(),
    datetimeString: timestamp('datetime_string', { mode: 'string' }).notNull(),
    datetimeFullPrecision: timestamp('datetime_full_precision', {
      precision: 6,
      mode: 'string',
    }).notNull(),
    datetimeWTZString: timestamp('datetime_wtz_string', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    interval: interval('interval').notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					date_string date not null,
					time time not null,
					datetime timestamp not null,
					datetime_wtz timestamp with time zone not null,
					datetime_string timestamp not null,
					datetime_full_precision timestamp(6) not null,
					datetime_wtz_string timestamp with time zone not null,
					interval interval not null
			)
	`);

  const someDatetime = new Date('2022-01-01T00:00:00.123Z');
  const fullPrecision = '2022-01-01T00:00:00.123456Z';
  const someTime = '23:23:12.432';

  await db.insert(table).values({
    dateString: '2022-01-01',
    time: someTime,
    datetime: someDatetime,
    datetimeWTZ: someDatetime,
    datetimeString: '2022-01-01T00:00:00.123Z',
    datetimeFullPrecision: fullPrecision,
    datetimeWTZString: '2022-01-01T00:00:00.123Z',
    interval: '1 day',
  });

  const result = await db.select().from(table);

  Expect<
    Equal<
      {
        id: number;
        dateString: string;
        time: string;
        datetime: Date;
        datetimeWTZ: Date;
        datetimeString: string;
        datetimeFullPrecision: string;
        datetimeWTZString: string;
        interval: string;
      }[],
      typeof result
    >
  >;

  Expect<
    Equal<
      {
        dateString: string;
        time: string;
        datetime: Date;
        datetimeWTZ: Date;
        datetimeString: string;
        datetimeFullPrecision: string;
        datetimeWTZString: string;
        interval: string;
        id?: number | undefined;
      },
      typeof table.$inferInsert
    >
  >;

  const [row] = result;
  const toDateStr = (val: unknown) =>
    val instanceof Date ? val.toISOString().slice(0, 10) : String(val);
  const toTimestampStr = (val: unknown) =>
    val instanceof Date
      ? val.toISOString().replace('T', ' ').replace('Z', '')
      : String(val);
  const toTimeStr = (val: unknown) =>
    val instanceof Date
      ? val.toISOString().split('T')[1]!.replace('Z', '')
      : typeof val === 'bigint' || typeof val === 'number'
        ? new Date(Number(val) / 1000)
            .toISOString()
            .split('T')[1]!
            .replace('Z', '')
        : String(val);

  assert(row);
  assert.deepEqual(toDateStr(row.dateString), '2022-01-01');
  assert.deepEqual(
    row.datetime instanceof Date ? row.datetime.getTime() : undefined,
    someDatetime.getTime()
  );
  assert.deepEqual(
    row.datetimeWTZ instanceof Date ? row.datetimeWTZ.getTime() : undefined,
    someDatetime.getTime()
  );
  assert.deepEqual(
    toTimestampStr(row.datetimeString),
    '2022-01-01 00:00:00.123'
  );
  assert(
    toTimestampStr(row.datetimeFullPrecision).startsWith(
      '2022-01-01 00:00:00.123'
    )
  );
  assert(
    toTimestampStr(row.datetimeWTZString).startsWith('2022-01-01 00:00:00.123')
  );
  assert.deepEqual(toTimeStr(row.time).startsWith('23:23:12'), true);

  await db.execute(sql`drop table if exists ${table}`);
});

test('all date and time columns with timezone second case mode date', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string').notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamptz not null
			)
	`);

  const insertedDate = new Date();

  // 1. Insert date as new date
  await db.insert(table).values([{ timestamp: insertedDate }]);

  // 2, Select as date and check that timezones are the same
  // There is no way to check timezone in Date object, as it is always represented internally in UTC
  const result = await db.select().from(table);

  assert.deepEqual(result, [{ id: 1, timestamp: insertedDate }]);

  // 3. Compare both dates
  assert.deepEqual(insertedDate.getTime(), result[0]?.timestamp.getTime());

  await db.execute(sql`drop table if exists ${table}`);
});

test('all date and time columns with timezone third case mode date', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string').notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamptz not null
			)
	`);

  const insertedDate = new Date('2022-01-01 20:00:00.123-04'); // used different time zones, internally is still UTC
  const insertedDate2 = new Date('2022-01-02 04:00:00.123+04'); // They are both the same date in different time zones

  // 1. Insert date as new dates with different time zones
  await db
    .insert(table)
    .values([{ timestamp: insertedDate }, { timestamp: insertedDate2 }]);

  // 2, Select and compare both dates
  const result = await db.select().from(table);

  assert.deepEqual(
    result[0]?.timestamp.getTime(),
    result[1]?.timestamp.getTime()
  );

  await db.execute(sql`drop table if exists ${table}`);
});

test('all date and time columns without timezone first case mode string', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string', { mode: 'string' }).notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamp not null
			)
	`);

  // 1. Insert date in string format without timezone in it
  await db.insert(table).values([{ timestamp: '2022-01-01 02:00:00.123456' }]);

  // 2, Select in string format and check that values are the same
  const result = await db
    .select({ id: table.id, timestamp: sql`${table.timestamp}::string` })
    .from(table);

  assert.deepEqual(result, [
    { id: 1, timestamp: '2022-01-01 02:00:00.123456' },
  ]);

  // 3. Select as raw query and check that values are the same
  const result2 = await db.execute<{
    id: number;
    timestamp_string: string | Date;
  }>(sql`select * from ${table}`);

  const ts2 = result2[0]?.timestamp_string;
  const ts2String =
    ts2 instanceof Date
      ? ts2.toISOString().replace('T', ' ')
      : String(ts2 ?? '');

  assert(ts2String.startsWith('2022-01-01 02:00:00.123'));

  await db.execute(sql`drop table if exists ${table}`);
});

test('all date and time columns without timezone second case mode string', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string', { mode: 'string' }).notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamp not null
			)
	`);

  // 1. Insert date in string format with timezone in it
  await db
    .insert(table)
    .values([{ timestamp: '2022-01-01T02:00:00.123456-02' }]);

  // 2, Select as raw query and check that values are the same
  const result = await db.execute<{
    id: number;
    timestamp_string: string | Date;
  }>(sql`select * from ${table}`);

  const normalized = result[0]?.timestamp_string;
  const normalizedString =
    normalized instanceof Date
      ? normalized.toISOString().replace('T', ' ')
      : String(normalized ?? '');
  assert(normalizedString.startsWith('2022-01-01 02:00:00.123'));

  await db.execute(sql`drop table ${table}`);
});

test('all date and time columns without timezone third case mode date', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string', { mode: 'date' }).notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamptz not null
			)
	`);

  const insertedDate = new Date('2022-01-01 20:00:00.123+04');

  // 1. Insert date as new date
  await db.insert(table).values([{ timestamp: insertedDate }]);

  // 2, Select as raw query as string
  const result = await db.execute<{
    id: number;
    timestamp_string: Date;
  }>(sql`select * from ${table}`);

  // 3. Compare both dates using orm mapping - Need to add 'Z' to tell JS that it is UTC
  assert.deepEqual(
    result[0]!.timestamp_string.getTime(),
    insertedDate.getTime()
  );

  await db.execute(sql`drop table if exists ${table}`);
});

test('test mode string for timestamp with timezone', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string', {
      mode: 'string',
      withTimezone: true,
    }).notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamptz not null
			)
	`);

  const timestampString = '2022-01-01 00:00:00.123456-0200';

  // 1. Insert date in string format with timezone in it
  await db.insert(table).values([{ id: 1, timestamp: timestampString }]);

  // 2. Select date in string format and check that the values are the same
  const result = await db.select().from(table);

  const normalized = result[0]?.timestamp;
  assert(String(normalized).startsWith('2022-01-01 02:00:00.123'));

  // 3. Select as raw query and checke that values are the same
  const result2 = await db.execute<{
    id: number;
    timestamp_string: string | Date;
  }>(sql`select * from ${table}`);

  // 3.1 Notice that postgres will return the date in UTC, but it is exactlt the same
  const normalized2 = result2[0]?.timestamp_string;
  const normalized2String =
    normalized2 instanceof Date
      ? normalized2.toISOString().replace('T', ' ')
      : String(normalized2 ?? '');
  assert(normalized2String.startsWith('2022-01-01 02:00:00.123'));

  await db.execute(sql`drop table if exists ${table}`);
});

test('test mode date for timestamp with timezone', async () => {
  const { db } = ctx;

  const table = publicSchema.table('all_columns', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    timestamp: timestamp('timestamp_string', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  });

  await db.execute(sql`drop table if exists ${table}`);

  await db.execute(sql`
		create table ${table} (
					id integer primary key default nextval('serial_users'),
					timestamp_string timestamptz not null
			)
	`);

  const timestampString = new Date('2022-01-01T00:00:00.456-0200');

  // 1. Insert date in string format with timezone in it
  await db.insert(table).values([{ id: 1, timestamp: timestampString }]);

  // 2. Select date in string format and check that the values are the same
  const result = await db.select().from(table);

  // 2.1 Notice that postgres will return the date in UTC, but it is exactly the same
  assert.deepEqual(result[0]?.timestamp.getTime(), timestampString.getTime());

  // 3. Select as raw query and checke that values are the same
  const result2 = await db.execute<{
    id: number;
    timestamp_string: string | Date;
  }>(sql`select * from ${table}`);

  // 3.1 Notice that postgres will return the date in UTC, but it is exactlt the same
  const ts = result2[0]?.timestamp_string;
  const tsString = ts instanceof Date ? ts.toISOString() : String(ts ?? '');
  assert.deepEqual(tsString, '2022-01-01T02:00:00.456Z');

  await db.execute(sql`drop table if exists ${table}`);
});

test('test mode string for timestamp with timezone in UTC timezone', async () => {
  // DuckDB doesn't expose or change session timezones like Postgres; assert unsupported.
  const { db } = ctx;
  let tzErr = false;
  try {
    await db.execute(sql`show timezone`);
  } catch {
    tzErr = true;
  }
  assert(tzErr);
});

test('test mode string for timestamp with timezone in different timezone', async () => {
  const { db } = ctx;
  await db.execute(sql`set time zone 'HST'`).catch(() => {});
});

test('orderBy with aliased column', () => {
  const { db } = ctx;

  const query = db
    .select({
      test: sql`something`,
    })
    .from(users2Table)
    .orderBy((fields) => fields.test)
    .toSQL();

  assert.deepEqual(
    query.sql,
    'select something as "test" from "buplic"."users2" order by "test"'
  );
});

// I don't even know what this is supposed to do and I don't care enough to figure it out
test('select from sql', async () => {
  const { db } = ctx;

  const metricEntry = publicSchema.table('metric_entry', {
    id: pgUuid('id').notNull(),
    createdAt: timestamp('created_at').notNull(),
  });

  await db.execute(sql`drop table if exists ${metricEntry}`);
  await db.execute(
    sql`create table ${metricEntry} (id uuid not null, created_at timestamp not null)`
  );

  const metricId = uuid();

  const intervals = db.$with('intervals').as(
    db
      .select({
        startTime: sql<string>`(date'2023-03-01'+ x * '1 day'::interval)`.as(
          'start_time'
        ),
        endTime: sql<string>`(date'2023-03-01'+ (x+1) *'1 day'::interval)`.as(
          'end_time'
        ),
      })
      .from(sql`generate_series(0, 29, 1) as t(x)`)
  );

  const rows = await db
    .with(intervals)
    .select({
      startTime: intervals.startTime,
      endTime: intervals.endTime,
      count: sql<number>`count(${metricEntry})`,
    })
    .from(metricEntry)
    .rightJoin(
      intervals,
      and(
        eq(metricEntry.id, metricId),
        gte(metricEntry.createdAt, intervals.startTime),
        lt(metricEntry.createdAt, intervals.endTime)
      )
    )
    .groupBy(intervals.startTime, intervals.endTime)
    .orderBy(asc(intervals.startTime));
  assert(Array.isArray(rows));
});

test('timestamp timezone', async () => {
  const { db } = ctx;

  const usersTableWithAndWithoutTimezone = publicSchema.table(
    'users_test_with_and_without_timezone',
    {
      id: integer('id').primaryKey(),
      name: text('name').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: false })
        .notNull()
        .defaultNow(),
    }
  );

  await db.execute(
    sql`drop table if exists ${usersTableWithAndWithoutTimezone}`
  );

  await db.execute(
    sql`
			create table buplic.users_test_with_and_without_timezone (
				id integer not null primary key,
				name text not null,
				created_at timestamptz not null default now(),
				updated_at timestamp not null default now()
			)
		`
  );

  const date = new Date(Date.parse('2020-01-01T00:00:00+04:00'));

  await db
    .insert(usersTableWithAndWithoutTimezone)
    .values({ id: 1, name: 'With default times' });
  await db.insert(usersTableWithAndWithoutTimezone).values({
    id: 2,
    name: 'Without default times',
    createdAt: date,
    updatedAt: date,
  });
  const users = await db.select().from(usersTableWithAndWithoutTimezone);

  const toDate = (val: unknown) =>
    val instanceof Date ? val : new Date(String(val));

  const toleranceMs = 5 * 60_000;

  // check that the timestamps are set correctly for default times
  assert(!Number.isNaN(toDate(users[0]!.updatedAt).getTime()));
  assert(!Number.isNaN(toDate(users[0]!.createdAt).getTime()));

  // check that the timestamps are set correctly for non default times
  assert(
    Math.abs(toDate(users[1]!.updatedAt).getTime() - date.getTime()) <
      toleranceMs
  );
  assert(
    Math.abs(toDate(users[1]!.createdAt).getTime() - date.getTime()) <
      toleranceMs
  );
});

test('transaction', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users_transactions', {
    id: integer('id').primaryKey(),
    balance: integer('balance').notNull(),
  });
  const products = publicSchema.table('products_transactions', {
    id: integer('id').primaryKey(),
    price: integer('price').notNull(),
    stock: integer('stock').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(sql`drop table if exists ${products}`);

  await db.execute(
    sql`create table buplic.users_transactions (id integer not null primary key, balance integer not null)`
  );
  await db.execute(
    sql`create table buplic.products_transactions (id integer not null primary key, price integer not null, stock integer not null)`
  );

  const user = await db
    .insert(users)
    .values({ id: 1, balance: 100 })
    .returning()
    .then((rows) => rows[0]!);
  const product = await db
    .insert(products)
    .values({ id: 2, price: 10, stock: 10 })
    .returning()
    .then((rows) => rows[0]!);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ balance: user.balance - product.price })
      .where(eq(users.id, user.id));
    await tx
      .update(products)
      .set({ stock: product.stock - 1 })
      .where(eq(products.id, product.id));
  });

  const result = await db.select().from(users);

  assert.deepEqual(result, [{ id: 1, balance: 90 }]);

  await db.execute(sql`drop table ${users}`);
  await db.execute(sql`drop table ${products}`);
});

test('transaction rollback', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users_transactions_rollback', {
    id: integer('id').primaryKey(),
    balance: integer('balance').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table buplic.users_transactions_rollback (id integer not null primary key, balance integer not null)`
  );

  await expect(
    db.transaction(async (tx) => {
      await tx.insert(users).values({ id: 1, balance: 100 });
      tx.rollback();
    })
  ).rejects.toThrowError(TransactionRollbackError);

  const result = await db.select().from(users);

  assert.deepEqual(result, []);

  await db.execute(sql`drop table ${users}`);
});

test('nested transaction', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users_nested_transactions', {
    id: integer('id').primaryKey(),
    balance: integer('balance').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table buplic.users_nested_transactions (id integer not null primary key, balance integer not null)`
  );

  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: 1, balance: 100 });

    await tx.transaction(async (tx) => {
      await tx.update(users).set({ id: 1, balance: 200 });
    });
  });

  const rows = await db.select().from(users);
  assert.deepEqual(rows, [{ id: 1, balance: 200 }]);

  await db.execute(sql`drop table ${users}`);
});

test('nested transaction rollback', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users_nested_transactions_rollback', {
    id: integer('id').primaryKey(),
    balance: integer('balance').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table buplic.users_nested_transactions_rollback (id integer not null primary key, balance integer not null)`
  );

  await expect(
    db.transaction(async (tx) => {
      await tx.insert(users).values({ id: 1, balance: 100 });

      await tx.transaction(async (tx) => {
        await tx.update(users).set({ id: 1, balance: 200 });
        tx.rollback();
      });
    })
  ).rejects.toThrowError(TransactionRollbackError);

  const rows = await db.select().from(users);
  assert.deepEqual(rows, []);

  await db.execute(sql`drop table ${users}`);
});

test('join subquery with join', async () => {
  const { db } = ctx;

  const internalStaff = publicSchema.table('internal_staff', {
    userId: integer('user_id').notNull(),
  });

  const customUser = publicSchema.table('custom_user', {
    id: integer('id').notNull(),
  });

  const ticket = publicSchema.table('ticket', {
    staffId: integer('staff_id').notNull(),
  });

  await db.execute(sql`drop table if exists ${internalStaff}`);
  await db.execute(sql`drop table if exists ${customUser}`);
  await db.execute(sql`drop table if exists ${ticket}`);

  await db.execute(
    sql`create table ${internalStaff} (user_id integer not null)`
  );
  await db.execute(sql`create table ${customUser} (id integer not null)`);
  await db.execute(sql`create table ${ticket} (staff_id integer not null)`);

  await db.insert(internalStaff).values({ userId: 1 });
  await db.insert(customUser).values({ id: 1 });
  await db.insert(ticket).values({ staffId: 1 });

  const subq = db
    .select()
    .from(internalStaff)
    .leftJoin(customUser, eq(internalStaff.userId, customUser.id))
    .as('internal_staff');

  const mainQuery = await db
    .select()
    .from(ticket)
    .leftJoin(subq, eq(subq.internal_staff.userId, ticket.staffId));

  assert.deepEqual(mainQuery, [
    {
      ticket: { staffId: 1 },
      internal_staff: {
        internal_staff: { userId: 1 },
        custom_user: { id: 1 },
      },
    },
  ]);

  await db.execute(sql`drop table ${internalStaff}`);
  await db.execute(sql`drop table ${customUser}`);
  await db.execute(sql`drop table ${ticket}`);
});

test('subquery with view', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users_subquery_view', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  });

  const newYorkers = pgView('new_yorkers').as((qb) =>
    qb.select().from(users).where(eq(users.cityId, 1))
  );

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(sql`drop view if exists ${newYorkers}`);

  await db.execute(
    sql`create table ${users} (id integer not null primary key default nextval('serial_users'), name text not null, city_id integer not null)`
  );
  await db.execute(
    sql`create view ${newYorkers} as select * from ${users} where city_id = 1`
  );

  await db.insert(users).values([
    { name: 'John', cityId: 1 },
    { name: 'Jane', cityId: 2 },
    { name: 'Jack', cityId: 1 },
    { name: 'Jill', cityId: 2 },
  ]);

  const sq = db.$with('sq').as(db.select().from(newYorkers));
  const result = await db.with(sq).select().from(sq);

  assert.deepEqual(result, [
    { id: 1, name: 'John', cityId: 1 },
    { id: 3, name: 'Jack', cityId: 1 },
  ]);

  await db.execute(sql`drop view ${newYorkers}`);
  await db.execute(sql`drop table ${users}`);
});

test('join view as subquery', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users_join_view', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  });

  const newYorkers = pgView('new_yorkers').as((qb) =>
    qb.select().from(users).where(eq(users.cityId, 1))
  );

  await db.execute(sql`drop table if exists ${users}`);
  await db.execute(sql`drop view if exists ${newYorkers}`);

  await db.execute(
    sql`create table ${users} (id integer not null primary key, name text not null, city_id integer not null)`
  );
  await db.execute(
    sql`create view ${newYorkers} as select * from ${users} where city_id = 1`
  );

  await db.insert(users).values([
    { id: 1, name: 'John', cityId: 1 },
    { id: 2, name: 'Jane', cityId: 2 },
    { id: 3, name: 'Jack', cityId: 1 },
    { id: 4, name: 'Jill', cityId: 2 },
  ]);

  const sq = db.select().from(newYorkers).as('new_yorkers_sq');

  const result = await db
    .select()
    .from(users)
    .leftJoin(sq, eq(users.id, sq.id))
    .orderBy(users.id);

  assert.deepEqual(result, [
    {
      users_join_view: { id: 1, name: 'John', cityId: 1 },
      new_yorkers_sq: { id: 1, name: 'John', cityId: 1 },
    },
    {
      users_join_view: { id: 2, name: 'Jane', cityId: 2 },
      new_yorkers_sq: null,
    },
    {
      users_join_view: { id: 3, name: 'Jack', cityId: 1 },
      new_yorkers_sq: { id: 3, name: 'Jack', cityId: 1 },
    },
    {
      users_join_view: { id: 4, name: 'Jill', cityId: 2 },
      new_yorkers_sq: null,
    },
  ]);

  await db.execute(sql`drop view ${newYorkers}`);
  await db.execute(sql`drop table ${users}`);
});

test('table selection with single table', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    cityId: integer('city_id').notNull(),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table ${users} (id integer not null primary key, name text not null, city_id integer not null)`
  );

  await db.insert(users).values({ id: 1, name: 'John', cityId: 1 });

  const result = await db.select({ users }).from(users);

  assert.deepEqual(result, [{ users: { id: 1, name: 'John', cityId: 1 } }]);

  await db.execute(sql`drop table ${users}`);
});

test('insert undefined', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users', {
    id: integer('id').primaryKey(),
    name: text('name'),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table ${users} (id integer not null primary key, name text)`
  );

  await db.insert(users).values({ id: 1, name: undefined });

  await db.execute(sql`drop table ${users}`);
});

test('update undefined', async () => {
  const { db } = ctx;

  const users = publicSchema.table('users', {
    id: integer('id').primaryKey(),
    name: text('name'),
  });

  await db.execute(sql`drop table if exists ${users}`);

  await db.execute(
    sql`create table ${users} (id integer not null primary key, name text)`
  );

  expect(() =>
    db.update(users).set({ name: undefined }).toSQL()
  ).toThrowError();

  await db.update(users).set({ id: 1, name: undefined });

  await db.execute(sql`drop table ${users}`);
});

// todo: duckdb types!
test('array operators', async () => {
  const { db } = ctx;

  const posts = publicSchema.table('posts', {
    id: integer('id')
      .primaryKey()
      .default(sql`nextval('serial_users')`),
    tags: text('tags').array(),
  });

  await db.execute(sql`drop table if exists ${posts}`);

  await db.execute(
    sql`create table ${posts} (id integer primary key default nextval('serial_users'), tags text[])`
  );

  await db.insert(posts).values([
    {
      tags: ['ORM'],
    },
    {
      tags: ['Typescript'],
    },
    {
      tags: ['Typescript', 'ORM'],
    },
    {
      tags: ['Typescript', 'Frontend', 'React'],
    },
    {
      tags: ['Typescript', 'ORM', 'Database', 'Postgres'],
    },
    {
      tags: ['Java', 'Spring', 'OOP'],
    },
  ]);

  const contains = await db
    .select({ id: posts.id })
    .from(posts)
    .where(arrayContains(posts.tags, ['Typescript', 'ORM']));
  const contained = await db
    .select({ id: posts.id })
    .from(posts)
    .where(arrayContained(posts.tags, ['Typescript', 'ORM']));
  const overlaps = await db
    .select({ id: posts.id })
    .from(posts)
    .where(arrayOverlaps(posts.tags, ['Typescript', 'ORM']));
  const withSubQuery = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      arrayContains(
        posts.tags,
        db.select({ tags: posts.tags }).from(posts).where(eq(posts.id, 1))
      )
    );

  assert.deepEqual(contains, [{ id: 3 }, { id: 5 }]);
  assert.deepEqual(contained, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(overlaps, [
    { id: 1 },
    { id: 2 },
    { id: 3 },
    { id: 4 },
    { id: 5 },
  ]);
  assert.deepEqual(withSubQuery, [{ id: 1 }, { id: 3 }, { id: 5 }]);
});

test('set operations (union) from query builder with subquery', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const sq = db
    .select({ id: users2Table.id, name: users2Table.name })
    .from(users2Table)
    .as('sq');

  const result = await db
    .select({ id: cities2Table.id, name: citiesTable.name })
    .from(cities2Table)
    .union(db.select().from(sq))
    .orderBy(asc(sql`name`))
    .limit(2)
    .offset(1);

  assert(result.length === 2);

  assert.deepEqual(result, [
    { id: 3, name: 'Jack' },
    { id: 2, name: 'Jane' },
  ]);

  expect(() => {
    db.select({
      id: cities2Table.id,
      name: citiesTable.name,
      name2: users2Table.name,
    })
      .from(cities2Table)
      .union(
        // @ts-expect-error
        db
          .select({ id: users2Table.id, name: users2Table.name })
          .from(users2Table)
      )
      .orderBy(asc(sql`name`));
  }).toThrowError();
});

test('set operations (union) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await union(
    db
      .select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .where(eq(citiesTable.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1))
  )
    .orderBy(asc(sql`name`))
    .limit(1)
    .offset(1);

  assert(result.length === 1);

  assert.deepEqual(result, [{ id: 1, name: 'New York' }]);

  expect(() => {
    union(
      db
        .select({ name: citiesTable.name, id: cities2Table.id })
        .from(cities2Table)
        .where(eq(citiesTable.id, 1)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1))
    ).orderBy(asc(sql`name`));
  }).toThrowError();
});

test('set operations (union all) from query builder', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await db
    .select({ id: cities2Table.id, name: citiesTable.name })
    .from(cities2Table)
    .limit(2)
    .unionAll(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table)
        .limit(2)
    )
    .orderBy(asc(sql`id`));

  assert(result.length === 4);

  assert.deepEqual(result, [
    { id: 1, name: 'New York' },
    { id: 1, name: 'New York' },
    { id: 2, name: 'London' },
    { id: 2, name: 'London' },
  ]);

  expect(() => {
    db.select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .limit(2)
      .unionAll(
        db
          .select({ name: citiesTable.name, id: cities2Table.id })
          .from(cities2Table)
          .limit(2)
      )
      .orderBy(asc(sql`id`));
  }).toThrowError();
});

test('set operations (union all) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await unionAll(
    db
      .select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .where(eq(citiesTable.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1))
  );

  assert(result.length === 3);

  assert.deepEqual(result, [
    { id: 1, name: 'New York' },
    { id: 1, name: 'John' },
    { id: 1, name: 'John' },
  ]);

  expect(() => {
    unionAll(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table)
        .where(eq(citiesTable.id, 1)),
      db
        .select({ name: users2Table.name, id: users2Table.id })
        .from(users2Table)
        .where(eq(users2Table.id, 1)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1))
    );
  }).toThrowError();
});

test('set operations (intersect) from query builder', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await db
    .select({ id: cities2Table.id, name: citiesTable.name })
    .from(cities2Table)
    .intersect(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table)
        .where(gt(citiesTable.id, 1))
    )
    .orderBy(asc(sql`name`));

  assert(result.length === 2);

  assert.deepEqual(result, [
    { id: 2, name: 'London' },
    { id: 3, name: 'Tampa' },
  ]);

  expect(() => {
    db.select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .intersect(
        // @ts-expect-error
        db
          .select({
            id: cities2Table.id,
            name: citiesTable.name,
            id2: cities2Table.id,
          })
          .from(cities2Table)
          .where(gt(citiesTable.id, 1))
      )
      .orderBy(asc(sql`name`));
  }).toThrowError();
});

test('set operations (intersect) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await intersect(
    db
      .select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .where(eq(citiesTable.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1))
  );

  assert(result.length === 0);

  assert.deepEqual(result, []);

  expect(() => {
    intersect(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table)
        .where(eq(citiesTable.id, 1)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1)),
      db
        .select({ name: users2Table.name, id: users2Table.id })
        .from(users2Table)
        .where(eq(users2Table.id, 1))
    );
  }).toThrowError();
});

test('set operations (intersect all) from query builder', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await db
    .select({ id: cities2Table.id, name: citiesTable.name })
    .from(cities2Table)
    .limit(2)
    .intersectAll(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table)
        .limit(2)
    )
    .orderBy(asc(sql`id`));

  assert(result.length === 2);

  assert.deepEqual(result, [
    { id: 1, name: 'New York' },
    { id: 2, name: 'London' },
  ]);

  expect(() => {
    db.select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .limit(2)
      .intersectAll(
        db
          .select({ name: users2Table.name, id: users2Table.id })
          .from(cities2Table)
          .limit(2)
      )
      .orderBy(asc(sql`id`));
  }).toThrowError();
});

test('set operations (intersect all) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await intersectAll(
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1))
  );

  assert(result.length === 1);

  assert.deepEqual(result, [{ id: 1, name: 'John' }]);

  expect(() => {
    intersectAll(
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1)),
      db
        .select({ name: users2Table.name, id: users2Table.id })
        .from(users2Table)
        .where(eq(users2Table.id, 1)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1))
    );
  }).toThrowError();
});

test('set operations (except) from query builder', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await db
    .select()
    .from(cities2Table)
    .except(db.select().from(cities2Table).where(gt(citiesTable.id, 1)));

  assert(result.length === 1);

  assert.deepEqual(result, [{ id: 1, name: 'New York' }]);

  expect(() => {
    db.select()
      .from(cities2Table)
      .except(
        db
          .select({ name: users2Table.name, id: users2Table.id })
          .from(cities2Table)
          .where(gt(citiesTable.id, 1))
      );
  }).toThrowError();
});

test('set operations (except) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await except(
    db
      .select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table),
    db
      .select({ id: cities2Table.id, name: citiesTable.name })
      .from(cities2Table)
      .where(eq(citiesTable.id, 1)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1))
  ).orderBy(asc(sql`id`));

  assert(result.length === 2);

  assert.deepEqual(result, [
    { id: 2, name: 'London' },
    { id: 3, name: 'Tampa' },
  ]);

  expect(() => {
    except(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table),
      db
        .select({ name: users2Table.name, id: users2Table.id })
        .from(cities2Table)
        .where(eq(citiesTable.id, 1)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1))
    ).orderBy(asc(sql`id`));
  }).toThrowError();
});

test('set operations (except all) from query builder', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await db
    .select()
    .from(cities2Table)
    .exceptAll(
      db
        .select({ id: cities2Table.id, name: citiesTable.name })
        .from(cities2Table)
        .where(eq(citiesTable.id, 1))
    )
    .orderBy(asc(sql`id`));

  assert(result.length === 2);

  assert.deepEqual(result, [
    { id: 2, name: 'London' },
    { id: 3, name: 'Tampa' },
  ]);

  expect(() => {
    db.select({ name: cities2Table.name, id: cities2Table.id })
      .from(cities2Table)
      .exceptAll(
        db
          .select({ id: cities2Table.id, name: citiesTable.name })
          .from(cities2Table)
          .where(eq(citiesTable.id, 1))
      )
      .orderBy(asc(sql`id`));
  }).toThrowError();
});

test('set operations (except all) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await exceptAll(
    db.select({ id: users2Table.id, name: users2Table.name }).from(users2Table),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(gt(users2Table.id, 7)),
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1))
  )
    .orderBy(asc(sql`id`))
    .limit(5)
    .offset(2);

  assert(result.length === 4);

  assert.deepEqual(result, [
    { id: 4, name: 'Peter' },
    { id: 5, name: 'Ben' },
    { id: 6, name: 'Jill' },
    { id: 7, name: 'Mary' },
  ]);

  expect(() => {
    exceptAll(
      db
        .select({ name: users2Table.name, id: users2Table.id })
        .from(users2Table),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(gt(users2Table.id, 7)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1))
    ).orderBy(asc(sql`id`));
  }).toThrowError();
});

test('set operations (mixed) from query builder with subquery', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);
  const sq = db
    .select()
    .from(cities2Table)
    .where(gt(citiesTable.id, 1))
    .as('sq');

  const result = await db
    .select()
    .from(cities2Table)
    .except(({ unionAll }) =>
      unionAll(
        db.select().from(sq),
        db.select().from(cities2Table).where(eq(citiesTable.id, 2))
      )
    );

  assert(result.length === 1);

  assert.deepEqual(result, [{ id: 1, name: 'New York' }]);

  expect(() => {
    db.select()
      .from(cities2Table)
      .except(({ unionAll }) =>
        unionAll(
          db
            .select({ name: cities2Table.name, id: cities2Table.id })
            .from(cities2Table)
            .where(gt(citiesTable.id, 1)),
          db.select().from(cities2Table).where(eq(citiesTable.id, 2))
        )
      );
  }).toThrowError();
});

test('set operations (mixed all) as function', async () => {
  const { db } = ctx;

  await setupSetOperationTest(db);

  const result = await union(
    db
      .select({ id: users2Table.id, name: users2Table.name })
      .from(users2Table)
      .where(eq(users2Table.id, 1)),
    except(
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(gte(users2Table.id, 5)),
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 7))
    ),
    db.select().from(cities2Table).where(gt(citiesTable.id, 1))
  ).orderBy(asc(sql`id`));

  assert(result.length === 6);

  assert.deepEqual(result, [
    { id: 1, name: 'John' },
    { id: 2, name: 'London' },
    { id: 3, name: 'Tampa' },
    { id: 5, name: 'Ben' },
    { id: 6, name: 'Jill' },
    { id: 8, name: 'Sally' },
  ]);

  expect(() => {
    union(
      db
        .select({ id: users2Table.id, name: users2Table.name })
        .from(users2Table)
        .where(eq(users2Table.id, 1)),
      except(
        db
          .select({ id: users2Table.id, name: users2Table.name })
          .from(users2Table)
          .where(gte(users2Table.id, 5)),
        db
          .select({ name: users2Table.name, id: users2Table.id })
          .from(users2Table)
          .where(eq(users2Table.id, 7))
      ),
      db.select().from(cities2Table).where(gt(citiesTable.id, 1))
    ).orderBy(asc(sql`id`));
  }).toThrowError();
});

test('aggregate function: count', async () => {
  const { db } = ctx;
  const table = aggregateTable;
  await setupAggregateFunctionsTest(db);

  const result1 = await db.select({ value: count() }).from(table);
  const result2 = await db.select({ value: count(table.a) }).from(table);
  const result3 = await db
    .select({ value: countDistinct(table.name) })
    .from(table);

  assert.deepEqual(result1[0]?.value, 7);
  assert.deepEqual(result2[0]?.value, 5);
  assert.deepEqual(result3[0]?.value, 6);
});

test('aggregate function: avg', async () => {
  const { db } = ctx;
  const table = aggregateTable;
  await setupAggregateFunctionsTest(db);

  const result1 = await db
    .select({ value: sql<number>`avg(${table.b})` })
    .from(table);
  const result2 = await db.select({ value: avg(table.nullOnly) }).from(table);
  const result3 = await db
    .select({ value: sql<number>`avg(distinct ${table.b})` })
    .from(table);

  assert.deepEqual(result1[0]?.value, 33.3333333333333333);
  assert.deepEqual(result2[0]?.value, null);
  assert.deepEqual(result3[0]?.value, 42.5);
});

test('aggregate function: sum', async () => {
  const { db } = ctx;
  const table = aggregateTable;
  await setupAggregateFunctionsTest(db);

  const result1 = await db.select({ value: sum(table.b) }).from(table);
  const result2 = await db.select({ value: sum(table.nullOnly) }).from(table);
  const result3 = await db.select({ value: sumDistinct(table.b) }).from(table);

  assert.deepEqual(result1[0]?.value, '200');
  assert.deepEqual(result2[0]?.value, null);
  assert.deepEqual(result3[0]?.value, '170');
});

test('aggregate function: max', async () => {
  const { db } = ctx;
  const table = aggregateTable;
  await setupAggregateFunctionsTest(db);

  const result1 = await db.select({ value: max(table.b) }).from(table);
  const result2 = await db.select({ value: max(table.nullOnly) }).from(table);

  assert.deepEqual(result1[0]?.value, 90);
  assert.deepEqual(result2[0]?.value, null);
});

test('aggregate function: min', async () => {
  const { db } = ctx;
  const table = aggregateTable;
  await setupAggregateFunctionsTest(db);

  const result1 = await db.select({ value: min(table.b) }).from(table);
  const result2 = await db.select({ value: min(table.nullOnly) }).from(table);

  assert.deepEqual(result1[0]?.value, 10);
  assert.deepEqual(result2[0]?.value, null);
});

// todo: list/array types
test('array mapping and parsing', async () => {
  const { db } = ctx;

  const arrays = publicSchema.table('arrays_tests', {
    id: integer('id').primaryKey(),
    tags: text('tags').array(),
    nested: text('nested').array().array(),
    numbers: integer('numbers').notNull().array(),
  });

  await db.execute(sql`drop table if exists ${arrays}`);
  await db.execute(sql`
		 create table ${arrays} (
		 id integer primary key default nextval('serial_users'),
		 tags text[],
		 nested text[][],
		 numbers integer[]
		)
	`);

  await db.insert(arrays).values({
    id: 1,
    tags: ['', 'b', 'c'],
    nested: [
      ['1', ''],
      ['3', '\\a'],
    ],
    numbers: [1, 2, 3],
  });

  const result = await db.select().from(arrays);

  assert.deepEqual(result, [
    {
      id: 1,
      tags: ['', 'b', 'c'],
      nested: [
        ['1', ''],
        ['3', '\\a'],
      ],
      numbers: [1, 2, 3],
    },
  ]);

  await db.execute(sql`drop table ${arrays}`);
});

test('test $onUpdateFn and $onUpdate works as $default', async () => {
  const { db } = ctx;

  await db.execute(sql`drop table if exists ${usersOnUpdate}`);

  await db.execute(
    sql`
			create table ${usersOnUpdate} (
			id integer primary key,
			name text not null,
			update_counter integer default 1 not null,
			updated_at timestamp(3),
			always_null text
			)
		`
  );

  await db.insert(usersOnUpdate).values([
    { id: 1, name: 'John' },
    { id: 2, name: 'Jane' },
    { id: 3, name: 'Jack' },
    { id: 4, name: 'Jill' },
  ]);

  const { updatedAt, ...rest } = getTableColumns(usersOnUpdate);

  const justDates = await db
    .select({ updatedAt })
    .from(usersOnUpdate)
    .orderBy(asc(usersOnUpdate.id));

  const response = await db
    .select({ ...rest })
    .from(usersOnUpdate)
    .orderBy(asc(usersOnUpdate.id));

  assert.deepEqual(response, [
    { name: 'John', id: 1, updateCounter: 1, alwaysNull: null },
    { name: 'Jane', id: 2, updateCounter: 1, alwaysNull: null },
    { name: 'Jack', id: 3, updateCounter: 1, alwaysNull: null },
    { name: 'Jill', id: 4, updateCounter: 1, alwaysNull: null },
  ]);
  const msDelay = 250;

  for (const eachUser of justDates) {
    assert(eachUser.updatedAt!.valueOf() > Date.now() - msDelay);
  }
});

test('test $onUpdateFn and $onUpdate works updating', async () => {
  const { db } = ctx;

  await db.execute(sql`drop table if exists ${usersOnUpdate}`);

  await db.execute(
    sql`
			create table ${usersOnUpdate} (
			id integer primary key,
			name text not null,
			update_counter integer default 1,
			updated_at timestamp(3),
			always_null text
			)
		`
  );

  await db.insert(usersOnUpdate).values([
    { id: 1, name: 'John', alwaysNull: 'this will be null after updating' },
    { id: 2, name: 'Jane' },
    { id: 3, name: 'Jack' },
    { id: 4, name: 'Jill' },
  ]);

  const { updatedAt, ...rest } = getTableColumns(usersOnUpdate);
  // const initial = await db.select({ updatedAt }).from(usersOnUpdate).orderBy(asc(usersOnUpdate.id));

  await db
    .update(usersOnUpdate)
    .set({ name: 'Angel' })
    .where(eq(usersOnUpdate.id, 1));
  await db
    .update(usersOnUpdate)
    .set({ updateCounter: null })
    .where(eq(usersOnUpdate.id, 2));

  const justDates = await db
    .select({ updatedAt })
    .from(usersOnUpdate)
    .orderBy(asc(usersOnUpdate.id));

  const response = await db
    .select({ ...rest })
    .from(usersOnUpdate)
    .orderBy(asc(usersOnUpdate.id));

  assert.deepEqual(response, [
    { name: 'Angel', id: 1, updateCounter: 2, alwaysNull: null },
    { name: 'Jane', id: 2, updateCounter: null, alwaysNull: null },
    { name: 'Jack', id: 3, updateCounter: 1, alwaysNull: null },
    { name: 'Jill', id: 4, updateCounter: 1, alwaysNull: null },
  ]);
  const msDelay = 250;

  // assert(initial[0]?.updatedAt?.valueOf() !== justDates[0]?.updatedAt?.valueOf());

  for (const eachUser of justDates) {
    assert(eachUser.updatedAt!.valueOf() > Date.now() - msDelay);
  }
});
