import {
  blobValue,
  DuckDBTypeId,
  JSDuckDBValueConverter,
  JsonDuckDBValueConverter,
  listValue,
  timestampTZValue,
  timestampValue,
  type DuckDBArrayType,
  type DuckDBConnection,
  type DuckDBInstance,
  type DuckDBListType,
  type DuckDBType,
  type DuckDBValue,
  type DuckDBValueConverter,
  type JS,
} from '@duckdb/node-api';
import {
  DUCKDB_VALUE_MARKER,
  type AnyDuckDBValueWrapper,
  typedNodeApiParam,
  withNodeApiItemTypeHint,
  wrapperToNodeApiValue,
} from './value-wrappers.ts';
import {
  normalizePositiveInteger,
  type PreparedStatementCacheConfig,
} from './options.ts';
import { isPgArrayLiteral, parsePgArrayLiteral } from './array-literals.ts';
import type { PgDuckClient, PgDuckField, PgDuckQueryResult } from './pgduck.ts';
import {
  bindPreparedStatement,
  clearPreparedStatementCache,
  getPreparedStatementCache,
} from './prepared-statement-cache.ts';
import { assignOwnProperty } from './own-property.ts';

export type DuckDBExecutionClient = DuckDBConnection | PgDuckClient;
export type DuckDBClientLike = DuckDBExecutionClient | DuckDBConnectionPool;
export type RowData = Record<string, unknown>;

export interface DuckDBConnectionPool {
  acquire(): Promise<DuckDBExecutionClient>;
  release(connection: DuckDBExecutionClient): void | Promise<void>;
  close?(): Promise<void> | void;
}

export function isPool(
  client: DuckDBClientLike
): client is DuckDBConnectionPool {
  return typeof (client as DuckDBConnectionPool).acquire === 'function';
}

export interface ExecuteClientOptions {
  /** Return DECIMAL values as exact strings, including nested values. */
  decimalMode?: 'number' | 'string';
  prepareCache?: PreparedStatementCacheConfig;
  /**
   * Read top-level DECIMAL columns as exact strings instead of doubles. The
   * result lists those columns in `exactDecimalColumns`.
   */
  exactDecimals?: boolean;
}

export type ExecuteArraysResult = {
  columns: string[];
  rows: unknown[][];
  /** Indexes of DECIMAL columns read as exact strings (see exactDecimals). */
  exactDecimalColumns?: number[];
};

type MaterializedRows = ExecuteArraysResult;

type ResultColumnsLike = {
  columnNames: () => string[];
  deduplicatedColumnNames?: () => string[];
};

type ResultTypeMetadataLike = ResultColumnsLike & {
  columnCount?: number;
  columnName?: (columnIndex: number) => string;
  columnTypeId?: (columnIndex: number) => number;
};

type ResultJsonRowsLike = {
  getRowsJson?: () => Promise<unknown[][] | undefined>;
  getColumnsObjectJson?: () => Promise<unknown>;
};

type DataChunkLike = {
  rowCount: number;
  convertRows: <T>(converter: DuckDBValueConverter<T>) => (T | null)[][];
  convertColumns?: <T>(converter: DuckDBValueConverter<T>) => (T | null)[][];
};

type ResultChunksLike = {
  fetchAllChunks?: () => Promise<DataChunkLike[]>;
  fetchChunk?: () => Promise<DataChunkLike | null>;
};

type ClosableResource = {
  close?: () => Promise<void> | void;
  closeSync?: () => void;
  end?: () => Promise<void> | void;
};

type DisconnectableResource = ClosableResource & {
  disconnectSync?: () => void;
};

interface PreferredResultReader<T> {
  readDefault: () => Promise<T>;
  readPreferred?: () => Promise<T>;
  wrapError: (error: unknown) => Error;
}

export interface PrepareParamsOptions {
  rejectStringArrayLiterals?: boolean;
  warnOnStringArrayLiteral?: () => void;
  /** Indexes of params bound to non-array columns. They are never coerced. */
  scalarParamIndexes?: ReadonlySet<number>;
}

async function readPreferredResult<T>({
  readDefault,
  readPreferred,
  wrapError,
}: PreferredResultReader<T>): Promise<T> {
  if (readPreferred) {
    try {
      return await readPreferred();
    } catch {
      // Fall back when precision-preserving materialization is unavailable.
    }
  }

  try {
    return await readDefault();
  } catch (error) {
    throw wrapError(error);
  }
}

function isPgDuckClient(client: DuckDBExecutionClient): client is PgDuckClient {
  return typeof (client as PgDuckClient).query === 'function';
}

function isNodeApiConnection(
  client: DuckDBExecutionClient
): client is DuckDBConnection {
  return typeof (client as DuckDBConnection).run === 'function';
}

/*
 * DuckDB closes a connection's open streaming result when the connection runs
 * another query, and node-api then reports a normal end of stream. Streams
 * mark their connection so any other query on it fails instead of cutting the
 * stream short. The same bookkeeping lets close() tell which connections have
 * a query in flight.
 */
