import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
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
  mdRunFlight,
  mdRunJob,
  mdUpdateDiveContent,
  mdUpdateDiveMetadata,
  mdUpdateFlight,
  mdUpdateJob,
  type MotherDuckDiveVersionSummaryRow,
} from '../src/motherduck.ts';
import { DuckDBDialect } from '../src/dialect.ts';

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
    'from md_update_flight(flight_id = $1, source_code = source_code || $2, flight_secret_names = $3, max_runtime_sec = max_runtime_sec + 60)'
  );
  expect(updateFlight.params).toEqual([flightId, '\n# patched', []]);

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
    dialect.sqlToQuery(sql`from ${mdGetFlightLogs(flightId, 1)}`).sql
  ).toContain('from md_get_flight_logs(flight_id = $1, run_number = $2)');
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
  ).toContain('from md_get_flight_logs(flight_id = $1, run_number = $2)');
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
    'from (select flight_id as job_id, flight_name as job_name, schedule_cron, schedule_status, status, current_version, created_at, updated_at from md_update_flight(flight_id = $1, source_code = source_code || $2, flight_secret_names = $3)) as md_jobs'
  );
  expect(updateJob.params).toEqual([jobId, '\n# patched', []]);

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
    'from md_get_flight_logs(flight_id = $1, run_number = $2)'
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
