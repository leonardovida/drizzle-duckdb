import { AsyncLocalStorage } from 'node:async_hooks';
import { entityKind, is } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { NoopLogger } from 'drizzle-orm/logger';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  PgAsyncPreparedQuery,
  PgAsyncSession,
  PgAsyncTransaction,
} from 'drizzle-orm/pg-core/async/session';
import type { PgAsyncSelectBuilder } from 'drizzle-orm/pg-core/async/select';
import type { InferInsertModel } from 'drizzle-orm/table';
import type { SelectedFields } from 'drizzle-orm/pg-core/query-builders/select.types';
import type {
  PgQueryResultHKT,
  PgRawRow,
  PgTransactionConfig,
  PreparedQueryConfig,
} from 'drizzle-orm/pg-core/session';
import type { AnyRelations, EmptyRelations } from 'drizzle-orm/relations';
import {
  fillPlaceholders,
  type Query,
  SQL,
  sql,
  type SQLWrapper,
} from 'drizzle-orm/sql/sql';
import type { WithSubquery } from 'drizzle-orm/subquery';
import { Column } from 'drizzle-orm/column';
import type { Assume } from 'drizzle-orm/utils';
import type {
  WithCacheConfig,
  QueryMetadata,
} from 'drizzle-orm/cache/core/types';
import { skipQuotedOrComment } from './sql/array-bounds-text.ts';
import { resolveFieldDecoder } from './sql/result-mapper.ts';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { ParamKind } from './codecs.ts';
import type { DuckDBDialect } from './dialect.ts';
import { mapperFieldsOf, paramKindsOf } from './dialect.ts';
import type {
  DuckDBClientLike,
  DuckDBConnectionPool,
  RowData,
} from './client.ts';
import {
  APPEND_DEFAULT,
  appendRowsOnClient,
  executeArrowOnClient,
  executeArraysOnClient,
  executeInBatches,
  executeInBatchesRaw,
  executeOnClient,
  prepareParams,
  type DateParamType,
  type ExecuteBatchesRawChunk,
  type ExecuteInBatchesOptions,
} from './client.ts';
import { isPool } from './client.ts';
import {
  createDuckDBSelectMethods,
  DuckDBQueryBuilder,
  type DuckDBSelectBuilder,
} from './select-builder.ts';

export type { DuckDBClientLike, RowData } from './client.ts';

/**
 * A connection has one transaction, and every statement sent to it joins that
 * transaction. Without a pool, `db` and `db.transaction()` share the
 * connection, so an unrelated statement would join an open transaction: its
 * failure would abort it, and its writes would roll back with it. Queue such
 * statements until the transaction ends. Statements issued while the
 * transaction callback runs, even through `db`, keep running immediately so
 * that they cannot deadlock.
 */
const openTransactions = new WeakMap<object, Promise<void>>();
type TransactionScopeEntry = {
  // Cleared when the transaction ends. Timers and promise continuations the
  // callback left behind keep this async context, but must then queue.
  active: boolean;
  recordFailure: (error: unknown) => void;
  // The transaction's open streams, so streams opened through `db` inside
  // the callback are closed before COMMIT or ROLLBACK too.
  openStreams?: Set<() => Promise<void>>;
};

// Maps each client with a transaction open in this async context to that
// transaction.
const transactionScope = new AsyncLocalStorage<
  Map<object, TransactionScopeEntry>
>();

function activeScopeEntry(client: object): TransactionScopeEntry | undefined {
  const entry = transactionScope.getStore()?.get(client);
  return entry?.active ? entry : undefined;
}

function insideTransactionOn(client: object): boolean {
  return activeScopeEntry(client) !== undefined;
}

async function waitForOpenTransaction(client: object): Promise<void> {
  for (
    let open = openTransactions.get(client);
    open && !insideTransactionOn(client);
    open = openTransactions.get(client)
  ) {
    await open;
  }
}

