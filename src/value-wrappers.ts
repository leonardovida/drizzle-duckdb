import {
  listValue,
  arrayValue,
  structValue,
  mapValue,
  blobValue,
  timestampValue,
  timestampTZValue,
  ARRAY,
  BIGINT,
  BLOB,
  BOOLEAN,
  DATE,
  DOUBLE,
  DuckDBArrayValue,
  DuckDBBlobValue,
  DuckDBDateValue,
  DuckDBIntervalValue,
  DuckDBListValue,
  DuckDBMapValue,
  DuckDBStructValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTimeValue,
  DuckDBTypeId,
  DuckDBUUIDValue,
  FLOAT,
  HUGEINT,
  INTEGER,
  INTERVAL,
  LIST,
  MAP,
  SMALLINT,
  SQLNULL,
  STRUCT,
  TIME,
  TIMESTAMP,
  TIMESTAMPTZ,
  TINYINT,
  UBIGINT,
  UINTEGER,
  USMALLINT,
  UTINYINT,
  UUID,
  VARCHAR,
  type DuckDBArrayType,
  type DuckDBListType,
  type DuckDBMapType,
  type DuckDBStructType,
  type DuckDBType,
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
    return dateToEpochMicros(value);
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
 * Convert a Date to microseconds since the Unix epoch. An invalid Date has no
 * timestamp to bind, so it fails here with a clear message.
 */
function dateToEpochMicros(value: Date): bigint {
  const millis = value.getTime();
  if (Number.isNaN(millis)) {
    throw new Error('Invalid Date parameter: cannot bind an invalid Date');
  }
  return BigInt(millis) * 1000n;
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
 * Converts one JS value to a node-api value. The optional type is the DuckDB
 * type the value is bound to, taken from a wrapper's element or value type.
 */
export type NodeApiValueConverter = (
  value: unknown,
  typeHint?: DuckDBType
) => DuckDBValue;

/**
 * Convert struct entries to DuckDB struct value entries.
 */
function convertStructEntries(
  data: Record<string, unknown>,
  toValue: NodeApiValueConverter,
  schema: Record<string, string> | undefined
): Record<string, DuckDBValue> {
  const entries: Record<string, DuckDBValue> = {};
  for (const [key, val] of Object.entries(data)) {
    entries[key] = toValue(val, parseNodeApiTypeHint(schema?.[key]));
  }
  return entries;
}

/**
 * Convert map entries to DuckDB map entry format.
 */
function convertMapEntries(
  data: Record<string, unknown>,
  toValue: NodeApiValueConverter,
  valueType: DuckDBType | undefined
): DuckDBMapEntry[] {
  return Object.entries(data).map(([key, val]) => ({
    key: key as DuckDBValue,
    value: toValue(val, valueType),
  }));
}

/**
 * Convert a wrapper to a DuckDB Node API value.
 * Uses exhaustive switch for compile-time safety.
 */
export function wrapperToNodeApiValue(
  wrapper: AnyDuckDBValueWrapper,
  toValue: NodeApiValueConverter
): DuckDBValue {
  switch (wrapper.kind) {
    case 'list': {
      const itemType = parseNodeApiTypeHint(wrapper.elementType);
      return withNodeApiItemTypeHint(
        listValue(wrapper.data.map((item) => toValue(item, itemType))),
        itemType
      );
    }
    case 'array': {
      const itemType = parseNodeApiTypeHint(wrapper.elementType);
      return withNodeApiItemTypeHint(
        arrayValue(wrapper.data.map((item) => toValue(item, itemType))),
        itemType
      );
    }
    case 'struct':
      return structValue(
        convertStructEntries(wrapper.data, toValue, wrapper.schema)
      );
    case 'map': {
      const valueType = parseNodeApiTypeHint(wrapper.valueType);
      return withNodeApiItemTypeHint(
        mapValue(convertMapEntries(wrapper.data, toValue, valueType)),
        valueType
      );
    }
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

/*
 * node-api infers a list's type from its first item only. A list that starts
 * with null becomes LIST(NULL) and binds every item as NULL, and [1, 2.5]
 * fails because 1 makes it an INTEGER list. The helpers below work out the
 * type from every item, and prefer the element type a wrapper declares when
 * the items fit it. The result is passed to node-api through the `types`
 * argument of run(), stream() and bind().
 */

const SCALAR_TYPE_HINTS: Record<string, DuckDBType> = {
  BOOLEAN,
  BOOL: BOOLEAN,
  LOGICAL: BOOLEAN,
  TINYINT,
  INT1: TINYINT,
  SMALLINT,
  INT2: SMALLINT,
  INT16: SMALLINT,
  SHORT: SMALLINT,
  INTEGER,
  INT: INTEGER,
  INT4: INTEGER,
  INT32: INTEGER,
  SIGNED: INTEGER,
  BIGINT,
  INT8: BIGINT,
  INT64: BIGINT,
  LONG: BIGINT,
  HUGEINT,
  INT128: HUGEINT,
  UTINYINT,
  USMALLINT,
  UINTEGER,
  UBIGINT,
  FLOAT,
  FLOAT4: FLOAT,
  REAL: FLOAT,
  DOUBLE,
  FLOAT8: DOUBLE,
  VARCHAR,
  STRING: VARCHAR,
  TEXT: VARCHAR,
  CHAR: VARCHAR,
  BPCHAR: VARCHAR,
  BLOB,
  BYTEA: BLOB,
  VARBINARY: BLOB,
  BINARY: BLOB,
  DATE,
  TIME,
  INTERVAL,
  UUID,
  TIMESTAMP,
  DATETIME: TIMESTAMP,
  'TIMESTAMP WITHOUT TIME ZONE': TIMESTAMP,
  TIMESTAMPTZ,
  TIMESTAMP_TZ: TIMESTAMPTZ,
  'TIMESTAMP WITH TIME ZONE': TIMESTAMPTZ,
};

const TYPE_HINT_CACHE_LIMIT = 256;
const typeHintCache = new Map<string, DuckDBType | null>();

function parseTypeHintUncached(hint: string): DuckDBType | undefined {
  const normalized = hint.trim().replace(/\s+/g, ' ').toUpperCase();
  const listMatch = /^(.+?)\s*\[\s*(\d*)\s*\]$/.exec(normalized);
  if (listMatch) {
    const itemType = parseTypeHintUncached(listMatch[1] as string);
    if (!itemType) return undefined;
    return listMatch[2]
      ? ARRAY(itemType, Number(listMatch[2]))
      : LIST(itemType);
  }
  return Object.prototype.hasOwnProperty.call(SCALAR_TYPE_HINTS, normalized)
    ? SCALAR_TYPE_HINTS[normalized]
    : undefined;
}

/**
 * Parse a DuckDB type name such as `INTEGER`, `TIMESTAMPTZ` or `VARCHAR[]`.
 * Returns undefined for names it does not know, such as STRUCT or DECIMAL,
 * which leaves the type to inference.
 */
function parseNodeApiTypeHint(
  hint: string | undefined
): DuckDBType | undefined {
  if (!hint) return undefined;
  const cached = typeHintCache.get(hint);
  if (cached !== undefined) return cached ?? undefined;
  const parsed = parseTypeHintUncached(hint);
  if (typeHintCache.size >= TYPE_HINT_CACHE_LIMIT) {
    typeHintCache.clear();
  }
  typeHintCache.set(hint, parsed ?? null);
  return parsed;
}

/** The declared item type of a list or array value, or the value type of a map. */
const itemTypeHints = new WeakMap<object, DuckDBType>();

/**
 * Record the declared item type of a list, array or map value, for
 * typedNodeApiParam() to bind it with.
 */
export function withNodeApiItemTypeHint<T extends DuckDBValue>(
  value: T,
  itemType: DuckDBType | undefined
): T {
  if (itemType && value !== null && typeof value === 'object') {
    itemTypeHints.set(value, itemType);
  }
  return value;
}

function numberType(value: number): DuckDBType {
  if (Number.isInteger(value)) {
    if (value >= -2_147_483_648 && value <= 2_147_483_647) {
      return INTEGER;
    }
    // An integral number outside the safe range is not exact as an int64.
    return Number.isSafeInteger(value) ? BIGINT : DOUBLE;
  }
  return DOUBLE;
}

const NUMBER_TYPE_RANK: Partial<Record<DuckDBTypeId, number>> = {
  [DuckDBTypeId.INTEGER]: 1,
  [DuckDBTypeId.BIGINT]: 2,
  [DuckDBTypeId.DOUBLE]: 3,
};

/** Declared types that accept every item of an inferred number type. */
const WIDER_NUMBER_TYPES: Partial<Record<DuckDBTypeId, Set<DuckDBTypeId>>> = {
  [DuckDBTypeId.INTEGER]: new Set([
    DuckDBTypeId.BIGINT,
    DuckDBTypeId.FLOAT,
    DuckDBTypeId.DOUBLE,
  ]),
  [DuckDBTypeId.BIGINT]: new Set([DuckDBTypeId.FLOAT, DuckDBTypeId.DOUBLE]),
  [DuckDBTypeId.DOUBLE]: new Set([DuckDBTypeId.FLOAT]),
  [DuckDBTypeId.HUGEINT]: new Set([DuckDBTypeId.BIGINT]),
};

/**
 * Combine the types of two items of the same list. When they cannot be
 * combined, the first type wins and node-api reports the mismatched item.
 */
function unifyTypes(a: DuckDBType, b: DuckDBType): DuckDBType {
  if (a.typeId === DuckDBTypeId.SQLNULL) return b;
  if (b.typeId === DuckDBTypeId.SQLNULL || a === b) return a;

  if (a.typeId === b.typeId) {
    switch (a.typeId) {
      case DuckDBTypeId.LIST: {
        const itemType = unifyTypes(
          (a as DuckDBListType).valueType,
          (b as DuckDBListType).valueType
        );
        return itemType === (a as DuckDBListType).valueType
          ? a
          : LIST(itemType);
      }
      case DuckDBTypeId.ARRAY: {
        const left = a as DuckDBArrayType;
        const right = b as DuckDBArrayType;
        if (left.length !== right.length) return a;
        const itemType = unifyTypes(left.valueType, right.valueType);
        return itemType === left.valueType ? a : ARRAY(itemType, left.length);
      }
      case DuckDBTypeId.MAP: {
        const left = a as DuckDBMapType;
        const right = b as DuckDBMapType;
        const keyType = unifyTypes(left.keyType, right.keyType);
        const valueType = unifyTypes(left.valueType, right.valueType);
        return keyType === left.keyType && valueType === left.valueType
          ? a
          : MAP(keyType, valueType);
      }
      case DuckDBTypeId.STRUCT: {
        const left = a as DuckDBStructType;
        const right = b as DuckDBStructType;
        if (
          left.entryNames.length !== right.entryNames.length ||
          left.entryNames.some((name, i) => right.entryNames[i] !== name)
        ) {
          return a;
        }
        let changed = false;
        const entries: Record<string, DuckDBType> = {};
        left.entryNames.forEach((name, i) => {
          const entryType = unifyTypes(
            left.entryTypes[i] as DuckDBType,
            right.entryTypes[i] as DuckDBType
          );
          changed ||= entryType !== left.entryTypes[i];
          entries[name] = entryType;
        });
        return changed ? STRUCT(entries) : a;
      }
      default:
        return a;
    }
  }

  const rankA = NUMBER_TYPE_RANK[a.typeId];
  const rankB = NUMBER_TYPE_RANK[b.typeId];
  if (rankA !== undefined && rankB !== undefined) {
    return rankA >= rankB ? a : b;
  }
  return a;
}

/** Use the declared type when every inferred item fits it. */
function resolveDeclaredType(
  declared: DuckDBType,
  inferred: DuckDBType
): DuckDBType {
  if (inferred.typeId === DuckDBTypeId.SQLNULL) return declared;

  if (declared.typeId === inferred.typeId) {
    switch (declared.typeId) {
      case DuckDBTypeId.LIST:
        return LIST(
          resolveDeclaredType(
            (declared as DuckDBListType).valueType,
            (inferred as DuckDBListType).valueType
          )
        );
      case DuckDBTypeId.ARRAY: {
        const left = declared as DuckDBArrayType;
        const right = inferred as DuckDBArrayType;
        return left.length === right.length
          ? ARRAY(
              resolveDeclaredType(left.valueType, right.valueType),
              left.length
            )
          : inferred;
      }
      default:
        return declared;
    }
  }

  return WIDER_NUMBER_TYPES[inferred.typeId]?.has(declared.typeId)
    ? declared
    : inferred;
}

function inferItemsType(
  items: readonly DuckDBValue[],
  declared: DuckDBType | undefined
): DuckDBType | undefined {
  let inferred: DuckDBType | undefined;
  for (const item of items) {
    const itemType = inferNodeApiType(item);
    if (!itemType) return undefined;
    inferred = inferred ? unifyTypes(inferred, itemType) : itemType;
  }
  if (!inferred) return declared;
  return declared ? resolveDeclaredType(declared, inferred) : inferred;
}

/**
 * Infer the DuckDB type of a node-api value from all of its items. Returns
 * undefined for values it does not know, which leaves them to node-api.
 */
function inferNodeApiType(value: DuckDBValue): DuckDBType | undefined {
  if (value === null) return SQLNULL;

  switch (typeof value) {
    case 'number':
      return numberType(value);
    case 'string':
      return VARCHAR;
    case 'boolean':
      return BOOLEAN;
    case 'bigint':
      return HUGEINT;
    case 'object':
      break;
    default:
      return undefined;
  }

  if (value instanceof DuckDBListValue) {
    const itemType = inferItemsType(value.items, itemTypeHints.get(value));
    return itemType ? LIST(itemType) : undefined;
  }
  if (value instanceof DuckDBArrayValue) {
    const itemType = inferItemsType(value.items, itemTypeHints.get(value));
    return itemType ? ARRAY(itemType, value.items.length) : undefined;
  }
  if (value instanceof DuckDBMapValue) {
    if (value.entries.length === 0) return undefined;
    const keyType = inferItemsType(
      value.entries.map((entry) => entry.key),
      undefined
    );
    const valueType = inferItemsType(
      value.entries.map((entry) => entry.value),
      itemTypeHints.get(value)
    );
    return keyType && valueType ? MAP(keyType, valueType) : undefined;
  }
  if (value instanceof DuckDBStructValue) {
    const entries: Record<string, DuckDBType> = {};
    for (const key in value.entries) {
      const entryType = inferNodeApiType(value.entries[key] as DuckDBValue);
      if (!entryType) return undefined;
      entries[key] = entryType;
    }
    return STRUCT(entries);
  }
  if (value instanceof DuckDBTimestampTZValue) return TIMESTAMPTZ;
  if (value instanceof DuckDBTimestampValue) return TIMESTAMP;
  if (value instanceof DuckDBBlobValue) return BLOB;
  if (value instanceof DuckDBDateValue) return DATE;
  if (value instanceof DuckDBTimeValue) return TIME;
  if (value instanceof DuckDBIntervalValue) return INTERVAL;
  if (value instanceof DuckDBUUIDValue) return UUID;
  return undefined;
}

const BIGINT_TYPE_IDS = new Set<DuckDBTypeId>([
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
]);

function alignItems(
  items: readonly DuckDBValue[],
  type: DuckDBType
): readonly DuckDBValue[] {
  let aligned: DuckDBValue[] | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as DuckDBValue;
    const next = alignValueToType(item, type);
    if (next !== item) {
      aligned ??= items.slice();
      aligned[index] = next;
    }
  }
  return aligned ?? items;
}

/**
 * Make items match the type they bind with. node-api 1.4 only creates
 * BIGINT and HUGEINT values from a JS bigint, so integral numbers bound to
 * those types become bigints. Unchanged values keep their identity.
 */
function alignValueToType(value: DuckDBValue, type: DuckDBType): DuckDBValue {
  if (value === null) return value;

  if (typeof value === 'number') {
    return BIGINT_TYPE_IDS.has(type.typeId) && Number.isInteger(value)
      ? BigInt(value)
      : value;
  }

  switch (type.typeId) {
    case DuckDBTypeId.LIST:
      if (value instanceof DuckDBListValue) {
        const items = alignItems(
          value.items,
          (type as DuckDBListType).valueType
        );
        return items === value.items ? value : listValue(items);
      }
      return value;
    case DuckDBTypeId.ARRAY:
      if (value instanceof DuckDBArrayValue) {
        const items = alignItems(
          value.items,
          (type as DuckDBArrayType).valueType
        );
        return items === value.items ? value : arrayValue(items);
      }
      return value;
    case DuckDBTypeId.MAP:
      if (value instanceof DuckDBMapValue) {
        const mapType = type as DuckDBMapType;
        let changed = false;
        const entries = value.entries.map((entry) => {
          const key = alignValueToType(entry.key, mapType.keyType);
          const entryValue = alignValueToType(entry.value, mapType.valueType);
          changed ||= key !== entry.key || entryValue !== entry.value;
          return { key, value: entryValue };
        });
        return changed ? mapValue(entries) : value;
      }
      return value;
    case DuckDBTypeId.STRUCT:
      if (value instanceof DuckDBStructValue) {
        const structType = type as DuckDBStructType;
        let changed = false;
        const entries: Record<string, DuckDBValue> = {};
        structType.entryNames.forEach((name, index) => {
          const entry = value.entries[name] as DuckDBValue;
          const next = alignValueToType(
            entry,
            structType.entryTypes[index] as DuckDBType
          );
          changed ||= next !== entry;
          entries[name] = next;
        });
        return changed ? structValue(entries) : value;
      }
      return value;
    default:
      return value;
  }
}

/**
 * The type to bind a parameter with, when node-api's own inference would get
 * it wrong, and the value adjusted to that type. Returns undefined for values
 * node-api handles by itself.
 */
export function typedNodeApiParam(
  value: DuckDBValue
): { value: DuckDBValue; type: DuckDBType } | undefined {
  if (typeof value === 'number') {
    // node-api 1.4 binds every integral number as INTEGER and wraps values
    // outside int32, so 3e9 would be stored as -1294967296.
    const type = numberType(value);
    if (type === BIGINT) return { value: BigInt(value), type };
    if (type === DOUBLE && Number.isInteger(value)) return { value, type };
    return undefined;
  }
  if (
    value instanceof DuckDBListValue ||
    value instanceof DuckDBArrayValue ||
    value instanceof DuckDBMapValue ||
    value instanceof DuckDBStructValue
  ) {
    const type = inferNodeApiType(value);
    return type ? { value: alignValueToType(value, type), type } : undefined;
  }
  return undefined;
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
