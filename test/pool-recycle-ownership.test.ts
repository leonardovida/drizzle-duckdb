import { DuckDBConnection, type DuckDBInstance } from '@duckdb/node-api';
import { afterEach, expect, test, vi } from 'vitest';
import { createDuckDBConnectionPool } from '../src/pool.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each(['idle acquire', 'expired release'] as const)(
  '%s keeps the closing slot until close settles, then serves waiters in order',
  async (trigger) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failure = { reason: 'close failed' };
    let rejectClose: (error: unknown) => void = () => undefined;
    const closing = new Promise<void>((_, reject) => {
      rejectClose = reject;
    });
    const original = { close: vi.fn(() => closing) };
    const replacement = { closeSync: vi.fn() };
    const create = vi
      .spyOn(DuckDBConnection, 'create')
      .mockResolvedValueOnce(original as unknown as DuckDBConnection)
      .mockResolvedValueOnce(replacement as unknown as DuckDBConnection);
    const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
      size: 1,
      acquireTimeout: 50,
      // The idle connection goes stale when the clock moves to 20 below.
      ...(trigger === 'idle acquire'
        ? { idleTimeoutMs: 10 }
        : { maxLifetimeMs: 10 }),
    });

    try {
      const connection = await pool.acquire();
      if (trigger === 'idle acquire') await pool.release(connection);
      vi.setSystemTime(20);
      const recycling = Promise.resolve(
        trigger === 'idle acquire' ? pool.acquire() : pool.release(connection)
      ).catch((error: unknown) => error);
      const first = pool.acquire();
      const second = pool.acquire();

      await vi.advanceTimersByTimeAsync(5);
      expect(original.close).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(pool.stats()).toMatchObject({
        total: 1,
        idle: 0,
        leased: 0,
        waiting: 2,
        pending: 0,
        recycled: 1,
      });

      rejectClose(failure);
      if (trigger === 'expired release') {
        // The pool owns the close failure, so release() still resolves.
        expect(await recycling).toBeUndefined();
      } else {
        // The acquire that found the stale connection keeps the freed slot,
        // and its close failure does not fail it.
        expect(await recycling).toBe(replacement);
        expect(pool.stats()).toMatchObject({
          total: 1,
          leased: 1,
          waiting: 2,
          created: 2,
          closeErrors: 1,
        });
        await pool.release(replacement as unknown as DuckDBConnection);
      }
      const next = await first;
      expect(next).toBe(replacement);
      expect(pool.stats()).toMatchObject({
        total: 1,
        leased: 1,
        waiting: 1,
        pending: 0,
        created: 2,
        recycled: 1,
        closeErrors: 1,
        queued: 2,
        timedOut: 0,
      });
      expect(vi.getTimerCount()).toBe(1);

      // The remaining waiter receives this lease, not another connection.
      await pool.release(next);
      const last = await second;
      expect(last).toBe(replacement);
      expect(create).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      await pool.release(last);
    } finally {
      rejectClose(failure);
      await pool.close();
    }
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(replacement.closeSync).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toMatchObject({ total: 0, closed: true });
  }
);

test.each(['idle acquire', 'expired release'] as const)(
  '%s does not replace a failed closing connection after pool shutdown',
  async (trigger) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failure = new Error('close failed');
    let rejectClose: (error: unknown) => void = () => undefined;
    const closing = new Promise<void>((_, reject) => {
      rejectClose = reject;
    });
    const original = { close: vi.fn(() => closing) };
    const create = vi
      .spyOn(DuckDBConnection, 'create')
      .mockResolvedValue(original as unknown as DuckDBConnection);
    const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
      size: 1,
      // The idle connection goes stale when the clock moves to 20 below.
      ...(trigger === 'idle acquire'
        ? { idleTimeoutMs: 10 }
        : { maxLifetimeMs: 10 }),
    });

    try {
      const connection = await pool.acquire();
      if (trigger === 'idle acquire') await pool.release(connection);
      vi.setSystemTime(20);
      const recycling = Promise.resolve(
        trigger === 'idle acquire' ? pool.acquire() : pool.release(connection)
      ).catch((error: unknown) => error);
      const waiter = pool.acquire().catch((error: unknown) => error);

      await pool.close();
      expect(await waiter).toEqual(
        new Error('DuckDB connection pool is closed')
      );
      expect(vi.getTimerCount()).toBe(0);
      rejectClose(failure);
      if (trigger === 'expired release') {
        expect(await recycling).toBeUndefined();
      } else {
        expect(await recycling).toEqual(
          new Error('DuckDB connection pool is closed')
        );
      }
      expect(create).toHaveBeenCalledTimes(1);
      expect(original.close).toHaveBeenCalledTimes(1);
      expect(pool.stats()).toMatchObject({
        total: 0,
        idle: 0,
        leased: 0,
        waiting: 0,
        pending: 0,
        created: 1,
        recycled: 1,
        closeErrors: 1,
        closed: true,
      });
    } finally {
      rejectClose(failure);
      await pool.close();
    }
  }
);
