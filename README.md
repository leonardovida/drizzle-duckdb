<div align="center">

# Drizzle DuckDB

### DuckDB dialect for [Drizzle ORM](https://orm.drizzle.team/)

[![npm version](https://img.shields.io/npm/v/@leonardovida-md/drizzle-neo-duckdb)](https://www.npmjs.com/package/@leonardovida-md/drizzle-neo-duckdb)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[Documentation](https://leonardovida.github.io/drizzle-neo-duckdb/) • [LLM Context](https://leonardovida.github.io/drizzle-neo-duckdb/llms.txt) • [Examples](./example) • [Contributing](#contributing)

</div>

<br>

**Drizzle DuckDB** brings [Drizzle ORM](https://orm.drizzle.team/) to [DuckDB](https://duckdb.org/), an in-process analytical database. You get Drizzle's type-safe query builder, automatic migrations, and full TypeScript inference while working with DuckDB's analytics engine.

Works with local DuckDB files, in-memory databases, and [MotherDuck](https://motherduck.com/) cloud.

> **Status:** Experimental. Core query building, migrations, and type inference work well. Some DuckDB-specific types and edge cases are still being refined.

> **Note:** The NPM package is `@leonardovida-md/drizzle-neo-duckdb` while the repository is `drizzle-duckdb`. This is due to a migration to preserve the existing NPM package name.

Docs tip: every docs page has a **Markdown (raw)** button for LLM-friendly source.

## Installation

```bash
bun add @leonardovida-md/drizzle-neo-duckdb @duckdb/node-api
```

```bash
npm install @leonardovida-md/drizzle-neo-duckdb @duckdb/node-api
```

```bash
pnpm add @leonardovida-md/drizzle-neo-duckdb @duckdb/node-api
```

## Quick Start

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';
import { sql } from 'drizzle-orm';
import { integer, text, pgTable } from 'drizzle-orm/pg-core';

// Connect to DuckDB
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const db = drizzle(connection);

// Define your schema
const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});

// Create table
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  )
`);

// Insert data
await db.insert(users).values([
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
]);

// Query with full type safety
const allUsers = await db.select().from(users);
//    ^? { id: number; name: string; email: string }[]

// Clean up
connection.closeSync();
```

## Connecting to DuckDB

### In-Memory Database

```typescript
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const db = drizzle(connection);
```

### Local File

```typescript
const instance = await DuckDBInstance.create('./my-database.duckdb');
const connection = await instance.connect();
const db = drizzle(connection);
```

### MotherDuck Cloud

```typescript
const instance = await DuckDBInstance.create('md:', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
const connection = await instance.connect();
const db = drizzle(connection);
```

### With Logging

```typescript
import { DefaultLogger } from 'drizzle-orm';

const db = drizzle(connection, {
  logger: new DefaultLogger(),
});
```

> Tip: With connection strings (recommended), just pass the path: `const db = await drizzle(':memory:')`. Pooling is automatic.

## Connection Pooling

DuckDB executes one query per connection. The async `drizzle()` entrypoints create a pool automatically (default size: 4). Options:

- Set pool size or MotherDuck preset: `drizzle('md:', { pool: { size: 8 } })` or `pool: 'jumbo'` / `pool: 'giga'`.
- Disable pooling for single-connection workloads: `pool: false`.
- Transactions pin one pooled connection for their entire lifetime; non-transactional queries still use the pool.
- For tuning (acquire timeout, queue limits, idle/lifetime recycling), create the pool manually:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import {
  createDuckDBConnectionPool,
  drizzle,
} from '@leonardovida-md/drizzle-neo-duckdb';

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

## Schema & Types

- Use `drizzle-orm/pg-core` for schemas; DuckDB SQL is largely Postgres-compatible.
- DuckDB-specific helpers: `duckDbList`, `duckDbArray`, `duckDbStruct`, `duckDbMap`, `duckDbJson`, `duckDbBlob`, `duckDbInet`, `duckDbInterval`, `duckDbTimestamp`, `duckDbDate`, `duckDbTime`.
- Browser-safe imports live under `@leonardovida-md/drizzle-neo-duckdb/helpers` (introspection emits this path).

See the [column types](https://leonardovida.github.io/drizzle-neo-duckdb/api/columns) docs for full API.

## Postgres Schema Compatibility

Use `pgTable`, `pgSchema`, and other `drizzle-orm/pg-core` builders as you do with Postgres. The dialect keeps table definitions and relations intact while adapting queries to DuckDB.

## Querying

All standard Drizzle query methods work:

```typescript
// Select
const users = await db
  .select()
  .from(usersTable)
  .where(eq(usersTable.active, true));

// Insert
await db
  .insert(usersTable)
  .values({ name: 'Alice', email: 'alice@example.com' });

// Insert with returning
const inserted = await db
  .insert(usersTable)
  .values({ name: 'Bob' })
  .returning({ id: usersTable.id });

// Update
await db
  .update(usersTable)
  .set({ name: 'Updated' })
  .where(eq(usersTable.id, 1));

// Delete
await db.delete(usersTable).where(eq(usersTable.id, 1));
```

### Array Operations

For DuckDB array operations, use the custom helpers instead of Postgres operators:

```typescript
import {
  duckDbArrayContains,
  duckDbArrayContained,
  duckDbArrayOverlaps,
} from '@leonardovida-md/drizzle-neo-duckdb';

// Check if array contains all values
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayContains(products.tags, ['electronics', 'sale']));

// Check if array is contained by values
const results = await db
  .select()
  .from(products)
  .where(
    duckDbArrayContained(products.tags, ['electronics', 'sale', 'featured'])
  );

// Check if arrays overlap
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayOverlaps(products.tags, ['electronics', 'books']));
```

## Transactions

```typescript
await db.transaction(async (tx) => {
  await tx.insert(accounts).values({ balance: 100 });
  await tx.update(accounts).set({ balance: 50 }).where(eq(accounts.id, 1));
});
```

> **Note:** DuckDB doesn't support `SAVEPOINT`, so nested transactions reuse the outer transaction context. Inner rollbacks will abort the entire transaction.

## Migrations

Apply SQL migration files using the `migrate` function:

```typescript
import { migrate } from '@leonardovida-md/drizzle-neo-duckdb';

await migrate(db, { migrationsFolder: './drizzle' });
```

Migration metadata is stored in `drizzle.__drizzle_migrations` by default. See [Migrations Documentation](https://leonardovida.github.io/drizzle-neo-duckdb/guide/migrations) for configuration options.

## Schema Introspection

Generate Drizzle schema from an existing DuckDB database:

### CLI

```bash
bunx duckdb-introspect --url ./my-database.duckdb --out ./drizzle/schema.ts
```

### Programmatic

```typescript
import { introspect } from '@leonardovida-md/drizzle-neo-duckdb';

const result = await introspect(db, {
  schemas: ['public', 'analytics'],
  includeViews: true,
});

console.log(result.files.schemaTs);
```

See [Introspection Documentation](https://leonardovida.github.io/drizzle-neo-duckdb/guide/introspection) for all options.

## Configuration Options

```typescript
const db = drizzle(connection, {
  // Enable query logging
  logger: new DefaultLogger(),

  // Pool size/preset when using connection strings (default: 4). Set false to disable.
  pool: { size: 8 },

  // Throw on Postgres-style array literals like '{1,2,3}' (default: false)
  rejectStringArrayLiterals: false,

  // Pass your schema for relational queries
  schema: mySchema,
});
```

Postgres array operators (`@>`, `<@`, `&&`) are automatically rewritten to DuckDB's `array_has_*` functions via AST transformation.

## Known Limitations

This connector aims for compatibility with Drizzle's Postgres driver but has some differences:

| Feature               | Status                                                                       |
| --------------------- | ---------------------------------------------------------------------------- |
| Basic CRUD operations | Full support                                                                 |
| Joins and subqueries  | Full support                                                                 |
| Transactions          | No savepoints (nested transactions reuse outer)                              |
| JSON/JSONB columns    | Use `duckDbJson()` instead                                                   |
| Prepared statements   | No statement caching                                                         |
| Streaming results     | Chunked reads via `executeBatches()` / `executeArrow()`; no cursor streaming |
| Concurrent queries    | One query per connection; use pooling for parallelism                        |

See [Limitations Documentation](https://leonardovida.github.io/drizzle-neo-duckdb/reference/limitations) for details.

## Examples

- **[MotherDuck NYC Taxi](./example/motherduck-nyc.ts)**: Query the built-in NYC taxi dataset from MotherDuck cloud
- **[Analytics Dashboard](./example/analytics-dashboard.ts)**: Local in-memory analytics with DuckDB types and Parquet loading

Run examples:

```bash
MOTHERDUCK_TOKEN=your_token bun example/motherduck-nyc.ts
bun example/analytics-dashboard.ts
```

## Contributing

Contributions are welcome! Please:

1. Include tests for new features (`test/<feature>.test.ts`)
2. Note any DuckDB-specific quirks you encounter
3. Use a clear, imperative commit message

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests with UI
bun t

# Build
bun run build
```

## License

[Apache-2.0](./LICENSE)
