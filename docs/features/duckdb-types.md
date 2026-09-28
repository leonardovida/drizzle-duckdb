---
layout: default
title: DuckDB Types
parent: Features
nav_order: 3
---

# DuckDB Types

DuckDB provides several types not found in standard Postgres. This guide covers how to use them with Drizzle.

DuckDB 1.5 adds native `VARIANT` and moves `GEOMETRY` into core DuckDB. With `@duckdb/node-api@1.5.4-r.1`, `VARIANT` values materialize into JavaScript values. For portable geometry output, project with `ST_AsText(...)` or `ST_AsWKB(...)`.

## Import

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
} from '@duckdbfan/drizzle-duckdb';
```

## LIST (Variable Length Array)

Lists are variable-length sequences of values of the same type.

```typescript
const users = pgTable('users', {
  tags: duckDbList<string>('tags', 'TEXT'),
  scores: duckDbList<number>('scores', 'INTEGER'),
  timestamps: duckDbList<Date>('timestamps', 'TIMESTAMP'),
});
```

**Element types** (these autocomplete, and other DuckDB type strings work too):

- Integers: `'SMALLINT'`, `'INTEGER'`, `'BIGINT'`, `'HUGEINT'`
- Unsigned: `'USMALLINT'`, `'UINTEGER'`, `'UBIGINT'`
- Floats: `'FLOAT'`, `'DOUBLE'`
- Strings: `'TEXT'`, `'VARCHAR'`, `'STRING'`
- Boolean: `'BOOLEAN'`, `'BOOL'`
- Binary: `'BLOB'`, `'BYTEA'`
- Date/time: `'DATE'`, `'TIME'`, `'TIMESTAMP'`, `'TIMESTAMPTZ'`

For example, `'UUID'` or `'DECIMAL(10, 2)'` also work. Empty lists, lists of structs such as `duckDbList('items', 'STRUCT(a INTEGER)')`, lists of `Buffer` values and `[[]]` can be inserted. Lists that start with `null` and lists of mixed numbers such as `[1, 2.5]` bind with the right item type.

**Usage:**

```typescript
// Insert
await db.insert(users).values({
  tags: ['typescript', 'drizzle', 'duckdb'],
  scores: [85, 92, 78],
});

// Query - returns native arrays
const user = await db.select().from(users);
console.log(user[0].tags); // ['typescript', 'drizzle', 'duckdb']
```

## ARRAY (Fixed Length)

Arrays have a fixed size specified at definition time.

```typescript
const users = pgTable('users', {
  // Exactly 3 elements
  rgb: duckDbArray<number>('rgb', 'INTEGER', 3),
  // Exactly 2 elements
  coordinates: duckDbArray<number>('coordinates', 'DOUBLE', 2),
});
```

**Usage:**

```typescript
await db.insert(users).values({
  rgb: [255, 128, 0],
  coordinates: [40.7128, -74.006],
});
```

## STRUCT (Named Fields)

Structs are fixed schemas with named fields of potentially different types.

```typescript
const users = pgTable('users', {
  address: duckDbStruct<{
    street: string;
    city: string;
    zip: string;
    country: string;
  }>('address', {
    street: 'TEXT',
    city: 'TEXT',
    zip: 'VARCHAR',
    country: 'TEXT',
  }),
});
```

**Nested lists in structs:**

```typescript
const users = pgTable('users', {
  profile: duckDbStruct<{
    bio: string;
    interests: string[];
    scores: number[];
  }>('profile', {
    bio: 'TEXT',
    interests: 'TEXT[]',
    scores: 'INTEGER[]',
  }),
});
```

**Usage:**

```typescript
// Insert
await db.insert(users).values({
  address: {
    street: '123 Main St',
    city: 'Portland',
    zip: '97201',
    country: 'USA',
  },
});

// Query
const user = await db.select().from(users);
console.log(user[0].address.city); // 'Portland'
```

A `Date` field is sent as a timestamp or date literal typed from the field type, and a `Buffer` field as a BLOB literal. See [Struct]({{ '/api/columns' | relative_url }}#struct) for the exact rules.

**Accessing struct fields in raw SQL:**

```typescript
const results = await db.execute(sql`
  SELECT
    address['city'] as city,
    address['zip'] as zip
  FROM users
`);
```

## MAP (Key-Value Pairs)

Maps store key-value pairs. Keys are `STRING` by default. Pass `{ keyType }` as the third argument to use another key type, for example `duckDbMap<Record<string, string>>('labels', 'VARCHAR', { keyType: 'INTEGER' })` for `MAP(INTEGER, VARCHAR)`.

```typescript
const products = pgTable('products', {
  // Map with integer values
  inventory: duckDbMap<Record<string, number>>('inventory', 'INTEGER'),

  // Map with string values
  metadata: duckDbMap<Record<string, string>>('metadata', 'TEXT'),

  // Map with list values
  tags: duckDbMap<Record<string, string[]>>('tags', 'TEXT[]'),
});
```

**Usage:**

```typescript
await db.insert(products).values({
  inventory: {
    warehouse_a: 150,
    warehouse_b: 75,
    warehouse_c: 200,
  },
  metadata: {
    sku: 'ABC123',
    category: 'electronics',
  },
});