const streamingConnections = new WeakSet<object>();
const activeOperationCounts = new WeakMap<object, number>();
const closingConnections = new WeakSet<object>();

const STREAMING_CONNECTION_MESSAGE =
  'This connection is streaming a result from executeBatches(). Finish or break the stream before running another query on the same connection.';
const CLOSING_CONNECTION_MESSAGE =
  'DuckDB connection is closed. The query was interrupted or not started because the connection or its pool was closed.';

/** How long close() waits for interrupted queries to settle. */
const CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const CLOSE_DRAIN_POLL_MS = 10;

function beginOperation(connection: DuckDBConnection): void {
  if (closingConnections.has(connection)) {
    throw new Error(CLOSING_CONNECTION_MESSAGE);
  }
  if (streamingConnections.has(connection)) {
    throw new Error(STREAMING_CONNECTION_MESSAGE);
  }
  activeOperationCounts.set(
    connection,
    (activeOperationCounts.get(connection) ?? 0) + 1
  );
}

function endOperation(connection: DuckDBConnection): void {
  const remaining = (activeOperationCounts.get(connection) ?? 1) - 1;
  if (remaining > 0) {
    activeOperationCounts.set(connection, remaining);
  } else {
    activeOperationCounts.delete(connection);
  }
}

async function runNodeApiOperation<T>(
  connection: DuckDBConnection,
  operation: () => Promise<T>
): Promise<T> {
  beginOperation(connection);
  try {
    return await operation();
  } finally {
    endOperation(connection);
  }
}

function isClientConnectionBusy(connection: object): boolean {
  return activeOperationCounts.has(connection);
}

/**
 * Mark a connection as closing and interrupt its running query, if any. New
 * queries on it fail. Queries in flight reject with DuckDB's interrupt error.
 */
function interruptClientConnection(connection: DuckDBExecutionClient): void {
  if (!isNodeApiConnection(connection)) {
    return;
  }

  closingConnections.add(connection);
  if (isClientConnectionBusy(connection)) {
    try {
      (connection as { interrupt?: () => void }).interrupt?.();
    } catch {
      // The connection may already be gone. close() handles the rest.
    }
  }
}

/**
 * Interrupt a closing connection until its queries settle or the timeout
 * passes. DuckDB drops an interrupt that arrives before a query starts, so it
 * is sent again while the connection stays busy.
 */
async function waitForClientConnectionIdle(
  connection: DuckDBExecutionClient,
  timeoutMs: number = CLOSE_DRAIN_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isClientConnectionBusy(connection) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLOSE_DRAIN_POLL_MS));
    interruptClientConnection(connection);
  }
}

async function withConnection<T>(
  client: DuckDBClientLike,
  callback: (connection: DuckDBExecutionClient) => Promise<T>
): Promise<T> {
  if (!isPool(client)) {
    return await callback(client);
  }

  const connection = await client.acquire();
  try {
    return await callback(connection);
  } finally {
    await client.release(connection);
  }
}

async function* withConnectionStream<T>(
  client: DuckDBClientLike,
  callback: (connection: DuckDBExecutionClient) => AsyncGenerator<T, void, void>
): AsyncGenerator<T, void, void> {
  if (!isPool(client)) {
    yield* callback(client);
    return;
  }

  const connection = await client.acquire();
  try {
    yield* callback(connection);
  } finally {
    await client.release(connection);
  }
}

export function prepareParams(
  params: unknown[],
  options: PrepareParamsOptions = {}
): unknown[] {
  let preparedParams = params;

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    if (
      typeof param === 'string' &&
      param.length > 0 &&
      !options.scalarParamIndexes?.has(index)
    ) {
      const trimmed = param.trim();

      if (trimmed && isPgArrayLiteral(trimmed)) {
        if (options.rejectStringArrayLiterals) {
          throw new Error(
            'Stringified array literals are not supported. Use duckDbList()/duckDbArray() or pass native arrays.'
          );
        }

        if (options.warnOnStringArrayLiteral) {
          options.warnOnStringArrayLiteral();
        }
        const nextValue = parsePgArrayLiteral(trimmed);
        if (nextValue !== param) {
          if (preparedParams === params) {
            preparedParams = params.slice();
          }
          preparedParams[index] = nextValue;
        }
      }
    }
  }

  return preparedParams;
}

/**
 * Convert a value to DuckDB Node API value.
 * Handles wrapper types and plain values for backward compatibility.
 * Optimized for the common case (primitives) in the hot path.
 *
 * `typeHint` is the declared type of the value when it is an item of a
 * wrapper with an element type. A Date bound to TIMESTAMPTZ becomes a
 * TIMESTAMPTZ value, so DuckDB does not read it in the session time zone.
 */
