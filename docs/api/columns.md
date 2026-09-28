---
layout: default
title: Column Types
parent: API Reference
nav_order: 3
---

# Column Types

Drizzle DuckDB supports all standard Postgres column types from `drizzle-orm/pg-core` plus custom helpers for DuckDB-specific types.

## Standard Column Types

Use these from `drizzle-orm/pg-core`. They work with DuckDB:

```typescript
import {
  integer,
  bigint,
  smallint,
  real,
  doublePrecision,
  numeric,
  text,
  varchar,
  char,
  boolean,
  timestamp,
  date,
  time,
  uuid,
} from 'drizzle-orm/pg-core';
```

### Numeric Types

```typescript
const table = pgTable('example', {
  // Integers
  small: smallint('small'), // SMALLINT (-32768 to 32767)
  regular: integer('regular'), // INTEGER (-2B to 2B)
  big: bigint('big', { mode: 'number' }), // BIGINT

  // Floating point
  float: real('float'), // REAL (4 bytes)
  double: doublePrecision('double'), // DOUBLE (8 bytes)

  // Exact numeric
  price: numeric('price', { precision: 10, scale: 2 }),
});
```

### String Types

```typescript
const table = pgTable('example', {
  // Variable length
  name: text('name'), // TEXT (unlimited)
  email: varchar('email', { length: 255 }), // VARCHAR(255)

  // Fixed length
  code: char('code', { length: 2 }), // CHAR(2)
});
```

### Boolean

```typescript
const table = pgTable('example', {
  active: boolean('active').default(true),
});
```

### UUID

```typescript
const table = pgTable('example', {
  id: uuid('id').primaryKey().defaultRandom(),
});
```

## DuckDB-Specific Types

Import these from `@duckdbfan/drizzle-duckdb`. When the generated schema will be used in a browser bundle (drizzle-zod, tRPC inputs, React props), import from the client-safe helpers subpath instead to avoid bundling the native DuckDB node bindings:

```typescript
import {
  duckDbList,
  duckDbArray,
  duckDbStruct,
  duckDbMap,
  duckDbJson,
  duckDbTimestamp,
  duckDbDate,
  duckDbTime,
  duckDbBlob,
  duckDbInet,
  duckDbInterval,
} from '@duckdbfan/drizzle-duckdb/helpers';
```

### Lists and Arrays

DuckDB distinguishes between **lists** (variable length) and **arrays** (fixed length):

```typescript
const table = pgTable('example', {
  // LIST - variable length, any number of elements
  tags: duckDbList<string>('tags', 'TEXT'),
  scores: duckDbList<number>('scores', 'INTEGER'),

  // ARRAY - fixed length
  rgb: duckDbArray<number>('rgb', 'INTEGER', 3),
  coordinates: duckDbArray<number>('coordinates', 'DOUBLE', 2),
});
```

**Element types:**

The element type is a DuckDB type string. These names autocomplete in your editor:

- Integers: `'SMALLINT'`, `'INTEGER'`, `'BIGINT'`, `'HUGEINT'`
- Unsigned: `'USMALLINT'`, `'UINTEGER'`, `'UBIGINT'`
- Floats: `'FLOAT'`, `'DOUBLE'`
- Strings: `'TEXT'`, `'VARCHAR'`, `'STRING'`
- Boolean: `'BOOLEAN'`, `'BOOL'`
- Binary: `'BLOB'`, `'BYTEA'`
- Date/time: `'DATE'`, `'TIME'`, `'TIMESTAMP'`, `'TIMESTAMPTZ'`

Any other DuckDB type string is accepted too, for example `'UUID'` or `'DECIMAL(10, 2)'`. Empty lists and arrays can be inserted.

Values that DuckDB cannot infer an element type for are sent as SQL literals typed from the element type. This covers empty lists, lists of structs such as `duckDbList('items', 'STRUCT (a INTEGER)')`, lists of `Buffer` values and lists whose inner lists are all empty such as `[[]]`. Other lists bind as native parameters.

**Usage:**

```typescript
// Insert
await db.insert(table).values({
  tags: ['typescript', 'drizzle', 'duckdb'],
  rgb: [255, 128, 0],
});

// Query - returns native arrays
const rows = await db.select().from(table);
console.log(rows[0].tags); // ['typescript', 'drizzle', 'duckdb']
```

### Struct

For structured/nested data with named fields:

```typescript
const users = pgTable('users', {
  id: integer('id').primaryKey(),

  address: duckDbStruct<{
    street: string;
    city: string;
    zip: string;
  }>('address', {
    street: 'TEXT',
    city: 'TEXT',
    zip: 'VARCHAR',
  }),

  // Nested lists in struct
  profile: duckDbStruct<{
    bio: string;
    tags: string[];
  }>('profile', {
    bio: 'TEXT',
    tags: 'TEXT[]',
  }),
});
```

Field types in the schema object accept any DuckDB type string.

