import { entityKind } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { NoopLogger } from 'drizzle-orm/logger';
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type {
  PgTransactionConfig,
  PreparedQueryConfig,
  PgQueryResultHKT,
} from 'drizzle-orm/pg-core/session';
import { PgPreparedQuery, PgSession } from 'drizzle-orm/pg-core/session';
import type {
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from 'drizzle-orm/relations';
import { fillPlaceholders, type Query, SQL, sql } from 'drizzle-orm/sql/sql';
import type { Assume } from 'drizzle-orm/utils';
import { mapResultRow } from './sql/result-mapper.ts';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { DuckDBDialect } from './dialect.ts';
import type {
  DuckDBClientLike,
  DuckDBConnectionPool,
  RowData,
} from './client.ts';
import {
  executeArrowOnClient,
  executeArraysOnClient,
  executeInBatches,
  executeInBatchesRaw,
  executeOnClient,
  prepareParams,
  type ExecuteBatchesRawChunk,
  type ExecuteInBatchesOptions,
} from './client.ts';
import { isPool } from './client.ts';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { PreparedStatementCacheConfig } from './options.ts';

export type { DuckDBClientLike, RowData } from './client.ts';

function isSavepointSyntaxError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) {
    return false;
  }
  return (
    error.message.toLowerCase().includes('savepoint') &&
    error.message.toLowerCase().includes('syntax error')
  );
}

const VALID_TRANSACTION_ISOLATION_LEVELS = new Set<string>([
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
]);

const VALID_TRANSACTION_ACCESS_MODES = new Set<string>([
  'read only',
  'read write',
]);

export class DuckDBPreparedQuery<
  T extends PreparedQueryConfig,
> extends PgPreparedQuery<T> {
  static readonly [entityKind]: string = 'DuckDBPreparedQuery';

  constructor(
    private client: DuckDBClientLike,
    private dialect: DuckDBDialect,
    private queryString: string,
    private params: unknown[],
    private logger: Logger,
    private fields: SelectedFieldsOrdered | undefined,
    private _isResponseInArrayMode: boolean,
    private customResultMapper:
      | ((rows: unknown[][]) => T['execute'])
      | undefined,
    private rejectStringArrayLiterals: boolean,
    private prepareCache: PreparedStatementCacheConfig | undefined,
    private warnOnStringArrayLiteral?: (sql: string) => void
  ) {
    super({ sql: queryString, params });
  }

  async execute(
    placeholderValues: Record<string, unknown> | undefined = {}
  ): Promise<T['execute']> {
    this.dialect.assertNoPgJsonColumns();
    const params = prepareParams(
      fillPlaceholders(this.params, placeholderValues),
      {
        rejectStringArrayLiterals: this.rejectStringArrayLiterals,
        warnOnStringArrayLiteral: this.warnOnStringArrayLiteral
          ? () => this.warnOnStringArrayLiteral?.(this.queryString)
          : undefined,
      }
    );
    this.logger.logQuery(this.queryString, params);

    const { fields, joinsNotNullableMap, customResultMapper } =
      this as typeof this & { joinsNotNullableMap?: Record<string, boolean> };

    if (fields) {
      const { rows } = await executeArraysOnClient(
        this.client,
        this.queryString,
        params,
        { prepareCache: this.prepareCache }
      );

      if (rows.length === 0) {
        return [] as T['execute'];
      }

      return customResultMapper
        ? customResultMapper(rows)
        : rows.map((row) =>
            mapResultRow<T['execute']>(fields, row, joinsNotNullableMap)
          );
    }

    const rows = await executeOnClient(this.client, this.queryString, params, {
      prepareCache: this.prepareCache,
    });

    return rows as T['execute'];
  }

  all(
    placeholderValues: Record<string, unknown> | undefined = {}
  ): Promise<T['all']> {
    return this.execute(placeholderValues);
  }

  isResponseInArrayMode(): boolean {
    return this._isResponseInArrayMode;
  }
}

