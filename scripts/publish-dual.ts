#!/usr/bin/env bun
/**
 * Publishes the package under both npm scopes:
 * - @leonardovida-md/drizzle-neo-duckdb (original)
 * - @duckdbfan/drizzle-duckdb (new)
 *
 * Usage: bun run publish:dual [--dry-run]
 */

import { $ } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';

const PACKAGE_JSON_PATH = new URL('../package.json', import.meta.url).pathname;
const ORIGINAL_NAME = '@leonardovida-md/drizzle-neo-duckdb';
const NEW_NAME = '@duckdbfan/drizzle-duckdb';

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
  if (dryRun) {
    console.log('Running in dry-run mode (no actual publishing)\n');
  }

  // Read original package.json
  const originalPkg = await readPackageJson();
  const version = originalPkg.version;

  console.log(`Publishing version ${version} to both scopes...`);

  // Ensure we're built
  console.log('\nBuilding...');
  if (!dryRun) {
    await $`bun run build`.quiet();
  }

  // Publish under original name first
  const pkg1 = { ...originalPkg, name: ORIGINAL_NAME };
  await writePackageJson(pkg1);
  const result1 = await publish(ORIGINAL_NAME);

  // Publish under new name
  const pkg2 = { ...originalPkg, name: NEW_NAME };
  await writePackageJson(pkg2);
  const result2 = await publish(NEW_NAME);

  // Restore original package.json (keep original name as canonical)
  await writePackageJson(originalPkg);

  console.log('\n--- Summary ---');
  console.log(`${ORIGINAL_NAME}: ${result1 ? 'success' : 'failed'}`);
  console.log(`${NEW_NAME}: ${result2 ? 'success' : 'failed'}`);

  if (!result1 || !result2) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Publish failed:', err);
  process.exit(1);
});
