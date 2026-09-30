import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { migrate } from '../src/migrator.ts';

async function runConcurrentMigrators(
  migrations: MigrationMeta[],
  options: { setupFirst: boolean }
) {
  const instance = await DuckDBInstance.create(':memory:');
  const firstConnection = await instance.connect();
  const secondConnection = await instance.connect();
  const first = drizzle(firstConnection);
  const second = drizzle(secondConnection);
  const config = { migrationsFolder: '.' };
  try {
    if (options.setupFirst) {
      await first.dialect.migrate([], first.session, config);
    }
    const results = await Promise.allSettled([
      first.dialect.migrate(migrations, first.session, config),
      second.dialect.migrate(migrations, second.session, config),
    ]);
    const journal = await first.execute<{ hash: string }>(
      sql`select hash from drizzle.__drizzle_migrations order by created_at`
    );
    return { results, journal };
  } finally {
    firstConnection.closeSync();
    secondConnection.closeSync();
    instance.closeSync?.();
  }
}

// Each run races two migrators, so repeat to catch the losing side.
const RACE_RUNS = 5;

test('concurrent migrators succeed on a fresh database', async () => {
  const migrations = [
    {
      hash: 'fresh-migration',
      folderMillis: 1000,
      sql: ['create table if not exists fresh_effects (id integer)'],
      bps: true,
    },
  ];
  for (let run = 0; run < RACE_RUNS; run += 1) {
    const { results, journal } = await runConcurrentMigrators(migrations, {
      setupFirst: false,
    });
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    expect(journal).toEqual([{ hash: 'fresh-migration' }]);
  }
});

test('concurrent migrators succeed with DDL migrations', async () => {
  const migrations = [
    {
      hash: 'ddl-users',
      folderMillis: 1000,
      sql: ['create table users (id integer)'],
      bps: true,
    },
    {
      hash: 'ddl-posts',
      folderMillis: 2000,
      sql: ['create table posts (id integer)', 'insert into posts values (1)'],
      bps: true,
    },
  ];
  for (const setupFirst of [true, false]) {
    for (let run = 0; run < RACE_RUNS; run += 1) {
      const { results, journal } = await runConcurrentMigrators(migrations, {
        setupFirst,
      });
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      expect(journal).toEqual([{ hash: 'ddl-users' }, { hash: 'ddl-posts' }]);
    }
  }
});

test('migrate() calls on one database run one after another', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'drizzle-duckdb-migrate-'));
  const db = await drizzle(':memory:', { pool: { size: 4 } });
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 1000,
            tag: '0000_a',
            breakpoints: true,
          },
          {
            idx: 1,
            version: '7',
            when: 2000,
            tag: '0001_b',
            breakpoints: true,
          },
        ],
      })
    );
    await writeFile(
      join(folder, '0000_a.sql'),
      'create table serial_a (id integer);\n--> statement-breakpoint\ninsert into serial_a values (1);'
    );
    await writeFile(
      join(folder, '0001_b.sql'),
      'create table serial_b (id integer);'
    );

    let active = 0;
    let maxActive = 0;
    const originalMigrate = db.dialect.migrate.bind(db.dialect);
    db.dialect.migrate = async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await originalMigrate(...args);
      } finally {
        active -= 1;
      }
    };

    await Promise.all(
      Array.from({ length: 4 }, () => migrate(db, { migrationsFolder: folder }))
    );

    expect(maxActive).toBe(1);
    expect(
      await db.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`
      )
    ).toEqual([{ count: 2 }]);
    expect(
      await db.execute<{ count: number }>(
        sql`select count(*)::int as count from serial_a`
      )
    ).toEqual([{ count: 1 }]);
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('concurrent migrators apply each migration once', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const firstConnection = await instance.connect();
  const secondConnection = await instance.connect();
  const first = drizzle(firstConnection);
  const second = drizzle(secondConnection);
  const config = { migrationsFolder: '.' };
  const migrations = [
    {
      hash: 'concurrent-migration',
      bps: false,
      folderMillis: 1000,
      sql: ['insert into migration_effects values (1)'],
    },
  ];

  try {
    await first.execute(sql`create table migration_effects (id integer)`);
    await first.dialect.migrate([], first.session, config);

    let transactionsStarted = 0;
    let releaseTransactions!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseTransactions = resolve;
    });

    for (const db of [first, second]) {
      const originalTransaction = db.session.transaction.bind(db.session);
      db.session.transaction = (callback, options) =>
        originalTransaction(async (tx) => {
          transactionsStarted += 1;
          if (transactionsStarted === 2) {
            releaseTransactions();
          }
          await bothStarted;
          return callback(tx);
        }, options);
    }

    await Promise.all([
      first.dialect.migrate(migrations, first.session, config),
      second.dialect.migrate(migrations, second.session, config),
    ]);

    const effects = await first.execute<{ count: bigint }>(
      sql`select count(*) as count from migration_effects`
    );
    const journal = await first.execute<{ count: bigint }>(
      sql`select count(*) as count from drizzle.__drizzle_migrations`
    );
    expect(effects[0]?.count).toBe(1n);
    expect(journal[0]?.count).toBe(1n);
  } finally {
    firstConnection.closeSync();
    secondConnection.closeSync();
    instance.closeSync?.();
  }
});

test('migrate() calls on two databases opened on one file run one after another', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'drizzle-duckdb-migrate-'));
  const file = join(folder, 'app.duckdb');
  const migrations = join(folder, 'migrations');
  // Two spellings of one path share one database and one queue.
  const first = await drizzle(file);
  const second = await drizzle(join(folder, '.', 'app.duckdb'));
  try {
    await mkdir(join(migrations, 'meta'), { recursive: true });
    await writeFile(
      join(migrations, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 1000,
            tag: '0000_a',
            breakpoints: true,
          },
        ],
      })
    );
    await writeFile(
      join(migrations, '0000_a.sql'),
      'create table shared_file_a (id integer);'
    );

    let active = 0;
    let maxActive = 0;
    for (const db of [first, second]) {
      const originalMigrate = db.dialect.migrate.bind(db.dialect);
      db.dialect.migrate = async (...args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await originalMigrate(...args);
        } finally {
          active -= 1;
        }
      };
    }

    await Promise.all([
      migrate(first, { migrationsFolder: migrations }),
      migrate(second, { migrationsFolder: migrations }),
      migrate(first, { migrationsFolder: migrations }),
      migrate(second, { migrationsFolder: migrations }),
    ]);

    expect(maxActive).toBe(1);
    expect(
      await second.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`
      )
    ).toEqual([{ count: 1 }]);
  } finally {
    await first.close();
    await second.close();
    await rm(folder, { recursive: true, force: true });
  }
});
