/**
 * DuckDB wrapper value helpers that are safe for client-side bundles.
 * These utilities only tag values; conversion to native bindings lives
 * in value-wrappers.ts to avoid pulling @duckdb/node-api into browsers.
 */
export const DUCKDB_VALUE_MARKER = Symbol.for('drizzle-duckdb:value');

export type DuckDBValueKind =
  'list' | 'array' | 'struct' | 'map' | 'timestamp' | 'blob' | 'json';

export interface DuckDBValueWrapper<
  TKind extends DuckDBValueKind = DuckDBValueKind,
  TData = unknown,
> {
  readonly [DUCKDB_VALUE_MARKER]: true;
  readonly kind: TKind;
  readonly data: TData;
}

export interface ListValueWrapper extends DuckDBValueWrapper<
  'list',
  unknown[]
> {
  readonly elementType?: string;
}

export interface ArrayValueWrapper extends DuckDBValueWrapper<
  'array',
  unknown[]
> {
  readonly elementType?: string;
  readonly fixedLength?: number;
}

export interface StructValueWrapper extends DuckDBValueWrapper<
  'struct',
  Record<string, unknown>
> {
  readonly schema?: Record<string, string>;
}

export interface MapValueWrapper extends DuckDBValueWrapper<
  'map',
  Record<string, unknown>
> {
  readonly valueType?: string;
}

export interface TimestampValueWrapper extends DuckDBValueWrapper<
  'timestamp',
  Date | string | number | bigint
> {
  readonly withTimezone: boolean;
  readonly precision?: number;
}

export interface BlobValueWrapper extends DuckDBValueWrapper<
  'blob',
  Buffer | Uint8Array
> {}

export interface JsonValueWrapper extends DuckDBValueWrapper<'json', unknown> {}

export type AnyDuckDBValueWrapper =
  | ListValueWrapper
  | ArrayValueWrapper
  | StructValueWrapper
  | MapValueWrapper
  | TimestampValueWrapper
  | BlobValueWrapper
  | JsonValueWrapper;

export function isDuckDBWrapper(
  value: unknown
): value is AnyDuckDBValueWrapper {
  return (
    value !== null &&
    typeof value === 'object' &&
    DUCKDB_VALUE_MARKER in value &&
    (value as DuckDBValueWrapper)[DUCKDB_VALUE_MARKER] === true
  );
}

export function wrapList(
  data: unknown[],
  elementType?: string
): ListValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'list',
    data,
    elementType,
  };
}

export function wrapArray(
  data: unknown[],
  elementType?: string,
  fixedLength?: number
): ArrayValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'array',
    data,
    elementType,
    fixedLength,
  };
}

export function wrapStruct(
  data: Record<string, unknown>,
  schema?: Record<string, string>
): StructValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'struct',
    data,
    schema,
  };
}

export function wrapMap(
  data: Record<string, unknown>,
  valueType?: string
): MapValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'map',
    data,
    valueType,
  };
}

export function wrapTimestamp(
  data: Date | string | number | bigint,
  withTimezone: boolean,
  precision?: number
): TimestampValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'timestamp',
    data,
    withTimezone,
    precision,
  };
}

export function wrapBlob(data: Buffer | Uint8Array): BlobValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'blob',
    data,
  };
}

export function wrapJson(data: unknown): JsonValueWrapper {
  return {
    [DUCKDB_VALUE_MARKER]: true,
    kind: 'json',
    data,
  };
}
