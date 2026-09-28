# Examples

Runnable scripts for `@duckdbfan/drizzle-duckdb`. They import from `../src/index.ts`, so run them from the repository root after `bun install`.

| Script                   | Needs                                         | Run                                         |
| ------------------------ | --------------------------------------------- | ------------------------------------------- |
| `analytics-dashboard.ts` | Nothing                                       | `bun example/analytics-dashboard.ts`        |
| `parquet-analytics.ts`   | Nothing                                       | `bun example/parquet-analytics.ts`          |
| `ducklake-local.ts`      | Nothing (installs the `ducklake` extension)   | `bun example/ducklake-local.ts`             |
| `motherduck-nyc-taxi.ts` | `MOTHERDUCK_TOKEN`                            | `bun example/motherduck-nyc-taxi.ts`        |
| `ducklake-motherduck.ts` | `MOTHERDUCK_TOKEN`, `DUCKLAKE_MOTHERDUCK_DB` | `bun example/ducklake-motherduck.ts`        |

Scripts that write files put them under the OS temp directory.

## MotherDuck NYC taxi

- Get a MotherDuck token (`Profile -> Service Tokens` in the app) and export it as `MOTHERDUCK_TOKEN`.
- From the repository root run `bun example/motherduck-nyc-taxi.ts`.

The script:

- Connects to MotherDuck via `md:` with a `standard` connection pool.
- Reads the built-in `sample_data.nyc.taxi` share (taxi rides from November 2020, attached by default).
- Builds a temporary `taxi_sample` view limited to 100k rows and runs builder and raw SQL queries against it one at a time.
- Runs three queries in parallel against the shared table, because temp views exist only on the connection that created them.
- Closes the pool and instance with `db.close()`.