function toNodeApiValue(value: unknown, typeHint?: DuckDBType): DuckDBValue {
  // Fast path 1: null/undefined
  if (value == null) return null;

  // Fast path 2: primitives (most common)
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') {
    return value as DuckDBValue;
  }

  // Fast path 3: pre-wrapped DuckDB value (Symbol check ~2-3ns)
  if (t === 'object' && DUCKDB_VALUE_MARKER in (value as object)) {
    return wrapperToNodeApiValue(
      value as AnyDuckDBValueWrapper,
      toNodeApiValue
    );
  }

  // Legacy path: plain arrays (backward compatibility)
  if (Array.isArray(value)) {
    const itemType =
      typeHint?.typeId === DuckDBTypeId.LIST ||
      typeHint?.typeId === DuckDBTypeId.ARRAY
        ? (typeHint as DuckDBListType | DuckDBArrayType).valueType
        : undefined;
    return withNodeApiItemTypeHint(
      listValue(value.map((inner) => toNodeApiValue(inner, itemType))),
      itemType
    );
  }

  // Date conversion to timestamp. A bare Date binds as a naive UTC TIMESTAMP.
  if (value instanceof Date) {
    const millis = value.getTime();
    if (Number.isNaN(millis)) {
      throw new Error('Invalid Date parameter: cannot bind an invalid Date');
    }
    const micros = BigInt(millis) * 1000n;
    return typeHint?.typeId === DuckDBTypeId.TIMESTAMP_TZ
      ? timestampTZValue(micros)
      : timestampValue(micros);
  }

  if (value instanceof Uint8Array) {
    // node-api expects a plain Uint8Array, as blob wrappers pass it.
    return blobValue(value instanceof Buffer ? new Uint8Array(value) : value);
  }

  // Fallback for unknown objects
  return value as DuckDBValue;
}

type NodeApiParams = {
  values: DuckDBValue[] | undefined;
  /**
   * Explicit bind types, as a sparse array. node-api infers the type of a
   * param whose entry is empty.
   */
  types: DuckDBType[] | undefined;
};

const NO_NODE_API_PARAMS: NodeApiParams = {
  values: undefined,
  types: undefined,
};

function toNodeApiParams(params: unknown[]): NodeApiParams {
  if (params.length === 0) {
    return NO_NODE_API_PARAMS;
  }

  const values: DuckDBValue[] = new Array(params.length);
  let types: DuckDBType[] | undefined;

  for (let index = 0; index < params.length; index += 1) {
    const value = toNodeApiValue(params[index]);
    values[index] = value;

    // Primitives other than integers outside int32 bind correctly as they are.
    if (
      value !== null &&
      (typeof value === 'object' ||
        (typeof value === 'number' &&
          Number.isInteger(value) &&
          (value > 2_147_483_647 || value < -2_147_483_648)))
    ) {
      const typed = typedNodeApiParam(value);
      if (typed) {
        values[index] = typed.value;
        types ??= new Array(params.length);
        types[index] = typed.type;
      }
    }
  }

  return { values, types };
}

function wrapperToPgDuckValue(wrapper: AnyDuckDBValueWrapper): unknown {
  switch (wrapper.kind) {
    case 'list':
    case 'array':
      return wrapper.data.map((item) => toPgDuckValue(item));
    case 'struct':
    case 'map':
      return Object.fromEntries(
        Object.entries(wrapper.data).map(([key, value]) => [
          key,
          toPgDuckValue(value),
        ])
      );
    case 'json':
      return JSON.stringify(wrapper.data);
    case 'timestamp':
      return wrapper.data;
    case 'blob':
      return wrapper.data instanceof Buffer
        ? wrapper.data
        : Buffer.from(wrapper.data);
    default: {
      const _exhaustive: never = wrapper;
      throw new Error(
        `Unknown wrapper kind: ${(_exhaustive as AnyDuckDBValueWrapper).kind}`
      );
    }
  }
}

function toPgDuckValue(value: unknown): unknown {
  if (value == null) return null;

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }

  if (typeof value === 'object' && DUCKDB_VALUE_MARKER in value) {
    return wrapperToPgDuckValue(value as AnyDuckDBValueWrapper);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPgDuckValue(item));
  }

  if (value instanceof Uint8Array) {
    return value instanceof Buffer ? value : Buffer.from(value);
  }

  return value;
}

function toPgDuckValues(params: unknown[]): unknown[] {
  return params.map((param) => toPgDuckValue(param));
}

function deduplicateColumns(columns: string[]): string[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  let deduplicated: string[] | undefined;

  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index] as string;
    let candidate = column;

    if (used.has(candidate)) {
      let suffix = nextSuffix.get(column) ?? 1;
      do {
        candidate = `${column}_${suffix}`;
        suffix += 1;
      } while (used.has(candidate));

      nextSuffix.set(column, suffix);
      deduplicated ??= columns.slice();
      deduplicated[index] = candidate;
    }

    used.add(candidate);
  }

  return deduplicated ?? columns;
}

