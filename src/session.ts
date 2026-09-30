import { entityKind, is } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { NoopLogger } from 'drizzle-orm/logger';
import { PgArray, PgTransaction } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type {
  PgSelectBuilder,
  SelectedFields,
} from 'drizzle-orm/pg-core/query-builders';
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
import {
  fillPlaceholders,
  Param,
  Placeholder,
  type Query,
  type QueryWithTypings,
  SQL,
  sql,
  type SQLWrapper,
} from 'drizzle-orm/sql/sql';
import type { WithSubquery } from 'drizzle-orm/subquery';
import { Column } from 'drizzle-orm/column';
import type { Assume } from 'drizzle-orm/utils';
import {
  compileResultMapper,
  resolveFieldDecoder,
} from './sql/result-mapper.ts';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { DuckDBDialect } from './dialect.ts';
import type {
  DuckDBClientLike,
  DuckDBConnectionPool,
  DuckDBExecutionClient,
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
import type { PreparedStatementCacheConfig } from './options.ts';
import {
  createDuckDBSelectMethods,
  DuckDBQueryBuilder,
  type DuckDBSelectBuilder,
} from './select-builder.ts';

export type { DuckDBClientLike, RowData } from './client.ts';

type QueryMetadata = {
  type: 'select' | 'update' | 'delete' | 'insert';
  tables: string[];
};

type CacheConfig = {
  enable?: boolean;
  autoInvalidate?: boolean;
  tag?: string;
  config?: unknown;
};

function isSavepointSyntaxError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) {
    return false;
  }
  return (
    error.message.toLowerCase().includes('savepoint') &&
    error.message.toLowerCase().includes('syntax error')
  );
}

function isTransactionAbortedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('transaction is aborted')
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

function assertValidTransactionOption(
  label: string,
  value: string | undefined,
  validValues: ReadonlySet<string>
): void {
  if (!value || validValues.has(value)) {
    return;
  }

  throw new Error(
    `Invalid transaction ${label} "${value}". Expected one of: ${Array.from(
      validValues
    ).join(', ')}.`
  );
}

const TRANSACTION_CONFIG_WARNING =
  'Transaction config is not supported by DuckDB and is ignored. Passing it will throw in the next major version.';

let hasWarnedTransactionConfig = false;

function warnTransactionConfigIgnored(): void {
  if (hasWarnedTransactionConfig) {
    return;
  }
  hasWarnedTransactionConfig = true;
  console.warn(TRANSACTION_CONFIG_WARNING);
}

/**
 * Params bound to a non-array column must keep their string value even when
 * it looks like a Postgres array literal, for example `{}` in a text column
 * or a braced UUID in a uuid column. The dialect types array columns and
 * untyped params as 'none', so every other typing marks a scalar column.
 */
function getScalarParamIndexes(
  params: unknown[],
  typings: QueryWithTypings['typings']
): Set<number> | undefined {
  let indexes: Set<number> | undefined;
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const typing = typings?.[index];
    const isScalar =
      (typing !== undefined && typing !== 'none') ||
      (is(param, Param) &&
        is(param.value, Placeholder) &&
        is(param.encoder, Column) &&
        !is(param.encoder, PgArray));
    if (isScalar) {
      indexes ??= new Set();
      indexes.add(index);
    }
  }
  return indexes;
}

function isNumericColumn(decoder: unknown): boolean {
  return (
    is(decoder, Column) &&
    (decoder as Column).columnType.startsWith('PgNumeric')
  );
}

/**
 * DECIMAL columns are read as exact strings so numeric() columns keep every
 * digit, as node-postgres does for NUMERIC. Any other field, such as
 * sql`sum(${t.price})`, keeps the JS number it had before.
 */
function restoreNonNumericDecimals(
  rows: unknown[][],
  fields: SelectedFieldsOrdered,
  decimalColumns: readonly number[]
): void {
  const toNumber = decimalColumns.filter(
    (index) =>
      !isNumericColumn(
        fields[index] && resolveFieldDecoder(fields[index].field)
      )
  );
  if (toNumber.length === 0) {
    return;
  }
  for (const row of rows) {
    for (const index of toNumber) {
      const value = row[index];
      if (typeof value === 'string') {
        row[index] = Number(value);
      }
    }
  }
}

interface QueryParamPreparationOptions {
  logger: Logger;
  queryString: string;
  params: unknown[];
  rejectStringArrayLiterals: boolean;
  warnOnStringArrayLiteral?: (sql: string) => void;
  scalarParamIndexes?: ReadonlySet<number>;
}

