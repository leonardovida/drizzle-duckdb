import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { createDuckDBConnectionPool } from '../src/pool.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mockConnection = () =>
  ({ closeSync: vi.fn() }) as unknown as DuckDBConnection & {
    closeSync: ReturnType<typeof vi.fn>;
  };

test('a close failure while recycling on release does not replace query or transaction results', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const pool = createDuckDBConnectionPool(instance, {
    size: 1,
    maxLifetimeMs: 0,
    setup: async (connection) => {
      const close = connection.closeSync.bind(connection);
      connection.closeSync = () => {
        close();
        throw new Error('close failed');
      };
    },
  });
  const db = drizzle(pool);

  try {
    await db.execute(sql`create table pool_release_results(x integer)`);
    const committed = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into pool_release_results values (1)`);
      return 'committed';
    });
    expect(committed).toBe('committed');

    const rows = await db.execute(
      sql`select count(*)::integer as c from pool_release_results`
    );
    expect(rows).toEqual([{ c: 1 }]);
    expect(pool.stats().closeErrors).toBeGreaterThanOrEqual(3);
  } finally {
    await pool.close();
    instance.closeSync();
  }
});

test('acquire discards every expired idle connection, not only the newest', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const connections = [mockConnection(), mockConnection(), mockConnection()];
  const fresh = mockConnection();
  const create = vi.spyOn(DuckDBConnection, 'create');
  for (const connection of [...connections, fresh]) {
    create.mockResolvedValueOnce(connection);
  }
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
    size: 3,
    idleTimeoutMs: 50,
  });

  try {
    const leased = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);
    for (const connection of leased) await pool.release(connection);

    vi.setSystemTime(100);
    const next = await pool.acquire();
    expect(next).toBe(fresh);
    for (const connection of connections) {
      expect(connection.closeSync).toHaveBeenCalledTimes(1);
    }
    expect(pool.stats()).toMatchObject({
      total: 1,
      idle: 0,
      leased: 1,
      recycled: 3,
    });
    await pool.release(next);
  } finally {
    await pool.close();
  }
});

test('release discards other stale idle connections', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const stale = mockConnection();
  const active = mockConnection();
  vi.spyOn(DuckDBConnection, 'create')
    .mockResolvedValueOnce(stale)
    .mockResolvedValueOnce(active);
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
    size: 2,
    idleTimeoutMs: 50,
  });

  try {
    const first = await pool.acquire();
    const second = await pool.acquire();
    expect(first).toBe(stale);
    await pool.release(first);

    vi.setSystemTime(100);
    await pool.release(second);
    expect(stale.closeSync).toHaveBeenCalledTimes(1);
    expect(active.closeSync).not.toHaveBeenCalled();
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, recycled: 1 });
  } finally {
    await pool.close();
  }
});

test('maxLifetimeMs also expires idle connections below the newest', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const old = mockConnection();
  const young = mockConnection();
  vi.spyOn(DuckDBConnection, 'create')
    .mockResolvedValueOnce(old)
    .mockResolvedValueOnce(young);
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, {
    size: 2,
    maxLifetimeMs: 100,
  });

  try {
    const first = await pool.acquire();
    vi.setSystemTime(60);
    const second = await pool.acquire();
    await pool.release(first);
    await pool.release(second);

    vi.setSystemTime(120);
    // The newest idle connection is still young, but the older one is not.
    const next = await pool.acquire();
    expect(next).toBe(young);
    expect(old.closeSync).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toMatchObject({ total: 1, idle: 0, recycled: 1 });
    await pool.release(next);
  } finally {
    await pool.close();
  }
});

test('discard closes a leased connection and gives its slot to a waiter', async () => {
  const broken = mockConnection();
  const replacement = mockConnection();
  vi.spyOn(DuckDBConnection, 'create')
    .mockResolvedValueOnce(broken)
    .mockResolvedValueOnce(replacement);
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, { size: 1 });

  try {
    const connection = await pool.acquire();
    const waiter = pool.acquire();

    await pool.discard(connection);
    expect(broken.closeSync).toHaveBeenCalledTimes(1);
    expect(await waiter).toBe(replacement);
    expect(pool.stats()).toMatchObject({
      total: 1,
      leased: 1,
      idle: 0,
      discarded: 1,
    });

    // Discarding or releasing a connection the pool no longer leases is a no-op.
    await pool.discard(connection);
    await pool.release(connection);
    expect(broken.closeSync).toHaveBeenCalledTimes(1);
    expect(pool.stats().discarded).toBe(1);
    await pool.release(replacement);
  } finally {
    await pool.close();
  }
});

test('discard counts a close failure instead of rejecting', async () => {
  const broken = {
    closeSync: vi.fn(() => {
      throw new Error('close failed');
    }),
  } as unknown as DuckDBConnection;
  vi.spyOn(DuckDBConnection, 'create').mockResolvedValueOnce(broken);
  const pool = createDuckDBConnectionPool({} as DuckDBInstance, { size: 1 });

  try {
    const connection = await pool.acquire();
    await expect(pool.discard(connection)).resolves.toBeUndefined();
    expect(pool.stats()).toMatchObject({
      total: 0,
      leased: 0,
      discarded: 1,
      closeErrors: 1,
    });
  } finally {
    await pool.close();
  }
});
