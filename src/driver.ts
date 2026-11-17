import { DuckDBInstance } from '@duckdb/node-api';
import { entityKind } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { DefaultLogger } from 'drizzle-orm/logger';
import { PgAsyncDatabase } from 'drizzle-orm/pg-core/async/db';
import type { PgAsyncSelectBuilder } from 'drizzle-orm/pg-core/async/select';
import type { SelectedFields } from 'drizzle-orm/pg-core/query-builders/select.types';
import type {
  PgColumn,
  PgTable,
  PgTransactionConfig,
} from 'drizzle-orm/pg-core';
import type { AnyRelations, EmptyRelations } from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { SQL, SQLWrapper } from 'drizzle-orm/sql/sql';
import type { InferInsertModel } from 'drizzle-orm/table';
import type { WithSubquery } from 'drizzle-orm/subquery';
import type {
  DuckDBClientLike,
  DuckDBQueryResultHKT,
  DuckDBTransaction,
} from './session.ts';
import { DuckDBSession } from './session.ts';
import { DuckDBDialect } from './dialect.ts';
import { rememberDatabaseKey } from './instance-keys.ts';
import { createPgDuckConnectionPool, type PgDuckPool } from './pgduck.ts';
import {
  createDuckDBSelectMethods,
  DuckDBQueryBuilder,
  type DuckDBSelectBuilder,
} from './select-builder.ts';
import type {
  DateParamType,
  ExecuteBatchesRawChunk,
  ExecuteInBatchesOptions,
  RowData,
} from './client.ts';
import {
  closeClientConnection,
  closeDuckDbInstance,
  isPool,
} from './client.ts';
import {
  createDuckDBConnectionPool,
  type DuckDBPoolConfig,
  type PoolPreset,
} from './pool.ts';
import {
  configureDuckLake,
  createDuckLakeConnectionSetup,
  resolveDuckLakePoolSize,
  wrapDuckLakePool,
  type DuckLakeConfig,
} from './ducklake.ts';

export interface PgDriverOptions {
  decimalMode?: 'number' | 'string';
  dateParams?: DateParamType;
  logger?: Logger;
  rejectStringArrayLiterals?: boolean;
  arrayLiteralWarning?: (query: string) => void;
}

export class DuckDBDriver {
  static readonly [entityKind]: string = 'DuckDBDriver';

  constructor(
    private client: DuckDBClientLike,
    private dialect: DuckDBDialect,
    private options: PgDriverOptions = {}
  ) {}

  createSession<TRelations extends AnyRelations = EmptyRelations>(
    relations: TRelations
  ): DuckDBSession<TRelations> {
    return new DuckDBSession(this.client, this.dialect, relations, {
      logger: this.options.logger,
      rejectStringArrayLiterals: this.options.rejectStringArrayLiterals,
      arrayLiteralWarning: this.options.arrayLiteralWarning,
      decimalMode: this.options.decimalMode,
      dateParams: this.options.dateParams,
    });
  }
}

/** Connection configuration when using path-based connection */
export interface DuckDBConnectionConfig {
  /** Database path: ':memory:', './file.duckdb', 'md:', 'md:database' */
  path: string;
  /** DuckDB instance options (e.g., motherduck_token) */
  options?: Record<string, string>;
}

export interface DuckDBDrizzleConfig<
  TRelations extends AnyRelations = EmptyRelations,