const [product] = await db.select().from(products);
console.log(product.inventory);
// [
//   { key: 'warehouse_a', value: 150 },
//   { key: 'warehouse_b', value: 75 },
//   { key: 'warehouse_c', value: 200 },
// ]
```

{: .warning }

> The TypeScript type of a `duckDbMap` column is the `Record` you pass as the type parameter, but reads return an array of `{ key, value }` entries at runtime. Convert the entries when you need an object:
>
> ```typescript
> const inventory = Object.fromEntries(
>   (product.inventory as unknown as { key: string; value: number }[]).map(
>     ({ key, value }) => [key, value]
>   )
> );
> console.log(inventory.warehouse_a); // 150
> ```

## JSON

Use `duckDbJson` for arbitrary JSON data. Do NOT use Postgres `json`/`jsonb`.

```typescript
const events = pgTable('events', {
  payload: duckDbJson<{
    type: string;
    data: unknown;
    metadata?: Record<string, string>;
  }>('payload'),
});
```

{: .warning }

> **Important**
>
> Postgres `json` and `jsonb` columns from `drizzle-orm/pg-core` are **not supported**. The driver will throw an error if you use them. Always use `duckDbJson()` instead.

**Usage:**

```typescript
await db.insert(events).values({
  payload: {
    type: 'user_signup',
    data: { userId: 123, plan: 'premium' },
    metadata: { source: 'web' },
  },
});

// Query JSON fields with raw SQL
const results = await db.execute(sql`
  SELECT
    payload->>'type' as event_type,
    payload->'data'->>'userId' as user_id
  FROM events
`);
```

A JavaScript string value is sent as raw JSON text. `'{"a": 1}'` stores an object and `'hello'` fails as invalid JSON. Pass `JSON.stringify('hello')` to store a JSON string.

## Timestamps

DuckDB handles timestamps slightly differently than Postgres. Use `duckDbTimestamp` for best results.

```typescript
const events = pgTable('events', {
  // Timestamp without timezone (default)
  createdAt: duckDbTimestamp('created_at'),

  // Timestamp with timezone
  occurredAt: duckDbTimestamp('occurred_at', { withTimezone: true }),

  // Return as string instead of Date object
  loggedAt: duckDbTimestamp('logged_at', { mode: 'string' }),

  // With precision (microseconds)
  preciseAt: duckDbTimestamp('precise_at', { precision: 6 }),
});
```

**Modes:**

- `mode: 'date'` (default): returns JavaScript `Date` objects
- `mode: 'string'`: returns strings in DuckDB's text format, such as `'2024-01-15 10:30:00'`. `TIMESTAMPTZ` values are rendered in UTC with `+00`. See [Columns]({{ '/api/columns' | relative_url }}#timestamps-dates-and-times) for precision details

**Usage:**

```typescript
await db.insert(events).values({
  createdAt: new Date(),
  occurredAt: new Date('2024-01-15T10:30:00Z'),
});
```

## Date and Time

```typescript
const events = pgTable('events', {
  // Date only
  eventDate: duckDbDate('event_date'),

  // Time only
  startTime: duckDbTime('start_time'),
});
```

**Usage:**

```typescript
await db.insert(events).values({
  eventDate: '2024-01-15',
  startTime: '10:30:00',
});
```

TIME values read back as strings with three fractional digits, such as `'10:30:00.000'`, or six when the value has microseconds, such as `'10:30:00.123456'`.

## Blob (Binary Data)

```typescript
const files = pgTable('files', {
  content: duckDbBlob('content'),
  thumbnail: duckDbBlob('thumbnail'),
});
```

**Usage:**

```typescript
await db.insert(files).values({
  content: Buffer.from('Hello, World!'),
  thumbnail: Buffer.from(imageBytes),
});
```

Reads return a `Buffer`.

## INET (IP Addresses)

```typescript
const connections = pgTable('connections', {
  ipAddress: duckDbInet('ip_address'),
  clientIp: duckDbInet('client_ip'),
});
```

**Usage:**

```typescript
await db.insert(connections).values({
  ipAddress: '192.168.1.1',
  clientIp: '10.0.0.1',
});
```

## INTERVAL (Time Intervals)

```typescript
const tasks = pgTable('tasks', {
  duration: duckDbInterval('duration'),
  timeout: duckDbInterval('timeout'),
});
```

**Usage:**

```typescript
await db.insert(tasks).values({
  duration: '2 hours 30 minutes',
  timeout: '5 seconds',
});
```

Reads return DuckDB's interval text, such as `'02:30:00'` and `'00:00:05'`.

## Type Inference

All DuckDB types support TypeScript generic parameters:

```typescript
// Explicit types for better inference
const users = pgTable('users', {
  tags: duckDbList<string>('tags', 'TEXT'),

  metadata: duckDbStruct<{
    role: 'admin' | 'user' | 'guest';
    permissions: string[];
  }>('metadata', {
    role: 'TEXT',
    permissions: 'TEXT[]',
  }),

  settings: duckDbJson<{
    theme: 'light' | 'dark';
    notifications: boolean;
  }>('settings'),
});

// TypeScript knows the shape
const user = await db.select().from(users);
user[0].tags; // string[]
user[0].metadata.role; // 'admin' | 'user' | 'guest'
user[0].settings.theme; // 'light' | 'dark'
```

## See Also

- [Column Types API]({{ '/api/columns' | relative_url }}): complete reference
- [Array Helpers]({{ '/api/array-helpers' | relative_url }}): array query functions
- [Schema Definition]({{ '/core/schema' | relative_url }}): using types in schemas
