<div align="center">

# Drizzle DuckDB

### DuckDB dialect for [Drizzle ORM](https://orm.drizzle.team/)

[![npm version](https://img.shields.io/npm/v/@duckdbfan/drizzle-duckdb)](https://www.npmjs.com/package/@duckdbfan/drizzle-duckdb)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[Documentation](https://leonardovida.github.io/drizzle-duckdb/) • [LLM Context](https://leonardovida.github.io/drizzle-duckdb/llms.txt) • [Examples](./example) • [Contributing](#contributing)

</div>

<br>

**Drizzle DuckDB** brings [Drizzle ORM](https://orm.drizzle.team/) to [DuckDB](https://duckdb.org/), the in-process analytical database. You get Drizzle's type-safe query builder, migrations and TypeScript inference on top of DuckDB. It works with in-memory databases, local files, [MotherDuck](https://motherduck.com/) and Postgres servers running [`pg_duckdb`](https://github.com/duckdb/pg_duckdb).

> **Status:** Experimental. Query building, migrations and type inference are stable. Some DuckDB-specific types and edge cases are still being refined.

Every docs page has a **Markdown (raw)** button with LLM-friendly source.

## Installation

```bash
bun add @duckdbfan/drizzle-duckdb drizzle-orm @duckdb/node-api
# or: npm install / pnpm add with the same packages
```

| Requirement        | Supported versions                                                                  |
| ------------------ | ----------------------------------------------------------------------------------- |
| `drizzle-orm`      | 0.40.1 or newer, below 0.46.0                                                       |
| `@duckdb/node-api` | 1.4.4 or newer, below 1.6.0, including `-r.N` builds such as `1.5.5-r.5`            |
| Runtime            | Node.js 18.17 or newer (22 or 24 recommended), or Bun                               |

## Quick Start

```typescript
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});

const db = await drizzle(':memory:');

await db.execute(sql`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  )
`);

await db.insert(users).values([
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
]);

const allUsers = await db.select().from(users);
//    ^? { id: number; name: string; email: string }[]

await db.close();
```

Schemas use the regular `drizzle-orm/pg-core` builders (`pgTable`, `pgSchema` and so on), and all standard Drizzle query methods work. DuckDB SQL is largely Postgres-compatible, and the dialect adapts queries where it is not.

## Connecting

Pass a path and the driver creates a connection pool for you. `await db.close()` closes it.

```typescript
import { drizzle } from '@duckdbfan/drizzle-duckdb';

// In-memory
const db = await drizzle(':memory:');

// Local file (created if missing)
const db = await drizzle('./my-database.duckdb');

// MotherDuck
const db = await drizzle({
  connection: {
    path: 'md:my_database',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});

// DuckLake catalog
const db = await drizzle(':memory:', {
  ducklake: {
    catalog: './ducklake.duckdb',
    attachOptions: { dataPath: './ducklake-data' },
  },
});
```

Calls with the same file path share one DuckDB instance in a process, so they see each other's writes. `:memory:` is never shared.

You can also pass your own connection, pool or `pg_duckdb` client. These calls are synchronous:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import pg from 'pg';

// Existing DuckDB connection
const instance = await DuckDBInstance.create(':memory:');
const db = drizzle(await instance.connect());

// Postgres server with pg_duckdb. A pg.Client works too.
const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
```

A `pg.Pool` is wrapped with `createPgDuckConnectionPool()`, so each transaction runs on one pooled client and `await db.close()` ends the pool.

See [Database Connection](https://leonardovida.github.io/drizzle-duckdb/core/connection) for singleton and serverless patterns.

## Connection Pooling

DuckDB runs one query per connection, so the path forms above create a pool (default size 4).

- Set the size or a MotherDuck preset: `pool: { size: 8 }`, `pool: 'jumbo'` or `pool: 'giga'`.
- Tune recycling: `pool: { size: 8, idleTimeoutMs: 60_000, maxLifetimeMs: 10 * 60_000 }`.
- Disable pooling: `pool: false`.
- Transactions pin one pooled connection for their whole lifetime.
- `pool` is ignored when you pass a connection or pool instance.

Create the pool yourself when you need the `setup` hook or want to share it between `drizzle()` instances:

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

## Configuration

```typescript
import { DefaultLogger } from 'drizzle-orm';

const db = await drizzle(':memory:', {
  // Log every query
  logger: new DefaultLogger(),

  // Pool size, preset, or timeout and recycling options
  pool: { size: 8, idleTimeoutMs: 60_000 },

  // Per-connection prepared statement cache (default: disabled)
  prepareCache: { size: 32 },

  // Throw on Postgres-style array literals like '{1,2,3}' (default: false)
  rejectStringArrayLiterals: false,

  // Map camelCase keys to snake_case column names
  casing: 'snake_case',

  // Schema for relational queries
  schema: mySchema,
});
```

`pool` and `ducklake` apply only to the path and `{ connection }` forms. The other options also work with `drizzle(connection, { ... })`. See [Configuration](https://leonardovida.github.io/drizzle-duckdb/reference/configuration) for the full list.

## DuckDB Types

DuckDB-specific column helpers: `duckDbList`, `duckDbArray`, `duckDbStruct`, `duckDbMap`, `duckDbJson`, `duckDbBlob`, `duckDbInet`, `duckDbInterval`, `duckDbTimestamp`, `duckDbDate` and `duckDbTime`.

- `duckDbTimestamp` and `duckDbTime` can keep storage variants such as `TIMESTAMP_NS`, `TIMESTAMP_MS`, `TIMESTAMP_S`, `TIME_NS` and `TIME WITH TIME ZONE` through the `duckDbType` and `withTimezone` options.
- Postgres `json` and `jsonb` columns are rejected. Use `duckDbJson()`.
- Browser-safe imports live under `@duckdbfan/drizzle-duckdb/helpers`. Introspection emits this path.

See [Column Types](https://leonardovida.github.io/drizzle-duckdb/api/columns) for the full API.

### Arrays

DuckDB supports `@>`, `<@` and `&&` on lists and fixed-size arrays, so Drizzle's `arrayContains`, `arrayContained` and `arrayOverlaps` work unchanged. The DuckDB helpers emit `array_has_all` and `array_has_any`:

```typescript
import {
  duckDbArrayContained,
  duckDbArrayContains,
  duckDbArrayOverlaps,
} from '@duckdbfan/drizzle-duckdb';

// Tags include every value
db.select().from(products).where(duckDbArrayContains(products.tags, ['electronics', 'sale']));

// Tags are a subset of the values
db.select().from(products).where(duckDbArrayContained(products.tags, ['electronics', 'sale', 'featured']));

// Tags share at least one value
db.select().from(products).where(duckDbArrayOverlaps(products.tags, ['electronics', 'books']));
```

First-dimension `array_lower(a, 1)` and `array_upper(a, 1)` calls are rewritten to `array_length` expressions, because DuckDB lacks those functions.

## Transactions

```typescript
await db.transaction(async (tx) => {
  await tx.insert(accounts).values({ balance: 100 });
  await tx.update(accounts).set({ balance: 50 }).where(eq(accounts.id, 1));
});
```

DuckDB differs from Postgres here:

- There is no `SAVEPOINT`. Nested transactions reuse the outer one, so an inner rollback aborts everything.
- Any failed statement aborts the whole transaction. Catching the error inside the callback does not keep earlier writes. `db.transaction()` rolls back and rejects.
- The `config` argument (`isolationLevel`, `accessMode`, `deferrable`) is deprecated and ignored with a one-time warning, because DuckDB has no `SET TRANSACTION`.

## Migrations

```typescript
import { migrate } from '@duckdbfan/drizzle-duckdb';

await migrate(db, { migrationsFolder: './drizzle' });
```

Metadata goes to `drizzle.__drizzle_migrations` by default. Concurrent `migrate()` calls apply each migration once, and DuckLake works as the default catalog. See [Migrations](https://leonardovida.github.io/drizzle-duckdb/features/migrations) for configuration.

## Schema Introspection

Generate a Drizzle schema from an existing database with the CLI:

```bash
bunx duckdb-introspect --url ./my-database.duckdb --out ./drizzle/schema.ts
```

Or from code:

```typescript
import { introspect } from '@duckdbfan/drizzle-duckdb';

const result = await introspect(db, {
  schemas: ['public', 'analytics'],
  includeViews: true,
});

console.log(result.files.schemaTs);
```

See [Introspection](https://leonardovida.github.io/drizzle-duckdb/features/introspection) for all options.

## Analytics and MotherDuck Helpers

The package ships composable SQL helpers for analytical work:

- OLAP helpers such as `sumN`, `percentileCont`, window helpers and the `olap()` grouped measures builder.
- Lance vector, full-text and hybrid search.
- MotherDuck table functions for Dives, Flights and access tokens.
- Batch and Arrow reads through `db.executeBatches()`, `db.executeBatchesRaw()` and `db.executeArrow()`.

```typescript
import { sql } from 'drizzle-orm';
import { mdCreateFlight, mdListDives, mdRunFlight } from '@duckdbfan/drizzle-duckdb';

const dives = await db.execute(sql`
  select id, title, updated_at
  from ${mdListDives({ limit: 10, includeOrgShares: true })}
  order by updated_at desc
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

await db.execute(sql`
  select run_number, status
  from ${mdRunFlight(String(flight.flight_id), { config: { region: 'eu-west-1' } })}
`);
```

The older `mdJobs()` and `mdFlights()` helper names remain as deprecated aliases. See [OLAP Helpers](https://leonardovida.github.io/drizzle-duckdb/api/olap-helpers) for the full list, Flight options and log pagination.

## Known Limitations

| Feature               | Status                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| Basic CRUD operations | Full support                                                                  |
| Joins and subqueries  | Full support                                                                  |
| Transactions          | No savepoints (nested transactions reuse the outer one). Config is ignored    |
| JSON/JSONB columns    | Use `duckDbJson()` instead                                                    |
| Prepared statements   | Optional per-connection cache via `prepareCache`, no named statements         |
| Streaming results     | Chunked reads via `executeBatches()`, no cursor streaming                     |
| Concurrent queries    | One query per connection. Use pooling for parallelism                         |

See [Limitations](https://leonardovida.github.io/drizzle-duckdb/reference/limitations) for details.

## Examples

- **[Parquet Analytics](./example/parquet-analytics.ts)**: typed selections and grouped measures over Parquet files without importing tables
- **[MotherDuck NYC Taxi](./example/motherduck-nyc-taxi.ts)**: query the MotherDuck sample NYC taxi dataset with a connection pool
- **[Analytics Dashboard](./example/analytics-dashboard.ts)**: local in-memory analytics with DuckDB types and Parquet loading
- **[DuckLake Local](./example/ducklake-local.ts)** and **[DuckLake on MotherDuck](./example/ducklake-motherduck.ts)**: attach a DuckLake catalog

Run them from the repository root:

```bash
bun example/analytics-dashboard.ts
MOTHERDUCK_TOKEN=your_token bun example/motherduck-nyc-taxi.ts
```

See [example/README.md](./example/README.md) for the full list.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the guide and [SECURITY.md](./SECURITY.md) to report a vulnerability.

```bash
bun install      # install dependencies
bun run test     # run tests (Vitest, not `bun test`)
bun run t        # watch mode with the UI
bun run build    # build dist/
```

Include tests for new features in `test/<feature>.test.ts`, note any DuckDB quirks you hit, and use short imperative commit messages.

## License

[Apache-2.0](./LICENSE)
