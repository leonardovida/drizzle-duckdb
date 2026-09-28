---
layout: default
title: Introspection
parent: Features
nav_order: 2
---

# Schema Introspection

Generate Drizzle schema definitions from an existing DuckDB database using the introspection CLI or programmatic API.

## CLI Usage

```bash
bunx duckdb-introspect --url ./my-database.duckdb --out ./drizzle/schema.ts
```

### Options

| Option                               | Description                                                                                        | Default                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `--url`                              | DuckDB database path (`:memory:`, `./file.duckdb`, `md:`)                                          | Required                            |
| `--database`, `--db`                 | Database/catalog to introspect                                                                     | Current database                    |
| `--all-databases`                    | Introspect all attached databases                                                                  | `false`                             |
| `--schema`, `--schemas`              | Comma-separated schema names, such as `--schema main,analytics`. Not a repeatable flag             | All non-system schemas              |
| `--out`, `--outFile`                 | Output file path                                                                                   | `./drizzle/schema.ts`               |
| `--json`, `--out-json`, `--outJson`  | Also write table metadata as JSON to this path                                                     | Not written                         |
| `--include-views`, `--includeViews`  | Include views in generated schema                                                                  | `false`                             |
| `--use-pg-time`                      | Use pg-core `timestamp`/`date`/`time` instead of DuckDB helpers                                    | `false`                             |
| `--import-base`                      | Custom import path for DuckDB column helpers                                                       | `@duckdbfan/drizzle-duckdb/helpers` |
| `--ducklake-catalog`                 | DuckLake catalog value after the `ducklake:` prefix. Required when any `--ducklake-*` flag is used | None                                |
| `--ducklake-alias`                   | Alias for the attached DuckLake database                                                           | `ducklake`                          |
| `--ducklake-no-use`                  | Do not run `USE` after attach                                                                      | Runs `USE`                          |
| `--ducklake-install`                 | Run `INSTALL ducklake` before attach                                                               | `false`                             |
| `--ducklake-load`                    | Run `LOAD ducklake` before attach                                                                  | `false`                             |
| `--ducklake-data-path`               | Data path for DuckLake table storage                                                               | None                                |
| `--ducklake-read-only`               | Attach DuckLake read-only                                                                          | `false`                             |
| `--ducklake-create-if-not-exists`    | Create the catalog if it does not exist                                                            | `false`                             |
| `--ducklake-override-data-path`      | Override the data path of an existing catalog                                                      | `false`                             |
| `--ducklake-data-inlining-row-limit` | Inline row limit for data storage. Must be a non-negative integer                                  | None                                |
| `--ducklake-encrypted`               | Enable encryption for the metadata catalog                                                         | `false`                             |
| `--ducklake-metadata-catalog`        | Override the metadata catalog name                                                                 | None                                |
| `--ducklake-meta-parameter-name`     | Meta parameter name for metadata storage                                                           | None                                |
| `--help`, `-h`                       | Print help and exit                                                                                |                                     |

The CLI exits with code 2 on invalid usage: a missing `--url` (which also prints the help text), a flag without its value, an unknown option, a stray positional argument, or an invalid `--ducklake-data-inlining-row-limit`. Other failures exit with code 1.

Before writing anything, the CLI checks that the `--database` and every `--schema` exist. If one is missing it exits with code 1, names the missing database or schema and lists the available ones, and leaves the output file untouched. A schema that exists but has no tables still writes an empty module and prints a warning.

### Examples

**Local database:**

```bash
bunx duckdb-introspect --url ./analytics.duckdb --out ./src/schema.ts
```

**Specific schemas:**

```bash
bunx duckdb-introspect --url ./db.duckdb --schema public,analytics --out ./schema.ts
```

**Include views:**

```bash
bunx duckdb-introspect --url ./db.duckdb --include-views --out ./schema.ts
```

**MotherDuck:**

```bash
MOTHERDUCK_TOKEN=your_token bunx duckdb-introspect --url md: --database my_cloud_db --out ./schema.ts
```

The CLI automatically uses `MOTHERDUCK_TOKEN` from the environment for `md:` URLs.

## Database Filtering

By default, introspection only returns tables from the **current database**. This prevents accidentally including tables from all attached databases in MotherDuck workspaces.

### Default Behavior

When you connect to DuckDB or MotherDuck, the introspector uses `SELECT current_database()` to determine which database to introspect. This means:

- **Local DuckDB**: Introspects tables in the connected database file
- **MotherDuck**: Introspects only your current database, not shared databases like `sample_data`

### Specifying a Database

Use `--database` (or `--db`) to introspect a specific database:

```bash
# Introspect a specific MotherDuck database
MOTHERDUCK_TOKEN=xxx bunx duckdb-introspect --url md: --database my_analytics_db --out ./schema.ts

# Introspect a specific database with schema filter
MOTHERDUCK_TOKEN=xxx bunx duckdb-introspect --url md: --database my_db --schema main,public --out ./schema.ts
```

### Introspecting All Databases

Use `--all-databases` to introspect tables from all attached databases (use with caution):

```bash
bunx duckdb-introspect --url md: --all-databases --out ./schema.ts
```

