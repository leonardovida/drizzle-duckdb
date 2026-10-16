import { sql } from 'drizzle-orm';
import { expect, expectTypeOf, test } from 'vitest';
import {
  mdAccessTokens,
  mdCancelFlightRun,
  mdCancelJobRun,
  mdCreateDive,
  mdCreateFlight,
  mdCreateJob,
  mdDeleteDive,
  mdDeleteFlight,
  mdDeleteJob,
  mdFlightLogs,
  mdFlightRuns,
  mdFlights,
  mdFlightVersions,
  mdGetDive,
  mdGetDiveVersion,
  mdGetFlight,
  mdGetFlightRun,
  mdGetFlightVersion,
  mdGetJob,
  mdGetJobVersion,
  mdJobRunLogs,
  mdJobRuns,
  mdJobs,
  mdJobVersions,
  mdGetFlightLogs,
  mdListDiveVersions,
  mdListDives,
  mdListFlightRuns,
  mdListFlights,
  mdListFlightVersions,
  mdListFiles,
  mdCurrentEmail,
  mdSessionRoles,
  mdIsRoleInSession,
  mdUpdateDiveStatus,
  mdRunFlight,
  mdRunJob,
  mdUpdateDiveContent,
  mdUpdateDiveMetadata,
  mdUpdateFlight,
  mdUpdateJob,
  type MotherDuckDiveCreateRow,
  type MotherDuckDiveDetailRow,
  type MotherDuckDiveSummaryRow,
  type MotherDuckFileRow,
  type MotherDuckFlightRunRow,
  type MotherDuckDiveVersionSummaryRow,
  type MotherDuckFlightSummaryRow,
  type MotherDuckFlightVersionRow,
  type MotherDuckFlightLogLineRow,
  type MotherDuckFlightLogsRow,
} from '../src/motherduck.ts';
import { DuckDBDialect } from '../src/dialect.ts';
import type { DuckLakeMergeAdjacentFilesRow } from '../src/ducklake.ts';
import { drizzle } from '../src/index.ts';

test('MotherDuck table function helpers emit callable SQL', () => {
  const dialect = new DuckDBDialect();

  const tokens = dialect.sqlToQuery(sql`
    select token_name, token_type, created_ts, expire_at
    from ${mdAccessTokens()}
    order by token_name
  `);

  const dives = dialect.sqlToQuery(sql`
    select id, required_resources
    from ${mdListDives()}
    where len(required_resources) > 0
  `);

  expect(tokens.sql).toContain('from md_access_tokens()');
  expect(tokens.params).toEqual([]);
  expect(dives.sql).toContain('from md_list_dives()');
  expect(dives.sql).toContain('required_resources');
  expect(dives.params).toEqual([]);
});

