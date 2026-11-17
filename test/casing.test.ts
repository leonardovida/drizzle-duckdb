import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import {
  integer,
  pgTable,
  pgTableCreator,
  snakeCase,
  text,
} from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';

// drizzle-orm 1.0 sets the casing on the table definitions, not on drizzle().
const snakeCaseTable = pgTableCreator((name) => name, 'snake_case');

const accounts = snakeCaseTable('casing_accounts', {
  id: integer().primaryKey(),
  userName: text(),
});

test('snake_case tables generate snake_case SQL', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);
  try {
    await db.execute(
      sql`create table casing_accounts (id integer primary key, user_name text)`
    );
    await db.insert(accounts).values({ id: 1, userName: 'ada' });

    expect(
      db.select().from(accounts).where(eq(accounts.userName, 'ada')).toSQL().sql
    ).toContain('"user_name"');
    expect(
      await db.select().from(accounts).where(eq(accounts.userName, 'ada'))
    ).toEqual([{ id: 1, userName: 'ada' }]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

test('snakeCase.table() maps keys to snake_case columns', async () => {
  const people = snakeCase.table('casing_people', {
    id: integer().primaryKey(),
    firstName: text(),
  });
  const db = await drizzle(':memory:');
  try {
    await db.execute(
      sql`create table casing_people (id integer primary key, first_name text)`
    );
    await db.insert(people).values({ id: 1, firstName: 'ada' });
    expect(await db.select().from(people)).toEqual([
      { id: 1, firstName: 'ada' },
    ]);
  } finally {
    await db.close();
  }
});

test('path-based drizzle() reads snake_case tables', async () => {
  const db = await drizzle(':memory:');
  try {
    await db.execute(
      sql`create table casing_accounts (id integer primary key, user_name text)`
    );
    await db.insert(accounts).values({ id: 2, userName: 'grace' });
    expect(
      await db.select({ userName: accounts.userName }).from(accounts)
    ).toEqual([{ userName: 'grace' }]);
  } finally {
    await db.close();
  }
});

test('drizzle() rejects the removed casing and schema options', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const removed = { casing: 'snake_case' } as never;
    expect(() => drizzle(connection, removed)).toThrow(
      /casing option was removed in 3\.0.*pgTableCreator/
    );
    await expect(drizzle(':memory:', removed)).rejects.toThrow(
      /casing option was removed in 3\.0/
    );
    const schema = {
      schema: { users: pgTable('casing_users', { id: integer() }) },
    } as never;
    expect(() => drizzle(connection, schema)).toThrow(
      /schema option was removed in 3\.0.*defineRelations/
    );
    expect(() =>
      drizzle({ client: connection, ...(schema as object) })
    ).toThrow(/schema option was removed in 3\.0/);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
