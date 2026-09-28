---
layout: default
title: Coming from Postgres
parent: Getting Started
nav_order: 3
---

# Coming from Postgres

If you already use Drizzle with Postgres, this page covers what changes when you switch to DuckDB.

## Key Differences

| Feature                  | Drizzle Postgres      | Drizzle DuckDB                                                                                       |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------- |
| JSON columns             | `json()`, `jsonb()`   | `duckDbJson()` only                                                                                  |
| Nested transactions      | `SAVEPOINT` supported | DuckDB 1.4.x and 1.5.x have no savepoints. The driver probes once, then reuses the outer transaction |
| Array operators          | `@>`, `<@`, `&&`      | Supported natively, or use helpers                                                                   |
| Default schema           | `public`              | `main`                                                                                               |
| Serial columns           | `SERIAL` type         | Sequence + `nextval()`                                                                               |
| Result streaming         | Supported             | Chunked reads via `executeBatches()`, no cursor API                                                  |
| Prepared statement cache | Yes                   | Opt-in per-connection cache via `prepareCache`                                                       |
| `numeric()` columns      | Exact strings         | Exact strings. Raw SQL results return DECIMAL as numbers                                             |
| Raw `COUNT(*)`           | String                | `bigint`. Use `countN()` or Drizzle's `count()` for a number                                         |

## Required Changes

### 1. Replace JSON/JSONB Columns

```typescript
// Before (Postgres)
import { json, jsonb } from 'drizzle-orm/pg-core';

const users = pgTable('users', {
  settings: jsonb('settings'),
});

// After (DuckDB)
import { duckDbJson } from '@duckdbfan/drizzle-duckdb';

const users = pgTable('users', {
  settings: duckDbJson<{ theme: string }>('settings'),
});
```

### 2. Use DuckDB Timestamps (Optional)

For better DuckDB compatibility with timezones:

```typescript
// Before (Postgres)
import { timestamp } from 'drizzle-orm/pg-core';

const events = pgTable('events', {
  createdAt: timestamp('created_at', { withTimezone: true }),
});

// After (DuckDB) - recommended
import { duckDbTimestamp } from '@duckdbfan/drizzle-duckdb';

const events = pgTable('events', {
  createdAt: duckDbTimestamp('created_at', { withTimezone: true }),
});
```

### 3. Replace SERIAL with Sequences

DuckDB doesn't have `SERIAL`. Use sequences instead:

```sql
-- Before (Postgres)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- After (DuckDB)
CREATE SEQUENCE users_id_seq;
CREATE TABLE users (
  id INTEGER PRIMARY KEY DEFAULT nextval('users_id_seq'),
  name TEXT NOT NULL
);
```

### 4. Handle Array Operators

Option A: Use explicit DuckDB helpers:

```typescript
// Before (Postgres)
import { arrayContains } from 'drizzle-orm';

.where(arrayContains(products.tags, ['sale']))

// After (DuckDB) - explicit
import { duckDbArrayContains } from '@duckdbfan/drizzle-duckdb';

.where(duckDbArrayContains(products.tags, ['sale']))
```

Option B: Keep the Postgres operators. DuckDB supports `@>`, `<@` and `&&` on lists, so the SQL runs unchanged:

```typescript
import { arrayContains } from 'drizzle-orm';

.where(arrayContains(products.tags, ['sale']))
// Runs as: WHERE "products"."tags" @> $1
```

## Schema Migration

### Minimal Changes Needed

Most schema code works unchanged:

```typescript
// This works in both Postgres and DuckDB
import { pgTable, integer, text, boolean } from 'drizzle-orm/pg-core';

const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  active: boolean('active').default(true),
});
```

### Changes for JSON Columns

```typescript
// Replace json/jsonb imports
import { duckDbJson } from '@duckdbfan/drizzle-duckdb';

const users = pgTable('users', {
  // Change this
  metadata: duckDbJson<MyMetadataType>('metadata'),
});
```

## Transaction Behavior

### No Savepoints (driver auto-detects)

