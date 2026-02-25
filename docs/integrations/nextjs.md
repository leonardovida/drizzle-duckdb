---
layout: default
title: Next.js
parent: Integrations
nav_order: 1
---

# Next.js Integration

This guide covers how to use `@duckdbfan/drizzle-duckdb` with Next.js applications.

## Configuration

Since `@duckdb/node-api` is a native Node.js module, Next.js requires explicit configuration to handle it correctly during builds.

### Next.js 15+

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@duckdb/node-api'],
};

module.exports = nextConfig;
```

### Next.js 14

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@duckdb/node-api'],
  },
};

module.exports = nextConfig;
```

## Environment Variables

For MotherDuck connections, set your token as a server-side environment variable:

```bash
# .env.local
MOTHERDUCK_TOKEN=your_token_here
```

{: .warning }

> **Important**
>
> Do NOT prefix with `NEXT_PUBLIC_` as this would expose your token to the client bundle.

## Creating a Database Client

### Recommended: Auto-Pooling Pattern

The simplest approach uses connection strings with automatic pooling:

```typescript
// lib/db.ts
import { drizzle, DuckDBDatabase } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema';

let db: Awaited<ReturnType<typeof drizzle<typeof schema>>> | null = null;

export async function getDb() {
  if (!db) {
    const token = process.env.MOTHERDUCK_TOKEN;
    if (token) {
      // MotherDuck with auto-pooling (4 connections by default)
      db = await drizzle({
        connection: {
          path: 'md:',
          options: { motherduck_token: token },
        },
        schema,
      });
    } else {
      // In-memory with auto-pooling
      db = await drizzle(':memory:', { schema });
    }
  }
  return db;
}
```

This automatically creates a connection pool, which is critical for MotherDuck to handle concurrent API requests without serialization.

### Custom Pool Size

For larger MotherDuck instances, increase the pool size:

```typescript
db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: token },
  },
  pool: 'jumbo', // 8 connections (or use { size: 8 })
  schema,
});
```

Available presets: `'pulse'` (4), `'standard'` (6), `'jumbo'` (8), `'mega'` (12), `'giga'` (16).

The `pool` option on `drizzle()` controls size/presets. Use manual pools for timeouts, queue limits, or connection recycling.

### Manual Pool Creation (Advanced)

For more control, create the pool manually:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, createDuckDBConnectionPool } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export async function getDb() {
  if (!db) {
    const token = process.env.MOTHERDUCK_TOKEN;
    const instance = token
      ? await DuckDBInstance.create('md:', { motherduck_token: token })
      : await DuckDBInstance.create(':memory:');
    const pool = createDuckDBConnectionPool(instance, {
      size: 6,
      acquireTimeout: 15_000,
      maxWaitingRequests: 150,
      maxLifetimeMs: 10 * 60_000,
      idleTimeoutMs: 60_000,
    });
    db = drizzle(pool, { schema });
  }
  return db;
}
```

This form lets you set acquire timeouts, queue limits, and connection recycling policies in addition to pool size.

## Usage Examples

### API Routes (Route Handlers)

```typescript
// app/api/users/route.ts
import { getDb } from '@/lib/db';
import { users } from '@/lib/schema';
import { NextResponse } from 'next/server';

export async function GET() {
  const db = await getDb();
  const allUsers = await db.select().from(users);
  return NextResponse.json(allUsers);
}

export async function POST(request: Request) {
  const db = await getDb();
  const body = await request.json();

  const newUser = await db
    .insert(users)
    .values({ name: body.name, email: body.email })
    .returning();

  return NextResponse.json(newUser[0], { status: 201 });
}
```

### Server Components

```typescript
// app/dashboard/page.tsx
import { getDb } from '@/lib/db';
import { analytics } from '@/lib/schema';

export default async function DashboardPage() {
  const db = await getDb();
  const stats = await db.select().from(analytics).limit(10);

  return (
    <div>
      <h1>Dashboard</h1>
      <ul>
        {stats.map((stat) => (
          <li key={stat.id}>{stat.name}: {stat.value}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Server Actions

```typescript
// app/actions.ts
'use server';

import { getDb } from '@/lib/db';
import { users } from '@/lib/schema';
import { revalidatePath } from 'next/cache';

export async function createUser(formData: FormData) {
  const db = await getDb();
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  await db.insert(users).values({ name, email });
  revalidatePath('/users');
}
```

## Runtime Restrictions

### Edge Runtime: Not Supported

`@duckdb/node-api` is a native Node.js module and **cannot** run on the Edge Runtime. If you try to use it in an edge function, you'll see an error like:

```
Native Node.js APIs are not supported in Edge Runtime
```

Ensure your routes using DuckDB are configured for the Node.js runtime:

```typescript
// app/api/data/route.ts
export const runtime = 'nodejs'; // Explicitly use Node.js runtime
```

### Client Components: Not Supported

DuckDB can only be used server-side. Do not attempt to import or use the database client in client components (files with `'use client'`).

For client-side data, fetch from API routes:

```typescript
// components/UserList.tsx
'use client';

import { useEffect, useState } from 'react';

export function UserList() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    fetch('/api/users')
      .then((res) => res.json())
      .then(setUsers);
  }, []);

  return <ul>{users.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

## Troubleshooting

### "Module parse failed" Error

If you see webpack parsing errors for `@duckdb/node-api`:

```
Module parse failed: Unexpected character '...'
```

**Solution**: Add `serverExternalPackages` to your `next.config.js` (see Configuration section above).

### "Native Node.js APIs not supported" Error

This occurs when trying to use DuckDB in Edge Runtime.

**Solution**: Ensure your route uses the Node.js runtime by adding `export const runtime = 'nodejs'` or not specifying edge deployment.

### GLIBCXX Errors on Vercel

You may see errors related to GLIBCXX version compatibility on some Vercel deployment regions:

```
Error: /lib64/libstdc++.so.6: version `GLIBCXX_3.4.26' not found
```

**Solution**: Try deploying to a different Vercel region, or use a Docker-based deployment that includes a compatible runtime.

### Connection Cleanup in Serverless

In serverless environments, connections may not be properly cleaned up between invocations. Consider implementing connection pooling or cleanup logic:

```typescript
// lib/db.ts
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';

export async function withDb<T>(
  callback: (db: ReturnType<typeof drizzle>) => Promise<T>
): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    const db = drizzle(connection);
    return await callback(db);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
```

## Complete Example

**`next.config.js`**:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@duckdb/node-api'],
};
module.exports = nextConfig;
```

**`lib/schema.ts`**:

```typescript
import { pgTable, integer, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});
```

**`lib/db.ts`**:

```typescript
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema';

let db: Awaited<ReturnType<typeof drizzle<typeof schema>>> | null = null;

export async function getDb() {
  if (!db) {
    const token = process.env.MOTHERDUCK_TOKEN;
    if (token) {
      db = await drizzle({
        connection: { path: 'md:', options: { motherduck_token: token } },
        schema,
      });
    } else {
      db = await drizzle(':memory:', { schema });
    }
  }
  return db;
}
```

**`app/api/users/route.ts`**:

```typescript
import { getDb } from '@/lib/db';
import { users } from '@/lib/schema';
import { NextResponse } from 'next/server';

export async function GET() {
  const db = await getDb();
  const result = await db.select().from(users);
  return NextResponse.json(result);
}
```