export interface DuckDBSessionOptions {
  logger?: Logger;
  rejectStringArrayLiterals?: boolean;
  prepareCache?: PreparedStatementCacheConfig;
}

export class DuckDBSession<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends TablesRelationalConfig = Record<string, never>,
> extends PgSession<DuckDBQueryResultHKT, TFullSchema, TSchema> {
  static readonly [entityKind]: string = 'DuckDBSession';

  protected override dialect: DuckDBDialect;
  private logger: Logger;
  private rejectStringArrayLiterals: boolean;
  private prepareCache: PreparedStatementCacheConfig | undefined;
  private hasWarnedArrayLiteral = false;
  private rollbackOnly = false;

  constructor(
    private client: DuckDBClientLike,
    dialect: DuckDBDialect,
    private schema: RelationalSchemaConfig<TSchema> | undefined,
    private options: DuckDBSessionOptions = {}
  ) {
    super(dialect);
    this.dialect = dialect;
    this.logger = options.logger ?? new NoopLogger();
    this.rejectStringArrayLiterals = options.rejectStringArrayLiterals ?? false;
    this.prepareCache = options.prepareCache;
    this.options = {
      ...options,
      prepareCache: this.prepareCache,
    };
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    name: string | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => T['execute']
  ): PgPreparedQuery<T> {
    void name; // DuckDB doesn't support prepared statement names but the signature must match.
    return new DuckDBPreparedQuery(
      this.client,
      this.dialect,
      query.sql,
      query.params,
      this.logger,
      fields,
      isResponseInArrayMode,
      customResultMapper,
      this.rejectStringArrayLiterals,
      this.prepareCache,
      this.rejectStringArrayLiterals ? undefined : this.warnOnStringArrayLiteral
    );
  }

  override execute<T>(query: SQL): Promise<T> {
    this.dialect.resetPgJsonFlag();
    return super.execute(query);
  }

  override all<T = unknown>(query: SQL): Promise<T[]> {
    this.dialect.resetPgJsonFlag();
    return super.all(query);
  }

  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TFullSchema, TSchema>) => Promise<T>,
    config?: PgTransactionConfig
  ): Promise<T> {
    let pinnedConnection: DuckDBConnection | undefined;
    let pool: DuckDBConnectionPool | undefined;

    let clientForTx: DuckDBClientLike = this.client;
    if (isPool(this.client)) {
      pool = this.client;
      pinnedConnection = await pool.acquire();
      clientForTx = pinnedConnection;
    }

    const session = new DuckDBSession(
      clientForTx,
      this.dialect,
      this.schema,
      this.options
    );

    const tx = new DuckDBTransaction<TFullSchema, TSchema>(
      this.dialect,
      session,
      this.schema
    );

    try {
      await tx.execute(sql`BEGIN TRANSACTION;`);

      if (config) {
        await tx.setTransaction(config);
      }

      try {
        const result = await transaction(tx);
        if (session.isRollbackOnly()) {
          await tx.execute(sql`rollback`);
          throw new TransactionRollbackError();
        }
        await tx.execute(sql`commit`);
        return result;
      } catch (error) {
        await tx.execute(sql`rollback`);
        throw error;
      }
    } finally {
      if (pinnedConnection && pool) {
        await pool.release(pinnedConnection);
      }
    }
  }

  private warnOnStringArrayLiteral = (query: string) => {
    if (this.hasWarnedArrayLiteral) {
      return;
    }
    this.hasWarnedArrayLiteral = true;
    this.logger.logQuery(
      `[duckdb] ${arrayLiteralWarning}\nquery: ${query}`,
      []
    );
  };

  executeBatches<T extends RowData = RowData>(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<GenericRowData<T>[], void, void> {
    this.dialect.resetPgJsonFlag();
    const builtQuery = this.dialect.sqlToQuery(query);
    this.dialect.assertNoPgJsonColumns();
    const params = prepareParams(builtQuery.params, {
      rejectStringArrayLiterals: this.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: this.rejectStringArrayLiterals
        ? undefined
        : () => this.warnOnStringArrayLiteral(builtQuery.sql),
    });

    this.logger.logQuery(builtQuery.sql, params);

    return executeInBatches(
      this.client,
      builtQuery.sql,
      params,
      options
    ) as AsyncGenerator<GenericRowData<T>[], void, void>;
  }

  executeBatchesRaw(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
    this.dialect.resetPgJsonFlag();
    const builtQuery = this.dialect.sqlToQuery(query);
    this.dialect.assertNoPgJsonColumns();
    const params = prepareParams(builtQuery.params, {
      rejectStringArrayLiterals: this.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: this.rejectStringArrayLiterals
        ? undefined
        : () => this.warnOnStringArrayLiteral(builtQuery.sql),
    });

    this.logger.logQuery(builtQuery.sql, params);

    return executeInBatchesRaw(this.client, builtQuery.sql, params, options);
  }

  async executeArrow(query: SQL): Promise<unknown> {
    this.dialect.resetPgJsonFlag();
    const builtQuery = this.dialect.sqlToQuery(query);
    this.dialect.assertNoPgJsonColumns();
    const params = prepareParams(builtQuery.params, {
      rejectStringArrayLiterals: this.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: this.rejectStringArrayLiterals
        ? undefined
        : () => this.warnOnStringArrayLiteral(builtQuery.sql),
    });

    this.logger.logQuery(builtQuery.sql, params);

    return executeArrowOnClient(this.client, builtQuery.sql, params);
  }

  markRollbackOnly(): void {
    this.rollbackOnly = true;
  }

  isRollbackOnly(): boolean {
    return this.rollbackOnly;
  }
}

