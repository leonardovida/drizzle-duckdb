import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { asc, sql } from 'drizzle-orm';
import { getViewConfig, PgTable, PgView } from 'drizzle-orm/pg-core';
import { drizzle } from '../src/index';
import { introspect } from '../src/introspect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Catalog details that introspection used to lose: generated columns,
// non-literal defaults, unsigned and 128-bit integers, views, CHECK
// constraints and indexes.
const DDL = [
  `create schema cf`,
  `create sequence cf.account_seq`,
  `create table cf.accounts (
    id uuid primary key default gen_random_uuid(),
    seq integer not null default nextval('cf.account_seq'),
    email varchar not null,
    created date not null default current_date,
    launched date not null default cast('2024-01-01' as date),
    score integer not null default (1 + 2),
    email_domain varchar generated always as (split_part(email, '@', 2)),
    tricky varchar generated always as ('\`\${globalThis.__cfPwned = 1}*/' || email),
    positive integer check (positive > 0)
  )`,
  `create index accounts_email_idx on cf.accounts (email)`,
  `create table cf.counters (
    id integer primary key,
    ut utinyint,
    us usmallint,
    ui uinteger,
    ub ubigint,
    h hugeint,
    uh uhugeint
  )`,
  `create view cf.account_domains as select id, email_domain from cf.accounts`,
];

const tmpDir = path.join(
  process.cwd(),
  'test/.tmp/introspect-catalog-fidelity'
);
const helpersPath = path.join(process.cwd(), 'src/helpers.ts');

let connection: DuckDBConnection;
let schemaTs: string;
let mod: Record<string, unknown>;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  for (const statement of DDL) {
    await connection.run(statement);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const result = await introspect(drizzle(connection), {
    schemas: ['cf'],
    includeViews: true,
    importBasePath: path.relative(tmpDir, helpersPath),
  });
  schemaTs = result.files.schemaTs;
  fs.writeFileSync(path.join(tmpDir, 'schema.ts'), schemaTs);

  delete (globalThis as { __cfPwned?: unknown }).__cfPwned;
  mod = (await import(path.join(tmpDir, 'schema.ts'))) as Record<
    string,
    unknown
  >;
});

afterAll(() => {
  connection?.closeSync();
});

function runTsc(files: string[]): void {
  const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({
      extends: path.relative(tmpDir, path.join(process.cwd(), 'tsconfig.json')),
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      },
      files,
    })
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

describe('generated columns', () => {
  test('emits generatedAlwaysAs instead of a default', () => {
    expect(schemaTs).toContain(
      'emailDomain: varchar("email_domain").generatedAlwaysAs(sql`split_part(email, \'@\', 2)`)'
    );
    expect(schemaTs).not.toContain('/* default: CAST(');
  });

  test('escapes the generation expression', () => {
    expect(schemaTs).toContain(
      'tricky: varchar("tricky").generatedAlwaysAs(sql`(\'\\`\\${globalThis.__cfPwned = 1}*/\' || email)`)'
    );
    expect((globalThis as { __cfPwned?: unknown }).__cfPwned).toBeUndefined();
  });

  test('inserts through the generated schema and reads the value back', async () => {
    const db = drizzle(connection);
    await db
      .insert(mod.accounts as PgTable)
      .values({ email: 'ada@example.com', positive: 1 } as never);
    const rows = await db.execute<{
      email_domain: string;
      tricky: string;
      score: number;
    }>(sql`select email_domain, tricky, score from cf.accounts`);
    expect(rows).toEqual([
      {
        email_domain: 'example.com',
        tricky: '`${globalThis.__cfPwned = 1}*/ada@example.com',
        score: 3,
      },
    ]);
  });
});

describe('defaults', () => {
  test('emits unrecognized defaults as sql defaults', () => {
    const expected = [
      'id: uuid("id").notNull().default(sql`gen_random_uuid()`)',
      'seq: integer("seq").notNull().default(sql`nextval(\'cf.account_seq\')`)',
      'created: duckDbDate("created").notNull().default(sql`current_date`)',
      // DuckDB 1.5 quotes the type name, 1.4 does not.
      'launched: duckDbDate("launched").notNull().default(sql`CAST(\'2024-01-01\' AS ',
      'score: integer("score").notNull().default(sql`(1 + 2)`)',
    ];
    for (const fragment of expected) {
      expect(schemaTs).toContain(fragment);
    }
  });
});

describe('integer types', () => {
  test('maps unsigned and 128-bit integers to numeric builders', () => {
    const expected = [
      'ut: integer("ut")',
      'us: integer("us")',
      'ui: integer("ui")',
      `ub: bigint("ub", { mode: 'bigint' })`,
      `h: bigint("h", { mode: 'bigint' })`,
      `uh: bigint("uh", { mode: 'bigint' })`,
    ];
    for (const fragment of expected) {
      expect(schemaTs).toContain(fragment);
    }
    expect(schemaTs).not.toContain('unsupported DuckDB type');
  });

  test('round-trips extreme values with the runtime types', async () => {
    const db = drizzle(connection);
    const counters = mod.counters as PgTable;
    const values = {
      id: 1,
      ut: 255,
      us: 65535,
      ui: 4294967295,
      ub: 18446744073709551615n,
      h: -170141183460469231731687303715884105728n,
      // Bound parameters travel as HUGEINT, so UHUGEINT writes stop at the
      // HUGEINT maximum. Reads cover the full range below.
      uh: 170141183460469231731687303715884105727n,
    };
    await db.insert(counters).values(values as never);
    await connection.run(
      `insert into cf.counters (id, uh) values (2, 340282366920938463463374607431768211455)`
    );
    const rows = await db
      .select()
      .from(counters)
      .orderBy(asc(sql`id`));
    expect(rows).toEqual([
      values,
      {
        id: 2,
        ut: null,
        us: null,
        ui: null,
        ub: null,
        h: null,
        uh: 340282366920938463463374607431768211455n,
      },
    ]);
  });
});

