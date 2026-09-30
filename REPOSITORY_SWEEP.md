# Repository sweep: correctness, speed, and verification

Reviewed on 30 September 2026 at commit `ed8a80e`, package version 1.7.0.

The main opportunities are to fix silent result loss and integer rounding, make
SQL rewriting more conservative, and compile result mapping once per prepared
query. The initial sweep exposed gaps that the passing suite did not cover.
The implementation below addresses the findings and recommendations. The
original observations and baseline measurements are retained for comparison.

## Implementation and verification

Implemented the eight confirmed fixes, compiled prepared-query result mapping,
chunk-level streaming, direct column conversion, opt-in exact DECIMAL decoding,
and transaction-pinned catalog introspection with batched metadata reads.
Generated nested types include element and field types. Generated MAP helpers
opt into object decoding, while handwritten helpers retain their entry-array
default. Timestamp string mode now has a string output type.

Added pool and native cache counters, paired execution and AST benchmarks,
separate-process RSS measurements, metadata artifacts, uncertainty-aware
regression gating, minimum-version and packed-consumer CI, required DuckLake
integration, PR documentation builds, consistent Bun versions, and compatibility
documentation. Historical benchmark alerts use the correct worsening ratio.

Validation on Node 24.19.0, Bun 1.3.9 and DuckDB node-api 1.5.5-r.5:

- 947 tests passed, 14 optional integration tests skipped. The same suite passed
  with Drizzle 0.40.1, as did source and full workspace TypeScript checking.
- Build and declaration generation passed. Packed-package runtime and consumer
  type checks passed on Node 24 and the declared Node 18.17 minimum, and with
  Drizzle 0.40.1.
  Fresh installs passed earlier in the implementation. A final reinstall
  stalled during dependency resolution, so final tarball runtime and type
  verification reused the installed peer dependencies outside the repository.
  The install step now has a 90-second timeout.
- All 28 benchmarks completed with validation. The comparison against an
  untouched `ed8a80e` checkout measured on the same machine passed the 5% gate
  after accounting for reported relative margins of error.

| Benchmark                     | Base mean, ms | Implemented mean, ms | Throughput change |
| ----------------------------- | ------------: | -------------------: | ----------------: |
| Builder scan, 100,000 rows    |         1,026 |                  209 | +391%, about 4.9x |
| Wide builder rows, 2,000 rows |          31.6 |                  4.8 |             +558% |
| Columnar output, 100,000 rows |           194 |                  144 |              +34% |
| Batch streaming, 100,000 rows |           219 |                  190 |              +15% |

Several small-query point estimates vary across runs. Passing this gate means
no measured drop exceeds the threshold beyond the reported uncertainty, not
that every path became faster. RSS measurements validate identical counts and
checksums and record sampled peaks, which are lower bounds.

Compatibility changes: regenerated BIGINT columns use bigint mode unless
`bigintMode: 'number'` is requested. Regenerated MAP columns use object mode.
Raw SQL join qualification requires `qualifyRawJoinColumns: true` to restore
the old heuristic. `decimalMode: 'string'` preserves exact decimal text, while
explicit Number decoders still produce numbers. Cast relational SQL extras of
unknown type before JSON serialization when exact precision is required.

MotherDuck needs credentials. DuckLake's optional local suite cannot load its
extension here. Ruby/Bundler are unavailable, so the Jekyll build is delegated
to the added PR workflow. Hosted GitHub Actions have not been executed locally.
The extra DuckDB 1.4.4-r.1 run passed workspace typing and 943 tests. Two
optional INET paths initially timed out during extension downloads. Rechecking
the affected files with 60-second download limits passed 144 tests with one
skip. The floor CI job now uses those limits and also checks binding types.

## Initial sweep scope and baseline checks

The review covered the 37 source modules, public exports, driver and connection
lifecycle, pool and transaction paths, prepared caching, migration journals,
value binding and decoding, SQL visitors, introspection and CLI, analytical and
MotherDuck helpers, performance scripts, examples, packaging, CI, and relevant
documentation and regression tests. This was a correctness and performance
review, not an exhaustive vulnerability audit.

Environment: Node 24.19.0, Bun 1.3.9, DuckDB node-api 1.5.5-r.5, Drizzle 0.45.2,
Vitest 4.1.11, and TypeScript 6.0.3. Bun was installed in a temporary tooling
directory because the environment did not provide it.

