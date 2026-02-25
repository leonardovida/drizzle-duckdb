---
layout: default
title: Quick Start
parent: Getting Started
nav_order: 2
---

# Quick Start

Build your first DuckDB application with Drizzle in 5 minutes.

## 1. Define Your Schema

Create a schema file with your table definitions:

```typescript
// schema.ts
import { pgTable, integer, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content'),
  userId: integer('user_id').references(() => users.id),
});
```

## 2. Connect to DuckDB

```typescript
// db.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema';

// In-memory database
const instance = await DuckDBInstance.create(':memory:');

// Or persistent file
// const instance = await DuckDBInstance.create('./my-database.duckdb');

const connection = await instance.connect();
export const db = drizzle(connection, { schema });
```

## 3. Create Tables

```typescript
import { sql } from 'drizzle-orm';
import { db } from './db';

await db.execute(sql`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT current_timestamp
  )
`);

await db.execute(sql`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    user_id INTEGER REFERENCES users(id)
  )
`);
```

## 4. Insert Data

```typescript
import { users, posts } from './schema';
import { db } from './db';

// Insert a user
await db.insert(users).values({
  id: 1,
  name: 'Alice',
  email: 'alice@example.com',
});

// Insert multiple users
await db.insert(users).values([
  { id: 2, name: 'Bob', email: 'bob@example.com' },
  { id: 3, name: 'Carol', email: 'carol@example.com' },
]);

// Insert with returning
const [newPost] = await db
  .insert(posts)
  .values({
    id: 1,
    title: 'Hello World',
    content: 'My first post',
    userId: 1,
  })
  .returning();

console.log(newPost); // { id: 1, title: 'Hello World', ... }
```

## 5. Query Data

```typescript
import { eq, and, like, desc } from 'drizzle-orm';

// Select all users
const allUsers = await db.select().from(users);

// Select with WHERE
const alice = await db.select().from(users).where(eq(users.name, 'Alice'));

// Select specific columns
const names = await db
  .select({ name: users.name, email: users.email })
  .from(users);

// JOIN
const postsWithAuthors = await db
  .select({
    postTitle: posts.title,
    authorName: users.name,
  })
  .from(posts)
  .leftJoin(users, eq(posts.userId, users.id));

// ORDER BY and LIMIT
const recentUsers = await db
  .select()
  .from(users)
  .orderBy(desc(users.createdAt))
  .limit(10);
```

## 6. Update Data

```typescript
await db.update(users).set({ name: 'Alice Smith' }).where(eq(users.id, 1));

// Update with returning
const [updated] = await db
  .update(users)
  .set({ email: 'alice.smith@example.com' })
  .where(eq(users.id, 1))
  .returning();
```

## 7. Delete Data

```typescript
await db.delete(posts).where(eq(posts.userId, 1));

// Delete with returning
const [deleted] = await db.delete(users).where(eq(users.id, 1)).returning();
```

## Complete Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';

// Schema
const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});

async function main() {
  // Connect
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);

  // Create table
  await db.execute(sql`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    )
  `);

  // Insert
  await db.insert(users).values([
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
  ]);

  // Query
  const allUsers = await db.select().from(users);
  console.log('All users:', allUsers);

  const alice = await db.select().from(users).where(eq(users.name, 'Alice'));
  console.log('Alice:', alice[0]);

  // Update
  await db.update(users).set({ name: 'Alice Smith' }).where(eq(users.id, 1));

  // Delete
  await db.delete(users).where(eq(users.id, 2));

  // Final state
  const remaining = await db.select().from(users);
  console.log('Remaining users:', remaining);

  // Cleanup
  connection.closeSync();
}

main().catch(console.error);
```

## Next Steps

- [Database Connection]({{ '/core/connection' | relative_url }}) - Connection patterns
- [Schema Definition]({{ '/core/schema' | relative_url }}) - Advanced schema features
- [Queries]({{ '/core/queries' | relative_url }}) - CTEs, aggregations, and more
- [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}) - STRUCT, LIST, MAP, JSON
