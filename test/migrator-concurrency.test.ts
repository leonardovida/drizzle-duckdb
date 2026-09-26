import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';

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
