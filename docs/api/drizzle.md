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
function drizzle<TRelations>(
  connectionString: string
): Promise<DuckDBDatabase<TRelations>>;

// 2. Connection string plus config (async, creates a pool)
function drizzle<TRelations>(
  connectionString: string,
  config: DuckDBDrizzleConfig<TRelations>
): Promise<DuckDBDatabase<TRelations>>;

// 3. Config object with `connection` (async, creates a pool)
function drizzle<TRelations>(
  config: DuckDBDrizzleConfig<TRelations> & {
    connection: string | DuckDBConnectionConfig;
  }
): Promise<DuckDBDatabase<TRelations>>;

// 4. Config object with `client` (sync)
function drizzle<TRelations>(
  config: DuckDBDrizzleConfig<TRelations> & { client: DuckDBClientLike }
): DuckDBDatabase<TRelations>;

// 5. Client instance plus optional config (sync)
function drizzle<TRelations>(
  client: DuckDBClientLike,
  config?: DuckDBDrizzleConfig<TRelations>
): DuckDBDatabase<TRelations>;
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

### One instance per file per process

The async forms share one DuckDB instance per database path in a process, through `DuckDBInstance.fromCache()`. Two `drizzle('./app.duckdb')` calls, for example a migration script and the app, or tests that open the same file, read and write the same database. Closing one of them leaves the other usable.

Opening a path that is already open with different instance options throws `Can't open a connection to same database file with a different configuration`. Pass the same `options` everywhere, or share one `db`.

`:memory:` is not shared. Every `drizzle(':memory:')` call gets its own database.

The sync forms use the instance you created. If the same process also calls `drizzle(path)` on that file, create your instance with `DuckDBInstance.fromCache(path)` instead of `DuckDBInstance.create(path)`, so both share one instance.

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
- A `PgDuckClient`: a Postgres wire client such as `pg.Client` connected to a server with pg_duckdb
- A `pg.Pool`. It is wrapped with `createPgDuckConnectionPool()` automatically, so a transaction runs on one pooled client and `db.close()` ends the pool

```typescript
import { DuckDBInstance } from '@duckdb/node-api';

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
```

For SQL with several statements, node-postgres returns one result per statement. The driver uses the last one, as it does for DuckDB connections. A custom `PgDuckClient` that returns array rows, as with `rowMode: 'array'`, must also return `fields`. Otherwise the query throws `pg_duckdb client returned array rows without field metadata`.

### config (optional)

```typescript
interface DuckDBDrizzleConfig<TRelations> {
  // Enable query logging (true uses Drizzle's DefaultLogger)
  logger?: Logger | boolean;

  // Relations from defineRelations() for relational queries
  relations?: TRelations;

  // Pool size preset, pool options, or false for a single connection.
  // Used only by the connection string and { connection } forms.
  pool?: DuckDBPoolConfig | PoolPreset | false;

  // Attach a DuckLake catalog on every connection
  ducklake?: DuckLakeConfig;

  // How a bare Date in sql`...` binds: a naive UTC TIMESTAMP (default) or
  // a TIMESTAMPTZ instant.
  dateParams?: 'timestamp' | 'timestamptz';

  // Read DECIMAL values as exact strings across raw, streaming and nested reads (default: 'number')
  decimalMode?: 'number' | 'string';

  // Opt into legacy heuristic qualification of raw SQL join operands (default: false)
  qualifyRawJoinColumns?: boolean;

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
  'pulse' | 'standard' | 'jumbo' | 'mega' | 'giga' | 'local' | 'memory';
```

`pool` applies only to the connection-string and `{ connection }` forms. It is ignored when you pass a connection or pool instance.

`ducklake` works with the async forms and with an explicit pool. Passing it with a single connection throws. Use `configureDuckLake(connection, config)` in that case. With a local catalog (`:memory:`, a `duckdb:` or `file:` catalog, or a path without a scheme such as `meta.db`) and no `pool` setting, the driver uses a pool of size 1. A larger `pool` also works, and the driver logs a warning for local catalogs. See [DuckLake]({{ '/integrations/ducklake' | relative_url }}).

The config type takes `logger` and `relations` from Drizzle's `DrizzleConfig`. drizzle-orm 1.0 removed the `schema` and `casing` options, and `drizzle()` throws when it receives either one. Casing is set on the table definition instead:

```typescript
import { integer, snakeCase, text } from 'drizzle-orm/pg-core';

const users = snakeCase.table('users', {
  id: integer().primaryKey(),
  userName: text(),
});
const db = drizzle(connection);
await db.insert(users).values({ id: 1, userName: 'ada' });
// insert into "users" ("id", "user_name") values ($1, $2)
```

See [Upgrading to v3]({{ '/reference/upgrading-to-v3' | relative_url }}#drizzle-orm-10).

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

### With Relations for Relational Queries

```typescript
import { relations } from './schema'; // built with defineRelations()

const db = drizzle(connection, {
  relations,
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
