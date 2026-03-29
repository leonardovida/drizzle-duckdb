import type { MigrationConfig } from 'drizzle-orm/migrator';

export type DuckDbMigrationConfig = MigrationConfig | string;

export function normalizeMigrationConfig(
  config: DuckDbMigrationConfig
): MigrationConfig {
  return typeof config === 'string' ? { migrationsFolder: config } : config;
}
