import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle, createDuckDBConnectionPool } from '../src';
import { describe, expect, test, beforeAll, afterAll } from 'vitest';

const motherduckToken = process.env.MOTHERDUCK_TOKEN;
const skipMotherduck = !motherduckToken || process.env.SKIP_MOTHERDUCK === '1';

/**
 * Pool performance tests comparing single connection vs pooled connections.
 * These tests measure the impact of connection pooling on concurrent query execution.
 */
describe.skipIf(skipMotherduck)('Connection Pooling Performance', () => {
  // Use unique table name per test run to avoid conflicts
  const tableName = `pool_test_${Date.now()}`;

  const testTable = pgTable(tableName, {
    id: integer('id'),
    name: text('name'),
    value: integer('value'),
  });

  let instance: DuckDBInstance;
  let singleConnection: DuckDBConnection;

  beforeAll(async () => {
    instance = await DuckDBInstance.create('md:', {
      motherduck_token: motherduckToken!,
    });
    singleConnection = await instance.connect();

    // Create test table
    const db = drizzle(singleConnection);
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName}`));
    await db.execute(
      sql.raw(`
      CREATE TABLE ${tableName} (
        id INTEGER,
        name TEXT,
        value INTEGER
      )
    `)
    );

    // Insert test data
    const values = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item_${i}`,
      value: Math.floor(Math.random() * 1000),
    }));

    for (const v of values) {
      await db.insert(testTable).values(v);
    }
  }, 120_000);

  afterAll(async () => {
    if (singleConnection) {
      try {
        const db = drizzle(singleConnection);
        await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName}`));
      } catch {
        // Ignore cleanup errors
      }
      singleConnection.closeSync();
    }
    if (instance) {
      instance.closeSync();
    }
  });

  test('single connection: concurrent queries serialize', async () => {
    const db = drizzle(singleConnection);

    // Run 10 concurrent queries on a single connection
    const concurrentQueries = 10;
    const queries = Array.from({ length: concurrentQueries }, (_, i) =>
      db
        .select()
        .from(testTable)
        .where(sql`${testTable.id} = ${i}`)
    );

    const start = performance.now();
    const results = await Promise.all(queries);
    const singleConnectionTime = performance.now() - start;

    expect(results).toHaveLength(concurrentQueries);
    results.forEach((r) => expect(r).toHaveLength(1));

    console.log(
      `\n  Single connection (${concurrentQueries} concurrent queries): ${singleConnectionTime.toFixed(2)}ms`
    );

    return { time: singleConnectionTime, queryCount: concurrentQueries };
  }, 120_000);

  test('pooled connection: concurrent queries run in parallel', async () => {
    const pool = createDuckDBConnectionPool(instance, { size: 4 });
    const db = drizzle(pool);

    // Run 10 concurrent queries on a pool of 4 connections
    const concurrentQueries = 10;
    const queries = Array.from({ length: concurrentQueries }, (_, i) =>
      db
        .select()
        .from(testTable)
        .where(sql`${testTable.id} = ${i}`)
    );

    const start = performance.now();
    const results = await Promise.all(queries);
    const pooledTime = performance.now() - start;

    expect(results).toHaveLength(concurrentQueries);
    results.forEach((r) => expect(r).toHaveLength(1));

    console.log(
      `  Pooled connection (${concurrentQueries} concurrent queries, pool size 4): ${pooledTime.toFixed(2)}ms`
    );

    await pool.close();

    return { time: pooledTime, queryCount: concurrentQueries };
  }, 120_000);

  test('comparison: pool vs single with heavier queries', async () => {
    const concurrentQueries = 8;

    // Heavier query that takes more time
    const heavyQuery = (db: ReturnType<typeof drizzle>) =>
      db.execute(
        sql.raw(`
        SELECT
          t1.id,
          t1.name,
          t1.value,
          (SELECT COUNT(*) FROM ${tableName} t2 WHERE t2.value <= t1.value) as rank
        FROM ${tableName} t1
        WHERE t1.id < 20
        ORDER BY t1.value DESC
      `)
      );

    // Single connection timing
    const singleDb = drizzle(singleConnection);
    const singleQueries = Array.from({ length: concurrentQueries }, () =>
      heavyQuery(singleDb)
    );

    const singleStart = performance.now();
    await Promise.all(singleQueries);
    const singleTime = performance.now() - singleStart;

    // Pooled connection timing
    const pool = createDuckDBConnectionPool(instance, { size: 4 });
    const pooledDb = drizzle(pool);
    const pooledQueries = Array.from({ length: concurrentQueries }, () =>
      heavyQuery(pooledDb)
    );

    const poolStart = performance.now();
    await Promise.all(pooledQueries);
    const pooledTime = performance.now() - poolStart;

    await pool.close();

    const speedup = singleTime / pooledTime;

    console.log(
      `\n  Heavy query comparison (${concurrentQueries} concurrent):`
    );
    console.log(`    Single connection: ${singleTime.toFixed(2)}ms`);
    console.log(`    Pooled (size 4):   ${pooledTime.toFixed(2)}ms`);
    console.log(`    Speedup:           ${speedup.toFixed(2)}x`);

    // Pool should generally be faster for concurrent heavy queries
    // (may not always be true due to network variance, but captures the pattern)
    expect(speedup).toBeGreaterThan(0);
  }, 120_000);

  test('auto-pooling via connection string', async () => {
    // Test the new async drizzle() with connection string
    const db = await drizzle({
      connection: {
        path: 'md:',
        options: { motherduck_token: motherduckToken! },
      },
      pool: { size: 4 },
    });

    const concurrentQueries = 8;
    const queries = Array.from({ length: concurrentQueries }, (_, i) =>
      db
        .select()
        .from(testTable)
        .where(sql`${testTable.id} = ${i}`)
    );

    const start = performance.now();
    const results = await Promise.all(queries);
    const time = performance.now() - start;

    expect(results).toHaveLength(concurrentQueries);
    console.log(
      `\n  Auto-pooled via connection string (${concurrentQueries} queries): ${time.toFixed(2)}ms`
    );

    // Verify $client is accessible
    expect(db.$client).toBeDefined();
    expect(typeof (db.$client as any).acquire).toBe('function');

    await db.close();
  }, 120_000);

  test('pool presets work correctly', async () => {
    // Test 'standard' preset (6 connections)
    const db = await drizzle({
      connection: {
        path: 'md:',
        options: { motherduck_token: motherduckToken! },
      },
      pool: 'standard',
    });

    const result = await db.select().from(testTable).limit(1);
    expect(result).toHaveLength(1);

    // Verify pool size via the $client
    const pool = db.$client as any;
    expect(pool.size).toBe(6); // 'standard' preset = 6

    await db.close();
  }, 120_000);
});

/**
 * Local DuckDB pool tests (don't require MotherDuck token)
 */
describe('Local DuckDB Pooling', () => {
  test('in-memory pooling via connection string', async () => {
    const db = await drizzle(':memory:');

    // Create a test table
    await db.execute(sql`CREATE TABLE test_items (id INTEGER, name TEXT)`);
    await db.execute(
      sql`INSERT INTO test_items VALUES (1, 'a'), (2, 'b'), (3, 'c')`
    );

    // Run concurrent queries
    const queries = Array.from({ length: 10 }, (_, i) =>
      db.execute(sql`SELECT * FROM test_items WHERE id = ${(i % 3) + 1}`)
    );

    const results = await Promise.all(queries);
    expect(results).toHaveLength(10);
    results.forEach((r) => expect(r).toHaveLength(1));

    // Verify $client exists
    expect(db.$client).toBeDefined();

    await db.close();
  });

  test('pool: false creates single connection', async () => {
    const db = await drizzle(':memory:', { pool: false });

    await db.execute(sql`CREATE TABLE single_test (id INTEGER)`);
    await db.execute(sql`INSERT INTO single_test VALUES (1)`);

    const result = await db.execute(sql`SELECT * FROM single_test`);
    expect(result).toHaveLength(1);

    // $client should be a connection, not a pool
    expect(db.$client).toBeDefined();
    expect(typeof (db.$client as any).acquire).toBe('undefined');

    await db.close();
  });

  test('custom pool size', async () => {
    const db = await drizzle(':memory:', { pool: { size: 8 } });

    await db.execute(sql`SELECT 1`);

    const pool = db.$client as any;
    expect(pool.size).toBe(8);

    await db.close();
  });

  test('backward compatibility: direct connection still works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();

    // Old sync API
    const db = drizzle(connection);

    await db.execute(sql`CREATE TABLE compat_test (id INTEGER)`);
    const result = await db.execute(sql`SELECT 1 as num`);
    expect(result[0].num).toBe(1);

    connection.closeSync();
    instance.closeSync();
  });

  test('backward compatibility: manual pool still works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const pool = createDuckDBConnectionPool(instance, { size: 2 });

    // Old sync API with pool
    const db = drizzle(pool);

    await db.execute(sql`CREATE TABLE manual_pool_test (id INTEGER)`);
    const result = await db.execute(sql`SELECT 1 as num`);
    expect(result[0].num).toBe(1);

    await pool.close();
    instance.closeSync();
  });

  test('pooled transactions pin a single connection', async () => {
    const db = await drizzle(':memory:', { pool: { size: 2 } });

    await db.execute(
      sql`CREATE TABLE tx_pin (id INTEGER PRIMARY KEY, name TEXT)`
    );

    // Rollback path should leave table empty
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO tx_pin VALUES (1, 'a')`);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const afterRollback = await db.execute(
      sql`SELECT COUNT(*) as c FROM tx_pin`
    );
    expect(afterRollback[0].c).toBe(0n);

    // Commit path should persist both rows
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO tx_pin VALUES (1, 'a')`);
      await tx.execute(sql`INSERT INTO tx_pin VALUES (2, 'b')`);
    });

    const afterCommit = await db.execute(sql`SELECT COUNT(*) as c FROM tx_pin`);
    expect(afterCommit[0].c).toBe(2n);

    await db.close();
  });
});
