import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { createDuckDBConnectionPool } from '../src/pool.ts';
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
