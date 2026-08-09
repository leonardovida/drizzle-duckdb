import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { describe, expect, test, afterEach, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { POOL_PRESETS, resolvePoolSize } from '../src/pool.ts';
import { DuckDBDatabase } from '../src/driver.ts';
import { DuckDBDialect } from '../src/dialect.ts';
import { DuckDBSession } from '../src/session.ts';
import type { PgDuckClient } from '../src/pgduck.ts';

describe('Driver Factory Tests', () => {
  let db: DuckDBDatabase | null = null;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    vi.restoreAllMocks();
  });

  describe('Pool Presets', () => {
    test('memory preset has size 4', () => {
      expect(POOL_PRESETS.memory).toBe(4);
    });

    test('local preset has size 8', () => {
      expect(POOL_PRESETS.local).toBe(8);
    });

    test('pulse preset has size 4', () => {
      expect(POOL_PRESETS.pulse).toBe(4);
    });

    test('standard preset has size 6', () => {
      expect(POOL_PRESETS.standard).toBe(6);
    });

    test('jumbo preset has size 8', () => {
      expect(POOL_PRESETS.jumbo).toBe(8);
    });

    test('mega preset has size 12', () => {
      expect(POOL_PRESETS.mega).toBe(12);
    });

    test('giga preset has size 16', () => {
      expect(POOL_PRESETS.giga).toBe(16);
    });

    test('floors fractional explicit pool sizes', () => {
      expect(resolvePoolSize({ size: 2.9 })).toBe(2);
    });

    test('falls back when explicit pool sizes are not finite', () => {
      expect(resolvePoolSize({ size: Number.POSITIVE_INFINITY })).toBe(4);
      expect(resolvePoolSize({ size: Number.NaN })).toBe(4);
    });
  });

  describe('drizzle() with connection', () => {
    test('creates database from DuckDB connection', async () => {
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();

      db = drizzle(connection);
      expect(db).toBeDefined();

      const result = await db.execute(sql`SELECT 1 as value`);
      expect(result[0]).toEqual({ value: 1 });

      await db.close();
      db = null;
      instance.closeSync?.();
    });
  });

  describe('drizzle() config object entrypoints', () => {
    test('creates database from config with connection string', async () => {
      db = await drizzle({
        connection: ':memory:',
        pool: false,
      });

      const result = await db.execute(sql`SELECT 1 as value`);
      expect(result[0]).toEqual({ value: 1 });
    });

    test('creates database from config with connection object', async () => {
      db = await drizzle({
        connection: { path: ':memory:' },
        pool: false,
      });

      const result = await db.execute(sql`SELECT 1 as value`);
      expect(result[0]).toEqual({ value: 1 });
    });

    test('creates database from config with explicit client', async () => {
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();

      db = drizzle({
        client: connection,
      });

      const result = await db.execute(sql`SELECT 1 as value`);
      expect(result[0]).toEqual({ value: 1 });

      await db.close();
      db = null;
      instance.closeSync?.();
    });
  });

  describe('drizzle() pool options', () => {
    test('forwards acquireTimeout to auto-created pools', async () => {
      db = await drizzle(':memory:', {
        pool: { size: 1, acquireTimeout: 10 },
      });

      const pool = db.$client as any;
      const leased = await pool.acquire();

      await expect(pool.acquire()).rejects.toThrow(/acquire timeout/i);

      await pool.release(leased);
    });

    test('forwards idleTimeoutMs to auto-created pools', async () => {
      db = await drizzle(':memory:', {
        pool: { size: 1, idleTimeoutMs: 1 },
      });

      const pool = db.$client as any;
      const first = await pool.acquire();
      await pool.release(first);

      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await pool.acquire();
      expect(second).not.toBe(first);

      await pool.release(second);
    });
  });

  describe('close() behavior', () => {
    test('close() resolves successfully', async () => {
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      db = drizzle(connection);

      await db.close();
      db = null;
      instance.closeSync?.();
    });

    test('close() attempts instance close even when client close fails', async () => {
      const closeError = new Error('client close failed');
      const client = {
        close: async () => {
          throw closeError;
        },
      };

      let instanceClosed = 0;
      const instance = {
        closeSync: () => {
          instanceClosed += 1;
        },
      };

      const dbWithFailingClient = new DuckDBDatabase(
        new DuckDBDialect(),
        new DuckDBSession(
          client as never,
          new DuckDBDialect(),
          undefined,
          {}
        ) as never,
        undefined,
        client as never,
        instance as never
      );

      await expect(dbWithFailingClient.close()).rejects.toBe(closeError);
      expect(instanceClosed).toBe(1);
    });

    test('close() closes pooled clients and their instance', async () => {
      const pool = {
        acquire: vi.fn(),
        release: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      const instance = {
        closeSync: vi.fn(),
      };
      const dbWithPool = new DuckDBDatabase(
        new DuckDBDialect(),
        new DuckDBSession(
          pool as never,
          new DuckDBDialect(),
          undefined,
          {}
        ) as never,
        undefined,
        pool as never,
        instance as never
      );

      await dbWithPool.close();

      expect(pool.close).toHaveBeenCalledTimes(1);
      expect(instance.closeSync).toHaveBeenCalledTimes(1);
    });

    test('close() ends direct pg-style clients', async () => {
      const end = vi.fn(async () => undefined);
      const pgClient: PgDuckClient = {
        query: vi.fn(async () => ({ rows: [] })),
        end,
      };
      const dbWithPgClient = drizzle(pgClient);

      await dbWithPgClient.close();

      expect(end).toHaveBeenCalledTimes(1);
    });

    test('connection-string setup closes resources when DuckLake setup fails', async () => {
      const setupError = new Error('ducklake setup failed');
      const connection = {
        run: vi.fn(async () => {
          throw setupError;
        }),
        closeSync: vi.fn(),
      } as unknown as DuckDBConnection;
      const instance = {
        connect: vi.fn(async () => connection),
        closeSync: vi.fn(),
      } as unknown as DuckDBInstance;

      vi.spyOn(DuckDBInstance, 'create').mockResolvedValue(instance);

      await expect(
        drizzle(':memory:', {
          pool: false,
          ducklake: { catalog: 'md:meta_db' },
        })
      ).rejects.toBe(setupError);

      expect(connection.closeSync).toHaveBeenCalledTimes(1);
      expect(instance.closeSync).toHaveBeenCalledTimes(1);
    });
  });
});
