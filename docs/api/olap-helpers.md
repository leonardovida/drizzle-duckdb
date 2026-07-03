---
layout: default
title: OLAP Helpers
parent: API
nav_order: 7
---

# OLAP Helpers

Utilities to keep aggregates and window logic inside DuckDB while returning JS-friendly types.

## Numeric aggregates as numbers

DuckDB returns DECIMAL aggregates as strings. Use the numeric helpers to coerce to `number` when that's acceptable:

```typescript
import { sumN, avgN, countN, sumDistinctN } from '@duckdbfan/drizzle-duckdb';

await db
  .select({
    total: sumN(orders.total),
    average: avgN(orders.total),
    ordersCount: countN(),
    distinctTotal: sumDistinctN(orders.total),
  })
  .from(orders);
```

## Percentiles and median

```typescript
import { percentileCont, median } from '@duckdbfan/drizzle-duckdb';

await db
  .select({
    p90: percentileCont(0.9, orders.total),
    med: median(orders.total),
  })
  .from(orders);
```

## Window functions

```typescript
import {
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
} from '@duckdbfan/drizzle-duckdb';

await db
  .select({
    id: orders.id,
    rn: rowNumber({ orderBy: orders.createdAt }),
    prevTotal: lag<number>(orders.total, 1, sql`0`, {
      orderBy: orders.createdAt,
    }),
  })
  .from(orders)
  .orderBy(orders.createdAt);
```

## any_value for non-aggregated selections

```typescript
import { anyValue, sumN } from '@duckdbfan/drizzle-duckdb';

await db
  .select({
    region: orders.region,
    sampleCustomer: anyValue(orders.customerId),
    revenue: sumN(orders.total),
  })
  .from(orders)
  .groupBy(orders.region);
```

## MotherDuck Lance search

MotherDuck exposes Lance table functions for vector, full-text, and hybrid search. The helpers parameterize positional arguments and expose the remote-only named options added by MotherDuck:

```typescript
import {
  lanceVectorSearch,
  lanceFts,
  lanceHybridSearch,
} from '@duckdbfan/drizzle-duckdb';

await db.execute(sql`
  select *
  from ${lanceVectorSearch('documents', 'embedding', [0.1, 0.2, 0.3], {
    k: 10,
    useIndex: true,
    nprobs: 20,
    refineFactor: 4,
    prefilter: true,
  })}
`);

await db.execute(sql`
  select *
  from ${lanceFts('documents', 'body', 'duckdb', {
    k: 10,
    prefilter: true,
  })}
`);

await db.execute(sql`
  select *
  from ${lanceHybridSearch(
    'documents',
    'embedding',
    [0.1, 0.2, 0.3],
    'body',
    'duckdb',
    {
      k: 10,
      alpha: 0.7,
      oversampleFactor: 8,
      useIndex: true,
    }
  )}
`);
```

## MotherDuck scan execution overrides

MotherDuck supports `md_run` on file scan functions so you can force supported scans to execute locally, remotely, or leave the optimizer on automatic placement. Use the whitelisted helper when you want Drizzle to parameterize paths and option values:

```typescript
import { motherDuckReadParquet } from '@duckdbfan/drizzle-duckdb';

await db.execute(sql`
  select *
  from ${motherDuckReadParquet('s3://bucket/events/*.parquet', {
    mdRun: 'remote',
    named: {
      hive_partitioning: true,
      filename: false,
    },
  })}
`);
```

For other supported scan functions, use `motherDuckTableFunction`:

```typescript
import { motherDuckTableFunction } from '@duckdbfan/drizzle-duckdb';

await db.execute(sql`
  select *
  from ${motherDuckTableFunction('delta_scan', ['s3://bucket/delta'], {
    mdRun: 'remote',
  })}
`);
```

## MotherDuck metadata table functions

Use `mdAccessTokens()` and the Dives helpers when querying the matching
MotherDuck table functions through Drizzle SQL templates:

```typescript
import {
  mdAccessTokens,
  mdCreateDive,
  mdGetDive,
  mdListDives,
  mdListDiveVersions,
} from '@duckdbfan/drizzle-duckdb';

const tokens = await db.execute(sql`
  select token_name, token_type, created_ts, expire_at
  from ${mdAccessTokens()}
  order by token_name
`);

const activeTokens = await db.execute(sql`
  select token_name, token_type
  from ${mdAccessTokens({ activeOnly: true })}
`);

const divesWithResources = await db.execute(sql`
  select id, title, owner_name, updated_at, required_resources
  from ${mdListDives({ limit: 25, includeOrgShares: true })}
  where len(required_resources) > 0
`);

const [dive] = await db.execute(sql`
  select id, title, current_version
  from ${mdCreateDive({
    title: 'Revenue Trends',
    content: 'export default function Dive() { return null }',
    description: 'Monthly revenue dashboard',
  })}
`);

const [diveContent] = await db.execute(sql`
  select title, content
  from ${mdGetDive(String(dive.id))}
`);

const versions = await db.execute(sql`
  select version, description, created_at
  from ${mdListDiveVersions(String(dive.id), { limit: 5 })}
`);
```

`mdAccessTokens({ activeOnly: true })` filters out rows whose `expire_at` is in
the past. `mdListDives()` accepts pagination plus `includeOrgShares` for Dives
shared with the organization. The Dives helper family covers listing, reading,
creating, updating metadata or content, deleting, listing versions, and reading
a specific version. `mdListDives()`, `mdListDiveVersions()`, and
`mdGetDiveVersion()` include `required_resources` on supported MotherDuck
deployments. The column is a list of structs with `name`, `alias`, `url`, `id`,
and `resource_type` fields.

## MotherDuck Flight table functions

Use the Flight helper functions when creating, listing, updating, running, or
inspecting MotherDuck Flights through Drizzle SQL templates:

```typescript
import {
  mdAccessTokens,
  mdCreateFlight,
  mdFlightRuns,
  mdFlights,
} from '@duckdbfan/drizzle-duckdb';

const flights = await db.execute(sql`
  select flight_id, flight_name, current_version
  from ${mdFlights({ limit: 25 })}
`);

const activeTokens = await db.execute(sql`
  select token_name, token_type
  from ${mdAccessTokens({ activeOnly: true })}
`);

const [flight] = await db.execute(sql`
  select flight_id, status
  from ${mdCreateFlight({
    name: 'daily-refresh',
    accessTokenName: 'pipeline_token',
    sourceCode: 'print("hello")',
    scheduleCron: '0 0 * * *',
  })}
`);

const runs = await db.execute(sql`
  select run_number, status, created_at
  from ${mdFlightRuns(String(flight.flight_id))}
`);
```

The older Job helper names are still exported for older MotherDuck deployments,
but new code should use the Flight helpers.
For optional Flight fields, `undefined` omits the named parameter and `null`
emits an explicit SQL `NULL`. MotherDuck treats explicit `NULL` values as clear
or empty values for nullable Flight options such as `requirementsTxt`, `config`,
and `flightSecretNames`.

`config` entries are exposed to Flight code as environment variables using the
config key. Config keys must not be empty and cannot contain `=` or NULL bytes;
config values cannot contain NULL bytes. `flightSecretNames` references
MotherDuck `TYPE flights` secrets; each secret param is exposed as
`<SECRET_NAME>_<KEY>`, so a secret named `api_secret` with param `API_KEY`
becomes `API_SECRET_API_KEY`.

## OLAP builder (grouped measures)

```typescript
import { olap, sumN } from '@duckdbfan/drizzle-duckdb';

const query = olap(db)
  .from(orders)
  .groupBy([orders.region])
  .selectNonAggregates(
    { sampleCustomer: orders.customerId },
    { anyValue: true }
  )
  .measures({
    units: sumN(orders.quantity),
    revenue: sumN(orders.total),
  })
  .orderBy(orders.region);

const rows = await query.run();
```
