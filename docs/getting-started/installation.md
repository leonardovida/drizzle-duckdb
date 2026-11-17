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

Version 3 is a release candidate published under the `next` tag. It requires drizzle-orm 1.0, which is also a release candidate. A plain install without `@next` selects version 2.6, which works with drizzle-orm 0.40.1 to 0.45 and is documented on the [`2.x` branch](https://github.com/leonardovida/drizzle-duckdb/tree/2.x).

## Package Installation

**Using bun:**

```bash
bun add @duckdbfan/drizzle-duckdb@next drizzle-orm@rc @duckdb/node-api
```

**Using npm:**

```bash
npm install @duckdbfan/drizzle-duckdb@next drizzle-orm@rc @duckdb/node-api
```

**Using pnpm:**

```bash
pnpm add @duckdbfan/drizzle-duckdb@next drizzle-orm@rc @duckdb/node-api
```

**Using yarn:**

```bash
yarn add @duckdbfan/drizzle-duckdb@next drizzle-orm@rc @duckdb/node-api
```

## Peer Dependencies

- **`drizzle-orm`**: version 1.0.0-rc.5 or a later release candidate, or a 1.x release from 1.0.0. npm snapshot builds such as `1.0.0-rc.4-5d5b77c` are outside the range. drizzle-orm 1.0 is a release candidate at the time of writing, and the `latest` tag on npm still installs 0.45. Install it with the `rc` tag, as in `drizzle-orm@rc`.
- **`@duckdb/node-api`**: version 1.4.4 or newer, below 1.6.0. The `-r.N` release builds in that range, such as `1.4.4-r.1` and `1.5.6-r.2`, also match. The repository develops and tests against `1.5.6-r.2`.

## Requirements

- **Node.js** 22 or newer.
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
bun add -d drizzle-kit@rc
```

See [Migrations]({{ '/features/migrations' | relative_url }}) for setup details.

## Next Steps

- [Quick Start]({{ '/getting-started/quick-start' | relative_url }}): create your first schema and queries
- [Database Connection]({{ '/core/connection' | relative_url }}): connection patterns and options
