---
layout: default
title: Database Connection
parent: Core Concepts
nav_order: 1
---

# Database Connection

Learn how to connect to DuckDB databases in different scenarios.

## Quick Start (Recommended)

The simplest way to connect uses a connection string with automatic pooling:

```typescript
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

// In-memory with auto-pooling (4 connections)
const db = await drizzle(':memory:');

// Local file with auto-pooling
const db = await drizzle('./my-database.duckdb');

// MotherDuck cloud with auto-pooling
const db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});
```

This creates a connection pool automatically, which is critical for MotherDuck performance (see [Connection Pooling](#connection-pooling)).

## In-Memory Database

Perfect for testing and temporary data processing:

```typescript
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

const db = await drizzle(':memory:');
```

Data is lost when the connection closes.

## Local File

Persist your data to disk:

```typescript
const db = await drizzle('./my-database.duckdb');
```

The file is created if it doesn't exist.

## MotherDuck Cloud

Connect to [MotherDuck](https://motherduck.com/) for cloud-hosted DuckDB:

```typescript
const db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});

// Or connect to a specific database
const db = await drizzle({
  connection: {
    path: 'md:my_database',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});
```

See the [MotherDuck guide](/integrations/motherduck) for the auto pooling example and `db.close()` cleanup.

## With Logging

Enable query logging for debugging:

```typescript
import { DefaultLogger } from 'drizzle-orm';

const db = drizzle(connection, {
  logger: new DefaultLogger(),
});
```

Or simply:

```typescript
const db = drizzle(connection, { logger: true });
```

## With Schema

Pass your schema for relational queries:

```typescript
import * as schema from './schema';

const db = drizzle(connection, { schema });

// Now relational queries work
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

## Connection Patterns

### Singleton (Recommended for Long-Running Apps)

```typescript
// db.ts
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { drizzle, DuckDBDatabase } from '@leonardovida-md/drizzle-neo-duckdb';
import * as schema from './schema';

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;

export async function getDb(): Promise<DuckDBDatabase<typeof schema>> {
  if (!instance) {
    instance = await DuckDBInstance.create('./app.duckdb');
  }
  if (!connection) {
    connection = await instance.connect();
  }
  return drizzle(connection, { schema });
}
```

### Cleanup Pattern (Serverless/Short-Lived)

```typescript
export async function withDb<T>(
  callback: (db: DuckDBDatabase) => Promise<T>
): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    const db = drizzle(connection);
    return await callback(db);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

// Usage
const users = await withDb(async (db) => {
  return db.select().from(usersTable);
});
```

## Connection Pooling

DuckDB/MotherDuck runs **one query per connection**. Without pooling, concurrent requests serialize and cause slow response times. The async `drizzle()` entrypoints automatically create a pool (default size: 4) when given a connection string.

### Pool Size Configuration

```typescript
// Default: 4 connections
const db = await drizzle(':memory:');

// Custom pool size
const db = await drizzle('md:', { pool: { size: 8 } });

// Use a preset for MotherDuck instance types
const db = await drizzle('md:', { pool: 'jumbo' }); // 8 connections
const db = await drizzle('md:', { pool: 'giga' }); // 16 connections

// Disable pooling (single connection)
const db = await drizzle('md:', { pool: false });
```

> The `pool` option on `drizzle()` covers size/presets. For timeouts or recycling behavior, create the pool manually (see below).

### Pool Presets for MotherDuck

| Preset       | Size | Use Case                       |
| ------------ | ---- | ------------------------------ |
| `'pulse'`    | 4    | Auto-scaling, ad-hoc analytics |
| `'standard'` | 6    | Balanced ETL/ELT workloads     |
| `'jumbo'`    | 8    | Complex queries, high-volume   |
| `'mega'`     | 12   | Large-scale transformations    |
| `'giga'`     | 16   | Maximum parallelism            |
| `'local'`    | 8    | Local DuckDB file              |
| `'memory'`   | 4    | In-memory testing              |

### Manual Pool Creation (Advanced)

For more control, create the pool manually:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import {
  drizzle,
  createDuckDBConnectionPool,
} from '@leonardovida-md/drizzle-neo-duckdb';

const instance = await DuckDBInstance.create('./app.duckdb');
const pool = createDuckDBConnectionPool(instance, { size: 4 });
const db = drizzle(pool);
```

### Advanced Pool Options

`createDuckDBConnectionPool` supports tuning beyond size:

- `acquireTimeout` (ms, default 30_000): fail if a connection isn't available in time
- `maxWaitingRequests` (default 100): cap queued acquires; throws when full
- `maxLifetimeMs`: recycle connections after this age
- `idleTimeoutMs`: recycle idle connections after this idle period

```typescript
const pool = createDuckDBConnectionPool(instance, {
  size: 8,
  acquireTimeout: 20_000,
  maxWaitingRequests: 200,
  maxLifetimeMs: 10 * 60_000,
  idleTimeoutMs: 60_000,
});
```

Transactions automatically pin a single pooled connection for the entire callback; other queries continue to use the pool.

### Multiple Connections Without Pooling

DuckDB supports multiple independent connections:

```typescript
const instance = await DuckDBInstance.create('./app.duckdb');

const conn1 = await instance.connect();
const conn2 = await instance.connect();

const db1 = drizzle({ client: conn1 });
const db2 = drizzle({ client: conn2 });
```

## Configuration Options

```typescript
const db = await drizzle(':memory:', {
  // Enable query logging
  logger: true,

  // Or use custom logger
  logger: new DefaultLogger(),

  // Schema for relational queries
  schema: mySchema,

  // Pool configuration (size/preset; use createDuckDBConnectionPool for timeouts)
  pool: { size: 8 },

  // Throw on Postgres-style array literals (default: false)
  rejectStringArrayLiterals: false,
});
```

Note: Postgres array operators (`@>`, `<@`, `&&`) are automatically rewritten to DuckDB functions via AST transformation.

See [Configuration](/reference/configuration) for all options.

## Closing Connections

When using connection strings, call `close()` to clean up:

```typescript
const db = await drizzle('./app.duckdb');

try {
  // Use db...
} finally {
  await db.close();
}
```

For manual connections, close them explicitly:

```typescript
const instance = await DuckDBInstance.create('./app.duckdb');
const connection = await instance.connect();
const db = drizzle({ client: connection });

try {
  // Use db...
} finally {
  connection.closeSync();
  instance.closeSync();
}
```

## Error Handling

```typescript
try {
  const instance = await DuckDBInstance.create('./database.duckdb');
  const connection = await instance.connect();
  const db = drizzle(connection);

  // Use database...
} catch (error) {
  if (error.message.includes('Permission denied')) {
    console.error('Cannot write to database file');
  } else if (error.message.includes('Could not open')) {
    console.error('Database file not found or corrupted');
  } else {
    throw error;
  }
}
```

## See Also

- [drizzle()]({{ '/api/drizzle' | relative_url }}) - API reference
- [Configuration]({{ '/reference/configuration' | relative_url }}) - All options
- [MotherDuck]({{ '/integrations/motherduck' | relative_url }}) - Cloud connection
