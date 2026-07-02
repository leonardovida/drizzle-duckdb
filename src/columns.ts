import { sql, type SQL } from 'drizzle-orm';
import { isSQLWrapper, type SQLWrapper } from 'drizzle-orm/sql/sql';
import { customType } from 'drizzle-orm/pg-core';
import {
  wrapList,
  wrapArray,
  wrapMap,
  wrapBlob,
  wrapJson,
  wrapTimestamp,
  type ListValueWrapper,
  type ArrayValueWrapper,
  type MapValueWrapper,
  type BlobValueWrapper,
  type JsonValueWrapper,
  type TimestampValueWrapper,
} from './value-wrappers-core.ts';
import { coerceArrayString as parseArrayString } from './array-literals.ts';
import { splitTopLevel } from './sql/split-top-level.ts';

export { coerceArrayString } from './array-literals.ts';

type IntColType =
  | 'SMALLINT'
  | 'INTEGER'
  | 'BIGINT'
  | 'HUGEINT'
  | 'USMALLINT'
  | 'UINTEGER'
  | 'UBIGINT'
  | 'UHUGEINT'
  | 'INT'
  | 'INT16'
  | 'INT32'
  | 'INT64'
  | 'INT128'
  | 'LONG'
  | 'VARINT';

type FloatColType = 'FLOAT' | 'DOUBLE';

type StringColType = 'STRING' | 'VARCHAR' | 'TEXT';

type BoolColType = 'BOOLEAN' | 'BOOL';

type BlobColType = 'BLOB' | 'BYTEA' | 'VARBINARY';

type DateColType =
  | 'DATE'
  | 'TIME'
  | 'TIME_NS'
  | 'TIMETZ'
  | 'TIMESTAMP'
  | 'DATETIME'
  | 'TIMESTAMPTZ'
  | 'TIMESTAMP_MS'
  | 'TIMESTAMP_NS'
  | 'TIMESTAMP_S';

type AnyColType =
  | IntColType
  | FloatColType
  | StringColType
  | BoolColType
  | DateColType
  | BlobColType;

type ListColType = `${AnyColType}[]`;
type ArrayColType = `${AnyColType}[${number}]`;
type StructColType = `STRUCT (${string})`;

type Primitive = AnyColType | ListColType | ArrayColType | StructColType;

type ArrayDriverValue =
  | unknown[]
  | string
  | ListValueWrapper
  | ArrayValueWrapper;

export type ArrayPredicateValue<T> = T[] | SQLWrapper;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStructType(typeHint: string | undefined): typeHint is StructColType {
  return /^STRUCT\s*\(/i.test(typeHint?.trim() ?? '');
}

function parseStructSchema(
  typeHint: string | undefined
): Record<string, Primitive> | undefined {
  if (!isStructType(typeHint)) {
    return undefined;
  }

  const inner = typeHint
    .trim()
    .replace(/^STRUCT\s*\(/i, '')
    .replace(/\)$/, '');
  const fields: Record<string, Primitive> = {};

  for (const part of splitTopLevel(inner, ',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match =
      /^"([^"]+)"\s+(.*)$/i.exec(trimmed) ??
      /^([^\s"]+)\s+(.*)$/i.exec(trimmed);
    if (!match) continue;

    const [, key, type] = match;
    fields[key] = type.trim() as Primitive;
  }

  return fields;
}

function arrayElementType(typeHint: string | undefined): string | undefined {
  if (!typeHint) return undefined;
  const trimmed = typeHint.trim();
  if (trimmed.endsWith('[]')) {
    return trimmed.slice(0, -2);
  }

  const fixedArrayMatch = /^(.*)\[\d+\]$/.exec(trimmed);
  return fixedArrayMatch?.[1]?.trim();
}

function coerceArrayDriverValue<TData>(value: ArrayDriverValue): TData[] {
  if (Array.isArray(value)) {
    return value as TData[];
  }

  if (typeof value === 'string') {
    const parsed = parseArrayString(value);
    if (parsed !== undefined) {
      return parsed as TData[];
    }
  }

  return value as unknown as TData[];
}

export function formatLiteral(value: unknown, typeHint?: string): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  const upperType = typeHint?.toUpperCase() ?? '';
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }

  const str =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value));

  const escaped = str.replace(/'/g, "''");
  // Simple quoting based on hint.
  if (
    upperType.includes('CHAR') ||
    upperType.includes('TEXT') ||
    upperType.includes('STRING') ||
    upperType.includes('VARCHAR')
  ) {
    return `'${escaped}'`;
  }

  return `'${escaped}'`;
}