`--all-databases` skips the connection-local `temp` catalog and DuckDB's `system` catalog.

### Tables Outside the Current Database

The generated schema does not encode the database (catalog). `pgSchema("main")` produces `"main"."orders"`, which DuckDB resolves against the connection's current database. Tables introspected with `--database` set to another database, or from other databases with `--all-databases`, only work after the connection runs `USE <database>`. The generated file flags this with a header comment and a `/* database: "..." */` comment above each affected table. Tables from different databases that share a schema name also share one `pgSchema()` object, so a single connection can only query one of those databases at a time. Introspect each database into its own file when you need several.

## Programmatic API

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, introspect } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create('./my-database.duckdb');
const connection = await instance.connect();
const db = drizzle(connection);

const result = await introspect(db, {
  schemas: ['public', 'analytics'],
  includeViews: true,
});

console.log(result.files.schemaTs);

connection.closeSync();
```

### Options

```typescript
interface IntrospectOptions {
  // Database/catalog to introspect (default: current database)
  database?: string;

  // When true, introspects all attached databases (default: false)
  allDatabases?: boolean;

  // Schemas to introspect (default: all non-system schemas)
  schemas?: string[];

  // Include views in output (default: false)
  includeViews?: boolean;

  // Use DuckDB timestamp helpers instead of pg-core (default: true)
  useCustomTimeTypes?: boolean;

  // Use duckDbJson for JSON columns (default: true)
  mapJsonAsDuckDbJson?: boolean;

  // Custom import path for helpers (default: '@duckdbfan/drizzle-duckdb/helpers')
  importBasePath?: string;
}
```

### Return Value

```typescript
interface IntrospectResult {
  files: {
    // Generated TypeScript schema file content
    schemaTs: string;

    // Structured metadata about tables, columns, constraints.
    // Each table may include the `database` (catalog) that owns it.
    metaJson: IntrospectedTable[];

    /** @deprecated Never populated. Will be removed in the next major version. */
    relationsTs?: string;
  };
}
```

## Generated Schema Format

The introspector generates Drizzle schema files with:

1. **Imports** from `drizzle-orm`, `drizzle-orm/pg-core`, and DuckDB helpers
2. **Schema declarations** for each database schema
3. **Table definitions** with columns, primary keys, unique constraints and foreign keys
4. **View definitions** (with `--include-views`) as `schema.view(name, { ...columns }).existing()`, which Drizzle treats as read-only and drizzle-kit does not try to create
5. **Comments** for CHECK constraints and `CREATE INDEX` indexes, which are not emitted as Drizzle config

Table variables use the camelCased table name. They are renamed only on a collision: a table name shared across schemas gets a schema prefix (and a database prefix with `--all-databases`), a name that is a JavaScript reserved word or matches an imported helper gets a `Table` suffix, and any remaining clash gets a number suffix.

### Example Output

Given this DuckDB schema:

```sql
CREATE SCHEMA analytics;

CREATE TABLE analytics.events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  properties JSON,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT current_timestamp
);

CREATE TABLE analytics.users (
  id INTEGER PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  metadata STRUCT(plan TEXT, active BOOLEAN)
);
```

The introspector generates this file (verbatim output of `duckdb-introspect --url ./analytics.duckdb`, before any formatter runs):

<!-- prettier-ignore -->
```typescript
import { sql } from 'drizzle-orm';
import { integer, pgSchema, primaryKey, unique, varchar } from 'drizzle-orm/pg-core';
import { duckDbJson, duckDbList, duckDbStruct, duckDbTimestamp } from '@duckdbfan/drizzle-duckdb/helpers';

export const analyticsSchema = pgSchema("analytics");

export const events = analyticsSchema.table("events", {
  id: integer("id").notNull(),
  name: varchar("name").notNull(),
  properties: duckDbJson("properties"),
  tags: duckDbList("tags", "VARCHAR"),
  createdAt: duckDbTimestamp("created_at").default(sql`current_timestamp`),
}, (t) => ({
  eventsIdPkey: primaryKey({ columns: [t.id], name: "events_id_pkey" }),
}));

