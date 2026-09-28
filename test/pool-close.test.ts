import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { createDuckDBConnectionPool, drizzle } from '../src';

test('pending acquires reject when pool closes', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const pool = createDuckDBConnectionPool(instance, { size: 1 });

  const conn1 = await pool.acquire();
  const pending = pool.acquire();

  await pool.close();
  await pool.release(conn1);

  await expect(pending).rejects.toThrow(/closed/);
  await expect(pool.acquire()).rejects.toThrow(/closed/);

  instance.closeSync?.();
});

// Long enough that it is still running when close() is called, unless the
// interrupt stops it.
const LONG_QUERY = sql`select count(*) as n from range(6000000000) t(x) where x % 7 = ${3}`;

/** Start a lazy Drizzle query now and report how it settled. */
function track(query: PromiseLike<unknown>): Promise<string> {
  return Promise.resolve(query).then(
    () => 'resolved',
    (error: Error) => `rejected: ${error.message}`
  );
}

function settleWithin(settled: Promise<string>, ms: number) {
  return Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

test('pool close interrupts in-flight queries so they settle', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const pool = createDuckDBConnectionPool(instance, { size: 1 });
  const db = drizzle(pool);

  const inFlight = track(db.execute(LONG_QUERY));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await db.close();

  expect(await settleWithin(inFlight, 5_000)).toMatch(
    /^rejected: .*interrupt/i
  );
  await expect(pool.acquire()).rejects.toThrow(/closed/);

  instance.closeSync();
});

test('closing a single-connection database interrupts its query', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const db = drizzle(await instance.connect());

  const inFlight = track(db.execute(LONG_QUERY));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await db.close();

  expect(await settleWithin(inFlight, 5_000)).toMatch(
    /^rejected: .*interrupt/i
  );

  instance.closeSync();
});

test('pool close fails an open stream instead of ending it early', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const pool = createDuckDBConnectionPool(instance, { size: 1 });
  const db = drizzle(pool);

  let rows = 0;
  let closing: Promise<void> | undefined;
  const consume = async () => {
    for await (const batch of db.executeBatches(
      sql`select x from range(100000) t(x)`,
      { rowsPerChunk: 2048 }
    )) {
      rows += batch.length;
      closing ??= db.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  await expect(consume()).rejects.toThrow(/closed/);
  expect(rows).toBeLessThan(100000);
  await closing;

  instance.closeSync();
});

test('pool close closes leased idle connections without waiting', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const pool = createDuckDBConnectionPool(instance, { size: 1 });
  const connection = await pool.acquire();

  const started = Date.now();
  await pool.close();
  expect(Date.now() - started).toBeLessThan(1_000);
  await pool.release(connection);

  instance.closeSync();
});
