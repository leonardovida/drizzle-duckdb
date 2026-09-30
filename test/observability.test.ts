import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { createDuckDBConnectionPool } from '../src/pool.ts';
import { getPreparedStatementCacheStats } from '../src/prepared-statement-cache.ts';
import { introspect } from '../src/introspect.ts';

test('pool counters reflect queue handoff, leases and snapshot introspection', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const pool = createDuckDBConnectionPool(instance, { size: 1 });
  const db = drizzle(pool);
  try {
    const first = await pool.acquire();
    const second = pool.acquire();
    expect(pool.stats()).toMatchObject({
      created: 1,
      leased: 1,
      waiting: 1,
      queued: 1,
    });
    await pool.release(first);
    const handedOff = await second;
    expect(handedOff).toBe(first);
    expect(pool.stats()).toMatchObject({
      created: 1,
      leased: 1,
      waiting: 0,
      queued: 1,
    });
    await pool.release(handedOff);
    await db.execute(sql`create table observed(id integer)`);
    expect((await introspect(db)).files.metaJson.map((t) => t.name)).toEqual([
      'observed',
    ]);
    expect(pool.stats()).toMatchObject({ leased: 0, idle: 1, created: 1 });
    await db.close();
    expect(pool.stats()).toMatchObject({
      closed: true,
      total: 0,
      leased: 0,
      idle: 0,
    });
  } finally {
    await db.close();
    instance.closeSync();
  }
});

test('native cache counters observe reuse and eviction without creating a cache', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection, { prepareCache: { size: 2 } });
  try {
    expect(getPreparedStatementCacheStats(connection)).toBeUndefined();
    await db.execute(sql`select ${1}::integer as value`);
    await db.execute(sql`select ${2}::integer as value`);
    await db.execute(sql`select ${3}::integer as another`);
    await db.execute(sql`select ${4}::integer as third`);
    expect(getPreparedStatementCacheStats(connection)).toEqual({
      size: 2,
      capacity: 2,
      hits: 1,
      misses: 3,
      evictions: 1,
    });
  } finally {
    await db.close();
    instance.closeSync();
  }
});
