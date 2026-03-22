/**
 * Simple NYC Taxi Example - MotherDuck with Connection Pooling
 *
 * Demonstrates the simplest way to connect to MotherDuck with automatic pooling.
 */
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  integer,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';

const token = process.env.MOTHERDUCK_TOKEN;

if (!token) {
  console.error(
    'Set MOTHERDUCK_TOKEN to a valid MotherDuck service token before running this script.'
  );
  process.exit(1);
}

// Connect with automatic connection pooling
const db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: token },
  },
  pool: 'standard', // 6 connections, optimized for MotherDuck Standard
});

try {
  await db.execute(sql`
    create or replace temp view taxi_sample as
    select
      vendorid,
      tpep_pickup_datetime,
      passenger_count,
      trip_distance,
      total_amount,
      tip_amount
    from sample_data.nyc.taxi
    limit 50000
  `);

  const taxiSample = pgTable('taxi_sample', {
    vendorId: integer('vendorid'),
    pickupTime: timestamp('tpep_pickup_datetime', { withTimezone: false }),
    passengerCount: integer('passenger_count'),
    tripDistance: doublePrecision('trip_distance'),
    totalAmount: doublePrecision('total_amount'),
    tipAmount: doublePrecision('tip_amount'),
  });

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

  console.log('Sample rows from the nyc.taxi share (limited to 5):');
  console.table(trips);

  const tipByPassengers = await db
    .select({
      passengers: taxiSample.passengerCount,
      avgFare: sql<number>`avg(${taxiSample.totalAmount})`,
      avgTip: sql<number>`avg(${taxiSample.tipAmount})`,
    })
    .from(taxiSample)
    .groupBy(taxiSample.passengerCount)
    .orderBy(sql`avg(${taxiSample.tipAmount}) desc`)
    .limit(5);

  console.log('\nAvg fare/tip by passenger count (top 5 groups):');
  console.table(
    tipByPassengers.map((row) => ({
      passengers: row.passengers ?? 0,
      avgFare: Number(row.avgFare?.toFixed?.(2) ?? row.avgFare),
      avgTip: Number(row.avgTip?.toFixed?.(2) ?? row.avgTip),
    }))
  );
} finally {
  // Close the connection pool
  await db.close();
}
