import { Column, is, sql, type SQL } from 'drizzle-orm';
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
import {
  intervalToString,
  parseTimestampString,
  timeFromMicros,
  timestampStringFromMicros,
  timestampStringToDateInput,
  utcTimestampString,
} from './time.ts';

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

/**
 * A DuckDB type name. Known names autocomplete, and any other DuckDB type
 * string (UUID, DECIMAL(10, 2), MAP(VARCHAR, INTEGER), ...) is accepted too.
 */
type DuckDbTypeName<TKnown extends string> = TKnown | (string & {});

interface MapOptions {
  /** Object decoding is opt-in. Default output retains native entry arrays. */
  mode?: 'entries' | 'object';
  /** DuckDB key type for the MAP column. Defaults to STRING. */
  keyType?: DuckDbTypeName<AnyColType>;
}

type ArrayDriverValue =
  | unknown[]
  | string
  | ListValueWrapper
  | ArrayValueWrapper;

export type ArrayPredicateValue<T> = T[] | SQLWrapper;

/**
 * Plain objects only. Dates, Buffers and other class instances are values,
 * not structs or maps.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  // A root prototype also matches plain objects from another realm.
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function isNaiveTimestampType(typeHint: string | undefined): boolean {
  return /^(TIMESTAMP(_S|_MS|_NS)?|DATETIME)(\s*\(\s*\d+\s*\))?$/i.test(
    typeHint?.trim() ?? ''
  );
}

/**
 * A Date is an instant. Naive TIMESTAMP targets get its UTC wall time, DATE
 * targets its UTC date, and anything else a TIMESTAMPTZ literal.
 */
function dateLiteral(value: Date, typeHint: string | undefined): string {
  const utc = value.toISOString().replace('T', ' ').replace('Z', '');
  if (/^DATE$/i.test(typeHint?.trim() ?? '')) {
    return `DATE '${utc.slice(0, 10)}'`;
  }
  if (isNaiveTimestampType(typeHint)) {
    return `TIMESTAMP '${utc}'`;
  }
  return `TIMESTAMPTZ '${utc}+00'`;
}

function blobLiteral(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `from_hex('${hex}')`;
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
      /^"((?:[^"]|"")+)"\s+(.*)$/i.exec(trimmed) ??
      /^([^\s"]+)\s+(.*)$/i.exec(trimmed);
    if (!match) continue;

    const [, key, type] = match;
    fields[key.replace(/""/g, '"')] = type.trim() as Primitive;
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

  if (value instanceof Date) {
    return dateLiteral(value, typeHint);
  }

  if (value instanceof Uint8Array) {
    return blobLiteral(value);
  }

  if (typeof value === 'number') {
    // NaN and Infinity are not SQL number tokens.
    return Number.isFinite(value) ? value.toString() : `'${value}'::DOUBLE`;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    const elementType = arrayElementType(typeHint);
    return `[${value.map((item) => formatLiteral(item, elementType)).join(', ')}]`;
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }

  const str =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value));

  return `'${str.replace(/'/g, "''")}'`;
}

export function buildListLiteral(values: unknown[], elementType?: string): SQL {
  if (values.length === 0) {
    // An untyped [] cannot be inferred inside maps or parameters.
    return elementType ? sql.raw(`[]::${elementType}[]`) : sql`[]`;
  }
  const chunks = values.map((v) => valueToSqlLiteral(v, elementType));
  return sql`list_value(${sql.join(chunks, sql.raw(', '))})`;
}

export function normalizeArrayPredicateValue<T>(
  values: ArrayPredicateValue<T>,
  elementType?: string
): SQL | SQLWrapper {
  return Array.isArray(values) ? buildListLiteral(values, elementType) : values;
}

