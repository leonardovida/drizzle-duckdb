---
layout: default
title: Configuration
parent: Reference
nav_order: 1
---

# Configuration

Reference for the configuration options in Drizzle DuckDB.

## drizzle() Options

The `drizzle()` function accepts a configuration object:

```typescript
const db = await drizzle(':memory:', {
  logger: true,
  schema: mySchema,
  rejectStringArrayLiterals: false,
  pool: { size: 6, idleTimeoutMs: 60_000 },
});
```

`pool` and `ducklake` need the connection-string or `{ connection }` form, because the driver creates the connections. The other options also work when you pass your own client, as in `drizzle(connection, { logger: true })`.

### logger

Enable query logging for debugging.

| Type                | Default     | Description                             |
| ------------------- | ----------- | --------------------------------------- |
| `boolean \| Logger` | `undefined` | Enable logging or provide custom logger |

**Usage**:

```typescript
// Use default logger (logs to console)
const db = drizzle(connection, { logger: true });

// Use custom logger
import { DefaultLogger } from 'drizzle-orm';

const db = drizzle(connection, {
  logger: new DefaultLogger({
    writer: {
      write(message: string) {
        // Custom logging logic
        myLogger.debug(message);
      },
    },
  }),
});
```

**Example output** for ``db.execute(sql`SELECT * FROM users WHERE id = ${1}`)``:

```
Query: SELECT * FROM users WHERE id = $1 -- params: [1]
```

### schema

Schema definition for relational queries.

| Type                      | Default     | Description                             |
| ------------------------- | ----------- | --------------------------------------- |
| `Record<string, unknown>` | `undefined` | Schema object with tables and relations |

**Usage**:

```typescript
// schema.ts
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name'),
});

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id'),
  title: text('title'),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

// db.ts
import * as schema from './schema';

const db = drizzle(connection, { schema });

// Now relational queries work
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

### Array SQL Handling

Postgres array operators (`@>`, `<@`, `&&`) are sent unchanged. DuckDB supports them on `LIST` and fixed-size `ARRAY` values with the same results as `array_has_all` and `array_has_any`.

Postgres first-dimension array bounds calls are rewritten via AST transformation. This is always enabled and cannot be disabled:

| Postgres Function   | Rewritten To                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `array_lower(a, 1)` | `CASE WHEN array_length(a) > 0 THEN 1 ELSE NULL END`               |
| `array_upper(a, 1)` | `CASE WHEN array_length(a) > 0 THEN array_length(a) ELSE NULL END` |

**Example**:

```typescript
// Postgres-style code works as written
const results = await db
  .select()
  .from(products)
  .where(arrayContains(products.tags, ['sale']));
// Generated: WHERE "products"."tags" @> $1
```

### prepareCache

Enable a per-connection prepared statement cache.

| Type                                       | Default | Description                                                    |
| ------------------------------------------ | ------- | -------------------------------------------------------------- |
| `boolean` / `number` / `{ size?: number }` | `false` | Cache prepared statements. Numbers or `size` set the LRU size. |

**Usage**:

```typescript
// Enable with default size (32)
const db = drizzle(connection, { prepareCache: true });

// Custom cache size
const db = drizzle(connection, { prepareCache: { size: 16 } });
```

### rejectStringArrayLiterals

Throw an error when a parameter without column information looks like a Postgres-style array literal (`'{...}'`).

| Type      | Default | Description                                          |
| --------- | ------- | ---------------------------------------------------- |
| `boolean` | `false` | Throw instead of converting and warning on `'{...}'` |

Values bound to a column, such as inserts or `eq(column, value)`, are stored and compared as written and never checked. The check covers plain `sql` template parameters, `sql.param(...)` values and bare `sql.placeholder(...)` values. By default such a parameter is converted to a list when its contents parse as a JSON array after the braces become brackets (`'{1,2}'` becomes `[1, 2]`), and the driver logs a warning once per session.

**Usage**:

```typescript
// Default: converts '{1,2}' to [1, 2] and warns through the logger once per session
const db = drizzle(connection, { rejectStringArrayLiterals: false });
await db.execute(sql`SELECT * FROM t WHERE scores = ${'{1,2}'}`);
// Logged: [duckdb] Received a stringified Postgres-style array literal. ...

