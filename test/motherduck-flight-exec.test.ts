import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { executeOnClient } from '../src/client.ts';
import { DuckDBDialect } from '../src/dialect.ts';
import {
  mdCreateFlight,
  mdFlightLogs,
  mdJobRunLogs,
  mdRunFlight,
  mdUpdateFlight,
} from '../src/motherduck.ts';

const dialect = new DuckDBDialect();

// The md_* Flight functions only exist on MotherDuck. Local table macros stand
// in for them so the argument expressions and bound params run in DuckDB.
// Table macros take named arguments as `name := value`, so the stand-in
// rewrites the `name = value` arguments the helpers emit.
const standInMacros = [
  `create macro md_run_flight(flight_id := NULL, config := NULL) as table
    select config as config, typeof(config) as config_type`,
  `create macro md_create_flight(name := NULL, access_token_name := NULL, source_code := NULL, flight_secret_names := NULL, config := NULL) as table
    select flight_secret_names as flight_secret_names, typeof(flight_secret_names) as names_type, config as config, typeof(config) as config_type`,
  `create macro md_update_flight(flight_id := NULL, config := NULL, flight_secret_names := NULL) as table
    select flight_secret_names as flight_secret_names, typeof(flight_secret_names) as names_type, config as config, typeof(config) as config_type`,
  `create macro md_get_flight_logs(flight_id := NULL, run_number := NULL, "ORDER" := NULL) as table
    select * from (values (2, 'second'), (1, 'first'), (3, 'third')) as t(line_number, line)`,
];

function toStandInSql(query: SQL): { sql: string; params: unknown[] } {
  const compiled = dialect.sqlToQuery(query);
  return {
    sql: compiled.sql.replace(/(\b\w+|"\w+") = /g, '$1 := '),
    params: compiled.params,
  };
}

describe('MotherDuck Flight arguments run in DuckDB', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;

  async function run(query: SQL) {
    const { sql: text, params } = toStandInSql(query);
    return executeOnClient(connection, text, params);
  }

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    for (const macro of standInMacros) {
      await connection.run(macro);
    }
  });

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  test('an empty config binds as a typed empty map', async () => {
    const rows = await run(
      sql`from ${mdRunFlight('flight-id', { config: {} })}`
    );
    expect(rows).toEqual([
      { config: [], config_type: 'MAP(VARCHAR, VARCHAR)' },
    ]);

    const created = await run(
      sql`from ${mdCreateFlight({
        name: 'etl',
        sourceCode: 'print(1)',
        config: {},
        flightSecretNames: [],
      })}`
    );
    expect(created).toEqual([
      {
        flight_secret_names: [],
        names_type: 'VARCHAR[]',
        config: [],
        config_type: 'MAP(VARCHAR, VARCHAR)',
      },
    ]);
  });

  test('an empty secret name list binds as a typed empty list', async () => {
    const rows = await run(
      sql`from ${mdUpdateFlight({ flightId: 'flight-id', flightSecretNames: [] })}`
    );
    expect(rows).toMatchObject([
      { flight_secret_names: [], names_type: 'VARCHAR[]', config: null },
    ]);
  });

  test('non-empty config and secret names still bind as params', async () => {
    const rows = await run(
      sql`from ${mdUpdateFlight({
        flightId: 'flight-id',
        config: { REGION: 'eu', OPTIONAL: null },
        flightSecretNames: ['warehouse'],
      })}`
    );
    expect(rows).toEqual([
      {
        flight_secret_names: ['warehouse'],
        names_type: 'VARCHAR[]',
        config: [
          { key: 'REGION', value: 'eu' },
          { key: 'OPTIONAL', value: null },
        ],
        config_type: 'MAP(VARCHAR, VARCHAR)',
      },
    ]);
  });

  test('the legacy logs blob joins lines in line_number order', async () => {
    await expect(
      run(sql`from ${mdFlightLogs('flight-id', 1)}`)
    ).resolves.toEqual([{ logs: 'first\nsecond\nthird' }]);
    await expect(
      run(sql`from ${mdJobRunLogs('flight-id', 1, { order: 'desc' })}`)
    ).resolves.toEqual([{ logs: 'third\nsecond\nfirst' }]);
    await expect(
      run(sql`from ${mdFlightLogs('flight-id', 1, { order: sql`'DESC'` })}`)
    ).resolves.toEqual([{ logs: 'third\nsecond\nfirst' }]);
  });
});
