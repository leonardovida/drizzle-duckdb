#!/usr/bin/env bun
/**
 * Publishes the package under both npm scopes:
 * - @duckdbfan/drizzle-duckdb (canonical)
 * - @leonardovida-md/drizzle-neo-duckdb (legacy)
 *
 * Usage: bun run publish:dual [--dry-run]
 */

import { $ } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';

const PACKAGE_JSON_PATH = new URL('../package.json', import.meta.url).pathname;
const CANONICAL_NAME = '@duckdbfan/drizzle-duckdb';
const LEGACY_NAME = '@leonardovida-md/drizzle-neo-duckdb';

const dryRun = process.argv.includes('--dry-run');

async function readPackageJson() {
  const content = await readFile(PACKAGE_JSON_PATH, 'utf-8');
  return JSON.parse(content);
}

async function writePackageJson(pkg: Record<string, unknown>) {
  await writeFile(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

async function publish(name: string) {
  console.log(`\nPublishing as ${name}...`);

  if (dryRun) {
    console.log('  [dry-run] Would run: bun publish --access public');
    return true;
  }

  try {
    await $`bun publish --access public`.quiet();
    console.log(`  Published ${name}`);
    return true;
  } catch (error) {
    console.error(`  Failed to publish ${name}:`, error);
    return false;
  }
}

async function main() {
  let originalPkg: Record<string, unknown> | undefined;
  let publishFailed = false;

  if (dryRun) {
    console.log('Running in dry-run mode (no actual publishing)\n');
  }

  try {
    originalPkg = await readPackageJson();
    const version = originalPkg.version;

    console.log(`Publishing version ${version} to both scopes...`);

    // Ensure we're built
    console.log('\nBuilding...');
    if (!dryRun) {
      await $`bun run build`.quiet();
    }

    // Publish the canonical package first.
    await writePackageJson({ ...originalPkg, name: CANONICAL_NAME });
    const canonicalResult = await publish(CANONICAL_NAME);

    // Publish the legacy package name for backwards compatibility.
    await writePackageJson({ ...originalPkg, name: LEGACY_NAME });
    const legacyResult = await publish(LEGACY_NAME);

    console.log('\n--- Summary ---');
    console.log(`${CANONICAL_NAME}: ${canonicalResult ? 'success' : 'failed'}`);
    console.log(`${LEGACY_NAME}: ${legacyResult ? 'success' : 'failed'}`);

    publishFailed = !canonicalResult || !legacyResult;
  } finally {
    if (originalPkg) {
      await writePackageJson(originalPkg);
    }
  }

  if (publishFailed) {
    throw new Error('One or more publish steps failed');
  }
}

main().catch((err) => {
  console.error('Publish failed:', err);
  process.exit(1);
});
