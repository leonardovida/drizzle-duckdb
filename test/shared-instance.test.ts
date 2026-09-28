import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from '../src/index.ts';

describe('drizzle(path) shares one instance per file', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drizzle-duckdb-shared-'));
    file = join(dir, 'app.duckdb');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('two databases on one file see each other and keep every write', async () => {
    const a = await drizzle(file);
    const b = await drizzle(file);

    await a.execute(sql`create table t (id integer)`);
    await b.execute(sql`insert into t values (1)`);
    await a.execute(sql`insert into t values (2)`);

    expect(await a.execute(sql`select id from t order by id`)).toEqual([
      { id: 1 },
      { id: 2 },
    ]);

    await a.close();
    // Closing one database leaves the other usable.
    await b.execute(sql`insert into t values (3)`);
    await b.close();

    const reopened = await drizzle(file);
    expect(await reopened.execute(sql`select id from t order by id`)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    await reopened.close();
  });

  test('opening a file with conflicting options throws instead of forking it', async () => {
    const a = await drizzle({
      connection: { path: file, options: { threads: '1' } },
    });
    try {
      await expect(
        drizzle({ connection: { path: file, options: { threads: '2' } } })
      ).rejects.toThrow(/different configuration/);
    } finally {
      await a.close();
    }
  });

  test(':memory: databases stay separate', async () => {
    const a = await drizzle(':memory:');
    const b = await drizzle(':memory:');
    await a.execute(sql`create table only_a (id integer)`);
    await expect(b.execute(sql`select * from only_a`)).rejects.toThrow(
      /only_a/
    );
    await a.close();
    await b.close();
  });
});
