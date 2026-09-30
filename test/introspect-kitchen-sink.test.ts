import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from '../src/index';
import { introspect } from '../src/introspect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Catalog metadata that previously produced invalid or unsafe TypeScript:
// injection through type text and sequence names, name collisions, reserved
// words, quoted columns in constraints, self references, and typed defaults.
const DDL = [
  `create schema ks`,
  `create schema ks2`,
  `create schema pg`,
  `create type ks.mood as enum ('happy', 'x */ + (globalThis.__ksPwned = 1) + /* y')`,
  `create sequence ks."seq\${globalThis.__ksPwned = 2}"`,
  'create sequence ks."tick`seq"',
  `create table ks.parents (id integer primary key, "first name" varchar unique)`,
  `create table ks.emp (id integer primary key, mgr integer references ks.emp(id))`,
  `create table ks.t (id integer primary key)`,
  `create table ks.child (
    id integer primary key,
    t_id integer references ks.t(id),
    parent_name varchar references ks.parents("first name")
  )`,
  `create table ks.z_late (id integer primary key)`,
  `create table ks.a_early (z_id integer references ks.z_late(id))`,
  `create table ks."class" (id integer)`,
  `create table ks."delete" (id integer)`,
  `create table ks."integer" (id integer)`,
  `create table ks.ks_schema (id integer)`,
  `create table ks.users (id integer)`,
  `create table ks2.users (id integer)`,
  `create table pg.things (id integer)`,
  `create table ks.nested (
    l_dec decimal(10, 2)[],
    a_dec decimal(10, 2)[3],
    l_uuid uuid[],
    mp map(varchar, struct("Nice Name" integer)),
    mk map(integer, varchar)
  )`,
  `create table ks.cols (
    user_id integer,
    "user__id" integer,
    "first name" varchar,
    "1col" integer,
    email varchar unique,
    primary key ("first name"),
    unique ("1col"),
    unique (user_id, "user__id")
  )`,
  `create table ks.defaults (
    b boolean default true,
    b2 boolean default false,
    u uuid default uuid(),
    x integer default (1 + 2),
    v varchar default 5,
    n integer default -1,
    d double default 1e3,
    big bigint default 9007199254740993,
    dec decimal(10, 2) default 1.5,
    tstz timestamptz default now(),
    ts timestamp default current_timestamp,
    tsl timestamp default '2024-01-01 00:00:00',
    dt date default current_date,
    dd date default '2024-01-01',
    s1 integer default nextval('ks."seq\${globalThis.__ksPwned = 2}"'),
    s2 integer default nextval('ks."tick\`seq"'),
    vs varchar default 'it''s */ done',
    cc varchar default ('a */ b' || 'c'),
    j json default '{}',
    r real default 1.5,
    f float,
    m ks.mood,
    un union(num integer, "s*/x" varchar),
    g integer generated always as (n + 1) virtual,
    st struct("Nice Name" integer, tags varchar[]),
    mp map(varchar, integer[])
  )`,
];

const tmpDir = path.join(process.cwd(), 'test/.tmp/introspect-kitchen-sink');
const helpersPath = path.join(process.cwd(), 'src/helpers.ts');

let connection: DuckDBConnection;
let customSchemaTs: string;
let pgTimeSchemaTs: string;

function runTsc(files: string[]): void {
  const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        extends: path.relative(
          tmpDir,
          path.join(process.cwd(), 'tsconfig.json')
        ),
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        files,
      },
      null,
      2
    )
  );
  const tscPath = path.join(process.cwd(), 'node_modules', '.bin', 'tsc');
  try {
    execFileSync(tscPath, ['--pretty', 'false', '--project', tsconfigPath], {
      stdio: 'pipe',
    });
  } catch (error) {
    const err = error as { stdout?: Buffer; message: string };
    throw new Error(
      `tsc failed on generated schema:\n${err.stdout?.toString() ?? err.message}`
    );
  }
}

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  for (const statement of DDL) {
    await connection.run(statement);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const importBasePath = path.relative(tmpDir, helpersPath);
  const db = drizzle(connection);
  const schemas = ['ks', 'ks2', 'pg'];

  customSchemaTs = (await introspect(db, { schemas, importBasePath })).files
    .schemaTs;
  pgTimeSchemaTs = (
    await introspect(db, { schemas, importBasePath, useCustomTimeTypes: false })
  ).files.schemaTs;

  fs.writeFileSync(path.join(tmpDir, 'schema.ts'), customSchemaTs);
  fs.writeFileSync(path.join(tmpDir, 'schema-pg-time.ts'), pgTimeSchemaTs);
});

