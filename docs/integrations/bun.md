---
layout: default
title: Bun
parent: Integrations
nav_order: 3
---

# Bun

Drizzle DuckDB runs on Bun as well as Node.js. Bun runs TypeScript directly, which suits scripts and local tooling. For production services, Node.js 22 or 24 is the recommended runtime.

## Installation

```bash
bun add @duckdbfan/drizzle-duckdb drizzle-orm @duckdb/node-api
```

## Basic Usage

```typescript
// db.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import * as schema from './schema';

const instance = await DuckDBInstance.create('./app.duckdb');
const connection = await instance.connect();

export const db = drizzle(connection, { schema });
```

Run with:

```bash
bun run db.ts
```

## Why Bun?

### Native TypeScript

No compilation step needed. Bun runs TypeScript directly:

```bash
bun run src/index.ts
```

### Fast Startup

Bun starts quickly, which suits scripts and serverless:

```bash
# Run migrations
bun run scripts/migrate.ts

# Run introspection
bun run scripts/introspect.ts
```

### Native Module Support

`@duckdb/node-api` is a native Node.js addon, and Bun loads it. One difference: under Bun, `duckDbTimestamp` columns send values as SQL literals instead of native timestamp bindings, because Bun and Node.js handle bigint values differently in the DuckDB bindings. See [Limitations]({{ '/reference/limitations' | relative_url }}#timestamps).

## Project Setup

### package.json

```json
{
  "name": "my-duckdb-app",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "db:migrate": "bun run scripts/migrate.ts",
    "db:introspect": "bun run scripts/introspect.ts"
  },
  "dependencies": {
    "@duckdb/node-api": "1.5.5-r.5",
    "@duckdbfan/drizzle-duckdb": "^1.7.0",
    "drizzle-orm": "^0.45.2"
  },
  "devDependencies": {
    "@types/bun": "^1.4.2",
    "drizzle-kit": "^0.31.11"
  }
}
```

`bun add` writes the current versions for you. Keep `drizzle-orm` at 0.40.1 or newer and below 0.46.0, and `@duckdb/node-api` at 1.4.4 or newer and below 1.6.0. See [Installation]({{ '/getting-started/installation' | relative_url }}#peer-dependencies).

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun"]
  }
}
```

## Scripts

### Migration Script

```typescript
// scripts/migrate.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, migrate } from '@duckdbfan/drizzle-duckdb';

async function main() {
  const instance = await DuckDBInstance.create('./app.duckdb');
  const connection = await instance.connect();
  const db = drizzle(connection);

  console.log('Running migrations...');
  await migrate(db, './drizzle');
  console.log('Done!');

  connection.closeSync();
}

main().catch(console.error);
```

### Introspection Script

```typescript
// scripts/introspect.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle, introspect } from '@duckdbfan/drizzle-duckdb';
import { writeFileSync } from 'fs';

async function main() {
  const instance = await DuckDBInstance.create('./app.duckdb');
  const connection = await instance.connect();
  const db = drizzle(connection);

  const result = await introspect(db);
  writeFileSync('./src/db/schema.ts', result.files.schemaTs);

  console.log('Schema written to ./src/db/schema.ts');

  connection.closeSync();
}

main().catch(console.error);
```

## Testing with Bun

Bun has a built-in test runner:

```typescript
// tests/db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';

let instance: DuckDBInstance;
let connection: any;
let db: any;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);

  await db.execute(sql`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
});

afterAll(() => {
  connection.closeSync();
});

describe('database', () => {
  it('should insert and query users', async () => {
    await db.execute(sql`INSERT INTO users VALUES (1, 'Alice')`);
    const result = await db.execute(sql`SELECT * FROM users`);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Alice');
  });
});
```

Run tests:

```bash
bun test
```

## Environment Variables

Bun loads `.env` files automatically:

```bash
# .env
MOTHERDUCK_TOKEN=your_token_here
DATABASE_PATH=./data/app.duckdb
```

```typescript
const token = process.env.MOTHERDUCK_TOKEN; // Available without dotenv
```

## Watch Mode

For development, use watch mode:

```bash
bun run --watch src/index.ts
```

## Production

Build for production (optional):

```bash
bun build src/index.ts --outdir ./dist --target node
```

Or run directly in production:

```bash
NODE_ENV=production bun run src/index.ts
```

## See Also

- [Installation]({{ '/getting-started/installation' | relative_url }}): package setup
- [Quick Start]({{ '/getting-started/quick-start' | relative_url }}): first application
- [Examples]({{ '/examples/' | relative_url }}): complete examples
