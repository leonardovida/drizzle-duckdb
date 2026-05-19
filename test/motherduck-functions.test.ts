import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  mdAccessTokens,
  mdCancelJobRun,
  mdCreateJob,
  mdDeleteJob,
  mdGetJob,
  mdGetJobVersion,
  mdJobRunLogs,
  mdJobRuns,
  mdJobs,
  mdJobVersions,
  mdListDives,
  mdRunJob,
  mdUpdateJob,
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

test('MotherDuck job helpers emit named-parameter table functions', () => {
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
    })}
  `);

  expect(createJob.sql).toContain(
    'from md_create_job(name = $1, md_token_name = $2, source_code = $3, md_secret_names = $4, schedule_cron = $5, config = MAP($6, $7), requirements_txt = $8)'
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
  ]);

  const jobs = dialect.sqlToQuery(sql`
    select job_name
    from ${mdJobs({ limit: 10, offset: 20 })}
  `);

  expect(jobs.sql).toContain('from md_jobs("LIMIT" = $1, "OFFSET" = $2)');
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
    'from md_update_job(job_id = $1, source_code = source_code || $2, md_secret_names = $3)'
  );
  expect(updateJob.params).toEqual([jobId, '\n# patched', []]);

  expect(dialect.sqlToQuery(sql`from ${mdGetJob(jobId)}`).sql).toContain(
    'from md_get_job(job_id = $1)'
  );
  expect(dialect.sqlToQuery(sql`from ${mdDeleteJob(jobId)}`).sql).toContain(
    'from md_delete_job(job_id = $1)'
  );
  expect(dialect.sqlToQuery(sql`from ${mdRunJob(jobId)}`).sql).toContain(
    'from md_run_job(job_id = $1)'
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdCancelJobRun(jobId, 2)}`).sql
  ).toContain('from md_cancel_job_run(job_id = $1, run_number = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdJobRuns(jobId, { limit: 1 })}`).sql
  ).toContain('from md_job_runs(job_id = $1, "LIMIT" = $2)');
  expect(dialect.sqlToQuery(sql`from ${mdJobRunLogs(jobId, 1)}`).sql).toContain(
    'from md_job_run_logs(job_id = $1, run_number = $2)'
  );
  expect(
    dialect.sqlToQuery(sql`from ${mdJobVersions(jobId, { offset: 2 })}`).sql
  ).toContain('from md_job_versions(job_id = $1, "OFFSET" = $2)');
  expect(
    dialect.sqlToQuery(sql`from ${mdGetJobVersion(jobId, 1)}`).sql
  ).toContain('from md_get_job_version(job_id = $1, version_number = $2)');
});