| Check                                                      | Result                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `bun run test`                                             | 84 files passed, 2 skipped. 930 tests passed, 14 skipped. 28.98 seconds. |
| `bunx tsc --noEmit --project tsconfig.check.json`          | Passed. This config checks source only.                                  |
| `bunx prettier --check .`                                  | Passed before the report was added.                                      |
| `bun run build`                                            | Passed, including declaration generation.                                |
| `npm pack --dry-run --json`                                | Passed. 43 files, approximately 123 KB packed.                           |
| Built package under Node 24                                | Passed: create database, execute `select 42`, close.                     |
| `bun example/analytics-dashboard.ts`                       | Passed.                                                                  |
| `bun run perf:run -- --gha-output <temporary file>`        | Passed. 17 benchmarks recorded.                                          |
| `bunx tsc --noEmit --project tsconfig.json --pretty false` | Failed with 69 diagnostics in tests and benchmarks.                      |

MotherDuck was not exercised because no token was configured. DuckLake's live
integration suite skipped because its extension was unavailable. The advertised
Node 18/20 and Drizzle floor versions were not exercised locally. Neither hosted
GitHub Actions nor the Jekyll documentation build was run.

Evidence and logs are saved in
`/workspace/scratch/drizzle-duckdb-sweep/`. Executable local probes are in
`test/.tmp/sweep/reproduce.ts` and `test/.tmp/sweep/measure.ts`, which are ignored
by Git. The measurement script can be bundled for Node with
`bun build --target=node ./test/.tmp/sweep/measure.ts --outfile=./test/.tmp/sweep/measure.mjs --packages=external`
and run with `node test/.tmp/sweep/measure.mjs`.

## Confirmed correctness and workflow findings

### 1. P1: a matched joined object can become null based on selection order

Location: `src/sql/result-mapper.ts:127` and `src/sql/result-mapper.ts:136`.

With a matched child row `{ id: 1, note: null }`, selecting
`{ child: { note: children.note, id: children.id } }` returns `{ child: null }`.
Selecting `id` first returns the correct object. The first null field marks the
object for nullification, and a later non-null field from the same table never
clears that mark. This silently drops matched data.

Clear the nullification candidate when any qualifying field from the same source
is non-null. Preserve the existing mixed-source rules. Add regression cases for
both field orders, full joins, SQL aliases, and unmatched rows. If every selected
field is nullable and null, distinguishing a match from no match may require a
non-null sentinel. That separate ambiguity should be documented.

### 2. P1: generated BIGINT columns silently lose precision

Location: `src/introspect.ts:1293`.

Introspection emits `bigint("id", { mode: 'number' })` for ordinary BIGINT.
DuckDB returns `9007199254740993n`, but a select through that generated builder
returns `9007199254740992`. The generator uses bigint mode for UBIGINT and
128-bit integers, so its ordinary BIGINT default is inconsistent with its
otherwise precision-preserving mappings.

Generate bigint mode by default, or add an explicit integer-mode option and
make the precision tradeoff visible. Changing the default alters generated
TypeScript types, so it needs a compatibility note. Test minimum and maximum
BIGINT values, values on both sides of the JavaScript safe-integer boundary,
defaults, and read/write round trips.

### 3. P2: raw SQL join qualification can break valid DuckDB SQL

Location: `src/sql/visitors/column-qualifier.ts:151` and `:203`.

Given `a(id, parent_id)` and `b(key)`, this query executes directly in DuckDB:

```sql
select a.id from a join b on a.parent_id = id
```

The driver rewrites its predicate to `a.parent_id = b.id`, which fails because
`b.id` does not exist. The visitor assumes that the unqualified operand belongs
to the opposite source without knowing that source's columns. Token preservation
cannot prove that the chosen qualifier is correct.

Keep driver-generated fields qualified in the query builder. Limit compatibility
rewrites to references whose ownership is known from selection or subquery
metadata, or make heuristic raw SQL qualification opt-in. Test valid joins with
different column names, references to the same source, and multiple sources.

### 4. P2: array_upper rewrites are rejected for parameters and string literals

Locations: `src/sql/visitors/array-bounds.ts:63` and
`src/sql/ast-transformer.ts:178`.

`array_upper(ARRAY[1,2], 1)` works through the driver.
`array_upper(ARRAY['a','b'], 1)` and `array_upper($1, 1)` with a bound list fail
with “Scalar Function with name array_upper does not exist”. The visitor repeats
the array expression in the CASE condition and result. The preservation guard
then rejects the legitimate repeated string or parameter tokens and falls back
to unsupported original SQL.

