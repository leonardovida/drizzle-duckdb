import {
  Column,
  SQL,
  StringChunk,
  getTableName,
  is,
  sql,
  type AnyColumn,
  type DriverValueDecoder,
  type SelectedFieldsOrdered,
} from 'drizzle-orm';
import {
  PgCustomColumn,
  PgDate,
  PgDateString,
  PgInterval,
  PgTime,
  PgTimestamp,
  PgTimestampString,
} from 'drizzle-orm/pg-core';
import { assignOwnProperty } from '../own-property.ts';
import { timeFromMicros } from '../time.ts';

type SQLInternal<T = unknown> = SQL<T> & {
  decoder: DriverValueDecoder<T, any>;
};

type SQLCarrier = {
  getSQL?: () => SQL;
  sql?: SQL;
};

type DecoderInput<TDecoder extends DriverValueDecoder<unknown, unknown>> =
  Parameters<TDecoder['mapFromDriverValue']>[0];

type NullifyMap = Record<string, string | false>;
type ResultRow = Record<string, unknown>;

const passthroughDecoder: DriverValueDecoder<unknown, unknown> = {
  mapFromDriverValue: (value) => value,
};

function toDecoderInput<TDecoder extends DriverValueDecoder<unknown, unknown>>(
  decoder: TDecoder,
  value: unknown
): DecoderInput<TDecoder> {
  void decoder;
  return value as DecoderInput<TDecoder>;
}

function getFieldSql(field: SQLCarrier): SQLInternal | undefined {
  if (field.sql && is(field.sql, SQL)) {
    return field.sql as SQLInternal;
  }

  if (typeof field.getSQL === 'function') {
    const sqlValue = field.getSQL();
    if (is(sqlValue, SQL)) {
      return sqlValue as SQLInternal;
    }
  }

  return undefined;
}

function findColumnInSql(sqlValue: SQL | undefined): AnyColumn | undefined {
  return sqlValue?.queryChunks.find((chunk: unknown) => is(chunk, Column)) as
    | AnyColumn
    | undefined;
}

// Drizzle's default decoder, shared by every SQL that has no mapWith().
const defaultSqlDecoder = (sql.empty() as SQLInternal).decoder;

function isEmptyStringChunk(chunk: unknown): boolean {
  return (
    is(chunk, StringChunk) && chunk.value.every((part) => part.trim() === '')
  );
}

/**
 * Return the column when the SQL is only `sql\`${column}\``. Expressions that
 * merely mention a column, such as `extract(hour from ${column})`, return
 * undefined.
 */
function singleColumnInSql(sqlValue: SQL | undefined): AnyColumn | undefined {
  if (!sqlValue) return undefined;
  const chunks = sqlValue.queryChunks.filter(
    (chunk: unknown) => !isEmptyStringChunk(chunk)
  );
  return chunks.length === 1 && is(chunks[0], Column)
    ? (chunks[0] as AnyColumn)
    : undefined;
}

export function resolveFieldDecoder(
  field: unknown
): DriverValueDecoder<unknown, unknown> {
  if (is(field, Column)) {
    return field;
  }

  if (is(field, SQL)) {
    return (field as SQLInternal).decoder;
  }

  const fieldSql = getFieldSql(field as SQLCarrier);

  // `sql\`${customColumn}\`.as('x')` without mapWith() still decodes with the
  // column. Any other expression uses its own decoder, as in stock Drizzle.
  if (fieldSql?.decoder === defaultSqlDecoder) {
    const column = singleColumnInSql(fieldSql);
    if (is(column, PgCustomColumn)) {
      return column;
    }
  }

  return fieldSql?.decoder ?? passthroughDecoder;
}

function trackNullifyTarget(
  nullifyMap: NullifyMap,
  objectName: string,
  tableName: string,
  value: unknown
): void {
  if (!Object.hasOwn(nullifyMap, objectName)) {
    assignOwnProperty(
      nullifyMap,
      objectName,
      value === null ? tableName : false
    );
    return;
  }

  if (nullifyMap[objectName] && nullifyMap[objectName] !== tableName) {
    nullifyMap[objectName] = false;
  }
}

