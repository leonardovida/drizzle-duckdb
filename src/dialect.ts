import { entityKind, is } from 'drizzle-orm/entity';
import type { MigrationConfig, MigrationMeta } from 'drizzle-orm/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { commonStringChunks, sql, StringChunk, type SQL } from 'drizzle-orm';
import {
  makeDefaultRqbMapper,
  type BuildRelationalQueryResult,
  type RelationalQueryMapperConfig,
} from 'drizzle-orm/relations';
import type { Query } from 'drizzle-orm/sql/sql';

import {
  DuckDBCodecsCollection,
  duckDbCodecs,
  recordParamKinds,
  type ParamKind,
} from './codecs.ts';
import { normalizeMigrationConfig } from './migration-config.ts';
import { transformSQL } from './sql/ast-transformer.ts';
import {
  compileRelationalRowNormalizer,
  compileResultMapper,
  relationColumnName,
  type RelationalSelectionItem,
  type SelectionFieldEntry,
  type ValueCodec,
} from './sql/result-mapper.ts';

const enum SavepointSupport {
  Unknown = 0,
  Yes = 1,
  No = 2,
}

/**
 * Kinds of the params of each query rendered by the dialect, keyed by the
 * Query object, so sessions can tell column params from untyped ones.
 */
const queryParamKinds = new WeakMap<object, ReadonlyMap<number, ParamKind>>();

/** @internal */
export function paramKindsOf(
  query: object
): ReadonlyMap<number, ParamKind> | undefined {
  return queryParamKinds.get(query);
}

/**
 * The selected field of each result column, keyed by the row mappers the
 * dialect generates. Sessions read exact DECIMAL text only for such queries,
 * and turn it back into numbers for fields that are not numeric() columns.
 */
const mapperFields = new WeakMap<object, readonly unknown[]>();

/** @internal */
export function mapperFieldsOf(mapper: object): readonly unknown[] | undefined {
  return mapperFields.get(mapper);
}

const MIGRATION_CONFLICT_MAX_ATTEMPTS = 10;
const MIGRATION_RETRY_BASE_DELAY_MS = 20;
const MIGRATION_RETRY_MAX_DELAY_MS = 1000;

// DuckDB reports optimistic concurrency failures as TransactionContext
// errors, for example "Catalog write-write conflict on create with ..." or
// "Conflict on tuple deletion!".
const TRANSACTION_CONFLICT_PATTERN =
  /write-write conflict|transaction conflict|TransactionContext Error:.*\bconflict\b/i;

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

function isDuplicateKeyIndexError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /contains duplicates on indexed column/i.test(error.message)
  );
}

function isTransactionConflictError(error: unknown): boolean {
  return errorMessages(error).some((message) =>
    TRANSACTION_CONFLICT_PATTERN.test(message)
  );
}

