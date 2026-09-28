import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { DuckDBDatabase } from './driver.ts';
import type { PgSession } from 'drizzle-orm/pg-core/session';
import {
  normalizeMigrationConfig,
  type DuckDbMigrationConfig,
} from './migration-config.ts';

// Concurrent migrate() calls on one database would conflict in DuckDB, so
// calls that share an instance (or a client) run one after another.
const migrationQueues = new WeakMap<object, Promise<unknown>>();

function runSerialized<T>(key: object, run: () => Promise<T>): Promise<T> {
  const previous = migrationQueues.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  migrationQueues.set(
    key,
    current.catch(() => undefined)
  );
  return current;
}

export async function migrate<TSchema extends Record<string, unknown>>(
  db: DuckDBDatabase<TSchema>,
  config: DuckDbMigrationConfig
) {
  const migrationConfig = normalizeMigrationConfig(config);
  const migrations = readMigrationFiles(migrationConfig);

  await runSerialized(db.$instance ?? db.$client, () =>
    // Cast needed: Drizzle's internal PgSession type differs from exported type
    db.dialect.migrate(
      migrations,
      db.session as unknown as PgSession,
      migrationConfig
    )
  );
}
