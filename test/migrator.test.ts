import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from 'vitest';
import { drizzle } from '../src/driver.ts';
import { migrate } from '../src/migrator.ts';
import type { DuckDBDatabase } from '../src/driver.ts';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('Migrator Tests', () => {
  let instance: DuckDBInstance;
  let db: DuckDBDatabase;
  const testMigrationsDir = join(import.meta.dirname, '.tmp/test-migrations');

  beforeAll(async () => {
    // Create test migrations directory
    if (!existsSync(testMigrationsDir)) {
      mkdirSync(testMigrationsDir, { recursive: true });
    }

    // Create a meta directory for drizzle migrations
    const metaDir = join(testMigrationsDir, 'meta');
    if (!existsSync(metaDir)) {
      mkdirSync(metaDir, { recursive: true });
    }

    // Create _journal.json
    writeFileSync(
      join(metaDir, '_journal.json'),
      JSON.stringify({
        version: '5',
        dialect: 'pg',
        entries: [
          {
            idx: 0,
            version: '5',
            when: Date.now(),
            tag: '0001_create_users',
            breakpoints: false,
          },
        ],
      })
    );

    // Create snapshot file
    writeFileSync(
      join(metaDir, '0001_snapshot.json'),
      JSON.stringify({
        version: '5',
        dialect: 'pg',
        tables: {},
        enums: {},
      })
    );

    // Create migration SQL file
    writeFileSync(
      join(testMigrationsDir, '0001_create_users.sql'),
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email TEXT UNIQUE
      );`
    );
  });

  beforeEach(async () => {
    instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    db = drizzle(connection);
  });

  afterEach(async () => {
    await db.close();
    instance.closeSync?.();
  });

  afterAll(async () => {
    // Clean up test migrations
    if (existsSync(testMigrationsDir)) {
      rmSync(testMigrationsDir, { recursive: true, force: true });
    }
  });

  test('migrate applies SQL migrations from folder', async () => {
    await migrate(db, { migrationsFolder: testMigrationsDir });

    // Verify the table was created
    const result = await db.execute<{ name: string }>(sql`
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_name = 'users'
    `);

    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe('users');
  });

  test('migrate accepts a migrations folder string', async () => {
    await db.execute(sql`DROP TABLE IF EXISTS users`);

    await migrate(db, testMigrationsDir);

    const result = await db.execute<{ name: string }>(sql`
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_name = 'users'
    `);

    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe('users');
  });

  test('migrate creates __drizzle_migrations table', async () => {
    await migrate(db, { migrationsFolder: testMigrationsDir });

    const result = await db.execute<{ name: string }>(sql`
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
    `);

    expect(result.length).toBe(1);
  });
});
