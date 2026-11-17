import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import semver from 'semver';

describe('package.json configuration', () => {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
  );

  test('should not contain platform-specific DuckDB bindings in dependencies', () => {
    const deps = packageJson.dependencies || {};
    const devDeps = packageJson.devDependencies || {};
    const allDeps = { ...deps, ...devDeps };

    const platformSpecificBindings = Object.keys(allDeps).filter((dep) =>
      dep.startsWith('@duckdb/node-bindings-')
    );

    expect(platformSpecificBindings).toEqual([]);
  });

  test('should have @duckdb/node-api as peer dependency', () => {
    const peerDeps = packageJson.peerDependencies || {};
    expect(peerDeps['@duckdb/node-api']).toBeDefined();
  });

  test('declares peer ranges for published DuckDB API release lines', () => {
    const range = packageJson.peerDependencies?.['@duckdb/node-api'];
    const supportedReleaseLines = [
      '>=1.4.4-r.1 <1.4.5',
      '>=1.4.5-r.1 <1.4.6',
      '>=1.5.0-r.1 <1.5.1',
      '>=1.5.1-r.1 <1.5.2',
      '>=1.5.2-r.1 <1.5.3',
      '>=1.5.3-r.1 <1.5.4',
      '>=1.5.4-r.1 <1.5.5',
      '>=1.5.5-r.1 <1.5.6',
      '>=1.5.6-r.1 <1.5.7',
    ];

    expect(range).toBeDefined();
    for (const releaseLine of supportedReleaseLines) {
      expect(range.split(' || ')).toContain(releaseLine);
    }
  });

  // A new -r.N build needs its own clause in the peer range. Bumping the dev
  // copy past the range fails here instead of in a consumer's install.
  test('the installed peers satisfy the declared peer ranges', () => {
    for (const name of ['@duckdb/node-api', 'drizzle-orm']) {
      const installed = packageJson.devDependencies[name];
      const range = packageJson.peerDependencies[name];
      expect(
        semver.satisfies(installed, range),
        `${name}@${installed} is outside the peer range ${range}`
      ).toBe(true);
    }
  });

  test('DuckDB API can be imported and instantiated', async () => {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    expect(instance).toBeDefined();

    const connection = await instance.connect();
    const result = await connection.run('SELECT 1 as value');
    expect(result).toBeDefined();
  });
});