function trackJoinedObjectNullability(
  nullifyMap: NullifyMap,
  field: unknown,
  path: string[],
  value: unknown
): void {
  if (path.length !== 2) {
    return;
  }

  const objectName = path[0] as string;

  if (is(field, Column)) {
    trackNullifyTarget(
      nullifyMap,
      objectName,
      getTableName(field.table),
      value
    );
    return;
  }

  if (!is(field, SQL.Aliased)) {
    return;
  }

  const column = findColumnInSql(getFieldSql(field as SQLCarrier));
  const tableName = column?.table && getTableName(column.table);

  if (tableName) {
    trackNullifyTarget(nullifyMap, objectName, tableName, value);
  }
}

type InetValue = {
  ip_type: 1 | 2;
  address: bigint | number;
  mask: number;
};

/**
 * Match the plain object DuckDB returns for INET values, so structs that
 * happen to have an `address` field are left alone.
 */
function isInetValue(value: unknown): value is InetValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const inet = value as Record<string, unknown>;
  return (
    Object.keys(inet).length === 3 &&
    (inet.ip_type === 1 || inet.ip_type === 2) &&
    (typeof inet.address === 'bigint' || Number.isSafeInteger(inet.address)) &&
    typeof inet.mask === 'number'
  );
}

function formatIpv4(address: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => ((address >> shift) & 255n).toString())
    .join('.');
}

/** Format IPv6 the way DuckDB casts INET to VARCHAR. */
function formatIpv6(address: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((address >> BigInt(112 - index * 16)) & 0xffffn)
  );
  const leadingZeros = (count: number) =>
    groups.slice(0, count).every((group) => group === 0);

  // IPv4 mapped (::ffff:a.b.c.d) and compatible (::a.b.c.d) addresses keep
  // their last 32 bits in dotted form.
  const dotted =
    (leadingZeros(5) && groups[5] === 0xffff) ||
    (leadingZeros(6) && groups[6] !== 0);
  const hexGroups = dotted ? groups.slice(0, 6) : groups;

  let runStart = -1;
  let runLength = 0;
  for (let index = 0; index < hexGroups.length; ) {
    if (hexGroups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < hexGroups.length && hexGroups[end] === 0) end += 1;
    if (end - index > runLength) {
      runStart = index;
      runLength = end - index;
    }
    index = end;
  }

  const hex = hexGroups.map((group) => group.toString(16));
  let text =
    runLength >= 2
      ? `${hex.slice(0, runStart).join(':')}::${hex.slice(runStart + runLength).join(':')}`
      : hex.join(':');

  if (dotted) {
    text += `${text.endsWith(':') ? '' : ':'}${formatIpv4(address & 0xffffffffn)}`;
  }
  return text;
}

export function normalizeInet(value: unknown): unknown {
  if (!isInetValue(value)) {
    return value;
  }

  const address = BigInt(value.address);
  if (value.ip_type === 1) {
    if (address < 0n || address > 0xffffffffn) {
      return value;
    }
    const suffix = value.mask !== 32 ? `/${value.mask}` : '';
    return `${formatIpv4(address)}${suffix}`;
  }

  // DuckDB stores IPv6 as a signed HUGEINT offset by 2^127.
  const unsigned = address + (1n << 127n);
  if (unsigned < 0n || unsigned >= 1n << 128n) {
    return value;
  }
  const suffix = value.mask !== 128 ? `/${value.mask}` : '';
  return `${formatIpv6(unsigned)}${suffix}`;
}

export function normalizeTimestampString(
  value: unknown,
  withTimezone: boolean
): string | unknown {
  if (value instanceof Date) {
    const iso = value.toISOString().replace('T', ' ');
    return withTimezone ? iso.replace('Z', '+00') : iso.replace('Z', '');
  }
  if (typeof value === 'string') {
    const normalized = value.replace('T', ' ');
    const hasTimezoneSuffix = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
      normalized.trim()
    );
    if (withTimezone) {
      return hasTimezoneSuffix ? normalized : `${normalized}+00`;
    }
    return normalized.replace(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/, '');
  }
  return value;
}

