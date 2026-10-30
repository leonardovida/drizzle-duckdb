---
layout: default
title: MotherDuck
parent: Integrations
nav_order: 2
---

# MotherDuck

[MotherDuck](https://motherduck.com/) is a cloud-hosted DuckDB service that lets you run analytical queries without managing infrastructure.

## Getting Started

### Create an Account

1. Sign up at [motherduck.com](https://motherduck.com/)
2. Generate an API token from your account settings
3. Store the token securely (never commit to version control)

### Connect

The async `drizzle()` entrypoint creates a pool automatically and exposes `db.close()` to clean up:

```typescript
import { drizzle } from '@duckdbfan/drizzle-duckdb';

const db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});

try {
  // Query MotherDuck
} finally {
  await db.close();
}
```

{: .highlight }

If you need to manage the instance and connection directly, use the lower level API:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create('md:', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
const connection = await instance.connect();
const db = drizzle(connection);
```

> **Environment Variables**
>
> Always use environment variables for tokens. Never hardcode credentials.

### Bound the Connection Time

By default the MotherDuck extension sets no overall deadline for opening a connection and keeps retrying network errors. Add `connection_timeout` to the path to fail fast instead, for example in a serverless handler with its own deadline:

```typescript
const db = await drizzle({
  connection: {
    path: 'md:?connection_timeout=30s',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});
```

The value is a DuckDB interval such as `30s` or `2 minutes`. The `MOTHERDUCK_CONNECTION_TIMEOUT` environment variable sets the same option. It bounds the token exchange and the initial attach. A connection that runs out of time throws `Timed out connecting to MotherDuck after <N>ms`. When no MotherDuck server answers, the `Could not connect to MotherDuck` error now includes the underlying gRPC message as `msg: '...'`.

## Connecting to a Specific Database

By default, connecting to `md:` opens your default MotherDuck database. To connect to a specific database:

```typescript
const instance = await DuckDBInstance.create('md:my_database', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
```

`md:my_database` still attaches every database in your workspace. To attach only that database, which shortens startup, add `attach_mode=single`:

```typescript
import { sql } from 'drizzle-orm';

const db = await drizzle({
  connection: {
    path: 'md:my_database?attach_mode=single',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
});

await db.execute(sql`ATTACH 'md:other_database'`);
```

Attach any other database you need with `ATTACH`, as shown. Single attach mode needs the name of a database that already exists, so `md:?attach_mode=single` fails.

Or use the database in your queries:

```typescript
import { sql } from 'drizzle-orm';

// Use a specific database
const results = await db.execute(sql`
  SELECT * FROM my_database.main.users
`);
```

## Querying Sample Data

MotherDuck provides sample datasets. Here's an example querying the NYC taxi dataset:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';

const instance = await DuckDBInstance.create('md:', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
const connection = await instance.connect();
const db = drizzle(connection);

// Query the sample NYC taxi data
const trips = await db.execute(sql`
  SELECT
    pickup_datetime,
    dropoff_datetime,
    passenger_count,
    trip_distance,
    total_amount
  FROM sample_data.nyc.taxi
  WHERE pickup_datetime >= '2019-01-01'
  LIMIT 10
`);

console.log(trips);

connection.closeSync();
```

## Schema Introspection

When introspecting MotherDuck databases, be aware that:

1. **Default behavior**: Only your current database is introspected
2. **Shared databases**: Databases like `sample_data` won't be included unless explicitly requested
3. **Catalogs are not encoded**: Generated tables resolve against the connection's current database. Tables from `--database` or `--all-databases` work only after the connection runs `USE <database>`, so introspect each database into its own file when one app needs several

```bash
# Introspect your specific database
MOTHERDUCK_TOKEN=xxx bunx duckdb-introspect --url md: --database my_db --out ./schema.ts

# Introspect all databases (including shared)
MOTHERDUCK_TOKEN=xxx bunx duckdb-introspect --url md: --all-databases --out ./schema.ts
```

See [Introspection]({{ '/features/introspection' | relative_url }}) for more details.

## Classify Text and Images with Jev

MotherDuck [`prompt_jev`](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/ai-functions/prompt-jev/) classifies text or images. It returns a yes/no probability, a choice, a score, a set of matching labels, or a bounding box. Its question settings must be SQL constants, so use `mdPromptJev` when building a query with Drizzle. The input can be a bound string or a column expression.

Use a `@duckdb/node-api` 1.5.5 or newer client for this function. In live checks, `1.5.5-r.5` and `1.5.6-r.1` resolved `prompt_jev`, while `1.4.4-r.1` did not expose it.

```typescript
import { mdPromptJev } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';

const rows = await db.execute(sql`
  select ${mdPromptJev(sql`message`, {
    instructions: 'Which team should handle this?',
    choice: ['billing', 'technical', 'sales'],
  })} as routing
  from support_messages
`);
```

`mdPromptJev` returns an `SQL` value typed from the options. Raw `db.execute` rows are untyped, so select it through the query builder to keep the type:

```typescript
const routed = await db
  .select({
    id: supportMessages.id,
    routing: mdPromptJev(supportMessages.message, {
      instructions: 'Which team should handle this?',
      choice: ['billing', 'technical', 'sales'],
    }),
  })
  .from(supportMessages);
// routed[0].routing is MotherDuckJevChoiceResult | null
```

The modes are:

| Option                               | Result                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `instructions` alone, or with `noul` | probability that the answer is yes, a `number`                                                           |
| `choice`                             | `{ choice, probabilities, confidence }`                                                                  |
| `score`                              | `{ score, probabilities, confidence }` for ordered criteria                                              |
| `multipleChoice`                     | `{ choices, probabilities }`. Each label is judged on its own, and `choices` holds every label above 0.5 |
| `box`                                | `{ box: { top, bottom, left, right }, confidence }` for a region of an image                             |
| `questions`                          | an object with one result per question                                                                   |

```typescript
const rows = await db.execute(sql`
  select ${mdPromptJev(sql`message`, {
    instructions: 'Which features does this request?',
    multipleChoice: [
      { label: 'sso', description: 'Single sign-on' },
      { label: 'api', description: 'Programmatic access' },
      'billing',
    ],
  })} as features
  from support_messages
`);
```

To classify images, pass a list of named images as the input. Each image is a `Uint8Array` or a SQL expression that yields a BLOB, with an optional `format` of `png`, `jpg` or `jpeg` (MotherDuck assumes `jpg`). Refer to images by name in backticks. `box` locates a region and needs image input:

```typescript
import { readFile } from 'node:fs/promises';

const receipt = await readFile('./receipt.png');
const [row] = await db.execute(sql`
  select
    ${mdPromptJev([{ name: 'receipt', image: receipt, format: 'png' }], {
      instructions: 'Is `receipt` itemized?',
    })} as itemized,
    ${mdPromptJev([{ name: 'receipt', image: receipt, format: 'png' }], {
      box: 'the line items in `receipt`',
    })} as items
`);
```

For one image, pass it without the list. Image bytes or `{ image }` are sent as a bare BLOB that the instructions call `image`. Add `name` or `format` to send a single named image, whose name defaults to `image`. A SQL expression on its own is text input, so wrap a BLOB column as `{ image: column }`:

```typescript
const rows = await db.execute(sql`
  select
    ${mdPromptJev(
      { image: sql`content` },
      { instructions: 'Does `image` show a duck?' }
    )} as duck,
    ${mdPromptJev(
      { name: 'receipt', image: sql`content`, format: 'png' },
      { box: 'the total in `receipt`' }
    )} as total
  from read_blob('receipts/*.png')
`);
```

The single-image forms need a MotherDuck client extension that includes the `prompt_jev` image shorthands. A constant image, such as bytes passed from JavaScript, must be smaller than 4 MiB. Images read from a column or `read_blob()` can be up to 8 MiB. Image rows go to MotherDuck one request at a time, so `batchSize` is not allowed with image input. A row whose images are too large or too small for the model returns `NULL`. For several questions about one input, pass a `questions` object instead of `instructions` and `choice`. Use `type: 'box'` for a region question on image input. The helper renders the object as a constant SQL STRUCT. It throws on an empty `questions` object, missing or empty `instructions`, an empty criteria list, and a `choice` or `score` question without `criteria`. Pass a JSON string when you need the function's JSON escape hatch. See the MotherDuck docs for [availability and AI Unit usage](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/ai-functions/prompt-jev/).

## Generate Text with Prompt

MotherDuck [`prompt`](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/ai-functions/prompt/) calls a language model for each row. Its model and output settings must be SQL constants too, so a plain `${'gpt-5'}` placeholder fails to bind. `mdPrompt` inlines them and keeps the input as a bound value or column:

```typescript
import { mdPrompt } from '@duckdbfan/drizzle-duckdb';

const rows = await db.execute(sql`
  select
    id,
    ${mdPrompt(sql`review`, { model: 'gpt-5-mini', reasoningEffort: 'low' })} as summary,
    ${mdPrompt<{ sentiment: string; stars: number }>(sql`review`, {
      struct: { sentiment: 'VARCHAR', stars: 'INTEGER' },
      structDescr: { sentiment: 'positive, neutral or negative' },
    })} as parsed
  from reviews
`);
```

Use one of `struct`, `jsonSchema` or `returnType` to get structured output, and pass the decoded type as the generic. `temperature` takes a number from 0 to 1 and does not apply to reasoning models such as `gpt-5` and `gpt-6-luna`. `reasoningEffort` defaults to `none` on MotherDuck, and `gpt-6-luna` rejects `minimal`.

## Hybrid Queries

MotherDuck supports hybrid queries that combine local and cloud data:

```typescript
import { sql } from 'drizzle-orm';
import { motherDuckReadParquet } from '@duckdbfan/drizzle-duckdb';

// Attach a local database
await db.execute(sql`ATTACH './local.duckdb' AS local_db`);

// Query across local and cloud
const results = await db.execute(sql`
  SELECT c.name, l.value
  FROM my_cloud_db.main.cloud_table c
  JOIN local_db.main.local_table l ON c.id = l.cloud_id
`);

// Force a supported cloud scan to run remotely
await db.execute(sql`
  select *
  from ${motherDuckReadParquet('s3://bucket/events/*.parquet', {
    mdRun: 'remote',
  })}
`);
```

## Performance Tips

### Use Appropriate Instance Sizes

MotherDuck offers different instance sizes. For large analytical queries, consider upgrading your instance.

### Leverage Caching

MotherDuck caches query results. Repeated queries on the same data will be faster.

### Read Scaling and Session Affinity

MotherDuck can use read scaling tokens to spread reads across replicas. Set a stable `session_name` in your connection options to keep related queries on the same replica. Instance cache TTL determines how long a replica stays warm, so reuse the same `session_name` while you want cache affinity. Older integrations may still pass `session_hint`, but MotherDuck now treats `session_name` as the preferred option.

```typescript
const db = await drizzle({
  connection: {
    path: 'md:',
    options: {
      motherduck_token: process.env.MOTHERDUCK_TOKEN,
      session_name: 'analytics-dashboard',
    },
  },
});
```

### Batch Operations

For writes, batch your operations:

```typescript
// Better: single batch insert
await db.insert(events).values(manyEvents);

// Less efficient: individual inserts
for (const event of manyEvents) {
  await db.insert(events).values(event);
}
```

### Bulk Loading

For large loads, prefer SQL based bulk loading with CTAS or `INSERT INTO`. When loading from cloud storage, keep data in the same region as your MotherDuck instance to reduce latency.

```typescript
import { sql } from 'drizzle-orm';

await db.execute(sql`
  CREATE TABLE events AS
  SELECT * FROM read_parquet('s3://bucket/path/*.parquet')
`);

await db.execute(sql`
  INSERT INTO events
  SELECT * FROM read_csv_auto('s3://bucket/path/*.csv')
`);
```

## Limitations

- **Write throughput**: MotherDuck is optimized for analytical reads. For high-frequency writes, consider local DuckDB.
- **Connection limits**: Be mindful of connection limits in serverless environments.
- **Cold starts**: First query after idle may be slower due to instance spin-up.

## Example: Analytics Dashboard

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';

async function getAnalytics() {
  const instance = await DuckDBInstance.create('md:', {
    motherduck_token: process.env.MOTHERDUCK_TOKEN,
  });
  const connection = await instance.connect();
  const db = drizzle(connection);

  try {
    // Get daily aggregates
    const dailyStats = await db.execute(sql`
      SELECT
        DATE_TRUNC('day', created_at) as date,
        COUNT(*) as count,
        SUM(revenue) as total_revenue
      FROM my_database.main.transactions
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `);

    return dailyStats;
  } finally {
    connection.closeSync();
  }
}
```

## Resources

- [MotherDuck Documentation](https://motherduck.com/docs/)
- [MotherDuck Sample Datasets](https://motherduck.com/docs/getting-started/sample-data/)
- [DuckDB MotherDuck Extension](https://duckdb.org/docs/extensions/motherduck.html)
