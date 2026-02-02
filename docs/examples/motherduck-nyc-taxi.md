---
layout: default
title: NYC Taxi (MotherDuck)
parent: Examples
nav_order: 2
---

# NYC Taxi (MotherDuck) Example

This example demonstrates Drizzle DuckDB with MotherDuck cloud database, querying NYC taxi sample data.

**Source**: [example/motherduck-nyc-taxi.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/motherduck-nyc-taxi.ts)

## Features Demonstrated

- Connecting to MotherDuck cloud database
- Type-safe schema definitions
- Aggregations with GROUP BY
- Common Table Expressions (CTEs)
- DuckDB date/time functions
- Percentile calculations

## Prerequisites

1. [Create a MotherDuck account](https://motherduck.com/)
2. Get your authentication token from the MotherDuck UI
3. Set the environment variable:
   ```bash
   export MOTHERDUCK_TOKEN=your_token_here
   ```

## Connecting to MotherDuck

Use the async `drizzle()` entrypoint for automatic pooling (default pool size: 4). This avoids serializing concurrent requests when hitting MotherDuck from an API or script.

```typescript
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

const motherDuckToken = process.env.MOTHERDUCK_TOKEN;
if (!motherDuckToken) {
  throw new Error('MOTHERDUCK_TOKEN is required');
}

// Auto-pooling connection (size 4 by default)
const db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: motherDuckToken },
  },
  pool: 'standard', // optional preset: pulse(4), standard(6), jumbo(8), mega(12), giga(16)
});
```

Want fine-grained pool control (timeouts, queue limits, recycling)? Build the pool manually:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import {
  createDuckDBConnectionPool,
  drizzle,
} from '@leonardovida-md/drizzle-neo-duckdb';

const instance = await DuckDBInstance.create('md:', {
  motherduck_token: motherDuckToken,
});
const pool = createDuckDBConnectionPool(instance, {
  size: 6,
  acquireTimeout: 15_000,
  maxWaitingRequests: 150,
  maxLifetimeMs: 10 * 60_000,
  idleTimeoutMs: 60_000,
});
const db = drizzle(pool);
```

## Schema Definition

Define a typed schema for the taxi data:

```typescript
import {
  pgTable,
  integer,
  doublePrecision,
  timestamp,
} from 'drizzle-orm/pg-core';

const taxiSample = pgTable('taxi_sample', {
  vendorId: integer('vendorid'),
  pickupTime: timestamp('tpep_pickup_datetime', { withTimezone: false }),
  passengerCount: integer('passenger_count'),
  tripDistance: doublePrecision('trip_distance'),
  totalAmount: doublePrecision('total_amount'),
  tipAmount: doublePrecision('tip_amount'),
});
```

## Creating a View from Sample Data

MotherDuck provides sample datasets. Create a view for efficient querying:

```typescript
// Create temp view from MotherDuck's sample_data.nyc.taxi
await db.execute(sql`
  CREATE OR REPLACE TEMP VIEW taxi_sample AS
  SELECT
    vendorid,
    tpep_pickup_datetime,
    passenger_count,
    trip_distance,
    total_amount,
    tip_amount
  FROM sample_data.nyc.taxi
  LIMIT 100000
`);
```

## Type-Safe Queries

Query using Drizzle's type-safe query builder:

```typescript
// Sample trips with type inference
const trips = await db
  .select({
    pickupTime: taxiSample.pickupTime,
    passengerCount: taxiSample.passengerCount,
    tripDistance: taxiSample.tripDistance,
    totalAmount: taxiSample.totalAmount,
    tipAmount: taxiSample.tipAmount,
  })
  .from(taxiSample)
  .limit(5);

// TypeScript knows the shape of `trips`
trips.forEach((t) => {
  console.log(`${t.passengerCount} passengers, $${t.totalAmount?.toFixed(2)}`);
});
```

## Aggregations with GROUP BY

Calculate statistics by passenger count:

```typescript
import { sql } from 'drizzle-orm';

const tipByPassengers = await db
  .select({
    passengers: taxiSample.passengerCount,
    avgFare: sql<number>`avg(${taxiSample.totalAmount})`,
    avgTip: sql<number>`avg(${taxiSample.tipAmount})`,
    tripCount: sql<number>`count(*)`,
  })
  .from(taxiSample)
  .groupBy(taxiSample.passengerCount)
  .orderBy(sql`avg(${taxiSample.tipAmount}) desc`)
  .limit(10);
```

## CTEs for Complex Analysis

Categorize trip distances using a CTE:

```typescript
const distanceDistribution = await db.execute(sql`
  WITH categorized AS (
    SELECT
      CASE
        WHEN trip_distance < 1 THEN '< 1 mile'
        WHEN trip_distance < 3 THEN '1-3 miles'
        WHEN trip_distance < 5 THEN '3-5 miles'
        WHEN trip_distance < 10 THEN '5-10 miles'
        ELSE '10+ miles'
      END as distance_range,
      CASE
        WHEN trip_distance < 1 THEN 1
        WHEN trip_distance < 3 THEN 2
        WHEN trip_distance < 5 THEN 3
        WHEN trip_distance < 10 THEN 4
        ELSE 5
      END as sort_order,
      total_amount,
      tip_amount
    FROM taxi_sample
  )
  SELECT
    distance_range,
    COUNT(*) as trip_count,
    AVG(total_amount) as avg_fare,
    AVG(tip_amount) as avg_tip
  FROM categorized
  GROUP BY distance_range, sort_order
  ORDER BY sort_order
`);
```

## Date/Time Functions

Analyze trips by hour of day:

```typescript
const hourlyPattern = await db.execute(sql`
  SELECT
    date_part('hour', tpep_pickup_datetime) as hour,
    COUNT(*) as trip_count,
    AVG(trip_distance) as avg_distance,
    AVG(total_amount) as avg_fare
  FROM taxi_sample
  GROUP BY 1
  ORDER BY 1
`);
```

## Percentile Calculations

Calculate summary statistics including median:

```typescript
const summary = await db.execute(sql`
  SELECT
    COUNT(*) as total_trips,
    SUM(total_amount) as total_revenue,
    AVG(total_amount) as avg_fare,
    AVG(tip_amount) as avg_tip,
    AVG(trip_distance) as avg_distance,
    MAX(total_amount) as max_fare,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_amount) as median_fare
  FROM taxi_sample
`);

const stats = summary[0];
console.log(`Median fare: $${stats.median_fare.toFixed(2)}`);
```

## Cleanup

If you used the async `drizzle()` connection-string form, call `db.close()` to clean up the pool and instance. For manual pools/connections, close them directly.

```typescript
await db.close();
```

## Running the Example

```bash
# Set your MotherDuck token
export MOTHERDUCK_TOKEN=your_token_here

# Run the example
bun run example/motherduck-nyc-taxi.ts
```

## Expected Output

```
Connecting to MotherDuck...
Connected to MotherDuck!
============================================================
NYC TAXI DATA ANALYSIS
============================================================

1. Sample of taxi trips (using Drizzle query builder):
┌──────────────────────────────┬────────────┬──────────┬─────────┬─────────┐
│ pickupTime                   │ passengers │ distance │ total   │ tip     │
├──────────────────────────────┼────────────┼──────────┼─────────┼─────────┤
│ 2024-01-15T10:30:00.000Z     │ 2          │ 3.50 mi  │ $18.50  │ $3.70   │
└──────────────────────────────┴────────────┴──────────┴─────────┴─────────┘

2. Average fare and tip by passenger count:
...

5. Overall summary statistics:
  Total trips:     100,000
  Total revenue:   $1,523,456.78
  Average fare:    $15.23
  Median fare:     $12.50
  Average tip:     $2.45
  Average distance: 2.87 miles
  Max fare:        $245.00
```

## Key Takeaways

1. **MotherDuck Connection**: Use `md:` prefix with authentication token
2. **Sample Data**: MotherDuck provides `sample_data.nyc.taxi` for testing
3. **Temp Views**: Create views to limit data and optimize queries
4. **Type Safety**: Schema definitions provide TypeScript inference
5. **DuckDB Functions**: Full access to DuckDB's analytical functions

## See Also

- [MotherDuck Integration]({{ '/integrations/motherduck' | relative_url }}) - Full MotherDuck guide
- [Queries]({{ '/core/queries' | relative_url }}) - Query patterns
- [Configuration]({{ '/reference/configuration' | relative_url }}) - Connection options
