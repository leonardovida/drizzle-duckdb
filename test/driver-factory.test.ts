import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { describe, expect, test, afterEach } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { POOL_PRESETS } from '../src/pool.ts';
import { DuckDBDatabase } from '../src/driver.ts';
import { DuckDBDialect } from '../src/dialect.ts';
import { DuckDBSession } from '../src/session.ts';

describe('Driver Factory Tests', () => {
  let db: DuckDBDatabase | null = null;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
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
  });
});