Struct values are sent as `struct_pack(...)` SQL literals. Only plain objects become nested structs. A `Date` field becomes a timestamp literal: `TIMESTAMP` fields get its UTC wall time, `DATE` fields its UTC date, and other fields a `TIMESTAMPTZ` literal. A `Buffer` or `Uint8Array` field becomes a `from_hex('...')` BLOB literal. The same rules apply inside list and map literals and to the array query helpers below.

**Usage:**

```typescript
await db.insert(users).values({
  id: 1,
  address: {
    street: '123 Main St',
    city: 'Portland',
    zip: '97201',
  },
});

const user = await db.select().from(users).where(eq(users.id, 1));
console.log(user[0].address.city); // 'Portland'
```

### Map

For key-value pairs. Keys are `STRING` unless you pass `keyType`:

```typescript
duckDbMap<TData>(name, valueType, options?: { keyType?: string })
```

```typescript
const config = pgTable('config', {
  id: integer('id').primaryKey(),

  // Map with text values
  settings: duckDbMap<Record<string, string>>('settings', 'TEXT'),

  // Map with integer values
  counts: duckDbMap<Record<string, number>>('counts', 'INTEGER'),

  // Map with list values
  tags: duckDbMap<Record<string, string[]>>('tags', 'TEXT[]'),

  // Map with VARCHAR keys: MAP (VARCHAR, INTEGER)
  totals: duckDbMap<Record<string, number>>('totals', 'INTEGER', {
    keyType: 'VARCHAR',
  }),
});
```

`valueType` and `keyType` accept any DuckDB type string. Common names autocomplete.

Empty maps, and maps whose values include structs, `Buffer` values or empty lists, are sent as `map(...)` SQL literals typed from `valueType`. Other maps bind as native parameters.

**Usage:**

```typescript
await db.insert(config).values({
  id: 1,
  settings: {
    theme: 'dark',
    language: 'en',
  },
});
```

Reads return an array of `{ key, value }` entries at runtime, not the `Record` shown in the TypeScript type. See [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}#map-key-value-pairs) for a conversion example.

### JSON

Use `duckDbJson` instead of Postgres `json`/`jsonb`:

```typescript
const events = pgTable('events', {
  id: integer('id').primaryKey(),
  payload: duckDbJson<{ type: string; data: unknown }>('payload'),
});
```

{: .warning }

> **Important**
>
> Postgres `json` and `jsonb` columns from `drizzle-orm/pg-core` are **not supported**. The driver will throw an error if you use them. Always use `duckDbJson()` instead.

**Usage:**

```typescript
await db.insert(events).values({
  id: 1,
  payload: { type: 'click', data: { x: 100, y: 200 } },
});

const event = await db.select().from(events).where(eq(events.id, 1));
console.log(event[0].payload.type); // 'click'
```

A JavaScript string is sent as raw JSON text, not encoded as a JSON string. `'{"a": 1}'` stores an object, `'123'` stores the number `123`, and `'hello'` fails because it is not valid JSON. To store a JSON string value, pass it already encoded, for example `JSON.stringify('hello')`.

### Timestamps, Dates, and Times

For proper DuckDB timestamp handling with timezone support:

```typescript
const events = pgTable('events', {
  // Timestamp without timezone (default)
  createdAt: duckDbTimestamp('created_at'),

  // Timestamp with timezone
  occurredAt: duckDbTimestamp('occurred_at', { withTimezone: true }),

  // Return as string instead of Date object
  loggedAt: duckDbTimestamp('logged_at', { mode: 'string' }),

  // With precision
  preciseAt: duckDbTimestamp('precise_at', { precision: 6 }),

  // Date only
  birthDate: duckDbDate('birth_date'),

  // Time only
  startTime: duckDbTime('start_time'),
});
```

**Options for `duckDbTimestamp`:**

| Option         | Values                                                                              | Default             | Description                      |
| -------------- | ----------------------------------------------------------------------------------- | ------------------- | -------------------------------- |
| `withTimezone` | `boolean`                                                                           | `false`             | Use `TIMESTAMPTZ`                |
| `mode`         | `'date'`, `'string'`                                                                | `'date'`            | Return `Date` objects or strings |
| `precision`    | `number`                                                                            | none                | Emit `TIMESTAMP(p)`              |
| `duckDbType`   | `'TIMESTAMP'`, `'TIMESTAMPTZ'`, `'TIMESTAMP_S'`, `'TIMESTAMP_MS'`, `'TIMESTAMP_NS'` | from `withTimezone` | Pick a DuckDB storage variant    |
| `bindMode`     | `'auto'`, `'bind'`, `'literal'`                                                     | `'auto'`            | How values are sent. See below   |

`bindMode` controls how inserted values reach DuckDB:

- `'auto'`: bind a native timestamp parameter on Node.js. Use a SQL literal on Bun or when `DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS` is set to a value other than `0`.
- `'bind'`: always bind a native timestamp parameter.
- `'literal'`: always inline a SQL literal such as `TIMESTAMP '2024-01-15 10:30:00.000+00'`.

`TIMESTAMP_S`, `TIMESTAMP_MS` and `TIMESTAMP_NS` columns always use literals.

Both paths read input strings the same way, whatever the session `TimeZone`:

- A string without an offset is UTC. `'2024-01-15 10:30:00'` in a `TIMESTAMPTZ` column is `2024-01-15T10:30:00Z`.
- A `TIMESTAMPTZ` string with an offset keeps it.
- A naive `TIMESTAMP` string with an offset is converted to UTC. `'2024-01-15 10:30:00+05:00'` stores `2024-01-15 05:30:00`.
- A `Date` is stored as its UTC instant. Naive columns store its UTC wall time.

`duckDbTime` accepts `withTimezone` and `duckDbType` (`'TIME'`, `'TIMETZ'`, `'TIME_NS'`). TIME values read back as strings and keep microseconds: `'10:30:00.123456'` when sub-millisecond digits are present, otherwise three fractional digits such as `'10:30:00.000'`.

**Modes:**

- `mode: 'date'` (default): returns JavaScript `Date` objects
- `mode: 'string'`: returns strings in DuckDB's text format. Naive `TIMESTAMP` values have no offset, such as `'2024-01-15 10:30:00'`. `TIMESTAMPTZ` values are rendered in UTC with `+00`, such as `'2024-01-15 10:30:00+00'`. Trailing zeros in the fraction are dropped, so `'2024-01-15 10:30:00.5'` means half a second.

DuckDB usually returns timestamps to JavaScript as `Date` values, which keep milliseconds only. So string mode returns `'2024-01-15 10:30:00.123'` for a stored `10:30:00.123456`, whatever else the query selects. Cast to `VARCHAR` in SQL when you need full precision.

**Usage:**

```typescript
await db.insert(events).values({
  createdAt: new Date(),
  occurredAt: new Date('2024-01-15T10:30:00Z'),
  birthDate: '2024-01-15',
  startTime: '10:30:00',
});
```

### Blob

For binary data:

```typescript
const files = pgTable('files', {
  id: integer('id').primaryKey(),
  content: duckDbBlob('content'),
});
```

**Usage:**

```typescript
await db.insert(files).values({
  id: 1,
  content: Buffer.from('hello world'),
});
```

Reads return a `Buffer`. When the driver reads a result as text, DuckDB renders BLOB values as strings such as `'\x01\x02'`, and the column decodes those back into a `Buffer`.

### Inet

For IP addresses:

```typescript
const connections = pgTable('connections', {
  id: integer('id').primaryKey(),
  ipAddress: duckDbInet('ip_address'),
});
```

**Usage:**

```typescript
await db.insert(connections).values({
  id: 1,
  ipAddress: '192.168.1.1',
});
```

### Interval

For time intervals:

```typescript
const tasks = pgTable('tasks', {
  id: integer('id').primaryKey(),
  duration: duckDbInterval('duration'),
});
```

**Usage:**

```typescript
await db.insert(tasks).values({
  id: 1,
  duration: '2 hours 30 minutes',
});

const [task] = await db.select().from(tasks);
console.log(task.duration); // '02:30:00'
```

Reads return the string DuckDB prints for `interval::VARCHAR`, such as `'1 year 2 months 3 days 04:05:06.5'`. You can insert that string back unchanged. Earlier versions returned a `{ months, days, micros }` object at runtime even though the TypeScript type was `string`.

## Array Query Helpers

For querying array columns, use these helpers. Drizzle's Postgres operators (`arrayContains` and the others from `drizzle-orm`) also work, because DuckDB supports `@>`, `<@` and `&&` natively:

```typescript
import {
  duckDbArrayContains,
  duckDbArrayContained,
  duckDbArrayOverlaps,
} from '@duckdbfan/drizzle-duckdb';
```

### duckDbArrayContains

Check if an array contains **all** specified values (equivalent to Postgres `@>`):

```typescript
const products = pgTable('products', {
  id: integer('id').primaryKey(),
  tags: duckDbList<string>('tags', 'TEXT'),
});

// Find products with both 'electronics' AND 'sale' tags
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayContains(products.tags, ['electronics', 'sale']));
```

Maps to DuckDB's `array_has_all(column, values)`.

### duckDbArrayContained

Check if an array is **contained by** the specified values (equivalent to Postgres `<@`):

```typescript
// Find products whose tags are all within the allowed set
const results = await db
  .select()
  .from(products)
  .where(
    duckDbArrayContained(products.tags, [
      'electronics',
      'sale',
      'featured',
      'new',
    ])
  );
```

Maps to DuckDB's `array_has_all(values, column)`.

### duckDbArrayOverlaps

Check if arrays have **any** common elements (equivalent to Postgres `&&`):

```typescript
// Find products with at least one matching tag
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayOverlaps(products.tags, ['electronics', 'books']));
```

Maps to DuckDB's `array_has_any(column, values)`.

## Postgres Array Operators

DuckDB supports the Postgres array operators on `LIST` and fixed-size `ARRAY` columns, so the driver sends them unchanged:

| Postgres | Same result as               |
| -------- | ---------------------------- |
| `@>`     | `array_has_all(left, right)` |
| `<@`     | `array_has_all(right, left)` |
| `&&`     | `array_has_any(left, right)` |

The explicit helpers (`duckDbArrayContains`, etc.) produce the `array_has_*` calls directly.