export function buildListLiteral(values: unknown[], elementType?: string): SQL {
  if (values.length === 0) {
    return sql`[]`;
  }
  const chunks = values.map((v) => valueToSqlLiteral(v, elementType));
  return sql`list_value(${sql.join(chunks, sql.raw(', '))})`;
}

export function normalizeArrayPredicateValue<T>(
  values: ArrayPredicateValue<T>
): SQL | SQLWrapper {
  return Array.isArray(values) ? buildListLiteral(values) : values;
}

function valueToSqlLiteral(value: unknown, typeHint?: string): SQL {
  if (Array.isArray(value)) {
    return buildListLiteral(value, arrayElementType(typeHint));
  }

  if (isSQLWrapper(value)) {
    return sql`${value}`;
  }

  if (isRecord(value)) {
    return buildStructLiteral(value, parseStructSchema(typeHint));
  }

  return sql.raw(formatLiteral(value, typeHint));
}

export function buildStructLiteral(
  value: Record<string, unknown>,
  schema?: Record<string, Primitive>
): SQL {
  const parts = Object.entries(value).map(([key, val]) => {
    const typeHint = schema?.[key];
    return sql`${sql.identifier(key)} := ${valueToSqlLiteral(val, typeHint)}`;
  });
  return sql`struct_pack(${sql.join(parts, sql.raw(', '))})`;
}

export function buildMapLiteral(
  value: Record<string, unknown>,
  valueType?: string
): SQL {
  const keys = Object.keys(value);
  const vals = Object.values(value);
  const keyList = buildListLiteral(keys, 'TEXT');
  const valList = buildListLiteral(
    vals,
    valueType?.endsWith('[]') ? valueType.slice(0, -2) : valueType
  );
  return sql`map(${keyList}, ${valList})`;
}

export const duckDbList = <TData = unknown>(
  name: string,
  elementType: AnyColType
) =>
  customType<{
    data: TData[];
    driverData: ListValueWrapper | unknown[] | string;
  }>({
    dataType() {
      return `${elementType}[]`;
    },
    toDriver(value: TData[]): ListValueWrapper {
      return wrapList(value, elementType);
    },
    fromDriver(value: unknown[] | string | ListValueWrapper): TData[] {
      return coerceArrayDriverValue(value);
    },
  })(name);

export const duckDbArray = <TData = unknown>(
  name: string,
  elementType: AnyColType,
  fixedLength?: number
) =>
  customType<{
    data: TData[];
    driverData: ArrayValueWrapper | unknown[] | string;
  }>({
    dataType() {
      return fixedLength
        ? `${elementType}[${fixedLength}]`
        : `${elementType}[]`;
    },
    toDriver(value: TData[]): ArrayValueWrapper {
      return wrapArray(value, elementType, fixedLength);
    },
    fromDriver(value: unknown[] | string | ArrayValueWrapper): TData[] {
      return coerceArrayDriverValue(value);
    },
  })(name);

export const duckDbMap = <TData extends Record<string, any>>(
  name: string,
  valueType: AnyColType | ListColType | ArrayColType
) =>
  customType<{ data: TData; driverData: MapValueWrapper | TData }>({
    dataType() {
      return `MAP (STRING, ${valueType})`;
    },
    toDriver(value: TData) {
      // Use SQL literals for empty maps due to DuckDB type inference issues
      // with mapValue() when there are no entries to infer types from
      if (Object.keys(value).length === 0) {
        return buildMapLiteral(value, valueType);
      }
      return wrapMap(value, valueType);
    },
    fromDriver(value: TData | MapValueWrapper): TData {
      return value as TData;
    },
  })(name);