export function normalizeTimestamp(
  value: unknown,
  withTimezone: boolean
): Date | unknown {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    const hasOffset =
      value.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(value.trim());
    const spaced = value.replace(' ', 'T');
    const normalized = withTimezone || hasOffset ? spaced : `${spaced}+00`;
    return new Date(normalized);
  }
  return value;
}

export function normalizeDateString(value: unknown): string | unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return value;
}

export function normalizeDateValue(value: unknown): Date | unknown {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(`${value.slice(0, 10)}T00:00:00Z`);
  }
  return value;
}

export function normalizeTime(value: unknown): string | unknown {
  if (typeof value === 'bigint') {
    return timeFromMicros(value);
  }
  if (value instanceof Date) {
    return value.toISOString().split('T')[1]!.replace('Z', '');
  }
  return value;
}

export function normalizeInterval(value: unknown): string | unknown {
  if (
    value &&
    typeof value === 'object' &&
    'days' in value &&
    'months' in value
  ) {
    const { months, days, micros } = value as {
      months: number;
      days: number;
      micros?: number | string;
    };

    if (months === 0 && days !== undefined) {
      if (micros && Number(micros) !== 0) {
        const seconds = Number(micros) / 1_000_000;
        return `${days} day${days === 1 ? '' : 's'} ${seconds} seconds`.trim();
      }
      return `${days} day${days === 1 ? '' : 's'}`;
    }
  }
  return value;
}

function mapDriverValue(
  decoder: DriverValueDecoder<unknown, unknown>,
  rawValue: unknown
): unknown {
  let normalized = rawValue;

  if (is(decoder, PgTimestampString)) {
    normalized = normalizeTimestampString(rawValue, decoder.withTimezone);
  } else if (is(decoder, PgTimestamp)) {
    normalized = normalizeTimestamp(rawValue, decoder.withTimezone);
    if (normalized instanceof Date) {
      return normalized;
    }
  } else if (is(decoder, PgDateString)) {
    normalized = normalizeDateString(rawValue);
  } else if (is(decoder, PgDate)) {
    normalized = normalizeDateValue(rawValue);
  } else if (is(decoder, PgTime)) {
    normalized = normalizeTime(rawValue);
  } else if (is(decoder, PgInterval)) {
    normalized = normalizeInterval(rawValue);
  }

  return decoder.mapFromDriverValue(toDecoderInput(decoder, normalized));
}

function mapFieldValue(
  decoder: DriverValueDecoder<unknown, unknown>,
  rawValue: unknown
): unknown {
  const normalized = normalizeInet(rawValue);
  return normalized === null ? null : mapDriverValue(decoder, normalized);
}

function assignResultPath(
  result: ResultRow,
  path: string[],
  value: unknown
): void {
  if (path.length === 0) {
    return;
  }

  let node = result;
  for (
    let pathChunkIndex = 0;
    pathChunkIndex < path.length - 1;
    pathChunkIndex += 1
  ) {
    const pathChunk = path[pathChunkIndex] as string;

    if (!Object.hasOwn(node, pathChunk)) {
      assignOwnProperty(node, pathChunk, {});
    }

    node = node[pathChunk] as ResultRow;
  }

  assignOwnProperty(node, path[path.length - 1] as string, value);
}

export function mapResultRow<TResult>(
  columns: SelectedFieldsOrdered<AnyColumn>,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined
): TResult {
  const nullifyMap = Object.create(null) as NullifyMap;
  const result: ResultRow = {};

  for (const [columnIndex, { path, field }] of columns.entries()) {
    const decoder = resolveFieldDecoder(field);
    const value = mapFieldValue(decoder, row[columnIndex]!);

    assignResultPath(result, path, value);

    if (joinsNotNullableMap) {
      trackJoinedObjectNullability(nullifyMap, field, path, value);
    }
  }

  if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
    for (const [objectName, tableName] of Object.entries(nullifyMap)) {
      if (typeof tableName === 'string' && !joinsNotNullableMap[tableName]) {
        assignOwnProperty(result, objectName, null);
      }
    }
  }

  return result as TResult;
}
