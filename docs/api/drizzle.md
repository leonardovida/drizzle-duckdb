---
layout: default
title: drizzle()
parent: API Reference
nav_order: 1
---

# drizzle()

The `drizzle()` function is the main entry point for creating a Drizzle database instance connected to DuckDB.

## Signatures

`drizzle()` has five overloads. The forms that take a path create the DuckDB instance for you and return a `Promise`. The forms that take an existing client return the database synchronously.

```typescript
// 1. Connection string (async, creates a pool)
function drizzle<TSchema>(
  connectionString: string
): Promise<DuckDBDatabase<TSchema>>;

// 2. Connection string plus config (async, creates a pool)
function drizzle<TSchema>(
  connectionString: string,
  config: DuckDBDrizzleConfig<TSchema>
): Promise<DuckDBDatabase<TSchema>>;

// 3. Config object with `connection` (async, creates a pool)
function drizzle<TSchema>(
  config: DuckDBDrizzleConfig<TSchema> & {
    connection: string | DuckDBConnectionConfig;
  }
): Promise<DuckDBDatabase<TSchema>>;

// 4. Config object with `client` (sync)
function drizzle<TSchema>(
  config: DuckDBDrizzleConfig<TSchema> & { client: DuckDBClientLike }
): DuckDBDatabase<TSchema>;

// 5. Client instance plus optional config (sync)
function drizzle<TSchema>(
  client: DuckDBClientLike,
  config?: DuckDBDrizzleConfig<TSchema>
): DuckDBDatabase<TSchema>;
```

```typescript
// Async forms
const db1 = await drizzle(':memory:');
const db2 = await drizzle('./app.duckdb', { pool: { size: 8 } });
const db3 = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});

// Sync forms
const db4 = drizzle({ client: connection });
const db5 = drizzle(connection);
```

Call `await db.close()` on databases created by the async forms. It closes the pool and the DuckDB instance. For the sync forms you own the client, so close it yourself.

## Parameters

### connectionString / connection

A DuckDB database path such as `':memory:'`, `'./file.duckdb'`, `'md:'` or `'md:my_database'`. Use the object form to pass DuckDB instance options:

```typescript
interface DuckDBConnectionConfig {
  /** Database path: ':memory:', './file.duckdb', 'md:', 'md:database' */
  path: string;
  /** DuckDB instance options (e.g., motherduck_token) */
  options?: Record<string, string>;
}
```

### client

An existing client. `DuckDBClientLike` is a union of the clients the driver can run queries on:

```typescript
type DuckDBExecutionClient = DuckDBConnection | PgDuckClient;
type DuckDBClientLike = DuckDBExecutionClient | DuckDBConnectionPool;

interface DuckDBConnectionPool {
  acquire(): Promise<DuckDBExecutionClient>;
  release(connection: DuckDBExecutionClient): void | Promise<void>;
  close?(): Promise<void> | void;
}
```

- `DuckDBConnection` from `@duckdb/node-api`, obtained with `instance.connect()`
- A pool from `createDuckDBConnectionPool()` or any object with `acquire()` and `release()`
- A `PgDuckClient`: a Postgres wire client such as `pg.Client` connected to a server with pg_duckdb, or a `pg.Pool` wrapped with `createPgDuckConnectionPool()`

```typescript
import { DuckDBInstance } from '@duckdb/node-api';

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
```

### config (optional)

```typescript
interface DuckDBDrizzleConfig<TSchema> {
  // Enable query logging (true uses Drizzle's DefaultLogger)
  logger?: Logger | boolean;

  // Schema for relational queries
  schema?: TSchema;

  // Pool size preset, pool options, or false for a single connection.
  // Used only by the connection string and { connection } forms.
  pool?: DuckDBPoolConfig | PoolPreset | false;

  // Attach a DuckLake catalog on every connection
  ducklake?: DuckLakeConfig;

  // Enable a per-connection prepared statement cache (default: disabled).
  // true uses 32 statements per connection.
  prepareCache?: boolean | number | { size?: number };

  // Throw on Postgres-style array literals like '{1,2,3}' (default: false)
  rejectStringArrayLiterals?: boolean;

  // Receive the Postgres-style array literal warning instead of the logger
  arrayLiteralWarning?: (query: string) => void;
}

interface DuckDBPoolConfig {
  size?: number; // default 4
  acquireTimeout?: number; // ms, default 30000
  maxWaitingRequests?: number; // default 100
  maxLifetimeMs?: number;
  idleTimeoutMs?: number;
}

type PoolPreset =
  | 'pulse'
  | 'standard'
  | 'jumbo'
  | 'mega'
  | 'giga'
  | 'local'
  | 'memory';
```

`pool` applies only to the connection-string and `{ connection }` forms. It is ignored when you pass a connection or pool instance.

`ducklake` works with the async forms and with an explicit pool. Passing it with a single connection throws. Use `configureDuckLake(connection, config)` in that case. With a local catalog (`:memory:`, a `.duckdb`, `.ddb` or `.ducklake` file, or a file path) and no `pool` setting, the driver uses a pool of size 1. A larger `pool` also works, and the driver logs a warning for local catalogs. See [DuckLake]({{ '/integrations/ducklake' | relative_url }}).

The config type extends Drizzle's `DrizzleConfig`, so it also accepts `casing` and `cache`. The DuckDB driver does not apply either option.

## Return Value

Returns a `DuckDBDatabase` instance, or a `Promise` of one for the async forms. It provides the full Drizzle query builder API plus the DuckDB methods listed in [DuckDBDatabase]({{ '/api/database' | relative_url }}).

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

`findMany()` returns an array and `findFirst()` returns one object or `undefined`. See [Relations]({{ '/core/schema' | relative_url }}#relations) for the result shape.

### Strict Array Literal Handling

```typescript
// Throw an error on Postgres-style array literals like '{1,2,3}'
const db = drizzle(connection, {
  rejectStringArrayLiterals: true,
});
```

Note: Postgres array operators (`@>`, `<@`, `&&`) run natively in DuckDB and are sent unchanged.

## See Also

- [DuckDBDatabase]({{ '/api/database' | relative_url }}): the database class returned by `drizzle()`
- [Configuration]({{ '/reference/configuration' | relative_url }}): configuration reference
- [Database Connection]({{ '/core/connection' | relative_url }}): connection patterns guide