export const duckDbStruct = <TData extends Record<string, any>>(
  name: string,
  schema: Record<string, Primitive>
) =>
  customType<{ data: TData; driverData: TData }>({
    dataType() {
      const fields = Object.entries(schema).map(
        ([key, type]) => `${key} ${type}`
      );

      return `STRUCT (${fields.join(', ')})`;
    },
    toDriver(value: TData) {
      // Use SQL literals for structs due to DuckDB type inference issues
      // with nested empty lists
      return buildStructLiteral(value, schema);
    },
    fromDriver(value: TData | string): TData {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as TData;
        } catch {
          return value as unknown as TData;
        }
      }
      return value;
    },
  })(name);

/**
 * JSON column type that wraps values and delays JSON.stringify() to binding time.
 * This ensures consistent handling with other wrapped types.
 *
 * Note: DuckDB stores JSON as VARCHAR internally, so the final binding
 * is always a stringified JSON value.
 */
export const duckDbJson = <TData = unknown>(name: string) =>
  customType<{ data: TData; driverData: JsonValueWrapper | SQL | string }>({
    dataType() {
      return 'JSON';
    },
    toDriver(value: TData): JsonValueWrapper | SQL | string {
      // Pass through strings directly
      if (typeof value === 'string') {
        return value;
      }
      // Pass through SQL objects (for raw SQL expressions)
      if (
        value !== null &&
        typeof value === 'object' &&
        'queryChunks' in (value as Record<string, unknown>)
      ) {
        return value as unknown as SQL;
      }
      // Wrap non-string values for delayed stringify at binding time
      return wrapJson(value);
    },
    fromDriver(value: SQL | string | JsonValueWrapper) {
      if (typeof value !== 'string') {
        return value as unknown as TData;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return value as unknown as TData;
      }
      try {
        return JSON.parse(trimmed) as TData;
      } catch {
        return value as unknown as TData;
      }
    },
  })(name);

export const duckDbBlob = customType<{
  data: Buffer;
  driverData: BlobValueWrapper;
  default: false;
}>({
  dataType() {
    return 'BLOB';
  },
  toDriver(value: Buffer): BlobValueWrapper {
    return wrapBlob(value);
  },
});

export const duckDbInet = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return 'INET';
    },
    toDriver(value: string) {
      return value;
    },
  })(name);

export const duckDbInterval = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return 'INTERVAL';
    },
    toDriver(value: string) {
      return value;
    },
  })(name);

type TimestampMode = 'date' | 'string';

type DuckDbTimestampType =
  | 'TIMESTAMP'
  | 'TIMESTAMPTZ'
  | 'TIMESTAMP_S'
  | 'TIMESTAMP_MS'
  | 'TIMESTAMP_NS';

type DuckDbTimeType = 'TIME' | 'TIMETZ' | 'TIME_NS';

interface TimestampOptions {
  withTimezone?: boolean;
  mode?: TimestampMode;
  precision?: number;
  bindMode?: 'auto' | 'bind' | 'literal';
  duckDbType?: DuckDbTimestampType;
}

interface TimeOptions {
  withTimezone?: boolean;
  duckDbType?: DuckDbTimeType;
}

function resolveTimestampType(options: TimestampOptions): DuckDbTimestampType {
  if (options.duckDbType) {
    return options.duckDbType;
  }

  return options.withTimezone ? 'TIMESTAMPTZ' : 'TIMESTAMP';
}

function isTimestampWithTimezone(
  duckDbType: DuckDbTimestampType,
  options: TimestampOptions
): boolean {
  return duckDbType === 'TIMESTAMPTZ' || options.withTimezone === true;
}

function resolveTimeType(options: TimeOptions): DuckDbTimeType {
  if (options.duckDbType) {
    return options.duckDbType;
  }

  return options.withTimezone ? 'TIMETZ' : 'TIME';
}

