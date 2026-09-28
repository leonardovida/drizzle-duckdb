import { sql } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import type { PgDuckClient, PgDuckQueryConfig } from '../src/pgduck.ts';

const people = pgTable('tx_failure_people', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

let db: DuckDBDatabase;

beforeAll(async () => {
  db = await drizzle(':memory:', { pool: { size: 2 } });
  await db.execute(sql`
    create table tx_failure_people (id integer primary key, name text not null)
  `);
});

beforeEach(async () => {
  await db.execute(sql`delete from tx_failure_people`);
});

afterAll(async () => {
  await db?.close();
});

const countPeople = async () => {
  const [row] = await db.execute<{ total: number }>(
    sql`select count(*)::int as total from tx_failure_people`
  );
  return row?.total;
};

test('rejects when a caught statement failure aborted the transaction', async () => {
  const transaction = db.transaction(async (tx) => {
    await tx.insert(people).values({ id: 1, name: 'Alice' });
    await tx
      .insert(people)
      .values({ id: 1, name: 'Duplicate' })
      .catch(() => undefined);
    return 'done';
  });

  await expect(transaction).rejects.toThrow(
    /DuckDB aborted the transaction because a statement inside it failed/
  );
  await expect(transaction).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringMatching(/constraint/i),
    }),
  });
  expect(await countPeople()).toBe(0);
});

test('commits when a caught failure left the transaction usable', async () => {
  // DuckDB keeps the transaction open after catalog and parser errors.
  await db.transaction(async (tx) => {
    await tx.insert(people).values({ id: 1, name: 'Alice' });
    await tx
      .execute(sql`select * from tx_failure_missing_table`)
      .catch(() => undefined);
  });

  expect(await countPeople()).toBe(1);
});

test('surfaces commit failures instead of the follow-up rollback error', async () => {
  let releaseFirst!: () => void;
  const firstMayCommit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondStarted!: () => void;
  const secondMayInsert = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });

  const first = db.transaction(async (tx) => {
    await tx.insert(people).values({ id: 5, name: 'first' });
    secondStarted();
    await firstMayCommit;
  });
  const second = db.transaction(async (tx) => {
    await secondMayInsert;
    await tx.insert(people).values({ id: 5, name: 'second' });
  });

  await expect(second).resolves.toBeUndefined();
  releaseFirst();

  const error = await first.then(
    () => undefined,
    (reason: unknown) => reason as Error
  );
  expect(error?.message).toMatch(/commit/i);
  expect(error?.message).not.toMatch(/no transaction is active/i);
  expect(await countPeople()).toBe(1);
});

function createSavepointClient(options: { failRollbackToSavepoint?: boolean }) {
  const statements: string[] = [];
  const client: PgDuckClient = {
    async query(query: string | PgDuckQueryConfig) {
      const text = typeof query === 'string' ? query : query.text;
      statements.push(text);
      if (
        options.failRollbackToSavepoint &&
        text.startsWith('rollback to savepoint')
      ) {
        throw new Error('rollback to savepoint failed');
      }
      return { rows: [], fields: [] };
    },
  };
  return { client, statements };
}

test('a nested failure rolled back to its savepoint keeps the outer transaction', async () => {
  const { client, statements } = createSavepointClient({});
  const savepointDb = drizzle(client);

  await expect(
    savepointDb.transaction(async (tx) => {
      await tx.execute(sql`select 'outer'`);
      await expect(
        tx.transaction(async () => {
          throw new Error('inner');
        })
      ).rejects.toThrow('inner');
      return 'outer result';
    })
  ).resolves.toBe('outer result');

  expect(statements).toEqual([
    'BEGIN TRANSACTION;',
    "select 'outer'",
    'savepoint drizzle_savepoint_1',
    'rollback to savepoint drizzle_savepoint_1',
    'commit',
  ]);
});

test('a failed rollback to savepoint rolls back the outer transaction', async () => {
  const { client, statements } = createSavepointClient({
    failRollbackToSavepoint: true,
  });
  const savepointDb = drizzle(client);

  await expect(
    savepointDb.transaction(async (tx) => {
      await tx
        .transaction(async () => {
          throw new Error('inner');
        })
        .catch(() => undefined);
    })
  ).rejects.toThrow(TransactionRollbackError);

  expect(statements.at(-1)).toBe('rollback');
});
