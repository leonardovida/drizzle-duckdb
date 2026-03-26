#!/usr/bin/env bun

import { $ } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type PackageJson = Record<string, unknown> & {
  name?: string;
  version?: string;
};

type PublishResult = 'dry-run' | 'published' | 'skipped';

type ExecFileError = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};

const PACKAGE_JSON_PATH = new URL('../package.json', import.meta.url);
const execFileAsync = promisify(execFile);

const targets = [
  '@duckdbfan/drizzle-duckdb',
  '@leonardovida-md/drizzle-neo-duckdb',
] as const;

const dryRun = process.argv.includes('--dry-run');

async function readPackageJson(): Promise<PackageJson> {
  const content = await readFile(PACKAGE_JSON_PATH, 'utf8');
  return JSON.parse(content);
}

async function writePackageJson(pkg: PackageJson) {
  await writeFile(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

async function isPublishedVersion(name: string, version: string) {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', `${name}@${version}`, 'version'],
      { env: process.env }
    );

    return stdout.trim() === version;
  } catch (error) {
    const execError = error as ExecFileError;
    const stderr = execError.stderr ?? '';

    if (
      stderr.includes('E404') ||
      stderr.includes('No match found for version') ||
      stderr.includes('404')
    ) {
      return false;
    }

    throw error;
  }
}

async function publishTarget(
  originalPkg: PackageJson,
  targetName: string,
  version: string
) {
  if (await isPublishedVersion(targetName, version)) {
    console.log(`Skipping ${targetName}@${version}, already published`);
    return 'skipped' satisfies PublishResult;
  }

  await writePackageJson({
    ...originalPkg,
    name: targetName,
  });

  if (dryRun) {
    console.log(`[dry-run] Would publish ${targetName}@${version}`);
    return 'dry-run' satisfies PublishResult;
  }

  console.log(`Publishing ${targetName}@${version}`);
  await $`npm publish --access public`;
  return 'published' satisfies PublishResult;
}

async function main() {
  const originalPkg = await readPackageJson();
  const version = originalPkg.version;

  if (!version) {
    throw new Error('package.json is missing a version');
  }

  if (dryRun) {
    console.log('Running dual publish in dry-run mode');
  }

  const results = new Map<string, PublishResult>();

  try {
    for (const targetName of targets) {
      const result = await publishTarget(originalPkg, targetName, version);
      results.set(targetName, result);
    }
  } finally {
    await writePackageJson(originalPkg);
  }

  console.log('\nPublish summary:');

  for (const targetName of targets) {
    const result = results.get(targetName);
    console.log(`- ${targetName}@${version}: ${result}`);
  }
}

await main();