export const users = analyticsSchema.table("users", {
  id: integer("id").notNull(),
  email: varchar("email").notNull(),
  metadata: duckDbStruct("metadata", { "plan": "VARCHAR", "active": "BOOLEAN" }),
}, (t) => ({
  usersIdPkey: primaryKey({ columns: [t.id], name: "users_id_pkey" }),
  usersEmailKey: unique("users_email_key").on(t.email),
}));
```

Things to note in the output:

- DuckDB reports `TEXT` as `VARCHAR` and drops the `VARCHAR(255)` length, so both columns become `varchar()`.
- Primary keys become `primaryKey()` entries in the table callback, and a single-column `UNIQUE` becomes `unique(name).on(t.col)`.
- DuckDB timestamp helpers get ``.default(sql`current_timestamp`)``. With `--use-pg-time` the column becomes `timestamp(...).defaultNow()`.
- Literal defaults become `.default(value)`. Other defaults, such as `gen_random_uuid()`, `current_date` or `nextval('seq')`, become ``.default(sql`...`)``, so the column is optional in `$inferInsert`.
- Generated columns (`GENERATED ALWAYS AS (...)`) become ``.generatedAlwaysAs(sql`...`)``. Drizzle leaves them out of inserts, which DuckDB requires. If the table's `CREATE TABLE` text cannot be read, the introspector cannot tell a generated column from a default, so it keeps the expression as a `/* default: ... */` comment.

## Type Mappings

### Numeric Types

| DuckDB Type                         | Drizzle Builder                       |
| ----------------------------------- | ------------------------------------- |
| `TINYINT`, `SMALLINT`, `INTEGER`    | `integer()`                           |
| `UTINYINT`, `USMALLINT`, `UINTEGER` | `integer()`                           |
| `BIGINT`                            | `bigint({ mode: 'number' })`          |
| `UBIGINT`, `HUGEINT`, `UHUGEINT`    | `bigint({ mode: 'bigint' })`          |
| `FLOAT`, `REAL`, `FLOAT4`           | `real()`                              |
| `DOUBLE`                            | `doublePrecision()`                   |
| `DECIMAL(p,s)`                      | `numeric({ precision: p, scale: s })` |

DuckDB returns the unsigned 8, 16 and 32-bit types as JS numbers, so they use `integer()` even though `UINTEGER` values go past the Postgres `int4` range. `UBIGINT`, `HUGEINT` and `UHUGEINT` come back as JS `bigint` values, so they use `bigint` mode to keep every digit. `BIGINT` keeps `mode: 'number'`, which rounds values beyond `Number.MAX_SAFE_INTEGER`. Change it to `mode: 'bigint'` by hand if you store larger values.

### String and Other Scalar Types

| DuckDB Type               | Drizzle Builder         |
| ------------------------- | ----------------------- |
| `VARCHAR` (also `TEXT`)   | `varchar()`             |
| `CHAR(n)`                 | `char({ length: n })`   |
| `BOOLEAN`                 | `boolean()`             |
| `UUID`                    | `uuid()`                |
| `ENUM(...)`, `UNION(...)` | `text()` with a comment |

DuckDB stores `TEXT` and `STRING` columns as `VARCHAR` and does not keep a `VARCHAR(n)` length, so they come back as `varchar()` without a length.

### Date/Time Types

| DuckDB Type                                   | Drizzle Builder                           | With `--use-pg-time`                |
| --------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `TIMESTAMP`                                   | `duckDbTimestamp()`                       | `timestamp()`                       |
| `TIMESTAMP WITH TIME ZONE`                    | `duckDbTimestamp({ withTimezone: true })` | `timestamp({ withTimezone: true })` |
| `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS` | `duckDbTimestamp({ duckDbType: '...' })`  | same                                |
| `DATE`                                        | `duckDbDate()`                            | `date()`                            |
| `TIME`                                        | `duckDbTime()`                            | `time()`                            |
| `TIME WITH TIME ZONE`                         | `duckDbTime({ withTimezone: true })`      | same                                |
| `TIME_NS`                                     | `duckDbTime({ duckDbType: 'TIME_NS' })`   | same                                |

### DuckDB-Specific Types

| DuckDB Type       | Drizzle Builder                            |
| ----------------- | ------------------------------------------ |
| `type[]` (list)   | `duckDbList('name', 'TYPE')`               |
| `type[n]` (array) | `duckDbArray('name', 'TYPE', n)`           |
| `STRUCT(...)`     | `duckDbStruct('name', { ... })`            |
| `MAP(K, V)`       | `duckDbMap('name', 'V', { keyType: 'K' })` |
| `JSON`            | `duckDbJson('name')`                       |
| `BLOB`            | `duckDbBlob('name')`                       |
| `INET`            | `duckDbInet('name')`                       |
| `INTERVAL`        | `duckDbInterval('name')`                   |

The generated `duckDbMap` always has the value type. A non-string key type is emitted as `{ keyType }`, for example `duckDbMap("counts", "VARCHAR", { keyType: "INTEGER" })`. String keys (`VARCHAR`) leave out the option because `VARCHAR` is the default.

Unrecognized types fall back to `text()` with a `/* unsupported DuckDB type: ... */` comment.

## Constraints

The introspector captures:

- **Primary keys**: single and composite
- **Foreign keys**: with referenced table and columns
- **Unique constraints**: single column and multi-column

CHECK constraints and indexes created with `CREATE INDEX` are not emitted as `check()`, `index()` or `uniqueIndex()` config. Each one is listed in a comment above its table, for example `/* check "users_age_check" (not emitted): CHECK((age > 0)) */`, so you can add it by hand if you use drizzle-kit.

## Workflow Example

1. **Create database and tables** in DuckDB
2. **Run introspection** to generate schema
3. **Review and adjust** the generated file
4. **Import in your app** for type-safe queries

```bash
# Generate schema
bunx duckdb-introspect --url ./app.duckdb --out ./src/db/schema.ts
```

```typescript
// src/db/index.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema.ts';

const instance = await DuckDBInstance.create('./app.duckdb');
const connection = await instance.connect();

export const db = drizzle(connection, { schema });
```