test('MotherDuck Dive helpers emit named-parameter table functions', () => {
  const dialect = new DuckDBDialect();
  const diveId = '90000000-0000-0000-0000-000000000001';

  const sharedDives = dialect.sqlToQuery(sql`
    select id, title
    from ${mdListDives({ limit: 10, offset: 20, includeOrgShares: true })}
  `);

  expect(sharedDives.sql).toContain(
    'from md_list_dives("LIMIT" = $1, "OFFSET" = $2, include_org_shares = $3)'
  );
  expect(sharedDives.params).toEqual([10, 20, true]);

  const createDive = dialect.sqlToQuery(sql`
    select id, current_version
    from ${mdCreateDive({
      title: 'Revenue Trends',
      content: 'export default function Dive() { return null }',
      description: 'Monthly revenue dashboard',
      apiVersion: 1,
    })}
  `);

  expect(createDive.sql).toContain(
    'from md_create_dive(title = $1, content = $2, description = $3, api_version = $4)'
  );
  expect(createDive.params).toEqual([
    'Revenue Trends',
    'export default function Dive() { return null }',
    'Monthly revenue dashboard',
    1,
  ]);

  const createDiveWithRequiredOnly = dialect.sqlToQuery(sql`
    from ${mdCreateDive({
      title: 'Minimal Dive',
      content: 'export default function Dive() { return null }',
    })}
  `);

  expect(createDiveWithRequiredOnly.sql).toContain(
    'from md_create_dive(title = $1, content = $2)'
  );
  expect(createDiveWithRequiredOnly.params).toEqual([
    'Minimal Dive',
    'export default function Dive() { return null }',
  ]);

  expect(dialect.sqlToQuery(sql`from ${mdGetDive(diveId)}`).sql).toContain(
    'from md_get_dive(id = $1)'
  );

  const updateMetadata = dialect.sqlToQuery(sql`
    from ${mdUpdateDiveMetadata({
      id: diveId,
      title: 'Q1 Revenue Dashboard',
      description: null,
    })}
  `);
  expect(updateMetadata.sql).toContain(
    'from md_update_dive_metadata(id = $1, title = $2, description = $3)'
  );
  expect(updateMetadata.params).toEqual([diveId, 'Q1 Revenue Dashboard', null]);

  const updateContent = dialect.sqlToQuery(sql`
    from ${mdUpdateDiveContent({
      id: diveId,
      content: sql`${'export default function Dive() { return null }'}`,
      description: 'Refresh chart copy',
      apiVersion: 1,
    })}
  `);
  expect(updateContent.sql).toContain(
    'from md_update_dive_content(id = $1, content = $2, description = $3, api_version = $4)'
  );
  expect(updateContent.params).toEqual([
    diveId,
    'export default function Dive() { return null }',
    'Refresh chart copy',
    1,
  ]);

  expect(dialect.sqlToQuery(sql`from ${mdDeleteDive(diveId)}`).sql).toContain(
    'from md_delete_dive(id = $1)'
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdListDiveVersions(diveId, { limit: 5 })}`)
      .sql
  ).toContain('from md_list_dive_versions(id = $1, "LIMIT" = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdGetDiveVersion(diveId, 0)}`).sql
  ).toContain('from md_get_dive_version(id = $1, version = $2)');
});

test('MotherDuck Dive version row types include required resources', () => {
  const row: MotherDuckDiveVersionSummaryRow = {
    id: '90000000-0000-0000-0000-000000000001',
    version: 1,
    storage_url: 's3://example/dive/1',
    description: null,
    created_at: '2026-07-03T00:00:00Z',
    api_version: 1,
    required_resources: [
      {
        name: 'analytics',
        alias: 'analytics',
        url: 'md:analytics',
        id: '90000000-0000-0000-0000-000000000002',
        resource_type: 'database',
      },
    ],
  };

  expect(row.required_resources?.[0]?.resource_type).toBe('database');
});

test('MotherDuck access token helper can filter expired tokens', () => {
  const dialect = new DuckDBDialect();

  const activeTokens = dialect.sqlToQuery(sql`
    select token_name
    from ${mdAccessTokens({
      activeOnly: true,
      asOf: '2026-06-19T00:00:00.000Z',
    })}
    order by token_name
  `);

  expect(activeTokens.sql).toContain(
    'from (select token_name, token_type, created_ts, expire_at from md_access_tokens() where expire_at is null or expire_at > $1) as active_access_tokens'
  );
  expect(activeTokens.params).toEqual(['2026-06-19T00:00:00.000Z']);
});

