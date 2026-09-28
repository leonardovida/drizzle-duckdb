import {
  listValue,
  arrayValue,
  structValue,
  mapValue,
  blobValue,
  timestampValue,
  timestampTZValue,
  type DuckDBValue,
  type DuckDBMapEntry,
} from '@duckdb/node-api';
import {
  DUCKDB_VALUE_MARKER,
  isDuckDBWrapper,
  wrapArray,
  wrapBlob,
  wrapJson,
  wrapList,
  wrapMap,
  wrapStruct,
  wrapTimestamp,
  type AnyDuckDBValueWrapper,
  type DuckDBValueWrapper,
  type ArrayValueWrapper,
  type BlobValueWrapper,
  type JsonValueWrapper,
  type ListValueWrapper,
  type MapValueWrapper,
  type StructValueWrapper,
  type TimestampValueWrapper,
  type DuckDBValueKind,
} from './value-wrappers-core.ts';
import {
  parseTimestampString,
  subMillisecondMicros,
  timestampStringToDateInput,
} from './time.ts';

/**
 * Convert a Date/string/epoch number to microseconds since Unix epoch.
 * Handles Date objects, ISO-like strings, bigint, and millisecond numbers.
 */
function dateToMicros(value: Date | string | number | bigint): bigint {
  if (value instanceof Date) {
    return BigInt(value.getTime()) * 1000n;
  }

  if (typeof value === 'bigint') {
    // Assume bigint already in microseconds (DuckDB default)
    return value;
  }

  if (typeof value === 'number') {
    // Assume JS milliseconds
    return BigInt(Math.trunc(value)) * 1000n;
  }

  // Strings without an offset are treated as UTC. Date only keeps
  // milliseconds, so the remaining microsecond digits are added back.
  const parts = parseTimestampString(value);
  const date = new Date(timestampStringToDateInput(value, parts));
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp string: ${value}`);
  }
  return BigInt(date.getTime()) * 1000n + subMillisecondMicros(parts?.fraction);
}

/**
 * Convert Buffer or Uint8Array to Uint8Array.
 */
function toUint8Array(data: Buffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array && !(data instanceof Buffer)
    ? data
    : new Uint8Array(data);
}

/**
 * Convert struct entries to DuckDB struct value entries.
 */
function convertStructEntries(
  data: Record<string, unknown>,
  toValue: (v: unknown) => DuckDBValue
): Record<string, DuckDBValue> {
  const entries: Record<string, DuckDBValue> = {};
  for (const [key, val] of Object.entries(data)) {
    entries[key] = toValue(val);
  }
  return entries;
}

/**
 * Convert map entries to DuckDB map entry format.
 */
function convertMapEntries(
  data: Record<string, unknown>,
  toValue: (v: unknown) => DuckDBValue
): DuckDBMapEntry[] {
  return Object.entries(data).map(([key, val]) => ({
    key: key as DuckDBValue,
    value: toValue(val),
  }));
}

/**
 * Convert a wrapper to a DuckDB Node API value.
 * Uses exhaustive switch for compile-time safety.
 */
export function wrapperToNodeApiValue(
  wrapper: AnyDuckDBValueWrapper,
  toValue: (v: unknown) => DuckDBValue
): DuckDBValue {
  switch (wrapper.kind) {
    case 'list':
      return listValue(wrapper.data.map(toValue));
    case 'array':
      return arrayValue(wrapper.data.map(toValue));
    case 'struct':
      return structValue(convertStructEntries(wrapper.data, toValue));
    case 'map':
      return mapValue(convertMapEntries(wrapper.data, toValue));
    case 'timestamp':
      return wrapper.withTimezone
        ? timestampTZValue(dateToMicros(wrapper.data))
        : timestampValue(dateToMicros(wrapper.data));
    case 'blob':
      return blobValue(toUint8Array(wrapper.data));
    case 'json':
      // JSON is stored as VARCHAR in DuckDB - stringify at binding time
      return JSON.stringify(wrapper.data);
    default: {
      // Exhaustive check - TypeScript will error if a case is missing
      const _exhaustive: never = wrapper;
      throw new Error(
        `Unknown wrapper kind: ${(_exhaustive as AnyDuckDBValueWrapper).kind}`
      );
    }
  }
}

// Re-export core helpers for convenience and backward compatibility.
export {
  DUCKDB_VALUE_MARKER,
  isDuckDBWrapper,
  wrapArray,
  wrapBlob,
  wrapJson,
  wrapList,
  wrapMap,
  wrapStruct,
  wrapTimestamp,
  type AnyDuckDBValueWrapper,
  type DuckDBValueWrapper,
  type ArrayValueWrapper,
  type BlobValueWrapper,
  type JsonValueWrapper,
  type ListValueWrapper,
  type MapValueWrapper,
  type StructValueWrapper,
  type TimestampValueWrapper,
  type DuckDBValueKind,
} from './value-wrappers-core.ts';
