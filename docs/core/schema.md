---
layout: default
title: Schema Definition
parent: Core Concepts
nav_order: 2
---

# Schema Definition

Define your database schema using Drizzle's type-safe schema builders.

## Basic Table

```typescript
import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});
```

## Column Types

### Standard Types (from pg-core)

```typescript
import {
  integer,
  bigint,
  smallint,
  real,
  doublePrecision,
  numeric,
  text,
  varchar,
  char,
  boolean,
  timestamp,
  date,
  time,
  uuid,
} from 'drizzle-orm/pg-core';
```

### DuckDB-Specific Types

```typescript
import {
  duckDbList,
  duckDbArray,
  duckDbStruct,
  duckDbMap,
  duckDbJson,
  duckDbTimestamp,
  duckDbDate,
  duckDbTime,
  duckDbBlob,
  duckDbInet,
  duckDbInterval,
} from '@duckdbfan/drizzle-duckdb';
```

See [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}) for detailed usage.

## Constraints

### Primary Key

```typescript
const users = pgTable('users', {
  id: integer('id').primaryKey(),
});

// Composite primary key
const orderItems = pgTable(
  'order_items',
  {
    orderId: integer('order_id'),
    productId: integer('product_id'),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.productId] })]
);
```

### Not Null

```typescript
const users = pgTable('users', {
  name: text('name').notNull(),
});
```

### Unique

```typescript
const users = pgTable('users', {
  email: text('email').unique(),
});

// Named unique constraint
const users = pgTable(
  'users',
  {
    email: text('email'),
  },
  (t) => [unique('users_email_unique').on(t.email)]
);
```

### Default Values

```typescript
const users = pgTable('users', {
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  data: text('data').default('empty'),
});
```

### Foreign Keys

```typescript
const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
});

// With explicit constraint
const posts = pgTable(
  'posts',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id'),
  },
  (t) => [
    foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: 'posts_user_fk',
    }),
  ]
);
```

## Relations

Define relations for relational queries with `defineRelations()` from drizzle-orm 1.0:

```typescript
import { defineRelations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name'),
});

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id'),
  title: text('title'),
});

export const relations = defineRelations({ users, posts }, (r) => ({
  users: {
    posts: r.many.posts({ from: r.users.id, to: r.posts.userId }),
  },
  posts: {
    author: r.one.users({ from: r.posts.userId, to: r.users.id }),
  },
}));
```

Pass the result as the `relations` option to use relational queries:

```typescript
const db = drizzle(connection, { relations });

const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: true,
  },
});
// [{ id: 1, name: 'Alice', posts: [{ id: 1, userId: 1, title: '...' }] }, ...]

const firstPost = await db.query.posts.findFirst({
  with: { author: true },
});
// { id: 1, userId: 1, title: '...', author: { id: 1, name: 'Alice' } }

const recentPosts = await db.query.posts.findMany({
  where: { userId: 1 },
  orderBy: { id: 'desc' },
  limit: 10,
});
```

`findMany()` returns an array and `findFirst()` returns one object or `undefined`. Result keys use the property names from your schema, such as `userId`, not the column names. Nested `with:` relations work. `where` and `orderBy` take objects, as in the drizzle-orm 1.0 relational query API. The driver builds nested rows as DuckDB structs and lists rather than JSON, so nested values decode through their column definitions.

## Schema Organization

### Single File (Small Projects)

```typescript
// schema.ts
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { defineRelations } from 'drizzle-orm';

export const users = pgTable('users', { ... });
export const posts = pgTable('posts', { ... });

export const relations = defineRelations({ users, posts }, (r) => ({ ... }));
```

### Multiple Files (Larger Projects)

```typescript
// schema/users.ts
export const users = pgTable('users', { ... });

// schema/posts.ts
export const posts = pgTable('posts', { ... });

// schema/relations.ts
import { defineRelations } from 'drizzle-orm';
import { users } from './users';
import { posts } from './posts';

export const relations = defineRelations({ users, posts }, (r) => ({ ... }));
```

## Column Name Casing

drizzle-orm 1.0 sets casing on the table definition. Define the table with `snakeCase.table()` or `camelCase.table()` from `drizzle-orm/pg-core` to derive column names from the TypeScript keys, so you can leave out the name argument:

```typescript
import { integer, snakeCase, text } from 'drizzle-orm/pg-core';

const users = snakeCase.table('users', {
  id: integer().primaryKey(),
  userName: text(),
});

const db = drizzle(connection);
await db.insert(users).values({ id: 1, userName: 'ada' });
// insert into "users" ("id", "user_name") values ($1, $2)
```

`snakeCase` and `camelCase` also provide `view`, `materializedView` and `schema`. `pgTableCreator((name) => name, 'snake_case')` works as well. Result keys still use the TypeScript names, such as `userName`. `drizzle()` no longer accepts a `casing` option.

## Custom Schemas

DuckDB's default schema is `main` (not `public` like Postgres):

```typescript
import { pgSchema } from 'drizzle-orm/pg-core';

const analyticsSchema = pgSchema('analytics');

export const events = analyticsSchema.table('events', {
  id: integer('id').primaryKey(),
  type: text('type'),
});
```

## Example: Complete Schema

```typescript
import {
  pgTable,
  integer,
  text,
  doublePrecision,
  boolean,
} from 'drizzle-orm/pg-core';
import { defineRelations } from 'drizzle-orm';
import {
  duckDbJson,
  duckDbList,
  duckDbStruct,
  duckDbTimestamp,
} from '@duckdbfan/drizzle-duckdb';

// Users table
export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  preferences: duckDbJson<{
    theme: 'light' | 'dark';
    notifications: boolean;
  }>('preferences'),
  tags: duckDbList<string>('tags', 'TEXT'),
  createdAt: duckDbTimestamp('created_at', { withTimezone: true }),
});

// Products table
export const products = pgTable('products', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  price: doublePrecision('price').notNull(),
  attributes: duckDbStruct<{
    brand: string;
    category: string;
  }>('attributes', {
    brand: 'TEXT',
    category: 'TEXT',
  }),
  active: boolean('active').default(true),
});

// Orders table
export const orders = pgTable('orders', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  total: doublePrecision('total').notNull(),
  status: text('status').notNull(),
  orderedAt: duckDbTimestamp('ordered_at', { withTimezone: true }),
});

// Relations
export const relations = defineRelations({ users, products, orders }, (r) => ({
  users: {
    orders: r.many.orders({ from: r.users.id, to: r.orders.userId }),
  },
  orders: {
    user: r.one.users({ from: r.orders.userId, to: r.users.id }),
  },
}));
```

## See Also

- [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}): duckDB-specific types
- [Column Types]({{ '/api/columns' | relative_url }}): complete column reference
- [Queries]({{ '/core/queries' | relative_url }}): using your schema