// Strict mode: throws error
const db = drizzle(connection, { rejectStringArrayLiterals: true });
await db.execute(sql`SELECT * FROM t WHERE scores = ${'{1,2}'}`);
// Error: Stringified array literals are not supported. Use duckDbList()/duckDbArray() or pass native arrays.
```

The full warning text is `[duckdb] Received a stringified Postgres-style array literal. Use duckDbList()/duckDbArray() or pass native arrays instead. You can also set rejectStringArrayLiterals=true to throw.` It goes to the configured logger, so you only see it when `logger` is set, unless you pass `arrayLiteralWarning`.

### arrayLiteralWarning

Handle the first detected Postgres-style array literal warning yourself instead of sending it to the logger.

| Type                      | Default | Description                                                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `(query: string) => void` | logger  | Called once per session with the SQL text when a `'{...}'` parameter without column information is found |

**Usage**:

```typescript
const db = drizzle(connection, {
  arrayLiteralWarning: (query) => {
    console.warn('Array literal parameter detected', query);
  },
});
```

### pool

Control connection pooling for the connection-string and `{ connection }` forms. DuckDB runs one query per connection, so pooling enables parallelism. `pool` is ignored when you pass a connection or pool instance.

| Type                                                                              | Default | Description                                  |
| --------------------------------------------------------------------------------- | ------- | -------------------------------------------- |
| `false`                                                                           | `4`     | Disable pooling (single connection)          |
| `{ size?, acquireTimeout?, maxWaitingRequests?, maxLifetimeMs?, idleTimeoutMs? }` | `4`     | Pool size plus timeout and recycling options |
| `'pulse'`, `'standard'`, `'jumbo'`, `'mega'`, `'giga'`, `'local'`, `'memory'`     | `4`     | Preset sizes (MotherDuck/local defaults)     |

**Usage**:

```typescript
// Auto-pooling (default size 4)
const db = await drizzle('md:');

// Custom size
const db = await drizzle('md:', { pool: { size: 8 } });

// MotherDuck preset
const db = await drizzle('md:', { pool: 'jumbo' }); // 8 connections

// Disable pooling
const db = await drizzle('md:', { pool: false });

// Timeouts, queue limits, and recycling
const db = await drizzle('md:', {
  pool: {
    size: 8,
    acquireTimeout: 20_000,
    maxWaitingRequests: 200,
    maxLifetimeMs: 10 * 60_000,
    idleTimeoutMs: 60_000,
  },
});
```

Build the pool manually when you need the `setup` hook or want to share one pool across several `drizzle()` instances:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { createDuckDBConnectionPool, drizzle } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create('md:', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
const pool = createDuckDBConnectionPool(instance, {
  size: 8,
  acquireTimeout: 20_000,
  maxWaitingRequests: 200,
  maxLifetimeMs: 10 * 60_000,
  idleTimeoutMs: 60_000,
});
const db = drizzle(pool);
```

### ducklake

Attach a DuckLake catalog when creating a connection with `drizzle()`.

```typescript
const db = await drizzle(':memory:', {
  ducklake: {
    catalog: './ducklake.duckdb',
    attachOptions: {
      dataPath: './ducklake-data',
      createIfNotExists: true,
    },
  },
});
```

Options:

- `catalog` string. Required. The catalog value after the `ducklake:` prefix.
- `alias` string. Optional. Defaults to `ducklake`.
- `use` boolean. Optional. Defaults to `true`.
- `install` boolean. Optional. Defaults to `false`.
- `load` boolean. Optional. Defaults to `false`.
- `attachOptions` object with fields `createIfNotExists`, `dataInliningRowLimit`, `dataPath`, `encrypted`, `metaParameterName`, `metadataCatalog`, `overrideDataPath`, and `readOnly`.