afterAll(() => {
  connection?.closeSync();
});

describe('introspection kitchen sink', () => {
  test('generated schemas pass tsc --strict', () => {
    runTsc(['schema.ts', 'schema-pg-time.ts']);
  }, 60_000);

  test('escapes catalog text in comments and sql templates', () => {
    expect(customSchemaTs).toContain(
      `/* ENUM ('happy', 'x *\\/ + (globalThis.__ksPwned = 1) + /* y') */`
    );
    expect(customSchemaTs).toContain(
      `/* UNION (num INTEGER, "s*\\/x" VARCHAR) */`
    );
    expect(customSchemaTs).toContain(
      's1: integer("s1").default(sql`nextval(\'ks."seq\\${globalThis.__ksPwned = 2}"\')`)'
    );
    expect(customSchemaTs).toContain(
      's2: integer("s2").default(sql`nextval(\'ks."tick\\`seq"\')`)'
    );
    expect(customSchemaTs).toContain(
      "cc: varchar(\"cc\").default(sql`('a */ b' || 'c')`)"
    );
    expect(customSchemaTs).toContain(
      `vs: varchar("vs").default("it's */ done")`
    );
  });

  test('allocates unique identifiers for tables and columns', () => {
    expect(customSchemaTs).toContain(
      'export const classTable = ksSchema.table("class"'
    );
    expect(customSchemaTs).toContain(
      'export const deleteTable = ksSchema.table("delete"'
    );
    expect(customSchemaTs).toContain(
      'export const integerTable = ksSchema.table("integer"'
    );
    expect(customSchemaTs).toContain(
      'export const ksSchema2 = ksSchema.table("ks_schema"'
    );
    expect(customSchemaTs).toContain('export const pgSchema2 = pgSchema("pg")');
    expect(customSchemaTs).toContain(
      'export const ksUsers = ksSchema.table("users"'
    );
    expect(customSchemaTs).toContain(
      'export const ks2Users = ks2Schema.table("users"'
    );
    expect(customSchemaTs).toContain(`userId: integer("user_id")`);
    expect(customSchemaTs).toContain(`userId2: integer("user__id")`);
    // A table named `t` is referenced by `child`, so the callback parameter
    // must not shadow it.
    expect(customSchemaTs).toContain(
      'foreignKey({ columns: [t2.tId], foreignColumns: [t.id], name: "child_t_id_id_fkey" })'
    );
    expect(customSchemaTs).toContain(`foreignColumns: [parents["first name"]]`);
  });

  test('emits constraints that match column properties', () => {
    expect(customSchemaTs).toContain(
      `primaryKey({ columns: [t["first name"]], name: "cols_first name_pkey" })`
    );
    expect(customSchemaTs).toContain(`unique("cols_email_key").on(t.email)`);
    expect(customSchemaTs).toContain(`unique("cols_1col_key").on(t["1col"])`);
    expect(customSchemaTs).toContain(`.on(t.userId, t.userId2)`);
    expect(customSchemaTs).toContain(
      `foreignKey({ columns: [t.mgr], foreignColumns: [t.id], name: "emp_mgr_id_fkey" })`
    );
  });

  test('emits defaults that match the column builder', () => {
    const expected = [
      `b: boolean("b").default(true)`,
      `b2: boolean("b2").default(false)`,
      'u: uuid("u").default(sql`uuid()`)',
      'x: integer("x").default(sql`(1 + 2)`)',
      `v: varchar("v").default("5")`,
      `n: integer("n").default(-1)`,
      `d: doublePrecision("d").default(1000.0)`,
      'big: bigint("big", { mode: \'bigint\' }).default(sql`9007199254740993`)',
      `dec: numeric("dec", { precision: 10, scale: 2 }).default("1.5")`,
      'tstz: duckDbTimestamp("tstz", { withTimezone: true }).default(sql`now()`)',
      'ts: duckDbTimestamp("ts").default(sql`current_timestamp`)',
      `tsl: duckDbTimestamp("tsl").default("2024-01-01 00:00:00")`,
      'dt: duckDbDate("dt").default(sql`current_date`)',
      `dd: duckDbDate("dd").default("2024-01-01")`,
      `j: duckDbJson("j").default("{}")`,
      `r: real("r").default(1.5)`,
      `f: real("f")`,
      'g: integer("g").generatedAlwaysAs(sql`(n + 1)`)',
      `st: duckDbStruct<{ "Nice Name": number | null; "tags": Array<string | null> | null }>("st", { "Nice Name": "INTEGER", "tags": "VARCHAR[]" })`,
      `mp: duckDbMap<Record<string, Array<number | null> | null>>("mp", "INTEGER[]", { mode: 'object' })`,
    ];
    for (const fragment of expected) {
      expect(customSchemaTs).toContain(fragment);
    }

    expect(pgTimeSchemaTs).toContain(
      `tstz: timestamp("tstz", { withTimezone: true }).defaultNow()`
    );
    expect(pgTimeSchemaTs).toContain(`ts: timestamp("ts").defaultNow()`);
    expect(pgTimeSchemaTs).toContain(
      'tsl: timestamp("tsl").default(sql`\'2024-01-01 00:00:00\'`)'
    );
    expect(pgTimeSchemaTs).toContain(`dd: date("dd").default("2024-01-01")`);
  });

  test('imports sql only when a default uses it', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    try {
      await conn.run(`create table plain (id integer default 1, name varchar)`);
      const result = await introspect(drizzle(conn));
      expect(result.files.schemaTs).not.toContain(`from 'drizzle-orm';`);
    } finally {
      conn.closeSync();
    }
  });

  test('generated module loads without side effects and resolves references', async () => {
    delete (globalThis as { __ksPwned?: unknown }).__ksPwned;
    const mod = (await import(path.join(tmpDir, 'schema.ts'))) as Record<
      string,
      unknown
    >;
    expect((globalThis as { __ksPwned?: unknown }).__ksPwned).toBeUndefined();

    const tables = Object.values(mod).filter(
      (value): value is PgTable => value instanceof PgTable
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      expect(() => getTableConfig(table)).not.toThrow();
    }

    const child = getTableConfig(mod.child as PgTable);
    const targets = child.foreignKeys.map(
      (fk) => getTableConfig(fk.reference().foreignTable).name
    );
    expect(targets.sort()).toEqual(['parents', 't']);

    const emp = getTableConfig(mod.emp as PgTable);
    expect(
      getTableConfig(emp.foreignKeys[0]!.reference().foreignTable).name
    ).toBe('emp');

    const cols = getTableConfig(mod.cols as PgTable);
    expect(cols.primaryKeys[0]!.columns.map((c) => c.name)).toEqual([
      'first name',
    ]);
    expect(cols.uniqueConstraints.map((u) => u.getName()).sort()).toEqual([
      'cols_1col_key',
      'cols_email_key',
      'cols_user_id_user__id_key',
    ]);
  });
});

