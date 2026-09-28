---
layout: default
title: Installation
parent: Getting Started
nav_order: 1
---

# Installation

Install Drizzle DuckDB and its peer dependencies, `drizzle-orm` and `@duckdb/node-api`.

{: .warning }

> Install `@duckdbfan/drizzle-duckdb`.

## Package Installation

**Using bun:**

```bash
bun add @duckdbfan/drizzle-duckdb drizzle-orm @duckdb/node-api
```

**Using npm:**

```bash
npm install @duckdbfan/drizzle-duckdb drizzle-orm @duckdb/node-api
```

**Using pnpm:**

```bash
pnpm add @duckdbfan/drizzle-duckdb drizzle-orm @duckdb/node-api
```

**Using yarn:**

```bash
yarn add @duckdbfan/drizzle-duckdb drizzle-orm @duckdb/node-api
```

## Peer Dependencies

- **`drizzle-orm`**: version 0.40.1 or newer, below 0.46.0.
- **`@duckdb/node-api`**: version 1.4.4 or newer, below 1.6.0. The `-r.N` release builds in that range, such as `1.4.4-r.1` and `1.5.5-r.5`, also match. The repository develops and tests against `1.5.5-r.5`.

## Requirements

- **Node.js** 18.17 or newer. Node.js 22 or 24 is recommended.
- **Bun** 1.0 or newer also works.
- Native module support. The DuckDB client does not run in browser or edge environments.

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

- [Quick Start]({{ '/getting-started/quick-start' | relative_url }}): create your first schema and queries
- [Database Connection]({{ '/core/connection' | relative_url }}): connection patterns and options
