import type { DuckDBConnection } from '@duckdb/node-api';
import { describe, expect, test, vi } from 'vitest';
import {
  buildDuckLakeAttachSql,
  configureDuckLake,
  isDuckDbFileCatalog,
  normalizeDuckLakeConfig,
  resolveDuckLakePoolSize,
  wrapDuckLakePool,
} from '../src/ducklake.ts';

describe('DuckLake helpers', () => {
  test('normalizeDuckLakeConfig defaults alias and use', () => {
    const normalized = normalizeDuckLakeConfig({ catalog: 'md:meta_db' });
    expect(normalized.catalog).toBe('ducklake:md:meta_db');
    expect(normalized.alias).toBe('ducklake');
    expect(normalized.use).toBe(true);
  });

  test('buildDuckLakeAttachSql emits attach with options', () => {
    const sql = buildDuckLakeAttachSql({
      catalog: 'md:meta_db',
      alias: 'lake',
      attachOptions: {
        dataPath: './data',
        readOnly: true,
        createIfNotExists: true,
      },
    });

    expect(sql).toBe(
      `ATTACH 'ducklake:md:meta_db' AS "lake" (CREATE_IF_NOT_EXISTS=true, DATA_PATH='./data', READ_ONLY=true)`
    );
  });

  test('buildDuckLakeAttachSql escapes identifiers and skips blank strings', () => {
    const sql = buildDuckLakeAttachSql({
      catalog: "md:meta'db",
      alias: 'lake"name',
      attachOptions: {
        dataPath: '',
        metadataCatalog: "cat'alog",
        readOnly: false,
      },
    });

    expect(sql).toBe(
      `ATTACH 'ducklake:md:meta''db' AS "lake""name" (METADATA_CATALOG='cat''alog', READ_ONLY=false)`
    );
  });

  test('configureDuckLake runs normalized setup in order', async () => {
    const connection = {
      run: vi.fn(async () => undefined),
    } as unknown as DuckDBConnection;

    await configureDuckLake(connection, {
      catalog: 'md:meta_db',
      alias: 'lake',
      install: true,
      load: true,
    });

    expect(connection.run).toHaveBeenCalledTimes(4);
    expect(connection.run).toHaveBeenNthCalledWith(1, 'INSTALL ducklake');
    expect(connection.run).toHaveBeenNthCalledWith(2, 'LOAD ducklake');
    expect(connection.run).toHaveBeenNthCalledWith(
      3,
      `ATTACH 'ducklake:md:meta_db' AS "lake"`
    );
    expect(connection.run).toHaveBeenNthCalledWith(4, 'USE "lake"');
  });

  test('isDuckDbFileCatalog detects local file catalogs', () => {
    expect(isDuckDbFileCatalog('./ducklake.duckdb')).toBe(true);
    expect(isDuckDbFileCatalog('ducklake:./ducklake.duckdb')).toBe(true);
    expect(isDuckDbFileCatalog(':memory:')).toBe(true);
    expect(isDuckDbFileCatalog('md:__ducklake_metadata_db')).toBe(false);
    expect(isDuckDbFileCatalog('ducklake:md:__ducklake_metadata_db')).toBe(
      false
    );
    expect(isDuckDbFileCatalog('postgres://localhost/db')).toBe(false);
  });

  test('resolveDuckLakePoolSize defaults to 1 for local catalogs', () => {
    const resolution = resolveDuckLakePoolSize(undefined, {
      catalog: './ducklake.duckdb',
    });
    expect(resolution.poolSize).toBe(1);
    expect(resolution.isLocalCatalog).toBe(true);
  });

  test('wrapDuckLakePool releases the slot when configuration fails', async () => {
    const connection = {
      run: vi.fn(async () => {
        throw new Error('setup failed');
      }),
    } as unknown as DuckDBConnection;
    const pool = {
      acquire: vi.fn(async () => connection),
      release: vi.fn(async () => undefined),
    };
    const wrapped = wrapDuckLakePool(pool, {
      catalog: 'md:meta_db',
    });

    await expect(wrapped.acquire()).rejects.toThrow('setup failed');
    expect(pool.release).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledWith(connection);
  });
});