test('maps nested and decimal element types without losing case', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    await conn.run(`create table nested (
      l_dec decimal(10, 2)[],
      a_dec decimal(10, 2)[3],
      mp map(varchar, struct("Nice Name" integer)),
      mk map(integer, varchar)
    )`);
    const { schemaTs } = (await introspect(drizzle(conn))).files;
    expect(schemaTs).toContain(
      `lDec: duckDbList<number | string | null>("l_dec", "DECIMAL(10,2)")`
    );
    expect(schemaTs).toContain(
      `aDec: duckDbArray<number | string | null>("a_dec", "DECIMAL(10,2)", 3)`
    );
    expect(schemaTs).toContain(
      `mp: duckDbMap<Record<string, { "Nice Name": number | null } | null>>("mp", "STRUCT(\\"Nice Name\\" INTEGER)", { mode: 'object' })`
    );
    expect(schemaTs).toContain(
      `mk: duckDbMap<Record<string, string | null>>("mk", "VARCHAR", { mode: 'object', keyType: "INTEGER" })`
    );
  } finally {
    conn.closeSync();
  }
});

describe('introspection with allDatabases', () => {
  test('keeps same-named tables from different databases apart', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    try {
      await conn.run(`attach ':memory:' as other_db`);
      await conn.run(
        `create table memory.main.users (id integer, name varchar)`
      );
      await conn.run(
        `create table other_db.main.users (id integer, email varchar)`
      );

      const result = await introspect(drizzle(conn), { allDatabases: true });
      const users = result.files.metaJson.filter(
        (table) => table.name === 'users'
      );
      expect(
        users.map((table) => [table.database, table.columns.length])
      ).toEqual([
        ['memory', 2],
        ['other_db', 2],
      ]);
      expect(result.files.schemaTs).toContain(
        'export const memoryMainUsers = mainSchema.table("users"'
      );
      expect(result.files.schemaTs).toContain(
        'export const otherDbMainUsers = mainSchema.table("users"'
      );
    } finally {
      conn.closeSync();
    }
  });
});
