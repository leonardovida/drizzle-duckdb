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
