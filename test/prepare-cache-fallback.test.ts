import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, migrate, type DuckDBDatabase } from '../src/index.ts';

describe('prepareCache with SQL that cannot be prepared', () => {
  let instance: DuckDBInstance;
  let db: DuckDBDatabase;
  let migrationsDir: string;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect(), { prepareCache: true });

    migrationsDir = mkdtempSync(join(tmpdir(), 'drizzle-duckdb-cache-'));
    mkdirSync(join(migrationsDir, 'meta'));
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '5',
        dialect: 'pg',
        entries: [
          {
            idx: 0,
            version: '5',
            when: 1_700_000_000_000,
            tag: '0000_no_breakpoints',
            breakpoints: false,
          },
        ],
      })
    );
    writeFileSync(
      join(migrationsDir, '0000_no_breakpoints.sql'),
      [
        'CREATE TABLE cache_a (id INTEGER);',
        'CREATE TABLE cache_b (id INTEGER);',
        'INSERT INTO cache_a VALUES (1);',
        '-- trailing comment',
      ].join('\n')
    );
  });

  afterAll(async () => {
    await db.close();
    instance.closeSync();
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('multi-statement SQL runs and returns the last result', async () => {
    const rows = await db.execute(
      sql.raw(
        'create table cache_multi(a int); insert into cache_multi values (1); select * from cache_multi'
      )
    );
    expect(rows).toEqual([{ a: 1 }]);
  });

  test('multi-statement SQL with params binds the last statement', async () => {
    const rows = await db.execute(
      sql`create temp table cache_params(a int); select ${5}::int as a`
    );
    expect(rows).toEqual([{ a: 5 }]);
  });

  test('comment-only SQL does not throw', async () => {
    await expect(
      db.execute(sql.raw('-- nothing to run'))
    ).resolves.toBeDefined();
  });

  test('single statements still use the cache', async () => {
    expect(await db.execute(sql`select ${1}::int as one`)).toEqual([
      { one: 1 },
    ]);
    expect(await db.execute(sql`select ${2}::int as one`)).toEqual([
      { one: 2 },
    ]);
  });

  test('a migration without breakpoints applies', async () => {
    await migrate(db, { migrationsFolder: migrationsDir });

    expect(
      await db.execute(
        sql`select (select count(*) from cache_a)::int as a, (select count(*) from cache_b)::int as b`
      )
    ).toEqual([{ a: 1, b: 0 }]);
  });
});
