import { DuckDBConnection } from '@duckdb/node-api';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDuckDBConnectionPool } from '../src/pool.ts';

describe('Pool recycling and resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('failed connection creation does not reduce capacity', async () => {
    const fakeConn = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    const createSpy = vi
      .spyOn(DuckDBConnection, 'create')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(fakeConn);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
      acquireTimeout: 50,
    });

    await expect(pool.acquire()).rejects.toThrow(/boom/);

    const conn = await pool.acquire();
    expect(conn).toBe(fakeConn);

    await pool.release(conn);
    await pool.close();

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  test('failed connection creation retries the next queued acquire', async () => {
    const fakeConn = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    let rejectFirstCreate: (error: Error) => void = () => undefined;
    const firstCreate = new Promise<DuckDBConnection>((_, reject) => {
      rejectFirstCreate = reject;
    });
    const createSpy = vi
      .spyOn(DuckDBConnection, 'create')
      .mockReturnValueOnce(firstCreate)
      .mockResolvedValueOnce(fakeConn);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
      acquireTimeout: 50,
    });

    const failedAcquire = pool.acquire();
    const queuedAcquire = pool.acquire();
    rejectFirstCreate(new Error('boom'));

    await expect(failedAcquire).rejects.toThrow(/boom/);
    await expect(queuedAcquire).resolves.toBe(fakeConn);

    await pool.release(fakeConn);
    await pool.close();

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  test('setup failure retries the next queued acquire', async () => {
    const conn1 = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    const conn2 = { closeSync: vi.fn() } as unknown as DuckDBConnection;

    const createSpy = vi
      .spyOn(DuckDBConnection, 'create')
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);

    const setup = vi.fn(async () => undefined);
    setup.mockRejectedValueOnce(new Error('setup failed'));
    setup.mockResolvedValueOnce(undefined);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
      setup,
    });

    const failedAcquire = pool.acquire();
    const queuedAcquire = pool.acquire();

    await expect(failedAcquire).rejects.toThrow(/setup failed/);
    expect(conn1.closeSync).toHaveBeenCalled();

    const conn = await queuedAcquire;
    expect(conn).toBe(conn2);

    await pool.release(conn);
    await pool.close();

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledTimes(2);
  });

  test('maxLifetimeMs recycles connections instead of reusing them', async () => {
    const conn1 = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    const conn2 = { closeSync: vi.fn() } as unknown as DuckDBConnection;

    const createSpy = vi
      .spyOn(DuckDBConnection, 'create')
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
      maxLifetimeMs: 0,
    });

    const first = await pool.acquire();
    expect(first).toBe(conn1);
    await pool.release(first);

    const second = await pool.acquire();
    expect(second).toBe(conn2);
    expect(conn1.closeSync).toHaveBeenCalled();

    await pool.release(second);
    await pool.close();

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  test('expired connections are replaced before resolving waiters', async () => {
    const conn1 = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    const conn2 = { closeSync: vi.fn() } as unknown as DuckDBConnection;

    const createSpy = vi
      .spyOn(DuckDBConnection, 'create')
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
      maxLifetimeMs: 0,
    });

    const first = await pool.acquire();
    expect(first).toBe(conn1);

    const pendingAcquire = pool.acquire();
    await pool.release(first);

    const second = await pendingAcquire;
    expect(second).toBe(conn2);
    expect(conn1.closeSync).toHaveBeenCalled();

    await pool.release(second);
    await pool.close();

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  test('idleTimeoutMs discards stale idle connections', async () => {
    const conn1 = { closeSync: vi.fn() } as unknown as DuckDBConnection;
    const conn2 = { closeSync: vi.fn() } as unknown as DuckDBConnection;

    const createSpy = vi
      .spyOn(DuckDBConnection, 'create')
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
      idleTimeoutMs: 1,
    });

    const first = await pool.acquire();
    await pool.release(first);

    await new Promise((r) => setTimeout(r, 5));

    const second = await pool.acquire();
    expect(second).toBe(conn2);
    expect(conn1.closeSync).toHaveBeenCalled();

    await pool.release(second);
    await pool.close();

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  test('close() shuts down leased connections and ignores late release', async () => {
    const conn = { closeSync: vi.fn() } as unknown as DuckDBConnection;

    vi.spyOn(DuckDBConnection, 'create').mockResolvedValue(conn);

    const pool = createDuckDBConnectionPool({} as any, {
      size: 1,
    });

    const leased = await pool.acquire();
    expect(leased).toBe(conn);

    await pool.close();
    expect(conn.closeSync).toHaveBeenCalledTimes(1);

    await pool.release(leased);
    expect(conn.closeSync).toHaveBeenCalledTimes(1);
  });
});
