import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { drizzle } from '../src/index';
import { introspect } from '../src/introspect';
import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let connection: DuckDBConnection;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();

  const db = drizzle(connection);

  await db.execute(sql`create schema if not exists tc`);
  await db.execute(sql`
    create table tc.metrics (
      id integer primary key,
      visits bigint not null,
      tags integer[],
      created_at timestamp with time zone
    )
  `);
});

afterAll(() => {
  connection?.closeSync();
});

test('generated schema type-checks with tsc', async () => {
  const db = drizzle(connection);
  const tmpDir = path.join(process.cwd(), 'test/.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const schemaPath = path.join(tmpDir, 'tc-schema.ts');

  const importBasePath = '@leonardovida-md/drizzle-neo-duckdb';

  const result = await introspect(db, {
    schemas: ['tc'],
    importBasePath,
  });

  fs.writeFileSync(schemaPath, result.files.schemaTs, 'utf8');

  const tsconfigPath = path.join(tmpDir, 'tsconfig.generated.json');
  const tsconfig = {
    extends: path.relative(tmpDir, path.join(process.cwd(), 'tsconfig.json')),
    compilerOptions: {
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      moduleResolution: 'bundler',
      module: 'ESNext',
      target: 'ESNext',
      // baseUrl is required for TS to apply `paths` mappings below
      baseUrl: '.',
      paths: {
        '@leonardovida-md/drizzle-neo-duckdb': [
          path.relative(tmpDir, path.join(process.cwd(), 'src', 'index.ts')),
          path.relative(tmpDir, path.join(process.cwd(), 'dist', 'index.d.ts')),
        ],
      },
    },
    include: [path.basename(schemaPath)],
  };

  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

  const tscPath = path.join(process.cwd(), 'node_modules', '.bin', 'tsc');
  try {
    execFileSync(tscPath, ['--pretty', 'false', '--project', tsconfigPath], {
      stdio: 'pipe',
    });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message: string };
    const stdout = err.stdout?.toString() ?? '';
    const stderr = err.stderr?.toString() ?? '';
    throw new Error(
      `tsc failed on generated schema. stdout: ${stdout}\nstderr: ${stderr}\nmessage: ${err.message}`
    );
  }

  expect(true).toBe(true);
}, 20_000);
