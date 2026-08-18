---
layout: default
title: Installation
parent: Getting Started
nav_order: 1
---

# Installation

Install Drizzle DuckDB and its peer dependency.

{: .warning }

> Install `@duckdbfan/drizzle-duckdb`.

## Package Installation

**Using bun:**

```bash
bun add @duckdbfan/drizzle-duckdb @duckdb/node-api
```

**Using npm:**

```bash
npm install @duckdbfan/drizzle-duckdb @duckdb/node-api
```

**Using pnpm:**

```bash
pnpm add @duckdbfan/drizzle-duckdb @duckdb/node-api
```

**Using yarn:**

```bash
yarn add @duckdbfan/drizzle-duckdb @duckdb/node-api
```

Supported client versions include `@duckdb/node-api@1.4.4-r.1` and `@duckdb/node-api@1.5.5-r.4`. The repo now develops against `1.5.5-r.4`, and `1.4.4-r.1` remains supported.

## Requirements

- **Node.js** 18+ or **Bun** 1.0+
- Native module support (not available in browser/edge environments)

## TypeScript Configuration

If using TypeScript, ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true
  }
}
```

## Verify Installation

Create a test file to verify everything works:

```typescript
// test.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';

async function test() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);

  const result = await db.execute(sql`SELECT 'Hello, DuckDB!' as message`);
  console.log(result[0].message); // Hello, DuckDB!

  connection.closeSync();
}

test();
```

Run it:

```bash
bun test.ts
# or
npx tsx test.ts
```

## Optional: Drizzle Kit

For migrations, you can also install Drizzle Kit:

```bash
bun add -d drizzle-kit
```

See [Migrations]({{ '/features/migrations' | relative_url }}) for setup details.

## Next Steps

- [Quick Start]({{ '/getting-started/quick-start' | relative_url }}) - Create your first schema and queries
- [Database Connection]({{ '/core/connection' | relative_url }}) - Connection patterns and options
