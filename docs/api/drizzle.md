---
layout: default
title: drizzle()
parent: API Reference
nav_order: 1
---

# drizzle()

The `drizzle()` function is the main entry point for creating a Drizzle database instance connected to DuckDB.

## Signature

```typescript
function drizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  client: DuckDBClientLike,
  config?: DuckDBDrizzleConfig<TSchema>
): DuckDBDatabase<TSchema>;
```

## Parameters

### client

A DuckDB connection object from `@duckdb/node-api`. This is typically obtained by calling `instance.connect()` on a `DuckDBInstance`.

```typescript
import { DuckDBInstance } from '@duckdb/node-api';

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
```

### config (optional)

Configuration options for the Drizzle instance.

```typescript
interface DuckDBDrizzleConfig<TSchema> {
  // Enable query logging
  logger?: Logger | boolean;

  // Schema for relational queries
  schema?: TSchema;

  // Enable a per-connection prepared statement cache (default: disabled)
  prepareCache?: boolean | number | { size?: number };

  // Throw on Postgres-style array literals like '{1,2,3}' (default: false)
  rejectStringArrayLiterals?: boolean;

  // Handle the first coerced Postgres-style array literal warning
  arrayLiteralWarning?: (query: string) => void;
}
```

Note: Postgres array operators (`@>`, `<@`, `&&`) are automatically rewritten to DuckDB functions via AST transformation.

## Return Value

Returns a `DuckDBDatabase` instance that provides the full Drizzle query builder API.

## Basic Usage

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';

// Create connection
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();

// Create Drizzle instance
const db = drizzle(connection);

// Use the database
const users = await db.select().from(usersTable);
```

## With Configuration

### Enable Logging

```typescript
import { DefaultLogger } from 'drizzle-orm';

// Use default logger
const db = drizzle(connection, {
  logger: true,
});

// Or provide a custom logger
const db = drizzle(connection, {
  logger: new DefaultLogger(),
});
```

### With Schema for Relational Queries

```typescript
import * as schema from './schema';

const db = drizzle(connection, {
  schema,
});

// Now you can use relational queries
const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: true,
  },
});
```

### Strict Array Literal Handling

```typescript
// Throw an error on Postgres-style array literals like '{1,2,3}'
const db = drizzle(connection, {
  rejectStringArrayLiterals: true,
});
```

Note: Postgres array operators (`@>`, `<@`, `&&`) are automatically transformed to DuckDB's `array_has_*` functions via AST parsing.

## Connection Types

The `drizzle()` function accepts any object that implements the `DuckDBClientLike` interface:

```typescript
interface DuckDBClientLike {
  run(sql: string): Promise<DuckDBResult>;
  runSync(sql: string): DuckDBResult;
}
```

This is automatically satisfied by connections from `@duckdb/node-api`.

## See Also

- [DuckDBDatabase]({{ '/api/database' | relative_url }}) - The database class returned by `drizzle()`
- [Configuration]({{ '/reference/configuration' | relative_url }}) - Full configuration reference
- [Database Connection]({{ '/core/connection' | relative_url }}) - Connection patterns guide
