---
layout: default
title: OLAP Helpers
parent: API Reference
nav_order: 7
---

# OLAP Helpers

Utilities to keep aggregates and window logic inside DuckDB while returning JS-friendly types.

## Numeric aggregates as numbers

Drizzle's `sum()` and `avg()` return strings. A raw ``sql`count(*)` `` or integer ``sql`sum(...)` `` returns a `bigint`, because DuckDB computes it as `BIGINT` or `HUGEINT`. The numeric helpers map the result to a JavaScript `number` when that's acceptable:

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

The options take `partitionBy` and `orderBy`, each a column or SQL expression or an array of them. Without options the helpers emit an empty window, for example `row_number() over ()`.

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
a specific version. `mdUpdateDiveStatus({ id, status, version })` sets a
Dive's governance status to `draft`, `ready`, `endorsed` or `archived`, and
summary rows from `mdListDives()` and `mdGetDive()` carry `status`,
`status_changed_at`, `status_set_by` and `status_applies_to_version`.
`mdCreateDive()` and `mdUpdateDiveContent()` accept `requiredResources` as a
list of `{ url, alias }` objects for the shares or databases a Dive reads. An
empty list is sent as a typed empty list. `mdListDives()`, `mdListDiveVersions()`, and
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
  mdGetFlightLogs,
  mdGetFlightRun,
  mdListFlightRuns,
  mdListFlights,
} from '@duckdbfan/drizzle-duckdb';

const flights = await db.execute(sql`
  select flight_id, flight_name, current_version
  from ${mdListFlights({ limit: 25 })}
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
    maxRuntimeSec: 1_800,
  })}
`);

const runs = await db.execute(sql`
  select run_number, status, created_at
  from ${mdListFlightRuns(String(flight.flight_id))}
`);

const [run] = await db.execute(sql`
  select run_number, status, created_at, ended_at
  from ${mdGetFlightRun(String(flight.flight_id), 1)}
`);

const latestLogs = await db.execute(sql`
  select line_number, reported_at, line
  from ${mdGetFlightLogs(String(flight.flight_id), 1, {
    limit: 100,
    order: 'desc',
  })}
`);
```

The older Job helper names remain exported as deprecated compatibility aliases.
They call the supported Flight table functions and preserve the older `job_*`
result column names where the Flight result uses `flight_*`. The earlier
`mdFlights()`, `mdFlightRuns()`, `mdFlightLogs()`, and `mdFlightVersions()`
TypeScript helper names remain as deprecated aliases too. New code should use
the verb-style Flight helpers.
`mdGetFlightRun()` fetches one run by Flight ID and run number. Run rows from
`mdRunFlight()`, `mdListFlightRuns()` and `mdGetFlightRun()` include
`started_by_id` and `started_by_name`, which are `NULL` for scheduled runs.
`mdGetFlightLogs()` returns line-oriented logs and accepts `limit`, `offset`,
and `order: 'asc' | 'desc'` for pagination from either end of the log.
For optional Flight fields, `undefined` omits the named parameter and `null`
emits an explicit SQL `NULL`. MotherDuck treats explicit `NULL` values as clear
or empty values for nullable Flight options such as `requirementsTxt`, `config`,
and `flightSecretNames`. An empty `config: {}` is sent as a typed empty map and
an empty `flightSecretNames: []` as a typed empty `VARCHAR[]` list.
The deprecated `mdFlightLogs()` and `mdJobRunLogs()` blobs join lines in
`line_number` order, descending when `order` is `'desc'`.
Use `maxRuntimeSec` on `mdCreateFlight()` or `mdUpdateFlight()` to cap each run
in seconds. Set it to `0` for no timeout, or omit it to use the plan default.
Use `instanceType` (`'F4'`, `'F8'`, `'F16'` or `'F32'`) to pick the Flight
size. Each plan offers a subset and uses its own default when you omit it.
Changing the size with `mdUpdateFlight()` creates a new version, and version
rows from `mdListFlightVersions()` and `mdGetFlightVersion()` report it as
`instance_type`. Summary rows include `owner_name`, and
`mdListFlights({ ownerOnly: true })` lists only the Flights you own.
`mdRunFlight()` also starts a Flight another user owns when they gave you run
access. The run uses the owner's settings, secrets and token, and `config` can
only override keys the Flight already defines. `mdListFlights()` does not list
Flights you can only run, so pass the Flight ID the owner shared. With run
access alone, `mdGetFlightRun()` reads the runs you started and reports other
runs as not found. `mdListFlightRuns()` refuses callers who are neither the
owner nor an organization admin, and `mdGetFlightLogs()` stays limited to them.

### Flight charts and grants

`mdCreateFlight()` and `mdUpdateFlight()` accept `metadata: { chart }`, for
example Mermaid flowchart source that describes the Flight's steps. On update,
an empty string clears the chart and `chart: null` leaves it unchanged.
`chart` is the only metadata key MotherDuck accepts, and the helper throws on
any other key. `mdGetFlightVersion()` returns the version's chart in a
`metadata` MAP column. `db.execute` returns MAP values as key and value
entries, so select `metadata['chart']` to read it as a string.
`mdListFlightVersions()` does not return `metadata`.

```typescript
import {
  mdGetFlightVersion,
  mdListFlightGrantees,
  mdUpdateFlight,
} from '@duckdbfan/drizzle-duckdb';