function normalizeDeduplicatedColumns(
  columns: string[],
  deduplicatedColumns: string[]
): string[] {
  if (columns.length !== deduplicatedColumns.length) {
    return deduplicateColumns(deduplicatedColumns);
  }

  const normalized = deduplicatedColumns.map((column, index) => {
    const original = columns[index];
    if (column === original) {
      return column;
    }

    const duplicatePrefix = `${original}:`;
    if (column.startsWith(duplicatePrefix)) {
      const suffix = column.slice(duplicatePrefix.length);
      if (/^\d+$/.test(suffix)) {
        return `${original}_${suffix}`;
      }
    }

    return column;
  });

  return deduplicateColumns(normalized);
}

function resolveResultColumns(result: ResultColumnsLike): string[] {
  const columns = result.columnNames();

  if (typeof result.deduplicatedColumnNames === 'function') {
    return normalizeDeduplicatedColumns(
      columns,
      result.deduplicatedColumnNames()
    );
  }

  return deduplicateColumns(columns);
}

function isUnsupportedNodeApiTypeError(error: unknown): boolean {
  return (
    error instanceof Error && /^Unexpected type id: \d+/.test(error.message)
  );
}

const JSON_RESULT_TYPE_IDS = new Set([22, 30, 39]);
const UNSUPPORTED_JS_RESULT_TYPE_IDS = new Set([0, 40, 41]);

function prefersJsonMaterialization(result: ResultTypeMetadataLike): boolean {
  if (
    typeof result.columnCount !== 'number' ||
    typeof result.columnTypeId !== 'function'
  ) {
    return false;
  }

  for (
    let columnIndex = 0;
    columnIndex < result.columnCount;
    columnIndex += 1
  ) {
    if (JSON_RESULT_TYPE_IDS.has(result.columnTypeId(columnIndex))) {
      return true;
    }
  }

  return false;
}

function findUnsupportedNodeApiColumns(
  result: ResultTypeMetadataLike
): string[] {
  if (
    typeof result.columnCount !== 'number' ||
    typeof result.columnName !== 'function' ||
    typeof result.columnTypeId !== 'function'
  ) {
    return [];
  }

  const unsupportedColumns: string[] = [];
  for (
    let columnIndex = 0;
    columnIndex < result.columnCount;
    columnIndex += 1
  ) {
    if (UNSUPPORTED_JS_RESULT_TYPE_IDS.has(result.columnTypeId(columnIndex))) {
      unsupportedColumns.push(result.columnName(columnIndex));
    }
  }

  return unsupportedColumns;
}

