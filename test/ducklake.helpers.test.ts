import { describe, expect, test } from 'vitest';
import {
  buildDuckLakeAttachSql,
  isDuckDbFileCatalog,
  normalizeDuckLakeConfig,
  resolveDuckLakePoolSize,
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
});
