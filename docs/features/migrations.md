---
layout: default
title: Migrations
parent: Features
nav_order: 1
---

# Migrations

Drizzle DuckDB supports running SQL migration files against your DuckDB database using the `migrate` function.

## Basic Usage

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, migrate } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create('./my-database.duckdb');
const connection = await instance.connect();
const db = drizzle(connection);

await migrate(db, { migrationsFolder: './drizzle' });

connection.closeSync();
```

## Migration Folder Structure

The folder must use the layout that [Drizzle Kit](https://orm.drizzle.team/kit-docs/overview) generates: one SQL file per migration plus `meta/_journal.json`. The journal lists each migration's `tag` (the SQL file name without `.sql`) and `when` timestamp. `migrate()` throws `Can't find meta/_journal.json file` when the journal is missing, so a folder of plain SQL files is not enough:

```
drizzle/
├── 0000_init.sql
├── 0001_add_users.sql
├── 0002_add_posts.sql
└── meta/
    └── _journal.json
```

Each migration file contains raw SQL statements. Drizzle Kit separates statements with `--> statement-breakpoint` comments, and the migrator runs each part as its own statement:

```sql
-- 0000_init.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id)
);
```

## Configuration Options

### migrationsFolder

Path to the folder containing migration files:

```typescript
await migrate(db, {
  migrationsFolder: './drizzle',
});
```

Or pass just the path string:

```typescript
await migrate(db, './drizzle');
```

### migrationsSchema

Schema where the migrations table is created (default: `'drizzle'`):

```typescript
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationsSchema: 'my_schema',
});
```

### migrationsTable

Name of the table tracking applied migrations (default: `'__drizzle_migrations'`):

```typescript
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationsTable: 'schema_migrations',
});
```

## How It Works

1. **Creates schema**: the migrations schema is created if it doesn't exist.
2. **Creates sequence**: a sequence generates migration IDs.
3. **Creates tracking table**: a table stores which migrations have been applied. With the default names the driver runs:
   ```sql
   CREATE SCHEMA IF NOT EXISTS "drizzle";
   CREATE SEQUENCE IF NOT EXISTS "drizzle"."__drizzle_migrations_id_seq";
   CREATE SEQUENCE IF NOT EXISTS "drizzle"."migrations_pk_seq";
   CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
     id integer PRIMARY KEY default nextval('"drizzle"."__drizzle_migrations_id_seq"'),
     hash text NOT NULL,
     created_at bigint
   );
   CREATE UNIQUE INDEX IF NOT EXISTS "__drizzle_migrations_created_at_unique"
     ON "drizzle"."__drizzle_migrations" (created_at);
   ```
   The `migrations_pk_seq` sequence is kept for databases created by older versions.
4. **Runs pending migrations**: all pending migrations run inside one transaction. If any statement fails, none of the pending migrations are applied.
5. **Records completion**: each applied migration is inserted into the tracking table in the same transaction.

The unique index on `created_at` keeps two concurrent `migrate()` calls from recording the same migration twice. If the transaction fails because another process already applied the latest migration, `migrate()` returns without error.

## Migration Tracking

The driver records a SHA-256 hash and the journal `when` timestamp for each applied migration. This means:

- Migrations only run once
- Migrations run in journal order. A migration is pending when its `when` timestamp is later than the newest `created_at` in the tracking table
- The stored hash is not compared on later runs. Editing a migration that was already applied has no effect, so add a new migration instead

To check which migrations have been applied:

```typescript
import { sql } from 'drizzle-orm';

const applied = await db.execute(sql`
  SELECT hash, created_at
  FROM drizzle.__drizzle_migrations
  ORDER BY created_at
`);
console.log(applied);
```

## Using with Drizzle Kit

While Drizzle Kit doesn't have native DuckDB support, you can generate migrations using the Postgres dialect since DuckDB's SQL is largely compatible:

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
});
```

Generate migrations:

```bash
bunx drizzle-kit generate
```

Then apply them with this package:

```typescript
await migrate(db, './drizzle');
```

{: .warning }

> **Note**
>
> Some generated SQL may need manual adjustment for DuckDB compatibility. Check the generated files before applying.

## Full Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, migrate } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';

async function runMigrations() {
  const instance = await DuckDBInstance.create('./my-database.duckdb');
  const connection = await instance.connect();
  const db = drizzle(connection);

  try {
    console.log('Running migrations...');
    await migrate(db, {
      migrationsFolder: './drizzle',
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });
    console.log('Migrations complete!');

    // Verify
    const tables = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'main'
    `);
    console.log(
      'Tables:',
      tables.map((t) => t.table_name)
    );
  } finally {
    connection.closeSync();
  }
}

runMigrations().catch(console.error);
```

## Troubleshooting

### "Migration already applied" errors

If you need to re-run migrations during development, you can clear the tracking table. The next `migrate()` call then runs every migration in the folder again:

```typescript
await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
await migrate(db, './drizzle');
```

### Sequence errors

If you see sequence-related errors, ensure the sequence exists:

```typescript
await db.execute(sql`
  CREATE SEQUENCE IF NOT EXISTS drizzle.__drizzle_migrations_id_seq
`);
```

### Schema doesn't exist

Make sure the migrations schema is created:

```typescript
await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
await migrate(db, './drizzle');
```