DuckDB 1.4.x and 1.5.x currently reject `SAVEPOINT`. The driver will try once, mark it unsupported if the backend errors, and then reuse the outer transaction for all nested calls:

```typescript
// This behaves DIFFERENTLY than Postgres!
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });

  await tx.transaction(async (innerTx) => {
    await innerTx.insert(users).values({ name: 'Bob' });
    innerTx.rollback(); // Rolls back EVERYTHING
  });
});
// Neither Alice nor Bob are inserted
```

**Solution**: Avoid nested transactions. DuckDB aborts the whole transaction when any statement fails. Catching the error does not keep earlier writes. Validate before writing, or run the risky write in its own `db.transaction()`:

```typescript
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });
});

try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: 'Bob' });
  });
} catch (e) {
  // Alice is already committed
  console.error('Failed to insert Bob:', e);
}
```

If you catch a failed statement inside the callback, `db.transaction()` still rolls back and rejects with `DuckDB aborted the transaction because a statement inside it failed. ...`.

### Transaction Config Is Ignored

`db.transaction(fn, { isolationLevel: 'serializable' })` and the other config options are deprecated. DuckDB has no `SET TRANSACTION`, so the driver ignores the config and prints a one-time warning. The next major version will throw.

## Connection Setup

```typescript
// Before (Postgres)
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// After (DuckDB)
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create('./my-database.duckdb');
const connection = await instance.connect();
const db = drizzle(connection);
```

If your Postgres server runs the `pg_duckdb` extension, you can keep the `pg.Pool` and switch only the import. `drizzle(pool)` from this package wraps the pool so each transaction runs on one client. See [pg_duckdb]({{ '/core/connection' | relative_url }}#pg_duckdb).

## Drizzle Kit Configuration

```typescript
// Before (Postgres)
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
};

// After (DuckDB) - use postgresql dialect
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql', // Still use postgresql
  // No dbCredentials needed for generation
};
```

{: .warning }

> Review generated SQL for DuckDB compatibility. Some Postgres-specific syntax may need manual adjustment.

## What Works Unchanged

These features work the same in both:

- All query builder methods (`select`, `insert`, `update`, `delete`)
- Operators (`eq`, `and`, `or`, `gt`, `lt`, `like`, etc.)
- Aggregations (`count`, `sum`, `avg`, `min`, `max`)
- Joins (all types)
- Subqueries
- CTEs (`$with()`, `.with()`)
- Transactions (single-level, without `isolationLevel` or other transaction config, which DuckDB ignores)
- Schema definitions (with noted exceptions)

## Performance Considerations

DuckDB is optimized for **analytical workloads**:

| Operation                         | DuckDB | Postgres |
| --------------------------------- | ------ | -------- |
| Large aggregations                | Faster | Slower   |
| Full table scans                  | Faster | Slower   |
| Complex joins on large data       | Faster | Slower   |
| High-frequency single-row inserts | Slower | Faster   |
| OLTP workloads                    | Slower | Faster   |

### Optimize for DuckDB

```typescript
// Good: Batch inserts
await db.insert(users).values(manyUsers);

// Bad: Many individual inserts
for (const user of manyUsers) {
  await db.insert(users).values(user);
}
```

## Migration Checklist

- [ ] Replace `json()`/`jsonb()` with `duckDbJson()`
- [ ] Consider `duckDbTimestamp()` for timestamp columns
- [ ] Update DDL: Replace `SERIAL` with sequences
- [ ] Review nested transaction usage
- [ ] Remove `db.transaction()` config such as `isolationLevel` (deprecated and ignored)
- [ ] Stop catching statement errors inside a transaction to continue it
- [ ] Test array operations
- [ ] Update connection code
- [ ] Review Drizzle Kit generated SQL

## See Also

- [Limitations]({{ '/reference/limitations' | relative_url }}): compatibility matrix
- [Troubleshooting]({{ '/reference/troubleshooting' | relative_url }}): common issues
- [FAQ]({{ '/reference/faq' | relative_url }}): frequently asked questions
