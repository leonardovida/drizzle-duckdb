<div align="center">

# Drizzle DuckDB

### DuckDB dialect for [Drizzle ORM](https://orm.drizzle.team/)

[![npm version](https://img.shields.io/npm/v/@duckdbfan/drizzle-duckdb)](https://www.npmjs.com/package/@duckdbfan/drizzle-duckdb)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[Documentation](https://leonardovida.github.io/drizzle-duckdb/) • [LLM Context](https://leonardovida.github.io/drizzle-duckdb/llms.txt) • [Examples](./example) • [Contributing](#contributing)

</div>

<br>

**Drizzle DuckDB** brings [Drizzle ORM](https://orm.drizzle.team/) to [DuckDB](https://duckdb.org/), an in-process analytical database. You get Drizzle's type-safe query builder, automatic migrations, and full TypeScript inference while working with DuckDB's analytics engine.

Works with local DuckDB files, in-memory databases, and [MotherDuck](https://motherduck.com/) cloud.

> **Status:** Experimental. Core query building, migrations, and type inference work well. Some DuckDB-specific types and edge cases are still being refined.

> **Note:** The npm package is `@duckdbfan/drizzle-duckdb`.

Docs tip: every docs page has a **Markdown (raw)** button for LLM-friendly source.

## Installation

```bash
bun add @duckdbfan/drizzle-duckdb @duckdb/node-api
```

```bash
npm install @duckdbfan/drizzle-duckdb @duckdb/node-api
```

```bash
pnpm add @duckdbfan/drizzle-duckdb @duckdb/node-api
```

Supported client versions include `@duckdb/node-api@1.4.4-r.1` and `@duckdb/node-api@1.5.5-r.4`. The repo now develops against `1.5.5-r.4`, and `1.4.4-r.1` remains supported.
Tested `drizzle-orm` versions currently span `0.40.1` through `0.45.x`.

## Quick Start

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
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

### pg_duckdb

For PostgreSQL servers with the
[`pg_duckdb`](https://github.com/duckdb/pg_duckdb) extension installed, use a
Postgres wire client such as `pg`:

```typescript
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from '@duckdbfan/drizzle-duckdb';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});
await client.connect();

const db = drizzle(client);

await db.execute(sql`SET duckdb.force_execution = true`);
```

When using a `pg.Pool`, wrap it so transactions pin one backend connection:

```typescript
import pg from 'pg';
import {
  createPgDuckConnectionPool,
  drizzle,
} from '@duckdbfan/drizzle-duckdb';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(createPgDuckConnectionPool(pool));
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
- Tune timeout and recycling behavior on the auto-created pool: `pool: { size: 8, idleTimeoutMs: 60_000, maxLifetimeMs: 10 * 60_000 }`.
- Disable pooling for single-connection workloads: `pool: false`.
- Transactions pin one pooled connection for their entire lifetime; non-transactional queries still use the pool.
- Create the pool manually when you need the `setup` hook or want to reuse the same pool across multiple `drizzle()` instances:

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

## Schema & Types

- Use `drizzle-orm/pg-core` for schemas; DuckDB SQL is largely Postgres-compatible.
- DuckDB-specific helpers: `duckDbList`, `duckDbArray`, `duckDbStruct`, `duckDbMap`, `duckDbJson`, `duckDbBlob`, `duckDbInet`, `duckDbInterval`, `duckDbTimestamp`, `duckDbDate`, `duckDbTime`.
- `duckDbTimestamp` and `duckDbTime` can preserve DuckDB-specific storage variants such as `TIMESTAMP_NS`, `TIMESTAMP_MS`, `TIMESTAMP_S`, `TIME_NS`, and `TIME WITH TIME ZONE` via the `duckDbType` / `withTimezone` options.
- Browser-safe imports live under `@duckdbfan/drizzle-duckdb/helpers` (introspection emits this path).

See the [column types](https://leonardovida.github.io/drizzle-duckdb/api/columns) docs for full API.

## Postgres Schema Compatibility

Use `pgTable`, `pgSchema`, and other `drizzle-orm/pg-core` builders as you do with Postgres. The dialect keeps table definitions and relations intact while adapting queries to DuckDB.

## MotherDuck Helpers

MotherDuck table function helpers are composable SQL fragments:

```typescript
import { sql } from 'drizzle-orm';
import {
  mdAccessTokens,
  mdCreateDive,
  mdCreateFlight,
  mdGetDive,
  mdListDives,
  mdListFlights,
  mdRunFlight,
} from '@duckdbfan/drizzle-duckdb';

const dives = await db.execute(sql`
  select id, title, owner_name, updated_at
  from ${mdListDives({ limit: 10, includeOrgShares: true })}
  order by updated_at desc
`);

const [dive] = await db.execute(sql`
  select id, title, current_version
  from ${mdCreateDive({
    title: 'Revenue Trends',
    content: 'export default function Dive() { return null }',
    description: 'Monthly revenue dashboard',
  })}
`);

const [diveContent] = await db.execute(sql`
  select title, content
  from ${mdGetDive(String(dive.id))}
`);

const flights = await db.execute(sql`
  select flight_id, flight_name, current_version
  from ${mdListFlights({ limit: 25 })}
`);

const activeTokens = await db.execute(sql`
  select token_name, token_type
  from ${mdAccessTokens({ activeOnly: true })}
`);

const [flight] = await db.execute(sql`
  select flight_id, status
  from ${mdCreateFlight({
    name: 'daily-refresh',
    sourceCode: 'print("hello")',
    scheduleCron: '0 0 * * *',
    maxRuntimeSec: 1_800,
  })}
`);

const runs = await db.execute(sql`
  select run_number, status, created_at
  from ${mdRunFlight(String(flight.flight_id), {
    config: { region: 'eu-west-1' },
  })}
`);
```

The Dives helper family covers the public preview table functions for listing,
reading, creating, updating, deleting, and versioning Dives: `mdListDives()`,
`mdGetDive()`, `mdCreateDive()`, `mdUpdateDiveMetadata()`,
`mdUpdateDiveContent()`, `mdDeleteDive()`, `mdListDiveVersions()`, and
`mdGetDiveVersion()`. Dive listing and version rows include
`required_resources` on supported MotherDuck deployments.

The older `mdJobs()` helper family remains exported as deprecated compatibility
aliases. Those helpers call the supported Flight table functions and preserve
the older `job_*` result column names where the Flight result uses `flight_*`.
The earlier `mdFlights()`, `mdFlightRuns()`, `mdFlightLogs()`, and
`mdFlightVersions()` TypeScript helper names also remain as deprecated aliases,
but new code should use the verb-style Flight helpers.
`mdGetFlightLogs()` returns one `MotherDuckFlightLogLineRow` per log line with
`line_number`, `reported_at`, and `line` fields. The old blob-shaped
`MotherDuckFlightLogsRow` type remains exported for the deprecated
`mdFlightLogs()` and `mdJobRunLogs()` compatibility views.
For optional Flight fields, `undefined` omits the named parameter and `null`
emits an explicit SQL `NULL`. MotherDuck treats explicit `NULL` values as clear
or empty values for nullable Flight options such as `requirementsTxt`, `config`,
and `flightSecretNames`.
Use `maxRuntimeSec` on `mdCreateFlight()` or `mdUpdateFlight()` to cap each run
in seconds. Set it to `0` for no timeout, or omit it to use the plan default.

`config` entries are exposed to Flight code as environment variables using the
config key. Config keys must not be empty, cannot contain `=` or NULL bytes, and
cannot use reserved runtime names such as `MOTHERDUCK_TOKEN` or
`MOTHERDUCK_FLIGHTS_RUN`. Config values cannot contain NULL bytes.
`flightSecretNames` references MotherDuck `TYPE flights` secrets; each secret
param is exposed as `<SECRET_NAME>_<KEY>`, so a secret named `api_secret` with
param `API_KEY` becomes `API_SECRET_API_KEY`.

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
} from '@duckdbfan/drizzle-duckdb';

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
import { migrate } from '@duckdbfan/drizzle-duckdb';

await migrate(db, { migrationsFolder: './drizzle' });
```

Migration metadata is stored in `drizzle.__drizzle_migrations` by default. See [Migrations Documentation](https://leonardovida.github.io/drizzle-duckdb/guide/migrations) for configuration options.

## Schema Introspection

Generate Drizzle schema from an existing DuckDB database:

### CLI

```bash
bunx duckdb-introspect --url ./my-database.duckdb --out ./drizzle/schema.ts
```

### Programmatic

```typescript
import { introspect } from '@duckdbfan/drizzle-duckdb';

const result = await introspect(db, {
  schemas: ['public', 'analytics'],
  includeViews: true,
});

console.log(result.files.schemaTs);
```

See [Introspection Documentation](https://leonardovida.github.io/drizzle-duckdb/guide/introspection) for all options.

## Configuration Options

```typescript
const db = drizzle(connection, {
  // Enable query logging
  logger: new DefaultLogger(),

  // Pool size, presets, and timeout/recycling when using connection strings.
  pool: { size: 8, idleTimeoutMs: 60_000 },

  // Throw on Postgres-style array literals like '{1,2,3}' (default: false)
  rejectStringArrayLiterals: false,

  // Pass your schema for relational queries
  schema: mySchema,
});
```

Postgres array operators (`@>`, `<@`, `&&`) are automatically rewritten to DuckDB's `array_has_*` functions via AST transformation. First-dimension `array_lower(a, 1)` and `array_upper(a, 1)` calls are also rewritten to DuckDB-compatible `array_length` expressions.

## Known Limitations

This connector aims for compatibility with Drizzle's Postgres driver but has some differences:

| Feature               | Status                                                                       |
| --------------------- | ---------------------------------------------------------------------------- |
| Basic CRUD operations | Full support                                                                 |
| Joins and subqueries  | Full support                                                                 |
| Transactions          | No savepoints (nested transactions reuse outer)                              |
| JSON/JSONB columns    | Use `duckDbJson()` instead                                                   |
| Prepared statements   | Optional per-connection cache via `prepareCache`; no named statements         |
| Streaming results     | Chunked reads via `executeBatches()` / `executeArrow()`; no cursor streaming |
| Concurrent queries    | One query per connection; use pooling for parallelism                        |

See [Limitations Documentation](https://leonardovida.github.io/drizzle-duckdb/reference/limitations) for details.

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
