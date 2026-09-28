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
      `ATTACH IF NOT EXISTS 'ducklake:md:meta_db' AS "lake" (CREATE_IF_NOT_EXISTS true, DATA_PATH './data', READ_ONLY true)`
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
      `ATTACH IF NOT EXISTS 'ducklake:md:meta''db' AS "lake""name" (METADATA_CATALOG 'cat''alog', READ_ONLY false)`
    );
  });

  test('configureDuckLake runs normalized setup in order', async () => {
    const connection = {
      run: vi.fn(async () => undefined),
      runAndReadAll: vi.fn(async () => ({
        getRowObjects: () => [{ type: 'ducklake', path: 'md:meta_db' }],
      })),
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
      `ATTACH IF NOT EXISTS 'ducklake:md:meta_db' AS "lake"`
    );
    expect(connection.run).toHaveBeenNthCalledWith(4, 'USE "lake"');
  });

  test('configureDuckLake checks the alias after attaching', async () => {
    const connectionWith = (row: { type: string; path: string | null }) =>
      ({
        run: vi.fn(async () => undefined),
        runAndReadAll: vi.fn(async () => ({ getRowObjects: () => [row] })),
      }) as unknown as DuckDBConnection;

    await expect(
      configureDuckLake(
        connectionWith({ type: 'duckdb', path: '/data/ducklake.duckdb' }),
        { catalog: '/data/meta.ducklake' }
      )
    ).rejects.toThrow(
      `DuckLake alias "ducklake" is already used by a duckdb database at '/data/ducklake.duckdb', so catalog '/data/meta.ducklake' was not attached`
    );
    await expect(
      configureDuckLake(
        connectionWith({ type: 'ducklake', path: '/data/a.ducklake' }),
        { catalog: '/data/b.ducklake' }
      )
    ).rejects.toThrow(
      `DuckLake alias "ducklake" is already attached to catalog '/data/a.ducklake'`
    );

    // Equivalent spellings of the same local file are accepted.
    await expect(
      configureDuckLake(
        connectionWith({ type: 'ducklake', path: 'duckdb:/data/a.ducklake' }),
        { catalog: 'file:///data/a.ducklake' }
      )
    ).resolves.toBeUndefined();
    // Remote and secret catalogs report a resolved path, so only the type is
    // checked for them.
    await expect(
      configureDuckLake(
        connectionWith({ type: 'ducklake', path: '/secrets/meta.ducklake' }),
        { catalog: 'my_lake_secret' }
      )
    ).resolves.toBeUndefined();
    await expect(
      configureDuckLake(
        connectionWith({ type: 'motherduck', path: 'md:ducklake' }),
        { catalog: 'md:__ducklake_metadata_lake' }
      )
    ).rejects.toThrow(/already used by a motherduck database/);
  });

  test('buildDuckLakeAttachSql emits META_ options from metaParameters', () => {
    expect(
      buildDuckLakeAttachSql({
        catalog: 'meta.ducklake',
        attachOptions: {
          dataPath: './data',
          metaParameters: { type: 'duckdb', Other_Key: "it's" },
        },
      })
    ).toBe(
      `ATTACH IF NOT EXISTS 'ducklake:meta.ducklake' AS "ducklake" (DATA_PATH './data', META_TYPE 'duckdb', META_OTHER_KEY 'it''s')`
    );
    for (const key of ['', '1type', 'bad key', "x') ; drop"]) {
      expect(() =>
        buildDuckLakeAttachSql({
          catalog: 'meta.ducklake',
          attachOptions: { metaParameters: { [key]: 'value' } },
        })
      ).toThrow(/metaParameters key/);
    }
  });

  test('buildDuckLakeAttachSql rejects the metaParameterName placeholder', () => {
    expect(() =>
      buildDuckLakeAttachSql({
        catalog: 'meta.ducklake',
        attachOptions: { metaParameterName: 'postgres' },
      })
    ).toThrow(/metaParameterName is not supported.*Use metaParameters/);
  });

  test('buildDuckLakeAttachSql rejects numbers that are not non-negative integers', () => {
    for (const value of [Infinity, -Infinity, NaN, -5, 1.5, 2 ** 53]) {
      expect(() =>
        buildDuckLakeAttachSql({
          catalog: 'meta.ducklake',
          attachOptions: { dataInliningRowLimit: value },
        })
      ).toThrow(
        `DuckLake attach option dataInliningRowLimit must be a non-negative integer, got ${value}`
      );
    }
    expect(
      buildDuckLakeAttachSql({
        catalog: 'meta.ducklake',
        attachOptions: { dataInliningRowLimit: 0 },
      })
    ).toBe(
      `ATTACH IF NOT EXISTS 'ducklake:meta.ducklake' AS "ducklake" (DATA_INLINING_ROW_LIMIT 0)`
    );
  });

  test('normalizeDuckLakeConfig trims the catalog', () => {
    expect(
      normalizeDuckLakeConfig({ catalog: ' ducklake:./x.duckdb ' }).catalog
    ).toBe('ducklake:./x.duckdb');
    expect(normalizeDuckLakeConfig({ catalog: '  ./x.duckdb\n' }).catalog).toBe(
      'ducklake:./x.duckdb'
    );
    expect(() => normalizeDuckLakeConfig({ catalog: '   ' })).toThrow(
      'DuckLake config requires a catalog'
    );
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
    expect(isDuckDbFileCatalog('metadata.ducklake')).toBe(true);
    expect(isDuckDbFileCatalog('ducklake:metadata.ducklake')).toBe(true);
  });

  test('isDuckDbFileCatalog treats scheme-less paths and file URLs as local', () => {
    for (const catalog of [
      'meta.db',
      'ducklake:meta.db',
      'meta.sqlite',
      'file:///tmp/meta.ducklake',
      'ducklake:file:///tmp/meta.ducklake',
      'duckdb:meta',
      'ducklake:duckdb:meta.duckdb',
      ' ducklake: ./x.duckdb ',
      'C:\\lake\\meta',
      '~/lake/meta',
    ]) {
      expect(isDuckDbFileCatalog(catalog), catalog).toBe(true);
    }
    for (const catalog of [
      'md:meta',
      's3://bucket/meta.ducklake',
      'gs://bucket/meta.ducklake',
      'postgres:dbname=lake',
      'postgresql://localhost/lake',
      'mysql:db=lake',
      'sqlite:meta.sqlite',
      // DuckLake reads a bare name as a secret name.
      'ducklake:my_lake',
      'my_lake',
    ]) {
      expect(isDuckDbFileCatalog(catalog), catalog).toBe(false);
    }
    expect(
      resolveDuckLakePoolSize(undefined, { catalog: 'meta.db' }).poolSize
    ).toBe(1);
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
