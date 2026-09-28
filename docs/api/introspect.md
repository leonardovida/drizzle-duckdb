---
layout: default
title: introspect()
parent: API Reference
nav_order: 6
---

# introspect()

The `introspect()` function generates Drizzle schema TypeScript code from an existing DuckDB database.

## Signature

```typescript
function introspect(
  db: DuckDBDatabase,
  opts?: IntrospectOptions
): Promise<IntrospectResult>;
```

## Options

```typescript
interface IntrospectOptions {
  // Database/catalog to introspect (default: current database)
  database?: string;

  // Introspect all attached databases instead of just current one
  allDatabases?: boolean;

  // Specific schemas to introspect (default: all non-system schemas)
  schemas?: string[];

  // Include views in output (default: false)
  includeViews?: boolean;

  // Use DuckDB-specific timestamp types (default: true)
  useCustomTimeTypes?: boolean;

  // Map JSON columns to duckDbJson (default: true)
  mapJsonAsDuckDbJson?: boolean;

  // Base import path for local types (default: '@duckdbfan/drizzle-duckdb/helpers')
  importBasePath?: string;
}
```

## Return Value

```typescript
interface IntrospectResult {
  files: {
    // Generated TypeScript schema code
    schemaTs: string;

    // Metadata about introspected tables
    metaJson: IntrospectedTable[];

    /** @deprecated Never populated. Will be removed in the next major version. */
    relationsTs?: string;
  };
}

interface IntrospectedTable {
  // Database (catalog) that owns the table
  database?: string;
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: IntrospectedColumn[];
  constraints: IntrospectedConstraint[];
  indexes: DuckDbIndexRow[];
}
```

## Basic Usage

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, introspect } from '@duckdbfan/drizzle-duckdb';
import { writeFileSync } from 'fs';

const instance = await DuckDBInstance.create('./my-database.duckdb');
const connection = await instance.connect();
const db = drizzle(connection);

// Introspect the database
const result = await introspect(db);

// Write the generated schema
writeFileSync('./src/schema.ts', result.files.schemaTs);

console.log('Schema generated successfully');
```

## With Options

```typescript
const result = await introspect(db, {
  // Only introspect specific schemas
  schemas: ['main', 'analytics'],

  // Include views
  includeViews: true,

  // Use standard Postgres timestamp types instead of DuckDB-specific
  useCustomTimeTypes: false,
});
```

## MotherDuck Workspaces

When connected to MotherDuck with multiple attached databases:

```typescript
// Only introspect current database (default behavior)
const result = await introspect(db);

// Introspect a specific database
const result = await introspect(db, {
  database: 'my_share',
});

// Introspect all attached databases
const result = await introspect(db, {
  allDatabases: true,
});
```

## Generated Schema Example

For a database with this table:

```sql
CREATE TABLE main.users (
  id INTEGER PRIMARY KEY,
  email VARCHAR NOT NULL UNIQUE,
  name VARCHAR,
  tags VARCHAR[],
  metadata JSON,
  created_at TIMESTAMPTZ
);
```

The generated schema is (verbatim `duckdb-introspect` output, before any formatter runs):

<!-- prettier-ignore -->
```typescript
import { integer, pgSchema, primaryKey, unique, varchar } from 'drizzle-orm/pg-core';
import { duckDbJson, duckDbList, duckDbTimestamp } from '@duckdbfan/drizzle-duckdb/helpers';

export const mainSchema = pgSchema("main");