test('MotherDuck flight helpers emit named-parameter table functions', () => {
  const dialect = new DuckDBDialect();
  const flightId = '80000000-0000-0000-0000-000000000001';

  const createFlight = dialect.sqlToQuery(sql`
    select flight_id, current_version
    from ${mdCreateFlight({
      name: 'daily-refresh',
      accessTokenName: 'pipeline_token',
      sourceCode: 'print("hello")',
      flightSecretNames: ['warehouse'],
      scheduleCron: '0 0 * * *',
      config: { retries: '3', owner: 'analytics' },
      requirementsTxt: 'duckdb==1.0.0',
      maxRuntimeSec: 1_800,
    })}
  `);

  expect(createFlight.sql).toContain(
    'from md_create_flight(name = $1, access_token_name = $2, source_code = $3, flight_secret_names = $4, schedule_cron = $5, config = MAP($6, $7), requirements_txt = $8, max_runtime_sec = $9)'
  );
  expect(createFlight.params).toEqual([
    'daily-refresh',
    'pipeline_token',
    'print("hello")',
    ['warehouse'],
    '0 0 * * *',
    ['retries', 'owner'],
    ['3', 'analytics'],
    'duckdb==1.0.0',
    1_800,
  ]);

  const createFlightWithoutToken = dialect.sqlToQuery(sql`
    select flight_id
    from ${mdCreateFlight({
      name: 'tokenless-refresh',
      sourceCode: 'print("hello")',
    })}
  `);

  expect(createFlightWithoutToken.sql).toContain(
    'from md_create_flight(name = $1, source_code = $2)'
  );
  expect(createFlightWithoutToken.params).toEqual([
    'tokenless-refresh',
    'print("hello")',
  ]);

  const flights = dialect.sqlToQuery(sql`
    select flight_name
    from ${mdListFlights({ limit: 10, offset: 20 })}
  `);

  expect(flights.sql).toContain(
    'from md_list_flights("LIMIT" = $1, "OFFSET" = $2)'
  );
  expect(flights.params).toEqual([10, 20]);

  const updateFlight = dialect.sqlToQuery(sql`
    select current_version
    from ${mdUpdateFlight({
      flightId,
      sourceCode: sql`source_code || ${'\n# patched'}`,
      flightSecretNames: [],
      maxRuntimeSec: sql`max_runtime_sec + 60`,
    })}
  `);

  expect(updateFlight.sql).toContain(
    'from md_update_flight(flight_id = $1, source_code = source_code || $2, flight_secret_names = CAST([] AS VARCHAR[]), max_runtime_sec = max_runtime_sec + 60)'
  );
  expect(updateFlight.params).toEqual([flightId, '\n# patched']);

  expect(dialect.sqlToQuery(sql`from ${mdGetFlight(flightId)}`).sql).toContain(
    'from md_get_flight(flight_id = $1)'
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdDeleteFlight(flightId)}`).sql
  ).toContain('from md_delete_flight(flight_id = $1)');
  expect(dialect.sqlToQuery(sql`from ${mdRunFlight(flightId)}`).sql).toContain(
    'from md_run_flight(flight_id = $1)'
  );
  const runWithConfig = dialect.sqlToQuery(sql`
    from ${mdRunFlight(flightId, {
      config: { region: 'eu-west-1', dry_run: 'true' },
    })}
  `);
  expect(runWithConfig.sql).toContain(
    'from md_run_flight(flight_id = $1, config = MAP($2, $3))'
  );
  expect(runWithConfig.params).toEqual([
    flightId,
    ['region', 'dry_run'],
    ['eu-west-1', 'true'],
  ]);
  expect(
    dialect.sqlToQuery(sql`from ${mdCancelFlightRun(flightId, 2)}`).sql
  ).toContain('from md_cancel_flight_run(flight_id = $1, run_number = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdListFlightRuns(flightId, { limit: 1 })}`)
      .sql
  ).toContain('from md_list_flight_runs(flight_id = $1, "LIMIT" = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdGetFlightRun(flightId, 1)}`).sql
  ).toContain('from md_get_flight_run(flight_id = $1, run_number = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdGetFlightLogs(flightId, 1)}`).sql
  ).toContain('from md_get_flight_logs(flight_id = $1, run_number = $2)');
  const latestLogs = dialect.sqlToQuery(sql`
    from ${mdGetFlightLogs(flightId, 1, {
      limit: 100,
      offset: 20,
      order: 'desc',
    })}
  `);
  expect(latestLogs.sql).toContain(
    'from md_get_flight_logs(flight_id = $1, run_number = $2, "LIMIT" = $3, "OFFSET" = $4, "ORDER" = $5)'
  );
  expect(latestLogs.params).toEqual([flightId, 1, 100, 20, 'desc']);
  expect(
    dialect.sqlToQuery(
      sql`from ${mdListFlightVersions(flightId, { offset: 2 })}`
    ).sql
  ).toContain('from md_list_flight_versions(flight_id = $1, "OFFSET" = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdGetFlightVersion(flightId, 1)}`).sql
  ).toContain(
    'from md_get_flight_version(flight_id = $1, version_number = $2)'
  );
});

test('MotherDuck flight log row types preserve line results and legacy imports', () => {
  const line: MotherDuckFlightLogLineRow = {
    line_number: 3n,
    reported_at: '2026-08-26T12:00:00Z',
    line: 'refresh complete',
  };
  const legacy: MotherDuckFlightLogsRow = {
    logs: 'refresh complete\n',
  };

  expect(line.line).toBe('refresh complete');
  expect(legacy.logs).toBe('refresh complete\n');
});

