import {
  listValue,
  timestampValue,
  type DuckDBConnection,
  type DuckDBInstance,
  type DuckDBPreparedStatement,
  type DuckDBValue,
} from '@duckdb/node-api';
import {
  DUCKDB_VALUE_MARKER,
  wrapperToNodeApiValue,
  type AnyDuckDBValueWrapper,
} from './value-wrappers.ts';
import {
  normalizePositiveInteger,
  type PreparedStatementCacheConfig,
} from './options.ts';
import { isPgArrayLiteral, parsePgArrayLiteral } from './array-literals.ts';

export type DuckDBClientLike = DuckDBConnection | DuckDBConnectionPool;
export type RowData = Record<string, unknown>;

export interface DuckDBConnectionPool {
  acquire(): Promise<DuckDBConnection>;
  release(connection: DuckDBConnection): void | Promise<void>;
  close?(): Promise<void> | void;
}

export function isPool(
  client: DuckDBClientLike
): client is DuckDBConnectionPool {
  return typeof (client as DuckDBConnectionPool).acquire === 'function';
}

export interface ExecuteClientOptions {
  prepareCache?: PreparedStatementCacheConfig;
}

export type ExecuteArraysResult = { columns: string[]; rows: unknown[][] };

type MaterializedRows = ExecuteArraysResult;

type PreparedCacheEntry = {
  statement: DuckDBPreparedStatement;
};

type PreparedStatementCache = {
  size: number;
  entries: Map<string, PreparedCacheEntry>;
};

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

type ClosableResource = {
  close?: () => Promise<void> | void;
  closeSync?: () => void;
};

type DisconnectableResource = ClosableResource & {
  disconnectSync?: () => void;
};

const PREPARED_CACHE = Symbol.for('drizzle-duckdb:prepared-cache');

interface PreferredResultReader<T> {
  readDefault: () => Promise<T>;
  readPreferred?: () => Promise<T>;
  wrapError: (error: unknown) => Error;
}

export interface PrepareParamsOptions {
  rejectStringArrayLiterals?: boolean;
  warnOnStringArrayLiteral?: () => void;
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

async function withConnection<T>(
  client: DuckDBClientLike,
  callback: (connection: DuckDBConnection) => Promise<T>
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
  callback: (connection: DuckDBConnection) => AsyncGenerator<T, void, void>
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
    if (typeof param === 'string' && param.length > 0) {
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
 */
function toNodeApiValue(value: unknown): DuckDBValue {
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
    return listValue(value.map((inner) => toNodeApiValue(inner)));
  }

  // Date conversion to timestamp
  if (value instanceof Date) {
    return timestampValue(BigInt(value.getTime()) * 1000n);
  }

  // Fallback for unknown objects
  return value as DuckDBValue;
}

function toNodeApiValues(params: unknown[]): DuckDBValue[] | undefined {
  return params.length > 0
    ? (params.map((param) => toNodeApiValue(param)) as DuckDBValue[])
    : undefined;
}

function deduplicateColumns(columns: string[]): string[] {
  const counts = new Map<string, number>();
  let hasDuplicates = false;

  for (const column of columns) {
    const next = (counts.get(column) ?? 0) + 1;
    counts.set(column, next);
    if (next > 1) {
      hasDuplicates = true;
      break;
    }
  }

  if (!hasDuplicates) {
    return columns;
  }

  counts.clear();
  return columns.map((column) => {
    const count = counts.get(column) ?? 0;
    counts.set(column, count + 1);
    return count === 0 ? column : `${column}_${count}`;
  });
}

function normalizeDeduplicatedColumns(
  columns: string[],
  deduplicatedColumns: string[]
): string[] {
  if (columns.length !== deduplicatedColumns.length) {
    return deduplicatedColumns;
  }

  let changed = false;
  const normalized = deduplicatedColumns.map((column, index) => {
    const original = columns[index];
    if (column === original) {
      return column;
    }

    const duplicatePrefix = `${original}:`;
    if (column.startsWith(duplicatePrefix)) {
      const suffix = column.slice(duplicatePrefix.length);
      if (/^\d+$/.test(suffix)) {
        changed = true;
        return `${original}_${suffix}`;
      }
    }

    return column;
  });

  return changed ? normalized : deduplicatedColumns;
}

function destroyPreparedStatement(entry: PreparedCacheEntry | undefined): void {
  if (!entry) return;
  try {
    entry.statement.destroySync();
  } catch {
    // Ignore cleanup errors
  }
}

function getPreparedCache(
  connection: DuckDBConnection,
  size: number
): PreparedStatementCache {
  const store = connection as unknown as Record<
    symbol,
    PreparedStatementCache | undefined
  >;
  const existing = store[PREPARED_CACHE];
  if (existing) {
    existing.size = size;
    return existing;
  }

  const cache: PreparedStatementCache = { size, entries: new Map() };
  store[PREPARED_CACHE] = cache;
  return cache;
}

function evictOldest(cache: PreparedStatementCache): void {
  const oldest = cache.entries.keys().next();
  if (!oldest.done) {
    const key = oldest.value as string;
    const entry = cache.entries.get(key);
    cache.entries.delete(key);
    destroyPreparedStatement(entry);
  }
}

function evictCacheEntry(cache: PreparedStatementCache, key: string): void {
  const entry = cache.entries.get(key);
  cache.entries.delete(key);
  destroyPreparedStatement(entry);
}

function rememberPreparedStatement(
  cache: PreparedStatementCache,
  query: string,
  statement: DuckDBPreparedStatement
): DuckDBPreparedStatement {
  cache.entries.delete(query);
  cache.entries.set(query, { statement });
  return statement;
}

async function getOrPrepareStatement(
  connection: DuckDBConnection,
  query: string,
  cacheConfig: PreparedStatementCacheConfig
): Promise<DuckDBPreparedStatement> {
  const cache = getPreparedCache(connection, cacheConfig.size);
  const cached = cache.entries.get(query);
  if (cached) {
    return rememberPreparedStatement(cache, query, cached.statement);
  }

  const statement = await connection.prepare(query);
  rememberPreparedStatement(cache, query, statement);

  while (cache.entries.size > cache.size) {
    evictOldest(cache);
  }

  return statement;
}

function bindPreparedStatement(
  statement: DuckDBPreparedStatement,
  values: DuckDBValue[] | undefined
): void {
  if (values) {
    statement.bind(values);
    return;
  }

  statement.clearBindings?.();
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
    error instanceof Error && error.message.includes('Unexpected type id: 0')
  );
}

const JSON_RESULT_TYPE_IDS = new Set([22, 30, 39]);

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
    if (result.columnTypeId(columnIndex) === 0) {
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
    `DuckDB returned a column type that @duckdb/node-api cannot materialize to JavaScript${columnsText}. This currently affects some DuckDB 1.5 types, including VARIANT and GEOMETRY. Cast those columns to a supported representation before selecting them, for example CAST(col AS VARCHAR), variant_extract(...), ST_AsText(...), or ST_AsWKB(...).`
  );
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

async function materializeResultRows(
  result: {
    getRowsJS: () => Promise<unknown[][] | undefined>;
  } & ResultTypeMetadataLike &
    ResultJsonRowsLike
): Promise<MaterializedRows> {
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

async function executePreparedQuery(
  connection: DuckDBConnection,
  query: string,
  values: DuckDBValue[] | undefined,
  cacheConfig: PreparedStatementCacheConfig
): Promise<MaterializedRows> {
  const cache = getPreparedCache(connection, cacheConfig.size);

  try {
    const statement = await getOrPrepareStatement(
      connection,
      query,
      cacheConfig
    );
    bindPreparedStatement(statement, values);
    const result = await statement.run();
    rememberPreparedStatement(cache, query, statement);
    return await materializeResultRows(result);
  } catch (error) {
    evictCacheEntry(cache, query);
    throw error;
  }
}

type StreamResultLike = ResultTypeMetadataLike & {
  yieldRowsJs: () => AsyncIterable<unknown[][]>;
  yieldRowsJson?: () => AsyncIterable<unknown[][]>;
  close?: () => Promise<void> | void;
  cancel?: () => Promise<void> | void;
};

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
    const values = toNodeApiValues(params);

    if (options.prepareCache && typeof connection.prepare === 'function') {
      return await executePreparedQuery(
        connection,
        query,
        values,
        options.prepareCache
      );
    }

    const result = await connection.run(query, values);
    return await materializeResultRows(result);
  });
}

