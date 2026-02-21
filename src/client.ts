import {
  listValue,
  timestampValue,
  type DuckDBConnection,
  type DuckDBPreparedStatement,
  type DuckDBValue,
} from '@duckdb/node-api';
import {
  DUCKDB_VALUE_MARKER,
  wrapperToNodeApiValue,
  type AnyDuckDBValueWrapper,
} from './value-wrappers.ts';
import type { PreparedStatementCacheConfig } from './options.ts';

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

const PREPARED_CACHE = Symbol.for('drizzle-duckdb:prepared-cache');

export interface PrepareParamsOptions {
  rejectStringArrayLiterals?: boolean;
  warnOnStringArrayLiteral?: () => void;
}

function isPgArrayLiteral(value: string): boolean {
  return value.startsWith('{') && value.endsWith('}');
}

function parsePgArrayLiteral(value: string): unknown {
  const json = value.replace(/{/g, '[').replace(/}/g, ']');

  try {
    return JSON.parse(json);
  } catch {
    return value;
  }
}

export function prepareParams(
  params: unknown[],
  options: PrepareParamsOptions = {}
): unknown[] {
  return params.map((param) => {
    if (typeof param === 'string' && param.length > 0) {
      const firstChar = param[0];
      const maybeArrayLiteral =
        firstChar === '{' ||
        firstChar === '[' ||
        firstChar === ' ' ||
        firstChar === '\t';

      if (maybeArrayLiteral) {
        const trimmed =
          firstChar === '{' || firstChar === '[' ? param : param.trim();

        if (trimmed && isPgArrayLiteral(trimmed)) {
          if (options.rejectStringArrayLiterals) {
            throw new Error(
              'Stringified array literals are not supported. Use duckDbList()/duckDbArray() or pass native arrays.'
            );
          }

          if (options.warnOnStringArrayLiteral) {
            options.warnOnStringArrayLiteral();
          }
          return parsePgArrayLiteral(trimmed);
        }
      }
    }
    return param;
  });
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

async function getOrPrepareStatement(
  connection: DuckDBConnection,
  query: string,
  cacheConfig: PreparedStatementCacheConfig
): Promise<DuckDBPreparedStatement> {
  const cache = getPreparedCache(connection, cacheConfig.size);
  const cached = cache.entries.get(query);
  if (cached) {
    cache.entries.delete(query);
    cache.entries.set(query, cached);
    return cached.statement;
  }

  const statement = await connection.prepare(query);
  cache.entries.set(query, { statement });

  while (cache.entries.size > cache.size) {
    evictOldest(cache);
  }

  return statement;
}

async function materializeResultRows(result: {
  getRowsJS: () => Promise<unknown[][] | undefined>;
  columnNames: () => string[];
  deduplicatedColumnNames?: () => string[];
}): Promise<MaterializedRows> {
  const rows = (await result.getRowsJS()) ?? [];
  const baseColumns =
    typeof result.deduplicatedColumnNames === 'function'
      ? result.deduplicatedColumnNames()
      : result.columnNames();
  const columns =
    typeof result.deduplicatedColumnNames === 'function'
      ? baseColumns
      : deduplicateColumns(baseColumns);

  return { columns, rows };
}

type StreamResultLike = {
  yieldRowsJs: () => AsyncIterable<unknown[][]>;
  columnNames: () => string[];
  deduplicatedColumnNames?: () => string[];
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
  if (isPool(client)) {
    const connection = await client.acquire();
    try {
      return await materializeRows(connection, query, params, options);
    } finally {
      await client.release(connection);
    }
  }

  const values =
    params.length > 0
      ? (params.map((param) => toNodeApiValue(param)) as DuckDBValue[])
      : undefined;

  const connection = client as DuckDBConnection;

  if (options.prepareCache && typeof connection.prepare === 'function') {
    const cache = getPreparedCache(connection, options.prepareCache.size);
    try {
      const statement = await getOrPrepareStatement(
        connection,
        query,
        options.prepareCache
      );
      if (values) {
        statement.bind(values as DuckDBValue[]);
      } else {
        statement.clearBindings?.();
      }
      const result = await statement.run();
      cache.entries.delete(query);
      cache.entries.set(query, { statement });
      return await materializeResultRows(result);
    } catch (error) {
      evictCacheEntry(cache, query);
      throw error;
    }
  }

  const result = await connection.run(query, values);
  return await materializeResultRows(result);
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
  return rows.map((vals) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      obj[col] = vals[idx];
    });
    return obj;
  }) as RowData[];
}

