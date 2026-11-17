import {
  Column,
  SQL,
  StringChunk,
  getColumnTable,
  getTableName,
  is,
  sql,
  type AnyColumn,
  type DriverValueDecoder,
} from 'drizzle-orm';
import {
  PgCustomColumn,
  PgDate,
  PgDateString,
  PgInet,
  PgInterval,
  PgTime,
  PgTimestamp,
  PgTimestampString,
} from 'drizzle-orm/pg-core';
import { assignOwnProperty } from '../own-property.ts';
import {
  dateStringFromDate,
  dateSubMillisecondMicros,
  intervalToString,
  timeFromMicros,
} from '../time.ts';

type SQLInternal<T = unknown> = SQL<T> & {
  decoder: DriverValueDecoder<T, any>;
};

type SQLCarrier = {
  getSQL?: () => SQL;
  sql?: SQL;
};

type DecoderInput<TDecoder extends DriverValueDecoder<unknown, unknown>> =
  Parameters<TDecoder['mapFromDriverValue']>[0];

type ResultRow = Record<string, unknown>;

/** Normalizes a decoded driver value, as drizzle-orm codecs do. */
export type ValueCodec = (value: unknown, dimensions?: number) => unknown;

/** Returns the `normalize` codec of a column, if it has one. */
export type CodecLookup = (column: Column) => ValueCodec | undefined;

/** The part of a drizzle-orm ordered selection entry the mapper reads. */
export interface SelectionFieldEntry {
  path: string[];
  field: unknown;
}

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
    AnyColumn | undefined;
}

// Drizzle's default decoder, shared by every SQL that has no mapWith().
const defaultSqlDecoder = (sql.empty() as SQLInternal).decoder;