await db.execute(sql`
  select current_version
  from ${mdUpdateFlight({
    flightId,
    metadata: { chart: 'flowchart TD\n  extract[Extract] --> load[Load]' },
  })}
`);

const [version] = await db.execute<{ chart: string | null }>(sql`
  select metadata['chart'] as chart
  from ${mdGetFlightVersion(flightId, 2)}
`);

const grantees = await db.execute(sql`
  select grantee_name, grantee_type, privilege
  from ${mdListFlightGrantees(flightId)}
`);
```

`mdListFlightGrantees(flightId)` calls `md_list_flight_grantees`, the table
function behind `SHOW GRANTS ON FLIGHT`, and casts the ID to `UUID`. Rows match
`MotherDuckFlightGranteeRow`: `grantee_name`, `grantee_type` (`user`, `role`
or `organization`) and `privilege` (`run`). `grantee_name` is `NULL` when the
caller may read the Flight but not manage its grants. Grant and revoke access
with the `GRANT RUN ON FLIGHT '<id>' TO USER <name>, ROLE <name>, ORGANIZATION`
and `REVOKE RUN ON FLIGHT '<id>' FROM ...` statements.

## MotherDuck files and session identity

`mdListFiles(path, { limit })` lists one level of an `s3://` or `azure://`
path with your MotherDuck secrets. Rows have `name`, `type` (`file` or
`folder`), `size` and `last_modified`.

MotherDuck exposes the session's identity as SQL scalars. Use them to scope
queries to the caller:

```typescript
import {
  mdCurrentEmail,
  mdIsRoleInSession,
  mdSessionRoles,
} from '@duckdbfan/drizzle-duckdb';

const [me] = await db.execute(sql`
  select
    ${mdCurrentEmail()} as email,
    ${mdSessionRoles()} as roles,
    ${mdIsRoleInSession(['admin', 'analyst'])} as can_view
`);
```

`mdCurrentEmail()` returns `NULL` for service accounts. `mdIsRoleInSession()`
matches case-insensitively, follows the role hierarchy and returns `true` when
any listed role is held.

The role introspection table functions return the rows of the `SHOW` role
statements from a `SELECT`, so they can be filtered, joined and run by
read-only callers:

```typescript
import {
  mdListRoleMembers,
  mdListRoles,
  mdListRolesGrantedToRole,
  mdListRolesGrantedToUser,
} from '@duckdbfan/drizzle-duckdb';

const [member] = await db.execute<{ member_name: string }>(sql`
  select member_name
  from ${mdListRoleMembers('explorer')}
  where member_type = 'user' and email = ${'alice@example.com'}
`);
```

| Helper                           | Rows                                                                 | Matching statement                         |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `mdListRoles()`                  | `MotherDuckRoleRow`: every role in the organization                  | `SHOW ALL ROLES`                           |
| `mdListRoleMembers(role)`        | `MotherDuckRoleMemberRow`: direct members, users then roles          | `SHOW USERS OF ROLE`, `SHOW ROLES OF ROLE` |
| `mdListRolesGrantedToUser(user)` | `MotherDuckGrantedRoleRow`: roles held directly or through hierarchy | `SHOW ROLES TO USER`                       |
| `mdListRolesGrantedToRole(role)` | `MotherDuckGrantedRoleRow`: roles a role inherits                    | `SHOW ROLES TO ROLE`                       |

Member rows set `email` and `is_service_account` to `NULL` for a role member
and `role_type` to `NULL` for a user member. Granted role rows mark direct
grants with `is_direct` and leave `granted_at` `NULL` for inherited roles.
MotherDuck refuses `NULL` arguments and roles that do not exist. Listing
members of a role or the roles of a role needs a full-scope token, and users
who are not admins see only roles within their own role hierarchy.
`mdSessionRoles()` and `mdIsRoleInSession()` are unchanged and remain the way to
check the current session's roles.

`config` entries are exposed to Flight code as environment variables using the
config key. Config keys must not be empty, cannot contain `=` or NULL bytes, and
cannot use reserved runtime names such as `MOTHERDUCK_TOKEN` or
`MOTHERDUCK_FLIGHTS_RUN`. Config values cannot contain NULL bytes.
`flightSecretNames` references MotherDuck `TYPE flights` secrets. Each secret
param is exposed as `<SECRET_NAME>_<KEY>`, so a secret named `api_secret` with
param `API_KEY` becomes `API_SECRET_API_KEY`.

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
