# Examples

Runnable scripts for `@duckdbfan/drizzle-duckdb`. They import from `../src/index.ts`, so run them from the repository root after `bun install`.

| Script                   | Needs                                         | Run                                         |
| ------------------------ | --------------------------------------------- | ------------------------------------------- |
| `analytics-dashboard.ts` | Nothing                                       | `bun example/analytics-dashboard.ts`        |
| `parquet-analytics.ts`   | Nothing                                       | `bun example/parquet-analytics.ts`          |
| `parquet-reconciliation-regions.ts` | Nothing | `bun example/parquet-reconciliation-regions.ts` |
| `ducklake-local.ts`      | Nothing (installs the `ducklake` extension)   | `bun example/ducklake-local.ts`             |
| `motherduck-nyc-taxi.ts` | `MOTHERDUCK_TOKEN`                            | `bun example/motherduck-nyc-taxi.ts`        |
| `ducklake-motherduck.ts` | `MOTHERDUCK_TOKEN`, `DUCKLAKE_MOTHERDUCK_DB` | `bun example/ducklake-motherduck.ts`        |
| `motherduck-read-scaling.ts` | `MOTHERDUCK_TOKEN`, optional `MOTHERDUCK_READ_SCALING_TOKEN` | `bun example/motherduck-read-scaling.ts` |
| `motherduck-concurrent-writers.ts` | `MOTHERDUCK_TOKEN` | `bun example/motherduck-concurrent-writers.ts` |
| `motherduck-multi-tenant.ts` | `MOTHERDUCK_TOKEN`, optional `MOTHERDUCK_TENANT_TOKENS` | `bun example/motherduck-multi-tenant.ts` |

Scripts that write files put them under the OS temp directory. The MotherDuck read scaling and concurrent writers examples use the `drizzle_examples` database, or the one named in `MOTHERDUCK_EXAMPLE_DB`, and replace only their own tables. The multi-tenant example creates `drizzle_examples_tenant_*` databases and drops them when it finishes.

## MotherDuck NYC taxi

- Get a MotherDuck token (`Profile -> Service Tokens` in the app) and export it as `MOTHERDUCK_TOKEN`.
- From the repository root run `bun example/motherduck-nyc-taxi.ts`.

The script:

- Connects to MotherDuck via `md:` with a `standard` connection pool.
- Reads the built-in `sample_data.nyc.taxi` share (taxi rides from November 2020, attached by default).
- Builds a temporary `taxi_sample` view limited to 100k rows and runs builder and raw SQL queries against it one at a time.
- Runs three queries in parallel against the shared table, because temp views exist only on the connection that created them.
- Closes the pool and instance with `db.close()`.

## MotherDuck read scaling

A dashboard backend for many concurrent users. A writer seeds 2 million orders with a read/write token. Readers use `MOTHERDUCK_READ_SCALING_TOKEN` when it is set, and a router pins each user to one of four replica slots through `session_name`. Each slot has a bounded pool, and the script prints latency and queue statistics per slot. It ends with read after write through `CREATE SNAPSHOT OF` and `REFRESH DATABASE`.

## MotherDuck concurrent writers

Four write patterns on one database: batched ingestion from eight producers, concurrent appends, conflicting updates retried with backoff, and idempotent upserts from two services that share the writer account.

## MotherDuck multi-tenant

One database per tenant, migrated with the Drizzle migrations in `migrations/tenant`. A tenant registry opens tenant connections on demand with `attach_mode=single` and `saas_mode=true` and closes idle tenants. Set `MOTHERDUCK_TENANT_TOKENS` to connect each tenant with its own service account token.
