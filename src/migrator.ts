import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { DuckDBDatabase } from './driver.ts';
import type { PgSession } from 'drizzle-orm/pg-core/session';
import {
  normalizeMigrationConfig,
  type DuckDbMigrationConfig,
} from './migration-config.ts';

export async function migrate<TSchema extends Record<string, unknown>>(
  db: DuckDBDatabase<TSchema>,
  config: DuckDbMigrationConfig
) {
  const migrationConfig = normalizeMigrationConfig(config);
  const migrations = readMigrationFiles(migrationConfig);

  // Cast needed: Drizzle's internal PgSession type differs from exported type
  await db.dialect.migrate(
    migrations,
    db.session as unknown as PgSession,
    migrationConfig
  );
}