Use a rewrite that evaluates the expression once, such as
`nullif(array_length(expr), 0)` for the supported first dimension. Verify null,
empty, fixed-size, parameterized, string-valued, and volatile expressions.
Preserve the literal guard rather than broadly relaxing it.

### 5. P2: introspection option precedence contradicts its public contract

Location: `src/introspect.ts:199`, with the same resolution issue in
`src/bin/duckdb-introspect.ts:105`.

`IntrospectOptions` says that an explicit `database` overrides `allDatabases`.
The implementation gives `allDatabases` precedence. Passing
`{ database: 'other', allDatabases: true }` reproduced metadata from both
`memory` and `other`.

Resolve the effective database once and use the same rule in target validation
and introspection. Add programmatic and CLI tests with both options supplied.

### 6. P1: benchmark CI fails even when performance is unchanged

Locations: `.github/workflows/bench.yml:71` and `:85`.

Both steps set `alert-threshold: '5%'` with `fail-on-alert: true`. Inspection of
the referenced action's v1 code confirmed that it divides this number by 100
and compares a worsening ratio against it. An unchanged result has ratio 1,
which exceeds 0.05 and triggers an alert. This is not a five-percent slowdown
setting.

For `customBiggerIsBetter`, a five-percent throughput decrease corresponds to
`100 / 0.95`, or approximately `105.263%`. Choose a ratio deliberately and
account for measurement uncertainty. Several existing benchmarks in this run
had relative margins above five percent, including insert batch at 9.73%.

### 7. P2: the MotherDuck workflow invokes the wrong test runner

Location: `.github/workflows/motherduck-integration.yml:96`.

The workflow uses `bun test test/motherduck.integration.test.ts`, but the file
imports Vitest and the repository explicitly requires Vitest. Bun's test runner
does not execute it through the configured Vitest workflow.

Use `bun run test -- test/motherduck.integration.test.ts` and verify the step
with a configured token. This finding comes from the workflow and test imports.
The credentialed path was not run during this sweep.

### 8. P2: green source checks conceal broken benchmark and test types

Locations: `tsconfig.check.json:3`, `test/perf/setup.ts:11`, and benchmark setup
and teardown calls.

The broader TypeScript check produced 69 diagnostics. The benchmark harness
still imports removed `RewriteArraysMode`, exposes the unused `rewriteArrays`
option, and returns a single/pooled union that callers use without narrowing.
Teardown callers supply `{ connection, db }` rather than the full harness.
Vitest transpiles these files, so successful execution does not establish type
correctness. Other diagnostics include inaccurate mocks, optional close calls,
and query-builder types.

Add separate checking for scripts, examples, benchmarks, and type-facing tests.
Fix the stale harness first, retain the full harness for cleanup, and remove
obsolete rewrite terminology. Extend checking in focused stages rather than
masking failures with casts or suppressions.

## Measured speed opportunities

### Compile field mapping once per prepared query

Locations: `src/session.ts:314`, `src/sql/result-mapper.ts:431`, and
`src/sql/result-mapper.ts:359`.

The existing Vitest benchmark measured a 100,000-row builder scan at 1,050 ms
mean and column-major output at 189 ms mean. A separate Node 24 probe used one
warmup and seven sequential samples over the same five-column dataset:

| Path                                           | Median milliseconds |
| ---------------------------------------------- | ------------------: |
| Native node-api getRowsJS                      |               184.4 |
| Driver array rows                              |               176.2 |
| Driver raw object rows                         |               200.8 |
| Driver select builder                          |             1,034.2 |
| Driver raw streaming                           |               199.5 |
| Driver object streaming                        |               214.1 |
| Current mapper alone over already fetched rows |               680.3 |

The mapper repeatedly resolves decoders, traverses SQL carriers, classifies
column types, and walks result paths for every cell. The fields are stable for
the prepared query. Precompute decoders, normalization functions, destination
paths, and join-nullability metadata once. Keep a flat-row fast path and a
general nested-selection path. Allocate nullification bookkeeping only for
selections that need it.

A simplified flat mapper with pre-resolved decoders took 11.6 ms on the same
rows. It omits general nested, temporal, INET, and join behavior, so that figure
is evidence of avoidable overhead, not a production speedup claim. An optimized
implementation must retain these behaviors and pass the mapper, aliasing,
precision, property-safety, and join regression suites.

### Rechunk streams at chunk boundaries

Location: `src/client.ts:1137` and `:1154`.