function migrationRetryDelayMs(attempt: number): number {
  const backoff = Math.min(
    MIGRATION_RETRY_MAX_DELAY_MS,
    MIGRATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  );
  // Jitter keeps two retrying migrators from colliding again in lockstep.
  return backoff / 2 + Math.random() * (backoff / 2);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A local migration that is neither recorded in the journal nor newer than
 * the last applied migration. The journal orders migrations by their
 * timestamp, so applying it out of order is not possible and skipping it
 * would leave the database without it.
 */
class MigrationOutOfOrderError extends Error {
  constructor(migration: MigrationMeta, lastAppliedMillis: number) {
    super(
      `Migration ${JSON.stringify(migration.name)} is not newer than the last applied migration (created_at ${lastAppliedMillis}) and is not recorded in the migration journal. migrate() applies migrations in timestamp order, so it cannot apply this one. Rename its folder to a timestamp later than the last applied migration. If this migration was already applied and its file was edited since, restore the original file.`
    );
    this.name = 'MigrationOutOfOrderError';
  }
}

// DuckDB's nextval() parses its string argument as a qualified name and drops
// escaped "" quotes, so the journal sequence cannot be found for such names.
function assertMigrationJournalName(option: string, name: string): void {
  if (name.includes('"')) {
    throw new Error(
      `Invalid ${option} ${JSON.stringify(name)}: migration journal names cannot contain double quotes (").`
    );
  }
}

/**
 * DuckLake has no sequences, primary keys or indexes, so a journal in a
 * DuckLake catalog is a plain table. pg_duckdb and other clients without
 * duckdb_databases() use the regular journal.
 */
type MigrationSession = {
  execute(query: SQL): PromiseLike<unknown>;
  objects<T>(query: SQL): PromiseLike<T[]>;
  transaction<T>(
    callback: (tx: { execute(query: SQL): PromiseLike<unknown> }) => Promise<T>
  ): Promise<T>;
};

async function isDuckLakeCurrentCatalog(
  session: MigrationSession
): Promise<boolean> {
  try {
    const [row] = await session.objects<{ type: string }>(
      sql`select type from duckdb_databases() where database_name = current_database()`
    );
    return row?.type === 'ducklake';
  } catch {
    return false;
  }
}

// drizzle-orm's relational builder loads each relation in a lateral join that
// serializes the related rows with Postgres JSON functions. DuckDB packs the
// row into a struct and list() collects structs, so relations keep their
// native values, such as 64-bit integers past 2^53. drizzle-orm defines these
// chunks privately, so they are matched by their text.
const RELATIONAL_JOIN_ONE =
  ' left join lateral(select row_to_json("t".*) "r" from (';
const RELATIONAL_JOIN_MANY = ` left join lateral(select coalesce(json_agg(row_to_json("t".*)), '[]') as "r" from (`;
const RELATIONAL_JOIN_CLOSE = ') as "t") as ';

// DuckDB rejects parameterized LIMIT/OFFSET in correlated subqueries, which
// is how relational queries load nested relations.
const RELATIONAL_LIMIT_CHUNKS = new Set([' limit ', ' offset ']);

/**
 * Name of the ordinal column of an ordered many relation. The columns of the
 * related row are renamed by position, so no user column can take this name.
 */
const RELATION_ORDINAL = '"ord"';

const UNMATCHED_JOIN_MESSAGE =
  'drizzle-duckdb could not match a relational query join to its relation.';

/** The closing chunk each rewritten join needs, keyed by its opening chunk. */
const relationJoinClosings = new WeakMap<StringChunk, string>();

type CollectRelationalQueryConfig = {
  depth?: number;
  mode?: 'first' | 'many';
  queryConfig?: true | { orderBy?: unknown; comment?: unknown };
};

type CollectRelationalQuery = (
  config: CollectRelationalQueryConfig,
  collectTo: unknown[]
) => readonly RelationalSelectionItem[];

/**
 * The chunks of the ORDER BY of one relation, which drizzle-orm writes after
 * the relation's nested joins and before its LIMIT, OFFSET and comment.
 */
function relationOrderChunks(
  chunks: readonly unknown[],
  start: number,
  config: CollectRelationalQueryConfig
): unknown[] | undefined {
  const params = config.queryConfig === true ? undefined : config.queryConfig;
  if (!params?.orderBy) return undefined;
  let end = chunks.length;
  if (params.comment) end -= 2;
  if (chunks[end - 2] === commonStringChunks[' offset ']) end -= 2;
  if (chunks[end - 2] === commonStringChunks[' limit ']) end -= 2;
  const orderBy = chunks.lastIndexOf(commonStringChunks[' order by '], end - 1);
  if (orderBy < start) return undefined;
  return chunks.slice(orderBy + 1, end);
}

/**
 * Rewrite the lateral join of one nested relation, right after drizzle-orm
 * collected its select. The related row becomes a struct of positional
 * columns. A many relation with an orderBy also numbers its rows in that
 * order and aggregates them in it: DuckDB decorrelates the lateral join into
 * a grouped aggregate, and list() on several threads does not keep the order
 * of the subquery.
 */
function rewriteNestedRelation(
  chunks: unknown[],
  start: number,
  config: CollectRelationalQueryConfig,
  selection: readonly RelationalSelectionItem[]
): void {
  const join = chunks[start - 1];
  if (
    !is(join, StringChunk) ||
    (join.value !== RELATIONAL_JOIN_ONE && join.value !== RELATIONAL_JOIN_MANY)
  ) {
    throw new Error(UNMATCHED_JOIN_MESSAGE);
  }
  const isMany = join.value === RELATIONAL_JOIN_MANY;
  const order = isMany ? relationOrderChunks(chunks, start, config) : undefined;

  const columns = selection.map((_, position) =>
    quoteIdentifier(relationColumnName(position))
  );
  const row = `struct_pack(${columns
    .map((column) => `${column} := "t".${column}`)
    .join(', ')})`;

  let open: string;
  if (!isMany) {
    open = ` left join lateral(select ${row} "r" from (`;
  } else if (order) {
    // The select starts with drizzle-orm's "select " chunk.
    chunks.splice(
      start + 1,
      0,
      new StringChunk('row_number() over (order by '),
      ...order,
      new StringChunk(`) as ${RELATION_ORDINAL}, `)
    );
    columns.unshift(RELATION_ORDINAL);
    open = ` left join lateral(select coalesce(list(${row} order by "t".${RELATION_ORDINAL}), []) as "r" from (`;
  } else {
    open = ` left join lateral(select coalesce(list(${row}), []) as "r" from (`;
  }
  // Shared chunk instances must not be mutated.
  const opening = new StringChunk(open);
  chunks[start - 1] = opening;
  relationJoinClosings.set(opening, `) as "t"(${columns.join(', ')})) as `);
}

/**
 * Close each rewritten join with the positional column names of its row,
 * and inline numeric LIMIT and OFFSET values.
 */
function finishRelationalChunks(chunks: unknown[]): void {
  const closings: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!is(chunk, StringChunk)) continue;
    const closing = relationJoinClosings.get(chunk);
    if (closing !== undefined) {
      closings.push(closing);
      continue;
    }
    if (
      chunk.value === RELATIONAL_JOIN_ONE ||
      chunk.value === RELATIONAL_JOIN_MANY
    ) {
      throw new Error(UNMATCHED_JOIN_MESSAGE);
    }
    if (chunk.value === RELATIONAL_JOIN_CLOSE) {
      const replacement = closings.pop();
      if (replacement === undefined) throw new Error(UNMATCHED_JOIN_MESSAGE);
      chunks[index] = new StringChunk(replacement);
      continue;
    }
    const next = chunks[index + 1];
    if (
      RELATIONAL_LIMIT_CHUNKS.has(chunk.value) &&
      Number.isSafeInteger(next)
    ) {
      chunks[index + 1] = new StringChunk(String(next));
    }
  }
  if (closings.length > 0) throw new Error(UNMATCHED_JOIN_MESSAGE);
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class DuckDBDialect extends PgDialect {
  static readonly [entityKind]: string = 'DuckDBPgDialect';
  // Track savepoint support per-dialect instance to avoid cross-contamination
  // when multiple database connections with different capabilities exist.
  private savepointsSupported: SavepointSupport = SavepointSupport.Unknown;

  constructor(
    private options: {
      qualifyRawJoinColumns?: boolean;
      decimalMode?: 'number' | 'string';
    } = {}
  ) {
    super({ codecs: duckDbCodecs, useJitMappers: false });
    const codecs = new DuckDBCodecsCollection();
    const codecOf = (column: Parameters<typeof codecs.get>[0]) =>
      codecs.get(column, 'normalize') as ValueCodec | undefined;
    const internals = this as unknown as {
      codecs: DuckDBCodecsCollection;
      mapperGenerators: PgDialect['mapperGenerators'];
    };
    internals.codecs = codecs;
    internals.mapperGenerators = {
      // Rows arrive as arrays in selection order. The driver's mapper also
      // turns node-api values into what each column decodes, and assigns
      // keys such as __proto__ as own properties.
      rows: ((fields: readonly SelectionFieldEntry[], nullableObjectPaths) => {
        const mapRow = compileResultMapper(
          fields,
          nullableObjectPaths,
          codecOf
        );
        const mapper = (rows: unknown[][]) => rows.map(mapRow);
        mapperFields.set(
          mapper,
          fields.map(({ field }) => field)
        );
        return mapper;
      }) as PgDialect['mapperGenerators']['rows'],
      relationalRows: ((config: RelationalQueryMapperConfig) => {
        const selection =
          config.selection as unknown as readonly RelationalSelectionItem[];
        const normalize = compileRelationalRowNormalizer(selection);
        const map = makeDefaultRqbMapper(config);
        const mapper = (rows: unknown[][]) => {
          for (const row of rows) normalize(row);
          return map(rows);
        };
        mapperFields.set(
          mapper,
          selection.map((item) => (item.selection ? undefined : item.field))
        );
        return mapper;
      }) as PgDialect['mapperGenerators']['relationalRows'],
    };

    // drizzle-orm collects each nested relation of a relational query in a
    // recursive call of this private method. Wrapping it on the instance lets
    // the dialect rewrite every relation with its own config and selection.
    const collect = (
      PgDialect.prototype as unknown as {
        collectRelationalQuery?: CollectRelationalQuery;
      }
    ).collectRelationalQuery;
    if (typeof collect === 'function') {
      (
        this as unknown as { collectRelationalQuery: CollectRelationalQuery }
      ).collectRelationalQuery = (config, collectTo) => {
        const start = collectTo.length;
        const selection = collect.call(this, config, collectTo);
        if (config.depth) {
          rewriteNestedRelation(collectTo, start, config, selection);
        }
        return selection;
      };
    }
  }

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

  async migrate(
    migrations: MigrationMeta[],
    session: MigrationSession,
    config: MigrationConfig | string
  ): Promise<void> {
    const migrationConfig = normalizeMigrationConfig(config);
    const migrationsSchema = migrationConfig.migrationsSchema ?? 'drizzle';
    const migrationsTableName =
      migrationConfig.migrationsTable ?? '__drizzle_migrations';
    assertMigrationJournalName('migrationsSchema', migrationsSchema);
    assertMigrationJournalName('migrationsTable', migrationsTableName);

    const migrationsSequence = `${migrationsTableName}_id_seq`;
    const legacySequence = 'migrations_pk_seq';

    // nextval() takes the qualified name as a string literal. Names never
    // contain double quotes (see assertMigrationJournalName).
    const sequenceLiteral =
      `"${migrationsSchema}"."${migrationsSequence}"`.replace(/'/g, "''");
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

    const isDuckLake = await isDuckLakeCurrentCatalog(session);

    const setupJournal = async () => {
      await session.execute(
        sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`
      );
      if (isDuckLake) {
        await session.execute(sql`
          CREATE TABLE IF NOT EXISTS ${migrationTable} (
            id integer NOT NULL,
            hash text NOT NULL,
            created_at bigint
          )
        `);
        return;
      }
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
      // Journals written before this index existed can already hold such
      // duplicates. They still migrate correctly, just without the guard.
      try {
        await session.execute(
          sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.identifier(
            `${migrationsTableName}_created_at_unique`
          )} ON ${migrationTable} (created_at)`
        );
      } catch (error) {
        if (!isDuplicateKeyIndexError(error)) {
          throw error;
        }
      }
    };

    const latestMigrationQuery = sql`select hash, created_at from ${migrationTable} order by created_at desc limit 1`;
    const appliedHashesQuery = sql`select distinct hash from ${migrationTable}`;

    const applyPendingMigrations = () =>
      session.transaction(async (tx) => {
        // Read the journal inside the transaction on every attempt, so a
        // retry skips migrations another migrator committed meanwhile.
        const dbMigrations = (await tx.execute(latestMigrationQuery)) as {
          hash: string;
          created_at: string;
        }[];
        const lastDbMigration = dbMigrations[0];
        let lastAppliedMillis =
          lastDbMigration === undefined
            ? undefined
            : Number(lastDbMigration.created_at);
        const appliedHashes = new Set(
          ((await tx.execute(appliedHashesQuery)) as { hash: string }[]).map(
            (row) => row.hash
          )
        );

        for (const migration of migrations) {
          if (
            lastAppliedMillis === undefined ||
            lastAppliedMillis < migration.folderMillis
          ) {
            for (const stmt of migration.sql) {
              await tx.execute(sql.raw(stmt));
            }

            await tx.execute(
              isDuckLake
                ? sql`insert into ${migrationTable} ("id", "hash", "created_at") select coalesce(max("id"), 0) + 1, ${migration.hash}, ${migration.folderMillis} from ${migrationTable}`
                : sql`insert into ${migrationTable} ("hash", "created_at") values(${migration.hash}, ${
                    migration.folderMillis
                  })`
            );
            lastAppliedMillis = migration.folderMillis;
            appliedHashes.add(migration.hash);
          } else if (!appliedHashes.has(migration.hash)) {
            throw new MigrationOutOfOrderError(migration, lastAppliedMillis);
          }
        }
      });

    const isLatestMigrationApplied = async (): Promise<boolean> => {
      const latestMigration = migrations.at(-1);
      if (!latestMigration) {
        return false;
      }
      try {
        const [applied] = await session.objects<{
          hash: string;
          created_at: string;
        }>(latestMigrationQuery);
        return (
          applied?.hash === latestMigration.hash &&
          Number(applied.created_at) === latestMigration.folderMillis
        );
      } catch {
        // The journal table may not exist yet when setup failed.
        return false;
      }
    };

    // DuckDB uses optimistic concurrency. A concurrent migrator on the same
    // database makes schema creation or migration DDL fail with a
    // write-write conflict, so retry the whole run with backoff.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await setupJournal();
        await applyPendingMigrations();
        return;
      } catch (error) {
        if (error instanceof MigrationOutOfOrderError) throw error;
        // Another migrator may have committed while this run failed.
        if (await isLatestMigrationApplied()) {
          return;
        }
        if (
          attempt >= MIGRATION_CONFLICT_MAX_ATTEMPTS ||
          !isTransactionConflictError(error)
        ) {
          throw error;
        }
        await delay(migrationRetryDelayMs(attempt));
      }
    }
  }

  override buildRelationalQuery(
    config: Parameters<PgDialect['buildRelationalQuery']>[0]
  ): BuildRelationalQueryResult {
    const result = super.buildRelationalQuery(config);
    finishRelationalChunks(result.sql.queryChunks);
    return result;
  }

  override sqlToQuery(
    sqlObj: SQL,
    invokeSource?: Parameters<PgDialect['sqlToQuery']>[1]
  ): Query {
    // Let the parent render the SQL, noting which params bind to columns.
    const { result, kinds } = recordParamKinds(() =>
      super.sqlToQuery(sqlObj, invokeSource)
    );

    // Apply AST-based transformations for DuckDB compatibility
    const transformed = transformSQL(result.sql, {
      qualifyJoinColumns: this.options.qualifyRawJoinColumns === true,
    });

    const query = {
      ...result,
      sql: transformed.sql,
    };
    if (kinds.size > 0) queryParamKinds.set(query, kinds);
    return query;
  }
}