function wrapUnsupportedNodeApiTypeError(
  result: ResultTypeMetadataLike,
  error: unknown
): Error {
  if (!isUnsupportedNodeApiTypeError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const unsupportedColumns = findUnsupportedNodeApiColumns(result);
  const columnsText =
    unsupportedColumns.length > 0
      ? ` for column${
          unsupportedColumns.length === 1 ? '' : 's'
        } ${unsupportedColumns.map((column) => `"${column}"`).join(', ')}`
      : '';

  const wrapped = new Error(
    `DuckDB returned a column type that @duckdb/node-api cannot materialize to JavaScript${columnsText}. Cast those columns to a supported representation before selecting them, for example CAST(col AS VARCHAR), variant_extract(...), ST_AsText(...), or ST_AsWKB(...).`
  );
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

/**
 * TIMESTAMP_NS, TIME_TZ and TIME_NS columns read as DuckDB strings, which keep
 * the precision a JS value would lose. Every other column keeps its JS value,
 * so a column's shape does not depend on what else is selected. Nested values
 * use the JS converter, as they do in a result without such columns.
 */
const PerColumnValueConverter: DuckDBValueConverter<JS> = (value, type) =>
  JSON_RESULT_TYPE_IDS.has(type.typeId)
    ? JsonDuckDBValueConverter(value, type, JsonDuckDBValueConverter)
    : JSDuckDBValueConverter(value, type, JSDuckDBValueConverter);

/**
 * Read top-level DECIMAL values as their exact text, which a double would
 * round, for example DECIMAL(38,10). Nested values keep `converter`.
 */
function withExactDecimals(
  converter: DuckDBValueConverter<JS>,
  recursive = false
): DuckDBValueConverter<JS> {
  const nested: DuckDBValueConverter<JS> = (value, type) =>
    type.typeId === DuckDBTypeId.DECIMAL
      ? value === null
        ? null
        : String(value)
      : JSDuckDBValueConverter(value, type, nested);
  return (value, type) =>
    type.typeId === DuckDBTypeId.DECIMAL
      ? value === null
        ? null
        : String(value)
      : recursive && !JSON_RESULT_TYPE_IDS.has(type.typeId)
        ? nested(value, type, nested)
        : converter(value, type, converter);
}

function findDecimalColumns(result: ResultTypeMetadataLike): number[] {
  if (
    typeof result.columnCount !== 'number' ||
    typeof result.columnTypeId !== 'function'
  ) {
    return [];
  }
  const columns: number[] = [];
  for (let index = 0; index < result.columnCount; index += 1) {
    if (result.columnTypeId(index) === DuckDBTypeId.DECIMAL) {
      columns.push(index);
    }
  }
  return columns;
}

/**
 * Reading chunks consumes a node-api result, so a reader that fails partway
 * must not be retried on the same result: the retry sees no rows. Convert the
 * fetched chunks instead, which can be retried with another converter.
 */
function convertChunkRows(
  chunks: DataChunkLike[],
  preferJson: boolean,
  exactDecimals = false,
  recursiveDecimals = false
): unknown[][] {
  const convert = <T>(converter: DuckDBValueConverter<T>) => {
    const rows: unknown[][] = [];
    for (const chunk of chunks) {
      for (const row of chunk.convertRows(converter)) {
        rows.push(row);
      }
    }
    return rows;
  };

  const finish = (converter: DuckDBValueConverter<JS>) =>
    convert(
      exactDecimals || recursiveDecimals
        ? withExactDecimals(converter, recursiveDecimals)
        : converter
    );

  if (preferJson) {
    try {
      return finish(PerColumnValueConverter);
    } catch {
      // Fall back when precision-preserving materialization is unavailable.
    }
  }

  return finish(JSDuckDBValueConverter);
}

async function readResultChunkRows(
  result: ResultTypeMetadataLike &
    Required<Pick<ResultChunksLike, 'fetchAllChunks'>>,
  exactDecimals = false,
  recursiveDecimals = false
): Promise<unknown[][]> {
  try {
    return convertChunkRows(
      await result.fetchAllChunks(),
      prefersJsonMaterialization(result),
      exactDecimals,
      recursiveDecimals
    );
  } catch (error) {
    throw wrapUnsupportedNodeApiTypeError(result, error);
  }
}

function hasFetchAllChunks<T extends ResultChunksLike>(
  result: T
): result is T & Required<Pick<ResultChunksLike, 'fetchAllChunks'>> {
  return typeof result.fetchAllChunks === 'function';
}

async function materializeResultRows(
  result: {
    getRowsJS: () => Promise<unknown[][] | undefined>;
  } & ResultTypeMetadataLike &
    ResultJsonRowsLike &
    ResultChunksLike,
  exactDecimals = false,
  recursiveDecimals = false
): Promise<MaterializedRows> {
  if (hasFetchAllChunks(result)) {
    const exactDecimalColumns =
      exactDecimals || recursiveDecimals ? findDecimalColumns(result) : [];
    const rows = await readResultChunkRows(
      result,
      exactDecimalColumns.length > 0,
      recursiveDecimals
    );
    return exactDecimalColumns.length > 0
      ? { columns: resolveResultColumns(result), rows, exactDecimalColumns }
      : { columns: resolveResultColumns(result), rows };
  }

  const getRowsJson =
    typeof result.getRowsJson === 'function'
      ? result.getRowsJson.bind(result)
      : undefined;
  const rows = await readPreferredResult({
    readDefault: async () => (await result.getRowsJS()) ?? [],
    readPreferred:
      prefersJsonMaterialization(result) && getRowsJson
        ? async () => (await getRowsJson()) ?? []
        : undefined,
    wrapError: (error) => wrapUnsupportedNodeApiTypeError(result, error),
  });
  const columns = resolveResultColumns(result);

  return { columns, rows };
}

/**
 * DuckDB prepares one statement at a time. SQL with several statements, or
 * with only comments, cannot be cached and runs through connection.run().
 */
function isUnpreparableQueryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Cannot prepare multiple statements at once|No statement to prepare/.test(
      error.message
    )
  );
}

async function executePreparedQuery(
  connection: DuckDBConnection,
  query: string,
  { values, types }: NodeApiParams,
  cacheConfig: PreparedStatementCacheConfig,
  exactDecimals = false,
  recursiveDecimals = false
): Promise<MaterializedRows> {
  const cache = getPreparedStatementCache(connection, cacheConfig.size);

  return await cache.runExclusive(async () => {
    let statement;
    try {
      statement = await cache.getOrPrepare(query);
    } catch (error) {
      if (!isUnpreparableQueryError(error)) {
        throw error;
      }
      const result = await connection.run(query, values, types);
      return await materializeResultRows(
        result,
        exactDecimals,
        recursiveDecimals
      );
    }

    try {
      bindPreparedStatement(statement, values, types);
      const result = await statement.run();
      cache.remember(query, statement);
      return await materializeResultRows(
        result,
        exactDecimals,
        recursiveDecimals
      );
    } catch (error) {
      cache.evict(query);
      throw error;
    }
  });
}

type StreamResultLike = ResultTypeMetadataLike &
  ResultChunksLike & {
    yieldRowsJs: () => AsyncIterable<unknown[][]>;
    yieldRowsJson?: () => AsyncIterable<unknown[][]>;
    close?: () => Promise<void> | void;
    cancel?: () => Promise<void> | void;
  };