> extends Pick<DrizzleConfig<TRelations>, 'logger' | 'relations'> {
  rejectStringArrayLiterals?: boolean;
  arrayLiteralWarning?: (query: string) => void;
  /** Opt into legacy heuristic qualification of raw SQL join operands. */
  qualifyRawJoinColumns?: boolean;
  /** Opt into exact DECIMAL strings across execution paths. */
  decimalMode?: 'number' | 'string';
  /**
   * How a bare `Date` parameter binds, as in sql`${new Date()}`. The default
   * 'timestamp' binds its UTC wall time as a naive TIMESTAMP, which DuckDB
   * reads in the session TimeZone when it compares it with a TIMESTAMPTZ.
   * 'timestamptz' binds the instant instead. Typed columns are not affected.
   */
  dateParams?: DateParamType;
  /** Pool configuration. Use preset name, size config, or false to disable. */
  pool?: DuckDBPoolConfig | PoolPreset | false;
  /** Optional DuckLake configuration */
  ducklake?: DuckLakeConfig;
}

export interface DuckDBDrizzleConfigWithConnection<
  TRelations extends AnyRelations = EmptyRelations,
> extends DuckDBDrizzleConfig<TRelations> {
  /** Connection string or config object */
  connection: string | DuckDBConnectionConfig;
}

export interface DuckDBDrizzleConfigWithClient<
  TRelations extends AnyRelations = EmptyRelations,
> extends DuckDBDrizzleConfig<TRelations> {
  /** Explicit client (connection or pool) */
  client: DuckDBClientLike;
}

/** Check if a value looks like a config object (not a client) */
function isConfigObject(data: unknown): data is Record<string, unknown> {
  if (typeof data !== 'object' || data === null) return false;
  if (data.constructor?.name !== 'Object') return false;
  return (
    'connection' in data ||
    'client' in data ||
    'pool' in data ||
    'relations' in data ||
    'schema' in data ||
    'logger' in data
  );
}

/**
 * drizzle-orm 1.0 removed the `schema` and `casing` options of Postgres
 * drivers. Passing them would otherwise be ignored without notice.
 */
function assertNoRemovedOptions(config: object): void {
  if ('schema' in config && config.schema !== undefined) {
    throw new Error(
      'The schema option was removed in 3.0 with drizzle-orm 1.0. Pass relations built with defineRelations() as the relations option, and use db.query with the drizzle-orm 1.0 relational query syntax.'
    );
  }
  if ('casing' in config && config.casing !== undefined) {
    throw new Error(
      'The casing option was removed in 3.0 with drizzle-orm 1.0. Set the casing on the table definitions instead, for example with pgTableCreator() from drizzle-orm/pg-core.'
    );
  }
}

interface ResolvedConnectionTarget<
  TRelations extends AnyRelations = EmptyRelations,
> {
  kind: 'connection';
  path: string;
  instanceOptions: Record<string, string> | undefined;
  config: DuckDBDrizzleConfig<TRelations>;
}

interface ResolvedClientTarget<
  TRelations extends AnyRelations = EmptyRelations,
> {
  kind: 'client';
  client: DuckDBClientLike;
  config: DuckDBDrizzleConfig<TRelations>;
}

type ResolvedDrizzleTarget<TRelations extends AnyRelations = EmptyRelations> =
  | ResolvedConnectionTarget<TRelations>
  | ResolvedClientTarget<TRelations>;

function resolveConnectionTarget(
  connection: string | DuckDBConnectionConfig
): Omit<ResolvedConnectionTarget, 'config' | 'kind'> {
  if (typeof connection === 'string') {
    return {
      path: connection,
      instanceOptions: undefined,
    };
  }

  return {
    path: connection.path,
    instanceOptions: connection.options,
  };
}