type PgTransactionInternals<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends TablesRelationalConfig = Record<string, never>,
> = {
  dialect: DuckDBDialect;
  session: DuckDBSession<TFullSchema, TSchema>;
};

type DuckDBTransactionWithInternals<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends TablesRelationalConfig = Record<string, never>,
> = PgTransactionInternals<TFullSchema, TSchema> &
  DuckDBTransaction<TFullSchema, TSchema>;

export class DuckDBTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgTransaction<DuckDBQueryResultHKT, TFullSchema, TSchema> {
  static readonly [entityKind]: string = 'DuckDBTransaction';

  rollback(): never {
    throw new TransactionRollbackError();
  }

  getTransactionConfigSQL(config: PgTransactionConfig): SQL {
    if (
      config.isolationLevel &&
      !VALID_TRANSACTION_ISOLATION_LEVELS.has(config.isolationLevel)
    ) {
      throw new Error(
        `Invalid transaction isolation level "${config.isolationLevel}". Expected one of: ${Array.from(
          VALID_TRANSACTION_ISOLATION_LEVELS
        ).join(', ')}.`
      );
    }

    if (
      config.accessMode &&
      !VALID_TRANSACTION_ACCESS_MODES.has(config.accessMode)
    ) {
      throw new Error(
        `Invalid transaction access mode "${config.accessMode}". Expected one of: ${Array.from(
          VALID_TRANSACTION_ACCESS_MODES
        ).join(', ')}.`
      );
    }

    if (
      config.deferrable !== undefined &&
      typeof config.deferrable !== 'boolean'
    ) {
      throw new Error(
        `Invalid transaction deferrable flag "${String(
          config.deferrable
        )}". Expected a boolean.`
      );
    }

    const chunks: string[] = [];
    if (config.isolationLevel) {
      chunks.push(`isolation level ${config.isolationLevel}`);
    }
    if (config.accessMode) {
      chunks.push(config.accessMode);
    }
    if (typeof config.deferrable === 'boolean') {
      chunks.push(config.deferrable ? 'deferrable' : 'not deferrable');
    }
    return sql.raw(chunks.join(' '));
  }