async function* yieldChunkRows(
  fetchChunk: () => Promise<DataChunkLike | null>,
  preferJson: boolean,
  exactDecimals = false
): AsyncGenerator<unknown[][], void, void> {
  let useJson = preferJson;
  let yieldedRows = false;

  while (true) {
    const chunk = await fetchChunk();
    if (!chunk || chunk.rowCount === 0) {
      return;
    }

    let rows: unknown[][] | undefined;
    if (useJson) {
      try {
        rows = chunk.convertRows(
          exactDecimals
            ? withExactDecimals(PerColumnValueConverter, true)
            : PerColumnValueConverter
        );
      } catch (error) {
        // Earlier chunks used string values. Switching now would mix formats.
        if (yieldedRows) {
          throw error;
        }
        useJson = false;
      }
    }

    rows ??= chunk.convertRows(
      exactDecimals
        ? withExactDecimals(JSDuckDBValueConverter, true)
        : JSDuckDBValueConverter
    );
    yieldedRows = true;
    yield rows;
  }
}

async function closeStreamResult(result: StreamResultLike): Promise<void> {
  try {
    if (typeof result.close === 'function') {
      await result.close();
      return;
    }
    if (typeof result.cancel === 'function') {
      await result.cancel();
    }
  } catch {
    // Ignore cleanup errors because stream consumers already handled main errors.
  }
}

async function materializeRows(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteClientOptions = {}
): Promise<MaterializedRows> {
  return await withConnection(client, async (connection) => {
    if (isPgDuckClient(connection)) {
      return await materializePgDuckRows(connection, query, params);
    }

    return await runNodeApiOperation(connection, async () => {
      const nodeApiParams = toNodeApiParams(params);

      if (options.prepareCache && typeof connection.prepare === 'function') {
        return await executePreparedQuery(
          connection,
          query,
          nodeApiParams,
          options.prepareCache,
          options.exactDecimals,
          options.decimalMode === 'string'
        );
      }

      const result = await connection.run(
        query,
        nodeApiParams.values,
        nodeApiParams.types
      );
      return await materializeResultRows(
        result,
        options.exactDecimals,
        options.decimalMode === 'string'
      );
    });
  });
}

type NormalizedPgDuckResult = {
  rows: unknown[];
  fields?: PgDuckField[];
};

function isPgDuckQueryResult(value: unknown): value is PgDuckQueryResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as PgDuckQueryResult).rows) &&
    'fields' in value &&
    ('command' in value || 'rowCount' in value)
  );
}

function normalizePgDuckResult(
  result: PgDuckQueryResult | unknown[]
): NormalizedPgDuckResult {
  if (!Array.isArray(result)) {
    return { rows: result.rows, fields: result.fields };
  }

  // node-postgres returns one Result per statement for multi-statement SQL.
  // Use the last statement's rows, as node-api does.
  const last = result[result.length - 1];
  if (isPgDuckQueryResult(last)) {
    return { rows: last.rows, fields: last.fields };
  }

  return { rows: result, fields: undefined };
}

function getPgDuckFieldNames(fields: PgDuckField[] | undefined): string[] {
  return fields?.map((field) => field.name) ?? [];
}

function materializedRows(
  columns: string[],
  rows: unknown[][]
): MaterializedRows {
  return { columns: deduplicateColumns(columns), rows };
}

function mapObjectRowsToArrays(
  rows: RowData[],
  columns: string[]
): unknown[][] {
  return rows.map((row) => columns.map((column) => row[column]));
}

function materializePgDuckResultRows(
  result: NormalizedPgDuckResult
): MaterializedRows {
  const { rows } = result;
  const fieldColumns = getPgDuckFieldNames(result.fields);

  if (rows.length === 0) {
    return materializedRows(fieldColumns, []);
  }

  const firstRow = rows[0];
  if (Array.isArray(firstRow)) {
    if (fieldColumns.length === 0 && firstRow.length > 0) {
      throw new Error(
        'pg_duckdb client returned array rows without field metadata. Return `fields` with rowMode "array" results, or return object rows.'
      );
    }
    return materializedRows(fieldColumns, rows as unknown[][]);
  }

  const columns =
    fieldColumns.length > 0 ? fieldColumns : Object.keys(firstRow as RowData);

  return materializedRows(
    columns,
    mapObjectRowsToArrays(rows as RowData[], columns)
  );
}

async function materializePgDuckRows(
  client: PgDuckClient,
  query: string,
  params: unknown[]
): Promise<MaterializedRows> {
  return materializePgDuckResultRows(
    normalizePgDuckResult(
      await client.query({
        text: query,
        values: toPgDuckValues(params),
        rowMode: 'array',
      })
    )
  );
}

function mapRowsToObjects(columns: string[], rows: unknown[][]): RowData[] {
  const mappedRows: RowData[] = new Array(rows.length);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex] as unknown[];
    const row: RowData = {};

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      assignOwnProperty(
        row,
        columns[columnIndex] as string,
        values[columnIndex]
      );
    }

    mappedRows[rowIndex] = row;
  }

  return mappedRows;
}