function resolveDrizzleTarget<TRelations extends AnyRelations = EmptyRelations>(
  clientOrConfigOrPath:
    | string
    | DuckDBClientLike
    | DuckDBDrizzleConfigWithConnection<TRelations>
    | DuckDBDrizzleConfigWithClient<TRelations>,
  config: DuckDBDrizzleConfig<TRelations> = {}
): ResolvedDrizzleTarget<TRelations> {
  assertNoRemovedOptions(config);
  if (typeof clientOrConfigOrPath === 'string') {
    return {
      kind: 'connection',
      ...resolveConnectionTarget(clientOrConfigOrPath),
      config,
    };
  }

  if (isConfigObject(clientOrConfigOrPath)) {
    assertNoRemovedOptions(clientOrConfigOrPath);
    if ('connection' in clientOrConfigOrPath) {
      const { connection, ...restConfig } = clientOrConfigOrPath;

      return {
        kind: 'connection',
        ...resolveConnectionTarget(
          connection as DuckDBDrizzleConfigWithConnection<TRelations>['connection']
        ),
        config: restConfig as DuckDBDrizzleConfig<TRelations>,
      };
    }

    if ('client' in clientOrConfigOrPath) {
      const { client, ...restConfig } = clientOrConfigOrPath;

      return {
        kind: 'client',
        client: client as DuckDBClientLike,
        config: restConfig as DuckDBDrizzleConfig<TRelations>,
      };
    }

    throw new Error(
      'Invalid drizzle config: either connection or client must be provided'
    );
  }

  return {
    kind: 'client',
    client: clientOrConfigOrPath as DuckDBClientLike,
    config,
  };
}

/**
 * True for a node-postgres `Pool`. A `pg.Client` also has `connect()` and
 * `query()`, so the pool is recognized by its connection counters.
 */
function isNodePostgresPool(value: unknown): value is PgDuckPool {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.connect === 'function' &&
    typeof candidate.query === 'function' &&
    typeof candidate.acquire !== 'function' &&
    typeof candidate.totalCount === 'number' &&
    typeof candidate.idleCount === 'number'
  );
}

/** Internal: create database from a client (connection or pool) */
function createFromClient<TRelations extends AnyRelations = EmptyRelations>(
  client: DuckDBClientLike,
  config: DuckDBDrizzleConfig<TRelations> = {},
  instance?: DuckDBInstance
): DuckDBDatabase<TRelations> {
  // pool.query() runs each statement on any free client, so BEGIN, the
  // statements and COMMIT of one transaction would land on different
  // backends. Lease one client per operation instead.
  let finalClient: DuckDBClientLike = isNodePostgresPool(client)
    ? createPgDuckConnectionPool(client)
    : client;

  if (config.ducklake) {
    if (isPool(finalClient)) {
      finalClient = wrapDuckLakePool(finalClient, config.ducklake);
    } else {
      throw new Error(
        'DuckLake configuration requires a connection string or pool. Use drizzle("path", { ducklake: ... }) or call configureDuckLake(connection, config) manually.'
      );
    }
  }

  const dialect = new DuckDBDialect({
    qualifyRawJoinColumns: config.qualifyRawJoinColumns,
    decimalMode: config.decimalMode,
  });

  const logger =
    config.logger === true ? new DefaultLogger() : config.logger || undefined;

  const relations = (config.relations ?? {}) as TRelations;

  const driver = new DuckDBDriver(finalClient, dialect, {
    logger,
    rejectStringArrayLiterals: config.rejectStringArrayLiterals,
    arrayLiteralWarning: config.arrayLiteralWarning,
    decimalMode: config.decimalMode,
    dateParams: config.dateParams,
  });
  const session = driver.createSession(relations);

  return new DuckDBDatabase<TRelations>(
    dialect,
    session,
    relations,
    finalClient,
    instance
  );
}

function resolvePoolOptions(
  pool: DuckDBPoolConfig | PoolPreset | false | undefined
): DuckDBPoolConfig | undefined {
  if (!pool || typeof pool !== 'object') {
    return undefined;
  }

  return pool;
}

async function closeDatabaseClient(client: DuckDBClientLike): Promise<void> {
  if (isPool(client)) {
    await client.close?.();
    return;
  }

  await closeClientConnection(client);
}

/** Internal: create database from a connection string */
async function createFromConnectionString<
  TRelations extends AnyRelations = EmptyRelations,
