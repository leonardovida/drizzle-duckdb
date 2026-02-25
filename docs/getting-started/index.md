---
layout: default
title: Getting Started
nav_order: 1
has_children: true
permalink: /getting-started/
---

# Introduction

Drizzle DuckDB brings [Drizzle ORM](https://orm.drizzle.team/) to [DuckDB](https://duckdb.org/) - the fast in-process analytical database.

{: .warning }

> Install `@duckdbfan/drizzle-duckdb`.
> The older package `@leonardovida-md/drizzle-neo-duckdb` is being deprecated and stops receiving updates after May 2, 2026.

## What is Drizzle DuckDB?

This package is a DuckDB dialect adapter for Drizzle ORM. It provides:

- **Type-safe queries** - Full TypeScript inference with Drizzle's query builder
- **DuckDB-native types** - Support for STRUCT, MAP, LIST, JSON, and other DuckDB-specific types
- **Postgres compatibility** - Uses Drizzle's familiar `pg-core` schema definitions
- **Analytical power** - Leverage DuckDB's columnar engine for fast analytics

## When to Use DuckDB

DuckDB excels at:

- **Analytical queries** - Aggregations, window functions, complex joins
- **Large dataset processing** - Columnar storage and vectorized execution
- **Local-first applications** - In-process database, no server required
- **Data transformation** - Read/write Parquet, CSV, JSON directly

DuckDB is less suited for:

- **High-frequency OLTP** - Many small insert/update operations
- **Real-time transactional workloads** - Use Postgres instead

## Quick Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';

// Define your schema
const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});

// Connect to DuckDB
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const db = drizzle(connection);

// Query with full type safety
const allUsers = await db.select().from(users);
//    ^? { id: number; name: string; email: string }[]
```

## Status

{: .warning }

> **Experimental**
>
> This package is experimental. Core query building, migrations, and type inference work well. Some DuckDB-specific types and edge cases are still being refined.

## Next Steps

- [Installation]({{ '/getting-started/installation' | relative_url }}) - Set up the package
- [Quick Start]({{ '/getting-started/quick-start' | relative_url }}) - Build your first query
- [Coming from Postgres]({{ '/getting-started/coming-from-postgres' | relative_url }}) - Migration guide for Drizzle users

## Resources

- [GitHub Repository](https://github.com/leonardovida/drizzle-duckdb)
- [npm Package](https://www.npmjs.com/package/@duckdbfan/drizzle-duckdb)
- [DuckDB Documentation](https://duckdb.org/docs/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
