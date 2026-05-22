---
layout: default
title: DuckDB Types
parent: Features
nav_order: 3
---

# DuckDB Types

DuckDB provides several types not found in standard Postgres. This guide covers how to use them with Drizzle.

DuckDB 1.5 adds native `VARIANT` and moves `GEOMETRY` into core DuckDB. Those types are available in the database, but `@duckdb/node-api@1.5.2-r.2` still cannot materialize raw JS values for them reliably. Use explicit projections such as `CAST(... AS VARCHAR)`, `variant_extract(...)`, `ST_AsText(...)`, or `ST_AsWKB(...)` when querying them.

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

Maps store key-value pairs with string keys.

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

const product = await db.select().from(products);
console.log(product[0].inventory.warehouse_a); // 150
```

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

- `mode: 'date'` (default) - Returns JavaScript `Date` objects
- `mode: 'string'` - Returns ISO-formatted strings

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

- [Column Types API]({{ '/api/columns' | relative_url }}) - Complete reference
- [Array Helpers]({{ '/api/array-helpers' | relative_url }}) - Array query functions
- [Schema Definition]({{ '/core/schema' | relative_url }}) - Using types in schemas
