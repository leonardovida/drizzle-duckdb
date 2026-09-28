import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';

const accounts = pgTable('casing_accounts', {
  id: integer().primaryKey(),
  userName: text(),
});

test('drizzle() applies the casing option to generated SQL', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection, { casing: 'snake_case' });
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

test('path-based drizzle() applies the casing option', async () => {
  const db = await drizzle(':memory:', { casing: 'snake_case' });
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
