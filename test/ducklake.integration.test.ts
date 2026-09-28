import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { createDuckDBConnectionPool } from '../src/pool.ts';

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

  test('throws when the main database already uses the DuckLake alias', async () => {
    // DuckDB names the main database after the file, so it takes the default
    // "ducklake" alias and ATTACH IF NOT EXISTS would silently do nothing.
    await expect(
      drizzle(join(directory, 'ducklake.duckdb'), {
        pool: false,
        ducklake: {
          catalog: join(directory, 'meta.ducklake'),
          attachOptions: { dataPath: join(directory, 'data') },
        },
      })
    ).rejects.toThrow(
      /DuckLake alias "ducklake" is already used by a duckdb database .*Set ducklake.alias/
    );

    const db = await drizzle(join(directory, 'ducklake.duckdb'), {
      pool: false,
      ducklake: {
        catalog: join(directory, 'meta.ducklake'),
        alias: 'lake',
        attachOptions: { dataPath: join(directory, 'data') },
      },
    });
    try {
      await expect(
        db.execute(sql`select current_database() as database`)
      ).resolves.toEqual([{ database: 'lake' }]);
    } finally {
      await db.close();
    }
  });

  test('throws when a shared pool already attached another catalog under the alias', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const pool = createDuckDBConnectionPool(instance, { size: 2 });
    const first = drizzle({
      client: pool,
      ducklake: {
        catalog: join(directory, 'a.ducklake'),
        attachOptions: { dataPath: join(directory, 'a-data') },
      },
    });
    const second = drizzle({
      client: pool,
      ducklake: {
        catalog: join(directory, 'b.ducklake'),
        attachOptions: { dataPath: join(directory, 'b-data') },
      },
    });
    const sameCatalog = drizzle({
      client: pool,
      ducklake: {
        // The same catalog spelled as a file URL still matches.
        catalog: pathToFileURL(join(directory, 'a.ducklake')).href,
        attachOptions: { dataPath: join(directory, 'a-data') },
      },
    });

    try {
      await first.execute(sql`create table meant_for_a (id integer)`);
      await expect(
        second.execute(sql`create table meant_for_b (id integer)`)
      ).rejects.toThrow(
        /DuckLake alias "ducklake" is already attached to catalog '.*a\.ducklake', so catalog '.*b\.ducklake' was not attached/
      );
      await expect(
        sameCatalog.execute<{ total: number }>(
          sql`select count(*)::int as total from meant_for_a`
        )
      ).resolves.toEqual([{ total: 0 }]);
    } finally {
      await pool.close();
      instance.closeSync();
    }
  });

  test('metaParameters pass META_ options to the metadata catalog', async () => {
    const db = await drizzle(':memory:', {
      ducklake: {
        catalog: join(directory, 'meta.ducklake'),
        attachOptions: {
          dataPath: join(directory, 'data'),
          metaParameters: { type: 'duckdb' },
        },
      },
    });

    try {
      await db.execute(sql`create table items (id integer)`);
      await expect(
        db.execute<{ type: string }>(
          sql`select type from duckdb_databases() where database_name = 'ducklake'`
        )
      ).resolves.toEqual([{ type: 'ducklake' }]);
    } finally {
      await db.close();
    }
  });
});
