import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { migrate } from '../src/migrator.ts';
import { writeMigrationFolders } from './utils.ts';

const migrations = [
  {
    hash: 'journal-migration',
    name: 'journal-migration',
    folderMillis: 1000,
    sql: ['create table journal_effects (id integer)'],
    bps: true,
  },
];

test.each([
  ['migrationsTable', { migrationsTable: 'mig"x' }],
  ['migrationsSchema', { migrationsSchema: 's"q' }],
])(
  '%s containing a double quote fails with a clear error',
  async (option, names) => {
    const db = await drizzle(':memory:');
    try {
      await expect(
        db.dialect.migrate(migrations, db.session, {
          migrationsFolder: '.',
          ...names,
        })
      ).rejects.toThrow(
        `Invalid ${option} ${JSON.stringify(Object.values(names)[0])}: migration journal names cannot contain double quotes`
      );
      // Nothing was created or applied.
      const tables = await db.execute<{ name: string }>(
        sql`select table_name as name from information_schema.tables where table_name = 'journal_effects'`
      );
      expect(tables).toEqual([]);
    } finally {
      await db.close();
    }
  }
);

test('folders converted by drizzle-kit up skip migrations a 2.x journal recorded', async () => {
  // 2.x stored the millisecond `when` of meta/_journal.json as created_at.
  // drizzle-kit up names each folder after the UTC second of that `when`, so
  // the folder time never exceeds the recorded created_at.
  const when = 1_680_271_923_328;
  const folder = await mkdtemp(join(tmpdir(), 'drizzle-duckdb-up-'));
  const db = await drizzle(':memory:');
  try {
    await db.dialect.migrate(
      [
        {
          hash: 'applied-by-2x',
          name: 'applied-by-2x',
          folderMillis: when,
          sql: ['create table upgraded_init (id integer)'],
          bps: true,
        },
      ],
      db.session,
      { migrationsFolder: folder }
    );
    writeMigrationFolders(folder, [
      { tag: 'init', when, sql: 'create table upgraded_init (id integer);' },
      {
        tag: 'next',
        when: when + 1000,
        sql: 'create table upgraded_next (id integer);',
      },
    ]);

    await migrate(db, { migrationsFolder: folder });

    expect(
      await db.execute(
        sql`select cast(created_at as varchar) as created_at from drizzle.__drizzle_migrations order by created_at`
      )
    ).toEqual([
      { created_at: '1680271923328' },
      { created_at: '1680271924000' },
    ]);
    expect(
      await db.execute(
        sql`select table_name from information_schema.tables where table_name like 'upgraded_%' order by table_name`
      )
    ).toEqual([
      { table_name: 'upgraded_init' },
      { table_name: 'upgraded_next' },
    ]);
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('journal names with other special characters still work', async () => {
  const db = await drizzle(':memory:');
  try {
    await db.dialect.migrate(migrations, db.session, {
      migrationsFolder: '.',
      migrationsSchema: "My Schema's",
      migrationsTable: 'Mig.Table?',
    });
    expect(
      await db.execute(sql`select hash from "My Schema's"."Mig.Table?"`)
    ).toEqual([{ hash: 'journal-migration' }]);
  } finally {
    await db.close();
  }
});

async function canLoadDuckLake(): Promise<boolean> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('LOAD ducklake');
    return true;
  } catch {
    return false;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

describe.skipIf(!(await canLoadDuckLake()))('migrate() with DuckLake', () => {
  test('applies migrations with DuckLake as the default catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drizzle-ducklake-mig-'));
    const db = await drizzle(':memory:', {
      ducklake: {
        catalog: join(directory, 'meta.ducklake'),
        install: false,
        attachOptions: { dataPath: join(directory, 'data') },
      },
    });
    const later = {
      hash: 'journal-migration-2',
      name: 'journal-migration-2',
      folderMillis: 2000,
      sql: ['insert into journal_effects values (1)'],
      bps: true,
    };
    try {
      await db.dialect.migrate(migrations, db.session, {
        migrationsFolder: '.',
      });
      // A second run applies only the new migration.
      await db.dialect.migrate([...migrations, later], db.session, {
        migrationsFolder: '.',
      });
      await db.dialect.migrate([...migrations, later], db.session, {
        migrationsFolder: '.',
      });

      expect(
        await db.execute(
          sql`select id, hash from drizzle.__drizzle_migrations order by id`
        )
      ).toEqual([
        { id: 1, hash: 'journal-migration' },
        { id: 2, hash: 'journal-migration-2' },
      ]);
      expect(await db.execute(sql`select id from journal_effects`)).toEqual([
        { id: 1 },
      ]);
      const [catalog] = await db.execute<{ type: string }>(
        sql`select d.type from duckdb_tables() t join duckdb_databases() d using (database_name) where t.table_name = '__drizzle_migrations'`
      );
      expect(catalog).toEqual({ type: 'ducklake' });
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps the journal in the main database when DuckLake is attached with use: false', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drizzle-ducklake-mig-'));
    const db = await drizzle(join(directory, 'app.duckdb'), {
      ducklake: {
        catalog: join(directory, 'meta.ducklake'),
        install: false,
        use: false,
        attachOptions: { dataPath: join(directory, 'data') },
      },
    });
    try {
      await db.dialect.migrate(migrations, db.session, {
        migrationsFolder: '.',
      });
      expect(
        await db.execute(sql`select hash from drizzle.__drizzle_migrations`)
      ).toEqual([{ hash: 'journal-migration' }]);
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