export const users = mainSchema.table("users", {
  id: integer("id").notNull(),
  email: varchar("email").notNull(),
  name: varchar("name"),
  tags: duckDbList("tags", "VARCHAR"),
  metadata: duckDbJson("metadata"),
  createdAt: duckDbTimestamp("created_at", { withTimezone: true }),
}, (t) => ({
  usersIdPkey: primaryKey({ columns: [t.id], name: "users_id_pkey" }),
  usersEmailKey: unique("users_email_key").on(t.email),
}));
```

## Type Mapping

| DuckDB Type                      | Generated Drizzle Type                             |
| -------------------------------- | -------------------------------------------------- |
| `TINYINT`, `SMALLINT`, `INTEGER` | `integer()`                                        |
| `BIGINT`, `UBIGINT`              | `bigint({ mode: 'number' })`                       |
| `VARCHAR` (also `TEXT`)          | `varchar()`                                        |
| `BOOLEAN`                        | `boolean()`                                        |
| `DOUBLE`                         | `doublePrecision()`                                |
| `FLOAT`, `REAL`                  | `real()`                                           |
| `DECIMAL(p,s)`                   | `numeric({ precision: p, scale: s })`              |
| `UUID`                           | `uuid()`                                           |
| `TIMESTAMP`                      | `duckDbTimestamp()`                                |
| `TIMESTAMPTZ`                    | `duckDbTimestamp({ withTimezone: true })`          |
| `DATE`                           | `duckDbDate()`                                     |
| `TIME`                           | `duckDbTime()`                                     |
| `JSON`                           | `duckDbJson()`                                     |
| `VARCHAR[]`                      | `duckDbList('VARCHAR')`                            |
| `INTEGER[3]`                     | `duckDbArray('INTEGER', 3)`                        |
| `STRUCT(...)`                    | `duckDbStruct({...})`                              |
| `MAP(VARCHAR, INTEGER)`          | `duckDbMap('INTEGER')`                             |
| `BLOB`                           | `duckDbBlob()`                                     |
| `INET`                           | `duckDbInet()`                                     |
| `INTERVAL`                       | `duckDbInterval()`                                 |
| Anything else                    | `text()` with an `unsupported DuckDB type` comment |

With `useCustomTimeTypes: false`, timestamp, date and time columns use the pg-core builders, and timestamp columns with a `current_timestamp` default get `.defaultNow()`. With the DuckDB helpers they get ``.default(sql`current_timestamp`)``. Defaults the introspector does not recognize become a `/* default: ... */` comment. See the [Introspection guide]({{ '/features/introspection' | relative_url }}#type-mappings) for the full mapping.

## CLI Usage

A CLI tool is also available for quick introspection:

```bash
# Introspect and output to file
bunx duckdb-introspect --url ./my-database.duckdb --out ./src/schema.ts

# With options (--schema takes a comma-separated list)
bunx duckdb-introspect \
  --url ./my-database.duckdb \
  --schema main,analytics \
  --include-views \
  --out ./src/schema.ts
```

See [CLI options]({{ '/features/introspection' | relative_url }}#options) for every flag and the exit codes.

## Complete Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, introspect } from '@duckdbfan/drizzle-duckdb';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

async function generateSchema() {
  const instance = await DuckDBInstance.create('./data/app.duckdb');
  const connection = await instance.connect();
  const db = drizzle(connection);

  try {
    const result = await introspect(db, {
      schemas: ['main'],
      includeViews: true,
      useCustomTimeTypes: true,
      mapJsonAsDuckDbJson: true,
    });

    // Ensure output directory exists
    const outputPath = './src/db/schema.ts';
    mkdirSync(dirname(outputPath), { recursive: true });

    // Write schema file
    writeFileSync(outputPath, result.files.schemaTs);

    // Optionally write metadata for tooling
    writeFileSync(
      './src/db/schema-meta.json',
      JSON.stringify(result.files.metaJson, null, 2)
    );

    console.log(`Schema written to ${outputPath}`);
    console.log(`Found ${result.files.metaJson.length} tables/views`);
  } finally {
    connection.closeSync();
  }
}

generateSchema().catch(console.error);
```

## See Also

- [Introspection Guide]({{ '/features/introspection' | relative_url }}): introspection workflow
- [migrate()]({{ '/api/migrate' | relative_url }}): applying migrations
- [Column Types]({{ '/api/columns' | relative_url }}): available column types
