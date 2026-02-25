---
layout: default
title: migrate()
parent: API Reference
nav_order: 5
---

# migrate()

The `migrate()` function applies SQL migrations to your DuckDB database.

## Signature

```typescript
function migrate<TSchema extends Record<string, unknown>>(
  db: DuckDBDatabase<TSchema>,
  config: DuckDbMigrationConfig
): Promise<void>;

type DuckDbMigrationConfig = MigrationConfig | string;

interface MigrationConfig {
  migrationsFolder: string;
  migrationsTable?: string;
  migrationsSchema?: string;
}
```

## Parameters

### db

The Drizzle database instance created by `drizzle()`.

### config

Either a string path to the migrations folder, or a configuration object:

| Option             | Type     | Default                  | Description                                |
| ------------------ | -------- | ------------------------ | ------------------------------------------ |
| `migrationsFolder` | `string` | Required                 | Path to migrations directory               |
| `migrationsTable`  | `string` | `'__drizzle_migrations'` | Table name for tracking applied migrations |
| `migrationsSchema` | `string` | `'drizzle'`              | Schema for the migrations table            |

## Basic Usage

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, migrate } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create('./my-database.duckdb');
const connection = await instance.connect();
const db = drizzle(connection);

// Simple usage with just the folder path
await migrate(db, './drizzle/migrations');
```

## With Configuration Object

```typescript
await migrate(db, {
  migrationsFolder: './drizzle/migrations',
  migrationsTable: 'my_migrations',
  migrationsSchema: 'app',
});
```

## Migration Files

Migration files should be SQL files in the migrations folder, named with a timestamp or sequential number:

```
drizzle/migrations/
  0000_initial.sql
  0001_add_users_table.sql
  0002_add_orders_table.sql
```

### Example Migration File

```sql
-- 0001_add_users_table.sql
CREATE SEQUENCE IF NOT EXISTS users_id_seq;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY DEFAULT nextval('users_id_seq'),
  email VARCHAR NOT NULL UNIQUE,
  name VARCHAR NOT NULL,
  created_at TIMESTAMPTZ DEFAULT current_timestamp
);
```

## Using with Drizzle Kit

You can use Drizzle Kit to generate migrations:

```typescript
// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql', // Use postgresql dialect
} satisfies Config;
```

Generate migrations:

```bash
bunx drizzle-kit generate
```

{: .warning }

> **DuckDB Compatibility**
>
> Drizzle Kit generates Postgres SQL. Some statements may need manual adjustment for DuckDB compatibility. Common issues:
>
> - `SERIAL` should use sequences with `nextval()`
> - `JSONB` should be `JSON`
> - Some constraints syntax may differ

## Migration Tracking

The migrate function creates a tracking table to record applied migrations:

```sql
-- Created automatically in the specified schema
CREATE SCHEMA IF NOT EXISTS drizzle;

CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
);
```

## Error Handling

```typescript
try {
  await migrate(db, './drizzle/migrations');
  console.log('Migrations applied successfully');
} catch (error) {
  console.error('Migration failed:', error);
  // Handle error - migrations are not automatically rolled back
}
```

## Complete Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, migrate } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema';

async function main() {
  // Create or connect to database
  const instance = await DuckDBInstance.create('./data/app.duckdb');
  const connection = await instance.connect();

  // Create Drizzle instance with schema
  const db = drizzle(connection, { schema });

  // Apply migrations
  console.log('Applying migrations...');
  await migrate(db, {
    migrationsFolder: './drizzle/migrations',
  });
  console.log('Migrations complete');

  // Now use the database
  const users = await db.query.users.findMany();
  console.log('Users:', users);

  // Clean up
  connection.closeSync();
}

main().catch(console.error);
```

## See Also

- [Migrations Guide]({{ '/features/migrations' | relative_url }}) - Detailed migration setup
- [Troubleshooting]({{ '/reference/troubleshooting' | relative_url }}) - Common migration issues
- [Introspection]({{ '/features/introspection' | relative_url }}) - Generate schema from existing database