function isEmptyStringChunk(chunk: unknown): boolean {
  return is(chunk, StringChunk) && chunk.value.trim() === '';
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

/** The table of a column field, or of the column an aliased field wraps. */
function fieldTableName(field: unknown): string | undefined {
  const column = is(field, Column)
    ? field
    : is(field, SQL.Aliased)
      ? findColumnInSql(getFieldSql(field as SQLCarrier))
      : undefined;
  return column ? getTableName(getColumnTable(column)) : undefined;
}

/**
 * The top-level keys of a joined selection whose object becomes null when
 * every column under it is null: those whose columns all come from one table
 * that a left, right or full join can leave out. Unlike drizzle-orm's own
 * version, this one also sees columns wrapped by the driver's field aliases.
 */
export function resolveNullableObjectPaths(
  columns: readonly SelectionFieldEntry[],
  joinsNotNullableMap: Record<string, boolean> | undefined
): string[] | undefined {
  if (!joinsNotNullableMap) return undefined;
  const tableOf = new Map<string, string | false>();
  for (const { path, field } of columns) {
    if (path.length !== 2) continue;
    const tableName = fieldTableName(field);
    if (tableName === undefined) continue;
    const key = path[0]!;
    const current = tableOf.get(key);
    if (current === undefined) tableOf.set(key, tableName);
    else if (current !== tableName) tableOf.set(key, false);
  }
  const result: string[] = [];
  for (const [key, table] of tableOf) {
    if (typeof table === 'string' && !joinsNotNullableMap[table]) {
      result.push(key);
    }
  }
  return result;
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
  for (let index = 0; index < hexGroups.length;) {
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

/**
 * The driver reads DuckDB's infinite timestamps as these strings, since a
 * Date cannot hold them. Decoders keep them instead of an invalid Date.
 */
export function isInfiniteTimestamp(value: unknown): value is string {
  return value === 'infinity' || value === '-infinity';
}

export function normalizeTimestampString(
  value: unknown,
  withTimezone: boolean
): string | unknown {
  if (isInfiniteTimestamp(value)) {
    return value;
  }
  if (value instanceof Date) {
    const micros = dateSubMillisecondMicros(value);
    const digits = micros
      ? String(micros).padStart(3, '0').replace(/0+$/, '')
      : '';
    const iso = value.toISOString().replace('T', ' ').replace('Z', digits);
    return withTimezone ? `${iso}+00` : iso;
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
    // toISOString() prints years outside 0001-9999 as +010000 or -000043.
    return dateStringFromDate(value);
  }
  if (typeof value === 'string') {
    return value === 'infinity' || value === '-infinity'
      ? value
      : value.slice(0, 10);
  }
  return value;
}

export function normalizeDateValue(value: unknown): Date | unknown {
  if (value instanceof Date) {
    return value;
  }
  if (isInfiniteTimestamp(value)) {
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

/**
 * DuckDB returns INTERVAL values as `{ months, days, micros }`. Format them
 * the way DuckDB casts an INTERVAL to VARCHAR, for example
 * `1 year 2 months 3 days 04:05:06`, which DuckDB and Postgres parse back.
 */
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
      micros?: number | string | bigint;
    };
    return intervalToString(Number(months), Number(days), BigInt(micros ?? 0));
  }
  return value;
}

/**
 * INET values arrive as plain objects. Only convert them for INET columns and
 * for SQL without a column type. A typed STRUCT column with the same three
 * fields keeps its value.
 */
function decodesInet(decoder: DriverValueDecoder<unknown, unknown>): boolean {
  if (is(decoder, PgInet)) return true;
  if (is(decoder, Column)) {
    // 'unknown' is the stand-in column exposeSubqueryFields() gives untyped
    // SQL fields of a subquery.
    const type = decoder.getSQLType().trim().toUpperCase();
    return type === 'INET' || type === 'UNKNOWN';
  }
  return true;
}

/**
 * Convert a node-api value into the input the column's decoder expects, such
 * as DuckDB's text for TIME and INTERVAL values. Decoding stays separate, so
 * Drizzle's relational mapper can decode the normalized value itself.
 */
function compileValueNormalizer(
  decoder: DriverValueDecoder<unknown, unknown>
): (value: unknown) => unknown {
  const inet = decodesInet(decoder) ? normalizeInet : (value: unknown) => value;
  let normalize: (value: unknown) => unknown = (value) => value;
  if (is(decoder, PgTimestampString)) {
    normalize = (value) =>
      normalizeTimestampString(value, decoder.withTimezone);
  } else if (is(decoder, PgTimestamp)) {
    normalize = (value) =>
      isInfiniteTimestamp(value)
        ? value
        : normalizeTimestamp(value, decoder.withTimezone);
  } else if (is(decoder, PgDateString)) {
    normalize = normalizeDateString;
  } else if (is(decoder, PgDate)) {
    normalize = normalizeDateValue;
  } else if (is(decoder, PgTime)) {
    normalize = normalizeTime;
  } else if (is(decoder, PgInterval)) {
    normalize = normalizeInterval;
  }
  return (value) => (value === null ? null : normalize(inet(value)));
}

/**
 * The column codec, then the decoder. drizzle-orm 1.0 moved the decoding of
 * built-in pg-core columns, such as `bigint({ mode: 'number' })`, from the
 * column into codecs, so both run.
 */
function decodeWith(
  decoder: DriverValueDecoder<unknown, unknown>,
  codec: ValueCodec | undefined
): (value: unknown) => unknown {
  const dimensions = is(decoder, Column)
    ? (decoder as Column & { dimensions?: number }).dimensions
    : undefined;
  if (codec) {
    return (value) =>
      decoder.mapFromDriverValue(
        toDecoderInput(decoder, codec(value, dimensions))
      );
  }
  return (value) => decoder.mapFromDriverValue(toDecoderInput(decoder, value));
}

function compileValueMapper(
  decoder: DriverValueDecoder<unknown, unknown>,
  codec?: ValueCodec
): (value: unknown) => unknown {
  const normalize = compileValueNormalizer(decoder);
  const decode = decodeWith(decoder, codec);
  if (is(decoder, PgTimestamp) || is(decoder, PgDate)) {
    // Dates are final, and infinite values keep DuckDB's text.
    return (value) => {
      const normalized = normalize(value);
      return normalized === null ||
        normalized instanceof Date ||
        isInfiniteTimestamp(normalized)
        ? normalized
        : decode(normalized);
    };
  }
  return (value) => {
    const normalized = normalize(value);
    return normalized === null ? null : decode(normalized);
  };
}

/** The part of a drizzle-orm relational query selection the driver reads. */
export interface RelationalSelectionItem {
  key: string;
  field: unknown;
  fieldType?: string;
  selection?: readonly RelationalSelectionItem[];
  isArray?: boolean;
}

/**
 * Name of the column, and struct field, at a position of a related row.
 * DuckDB matches identifiers case-insensitively, so keys such as userId and
 * userid cannot name the columns or the struct fields of a relation.
 */
export function relationColumnName(position: number): string {
  return `c${position}`;
}

/**
 * Normalize the values of relational query rows (`db.query`) in place, so
 * they reach drizzle-orm's relational mapper the way flat selects see them.
 * Relations arrive as native DuckDB structs and lists, whose fields are
 * normalized the same way and renamed from their positions to their keys.
 * Root rows are arrays, nested rows are objects.
 */
export function compileRelationalRowNormalizer(
  selection: readonly RelationalSelectionItem[]
): (row: unknown[]) => void {
  const normalizeObject = compileNestedNormalizer(selection);
  const steps = selection.map((item) =>
    item.selection
      ? nestedValueNormalizer(item, normalizeObject.get(item)!)
      : compileValueNormalizer(resolveFieldDecoder(item.field))
  );
  return (row) => {
    for (let index = 0; index < steps.length; index += 1) {
      row[index] = steps[index]!(row[index]);
    }
  };
}

type ObjectNormalizer = (
  row: Record<string, unknown>
) => Record<string, unknown>;

function compileNestedNormalizer(
  selection: readonly RelationalSelectionItem[]
): Map<RelationalSelectionItem, ObjectNormalizer> {
  const result = new Map<RelationalSelectionItem, ObjectNormalizer>();
  for (const item of selection) {
    if (!item.selection) continue;
    const inner = item.selection;
    const nested = compileNestedNormalizer(inner);
    const steps = inner.map(
      (child, position) =>
        [
          relationColumnName(position),
          child.key,
          child.selection
            ? nestedValueNormalizer(child, nested.get(child)!)
            : compileValueNormalizer(resolveFieldDecoder(child.field)),
        ] as const
    );
    result.set(item, (row) => {
      const normalized: Record<string, unknown> = {};
      for (const [field, key, step] of steps) {
        assignOwnProperty(normalized, key, step(row[field]));
      }
      return normalized;
    });
  }
  return result;
}

function nestedValueNormalizer(
  item: RelationalSelectionItem,
  normalizeObject: ObjectNormalizer
): (value: unknown) => unknown {
  return (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (item.isArray && Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const row = value[index];
        if (row && typeof row === 'object') {
          value[index] = normalizeObject(row as Record<string, unknown>);
        }
      }
      return value;
    }
    if (!Array.isArray(value)) {
      return normalizeObject(value as Record<string, unknown>);
    }
    return value;
  };
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

/**
 * Resolve stable field metadata once, before mapping any result rows.
 * `nullableObjectPaths` lists the top-level keys that become null when every
 * column under them is null (see resolveNullableObjectPaths()).
 */
export function compileResultMapper<TResult>(
  columns: readonly SelectionFieldEntry[],
  nullableObjectPaths?: readonly string[],
  codecOf?: CodecLookup
): (row: unknown[]) => TResult {
  const nullable = new Set(nullableObjectPaths ?? []);
  const plan = columns.map(({ path, field }) => {
    const decoder = resolveFieldDecoder(field);
    const codec = codecOf && is(decoder, Column) ? codecOf(decoder) : undefined;
    const nullifies =
      path.length === 2 &&
      nullable.has(path[0]!) &&
      fieldTableName(field) !== undefined;
    return {
      path: [...path],
      map: compileValueMapper(decoder, codec),
      nullifies,
    };
  });
  const flat = plan.every(({ path }) => path.length === 1);
  const nullifyTargets = [...nullable].map((key) => ({
    key,
    leaves: plan.flatMap((entry, index) =>
      entry.nullifies && entry.path[0] === key ? [index] : []
    ),
  }));

  return (row) => {
    const result: ResultRow = {};
    const values = nullifyTargets.length ? new Array(plan.length) : undefined;
    for (let index = 0; index < plan.length; index += 1) {
      const { path, map } = plan[index]!;
      const value = map(row[index]);
      if (values) values[index] = value;
      if (flat) assignOwnProperty(result, path[0]!, value);
      else assignResultPath(result, path, value);
    }
    if (values) {
      for (const { key, leaves } of nullifyTargets) {
        if (
          leaves.length > 0 &&
          leaves.every((index) => values[index] === null)
        ) {
          assignOwnProperty(result, key, null);
        }
      }
    }
    return result as TResult;
  };
}