When the DuckLake catalog is local and `pool` is not set, `drizzle()` uses a pool of size 1. A catalog counts as local when it is `:memory:`, ends in `.duckdb`, `.ddb` or `.ducklake`, or looks like a file path. `md:` catalogs, URLs and Postgres, MySQL or SQLite connection strings do not. A larger `pool` works in one process because all connections share the attached catalog and the driver sets up one connection at a time. With a local catalog and a pool size above 1, `drizzle()` logs a `[ducklake]` warning. See [DuckLake pooling]({{ '/integrations/ducklake#pooling-guidance' | relative_url }}).

## migrate() Options

The `migrate()` function accepts either a string path or configuration object:

```typescript
// Simple: just the path
await migrate(db, './drizzle');

// Full configuration
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationsTable: '__drizzle_migrations',
  migrationsSchema: 'drizzle',
});
```

### migrationsFolder

Path to the folder containing SQL migration files.

| Type     | Default  | Description                  |
| -------- | -------- | ---------------------------- |
| `string` | Required | Path to migrations directory |

### migrationsTable

Name of the table used to track applied migrations.

| Type     | Default                  | Description                   |
| -------- | ------------------------ | ----------------------------- |
| `string` | `'__drizzle_migrations'` | Migration tracking table name |

### migrationsSchema

Schema where the migrations tracking table is created.

| Type     | Default     | Description                 |
| -------- | ----------- | --------------------------- |
| `string` | `'drizzle'` | Schema for migrations table |

## introspect() Options

Options for schema introspection:

```typescript
const result = await introspect(db, {
  database: 'my_database',
  schemas: ['main', 'analytics'],
  includeViews: true,
  useCustomTimeTypes: true,
  mapJsonAsDuckDbJson: true,
  importBasePath: '@duckdbfan/drizzle-duckdb/helpers',
});
```

### database

Specific database to introspect.

| Type     | Default          | Description          |
| -------- | ---------------- | -------------------- |
| `string` | Current database | Target database name |

### allDatabases

Introspect all attached databases (ignored if `database` is set).

| Type      | Default | Description                    |
| --------- | ------- | ------------------------------ |
| `boolean` | `false` | Include all attached databases |

### schemas

Specific schemas to introspect.

| Type       | Default                | Description        |
| ---------- | ---------------------- | ------------------ |
| `string[]` | All non-system schemas | Schemas to include |

### includeViews

Include views in the output.

| Type      | Default | Description               |
| --------- | ------- | ------------------------- |
| `boolean` | `false` | Generate schema for views |

### useCustomTimeTypes

Use DuckDB-specific timestamp types.

| Type      | Default | Description                |
| --------- | ------- | -------------------------- |
| `boolean` | `true`  | Use `duckDbTimestamp` etc. |

When `true`, generates:

```typescript
createdAt: duckDbTimestamp('created_at'),
```

When `false`, generates:

```typescript
createdAt: timestamp('created_at'),
```

### mapJsonAsDuckDbJson

Map JSON columns to `duckDbJson`.

| Type      | Default | Description                       |
| --------- | ------- | --------------------------------- |
| `boolean` | `true`  | Use `duckDbJson` for JSON columns |

### importBasePath

Base path for local type imports.

| Type     | Default                               | Description           |
| -------- | ------------------------------------- | --------------------- |
| `string` | `'@duckdbfan/drizzle-duckdb/helpers'` | Import path for types |

## Environment Variables

Common environment variables used with Drizzle DuckDB:

### MOTHERDUCK_TOKEN

Authentication token for MotherDuck connections.

```bash
MOTHERDUCK_TOKEN=your_token_here
```

```typescript
const instance = await DuckDBInstance.create('md:', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
```

## TypeScript Configuration

Recommended `tsconfig.json` settings:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## See Also

- [drizzle()]({{ '/api/drizzle' | relative_url }}): API reference
- [migrate()]({{ '/api/migrate' | relative_url }}): migration API
- [introspect()]({{ '/api/introspect' | relative_url }}): introspection API
