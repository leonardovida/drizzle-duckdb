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

  test('setup failure does not reduce capacity', async () => {
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

    await expect(pool.acquire()).rejects.toThrow(/setup failed/);
    expect(conn1.closeSync).toHaveBeenCalled();

    const conn = await pool.acquire();
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
});