function prepareQueryParams({
  logger,
  queryString,
  params,
  rejectStringArrayLiterals,
  warnOnStringArrayLiteral,
  scalarParamIndexes,
}: QueryParamPreparationOptions): unknown[] {
  const preparedParams = prepareParams(params, {
    rejectStringArrayLiterals,
    warnOnStringArrayLiteral: rejectStringArrayLiterals
      ? undefined
      : () => warnOnStringArrayLiteral?.(queryString),
    scalarParamIndexes,
  });

  logger.logQuery(queryString, preparedParams);
  return preparedParams;
}

export class DuckDBPreparedQuery<
  T extends PreparedQueryConfig,
> extends PgPreparedQuery<T> {
  static readonly [entityKind]: string = 'DuckDBPreparedQuery';
  private resultMapper?: (row: unknown[]) => T['execute'];

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
    queryMetadata?: QueryMetadata,
    cacheConfig?: CacheConfig,
    private warnOnStringArrayLiteral?: (sql: string) => void,
    private scalarParamIndexes?: ReadonlySet<number>,
    private onStatementError?: (error: unknown) => void,
    private decimalMode: 'number' | 'string' = 'number'
  ) {
    super(
      ...([
        { sql: queryString, params },
        undefined,
        queryMetadata,
        cacheConfig,
      ] as unknown as ConstructorParameters<typeof PgPreparedQuery>)
    );
  }

  async execute(
    placeholderValues: Record<string, unknown> | undefined = {}
  ): Promise<T['execute']> {
    try {
      return await this.executeQuery(placeholderValues);
    } catch (error) {
      this.onStatementError?.(error);
      throw error;
    }
  }

  private async executeQuery(
    placeholderValues: Record<string, unknown>
  ): Promise<T['execute']> {
    const params = prepareQueryParams({
      logger: this.logger,
      queryString: this.queryString,
      params: fillPlaceholders(this.params, placeholderValues),
      rejectStringArrayLiterals: this.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: this.warnOnStringArrayLiteral,
      scalarParamIndexes: this.scalarParamIndexes,
    });

    const { fields, joinsNotNullableMap, customResultMapper } =
      this as typeof this & { joinsNotNullableMap?: Record<string, boolean> };

    // Match PgPreparedQuery: relational queries pass a result mapper without
    // fields and expect array rows, including for empty results.
    if (!fields && !customResultMapper) {
      const rows = await executeOnClient(
        this.client,
        this.queryString,
        params,
        { prepareCache: this.prepareCache, decimalMode: this.decimalMode }
      );

      return rows as T['execute'];
    }

    const { rows, exactDecimalColumns } = await executeArraysOnClient(
      this.client,
      this.queryString,
      params,
      {
        prepareCache: this.prepareCache,
        exactDecimals: !customResultMapper,
        decimalMode: this.decimalMode,
      }
    );

    if (customResultMapper) {
      return customResultMapper(rows);
    }

    if (exactDecimalColumns && this.decimalMode !== 'string') {
      restoreNonNumericDecimals(rows, fields!, exactDecimalColumns);
    }

    this.resultMapper ??= compileResultMapper<T['execute']>(
      fields!,
      joinsNotNullableMap
    );
    return rows.map(this.resultMapper);
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
  decimalMode?: 'number' | 'string';
  logger?: Logger;
  rejectStringArrayLiterals?: boolean;
  arrayLiteralWarning?: (query: string) => void;
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
  // Set on sessions that run a transaction. DuckDB aborts the transaction when
  // a statement fails during execution, and a later COMMIT silently rolls back.
  private statementFailures: unknown[] | undefined;

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
    customResultMapper?: (rows: unknown[][]) => T['execute'],
    queryMetadata?: QueryMetadata,
    cacheConfig?: CacheConfig
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
      queryMetadata,
      cacheConfig,
      this.rejectStringArrayLiterals
        ? undefined
        : this.warnOnStringArrayLiteral,
      getScalarParamIndexes(query.params, (query as QueryWithTypings).typings),
      this.statementFailures ? this.recordStatementFailure : undefined,
      this.options.decimalMode
    );
  }

  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TFullSchema, TSchema>) => Promise<T>,
    config?: PgTransactionConfig
  ): Promise<T> {
    if (config) {
      warnTransactionConfigIgnored();
    }

    let pinnedConnection: DuckDBExecutionClient | undefined;
    let pool: DuckDBConnectionPool | undefined;

    let clientForTx: DuckDBClientLike = this.client;
    if (isPool(this.client)) {
      pool = this.client;
      pinnedConnection = await pool.acquire();
      clientForTx = pinnedConnection;
    }

    const session = new DuckDBSession<TFullSchema, TSchema>(
      clientForTx,
      this.dialect,
      this.schema,
      this.options
    );
    session.statementFailures = [];

    const tx = new DuckDBTransaction<TFullSchema, TSchema>(
      this.dialect,
      session,
      this.schema
    );

    try {
      await tx.execute(sql`BEGIN TRANSACTION;`);

      let result: T;
      try {
        result = await transaction(tx);
        if (session.isRollbackOnly()) {
          throw new TransactionRollbackError();
        }
        await session.assertTransactionNotAborted();
      } catch (error) {
        await session.rollbackQuietly();
        throw error;
      }

      try {
        await tx.execute(sql`commit`);
      } catch (error) {
        // A failed COMMIT usually ends the transaction already. Roll back in
        // case it did not, but surface the commit error.
        await session.rollbackQuietly();
        throw error;
      }
      return result;
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
    if (this.options.arrayLiteralWarning) {
      this.options.arrayLiteralWarning(query);
      return;
    }
    this.logger.logQuery(
      `[duckdb] ${arrayLiteralWarning}\nquery: ${query}`,
      []
    );
  };

  private recordStatementFailure = (error: unknown) => {
    this.statementFailures?.push(error);
  };

  /**
   * DuckDB keeps parser and binder failures recoverable but aborts the
   * transaction on execution failures. COMMIT then succeeds without saving
   * anything, so probe the transaction before committing.
   */
  private async assertTransactionNotAborted(): Promise<void> {
    if (!this.statementFailures?.length) {
      return;
    }

    try {
      await this.execute(sql`select 1`);
    } catch {
      const cause =
        this.statementFailures.find(
          (error) =>
            !isSavepointSyntaxError(error) && !isTransactionAbortedError(error)
        ) ?? this.statementFailures[0];
      throw new Error(
        'DuckDB aborted the transaction because a statement inside it failed. No changes were committed. Rethrow the statement error, or catch it outside db.transaction(), instead of continuing the transaction.',
        { cause }
      );
    }
  }

  private async rollbackQuietly(): Promise<void> {
    try {
      await this.execute(sql`rollback`);
    } catch {
      // Keep the original error. DuckDB reports "no transaction is active"
      // when a failed statement or COMMIT already ended the transaction.
    }
  }

  private prepareQueryExecution(query: SQL): {
    sql: string;
    params: unknown[];
  } {
    const builtQuery = this.dialect.sqlToQuery(query);
    const params = prepareQueryParams({
      logger: this.logger,
      queryString: builtQuery.sql,
      params: builtQuery.params,
      rejectStringArrayLiterals: this.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: this.warnOnStringArrayLiteral,
      scalarParamIndexes: getScalarParamIndexes(
        builtQuery.params,
        builtQuery.typings
      ),
    });
    return { sql: builtQuery.sql, params };
  }

  private async *trackStreamFailures<T>(
    stream: AsyncGenerator<T, void, void>
  ): AsyncGenerator<T, void, void> {
    try {
      yield* stream;
    } catch (error) {
      this.recordStatementFailure(error);
      throw error;
    }
  }

  executeBatches<T extends RowData = RowData>(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<GenericRowData<T>[], void, void> {
    const { sql: queryString, params } = this.prepareQueryExecution(query);

    return this.trackStreamFailures(
      executeInBatches(this.client, queryString, params, {
        decimalMode: this.options.decimalMode,
        ...options,
      })
    ) as AsyncGenerator<GenericRowData<T>[], void, void>;
  }

  executeBatchesRaw(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
    const { sql: queryString, params } = this.prepareQueryExecution(query);
    return this.trackStreamFailures(
      executeInBatchesRaw(this.client, queryString, params, {
        decimalMode: this.options.decimalMode,
        ...options,
      })
    );
  }

  async executeArrow(query: SQL): Promise<unknown> {
    const { sql: queryString, params } = this.prepareQueryExecution(query);
    try {
      return await executeArrowOnClient(this.client, queryString, params, {
        decimalMode: this.options.decimalMode,
      });
    } catch (error) {
      this.recordStatementFailure(error);
      throw error;
    }
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

  constructor(
    dialect: DuckDBDialect,
    session: DuckDBSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex = 0
  ) {
    super(dialect, session, schema, nestedIndex);
    this.$with = new DuckDBQueryBuilder(dialect).$with;
  }

  private getInternals(): DuckDBTransactionWithInternals<TFullSchema, TSchema> {
    // PgTransaction keeps dialect/session private, but DuckDB transaction
    // helpers need the session for DuckDB-specific execution paths.
    return this as unknown as DuckDBTransactionWithInternals<
      TFullSchema,
      TSchema
    >;
  }

  private markRollbackOnly(): void {
    this.getInternals().session.markRollbackOnly();
  }

  private selectMethods(withList?: WithSubquery[]) {
    const { dialect, session } = this.getInternals();
    return createDuckDBSelectMethods(
      session as unknown as PgSession<DuckDBQueryResultHKT>,
      dialect,
      withList
    );
  }

  override with(
    ...queries: WithSubquery[]
  ): ReturnType<
    PgTransaction<DuckDBQueryResultHKT, TFullSchema, TSchema>['with']
  > {
    return {
      ...super.with(...queries),
      ...this.selectMethods(queries),
    } as ReturnType<
      PgTransaction<DuckDBQueryResultHKT, TFullSchema, TSchema>['with']
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

  override selectDistinct(): PgSelectBuilder<undefined>;
  override selectDistinct<TSelection extends SelectedFields>(
    fields: TSelection
  ): PgSelectBuilder<TSelection>;
  override selectDistinct(
    fields?: SelectedFields
  ): PgSelectBuilder<SelectedFields | undefined> {
    return this.selectMethods().selectDistinct(fields);
  }

  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[]
  ): PgSelectBuilder<undefined>;
  override selectDistinctOn<TSelection extends SelectedFields>(
    on: (PgColumn | SQLWrapper)[],
    fields: TSelection
  ): PgSelectBuilder<TSelection>;
  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[],
    fields?: SelectedFields
  ): PgSelectBuilder<SelectedFields | undefined> {
    return this.selectMethods().selectDistinctOn(on, fields);
  }

  rollback(): never {
    throw new TransactionRollbackError();
  }

  /**
   * @deprecated DuckDB has no SET TRANSACTION statement, so transaction config
   * is ignored. This helper will be removed in the next major version.
   */
  getTransactionConfigSQL(config: PgTransactionConfig): SQL {
    assertValidTransactionOption(
      'isolation level',
      config.isolationLevel,
      VALID_TRANSACTION_ISOLATION_LEVELS
    );
    assertValidTransactionOption(
      'access mode',
      config.accessMode,
      VALID_TRANSACTION_ACCESS_MODES
    );

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

  /**
   * @deprecated DuckDB has no SET TRANSACTION statement. This method is a
   * no-op that warns once, and passing config will throw in the next major
   * version.
   */
  setTransaction(config: PgTransactionConfig): Promise<void> {
    void config;
    warnTransactionConfigIgnored();
    return Promise.resolve();
  }

  executeBatches<T extends RowData = RowData>(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<GenericRowData<T>[], void, void> {
    return this.getInternals().session.executeBatches<T>(query, options);
  }

  executeBatchesRaw(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
    return this.getInternals().session.executeBatchesRaw(query, options);
  }

  executeArrow(query: SQL): Promise<unknown> {
    return this.getInternals().session.executeArrow(query);
  }

  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TFullSchema, TSchema>) => Promise<T>
  ): Promise<T> {
    const internals = this.getInternals();
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
      return this.runNestedWithoutSavepoint(transaction, nestedTx);
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
      return this.runNestedWithoutSavepoint(transaction, nestedTx);
    }

    try {
      const result = await transaction(nestedTx);
      if (createdSavepoint) {
        await internals.session.execute(releaseSql);
      }
      return result;
    } catch (error) {
      // A successful rollback to the savepoint leaves the outer transaction
      // usable, matching Postgres. Only a failed rollback poisons it.
      try {
        await internals.session.execute(rollbackSql);
      } catch {
        this.markRollbackOnly();
      }
      throw error;
    }
  }

  private runNestedWithoutSavepoint<T>(
    transaction: (tx: DuckDBTransaction<TFullSchema, TSchema>) => Promise<T>,
    nestedTx: DuckDBTransaction<TFullSchema, TSchema>
  ): Promise<T> {
    return transaction(nestedTx).catch((error) => {
      this.markRollbackOnly();
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