function clearPreparedCache(connection: DuckDBConnection): void {
  const store = connection as unknown as Record<
    symbol,
    PreparedStatementCache | undefined
  >;
  const cache = store[PREPARED_CACHE];
  if (!cache) return;
  for (const entry of cache.entries.values()) {
    destroyPreparedStatement(entry);
  }
  cache.entries.clear();
}

function mapRowsToObjects(columns: string[], rows: unknown[][]): RowData[] {
  const mappedRows: RowData[] = new Array(rows.length);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex] as unknown[];
    const row: RowData = {};

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      row[columns[columnIndex] as string] = values[columnIndex];
    }

    mappedRows[rowIndex] = row;
  }

  return mappedRows;
}

export async function closeClientConnection(
  connection: DuckDBConnection
): Promise<void> {
  clearPreparedCache(connection);

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
      const values = toNodeApiValues(params);

      const result = (await connection.stream(
        query,
        values
      )) as StreamResultLike;
      const columns = resolveResultColumns(result);
      const preferJson =
        prefersJsonMaterialization(result) &&
        typeof result.yieldRowsJson === 'function';
      let rows: unknown[][] = [];
      let hasYielded = false;

      const drainRows = async function* (
        rowStream: AsyncIterable<unknown[][]>
      ): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
        for await (const chunk of rowStream) {
          for (const row of chunk) {
            rows.push(row as unknown[]);
            if (rows.length >= rowsPerChunk) {
              hasYielded = true;
              yield { columns, rows };
              rows = [];
            }
          }
        }

        if (rows.length > 0) {
          hasYielded = true;
          yield { columns, rows };
          rows = [];
        }
      };

      try {
        try {
          if (preferJson) {
            try {
              yield* drainRows(result.yieldRowsJson!());
              return;
            } catch (error) {
              if (hasYielded) {
                throw error;
              }
              rows = [];
            }
          }

          yield* drainRows(result.yieldRowsJs());
        } catch (error) {
          throw wrapUnsupportedNodeApiTypeError(result, error);
        }
      } finally {
        await closeStreamResult(result);
      }
    }
  );
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
  params: unknown[]
): Promise<unknown> {
  return await withConnection(client, async (connection) => {
    const values = toNodeApiValues(params);
    const result = await connection.run(query, values);

    // Runtime detection for Arrow API support (optional method, not in base type)
    const maybeArrow =
      (result as unknown as { toArrow?: () => Promise<unknown> }).toArrow ??
      (result as unknown as { getArrowTable?: () => Promise<unknown> })
        .getArrowTable;

    if (typeof maybeArrow === 'function') {
      return await maybeArrow.call(result);
    }

    // Fallback: return column-major JS arrays to avoid per-row object creation.
    const resultMetadata = result as unknown as ResultTypeMetadataLike;
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
}
