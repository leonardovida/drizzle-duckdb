import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDuckDBConnectionPool } from '../src/pool.ts';

describe('pool option validation', () => {
  let instance: DuckDBInstance;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
  });

  afterAll(() => {
    instance.closeSync();
  });

  const isPendingAfter = async (promise: Promise<unknown>, ms: number) => {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    return !settled;
  };

  test.each([Infinity, 0, 2 ** 31, Number.MAX_SAFE_INTEGER])(
    'acquireTimeout %s waits for a released connection',
    async (acquireTimeout) => {
      const pool = createDuckDBConnectionPool(instance, {
        size: 1,
        acquireTimeout,
      });
      const connection = await pool.acquire();
      const waiting = pool.acquire();

      expect(await isPendingAfter(waiting, 50)).toBe(true);

      await pool.release(connection);
      const next = await waiting;
      expect(next).toBe(connection);
      await pool.release(next);
      await pool.close();
    }
  );

  test('a finite acquireTimeout still times out', async () => {
    const pool = createDuckDBConnectionPool(instance, {
      size: 1,
      acquireTimeout: 20,
    });
    const connection = await pool.acquire();

    await expect(pool.acquire()).rejects.toThrow(/acquire timeout after 20ms/);

    await pool.release(connection);
    await pool.close();
  });

  test.each([-1, NaN, -Infinity])(
    'acquireTimeout %s is rejected',
    (acquireTimeout) => {
      expect(() =>
        createDuckDBConnectionPool(instance, { acquireTimeout })
      ).toThrow(/acquireTimeout must be a non-negative number/);
    }
  );

  test.each([-1, NaN, 1.5])(
    'maxWaitingRequests %s is rejected',
    (maxWaitingRequests) => {
      expect(() =>
        createDuckDBConnectionPool(instance, { maxWaitingRequests })
      ).toThrow(/maxWaitingRequests must be a non-negative integer/);
    }
  );

  test('maxWaitingRequests accepts Infinity and 0', async () => {
    const unlimited = createDuckDBConnectionPool(instance, {
      size: 1,
      maxWaitingRequests: Infinity,
    });
    await unlimited.close();

    const noQueue = createDuckDBConnectionPool(instance, {
      size: 1,
      maxWaitingRequests: 0,
    });
    const connection = await noQueue.acquire();
    await expect(noQueue.acquire()).rejects.toThrow(/queue is full/);
    await noQueue.release(connection);
    await noQueue.close();
  });
});