/** The element type of a list or array column, used to type literal values. */
function columnElementType(column: SQLWrapper): string | undefined {
  return is(column, Column) ? arrayElementType(column.getSQLType()) : undefined;
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
  schema?: Record<string, DuckDbTypeName<Primitive>>
): SQL {
  const parts = Object.entries(value).map(([key, val]) => {
    const typeHint = schema?.[key];
    // Quote locally so keys are escaped whatever the dialect's escapeName does.
    const name = sql.raw(`"${key.replace(/"/g, '""')}"`);
    return sql`${name} := ${valueToSqlLiteral(val, typeHint)}`;
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
  const valList = buildListLiteral(vals, valueType);
  return sql`map(${keyList}, ${valList})`;
}

/**
 * Node API list and map parameters infer their element type from the items,
 * so empty lists, structs and blobs cannot be bound. Those values are sent as
 * SQL literals typed from the declared column type instead.
 */
function needsLiteral(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0 || value.some(needsLiteral);
  }
  return isRecord(value) || value instanceof Uint8Array;
}

export const duckDbList = <TData = unknown>(
  name: string,
  elementType: DuckDbTypeName<AnyColType>
) =>
  customType<{
    data: TData[];
    driverData: ListValueWrapper | unknown[] | string;
  }>({
    dataType() {
      return `${elementType}[]`;
    },
    toDriver(value: TData[]): ListValueWrapper | SQL {
      if (needsLiteral(value)) {
        return buildListLiteral(value, elementType);
      }
      return wrapList(value, elementType);
    },
    fromDriver(value: unknown[] | string | ListValueWrapper): TData[] {
      return coerceArrayDriverValue(value);
    },
  })(name);

export const duckDbArray = <TData = unknown>(
  name: string,
  elementType: DuckDbTypeName<AnyColType>,
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
    toDriver(value: TData[]): ArrayValueWrapper | SQL {
      if (needsLiteral(value)) {
        return buildListLiteral(value, elementType);
      }
      return wrapArray(value, elementType, fixedLength);
    },
    fromDriver(value: unknown[] | string | ArrayValueWrapper): TData[] {
      return coerceArrayDriverValue(value);
    },
  })(name);

export const duckDbMap = <TData extends Record<string, any>>(
  name: string,
  valueType: DuckDbTypeName<AnyColType | ListColType | ArrayColType>,
  options: MapOptions = {}
) =>
  customType<{ data: TData; driverData: MapValueWrapper | TData }>({
    dataType() {
      return `MAP (${options.keyType ?? 'STRING'}, ${valueType})`;
    },
    toDriver(value: TData) {
      // An empty map has no items to infer its key and value types from.
      if (
        Object.keys(value).length === 0 ||
        Object.values(value).some(needsLiteral)
      ) {
        return buildMapLiteral(value, valueType);
      }
      return wrapMap(value, valueType);
    },
    fromDriver(value: TData | MapValueWrapper): TData {
      // node-api's JS converter represents MAP as key/value entries.
      if (options.mode === 'object' && Array.isArray(value)) {
        return Object.fromEntries(
          value.map((entry: { key: unknown; value: unknown }) => [
            String(entry.key),
            entry.value,
          ])
        ) as TData;
      }
      return value as TData;
    },
  })(name);

