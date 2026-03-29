import { entityKind, is } from 'drizzle-orm/entity';
import type { MigrationConfig, MigrationMeta } from 'drizzle-orm/migrator';
import {
  PgDate,
  PgDateString,
  PgDialect,
  PgJson,
  PgJsonb,
  PgNumeric,
  PgSession,
  PgTime,
  PgTimestamp,
  PgTimestampString,
  PgUUID,
} from 'drizzle-orm/pg-core';
import {
  sql,
  SQL,
  type DriverValueEncoder,
  type QueryTypingsValue,
} from 'drizzle-orm';
import type { QueryWithTypings } from 'drizzle-orm/sql/sql';

import { normalizeMigrationConfig } from './migration-config.ts';
import { transformSQL } from './sql/ast-transformer.ts';

const enum SavepointSupport {
  Unknown = 0,
  Yes = 1,
  No = 2,
}

export class DuckDBDialect extends PgDialect {
  static readonly [entityKind]: string = 'DuckDBPgDialect';
  // Track if PG JSON columns were detected during the current query preparation.
  // Reset before each query via DuckDBSession to keep detection per-query.
  private hasPgJsonColumn = false;
  // Track savepoint support per-dialect instance to avoid cross-contamination
  // when multiple database connections with different capabilities exist.
  private savepointsSupported: SavepointSupport = SavepointSupport.Unknown;

  /**
   * Reset the PG JSON detection flag. Should be called before preparing a new query.
   */
  resetPgJsonFlag(): void {
    this.hasPgJsonColumn = false;
  }

  /**
   * Mark that a PG JSON/JSONB column was detected during query preparation.
   */
  markPgJsonDetected(): void {
    this.hasPgJsonColumn = true;
  }

  assertNoPgJsonColumns(): void {
    if (this.hasPgJsonColumn) {
      throw new Error(
        "Pg JSON/JSONB columns are not supported in DuckDB. Replace them with duckDbJson() to use DuckDB's native JSON type."
      );
    }
  }

  /**
   * Check if savepoints are known to be unsupported for this dialect instance.
   */
  areSavepointsUnsupported(): boolean {
    return this.savepointsSupported === SavepointSupport.No;
  }

  /**
   * Mark that savepoints are supported for this dialect instance.
   */
  markSavepointsSupported(): void {
    this.savepointsSupported = SavepointSupport.Yes;
  }

  /**
   * Mark that savepoints are not supported for this dialect instance.
   */
  markSavepointsUnsupported(): void {
    this.savepointsSupported = SavepointSupport.No;
  }

  override async migrate(
    migrations: MigrationMeta[],
    session: PgSession,
    config: MigrationConfig | string
  ): Promise<void> {
    const migrationConfig = normalizeMigrationConfig(config);
    const migrationsSchema = migrationConfig.migrationsSchema ?? 'drizzle';
    const migrationsTable =
      migrationConfig.migrationsTable ?? '__drizzle_migrations';
    const migrationsSequence = `${migrationsTable}_id_seq`;
    const legacySequence = 'migrations_pk_seq';

    const escapeIdentifier = (value: string) => value.replace(/"/g, '""');
    const sequenceLiteral = `"${escapeIdentifier(
      migrationsSchema
    )}"."${escapeIdentifier(migrationsSequence)}"`;

    const migrationTableCreate = sql`
      CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsSchema)}.${sql.identifier(
        migrationsTable
      )} (
        id integer PRIMARY KEY default nextval('${sql.raw(sequenceLiteral)}'),
        hash text NOT NULL,
        created_at bigint
      )
    `;

    await session.execute(
      sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`
    );
    await session.execute(
      sql`CREATE SEQUENCE IF NOT EXISTS ${sql.identifier(
        migrationsSchema
      )}.${sql.identifier(migrationsSequence)}`
    );
    if (legacySequence !== migrationsSequence) {
      await session.execute(
        sql`CREATE SEQUENCE IF NOT EXISTS ${sql.identifier(
          migrationsSchema
        )}.${sql.identifier(legacySequence)}`
      );
    }
    await session.execute(migrationTableCreate);

    const dbMigrations = await session.all<{
      id: number;
      hash: string;
      created_at: string;
    }>(
      sql`select id, hash, created_at from ${sql.identifier(
        migrationsSchema
      )}.${sql.identifier(migrationsTable)} order by created_at desc limit 1`
    );

    const lastDbMigration = dbMigrations[0];

    await session.transaction(async (tx) => {
      for await (const migration of migrations) {
        if (
          !lastDbMigration ||
          Number(lastDbMigration.created_at) < migration.folderMillis
        ) {
          for (const stmt of migration.sql) {
            await tx.execute(sql.raw(stmt));
          }

          await tx.execute(
            sql`insert into ${sql.identifier(
              migrationsSchema
            )}.${sql.identifier(
              migrationsTable
            )} ("hash", "created_at") values(${migration.hash}, ${
              migration.folderMillis
            })`
          );
        }
      }
    });
  }

  override prepareTyping(
    encoder: DriverValueEncoder<unknown, unknown>
  ): QueryTypingsValue {
    if (is(encoder, PgJsonb) || is(encoder, PgJson)) {
      this.markPgJsonDetected();
      throw new Error(
        "Pg JSON/JSONB columns are not supported in DuckDB. Replace them with duckDbJson() to use DuckDB's native JSON type."
      );
    } else if (is(encoder, PgNumeric)) {
      return 'decimal';
    } else if (is(encoder, PgTime)) {
      return 'time';
    } else if (is(encoder, PgTimestamp) || is(encoder, PgTimestampString)) {
      return 'timestamp';
    } else if (is(encoder, PgDate) || is(encoder, PgDateString)) {
      return 'date';
    } else if (is(encoder, PgUUID)) {
      return 'uuid';
    } else {
      return 'none';
    }
  }

  override sqlToQuery(
    sqlObj: SQL,
    invokeSource?: 'indexes' | undefined
  ): QueryWithTypings {
    // First, let the parent generate the SQL string
    const result = super.sqlToQuery(sqlObj, invokeSource);

    // Apply AST-based transformations for DuckDB compatibility
    const transformed = transformSQL(result.sql);

    return {
      ...result,
      sql: transformed.sql,
    };
  }
}
