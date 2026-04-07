import {
  Column,
  SQL,
  getTableName,
  is,
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

function resolveFieldDecoder(
  field: unknown
): DriverValueDecoder<unknown, unknown> {
  if (is(field, Column)) {
    return field;
  }

  if (is(field, SQL)) {
    return (field as SQLInternal).decoder;
  }

  const fieldSql = getFieldSql(field as SQLCarrier);
  const column = findColumnInSql(fieldSql);

  if (is(column, PgCustomColumn)) {
    return column;
  }

  return fieldSql?.decoder ?? passthroughDecoder;
}

function trackNullifyTarget(
  nullifyMap: NullifyMap,
  objectName: string,
  tableName: string,
  value: unknown
): void {
  if (!(objectName in nullifyMap)) {
    nullifyMap[objectName] = value === null ? tableName : false;
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

export function normalizeInet(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    'address' in value &&
    typeof (value as { address: unknown }).address !== 'undefined'
  ) {
    const { address, mask } = value as {
      address: bigint | number;
      mask?: number;
    };

    if (typeof address === 'bigint' || typeof address === 'number') {
      const inet = typeof address === 'number' ? BigInt(address) : address;
      const maxIpv4 = (1n << 32n) - 1n;
      if (inet >= 0 && inet <= maxIpv4) {
        const num = Number(inet);
        const octets = [
          (num >>> 24) & 255,
          (num >>> 16) & 255,
          (num >>> 8) & 255,
          num & 255,
        ];
        const suffix =
          typeof mask === 'number' && mask !== 32 ? `/${mask}` : '';
        return `${octets.join('.')}${suffix}`;
      }
    }

    const fallback = (value as { toString?: () => string }).toString?.();
    if (fallback && fallback !== '[object Object]') {
      return fallback;
    }
  }

  return value;
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
    const totalMillis = Number(value) / 1000;
    const date = new Date(totalMillis);
    return date.toISOString().split('T')[1]!.replace('Z', '');
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
  if (is(decoder, PgTimestampString)) {
    return decoder.mapFromDriverValue(
      toDecoderInput(
        decoder,
        normalizeTimestampString(rawValue, decoder.withTimezone)
      )
    );
  }

  if (is(decoder, PgTimestamp)) {
    const normalized = normalizeTimestamp(rawValue, decoder.withTimezone);
    if (normalized instanceof Date) {
      return normalized;
    }
    return decoder.mapFromDriverValue(toDecoderInput(decoder, normalized));
  }

  if (is(decoder, PgDateString)) {
    return decoder.mapFromDriverValue(
      toDecoderInput(decoder, normalizeDateString(rawValue))
    );
  }

  if (is(decoder, PgDate)) {
    return decoder.mapFromDriverValue(
      toDecoderInput(decoder, normalizeDateValue(rawValue))
    );
  }

  if (is(decoder, PgTime)) {
    return decoder.mapFromDriverValue(
      toDecoderInput(decoder, normalizeTime(rawValue))
    );
  }

  if (is(decoder, PgInterval)) {
    return decoder.mapFromDriverValue(
      toDecoderInput(decoder, normalizeInterval(rawValue))
    );
  }

  return decoder.mapFromDriverValue(toDecoderInput(decoder, rawValue));
}

export function mapResultRow<TResult>(
  columns: SelectedFieldsOrdered<AnyColumn>,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined
): TResult {
  const nullifyMap: NullifyMap = {};

  const result = columns.reduce<Record<string, any>>(
    (acc, { path, field }, columnIndex) => {
      const decoder = resolveFieldDecoder(field);
      let node = acc;
      for (const [pathChunkIndex, pathChunk] of path.entries()) {
        if (pathChunkIndex < path.length - 1) {
          if (!(pathChunk in node)) {
            node[pathChunk] = {};
          }
          node = node[pathChunk];
          continue;
        }

        const rawValue = normalizeInet(row[columnIndex]!);

        const value = (node[pathChunk] =
          rawValue === null ? null : mapDriverValue(decoder, rawValue));

        if (joinsNotNullableMap) {
          trackJoinedObjectNullability(nullifyMap, field, path, value);
        }
      }
      return acc;
    },
    {}
  );

  if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
    for (const [objectName, tableName] of Object.entries(nullifyMap)) {
      if (typeof tableName === 'string' && !joinsNotNullableMap[tableName]) {
        result[objectName] = null;
      }
    }
  }

  return result as TResult;
}
