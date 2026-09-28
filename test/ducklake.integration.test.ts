import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';

async function canLoadDuckLake(): Promise<boolean> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('LOAD ducklake');
    return true;
  } catch {
    try {
      await connection.run('INSTALL ducklake');
      await connection.run('LOAD ducklake');
      return true;
    } catch {
      return false;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

const ducklakeAvailable = await canLoadDuckLake();

describe.skipIf(!ducklakeAvailable)('DuckLake attach integration', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'drizzle-ducklake-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  test('pooled connections attach once with ATTACH options', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await drizzle(':memory:', {
      pool: { size: 3 },
      ducklake: {
        catalog: join(directory, 'meta.ducklake'),
        attachOptions: { dataPath: join(directory, 'data') },
      },
    });

    try {
      // Concurrent queries force the pool to open and set up 3 connections.
      const results = await Promise.all(
        [1, 2, 3].map((value) =>
          db.execute<{ value: number; database: string }>(
            sql`select ${value}::int as value, current_database() as database`
          )
        )
      );
      expect(results).toEqual([
        [{ value: 1, database: 'ducklake' }],
        [{ value: 2, database: 'ducklake' }],
        [{ value: 3, database: 'ducklake' }],
      ]);

      await db.execute(sql`create table items (id integer)`);
      await db.execute(sql`insert into items values (1), (2)`);
      const counts = await Promise.all(
        [1, 2, 3].map(() =>
          db.execute<{ total: number }>(
            sql`select count(*)::int as total from items`
          )
        )
      );
      expect(counts).toEqual([[{ total: 2 }], [{ total: 2 }], [{ total: 2 }]]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  test('does not warn about pool size when a local catalog defaults to one connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await drizzle(':memory:', {
      ducklake: { catalog: join(directory, 'meta.ducklake') },
    });

    try {
      await expect(
        db.execute<{ database: string }>(
          sql`select current_database() as database`
        )
      ).resolves.toEqual([{ database: 'ducklake' }]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
});
