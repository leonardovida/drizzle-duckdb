import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { DuckDBDatabase } from './driver.ts';
import { databaseKeyOf } from './instance-keys.ts';
import type { PgSession } from 'drizzle-orm/pg-core/session';
import {
  normalizeMigrationConfig,
  type DuckDbMigrationConfig,
} from './migration-config.ts';

// Concurrent migrate() calls on one database would conflict in DuckDB, so
// calls on the same database file (or the same client) run one after another.
const migrationQueues = new Map<unknown, Promise<unknown>>();

function runSerialized<T>(key: unknown, run: () => Promise<T>): Promise<T> {
  const previous = migrationQueues.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const tail = current.then(
    () => undefined,
    () => undefined
  );
  migrationQueues.set(key, tail);
  void tail.then(() => {
    if (migrationQueues.get(key) === tail) {
      migrationQueues.delete(key);
    }
  });
  return current;
}

export async function migrate<TSchema extends Record<string, unknown>>(
  db: DuckDBDatabase<TSchema>,
  config: DuckDbMigrationConfig
) {
  const migrationConfig = normalizeMigrationConfig(config);
  const migrations = readMigrationFiles(migrationConfig);

  const queueKey =
    (db.$instance && databaseKeyOf(db.$instance)) ?? db.$instance ?? db.$client;

  await runSerialized(queueKey, () =>
    // Cast needed: Drizzle's internal PgSession type differs from exported type
    db.dialect.migrate(
      migrations,
      db.session as unknown as PgSession,
      migrationConfig
    )
  );
}
