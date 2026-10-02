import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { getPreparedStatementCache } from '../src/prepared-statement-cache.ts';

test('a queued cached query cannot truncate a stream opened while it waits', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection, { prepareCache: true });
  const cache = getPreparedStatementCache(connection, 32);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = cache.runExclusive(() => gate);
  const pending = db.execute(sql`select ${42}::integer as answer`).then(
    (rows) => ({ rows, error: undefined }),
    (error: unknown) => ({ rows: undefined, error })
  );
  const stream = db.executeBatches(sql`select x from range(10000) t(x)`, {
    rowsPerChunk: 1000,
  });
  try {
    const first = await stream.next();
    expect(first.value?.length).toBe(1000);
    release();
    await held;
    const result = await pending;
    const rows = [...(first.value ?? [])];
    for await (const batch of stream) rows.push(...batch);
    expect(rows).toHaveLength(10000);
    expect(rows.map((row) => row.x)).toEqual(
      Array.from({ length: 10000 }, (_, index) => BigInt(index))
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toMatch(/streaming a result/);
    expect(await db.execute(sql`select ${7}::integer as answer`)).toEqual([
      { answer: 7 },
    ]);
  } finally {
    release();
    await held;
    await pending;
    await stream.return(undefined);
    await db.close();
    instance.closeSync();
  }
});

test.each([
  sql`select ${42}::integer as answer`,
  sql.raw(
    'create temp table if not exists fallback_items(id int); select 42::integer as answer'
  ),
])(
  'preparation cannot let a cached query interrupt an open stream (%#)',
  async (query) => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const db = drizzle(connection, { prepareCache: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let prepared!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const originalPrepare = connection.prepare.bind(connection);
    const prepare = vi
      .spyOn(connection, 'prepare')
      .mockImplementation(async (...args) => {
        try {
          return await originalPrepare(...args);
        } finally {
          // Let the stream open after native preparation but before its promise
          // settles, including the multi-statement fallback's rejection path.
          prepared();
          await gate;
        }
      });
    const pending = db.execute(query).then(
      (rows) => ({ rows, error: undefined }),
      (error: unknown) => ({ rows: undefined, error })
    );
    const stream = db.executeBatches<{ x: bigint }>(
      sql`select x from range(10000) t(x)`,
      { rowsPerChunk: 1000 }
    );
    try {
      await ready;
      const first = await stream.next();
      release();
      const result = await pending;
      const rows = [...(first.value ?? [])];
      for await (const batch of stream) rows.push(...batch);
      expect(rows.map((row) => row.x)).toEqual(
        Array.from({ length: 10000 }, (_, index) => BigInt(index))
      );
      expect(String(result.error)).toMatch(/streaming a result/);
      prepare.mockRestore();
      // Rejected operations leave both cached and fallback paths reusable.
      expect(await db.execute(query)).toEqual([{ answer: 42 }]);
    } finally {
      release();
      await pending;
      prepare.mockRestore();
      await stream.return(undefined);
      await db.close();
      instance.closeSync();
    }
  }
);

test('close rejects cached work queued before the connection starts closing', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection, { prepareCache: true });
  const cache = getPreparedStatementCache(connection, 32);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = cache.runExclusive(() => gate);
  const prepare = vi.spyOn(connection, 'prepare');
  const pending = db.execute(sql`select 42`).catch((error: unknown) => error);
  try {
    const closing = db.close();
    release();
    await held;
    expect(String(await pending)).toMatch(/connection is closed/);
    await closing;
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    release();
    await held;
    await pending;
    prepare.mockRestore();
    await db.close();
    instance.closeSync();
  }
});
