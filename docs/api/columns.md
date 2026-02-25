---
layout: default
title: Column Types
parent: API Reference
nav_order: 3
---

# Column Types

Drizzle DuckDB supports all standard Postgres column types from `drizzle-orm/pg-core` plus custom helpers for DuckDB-specific types.

## Standard Column Types

Use these from `drizzle-orm/pg-core` - they work with DuckDB:

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

**Supported element types:**

- Integers: `'SMALLINT'`, `'INTEGER'`, `'BIGINT'`, `'HUGEINT'`
- Unsigned: `'USMALLINT'`, `'UINTEGER'`, `'UBIGINT'`
- Floats: `'FLOAT'`, `'DOUBLE'`
- Strings: `'TEXT'`, `'VARCHAR'`, `'STRING'`
- Boolean: `'BOOLEAN'`, `'BOOL'`
- Binary: `'BLOB'`, `'BYTEA'`
- Date/time: `'DATE'`, `'TIME'`, `'TIMESTAMP'`, `'TIMESTAMPTZ'`

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

For key-value pairs with string keys:

```typescript
const config = pgTable('config', {
  id: integer('id').primaryKey(),

  // Map with text values
  settings: duckDbMap<Record<string, string>>('settings', 'TEXT'),

  // Map with integer values
  counts: duckDbMap<Record<string, number>>('counts', 'INTEGER'),

  // Map with list values
  tags: duckDbMap<Record<string, string[]>>('tags', 'TEXT[]'),
});
```

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

**Modes:**

- `mode: 'date'` (default) - Returns JavaScript `Date` objects
- `mode: 'string'` - Returns ISO-formatted strings like `'2024-01-15 10:30:00+00'`

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
```

## Array Query Helpers

For querying array columns, use these helpers instead of Postgres operators:

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

## Automatic Array Operator Rewriting

The driver automatically rewrites Postgres array operators to DuckDB equivalents via AST transformation:

| Postgres | DuckDB                       |
| -------- | ---------------------------- |
| `@>`     | `array_has_all(left, right)` |
| `<@`     | `array_has_all(right, left)` |
| `&&`     | `array_has_any(left, right)` |

Postgres array operators are automatically converted when using `ARRAY[...]` syntax. Using the explicit helpers (`duckDbArrayContains`, etc.) is recommended for clarity and to avoid parser limitations with DuckDB-native `[...]` syntax.
