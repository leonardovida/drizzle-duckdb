import { DuckDBConnection, type DuckDBInstance } from '@duckdb/node-api';
import { afterEach, expect, test, vi } from 'vitest';
import { createDuckDBConnectionPool } from '../src/pool.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each(['failed acquire', 'expired release'] as const)(
  '%s gives replacement errors to the first waiter and serves the next',
  async (trigger) => {
    const original = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    const replacement = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    let rejectInitial: (error: Error) => void = () => undefined;
    const initial = new Promise<DuckDBConnection>((_, reject) => {
      rejectInitial = reject;
    });
    const create = vi
      .spyOn(DuckDBConnection, 'create')
      .mockImplementationOnce(() =>
        trigger === 'failed acquire' ? initial : Promise.resolve(original)
      )
      .mockRejectedValueOnce('replacement failed')
      .mockResolvedValueOnce(replacement);
    const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
      size: 1,
      maxLifetimeMs: 0,
    });

    try {
      const first = pool.acquire();
      const initialOutcome =
        trigger === 'failed acquire'
          ? expect(first).rejects.toThrow('initial failed')
          : await first;
      const failedWaiter = pool.acquire().catch((error: unknown) => error);
      const nextWaiter = pool.acquire();

      if (trigger === 'failed acquire') {
        rejectInitial(new Error('initial failed'));
        await initialOutcome;
      } else {
        // A replacement failure belongs to its queued acquire, not release().
        await expect(pool.release(original)).resolves.toBeUndefined();
      }

      const error = await failedWaiter;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('replacement failed');
      expect(await nextWaiter).toBe(replacement);
      expect(create).toHaveBeenCalledTimes(3);
      await pool.release(replacement);
    } finally {
      await pool.close?.();
    }
  }
);

test('recycling cancels only the first waiter timer and release awaits setup', async () => {
  vi.useFakeTimers();
  const original = { closeSync: vi.fn() } as unknown as DuckDBConnection;
  const replacement = { closeSync: vi.fn() } as unknown as DuckDBConnection;
  vi.spyOn(DuckDBConnection, 'create')
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(replacement);
  let finishSetup: () => void = () => undefined;
  const setupGate = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  let startSetup: () => void = () => undefined;
  const setupStarted = new Promise<void>((resolve) => {
    startSetup = resolve;
  });
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
    size: 1,
    maxLifetimeMs: 0,
    acquireTimeout: 10,
    setup: async (connection) => {
      if (connection === replacement) {
        startSetup();
        await setupGate;
      }
    },
  });

  try {
    await pool.acquire();
    let firstSettled = false;
    const firstWaiter = pool.acquire().finally(() => {
      firstSettled = true;
    });
    const secondWaiter = pool.acquire().catch((error: unknown) => error);
    let releaseSettled = false;
    const releasing = Promise.resolve(pool.release(original)).finally(() => {
      releaseSettled = true;
    });

    await setupStarted;
    await vi.advanceTimersByTimeAsync(11);
    expect(firstSettled).toBe(false);
    expect(releaseSettled).toBe(false);
    expect(((await secondWaiter) as Error).message).toBe(
      'DuckDB connection pool acquire timeout after 10ms'
    );
    finishSetup();
    expect(await firstWaiter).toBe(replacement);
    await releasing;
    expect(releaseSettled).toBe(true);
    await pool.release(replacement);
  } finally {
    finishSetup();
    await pool.close?.();
  }
});

test('closing during replacement setup rejects the waiter and closes it once', async () => {
  const original = { closeSync: vi.fn() } as unknown as DuckDBConnection;
  const replacement = { closeSync: vi.fn() } as unknown as DuckDBConnection;
  vi.spyOn(DuckDBConnection, 'create')
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(replacement);
  let finishSetup: () => void = () => undefined;
  const setupGate = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  let startSetup: () => void = () => undefined;
  const setupStarted = new Promise<void>((resolve) => {
    startSetup = resolve;
  });
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
    size: 1,
    maxLifetimeMs: 0,
    setup: async (connection) => {
      if (connection === replacement) {
        startSetup();
        await setupGate;
      }
    },
  });

  try {
    await pool.acquire();
    const waiter = pool.acquire().catch((error: unknown) => error);
    const releasing = pool.release(original);
    await setupStarted;
    const closing = pool.close?.();
    finishSetup();
    const error = await waiter;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('DuckDB connection pool is closed');
    await releasing;
    await closing;
    expect(original.closeSync).toHaveBeenCalledTimes(1);
    expect(replacement.closeSync).toHaveBeenCalledTimes(1);
    await expect(pool.acquire()).rejects.toThrow('pool is closed');
  } finally {
    finishSetup();
    await pool.close?.();
  }
});
