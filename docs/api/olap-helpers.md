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