test('deprecated MotherDuck flight helper aliases emit supported table functions', () => {
  const dialect = new DuckDBDialect();
  const flightId = '80000000-0000-0000-0000-000000000001';

  expect(
    dialect.sqlToQuery(sql`from ${mdFlights({ limit: 1 })}`).sql
  ).toContain('from md_list_flights("LIMIT" = $1)');
  expect(
    dialect.sqlToQuery(sql`from ${mdFlightRuns(flightId, { limit: 1 })}`).sql
  ).toContain('from md_list_flight_runs(flight_id = $1, "LIMIT" = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdFlightLogs(flightId, 1)}`).sql
  ).toContain(
    "from (select coalesce(string_agg(coalesce(line, ''), chr(10) order by line_number), '') as logs from md_get_flight_logs(flight_id = $1, run_number = $2)) as md_flight_logs"
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdFlightVersions(flightId, { offset: 2 })}`)
      .sql
  ).toContain('from md_list_flight_versions(flight_id = $1, "OFFSET" = $2)');
});

test('MotherDuck flight helpers emit explicit null optional parameters', () => {
  const dialect = new DuckDBDialect();
  const flightId = '80000000-0000-0000-0000-000000000001';

  const createFlight = dialect.sqlToQuery(sql`
    from ${mdCreateFlight({
      name: 'null-options',
      accessTokenName: 'pipeline_token',
      sourceCode: 'print("hello")',
      flightSecretNames: null,
      scheduleCron: null,
      config: { keep: 'value', clear: null },
      requirementsTxt: null,
    })}
  `);

  expect(createFlight.sql).toContain(
    'from md_create_flight(name = $1, access_token_name = $2, source_code = $3, flight_secret_names = $4, schedule_cron = $5, config = MAP($6, $7), requirements_txt = $8)'
  );
  expect(createFlight.params).toEqual([
    'null-options',
    'pipeline_token',
    'print("hello")',
    null,
    null,
    ['keep', 'clear'],
    ['value', null],
    null,
  ]);

  const updateFlight = dialect.sqlToQuery(sql`
    from ${mdUpdateFlight({
      flightId,
      config: null,
      flightSecretNames: [null, 'warehouse'],
      requirementsTxt: null,
    })}
  `);

  expect(updateFlight.sql).toContain(
    'from md_update_flight(flight_id = $1, config = $2, requirements_txt = $3, flight_secret_names = $4)'
  );
  expect(updateFlight.params).toEqual([
    flightId,
    null,
    null,
    [null, 'warehouse'],
  ]);
});

test('MotherDuck flight config helpers reject invalid environment keys', () => {
  const dialect = new DuckDBDialect();
  const flightId = '80000000-0000-0000-0000-000000000001';

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdCreateFlight({
        name: 'bad-config',
        sourceCode: 'print("hello")',
        config: { '': 'value' },
      })}
    `)
  ).toThrow(/config keys must not be empty/i);

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdRunFlight(flightId, {
        config: { 'KEY=value': 'bad' },
      })}
    `)
  ).toThrow(/must not contain "="/i);

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdUpdateFlight({
        flightId,
        config: { 'BAD\0KEY': 'value' },
      })}
    `)
  ).toThrow(/must not contain a NULL byte/i);

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdUpdateFlight({
        flightId,
        config: { GOOD_KEY: 'bad\0value' },
      })}
    `)
  ).toThrow(/value for key "GOOD_KEY" must not contain a NULL byte/i);

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdCreateFlight({
        name: 'reserved-config',
        sourceCode: 'print("hello")',
        config: { MOTHERDUCK_TOKEN: 'not-allowed' },
      })}
    `)
  ).toThrow(/config key "MOTHERDUCK_TOKEN" is reserved/i);

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdRunFlight(flightId, {
        config: { MOTHERDUCK_FLIGHTS_RUN: '1' },
      })}
    `)
  ).toThrow(/config key "MOTHERDUCK_FLIGHTS_RUN" is reserved/i);
});

test('MotherDuck config validation preserves nulls and SQL wrapper escape hatches', () => {
  const dialect = new DuckDBDialect();
  const flightId = '80000000-0000-0000-0000-000000000001';

  const explicitNullValue = dialect.sqlToQuery(sql`
    from ${mdUpdateFlight({
      flightId,
      config: { OPTIONAL_KEY: null },
    })}
  `);
  expect(explicitNullValue.sql).toContain(
    'from md_update_flight(flight_id = $1, config = MAP($2, $3))'
  );
  expect(explicitNullValue.params).toEqual([
    flightId,
    ['OPTIONAL_KEY'],
    [null],
  ]);

  const sqlWrapperConfig = dialect.sqlToQuery(sql`
    from ${mdRunFlight(flightId, {
      config: sql`MAP([''], ['advanced'])`,
    })}
  `);
  expect(sqlWrapperConfig.sql).toContain(
    "from md_run_flight(flight_id = $1, config = MAP([''], ['advanced']))"
  );
  expect(sqlWrapperConfig.params).toEqual([flightId]);
});

test('deprecated MotherDuck job helpers emit supported Flight functions', () => {
  const dialect = new DuckDBDialect();
  const jobId = '80000000-0000-0000-0000-000000000001';

  const createJob = dialect.sqlToQuery(sql`
    select job_id, current_version
    from ${mdCreateJob({
      name: 'daily-refresh',
      mdTokenName: 'pipeline_token',
      sourceCode: 'print("hello")',
      mdSecretNames: ['warehouse'],
      scheduleCron: '0 0 * * *',
      config: { retries: '3', owner: 'analytics' },
      requirementsTxt: 'duckdb==1.0.0',
      maxRuntimeSec: 1_800,
    })}
  `);

  expect(createJob.sql).toContain(
    'from (select flight_id as job_id, flight_name as job_name, schedule_cron, schedule_status, status, current_version, created_at, updated_at from md_create_flight(name = $1, access_token_name = $2, source_code = $3, flight_secret_names = $4, schedule_cron = $5, config = MAP($6, $7), requirements_txt = $8, max_runtime_sec = $9)) as md_jobs'
  );
  expect(createJob.params).toEqual([
    'daily-refresh',
    'pipeline_token',
    'print("hello")',
    ['warehouse'],
    '0 0 * * *',
    ['retries', 'owner'],
    ['3', 'analytics'],
    'duckdb==1.0.0',
    1_800,
  ]);

  const jobs = dialect.sqlToQuery(sql`
    select job_name
    from ${mdJobs({ limit: 10, offset: 20 })}
  `);

  expect(jobs.sql).toContain(
    'from (select flight_id as job_id, flight_name as job_name, schedule_cron, schedule_status, status, current_version, created_at, updated_at from md_list_flights("LIMIT" = $1, "OFFSET" = $2)) as md_jobs'
  );
  expect(jobs.params).toEqual([10, 20]);

  const updateJob = dialect.sqlToQuery(sql`
    select current_version
    from ${mdUpdateJob({
      jobId,
      sourceCode: sql`source_code || ${'\n# patched'}`,
      mdSecretNames: [],
    })}
  `);

  expect(updateJob.sql).toContain(
    'from (select flight_id as job_id, flight_name as job_name, schedule_cron, schedule_status, status, current_version, created_at, updated_at from md_update_flight(flight_id = $1, source_code = source_code || $2, flight_secret_names = CAST([] AS VARCHAR[]))) as md_jobs'
  );
  expect(updateJob.params).toEqual([jobId, '\n# patched']);

  expect(dialect.sqlToQuery(sql`from ${mdGetJob(jobId)}`).sql).toContain(
    'from (select flight_id as job_id, flight_name as job_name, schedule_cron, schedule_status, status, current_version, created_at, updated_at from md_get_flight(flight_id = $1)) as md_jobs'
  );
  expect(dialect.sqlToQuery(sql`from ${mdDeleteJob(jobId)}`).sql).toContain(
    'from md_delete_flight(flight_id = $1)'
  );
  expect(dialect.sqlToQuery(sql`from ${mdRunJob(jobId)}`).sql).toContain(
    'from (select run_id, flight_id as job_id, flight_name as job_name, flight_version as job_version, run_number, is_scheduled, status, created_at, started_at, ended_at, scheduled_at, cancelled_at, exit_code from md_run_flight(flight_id = $1)) as md_job_runs'
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdCancelJobRun(jobId, 2)}`).sql
  ).toContain('from md_cancel_flight_run(flight_id = $1, run_number = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdJobRuns(jobId, { limit: 1 })}`).sql
  ).toContain(
    'from (select run_id, flight_id as job_id, flight_name as job_name, flight_version as job_version, run_number, is_scheduled, status, created_at, started_at, ended_at, scheduled_at, cancelled_at, exit_code from md_list_flight_runs(flight_id = $1, "LIMIT" = $2)) as md_job_runs'
  );
  expect(dialect.sqlToQuery(sql`from ${mdJobRunLogs(jobId, 1)}`).sql).toContain(
    "from (select coalesce(string_agg(coalesce(line, ''), chr(10) order by line_number), '') as logs from md_get_flight_logs(flight_id = $1, run_number = $2)) as md_flight_logs"
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdJobVersions(jobId, { offset: 2 })}`).sql
  ).toContain(
    'from (select version_id, flight_id as job_id, flight_version as version, created_at, access_token_name as md_token_name, flight_secret_names as md_secret_names, config, source_code, requirements_txt from md_list_flight_versions(flight_id = $1, "OFFSET" = $2)) as md_job_versions'
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdGetJobVersion(jobId, 1)}`).sql
  ).toContain(
    'from (select version_id, flight_id as job_id, flight_version as version, created_at, access_token_name as md_token_name, flight_secret_names as md_secret_names, config, source_code, requirements_txt from md_get_flight_version(flight_id = $1, version_number = $2)) as md_job_versions'
  );
});

