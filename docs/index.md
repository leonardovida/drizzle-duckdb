---
layout: home
title: Home
nav_exclude: true
---

# Drizzle DuckDB

**Type-safe DuckDB for TypeScript**

DuckDB dialect for Drizzle ORM with full TypeScript inference, DuckDB-native types, and Postgres-compatible schema definitions.

[Get Started]({{ '/getting-started/' | relative_url }}){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/leonardovida/drizzle-duckdb){: .btn .fs-5 .mb-4 .mb-md-0 .mr-2 }
[LLM Context (llms.txt)]({{ '/llms.txt' | relative_url }}){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## Features

| Feature                 | Description                                                                                              |
| :---------------------- | :------------------------------------------------------------------------------------------------------- |
| **Type Safe**           | Full TypeScript inference with Drizzle's query builder. Catch errors at compile time.                    |
| **DuckDB Native**       | Native support for DuckDB types like STRUCT, MAP, LIST, and JSON. Works with local files and MotherDuck. |
| **Fast Analytics**      | Leverage DuckDB's analytical engine for blazing fast queries on large datasets.                          |
| **Postgres Compatible** | Built on Drizzle's Postgres driver. Use familiar schema definitions and query patterns.                  |
| **DuckLake Ready**      | Attach DuckLake catalogs for lakehouse storage with local files or MotherDuck.                           |

---

## Quick Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';
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

// Query with full type safety
const allUsers = await db.select().from(users);
//    ^? { id: number; name: string; email: string }[]
```
