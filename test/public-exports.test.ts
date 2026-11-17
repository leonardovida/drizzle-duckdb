import { expect, expectTypeOf, test } from 'vitest';
import * as helpersApi from '../src/helpers.ts';
import * as publicApi from '../src/index.ts';
import type { DuckDbMigrationConfig } from '../src/index.ts';

test('types used in public signatures are exported by name', async () => {
  expect(publicApi.DuckDBDialect).toBeTypeOf('function');
  expect(publicApi.DuckDBSelectBuilder).toBeTypeOf('function');
  expectTypeOf<DuckDbMigrationConfig>().toEqualTypeOf<
    Parameters<typeof publicApi.migrate>[1]
  >();

  const db = await publicApi.drizzle(':memory:');
  try {
    expect(db.dialect).toBeInstanceOf(publicApi.DuckDBDialect);
    expect(db.select()).toBeInstanceOf(publicApi.DuckDBSelectBuilder);
  } finally {
    await db.close();
  }
});

// Removing or renaming an export is a breaking change, and adding one is a
// commitment. Update these lists on purpose, together with the docs.
test('the runtime exports of the package entry point are pinned', () => {
  expect(Object.keys(publicApi).sort()).toMatchInlineSnapshot(`
    [
      "APPEND_DEFAULT",
      "DUCKDB_VALUE_MARKER",
      "DuckDBDatabase",
      "DuckDBDialect",
      "DuckDBDriver",
      "DuckDBPreparedQuery",
      "DuckDBSelectBuilder",
      "DuckDBSession",
      "DuckDBTransaction",
      "OlapBuilder",
      "POOL_PRESETS",
      "anyValue",
      "appendRowsOnClient",
      "arrayContainedBy",
      "arrayHasAll",
      "arrayHasAny",
      "avgN",
      "closeClientConnection",
      "closeDuckDbInstance",
      "configureDuckLake",
      "countN",
      "createDuckDBConnectionPool",
      "createPgDuckConnectionPool",
      "denseRank",
      "drizzle",
      "duckDbArray",
      "duckDbArrayContained",
      "duckDbArrayContains",
      "duckDbArrayOverlaps",
      "duckDbBlob",
      "duckDbDate",
      "duckDbInet",
      "duckDbInterval",
      "duckDbJson",
      "duckDbList",
      "duckDbMap",
      "duckDbStruct",
      "duckDbTime",
      "duckDbTimestamp",
      "duckDbUnion",
      "duckLakeMergeAdjacentFiles",
      "executeArraysOnClient",
      "executeArrowOnClient",
      "executeInBatches",
      "executeInBatchesRaw",
      "executeOnClient",
      "introspect",
      "isDuckDBWrapper",
      "isPool",
      "lag",
      "lanceFts",
      "lanceHybridSearch",
      "lanceVectorSearch",
      "lead",
      "mdAccessTokens",
      "mdCancelFlightRun",
      "mdCreateDive",
      "mdCreateFlight",
      "mdCurrentEmail",
      "mdDeleteDive",
      "mdDeleteFlight",
      "mdGetDive",
      "mdGetDiveVersion",
      "mdGetFlight",
      "mdGetFlightLogs",
      "mdGetFlightRun",
      "mdGetFlightVersion",
      "mdIsRoleInSession",
      "mdListDiveVersions",
      "mdListDives",
      "mdListFiles",
      "mdListFlightGrantees",
      "mdListFlightRuns",
      "mdListFlightVersions",
      "mdListFlights",
      "mdListRoleMembers",
      "mdListRoles",
      "mdListRolesGrantedToRole",
      "mdListRolesGrantedToUser",
      "mdPrompt",
      "mdPromptJev",
      "mdRunFlight",
      "mdSessionRoles",
      "mdUpdateDiveContent",
      "mdUpdateDiveMetadata",
      "mdUpdateDiveStatus",
      "mdUpdateFlight",
      "median",
      "migrate",
      "motherDuckReadCsvAuto",
      "motherDuckReadJsonAuto",
      "motherDuckReadParquet",
      "motherDuckTableFunction",
      "olap",
      "percentileCont",
      "prepareParams",
      "rank",
      "resolvePoolSize",
      "rowNumber",
      "sumDistinctN",
      "sumN",
      "wrapArray",
      "wrapBlob",
      "wrapDuckLakePool",
      "wrapJson",
      "wrapList",
      "wrapMap",
      "wrapStruct",
      "wrapTimestamp",
      "wrapperToNodeApiValue",
    ]
  `);
});

test('the runtime exports of the helpers entry point are pinned', () => {
  expect(Object.keys(helpersApi).sort()).toMatchInlineSnapshot(`
    [
      "duckDbArray",
      "duckDbArrayContained",
      "duckDbArrayContains",
      "duckDbArrayOverlaps",
      "duckDbBlob",
      "duckDbDate",
      "duckDbInet",
      "duckDbInterval",
      "duckDbJson",
      "duckDbList",
      "duckDbMap",
      "duckDbStruct",
      "duckDbTime",
      "duckDbTimestamp",
      "duckDbUnion",
    ]
  `);
});