export async function closeClientConnection(
  connection: DuckDBConnection
): Promise<void> {
  clearPreparedCache(connection);

  if ('close' in connection && typeof connection.close === 'function') {
    await connection.close();
    return;
  }

  if ('closeSync' in connection && typeof connection.closeSync === 'function') {
    connection.closeSync();
    return;
  }

  if (
    'disconnectSync' in connection &&
    typeof connection.disconnectSync === 'function'
  ) {
    connection.disconnectSync();
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

/**
 * Stream results from DuckDB in batches to avoid fully materializing rows in JS.
 */
export async function* executeInBatches(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteInBatchesOptions = {}
): AsyncGenerator<RowData[], void, void> {
  if (isPool(client)) {
    const connection = await client.acquire();
    try {
      yield* executeInBatches(connection, query, params, options);
      return;
    } finally {
      await client.release(connection);
    }
  }

  const rowsPerChunk =
    options.rowsPerChunk && options.rowsPerChunk > 0
      ? options.rowsPerChunk
      : 100_000;
  const values =
    params.length > 0
      ? (params.map((param) => toNodeApiValue(param)) as DuckDBValue[])
      : undefined;

  const result = (await client.stream(query, values)) as StreamResultLike;
  const rawColumns =
    typeof result.deduplicatedColumnNames === 'function'
      ? result.deduplicatedColumnNames()
      : result.columnNames();
  const columns =
    typeof result.deduplicatedColumnNames === 'function'
      ? rawColumns
      : deduplicateColumns(rawColumns);

  let buffer: RowData[] = [];

  try {
    for await (const chunk of result.yieldRowsJs()) {
      const objects = mapRowsToObjects(columns, chunk);
      for (const row of objects) {
        buffer.push(row);
        if (buffer.length >= rowsPerChunk) {
          yield buffer;
          buffer = [];
        }
      }
    }

    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    await closeStreamResult(result);
  }
}

export async function* executeInBatchesRaw(
  client: DuckDBClientLike,
  query: string,
  params: unknown[],
  options: ExecuteInBatchesOptions = {}
): AsyncGenerator<ExecuteBatchesRawChunk, void, void> {
  if (isPool(client)) {
    const connection = await client.acquire();
    try {
      yield* executeInBatchesRaw(connection, query, params, options);
      return;
    } finally {
      await client.release(connection);
    }
  }

  const rowsPerChunk =
    options.rowsPerChunk && options.rowsPerChunk > 0
      ? options.rowsPerChunk
      : 100_000;

  const values =
    params.length > 0
      ? (params.map((param) => toNodeApiValue(param)) as DuckDBValue[])
      : undefined;

  const result = (await client.stream(query, values)) as StreamResultLike;
  const rawColumns =
    typeof result.deduplicatedColumnNames === 'function'
      ? result.deduplicatedColumnNames()
      : result.columnNames();
  const columns =
    typeof result.deduplicatedColumnNames === 'function'
      ? rawColumns
      : deduplicateColumns(rawColumns);

  let buffer: unknown[][] = [];

  try {
    for await (const chunk of result.yieldRowsJs()) {
      for (const row of chunk) {
        buffer.push(row as unknown[]);
        if (buffer.length >= rowsPerChunk) {
          yield { columns, rows: buffer };
          buffer = [];
        }
      }
    }

    if (buffer.length > 0) {
      yield { columns, rows: buffer };
    }
  } finally {
    await closeStreamResult(result);
  }
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
  if (isPool(client)) {
    const connection = await client.acquire();
    try {
      return await executeArrowOnClient(connection, query, params);
    } finally {
      await client.release(connection);
    }
  }

  const values =
    params.length > 0
      ? (params.map((param) => toNodeApiValue(param)) as DuckDBValue[])
      : undefined;
  const result = await client.run(query, values);

  // Runtime detection for Arrow API support (optional method, not in base type)
  const maybeArrow =
    (result as unknown as { toArrow?: () => Promise<unknown> }).toArrow ??
    (result as unknown as { getArrowTable?: () => Promise<unknown> })
      .getArrowTable;

  if (typeof maybeArrow === 'function') {
    return await maybeArrow.call(result);
  }

  // Fallback: return column-major JS arrays to avoid per-row object creation.
  return result.getColumnsObjectJS();
}