function normalizeTimestampStringForDate(stringValue: string): string {
  const trimmed = stringValue.trim();
  const normalized = trimmed.replace(' ', 'T');

  if (normalized.endsWith('Z')) {
    return normalized;
  }

  return normalized
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

function shouldBindTimestamp(options: TimestampOptions): boolean {
  if (
    options.duckDbType &&
    options.duckDbType !== 'TIMESTAMP' &&
    options.duckDbType !== 'TIMESTAMPTZ'
  ) {
    return false;
  }

  const bindMode = options.bindMode ?? 'auto';
  if (bindMode === 'bind') return true;
  if (bindMode === 'literal') return false;

  const isBun =
    typeof process !== 'undefined' &&
    typeof process.versions?.bun !== 'undefined';
  if (isBun) return false;

  const forceLiteral =
    typeof process !== 'undefined'
      ? process.env.DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS
      : undefined;

  if (forceLiteral && forceLiteral !== '0') {
    return false;
  }

  return true;
}

export const duckDbTimestamp = (name: string, options: TimestampOptions = {}) =>
  customType<{
    data: Date | string;
    driverData: SQL | string | Date | TimestampValueWrapper;
  }>({
    dataType() {
      const duckDbType = resolveTimestampType(options);
      if (duckDbType !== 'TIMESTAMP') {
        return duckDbType;
      }
      const precision = options.precision ? `(${options.precision})` : '';
      return `TIMESTAMP${precision}`;
    },
    toDriver(
      value: Date | string
    ): SQL | string | Date | TimestampValueWrapper {
      const duckDbType = resolveTimestampType(options);
      const withTimezone = isTimestampWithTimezone(duckDbType, options);

      if (shouldBindTimestamp(options)) {
        return wrapTimestamp(value, withTimezone, options.precision);
      }

      const iso = value instanceof Date ? value.toISOString() : value;
      const normalized = iso.replace('T', ' ').replace('Z', '+00');
      return sql.raw(`${duckDbType} '${normalized}'`);
    },
    fromDriver(value: Date | string | SQL | TimestampValueWrapper) {
      if (
        value &&
        typeof value === 'object' &&
        'kind' in value &&
        (value as TimestampValueWrapper).kind === 'timestamp'
      ) {
        const wrapped = value as TimestampValueWrapper;
        return wrapped.data instanceof Date
          ? wrapped.data
          : typeof wrapped.data === 'number' || typeof wrapped.data === 'bigint'
            ? new Date(Number(wrapped.data) / 1000)
            : wrapped.data;
      }
      if (options.mode === 'string') {
        if (value instanceof Date) {
          return value.toISOString().replace('T', ' ').replace('Z', '+00');
        }
        return typeof value === 'string' ? value : value.toString();
      }
      if (value instanceof Date) {
        return value;
      }
      const stringValue = typeof value === 'string' ? value : value.toString();
      const hasOffset =
        stringValue.endsWith('Z') || /[+-]\d{2}(?::?\d{2})?$/.test(stringValue);
      const normalized = hasOffset
        ? normalizeTimestampStringForDate(stringValue)
        : `${stringValue.replace(' ', 'T')}Z`;
      return new Date(normalized);
    },
  })(name);

export const duckDbDate = (name: string) =>
  customType<{ data: string | Date; driverData: string | Date }>({
    dataType() {
      return 'DATE';
    },
    toDriver(value: string | Date) {
      return value;
    },
    fromDriver(value: string | Date) {
      const str =
        value instanceof Date ? value.toISOString().slice(0, 10) : value;
      return str;
    },
  })(name);

export const duckDbTime = (name: string, options: TimeOptions = {}) =>
  customType<{ data: string; driverData: string | bigint }>({
    dataType() {
      return resolveTimeType(options);
    },
    toDriver(value: string) {
      return value;
    },
    fromDriver(value: string | bigint) {
      if (typeof value === 'bigint') {
        const totalMillis = Number(value) / 1000;
        const date = new Date(totalMillis);
        return date.toISOString().split('T')[1]!.replace('Z', '');
      }
      return value;
    },
  })(name);

export function duckDbArrayContains(
  column: SQLWrapper,
  values: ArrayPredicateValue<unknown>
): SQL {
  const rhs = normalizeArrayPredicateValue(values);
  return sql`array_has_all(${column}, ${rhs})`;
}

export function duckDbArrayContained(
  column: SQLWrapper,
  values: ArrayPredicateValue<unknown>
): SQL {
  const rhs = normalizeArrayPredicateValue(values);
  return sql`array_has_all(${rhs}, ${column})`;
}

export function duckDbArrayOverlaps(
  column: SQLWrapper,
  values: ArrayPredicateValue<unknown>
): SQL {
  const rhs = normalizeArrayPredicateValue(values);
  return sql`array_has_any(${column}, ${rhs})`;
}