>(
  path: string,
  instanceOptions: Record<string, string> | undefined,
  config: DuckDBDrizzleConfig<TRelations> = {}
): Promise<DuckDBDatabase<TRelations>> {
  // Share one instance per database path in this process. Two instances on
  // the same file do not see each other's writes and can lose committed data.
  // ':memory:' still gets a new database each time.
  const instance = await DuckDBInstance.fromCache(path, instanceOptions);
  rememberDatabaseKey(instance, path);
  let createdClient: DuckDBClientLike | undefined;

  try {
    const { ducklake: ducklakeConfig, ...restConfig } = config;
    const poolOptions = resolvePoolOptions(config.pool);
    const { poolSize, isLocalCatalog } = resolveDuckLakePoolSize(
      config.pool,
      ducklakeConfig
    );

    if (
      ducklakeConfig &&
      typeof poolSize === 'number' &&
      poolSize > 1 &&
      isLocalCatalog
    ) {
      console.warn(
        '[ducklake] DuckDB catalog files support a single client connection. Pool sizes greater than 1 can cause write conflicts.'
      );
    }

    if (poolSize === false) {
      const connection = await instance.connect();
      createdClient = connection;
      if (ducklakeConfig) {
        await configureDuckLake(connection, ducklakeConfig);
      }
    } else {
      createdClient = createDuckDBConnectionPool(instance, {
        ...poolOptions,
        size: poolSize,
        setup: ducklakeConfig
          ? createDuckLakeConnectionSetup(ducklakeConfig)
          : undefined,
      });
    }

    const db = createFromClient(
      createdClient,
      restConfig as DuckDBDrizzleConfig<TRelations>,
      instance
    );
    createdClient = undefined;
    return db;
  } catch (error) {
    if (createdClient) {
      await closeDatabaseClient(createdClient);
    }
    await closeDuckDbInstance(instance);
    throw error;
  }
}

// Overload 1: Connection string (async, auto-pools)
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  connectionString: string
): Promise<DuckDBDatabase<TRelations>>;

// Overload 2: Connection string + config (async, auto-pools)
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  connectionString: string,
  config: DuckDBDrizzleConfig<TRelations>
): Promise<DuckDBDatabase<TRelations>>;

// Overload 3: Config with connection (async, auto-pools)
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  config: DuckDBDrizzleConfigWithConnection<TRelations>
): Promise<DuckDBDatabase<TRelations>>;

// Overload 4: Config with explicit client (sync)
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  config: DuckDBDrizzleConfigWithClient<TRelations>
): DuckDBDatabase<TRelations>;

// Overload 5: Explicit client (sync, backward compatible)
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  client: DuckDBClientLike,
  config?: DuckDBDrizzleConfig<TRelations>
): DuckDBDatabase<TRelations>;

// Implementation
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  clientOrConfigOrPath:
    | string
    | DuckDBClientLike
    | DuckDBDrizzleConfigWithConnection<TRelations>
    | DuckDBDrizzleConfigWithClient<TRelations>,
  config?: DuckDBDrizzleConfig<TRelations>
): DuckDBDatabase<TRelations> | Promise<DuckDBDatabase<TRelations>> {
  const target = resolveDrizzleTarget(clientOrConfigOrPath, config);

  if (target.kind === 'connection') {
    return createFromConnectionString(
      target.path,
      target.instanceOptions,
      target.config
    );
  }

  return createFromClient(target.client, target.config);
}

export class DuckDBDatabase<
  TRelations extends AnyRelations = EmptyRelations,