function mapRowsToColumnData(
  columns: string[],
  rows: unknown[][]
): Record<string, unknown[]> {
  const columnData: Record<string, unknown[]> = {};
  const valuesByColumn: unknown[][] = [];

  for (const column of columns) {
    const values: unknown[] = [];
    assignOwnProperty(columnData, column, values);
    valuesByColumn.push(values);
  }

  for (const row of rows) {
    for (let index = 0; index < columns.length; index += 1) {
      valuesByColumn[index]?.push(row[index]);
    }
  }

  return columnData;
}

/**
 * Close a connection. A query still running on a node-api connection is
 * interrupted first, because disconnecting under it leaves its promise
 * pending forever. `drainTimeoutMs` bounds the wait for it to settle.
 */
export async function closeClientConnection(
  connection: DuckDBExecutionClient,
  drainTimeoutMs: number = CLOSE_DRAIN_TIMEOUT_MS
): Promise<void> {
  if (isNodeApiConnection(connection)) {
    interruptClientConnection(connection);
    await waitForClientConnectionIdle(connection, drainTimeoutMs);
    clearPreparedStatementCache(connection);
  }

  await closeDuckDbResource(connection as DisconnectableResource, true);
}

export async function closeDuckDbInstance(
  instance: DuckDBInstance
): Promise<void> {
  await closeDuckDbResource(instance as ClosableResource);
}

async function closeDuckDbResource(
  resource: DisconnectableResource,
  allowDisconnectSync = false
): Promise<void> {
  if (typeof resource.close === 'function') {
    await resource.close();
    return;
  }

  if (typeof resource.closeSync === 'function') {
    resource.closeSync();
    return;
  }

  if (typeof resource.end === 'function') {
    await resource.end();
    return;
  }

  if (allowDisconnectSync && typeof resource.disconnectSync === 'function') {
    resource.disconnectSync();
  }
}

export async function executeOnClient(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteClientOptions = {}
): Promise<RowData[]> {
  const { columns, rows } = await materializeRows(
    client,
    query,
    params,
    options
  );

  if (!rows || rows.length === 0) {
    return [];
  }

  return mapRowsToObjects(columns, rows);
}

export async function executeArraysOnClient(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteClientOptions = {}
): Promise<ExecuteArraysResult> {
  return await materializeRows(client, query, params, options);
}

export interface ExecuteInBatchesOptions {
  rowsPerChunk?: number;
  decimalMode?: 'number' | 'string';
}

export interface ExecuteBatchesRawChunk {
  columns: string[];
  rows: unknown[][];
}

function resolveRowsPerChunk(
  options: ExecuteInBatchesOptions | undefined
): number {
  return normalizePositiveInteger(options?.rowsPerChunk, 100_000);
}

async function* chunkRowStream(
  rowStream: AsyncIterable<unknown[][]>,
  columns: string[],
  rowsPerChunk: number
): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
  let rows: unknown[][] = [];
  for await (const chunk of rowStream) {
    for (const row of chunk) {
      rows.push(row);
      if (rows.length >= rowsPerChunk) {
        yield { columns, rows };
        rows = [];
      }
    }
  }
  if (rows.length > 0) yield { columns, rows };
}

async function* chunkRows(
  rowStream: Iterable<unknown[]>,
  columns: string[],
  rowsPerChunk: number
): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
  let rows: unknown[][] = [];

  for (const row of rowStream) {
    rows.push(row);
    if (rows.length >= rowsPerChunk) {
      yield { columns, rows };
      rows = [];
    }
  }

  if (rows.length > 0) {
    yield { columns, rows };
  }
}

async function* streamRawBatches(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteInBatchesOptions = {}
): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
  yield* withConnectionStream(
    client,
    async function* (connection): AsyncGenerator<ExecuteBatchesRawChunk> {
      const rowsPerChunk = resolveRowsPerChunk(options);

      if (isPgDuckClient(connection)) {
        const { columns, rows } = await materializePgDuckRows(
          connection,
          query,
          params
        );
        yield* chunkRows(rows, columns, rowsPerChunk);
        return;
      }

      // Mark the connection until the stream ends, is broken or throws.
      beginOperation(connection);
      streamingConnections.add(connection);
      let result: StreamResultLike | undefined;

      try {
        const { values, types } = toNodeApiParams(params);
        result = (await connection.stream(
          query,
          values,
          types
        )) as StreamResultLike;
        yield* streamNodeApiResult(
          connection,
          result,
          rowsPerChunk,
          options.decimalMode === 'string'
        );
      } finally {
        if (result) {
          await closeStreamResult(result);
        }
        streamingConnections.delete(connection);
        endOperation(connection);
      }
    }
  );
}

