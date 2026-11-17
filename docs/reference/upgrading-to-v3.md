---
layout: default
title: Upgrading to v3
parent: Reference
nav_order: 7
---

# Upgrading to v3

Version 3.0 moves the driver to drizzle-orm 1.0 and removes the APIs that 2.x marked as deprecated, together with internal helpers that the package entry point exported by accident. Most removals surface as TypeScript compile errors. The sections below map each removed name or option to its replacement.

These changes affect runtime behavior for code that compiles:

- `drizzle()` throws when it receives the `schema` or `casing` option. See [drizzle-orm 1.0](#drizzle-orm-10).
- `migrate()` throws for a migrations folder in the layout of Drizzle Kit before 1.0. See [Migration folders](#migration-folders).
- A select that reads a column of a table missing from the FROM clause fails in DuckDB. See [Other drizzle-orm 1.0 changes](#other-drizzle-orm-10-changes).
- Transaction config now rejects instead of logging a warning. See [Transaction config](#transaction-config).
- JavaScript callers that still pass `prepareCache` or `metaParameterName` no longer receive a warning or an error. The driver ignores the unknown option.

## drizzle-orm 1.0

Version 3.0 requires drizzle-orm 1.0. The peer range is `>=1.0.0-rc.5 <2.0.0`, and drizzle-orm 0.x is no longer supported. At the time of writing, drizzle-orm 1.0 is a release candidate, and the `latest` tag on npm still installs 0.45. Projects install the release candidate with the `rc` tag, together with the matching Drizzle Kit:

```bash
bun add drizzle-orm@rc
bun add -d drizzle-kit@rc
```

The [drizzle-orm upgrade guide](https://orm.drizzle.team/docs/upgrade-v1) describes the changes in drizzle-orm itself. This section covers the changes that affect code using this driver.

### Relational Queries

`db.query` uses the relational query API of drizzle-orm 1.0. Relations are built with `defineRelations()` and passed as the `relations` option. The `schema` option and the `relations()` helper of drizzle-orm 0.x are no longer accepted, and `drizzle()` throws `The schema option was removed in 3.0 with drizzle-orm 1.0` when it receives `schema`.

Before, with 2.x:

```typescript
import { relations } from 'drizzle-orm';

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

const db = drizzle(connection, { schema });
const rows = await db.query.users.findMany({
  where: (u, { eq }) => eq(u.id, 1),
  with: { posts: true },
});
```

After, with 3.0:

```typescript
import { defineRelations } from 'drizzle-orm';

export const relations = defineRelations({ users, posts }, (r) => ({
  users: {
    posts: r.many.posts({ from: r.users.id, to: r.posts.userId }),
  },
}));

const db = drizzle(connection, { relations });
const rows = await db.query.users.findMany({
  where: { id: 1 },
  with: { posts: true },
});
```

In the 1.0 API, `where` and `orderBy` take objects such as `{ id: 1 }` and `{ id: 'desc' }`, and each entry of `extras` is a function such as ``(t) => sql`...` ``. The drizzle-orm guide [Relational Queries v1 to v2](https://orm.drizzle.team/docs/relations-v1-v2) covers the full syntax.

The driver now builds nested relation rows as DuckDB structs and lists instead of JSON. Nested values decode through their column definitions. A DECIMAL extra inside a nested relation follows `decimalMode` like any other DECIMAL result.

### Column Name Casing

The `casing` option of `drizzle()` is removed, because drizzle-orm 1.0 sets casing on the table definition. `drizzle()` throws `The casing option was removed in 3.0 with drizzle-orm 1.0` when it receives `casing`. Tables are defined with `snakeCase.table()` or `camelCase.table()` from `drizzle-orm/pg-core`, or with `pgTableCreator((name) => name, 'snake_case')`:

```typescript
import { integer, snakeCase, text } from 'drizzle-orm/pg-core';

const users = snakeCase.table('users', {
  id: integer().primaryKey(),
  userName: text(),
});
// userName maps to the user_name column
```

The `casing` option of the `DuckDBDialect` constructor is removed as well.

### Migration Folders

drizzle-orm 1.0 reads the folder layout of Drizzle Kit 1.0, with one `<YYYYMMDDHHMMSS>_<name>/migration.sql` folder per migration. For a folder that still contains `meta/_journal.json`, `migrate()` throws `We detected that you have old drizzle-kit migration folders. You must upgrade drizzle-kit and run "drizzle-kit up"`. Running `drizzle-kit up` with Drizzle Kit 1.0 converts the folder in place.

The tracking table keeps its columns `id`, `hash` and `created_at`, and databases migrated with 2.x need no change. `drizzle-kit up` names each folder after the UTC second of the original journal timestamp. That time is never later than the `created_at` value that 2.x recorded, so `migrate()` does not apply converted migrations a second time. Migrations generated after the conversion are applied as usual.

`drizzle-kit up` requires the `meta/<prefix>_snapshot.json` file of each journal entry. A folder written by hand without snapshots is converted manually. Each `<tag>.sql` file moves to `<timestamp>_<name>/migration.sql`, where `<timestamp>` is the journal `when` of that entry formatted as `YYYYMMDDHHMMSS` in UTC, and the `meta` directory is then removed. The folder timestamp must not be later than the journal `when`. A later timestamp makes `migrate()` apply the migration a second time on databases that 2.x already migrated.

`migrate()` records each migration by the second in its folder name, and the tracking table has a unique index on `created_at`. Two folders with the same timestamp therefore cannot both be applied. `migrate()` fails with a constraint violation and applies neither of them. Folders generated by Drizzle Kit 1.0 carry distinct timestamps. Folders created by hand need timestamps at least one second apart.

### Types and Constructors

| Changed in 3.0                                                                                  | Replacement                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DuckDBDatabase<TSchema>` and `DuckDBDrizzleConfig<TSchema>`                                    | `DuckDBDatabase<TRelations>` and `DuckDBDrizzleConfig<TRelations>`, where `TRelations` is the type of the `defineRelations()` result, for example `typeof relations`       |
| `DuckDBSession` and `DuckDBTransaction` with two schema types                                   | One `TRelations` type parameter                                                                                                                                            |
| `schema` argument of the `DuckDBDatabase`, `DuckDBSession` and `DuckDBTransaction` constructors | The relations object at the same position. `{}` stands for no relations.                                                                                                   |
| `DuckDBPreparedQuery` constructor                                                               | Takes the rendered query, the query mode and a row mapper, following drizzle-orm 1.0. Code that builds prepared queries directly can call `session.prepareQuery()` instead |
| `DuckDBDrizzleConfig` extending all of `DrizzleConfig`                                          | It takes `logger` and `relations` from `DrizzleConfig`. `casing`, `schema` and `cache` are not accepted                                                                    |
| Base classes `PgDatabase`, `PgSession`, `PgTransaction` and `PgPreparedQuery`                   | `PgAsyncDatabase`, `PgAsyncSession`, `PgAsyncTransaction` and `PgAsyncPreparedQuery` from drizzle-orm 1.0                                                                  |
| `rows` type of `appendRows()`                                                                   | `readonly InferInsertModel<TTable>[]`. Accepted rows do not change                                                                                                         |

### Other drizzle-orm 1.0 Changes

- In drizzle-orm 1.0, `.array().array()` on a pg-core column declares one dimension. A two-dimensional array column is declared with `.array('[][]')`.
- A select that reads a column of a table missing from the FROM clause keeps the table qualifier in drizzle-orm 1.0. DuckDB rejects such a query with a binder error that names the table. With 2.x the qualifier was dropped and the column was read from the table in the FROM clause.
- An unnamed `.unique()` column has no generated constraint name in its column metadata. drizzle-orm 1.0 leaves `uniqueName` undefined.
- Query errors from DuckDB are thrown unchanged. They are not wrapped in the `DrizzleQueryError` that other drizzle-orm 1.0 drivers use.
- drizzle-orm query caching through the `cache` option is not supported.

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

| Removed or changed                            | Behavior in 3.0                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.transaction(fn, config)`                  | Rejects before a connection is leased or the transaction begins. The callback does not run. Remove the `config` argument. An object with no option set, such as `{}`, is accepted. |
| `tx.setTransaction(config)`                   | Rejects. `tx.setTransaction()` without config resolves and sends nothing.                                                                                                          |
| `DuckDBTransaction.getTransactionConfigSQL()` | Removed, no replacement                                                                                                                                                            |

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
| `DEFAULT_IMPORT_BASE`                                                                       | Removed, no replacement |
