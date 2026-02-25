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

| Option               | Description                                               | Default                |
| -------------------- | --------------------------------------------------------- | ---------------------- |
| `--url`              | DuckDB database path (`:memory:`, `./file.duckdb`, `md:`) | Required               |
| `--database`, `--db` | Database/catalog to introspect                            | Current database       |
| `--all-databases`    | Introspect all attached databases                         | `false`                |
| `--schema`           | Comma-separated schema names to introspect                | All non-system schemas |
| `--out`              | Output file path                                          | `./drizzle/schema.ts`  |
| `--include-views`    | Include views in generated schema                         | `false`                |
| `--use-pg-time`      | Use pg-core timestamp/date/time instead of DuckDB helpers | `false`                |
| `--import-base`      | Custom import path for DuckDB column helpers              | Package name           |

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

    // Structured metadata about tables, columns, constraints
    metaJson: IntrospectedTable[];
  };
}
```

## Generated Schema Format

The introspector generates Drizzle schema files with:

1. **Imports** from `drizzle-orm`, `drizzle-orm/pg-core`, and DuckDB helpers
2. **Schema declarations** for each database schema
3. **Table definitions** with columns, constraints, and indexes

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

The introspector generates:

```typescript
import { sql } from 'drizzle-orm';
import { integer, pgSchema, text, varchar } from 'drizzle-orm/pg-core';
import {
  duckDbJson,
  duckDbList,
  duckDbStruct,
  duckDbTimestamp,
} from '@duckdbfan/drizzle-duckdb/helpers';

export const analyticsSchema = pgSchema('analytics');

export const events = analyticsSchema.table('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  properties: duckDbJson('properties'),
  tags: duckDbList('tags', 'TEXT'),
  createdAt: duckDbTimestamp('created_at').defaultNow(),
});

export const users = analyticsSchema.table(
  'users',
  {
    id: integer('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    metadata: duckDbStruct('metadata', { plan: 'TEXT', active: 'BOOLEAN' }),
  },
  (t) => ({
    emailUnique: t.email.unique('users_email_unique'),
  })
);
```

## Type Mappings

### Numeric Types

| DuckDB Type           | Drizzle Builder     |
| --------------------- | ------------------- |
| `TINYINT`, `SMALLINT` | `integer()`         |
| `INTEGER`, `INT`      | `integer()`         |
| `BIGINT`              | `bigint()`          |
| `REAL`, `FLOAT4`      | `real()`            |
| `DOUBLE`, `FLOAT`     | `doublePrecision()` |
| `DECIMAL(p,s)`        | `numeric()`         |

### String Types

| DuckDB Type      | Drizzle Builder          |
| ---------------- | ------------------------ |
| `TEXT`, `STRING` | `text()`                 |
| `VARCHAR(n)`     | `varchar({ length: n })` |
| `CHAR(n)`        | `char({ length: n })`    |

### Date/Time Types

| DuckDB Type                | Drizzle Builder                           |
| -------------------------- | ----------------------------------------- |
| `TIMESTAMP`                | `duckDbTimestamp()`                       |
| `TIMESTAMP WITH TIME ZONE` | `duckDbTimestamp({ withTimezone: true })` |
| `DATE`                     | `duckDbDate()`                            |
| `TIME`                     | `duckDbTime()`                            |

### DuckDB-Specific Types

| DuckDB Type       | Drizzle Builder                  |
| ----------------- | -------------------------------- |
| `type[]` (list)   | `duckDbList('name', 'TYPE')`     |
| `type[n]` (array) | `duckDbArray('name', 'TYPE', n)` |
| `STRUCT(...)`     | `duckDbStruct('name', { ... })`  |
| `MAP(K, V)`       | `duckDbMap('name', 'V')`         |
| `JSON`            | `duckDbJson('name')`             |
| `BLOB`            | `duckDbBlob('name')`             |
| `INET`            | `duckDbInet('name')`             |
| `INTERVAL`        | `duckDbInterval('name')`         |

Unrecognized types fall back to `text()` with a `/* TODO */` comment.

## Constraints

The introspector captures:

- **Primary keys** - Single and composite
- **Foreign keys** - With referenced table and columns
- **Unique constraints** - Single column and multi-column

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