async function* streamNodeApiResult(
  connection: DuckDBConnection,
  result: StreamResultLike,
  rowsPerChunk: number,
  exactDecimals = false
): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
  const columns = resolveResultColumns(result);
  const resultFetchChunk =
    typeof result.fetchChunk === 'function'
      ? result.fetchChunk.bind(result)
      : undefined;
  // An interrupt from close() ends the stream with an empty chunk, the same
  // as its real end. Report it as an error instead of a short result.
  const fetchChunk = resultFetchChunk
    ? async () => {
        if (closingConnections.has(connection)) {
          throw new Error(CLOSING_CONNECTION_MESSAGE);
        }
        const chunk = await resultFetchChunk();
        if (
          (!chunk || chunk.rowCount === 0) &&
          closingConnections.has(connection)
        ) {
          throw new Error(CLOSING_CONNECTION_MESSAGE);
        }
        return chunk;
      }
    : undefined;
  const preferJson =
    prefersJsonMaterialization(result) &&
    typeof result.yieldRowsJson === 'function';

  try {
    if (fetchChunk) {
      yield* chunkRowStream(
        yieldChunkRows(
          fetchChunk,
          prefersJsonMaterialization(result),
          exactDecimals
        ),
        columns,
        rowsPerChunk
      );
      return;
    }

    if (preferJson) {
      let yieldedJsonRows = false;
      try {
        for await (const chunk of chunkRowStream(
          result.yieldRowsJson!(),
          columns,
          rowsPerChunk
        )) {
          yieldedJsonRows = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (yieldedJsonRows) {
          throw error;
        }
      }
    }

    yield* chunkRowStream(result.yieldRowsJs(), columns, rowsPerChunk);
  } catch (error) {
    throw wrapUnsupportedNodeApiTypeError(result, error);
  }
}

/**
 * Stream results from DuckDB in batches to avoid fully materializing rows in JS.
 */
export async function* executeInBatches(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteInBatchesOptions = {}
): AsyncGenerator<RowData[], void, void> {
  for await (const chunk of streamRawBatches(client, query, params, options)) {
    yield mapRowsToObjects(chunk.columns, chunk.rows);
  }
}

export async function* executeInBatchesRaw(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteInBatchesOptions = {}
): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
  yield* streamRawBatches(client, query, params, options);
}

/**
 * Return columnar results when the underlying node-api exposes an Arrow/columnar API.
 * Falls back to column-major JS arrays when Arrow is unavailable.
 */
export async function executeArrowOnClient(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: Pick<ExecuteClientOptions, 'decimalMode'> = {}
): Promise<unknown> {
  return await withConnection(client, async (connection) => {
    if (isPgDuckClient(connection)) {
      const { columns, rows } = await materializePgDuckRows(
        connection,
        query,
        params
      );
      return mapRowsToColumnData(columns, rows);
    }

    return await runNodeApiOperation(connection, async () => {
      const { values, types } = toNodeApiParams(params);
      const result = await connection.run(query, values, types);

      // Runtime detection for Arrow API support (optional method, not in base type)
      const maybeArrow =
        (result as unknown as { toArrow?: () => Promise<unknown> }).toArrow ??
        (result as unknown as { getArrowTable?: () => Promise<unknown> })
          .getArrowTable;

      if (typeof maybeArrow === 'function') {
        return await maybeArrow.call(result);
      }

      // Fallback: return column-major JS arrays to avoid per-row object creation.
      const resultMetadata = result as unknown as ResultTypeMetadataLike &
        ResultChunksLike;
      if (hasFetchAllChunks(resultMetadata)) {
        const chunks = await resultMetadata.fetchAllChunks();
        const columns = resolveResultColumns(resultMetadata);
        const convert = (baseConverter: DuckDBValueConverter<JS>) => {
          const converter =
            options.decimalMode === 'string'
              ? withExactDecimals(baseConverter, true)
              : baseConverter;
          const values: unknown[][] = columns.map(() => []);
          for (const chunk of chunks) {
            if (typeof chunk.convertColumns === 'function') {
              const converted = chunk.convertColumns(converter);
              for (let index = 0; index < columns.length; index += 1) {
                for (const value of converted[index] ?? [])
                  values[index]!.push(value);
              }
            } else {
              for (const row of chunk.convertRows(converter)) {
                for (let index = 0; index < columns.length; index += 1)
                  values[index]!.push(row[index]);
              }
            }
          }
          const data: Record<string, unknown[]> = {};
          columns.forEach((name, index) =>
            assignOwnProperty(data, name, values[index])
          );
          return data;
        };
        try {
          if (prefersJsonMaterialization(resultMetadata)) {
            try {
              return convert(PerColumnValueConverter);
            } catch {
              /* Retry fetched chunks safely. */
            }
          }
          return convert(JSDuckDBValueConverter);
        } catch (error) {
          throw wrapUnsupportedNodeApiTypeError(resultMetadata, error);
        }
      }

      const resultJsonRows = result as ResultJsonRowsLike;
      const getColumnsObjectJson =
        typeof resultJsonRows.getColumnsObjectJson === 'function'
          ? resultJsonRows.getColumnsObjectJson.bind(result)
          : undefined;
      return await readPreferredResult({
        readDefault: () => result.getColumnsObjectJS(),
        readPreferred:
          prefersJsonMaterialization(resultMetadata) && getColumnsObjectJson
            ? () => getColumnsObjectJson()
            : undefined,
        wrapError: (error) =>
          wrapUnsupportedNodeApiTypeError(resultMetadata, error),
      });
    });
  });
}