export const duckDbStruct = <TData extends Record<string, any>>(
  name: string,
  schema: Record<string, DuckDbTypeName<Primitive>>
) =>
  customType<{ data: TData; driverData: TData }>({
    dataType() {
      const fields = Object.entries(schema).map(
        ([key, type]) => `"${key.replace(/"/g, '""')}" ${type}`
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
  driverData: BlobValueWrapper | Uint8Array | string;
  default: false;
}>({
  dataType() {
    return 'BLOB';
  },
  toDriver(value: Buffer): BlobValueWrapper {
    return wrapBlob(value);
  },
  fromDriver(value: BlobValueWrapper | Uint8Array | string): Buffer {
    // Some result paths render BLOB as DuckDB text such as '\x01\x02'.
    if (typeof value === 'string') {
      return toBuffer(bytesFromBlobString(value));
    }
    return toBuffer(value instanceof Uint8Array ? value : value.data);
  },
});

/**
 * Decode DuckDB's BLOB text form. Printable ASCII bytes appear as themselves
 * and every other byte, including the backslash, as `\xNN`.
 */
function bytesFromBlobString(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const hex = value.slice(i + 2, i + 4);
    if (
      value[i] === '\\' &&
      (value[i + 1] === 'x' || value[i + 1] === 'X') &&
      /^[0-9a-f]{2}$/i.test(hex)
    ) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function toBuffer(bytes: Uint8Array): Buffer {
  // Buffer is missing in browsers, where this module may be loaded.
  const NodeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (!NodeBuffer || NodeBuffer.isBuffer(bytes)) {
    return bytes as Buffer;
  }
  return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export const duckDbInet = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return 'INET';
    },
    toDriver(value: string) {
      return value;
    },
  })(name);

interface IntervalParts {
  months: number | string;
  days: number | string;
  micros: bigint | number | string;
}

function isIntervalParts(value: unknown): value is IntervalParts {
  return (
    value !== null &&
    typeof value === 'object' &&
    'months' in value &&
    'days' in value &&
    'micros' in value
  );
}

export const duckDbInterval = (name: string) =>
  customType<{ data: string; driverData: string | IntervalParts }>({
    dataType() {
      return 'INTERVAL';
    },
    toDriver(value: string) {
      return value;
    },
    fromDriver(value: string | IntervalParts): string {
      // DuckDB returns { months, days, micros }. Format it as DuckDB text,
      // which matches the string type and can be written back.
      if (isIntervalParts(value)) {
        return intervalToString(
          Number(value.months),
          Number(value.days),
          BigInt(value.micros)
        );
      }
      return String(value);
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

/**
 * Render a timestamp for inline SQL. ISO-like strings are rebuilt from their
 * parsed parts, anything else is passed to DuckDB as an escaped string.
 *
 * Strings are read the same way bind mode reads them: a missing offset means
 * UTC. DuckDB would otherwise read a TIMESTAMPTZ literal without an offset in
 * the session TimeZone, and drop the offset from a naive TIMESTAMP literal.
 */
function timestampLiteral(value: Date | string, withTimezone: boolean): string {
  if (value instanceof Date) {
    return value.toISOString().replace('T', ' ').replace('Z', '+00');
  }

  const parts = parseTimestampString(value);
  if (!parts) {
    return value.replace(/'/g, "''");
  }

  const fraction = parts.fraction ? `.${parts.fraction}` : '';
  const offset = parts.offset === 'Z' ? '+00' : parts.offset;

  if (withTimezone) {
    const time = ` ${parts.time ?? '00:00:00'}`;
    return `${parts.date}${time}${fraction}${offset ?? '+00'}`;
  }

  if (offset && !/^[+-]00(:00)?$/.test(offset)) {
    const utc = utcTimestampString(parts);
    if (utc) {
      return `${utc}+00`;
    }
  }

  const time = parts.time ? ` ${parts.time}` : '';
  return `${parts.date}${time}${fraction}${offset ?? ''}`;
}

/**
 * Format a TIMESTAMP read for string mode. Naive values keep their wall time
 * without an offset. TIMESTAMPTZ values are rendered in UTC with `+00`.
 * Fractional digits are kept as far as the driver value carries them.
 */
function timestampModeString(value: unknown, withTimezone: boolean): string {
  if (value instanceof Date) {
    return timestampStringFromMicros(
      BigInt(value.getTime()) * 1000n,
      withTimezone
    );
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    'micros' in value &&
    typeof value.micros === 'bigint'
  ) {
    return timestampStringFromMicros(value.micros, withTimezone);
  }

  const text = typeof value === 'string' ? value : String(value);
  const parts = withTimezone ? parseTimestampString(text) : undefined;
  if (!parts) {
    return text;
  }
  const utc = utcTimestampString(parts);
  return utc ? `${utc}+00` : text;
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

export const duckDbTimestamp = <TMode extends TimestampMode = 'date'>(
  name: string,
  options: TimestampOptions & { mode?: TMode } = {}
) =>
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

      return sql.raw(
        `${duckDbType} '${timestampLiteral(value, withTimezone)}'`
      );
    },
    fromDriver(value: Date | string | SQL | TimestampValueWrapper) {
      if (
        value &&
        typeof value === 'object' &&
        'kind' in value &&
        (value as TimestampValueWrapper).kind === 'timestamp'
      ) {
        const wrapped = value as TimestampValueWrapper;
        value =
          wrapped.data instanceof Date
            ? wrapped.data
            : typeof wrapped.data === 'number' ||
                typeof wrapped.data === 'bigint'
              ? new Date(Number(wrapped.data) / 1000)
              : wrapped.data;
      }
      if (options.mode === 'string') {
        return timestampModeString(
          value,
          isTimestampWithTimezone(resolveTimestampType(options), options)
        );
      }
      if (value instanceof Date) {
        return value;
      }
      const stringValue = typeof value === 'string' ? value : value.toString();
      return new Date(timestampStringToDateInput(stringValue));
    },
  })(name).$type<TMode extends 'string' ? string : Date | string>();

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
        return timeFromMicros(value);
      }
      return value;
    },
  })(name);

export function duckDbArrayContains<T>(
  column: SQLWrapper,
  values: ArrayPredicateValue<T>
): SQL {
  const rhs = normalizeArrayPredicateValue(values, columnElementType(column));
  return sql`array_has_all(${column}, ${rhs})`;
}

export function duckDbArrayContained<T>(
  column: SQLWrapper,
  values: ArrayPredicateValue<T>
): SQL {
  const rhs = normalizeArrayPredicateValue(values, columnElementType(column));
  return sql`array_has_all(${rhs}, ${column})`;
}

export function duckDbArrayOverlaps<T>(
  column: SQLWrapper,
  values: ArrayPredicateValue<T>
): SQL {
  const rhs = normalizeArrayPredicateValue(values, columnElementType(column));
  return sql`array_has_any(${column}, ${rhs})`;
}