> extends PgAsyncDatabase<DuckDBQueryResultHKT, TRelations> {
  static override readonly [entityKind]: string = 'DuckDBDatabase';

  /** The underlying connection or pool */
  readonly $client: DuckDBClientLike;

  /** The DuckDB instance (when created from connection string) */
  readonly $instance?: DuckDBInstance;

  constructor(
    readonly dialect: DuckDBDialect,
    readonly session: DuckDBSession<TRelations>,
    relations: TRelations,
    client: DuckDBClientLike,
    instance?: DuckDBInstance
  ) {
    // Relations arrive as native DuckDB values, so they are not JSON text.
    super(dialect, session, relations, false);
    this.$client = client;
    this.$instance = instance;
    this.$with = new DuckDBQueryBuilder(dialect).$with;
  }

  /**
   * Close the database connection pool and instance.
   * Should be called when shutting down the application.
   */
  async close(): Promise<void> {
    let firstError: unknown;

    try {
      await closeDatabaseClient(this.$client);
    } catch (error) {
      firstError = error;
    }

    try {
      if (this.$instance) {
        await closeDuckDbInstance(this.$instance);
      }
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }

    if (firstError) {
      throw firstError;
    }
  }

  private selectMethods(withList?: WithSubquery[]) {
    return createDuckDBSelectMethods(this.session, this.dialect, withList);
  }

  override with(
    ...queries: WithSubquery[]
  ): ReturnType<PgAsyncDatabase<DuckDBQueryResultHKT, TRelations>['with']> {
    return {
      ...super.with(...queries),
      ...this.selectMethods(queries),
    } as unknown as ReturnType<
      PgAsyncDatabase<DuckDBQueryResultHKT, TRelations>['with']
    >;
  }

  override select(): DuckDBSelectBuilder<undefined>;
  override select<TSelection extends SelectedFields>(
    fields: TSelection
  ): DuckDBSelectBuilder<TSelection>;
  override select(
    fields?: SelectedFields
  ): DuckDBSelectBuilder<SelectedFields | undefined> {
    return this.selectMethods().select(fields);
  }

  override selectDistinct(): PgAsyncSelectBuilder<undefined>;
  override selectDistinct<TSelection extends SelectedFields>(
    fields: TSelection
  ): PgAsyncSelectBuilder<TSelection>;
  override selectDistinct(
    fields?: SelectedFields
  ): PgAsyncSelectBuilder<SelectedFields | undefined> {
    return this.selectMethods().selectDistinct(fields);
  }

  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[]
  ): PgAsyncSelectBuilder<undefined>;
  override selectDistinctOn<TSelection extends SelectedFields>(
    on: (PgColumn | SQLWrapper)[],
    fields: TSelection
  ): PgAsyncSelectBuilder<TSelection>;
  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[],
    fields?: SelectedFields
  ): PgAsyncSelectBuilder<SelectedFields | undefined> {
    return this.selectMethods().selectDistinctOn(on, fields);
  }

  executeBatches<T extends RowData = RowData>(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<T[], void, void> {
    return this.session.executeBatches<T>(query, options);
  }

  executeBatchesRaw(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
    return this.session.executeBatchesRaw(query, options);
  }

  executeArrow(query: SQL): Promise<unknown> {
    return this.session.executeArrow(query);
  }

  /**
   * Append rows with DuckDB's appender instead of an INSERT statement. It
   * skips SQL building and parameter binding, so large batches load far
   * faster than `db.insert().values()`. Missing columns take their default.
   * Returns the number of rows appended.
   *
   * The appender has no RETURNING or ON CONFLICT, and it cannot take values
   * that a column encodes as SQL, such as structs. Outside a transaction a
   * failure can leave earlier rows of the batch in the table. Use
   * `db.transaction((tx) => tx.appendRows(...))` for all or nothing.
   */
  appendRows<TTable extends PgTable>(
    table: TTable,
    rows: readonly InferInsertModel<TTable>[]
  ): Promise<number> {
    return this.session.appendRows(table, rows);
  }

  /**
   * Run a transaction. DuckDB has no SET TRANSACTION statement, so passing
   * `config` rejects before the transaction begins.
   */
  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TRelations>) => Promise<T>,
    config?: PgTransactionConfig
  ): Promise<T> {
    return await this.session.transaction<T>(transaction, config);
  }
}
