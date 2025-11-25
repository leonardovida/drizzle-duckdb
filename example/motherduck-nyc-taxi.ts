/**
 * NYC Taxi Data Example - MotherDuck
 *
 * This example demonstrates drizzle-neo-duckdb with MotherDuck cloud database,
 * querying NYC taxi sample data from MotherDuck's sample_data database.
 *
 * Features demonstrated:
 * - Connecting to MotherDuck cloud database
 * - Drizzle query builder with type-safe schema
 * - Aggregations and groupBy operations
 * - Raw SQL execution with CTEs
 * - Window functions and date operations
 *
 * Prerequisites:
 * - Set MOTHERDUCK_TOKEN environment variable with your MotherDuck token
 *
 * Run with:
 *   MOTHERDUCK_TOKEN=your_token bun run example/motherduck-nyc-taxi.ts
 */

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { drizzle } from '../src/index.ts';
import { sql } from 'drizzle-orm';
import {
  pgTable,
  integer,
  doublePrecision,
  timestamp,
} from 'drizzle-orm/pg-core';

// Define the taxi table schema for type-safe queries
const taxiSample = pgTable('taxi_sample', {
  vendorId: integer('vendorid'),
  pickupTime: timestamp('tpep_pickup_datetime', { withTimezone: false }),
  passengerCount: integer('passenger_count'),
  tripDistance: doublePrecision('trip_distance'),
  totalAmount: doublePrecision('total_amount'),
  tipAmount: doublePrecision('tip_amount'),
});

async function main() {
  const motherDuckToken = process.env.MOTHERDUCK_TOKEN;
  if (!motherDuckToken) {
    console.error('MOTHERDUCK_TOKEN environment variable is required');
    console.error('Usage: MOTHERDUCK_TOKEN=your_token bun run example/motherduck-nyc-taxi.ts');
    process.exit(1);
  }

  console.log('Connecting to MotherDuck...\n');

  // Connect to MotherDuck by passing the token in the config
  const instance = await DuckDBInstance.create('md:', { motherduck_token: motherDuckToken });
  let connection: DuckDBConnection | undefined;

  try {
    connection = await instance.connect();
    const db = drizzle(connection);

    console.log('Connected to MotherDuck!\n');
    console.log('='.repeat(60));
    console.log('NYC TAXI DATA ANALYSIS');
    console.log('='.repeat(60));

    // Create a temp view from the sample data
    // MotherDuck provides sample_data.nyc.taxi with NYC taxi trip records
    console.log('\nCreating temp view from sample_data.nyc.taxi...\n');
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

    // 1. Basic sample of trips using Drizzle query builder
    console.log('1. Sample of taxi trips (using Drizzle query builder):');
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

    console.table(
      trips.map((t) => ({
        pickupTime: t.pickupTime?.toISOString(),
        passengers: t.passengerCount,
        distance: t.tripDistance?.toFixed(2) + ' mi',
        total: '$' + t.totalAmount?.toFixed(2),
        tip: '$' + t.tipAmount?.toFixed(2),
      }))
    );

    // 2. Average tip by passenger count using Drizzle
    console.log('\n2. Average fare and tip by passenger count:');
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

    console.table(
      tipByPassengers.map((row) => ({
        passengers: row.passengers,
        avgFare: '$' + Number(row.avgFare).toFixed(2),
        avgTip: '$' + Number(row.avgTip).toFixed(2),
        tripCount: Number(row.tripCount).toLocaleString(),
      }))
    );

    // 3. Trip distance distribution using CTEs
    console.log('\n3. Trip distance distribution:');
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

    console.table(
      distanceDistribution.map((row: any) => ({
        range: row.distance_range,
        trips: Number(row.trip_count).toLocaleString(),
        avgFare: '$' + Number(row.avg_fare).toFixed(2),
        avgTip: '$' + Number(row.avg_tip).toFixed(2),
      }))
    );

    // 4. Hourly trip patterns using DuckDB date functions
    console.log('\n4. Trips by hour of day:');
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

    console.table(
      hourlyPattern.map((row: any) => ({
        hour: String(Number(row.hour)).padStart(2, '0') + ':00',
        trips: Number(row.trip_count).toLocaleString(),
        avgDistance: Number(row.avg_distance).toFixed(2) + ' mi',
        avgFare: '$' + Number(row.avg_fare).toFixed(2),
      }))
    );

    // 5. Summary statistics with percentiles
    console.log('\n5. Overall summary statistics:');
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

    const stats = summary[0] as any;
    console.log(`  Total trips:     ${Number(stats.total_trips).toLocaleString()}`);
    console.log(`  Total revenue:   $${Number(stats.total_revenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  Average fare:    $${Number(stats.avg_fare).toFixed(2)}`);
    console.log(`  Median fare:     $${Number(stats.median_fare).toFixed(2)}`);
    console.log(`  Average tip:     $${Number(stats.avg_tip).toFixed(2)}`);
    console.log(`  Average distance: ${Number(stats.avg_distance).toFixed(2)} miles`);
    console.log(`  Max fare:        $${Number(stats.max_fare).toFixed(2)}`);

    console.log('\n' + '='.repeat(60));
    console.log('NYC Taxi analysis completed successfully!');
    console.log('='.repeat(60));

  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

main().catch(console.error);
