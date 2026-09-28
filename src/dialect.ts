import { entityKind, is } from 'drizzle-orm/entity';
import type { MigrationConfig, MigrationMeta } from 'drizzle-orm/migrator';
import {
  PgArray,
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
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';
import {
  Column,
  sql,
  SQL,
  Subquery,
  type DriverValueEncoder,
  type QueryTypingsValue,
} from 'drizzle-orm';
import type { BuildRelationalQueryResult } from 'drizzle-orm/relations';
import {
  StringChunk,
  type QueryWithTypings,
  type SQLChunk,
} from 'drizzle-orm/sql/sql';

import { normalizeMigrationConfig } from './migration-config.ts';
import { transformSQL } from './sql/ast-transformer.ts';

const enum SavepointSupport {
  Unknown = 0,
  Yes = 1,
  No = 2,
}

const PG_JSON_UNSUPPORTED_MESSAGE =
  "Pg JSON/JSONB columns are not supported in DuckDB. Replace them with duckDbJson() to use DuckDB's native JSON type.";

/**
 * Query typing for params bound to a non-array column. DuckDB sessions never
 * coerce these params from Postgres array literal strings.
 * @internal
 */
export const DUCKDB_SCALAR_COLUMN_TYPING =
  'duckdb:scalar' as unknown as QueryTypingsValue;

// Drizzle's relational builder emits Postgres JSON functions. DuckDB names
// them differently, so rewrite the exact template chunks it produces.
// json_group_array is a macro and rejects ORDER BY, so aggregate with list().
const RELATIONAL_JSON_CHUNKS = new Map([
  ['json_build_array(', 'json_array('],
  ['coalesce(json_agg(', 'coalesce(to_json(list('],
  ["), '[]'::json)", ")), '[]'::json)"],
]);

// DuckDB rejects parameterized LIMIT/OFFSET in correlated subqueries, which
// is how relational queries load nested relations.
const RELATIONAL_LIMIT_CHUNKS = new Set([' limit ', ' offset ']);

function rewriteRelationalJsonChunks(chunks: SQLChunk[]): void {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (is(chunk, StringChunk)) {
      const value = chunk.value.length === 1 ? chunk.value[0] : undefined;
      const replacement =
        value === undefined ? undefined : RELATIONAL_JSON_CHUNKS.get(value);
      const next = chunks[index + 1] as unknown;
      if (replacement) {
        chunks[index] = new StringChunk(replacement);
      } else if (
        value !== undefined &&
        RELATIONAL_LIMIT_CHUNKS.has(value) &&
        Number.isSafeInteger(next)
      ) {
        chunks[index + 1] = new StringChunk(String(next));
      }
    } else if (Array.isArray(chunk)) {
      rewriteRelationalJsonChunks(chunk);
    } else if (is(chunk, SQL)) {
      rewriteRelationalJsonChunks(chunk.queryChunks);
    } else if (is(chunk, SQL.Aliased)) {
      rewriteRelationalJsonChunks(chunk.sql.queryChunks);
    } else if (is(chunk, Subquery)) {
      rewriteRelationalJsonChunks((chunk._.sql as SQL).queryChunks);
    }
  }
}

export class DuckDBDialect extends PgDialect {
  static readonly [entityKind]: string = 'DuckDBPgDialect';
  // Track savepoint support per-dialect instance to avoid cross-contamination
  // when multiple database connections with different capabilities exist.
  private savepointsSupported: SavepointSupport = SavepointSupport.Unknown;

  /**
   * @deprecated Pg JSON/JSONB params now throw while the query is built. This
   * method is a no-op and will be removed in the next major version.
   */
  resetPgJsonFlag(): void {}

  /**
   * @deprecated Pg JSON/JSONB params now throw while the query is built. This
   * method is a no-op and will be removed in the next major version.
   */
  markPgJsonDetected(): void {}

  /**
   * @deprecated Pg JSON/JSONB params now throw while the query is built. This
   * method is a no-op and will be removed in the next major version.
   */
  assertNoPgJsonColumns(): void {}

  // Drizzle passes escapeName unbound, so it must not use `this`. drizzle-orm
  // before 0.45.2 did not escape embedded quotes (GHSA-gpj5-g38j-94v9).
  override escapeName(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
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
    const migrationsTableName =
      migrationConfig.migrationsTable ?? '__drizzle_migrations';
    const migrationsSequence = `${migrationsTableName}_id_seq`;
    const legacySequence = 'migrations_pk_seq';

    const escapeIdentifier = (value: string) => value.replace(/"/g, '""');
    // nextval() takes the qualified name as a string literal.
    const sequenceLiteral = `"${escapeIdentifier(
      migrationsSchema
    )}"."${escapeIdentifier(migrationsSequence)}"`.replace(/'/g, "''");
    const migrationTable = sql`${sql.identifier(
      migrationsSchema
    )}.${sql.identifier(migrationsTableName)}`;

    const migrationTableCreate = sql`
      CREATE TABLE IF NOT EXISTS ${migrationTable} (
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

    // Concurrent migrators must not commit the same migration twice.
    await session.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.identifier(
        `${migrationsTableName}_created_at_unique`
      )} ON ${migrationTable} (created_at)`
    );

    const latestMigrationQuery = sql`select hash, created_at from ${migrationTable} order by created_at desc limit 1`;

    try {
      await session.transaction(async (tx) => {
        const dbMigrations = (await tx.execute(latestMigrationQuery)) as {
          hash: string;
          created_at: string;
        }[];
        const lastDbMigration = dbMigrations[0];

        for (const migration of migrations) {
          if (
            !lastDbMigration ||
            Number(lastDbMigration.created_at) < migration.folderMillis
          ) {
            for (const stmt of migration.sql) {
              await tx.execute(sql.raw(stmt));
            }

            await tx.execute(
              sql`insert into ${migrationTable} ("hash", "created_at") values(${migration.hash}, ${
                migration.folderMillis
              })`
            );
          }
        }
      });
    } catch (error) {
      // Another migrator may have committed while this transaction ran.
      const latestMigration = migrations.at(-1);
      if (latestMigration) {
        const [applied] = await session.all<{
          hash: string;
          created_at: string;
        }>(latestMigrationQuery);
        if (
          applied?.hash === latestMigration.hash &&
          Number(applied.created_at) === latestMigration.folderMillis
        ) {
          return;
        }
      }
      throw error;
    }
  }

  // Drizzle passes prepareTyping unbound, so it must not use `this`.
  override prepareTyping(
    encoder: DriverValueEncoder<unknown, unknown>
  ): QueryTypingsValue {
    if (is(encoder, PgJsonb) || is(encoder, PgJson)) {
      throw new Error(PG_JSON_UNSUPPORTED_MESSAGE);
    } else if (is(encoder, PgArray)) {
      return 'none';
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
    } else if (is(encoder, Column)) {
      return DUCKDB_SCALAR_COLUMN_TYPING;
    } else {
      return 'none';
    }
  }

  override buildRelationalQueryWithoutPK(
    config: Parameters<PgDialect['buildRelationalQueryWithoutPK']>[0]
  ): BuildRelationalQueryResult<PgTable, PgColumn> {
    const result = super.buildRelationalQueryWithoutPK(config);
    // Nested relations recurse through this method; rewrite once at the root.
    if (!config.nestedQueryRelation && is(result.sql, SQL)) {
      rewriteRelationalJsonChunks(result.sql.queryChunks);
    }
    return result;
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