Native result chunks are flattened into an async generator of individual rows,
then consumed with `for await` to rebuild chunks. The isolated existing pattern
took 18.8 ms per 100,000 rows under Node. A chunk-level prototype with a
synchronous inner loop took 1.3 ms. The end-to-end improvement will be smaller
because fetching and conversion still dominate streaming latency.

Consume each native chunk once, fill the output batch synchronously, and yield
only completed output batches. Preserve rowsPerChunk, order, early break,
cancellation, connection release, and precision conversion.

### Convert columnar output directly

Location: `src/client.ts:1337`.

The fallback executeArrow path materializes all row arrays and then transposes
them into column arrays. Evaluate direct per-column or per-chunk conversion
instead. Retain duplicate-name handling and per-column precision policy. Measure
peak RSS and heap usage as well as latency, since the main expected benefit is
avoiding an intermediate row matrix. No memory reduction was measured here.

## Make accuracy and performance claims easier to verify

- Add differential tests that execute already valid SQL natively and through
  the driver, then compare rows. Cover rewritten expressions in SELECT, JOIN,
  WHERE, GROUP BY, HAVING, ORDER BY, correlated subqueries, and set operations.
  Include literals and bound parameters. Add field-order invariance tests for
  result mapping and generated-schema integer boundary tests.
- DECIMAL loss in raw, relational, streaming, and aggregate paths is already
  documented in `docs/reference/limitations.md:83`. Consider an opt-in exact
  decimal output policy shared across execution methods. Preserve current
  numeric defaults for compatibility and document that Number-based helpers
  and JavaScript type annotations cannot provide exact financial arithmetic.
- Introspection makes seven sequential metadata calls and does not pin a
  catalog snapshot across them. Evaluate one pinned transaction and fewer
  catalog round trips for remote databases. Do not blindly parallelize metadata
  calls on one node-api connection. Generated schemas also need stronger list,
  map, struct, and timestamp output types where metadata permits them.
- Add same-query cache-on/cache-off benchmarks and single/pooled concurrency
  benchmarks. Current suites all call the harness without options. Their
  “prepared select reuse” case reuses a Drizzle prepared query while native
  prepareCache remains disabled, so it does not measure native cache benefits.
  Add raw-versus-builder, cold-versus-warm AST, precision conversion, and memory
  comparisons with result-count or checksum validation.
- Record runtime, DuckDB and Drizzle versions, CPU, row counts, batch sizes,
  cache settings, and uncertainty with benchmark artifacts. Recheck regressions
  on the same runner or against a same-run base revision. Several documentation
  benchmark numbers lack this context. Millisecond timings cannot demonstrate
  “12x faster memory efficiency” in `docs/reference/performance.md:192`.
- `perf:compare` prints a regression risk but exits zero even for a confirmed
  50% throughput drop. Add an explicit fail-on-regression mode if it is intended
  as a gate. Validate finite positive measurements, duplicate names, missing
  benchmarks, and units before comparing.
- CI covers Node 22/24 and DuckDB minor floors, but not Drizzle 0.40.1 despite
  the peer range and reliance on Drizzle internals. Add a floor-version contract
  job and packed-package consumer type checking. Test the declared minimum Node
  runtime or revise that declaration. Pin Bun consistently across workflows.
- Add a required DuckLake integration job with a prepared extension so failures
  to install or load it cannot silently skip all integration coverage. Build
  documentation on pull requests to catch broken pages before deployment.
- Pool acquire timeouts only bound queued waiting, not connection creation or
  setup, and waiter handoff cancels the queue timer before replacement creation.
  Decide whether this should be an end-to-end deadline or document queue-only
  semantics. Add observability for leases, queue depth, wait duration, connection
  recycling, and cache hits before tuning pool sizes. More connections can
  contend with DuckDB query parallelism, so pool-size increases need measurement.

## Recommended implementation order

1. Fix join nullification, BIGINT generation, unsafe join rewriting, and the
   array_upper guard interaction with focused regression tests.
2. Correct benchmark threshold semantics and the MotherDuck test command.
   Repair benchmark types and establish trustworthy paired baselines.
3. Compile result mapping, then remove per-row async rechunking. Compare on the
   same dataset and runtime, retaining all relevant regression coverage.
4. Add precision options and improve generated types, introspection snapshot
   consistency, compatibility jobs, packed consumer checks, and documentation.

This order addresses silent wrong results first, repairs measurement next, and
then targets the largest measured JavaScript cost.