test('deprecated MotherDuck job config helpers share Flight validation', () => {
  const dialect = new DuckDBDialect();

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdCreateJob({
        name: 'bad-config',
        mdTokenName: 'pipeline_token',
        sourceCode: 'print("hello")',
        config: { 'BAD=KEY': 'value' },
      })}
    `)
  ).toThrow(/must not contain "="/i);

  expect(() =>
    dialect.sqlToQuery(sql`
      from ${mdUpdateJob({
        jobId: '80000000-0000-0000-0000-000000000001',
        config: { GOOD_KEY: 'bad\0value' },
      })}
    `)
  ).toThrow(/value for key "GOOD_KEY" must not contain a NULL byte/i);
});

test('MotherDuck Flight helpers pass instance types and the owner filter', () => {
  const dialect = new DuckDBDialect();
  const flightId = '80000000-0000-0000-0000-000000000001';

  const created = dialect.sqlToQuery(
    sql`from ${mdCreateFlight({
      name: 'nightly',
      sourceCode: 'print(1)',
      instanceType: 'F16',
    })}`
  );
  expect(created.sql).toContain(
    'from md_create_flight(name = $1, source_code = $2, instance_type = $3)'
  );
  expect(created.params).toEqual(['nightly', 'print(1)', 'F16']);

  const updated = dialect.sqlToQuery(
    sql`from ${mdUpdateFlight({ flightId, instanceType: sql`'F32'` })}`
  );
  expect(updated.sql).toContain(
    "from md_update_flight(flight_id = $1, instance_type = 'F32')"
  );

  const owned = dialect.sqlToQuery(
    sql`from ${mdListFlights({ ownerOnly: true, limit: 5 })}`
  );
  expect(owned.sql).toContain(
    'from md_list_flights("LIMIT" = $1, owner_only = $2)'
  );
  expect(owned.params).toEqual([5, true]);

  const version: MotherDuckFlightVersionRow = {
    version_id: '1',
    flight_id: flightId,
    flight_version: 2,
    created_at: '2026-10-01T00:00:00Z',
    access_token_name: 'token',
    flight_secret_names: [],
    config: null,
    source_code: 'print(1)',
    requirements_txt: null,
    instance_type: 'F4',
  };
  const summary: MotherDuckFlightSummaryRow = {
    flight_id: flightId,
    flight_name: 'nightly',
    schedule_cron: null,
    schedule_status: null,
    status: 'active',
    current_version: 2,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    owner_name: 'leo',
  };
  expect([version.instance_type, summary.owner_name]).toEqual(['F4', 'leo']);
});

test('MotherDuck Dive helpers set status and required resources', () => {
  const dialect = new DuckDBDialect();
  const diveId = '90000000-0000-0000-0000-000000000001';

  const status = dialect.sqlToQuery(
    sql`from ${mdUpdateDiveStatus({ id: diveId, status: 'endorsed', version: 3 })}`
  );
  expect(status.sql).toContain(
    'from md_update_dive_status(id = $1, status = $2, version = $3)'
  );
  expect(status.params).toEqual([diveId, 'endorsed', 3]);

  const created = dialect.sqlToQuery(
    sql`from ${mdCreateDive({
      title: 'Revenue',
      content: 'export default () => null',
      requiredResources: [
        { url: 'md:_share/sales/abc', alias: 'sales' },
        { url: 'md:analytics' },
      ],
    })}`
  );
  expect(created.sql).toContain(
    'required_resources = CAST([{url: $3, alias: $4}, {url: $5, alias: $6}] AS STRUCT(url VARCHAR, alias VARCHAR)[])'
  );
  expect(created.params.slice(2)).toEqual([
    'md:_share/sales/abc',
    'sales',
    'md:analytics',
    null,
  ]);

  const cleared = dialect.sqlToQuery(
    sql`from ${mdUpdateDiveContent({
      id: diveId,
      content: 'x',
      requiredResources: [],
    })}`
  );
  expect(cleared.sql).toContain(
    'required_resources = CAST([] AS STRUCT(url VARCHAR, alias VARCHAR)[])'
  );

  expect(() =>
    mdCreateDive({
      title: 't',
      content: 'c',
      requiredResources: [{ url: '' }],
    })
  ).toThrow(/needs a non-empty url/);

  const row: MotherDuckDiveSummaryRow = {
    id: diveId,
    title: 'Revenue',
    description: null,
    owner_id: '1',
    current_version: 3,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    owner_name: 'leo',
    status: 'endorsed',
    status_applies_to_version: 3,
  };
  expect(row.status).toBe('endorsed');
});

test('MotherDuck file listing and session identity helpers emit SQL', () => {
  const dialect = new DuckDBDialect();

  const files = dialect.sqlToQuery(
    sql`select name from ${mdListFiles('s3://bucket/raw/', { limit: 100 })}`
  );
  expect(files.sql).toContain('from md_list_files($1, "LIMIT" = $2)');
  expect(files.params).toEqual(['s3://bucket/raw/', 100]);

  const identity = dialect.sqlToQuery(
    sql`select ${mdCurrentEmail()}, ${mdSessionRoles()}, ${mdIsRoleInSession(
      'analyst'
    )}, ${mdIsRoleInSession(['admin', 'owner'])}, ${mdIsRoleInSession([])}`
  );
  expect(identity.sql).toBe(
    'select current_email(), session_roles(), is_role_in_session(CAST($1 AS VARCHAR)), is_role_in_session(CAST($2 AS VARCHAR[])), is_role_in_session(CAST([] AS VARCHAR[]))'
  );
  expect(identity.params).toEqual(['analyst', ['admin', 'owner']]);
});

test('MotherDuck helper argument expressions bind in DuckDB', async () => {
  // Mirrors the list arguments the Dive and role helpers emit.
  const db = await drizzle(':memory:');
  try {
    const [row] = await db.execute<{
      resources: { url: string; alias: string | null }[];
      empty: unknown[];
      roles: string[];
    }>(sql`
      select
        CAST([{url: ${'md:a'}, alias: ${'a'}}, {url: ${'md:b'}, alias: ${null}}] AS STRUCT(url VARCHAR, alias VARCHAR)[]) as resources,
        CAST([] AS STRUCT(url VARCHAR, alias VARCHAR)[]) as empty,
        CAST(${sql.param(['admin', 'owner'])} AS VARCHAR[]) as roles
    `);
    expect(row).toEqual({
      resources: [
        { url: 'md:a', alias: 'a' },
        { url: 'md:b', alias: null },
      ],
      empty: [],
      roles: ['admin', 'owner'],
    });
  } finally {
    await db.close();
  }
});

test('MotherDuck row types work as db.execute result types', () => {
  // db.execute<T> requires T to extend Record<string, unknown>, which an
  // interface does not.
  expectTypeOf<MotherDuckFlightRunRow>().toExtend<Record<string, unknown>>();
  expectTypeOf<MotherDuckDiveDetailRow>().toExtend<Record<string, unknown>>();
  expectTypeOf<MotherDuckDiveCreateRow>().toExtend<Record<string, unknown>>();
  expectTypeOf<MotherDuckFileRow>().toExtend<Record<string, unknown>>();
  expectTypeOf<DuckLakeMergeAdjacentFilesRow>().toExtend<
    Record<string, unknown>
  >();
});
