import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src';

const transactions = pgTable('tx_savepoints', {
  id: integer('id').primaryKey(),
  note: text('note'),
});

let db: DuckDBDatabase;
let connection: DuckDBConnection;
let instance: DuckDBInstance;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);

  await db.execute(sql`drop table if exists ${transactions}`);
  await db.execute(sql`
    create table ${transactions} (
      id integer primary key,
      note text
    )
  `);
});

beforeEach(async () => {
  await db.execute(sql`delete from ${transactions}`);
});

afterAll(() => {
  connection?.closeSync();
  instance?.closeSync?.();
});

test('nested transaction error marks outer transaction for rollback', async () => {
  await expect(
    db.transaction(async (tx) => {
      await tx.insert(transactions).values({ id: 1, note: 'outer-start' });

      await expect(
        tx.transaction(async (nested) => {
          await nested.insert(transactions).values({ id: 2, note: 'inner' });
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
    })
  ).rejects.toThrow(TransactionRollbackError);

  const rows = await db.select().from(transactions).orderBy(transactions.id);

  expect(rows).toEqual([]);
});

test('nested transaction success still commits work', async () => {
  await db.transaction(async (tx) => {
    await tx.insert(transactions).values({ id: 1, note: 'outer' });
    await tx.transaction(async (nested) => {
      await nested.insert(transactions).values({ id: 2, note: 'inner' });
    });
  });

  const rows = await db.select().from(transactions).orderBy(transactions.id);

  expect(rows).toEqual([
    { id: 1, note: 'outer' },
    { id: 2, note: 'inner' },
  ]);
});
