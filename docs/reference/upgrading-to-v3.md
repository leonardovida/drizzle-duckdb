---
layout: default
title: Upgrading to v3
parent: Reference
nav_order: 7
---

# Upgrading to v3

Version 3.0 removes the APIs that 2.x marked as deprecated, together with internal helpers that the package entry point exported by accident. Most removals surface as TypeScript compile errors. The tables below map each removed name or option to its replacement.

Two removals change runtime behavior for code that compiles:

- Transaction config now rejects instead of logging a warning. See [Transaction config](#transaction-config).
- JavaScript callers that still pass `prepareCache` or `metaParameterName` no longer receive a warning or an error. The driver ignores the unknown option.

## MotherDuck Flight Helpers

The Job helpers and the earlier Flight aliases are removed. Each one called a Flight table function that remains available under its verb-style name.

| Removed              | Replacement              |
| -------------------- | ------------------------ |
| `mdJobs()`           | `mdListFlights()`        |
| `mdCreateJob()`      | `mdCreateFlight()`       |
| `mdGetJob()`         | `mdGetFlight()`          |
| `mdUpdateJob()`      | `mdUpdateFlight()`       |
| `mdDeleteJob()`      | `mdDeleteFlight()`       |
| `mdRunJob()`         | `mdRunFlight()`          |
| `mdCancelJobRun()`   | `mdCancelFlightRun()`    |
| `mdJobRuns()`        | `mdListFlightRuns()`     |
| `mdJobRunLogs()`     | `mdGetFlightLogs()`      |
| `mdJobVersions()`    | `mdListFlightVersions()` |
| `mdGetJobVersion()`  | `mdGetFlightVersion()`   |
| `mdFlights()`        | `mdListFlights()`        |
| `mdFlightRuns()`     | `mdListFlightRuns()`     |
| `mdFlightLogs()`     | `mdGetFlightLogs()`      |
| `mdFlightVersions()` | `mdListFlightVersions()` |

The Job helpers renamed some result columns and returned a subset of them. The Flight helpers return the full Flight result with the Flight column names:

| Job column        | Flight column         |
| ----------------- | --------------------- |
| `job_id`          | `flight_id`           |
| `job_name`        | `flight_name`         |
| `job_version`     | `flight_version`      |
| `version`         | `flight_version`      |
| `md_token_name`   | `access_token_name`   |
| `md_secret_names` | `flight_secret_names` |

The Job option names change in the same way. In `mdCreateFlight()` and `mdUpdateFlight()`, `mdTokenName` becomes `accessTokenName`, `mdSecretNames` becomes `flightSecretNames` and `jobId` becomes `flightId`.

`mdFlightLogs()` and `mdJobRunLogs()` returned a single row with one `logs` column. `mdGetFlightLogs()` returns one row per log line with `line_number`, `reported_at` and `line`, so it is not a drop-in replacement. To rebuild the single text value, aggregate the lines:

```typescript
const [row] = await db.execute<{ logs: string }>(sql`
  select coalesce(string_agg(coalesce(line, ''), chr(10) order by line_number), '') as logs
  from ${mdGetFlightLogs(flightId, runNumber)}
`);
```

The row and option types follow the same mapping:

| Removed type                 | Replacement                     |
| ---------------------------- | ------------------------------- |
| `MotherDuckJobSummaryRow`    | `MotherDuckFlightSummaryRow`    |
| `MotherDuckJobVersionRow`    | `MotherDuckFlightVersionRow`    |
| `MotherDuckJobRunRow`        | `MotherDuckFlightRunRow`        |
| `MotherDuckJobRunLogsRow`    | `MotherDuckFlightLogLineRow`    |
| `MotherDuckFlightLogsRow`    | `MotherDuckFlightLogLineRow`    |
| `MotherDuckJobDeleteRow`     | `MotherDuckFlightDeleteRow`     |
| `MotherDuckJobCancelRunRow`  | `MotherDuckFlightCancelRunRow`  |
| `MotherDuckCreateJobOptions` | `MotherDuckCreateFlightOptions` |
| `MotherDuckUpdateJobOptions` | `MotherDuckUpdateFlightOptions` |

## Prepared Statement Cache

Since 2.5 the driver prepares every query for one run and ignores `prepareCache`. Version 3.0 removes the option and the code behind it. Query results do not change. See [Prepared Statements Are Not Cached]({{ '/reference/performance' | relative_url }}#prepared-statements-are-not-cached).

| Removed                                                                                      | Replacement                                                       |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `prepareCache` option of `drizzle()`                                                         | Removed, no replacement. Delete the option.                       |
| `prepareCache` field of `PgDriverOptions`, `DuckDBSessionOptions` and `ExecuteClientOptions` | Removed, no replacement. Delete the field.                        |
| `PrepareCacheOption` and `PreparedStatementCacheConfig` types                                | Removed, no replacement                                           |
| `resolvePrepareCacheOption()`                                                                | Removed, no replacement                                           |
| `getPreparedStatementCacheStats()`                                                           | Removed, no replacement                                           |
| `prepareCache` parameter of the `DuckDBPreparedQuery` constructor                            | Removed. The parameters that followed it move up by one position. |

## Transaction Config

DuckDB has no `SET TRANSACTION` statement. Version 2.6 ignored transaction config with a one-time warning. Version 3.0 rejects it with `Transaction config is not supported by DuckDB, which has no SET TRANSACTION statement. Remove the config argument (isolationLevel, accessMode, deferrable).`

| Removed or changed                            | Behavior in 3.0                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db.transaction(fn, config)`                  | Rejects before a connection is leased or the transaction begins. The callback does not run. Remove the `config` argument. An empty object `{}` also rejects. |
| `tx.setTransaction(config)`                   | Rejects. `tx.setTransaction()` without config resolves and sends nothing.                                                                                    |
| `DuckDBTransaction.getTransactionConfigSQL()` | Removed, no replacement                                                                                                                                      |

## Other Removals

| Removed                                                                              | Replacement                                                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `DuckDBDialect.resetPgJsonFlag()`, `markPgJsonDetected()`, `assertNoPgJsonColumns()` | Removed, no replacement. Postgres JSON parameters throw while the query is built. |
| `relationsTs` field of the `introspect()` result                                     | Removed, no replacement. The field was never populated.                           |
| `metaParameterName` DuckLake attach option                                           | `metaParameters`, for example `{ type: 'duckdb' }` for `META_TYPE 'duckdb'`       |

## Internal Helpers

The package entry point no longer exports these internal helpers. They were not documented and have no public replacement. Schemas generated by `duckdb-introspect` import only from `@duckdbfan/drizzle-duckdb/helpers` and are not affected.

| Removed                                                                                     | Replacement             |
| ------------------------------------------------------------------------------------------- | ----------------------- |
| `formatLiteral`, `buildListLiteral`, `buildMapLiteral`, `buildStructLiteral`                | Removed, no replacement |
| `coerceArrayString`, `normalizeArrayPredicateValue`                                         | Removed, no replacement |
| `buildDefault`, `normalizeTypeLiteral`, `parseMapKey`, `parseMapValue`, `parseStructFields` | Removed, no replacement |
| `splitTopLevel`, `toIdentifier`, `normalizePositiveInteger`                                 | Removed, no replacement |
| `APPEND_DEFAULT`, `DEFAULT_IMPORT_BASE`                                                     | Removed, no replacement |