  setTransaction(config: PgTransactionConfig): Promise<void> {
    // Cast needed: PgTransaction doesn't expose dialect/session properties in public API
    type Tx = DuckDBTransactionWithInternals<TFullSchema, TSchema>;
    return (this as unknown as Tx).session.execute(
      sql`set transaction ${this.getTransactionConfigSQL(config)}`
    );
  }

  executeBatches<T extends RowData = RowData>(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<GenericRowData<T>[], void, void> {
    // Cast needed: PgTransaction doesn't expose session property in public API
    type Tx = DuckDBTransactionWithInternals<TFullSchema, TSchema>;
    return (this as unknown as Tx).session.executeBatches<T>(query, options);
  }

  executeBatchesRaw(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
    // Cast needed: PgTransaction doesn't expose session property in public API
    type Tx = DuckDBTransactionWithInternals<TFullSchema, TSchema>;
    return (this as unknown as Tx).session.executeBatchesRaw(query, options);
  }

  executeArrow(query: SQL): Promise<unknown> {
    // Cast needed: PgTransaction doesn't expose session property in public API
    type Tx = DuckDBTransactionWithInternals<TFullSchema, TSchema>;
    return (this as unknown as Tx).session.executeArrow(query);
  }

  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TFullSchema, TSchema>) => Promise<T>
  ): Promise<T> {
    // Cast needed: PgTransaction doesn't expose dialect/session properties in public API
    type Tx = DuckDBTransactionWithInternals<TFullSchema, TSchema>;
    const internals = this as unknown as Tx;
    const savepoint = `drizzle_savepoint_${this.nestedIndex + 1}`;
    const savepointSql = sql.raw(`savepoint ${savepoint}`);
    const releaseSql = sql.raw(`release savepoint ${savepoint}`);
    const rollbackSql = sql.raw(`rollback to savepoint ${savepoint}`);

    const nestedTx = new DuckDBTransaction<TFullSchema, TSchema>(
      internals.dialect,
      internals.session,
      this.schema,
      this.nestedIndex + 1
    );

    // Check dialect-level savepoint support (per-instance, not global)
    if (internals.dialect.areSavepointsUnsupported()) {
      return this.runNestedWithoutSavepoint(transaction, nestedTx, internals);
    }

    let createdSavepoint = false;
    try {
      await internals.session.execute(savepointSql);
      internals.dialect.markSavepointsSupported();
      createdSavepoint = true;
    } catch (error) {
      if (!isSavepointSyntaxError(error)) {
        throw error;
      }
      internals.dialect.markSavepointsUnsupported();
      return this.runNestedWithoutSavepoint(transaction, nestedTx, internals);
    }

    try {
      const result = await transaction(nestedTx);
      if (createdSavepoint) {
        await internals.session.execute(releaseSql);
      }
      return result;
    } catch (error) {
      if (createdSavepoint) {
        await internals.session.execute(rollbackSql);
      }
      (
        internals.session as DuckDBSession<TFullSchema, TSchema>
      ).markRollbackOnly();
      throw error;
    }
  }

  private runNestedWithoutSavepoint<T>(
    transaction: (tx: DuckDBTransaction<TFullSchema, TSchema>) => Promise<T>,
    nestedTx: DuckDBTransaction<TFullSchema, TSchema>,
    internals: DuckDBTransactionWithInternals<TFullSchema, TSchema>
  ): Promise<T> {
    return transaction(nestedTx).catch((error) => {
      (
        internals.session as DuckDBSession<TFullSchema, TSchema>
      ).markRollbackOnly();
      throw error;
    });
  }
}

export type GenericRowData<T extends RowData = RowData> = T;

export type GenericTableData<T = RowData> = T[];

const arrayLiteralWarning =
  'Received a stringified Postgres-style array literal. Use duckDbList()/duckDbArray() or pass native arrays instead. You can also set rejectStringArrayLiterals=true to throw.';

export interface DuckDBQueryResultHKT extends PgQueryResultHKT {
  type: GenericTableData<Assume<this['row'], RowData>>;
}
