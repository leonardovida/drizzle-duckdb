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

`migrationsSchema` and `migrationsTable` cannot contain a double quote (`"`). DuckDB's `nextval()` drops escaped quotes from the sequence name, so `migrate()` throws `Invalid migrationsTable "...": migration journal names cannot contain double quotes (").` before it creates anything. Spaces, dots, `'` and other characters work.

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

### Concurrent migrations

Concurrent `migrate()` calls apply each migration once:

- Calls on the same database in one process run one after another. `migrate()` queues calls that share a `DuckDBDatabase` instance created from a path, or the same connection or pool.
- Calls from separate connections to one DuckDB instance can still race. DuckDB then fails one of them with a `TransactionContext Error` such as `Catalog write-write conflict`. `migrate()` retries the setup and the migration transaction up to 10 times with a short backoff (a few seconds in total). Each attempt reads the tracking table again, so migrations that the other call committed are skipped.
- The unique index on `created_at` keeps two migrators from recording the same migration twice. If a run fails and the latest migration is already recorded, `migrate()` returns without error.

A retry does not wait for a long migration in another connection to finish. If the other migration runs longer than the retry window, the call fails with the conflict error and you can run it again. Other errors, such as a failing statement in a migration, are not retried.

### DuckLake

`migrate()` works when DuckLake is the default catalog, which is the default `use: true` setting. DuckLake has no sequences, primary keys or indexes, so the driver detects a DuckLake catalog and creates a plain tracking table instead. It has the same columns, `id` is computed when each row is inserted, and there is no unique index on `created_at`.

Two points follow from that:

- Migrations run in one transaction, as with a regular database. Calls in one process are still queued. Two processes that migrate one DuckLake catalog at the same time rely on DuckLake's own conflict detection and the retry described above, without the unique index as a backstop. Run migrations from a single process when you can.
- The migration SQL must itself be valid on DuckLake. Tables with primary keys, unique constraints, foreign keys or `serial` columns fail. Generate those migrations from a schema without them, or write them by hand.

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

### "Catalog write-write conflict" errors

Another connection ran DDL or a migration on the same database at the same time, and the conflict outlasted the retries described in [Concurrent migrations](#concurrent-migrations). Run `migrate()` again once the other migration has finished, or run migrations from a single process before the app starts.

### Schema doesn't exist

Make sure the migrations schema is created:

```typescript
await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
await migrate(db, './drizzle');
```