describe('views', () => {
  test('emits views as existing views', () => {
    expect(schemaTs).toContain(
      'export const accountDomains = cfSchema.view("account_domains", {'
    );
    expect(schemaTs).toContain('}).existing();');
    expect(mod.accountDomains).toBeInstanceOf(PgView);
    const config = getViewConfig(mod.accountDomains as PgView);
    expect(config.name).toBe('account_domains');
    expect(config.schema).toBe('cf');
    expect(config.isExisting).toBe(true);
  });

  test('selects from the generated view', async () => {
    const db = drizzle(connection);
    await connection.run(`delete from cf.accounts`);
    await connection.run(
      `insert into cf.accounts (email) values ('b@one.test'), ('a@two.test')`
    );
    const rows = await db
      .select()
      .from(mod.accountDomains as PgView)
      .orderBy(asc(sql`email_domain`));
    expect(rows.map((row) => row.emailDomain)).toEqual([
      'one.test',
      'two.test',
    ]);
  });
});

describe('check constraints and indexes', () => {
  test('lists them as comments', () => {
    expect(schemaTs).toContain(
      '/* check "accounts_positive_check" (not emitted): CHECK((positive > 0)) */'
    );
    // DuckDB normalizes the index statement text.
    expect(schemaTs).toMatch(
      /\/\* index "accounts_email_idx" \(not emitted\): CREATE INDEX accounts_email_idx ON .*\(email\);? \*\//
    );
  });
});

test('generated schema and its insert types pass tsc --strict', () => {
  fs.writeFileSync(
    path.join(tmpDir, 'usage.ts'),
    `import type { DuckDBDatabase } from '${path.relative(
      tmpDir,
      path.join(process.cwd(), 'src/driver.ts')
    )}';
import { accountDomains, accounts, counters } from './schema.ts';

// Columns with a default or a generation expression are optional.
export const minimal: typeof accounts.$inferInsert = { email: 'a@b.c' };

export const generated: typeof accounts.$inferInsert = {
  email: 'a@b.c',
  // @ts-expect-error generated columns cannot be inserted
  emailDomain: 'b.c',
};

export const counter: typeof counters.$inferSelect = {
  id: 1,
  ut: 1,
  us: 1,
  ui: 4294967295,
  ub: 1n,
  h: 1n,
  uh: 1n,
};

export const domain: string | null = ({} as typeof accountDomains.$inferSelect)
  .emailDomain;

export function insertIntoView(db: DuckDBDatabase) {
  // @ts-expect-error views cannot be inserted into
  return db.insert(accountDomains);
}
`
  );
  runTsc(['schema.ts', 'usage.ts']);
}, 60_000);

describe('databases other than the current one', () => {
  let conn: DuckDBConnection;

  beforeAll(async () => {
    const instance = await DuckDBInstance.create(':memory:');
    conn = await instance.connect();
    await conn.run(`attach ':memory:' as "other*/db"`);
    await conn.run(`create table memory.main.users (id integer)`);
    await conn.run(`create table "other*/db".main.orders (id integer)`);
    await conn.run(`create temp table scratch (id integer)`);
  });

  afterAll(() => {
    conn?.closeSync();
  });

  test('does not warn for the current database', async () => {
    const { schemaTs } = (await introspect(drizzle(conn))).files;
    expect(schemaTs).not.toContain('databases other than the current one');
  });

  test('warns when a table comes from another database', async () => {
    const { schemaTs } = (
      await introspect(drizzle(conn), { database: 'other*/db' })
    ).files;
    expect(schemaTs).toContain(
      'Some tables come from databases other than the current one ("memory"):'
    );
    expect(schemaTs).toContain(' * "other*\\/db".');
    expect(schemaTs).toContain('/* database: "other*\\/db" */');
    expect(schemaTs).toContain('mainSchema.table("orders"');
  });

  test('skips the temp catalog with allDatabases', async () => {
    // information_schema reports temp tables as LOCAL TEMPORARY, so they
    // only passed the table type filter when views were included.
    const result = await introspect(drizzle(conn), {
      allDatabases: true,
      includeViews: true,
    });
    expect(
      result.files.metaJson.map((table) => [table.database, table.name])
    ).toEqual([
      ['memory', 'users'],
      ['other*/db', 'orders'],
    ]);
    expect(result.files.schemaTs).not.toContain('scratch');
    expect(result.files.schemaTs).toContain('/* database: "other*\\/db" */');
  });
});

test('does not import pgSchema when nothing matched', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    const { schemaTs } = (await introspect(drizzle(conn))).files;
    expect(schemaTs).not.toContain('pgSchema');
    expect(schemaTs).toContain('export {};');
  } finally {
    conn.closeSync();
  }
});