async function acquireTransactionSlot(client: object): Promise<() => void> {
  await waitForOpenTransaction(client);
  // Check and claim in one tick, so two waiters cannot both claim the slot.
  while (openTransactions.has(client) && !insideTransactionOn(client)) {
    await waitForOpenTransaction(client);
  }
  let release!: () => void;
  const previous = openTransactions.get(client);
  openTransactions.set(
    client,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  return () => {
    if (previous) {
      openTransactions.set(client, previous);
    } else {
      openTransactions.delete(client);
    }
    release();
  };
}

async function runInTransactionScope<T>(
  client: object,
  run: () => Promise<T>
): Promise<T> {
  const entry: TransactionScopeEntry = {
    active: true,
    recordFailure: () => undefined,
  };
  const scope = new Map(transactionScope.getStore());
  scope.set(client, entry);
  try {
    return await transactionScope.run(scope, run);
  } finally {
    entry.active = false;
  }
}

/**
 * A statement through `db` inside the callback runs in the transaction, so
 * its failure can abort it. Record it there, so COMMIT is probed first.
 */
function recordInTransactionScope(client: object, error: unknown): void {
  activeScopeEntry(client)?.recordFailure(error);
}

function isNoActiveTransactionError(error: unknown): boolean {
  return (
    error instanceof Error && /no transaction is active/i.test(error.message)
  );
}

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

const TRANSACTION_CONFIG_ERROR =
  'Transaction config is not supported by DuckDB, which has no SET TRANSACTION statement. Remove the config argument (isolationLevel, accessMode, deferrable).';

/** Reject any transaction config with at least one defined option. */
function assertNoTransactionConfig(config: unknown): void {
  // An object with no option set asks for nothing, so it is accepted.
  if (
    config &&
    (typeof config !== 'object' ||
      Object.values(config).some((value) => value !== undefined))
  ) {
    throw new Error(TRANSACTION_CONFIG_ERROR);
  }
}

/**
 * Params bound to a non-array column must keep their string value even when
 * it looks like a Postgres array literal, for example `{}` in a text column
 * or a braced UUID in a uuid column. Params without a column are coerced.
 */
function getScalarParamIndexes(
  kinds: ReadonlyMap<number, ParamKind> | undefined
): Set<number> | undefined {
  let indexes: Set<number> | undefined;
  for (const [index, kind] of kinds ?? []) {
    if (kind === 'scalar') {
      indexes ??= new Set();
      indexes.add(index);
    }
  }
  return indexes;
}

/**
 * An empty array has no item type to bind a list with. DuckDB casts the
 * string '[]' to an empty list of the column type instead, so params bound to
 * a pg-core array column bind their empty array that way.
 */
function bindEmptyArrays(
  values: unknown[],
  kinds: ReadonlyMap<number, ParamKind> | undefined
): unknown[] {
  if (!kinds) return values;
  let result = values;
  for (const [index, kind] of kinds) {
    if (kind !== 'array') continue;
    const value = values[index];
    if (value !== '{}' && !(Array.isArray(value) && value.length === 0)) {
      continue;
    }
    if (result === values) result = values.slice();
    result[index] = '[]';
  }
  return result;
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
  fields: readonly unknown[],
  decimalColumns: readonly number[]
): void {
  const toNumber = decimalColumns.filter(
    (index) =>
      !isNumericColumn(
        fields[index] !== undefined && resolveFieldDecoder(fields[index])
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

/** A `$n` parameter reference at the regex's lastIndex. */
const PARAM_REFERENCE = /\$(\d+)/y;

/**
 * Column encoders such as `duckDbStruct` return SQL literals, because node-api
 * cannot bind those values. Drizzle inlines them when it builds a query, but
 * values filled in for `sql.placeholder()` arrive after that. Splice such
 * values into the statement text and renumber the remaining parameters.
 */
function inlineSqlParams(
  dialect: DuckDBDialect,
  queryString: string,
  params: unknown[],
  scalarParamIndexes: ReadonlySet<number> | undefined
): {
  queryString: string;
  params: unknown[];
  scalarParamIndexes: ReadonlySet<number> | undefined;
} {
  if (!params.some((param) => is(param, SQL))) {
    return { queryString, params, scalarParamIndexes };
  }

  const inlined = params.map((param) => {
    if (!is(param, SQL)) return undefined;
    const rendered = dialect.sqlToQuery(param);
    if (rendered.params.length > 0) {
      throw new Error(
        'A sql.placeholder() value was encoded to SQL with its own parameters, which cannot be inlined. Pass the value directly instead of through a placeholder.'
      );
    }
    return rendered.sql;
  });
  const remaining: unknown[] = [];
  const newIndexes = params.map((param, index) => {
    if (inlined[index] !== undefined) return -1;
    remaining.push(param);
    return remaining.length - 1;
  });

  let text = '';
  for (let i = 0; i < queryString.length;) {
    const skipped = skipQuotedOrComment(queryString, i);
    if (skipped !== i) {
      text += queryString.slice(i, skipped);
      i = skipped;
      continue;
    }
    let match: RegExpExecArray | null = null;
    if (queryString[i] === '$') {
      PARAM_REFERENCE.lastIndex = i;
      match = PARAM_REFERENCE.exec(queryString);
    }
    if (!match) {
      text += queryString[i];
      i += 1;
      continue;
    }
    const index = Number(match[1]) - 1;
    const literal = inlined[index];
    text +=
      literal !== undefined
        ? `(${literal})`
        : `$${(newIndexes[index] ?? index) + 1}`;
    i += match[0].length;
  }

  const remappedScalars = scalarParamIndexes
    ? new Set(
        [...scalarParamIndexes]
          .map((index) => newIndexes[index] ?? -1)
          .filter((index) => index >= 0)
      )
    : undefined;
  return {
    queryString: text,
    params: remaining,
    scalarParamIndexes: remappedScalars,
  };
}

type QueryMode = 'arrays' | 'objects' | 'raw';

interface DuckDBPreparedQueryOptions {
  rejectStringArrayLiterals: boolean;
  warnOnStringArrayLiteral?: (sql: string) => void;
  paramKinds?: ReadonlyMap<number, ParamKind>;
  onStatementError?: (error: unknown) => void;
  decimalMode?: 'number' | 'string';
  waitForTransactions: boolean;
  dateParams?: DateParamType;
}

export class DuckDBPreparedQuery<
  T extends PreparedQueryConfig,
> extends PgAsyncPreparedQuery<T> {
  static override readonly [entityKind]: string = 'DuckDBPreparedQuery';

  constructor(
    private client: DuckDBClientLike,
    private dialect: DuckDBDialect,
    query: Query,
    private queryMode: QueryMode,
    private rowsMapper: ((rows: unknown[]) => unknown) | undefined,
    logger: Logger,
    private duckOptions: DuckDBPreparedQueryOptions,
    queryMetadata?: QueryMetadata,
    cacheConfig?: WithCacheConfig
  ) {
    super(
      (params) => this.run(query.sql, params ?? []),
      query,
      rowsMapper,
      queryMode,
      logger,
      undefined,
      queryMetadata,
      cacheConfig,
      false
    );
  }

  /**
   * Runs the statement directly, as 2.x did: errors keep DuckDB's own error
   * instead of drizzle-orm's DrizzleQueryError wrapper, and the logger sees
   * the params as they are bound.
   */
  override async execute(
    placeholderValues: Record<string, unknown> | undefined = {}
  ): Promise<T['execute']> {
    try {
      return (await this.executeQuery(placeholderValues)) as T['execute'];
    } catch (error) {
      this.duckOptions.onStatementError?.(error);
      throw error;
    }
  }

  // The param kinds of a prepared query do not change between executions.
  private scalarParamIndexes: Set<number> | undefined | null = null;

  private async executeQuery(
    placeholderValues: Record<string, unknown>
  ): Promise<unknown> {
    const options = this.duckOptions;
    if (options.waitForTransactions) {
      await waitForOpenTransaction(this.client);
    }
    if (this.scalarParamIndexes === null) {
      this.scalarParamIndexes = getScalarParamIndexes(options.paramKinds);
    }
    const scalarParamIndexes = this.scalarParamIndexes;
    const filled = inlineSqlParams(
      this.dialect,
      this.query.sql,
      bindEmptyArrays(
        fillPlaceholders(this.query.params, placeholderValues),
        options.paramKinds
      ),
      scalarParamIndexes
    );
    const params = prepareQueryParams({
      logger: this.logger,
      queryString: filled.queryString,
      params: filled.params,
      rejectStringArrayLiterals: options.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: options.warnOnStringArrayLiteral,
      scalarParamIndexes: filled.scalarParamIndexes,
    });
    const rows = await this.run(filled.queryString, params);
    return this.rowsMapper ? this.rowsMapper(rows) : rows;
  }

  private async run(
    queryString: string,
    params: unknown[]
  ): Promise<unknown[]> {
    const { decimalMode, dateParams } = this.duckOptions;
    if (this.queryMode !== 'arrays') {
      return executeOnClient(this.client, queryString, params, {
        decimalMode,
        dateParams,
      });
    }

    // Rows of selects and relational queries keep exact DECIMAL text for
    // numeric() columns. Raw array queries, such as $count(), keep doubles.
    const fields = this.rowsMapper
      ? mapperFieldsOf(this.rowsMapper)
      : undefined;
    const { rows, exactDecimalColumns } = await executeArraysOnClient(
      this.client,
      queryString,
      params,
      {
        exactDecimals: fields !== undefined,
        decimalMode,
        dateParams,
      }
    );
    if (exactDecimalColumns && fields && decimalMode !== 'string') {
      restoreNonNumericDecimals(rows, fields, exactDecimalColumns);
    }
    return rows;
  }
}

export interface DuckDBSessionOptions {
  decimalMode?: 'number' | 'string';
  dateParams?: DateParamType;
  logger?: Logger;
  rejectStringArrayLiterals?: boolean;
  arrayLiteralWarning?: (query: string) => void;
}

export class DuckDBSession<
  TRelations extends AnyRelations = EmptyRelations,
> extends PgAsyncSession<DuckDBQueryResultHKT, TRelations> {
  static override readonly [entityKind]: string = 'DuckDBSession';

  protected override dialect: DuckDBDialect;
  private logger: Logger;
  private rejectStringArrayLiterals: boolean;
  private hasWarnedArrayLiteral = false;
  private rollbackOnly = false;
  private rollbackOnlyCause: unknown;
  // Streams opened through a transaction session, closed when it ends.
  private openStreams: Set<() => Promise<void>> | undefined;
  // Set on sessions that run a transaction. DuckDB aborts the transaction when
  // a statement fails during execution, and a later COMMIT silently rolls back.
  private statementFailures: unknown[] | undefined;

  constructor(
    private client: DuckDBClientLike,
    dialect: DuckDBDialect,
    private relations: TRelations,
    private options: DuckDBSessionOptions = {}
  ) {
    super(dialect);
    this.dialect = dialect;
    this.logger = options.logger ?? new NoopLogger();
    this.rejectStringArrayLiterals = options.rejectStringArrayLiterals ?? false;
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    mode: QueryMode,
    name: string | boolean,
    mapper?: (rows: any[]) => any,
    queryMetadata?: QueryMetadata,
    cacheConfig?: WithCacheConfig
  ): DuckDBPreparedQuery<T> {
    void name; // DuckDB doesn't support prepared statement names but the signature must match.
    return new DuckDBPreparedQuery<T>(
      this.client,
      this.dialect,
      query,
      mode,
      mapper,
      this.logger,
      {
        rejectStringArrayLiterals: this.rejectStringArrayLiterals,
        warnOnStringArrayLiteral: this.rejectStringArrayLiterals
          ? undefined
          : this.warnOnStringArrayLiteral,
        paramKinds: paramKindsOf(query),
        onStatementError:
          this.statementFailures || this.waitsForTransactions()
            ? this.recordStatementFailure
            : undefined,
        decimalMode: this.options.decimalMode,
        waitForTransactions: this.waitsForTransactions(),
        dateParams: this.options.dateParams,
      },
      queryMetadata,
      cacheConfig
    );
  }

  /** Root sessions on one shared connection queue behind its transaction. */
  private waitsForTransactions(): boolean {
    return !this.statementFailures && !isPool(this.client);
  }

  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TRelations>) => Promise<T>,
    config?: PgTransactionConfig
  ): Promise<T> {
    // Reject before a connection is leased or BEGIN runs.
    assertNoTransactionConfig(config);

    if (isPool(this.client)) {
      return this.runTransaction(transaction, this.client);
    }

    const client = this.client;
    const release = await acquireTransactionSlot(client);
    try {
      return await runInTransactionScope(client, () =>
        this.runTransaction(transaction)
      );
    } finally {
      release();
    }
  }

  private async runTransaction<T>(
    transaction: (tx: DuckDBTransaction<TRelations>) => Promise<T>,
    pool?: DuckDBConnectionPool
  ): Promise<T> {
    const pinnedConnection = pool ? await pool.acquire() : undefined;

    const session = new DuckDBSession<TRelations>(
      pinnedConnection ?? this.client,
      this.dialect,
      this.relations,
      this.options
    );
    session.statementFailures = [];
    session.openStreams = new Set();
    const scopeEntry = pool ? undefined : activeScopeEntry(this.client);
    if (scopeEntry) {
      scopeEntry.recordFailure = session.recordStatementFailure;
      scopeEntry.openStreams = session.openStreams;
    }

    const tx = new DuckDBTransaction<TRelations>(
      this.dialect,
      session,
      this.relations
    );

    // A connection whose ROLLBACK failed may still be inside the transaction
    // and must not serve other callers.
    let connectionClean = true;
    try {
      await tx.execute(sql`BEGIN TRANSACTION;`);

      let result: T;
      try {
        result = await transaction(tx);
        await session.closeOpenStreams();
        if (session.isRollbackOnly()) {
          throw session.rollbackOnlyError();
        }
        await session.assertTransactionNotAborted();
      } catch (error) {
        await session.closeOpenStreams();
        connectionClean = await session.rollbackQuietly();
        throw error;
      }

      try {
        await tx.execute(sql`commit`);
      } catch (error) {
        // A failed COMMIT usually ends the transaction already. Roll back in
        // case it did not, but surface the commit error.
        connectionClean = await session.rollbackQuietly();
        throw error;
      }
      return result;
    } finally {
      if (pinnedConnection && pool) {
        if (!connectionClean && pool.discard) {
          await pool.discard(pinnedConnection);
        } else {
          await pool.release(pinnedConnection);
        }
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
    if (this.statementFailures) {
      this.statementFailures.push(error);
    } else if (this.waitsForTransactions()) {
      recordInTransactionScope(this.client, error);
    }
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

  /**
   * Roll back and report whether the connection is out of the transaction.
   * DuckDB reports "no transaction is active" when a failed statement or
   * COMMIT already ended it. Any other failure keeps the original error.
   */
  private async rollbackQuietly(): Promise<boolean> {
    try {
      await this.execute(sql`rollback`);
      return true;
    } catch (error) {
      return isNoActiveTransactionError(error);
    }
  }

  /**
   * A stream left open by the callback keeps the connection busy, so COMMIT
   * and ROLLBACK would fail. Close it, and make further reads throw instead
   * of ending early.
   */
  private async closeOpenStreams(): Promise<void> {
    const streams = [...(this.openStreams ?? [])];
    this.openStreams?.clear();
    for (const close of streams) {
      await close();
    }
  }

  private rollbackOnlyError(): TransactionRollbackError {
    const error = new TransactionRollbackError();
    if (this.rollbackOnlyCause !== undefined) {
      error.message =
        'A nested transaction failed. DuckDB has no savepoints, so the outer transaction was rolled back.';
      (error as Error & { cause?: unknown }).cause = this.rollbackOnlyCause;
    }
    return error;
  }

  private prepareQueryExecution(query: SQL): {
    sql: string;
    params: unknown[];
  } {
    const builtQuery = this.dialect.sqlToQuery(query);
    const kinds = paramKindsOf(builtQuery);
    const params = prepareQueryParams({
      logger: this.logger,
      queryString: builtQuery.sql,
      params: bindEmptyArrays(builtQuery.params, kinds),
      rejectStringArrayLiterals: this.rejectStringArrayLiterals,
      warnOnStringArrayLiteral: this.warnOnStringArrayLiteral,
      scalarParamIndexes: getScalarParamIndexes(kinds),
    });
    return { sql: builtQuery.sql, params };
  }

  private trackStreamFailures<T>(
    stream: AsyncGenerator<T, void, void>
  ): AsyncGenerator<T, void, void> {
    const session = this;
    const openStreams =
      this.openStreams ??
      (this.waitsForTransactions()
        ? activeScopeEntry(this.client)?.openStreams
        : undefined);
    let endedWithTransaction = false;
    const close = async () => {
      endedWithTransaction = true;
      await stream.return(undefined);
    };
    openStreams?.add(close);

    return (async function* () {
      try {
        yield* stream;
        if (endedWithTransaction) {
          throw new Error(
            'The transaction ended before this stream was read to the end. Read transaction streams fully inside the transaction callback.'
          );
        }
      } catch (error) {
        if (!endedWithTransaction) {
          session.recordStatementFailure(error);
        }
        throw error;
      } finally {
        openStreams?.delete(close);
      }
    })();
  }

  private afterOpenTransaction<T>(
    stream: AsyncGenerator<T, void, void>
  ): AsyncGenerator<T, void, void> {
    if (!this.waitsForTransactions()) {
      return stream;
    }
    const client = this.client;
    return (async function* () {
      await waitForOpenTransaction(client);
      yield* stream;
    })();
  }

  executeBatches<T extends RowData = RowData>(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<GenericRowData<T>[], void, void> {
    const { sql: queryString, params } = this.prepareQueryExecution(query);

    return this.trackStreamFailures(
      this.afterOpenTransaction(
        executeInBatches(this.client, queryString, params, {
          decimalMode: this.options.decimalMode,
          dateParams: this.options.dateParams,
          ...options,
        })
      )
    ) as AsyncGenerator<GenericRowData<T>[], void, void>;
  }

  executeBatchesRaw(
    query: SQL,
    options: ExecuteInBatchesOptions = {}
  ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
    const { sql: queryString, params } = this.prepareQueryExecution(query);
    return this.trackStreamFailures(
      this.afterOpenTransaction(
        executeInBatchesRaw(this.client, queryString, params, {
          decimalMode: this.options.decimalMode,
          dateParams: this.options.dateParams,
          ...options,
        })
      )
    );
  }

  async executeArrow(query: SQL): Promise<unknown> {
    const { sql: queryString, params } = this.prepareQueryExecution(query);
    if (this.waitsForTransactions()) {
      await waitForOpenTransaction(this.client);
    }
    try {
      return await executeArrowOnClient(this.client, queryString, params, {
        decimalMode: this.options.decimalMode,
        dateParams: this.options.dateParams,
      });
    } catch (error) {
      this.recordStatementFailure(error);
      throw error;
    }
  }

  /**
   * Append rows with DuckDB's appender, which is much faster than a
   * multi-row INSERT. Returns the number of rows appended.
   */
  async appendRows(
    table: PgTable,
    rows: readonly Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const { name, schema, columns } = getTableConfig(table);
    // Row objects use the table's property keys, as db.insert() does.
    const keyOf = new Map<PgColumn, string>();
    for (const [key, column] of Object.entries(
      table as unknown as Record<string, PgColumn>
    )) {
      keyOf.set(column, key);
    }
    const byName = new Map(columns.map((column) => [column.name, column]));

    if (this.waitsForTransactions()) {
      await waitForOpenTransaction(this.client);
    }
    try {
      return await appendRowsOnClient(
        this.client,
        { table: name, schema },
        rows.length,
        (columnNames) => {
          const known = new Set(columnNames);
          for (const column of columns) {
            if (!known.has(column.name)) {
              throw new Error(
                `appendRows(): column "${column.name}" is not a column of table "${name}".`
              );
            }
          }
          const plan = columnNames.map((columnName) => {
            const column = byName.get(columnName);
            return column
              ? { column, key: keyOf.get(column) ?? column.name }
              : undefined;
          });
          return (rowIndex, columnIndex) => {
            const entry = plan[columnIndex];
            // Columns the Drizzle table does not declare take their default.
            if (!entry) return APPEND_DEFAULT;
            const { column, key } = entry;
            let value = (rows[rowIndex] as Record<string, unknown>)[key];
            if (value === undefined) {
              if (column.defaultFn !== undefined) {
                value = column.defaultFn();
              } else if (column.onUpdateFn !== undefined) {
                value = column.onUpdateFn();
              } else {
                return APPEND_DEFAULT;
              }
            }
            if (value === null) return null;
            if (is(value, SQL)) {
              throw new Error(
                `appendRows(): column "${column.name}" got a SQL expression, which the appender cannot evaluate. Use db.insert() for such rows.`
              );
            }
            const driverValue = column.mapToDriverValue(value);
            if (is(driverValue, SQL)) {
              throw new Error(
                `appendRows(): column "${column.name}" encodes this value as a SQL literal (a struct, union, empty list, or a list of objects or blobs), which the appender cannot take. Use db.insert() for such rows.`
              );
            }
            return driverValue;
          };
        }
      );
    } catch (error) {
      this.recordStatementFailure(error);
      throw error;
    }
  }

  markRollbackOnly(cause?: unknown): void {
    this.rollbackOnly = true;
    this.rollbackOnlyCause ??= cause;
  }

  isRollbackOnly(): boolean {
    return this.rollbackOnly;
  }
}

type PgTransactionInternals<TRelations extends AnyRelations> = {
  dialect: DuckDBDialect;
  session: DuckDBSession<TRelations>;
};

export class DuckDBTransaction<
  TRelations extends AnyRelations = EmptyRelations,
> extends PgAsyncTransaction<DuckDBQueryResultHKT, TRelations> {
  static override readonly [entityKind]: string = 'DuckDBTransaction';

  constructor(
    dialect: DuckDBDialect,
    session: DuckDBSession<TRelations>,
    relations: TRelations,
    nestedIndex = 0
  ) {
    // Relations arrive as native DuckDB values, so they are not JSON text.
    super(dialect, session, relations, nestedIndex, false);
    this.$with = new DuckDBQueryBuilder(dialect).$with;
  }

  private getInternals(): PgTransactionInternals<TRelations> {
    // drizzle-orm keeps dialect and session internal, but DuckDB transaction
    // helpers need the session for DuckDB-specific execution paths.
    return this as unknown as PgTransactionInternals<TRelations>;
  }

  private markRollbackOnly(cause?: unknown): void {
    this.getInternals().session.markRollbackOnly(cause);
  }

  private selectMethods(withList?: WithSubquery[]) {
    const { dialect, session } = this.getInternals();
    return createDuckDBSelectMethods(session, dialect, withList);
  }

  override with(
    ...queries: WithSubquery[]
  ): ReturnType<PgAsyncTransaction<DuckDBQueryResultHKT, TRelations>['with']> {
    return {
      ...super.with(...queries),
      ...this.selectMethods(queries),
    } as unknown as ReturnType<
      PgAsyncTransaction<DuckDBQueryResultHKT, TRelations>['with']
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

  override rollback(): never {
    throw new TransactionRollbackError();
  }

  /**
   * DuckDB has no SET TRANSACTION statement. Drizzle's version would send one,
   * so this override rejects any config and resolves when none is given.
   */
  override async setTransaction(config?: PgTransactionConfig): Promise<void> {
    assertNoTransactionConfig(config);
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

  /** Append rows inside this transaction. See `db.appendRows()`. */
  appendRows<TTable extends PgTable>(
    table: TTable,
    rows: readonly InferInsertModel<TTable>[]
  ): Promise<number> {
    return this.getInternals().session.appendRows(table, rows);
  }

  override async transaction<T>(
    transaction: (tx: DuckDBTransaction<TRelations>) => Promise<T>
  ): Promise<T> {
    const internals = this.getInternals();
    const savepoint = `drizzle_savepoint_${this.nestedIndex + 1}`;
    const savepointSql = sql.raw(`savepoint ${savepoint}`);
    const releaseSql = sql.raw(`release savepoint ${savepoint}`);
    const rollbackSql = sql.raw(`rollback to savepoint ${savepoint}`);

    const nestedTx = new DuckDBTransaction<TRelations>(
      internals.dialect,
      internals.session,
      this._.relations,
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
    transaction: (tx: DuckDBTransaction<TRelations>) => Promise<T>,
    nestedTx: DuckDBTransaction<TRelations>
  ): Promise<T> {
    return transaction(nestedTx).catch((error) => {
      this.markRollbackOnly(error);
      throw error;
    });
  }
}

export type GenericRowData<T extends RowData = RowData> = T;

export type GenericTableData<T = RowData> = T[];

const arrayLiteralWarning =
  'Received a stringified Postgres-style array literal. Use duckDbList()/duckDbArray() or pass native arrays instead. You can also set rejectStringArrayLiterals=true to throw.';

export interface DuckDBQueryResultHKT extends PgQueryResultHKT {
  type: GenericTableData<Assume<PgRawRow<this['row']>, RowData>>;
}
