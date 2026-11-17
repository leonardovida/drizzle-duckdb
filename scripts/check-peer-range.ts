#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import semver from 'semver';

// Every @duckdb/node-api build is published as X.Y.Z-r.N, which semver treats
// as a prerelease. A range matches a prerelease only through a clause on the
// same X.Y.Z, so each new patch release needs its own clause. This lists the
// published builds on supported release lines that the peer range rejects.
const name = '@duckdb/node-api';
const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
  peerDependencies: Record<string, string>;
};
const range = manifest.peerDependencies[name]!;
// The plain X.Y.Z comparator bounds the supported lines, for example
// `>=1.4.4 <1.6.0`.
const supported = range.split('||')[0]!.trim();

const response = await fetch(`https://registry.npmjs.org/${name}`, {
  headers: { accept: 'application/vnd.npm.install-v1+json' },
});
if (!response.ok) {
  throw new Error(`npm registry returned HTTP ${response.status} for ${name}`);
}
const { versions } = (await response.json()) as {
  versions: Record<string, unknown>;
};

const missing = Object.keys(versions).filter((version) => {
  const base = version.split('-')[0]!;
  return semver.satisfies(base, supported) && !semver.satisfies(version, range);
});

if (missing.length > 0) {
  console.error(
    `${name} builds outside the peer range: ${missing.join(', ')}.\n` +
      'Add a clause for each release line to peerDependencies in package.json, ' +
      'test against it, and release.'
  );
  process.exit(1);
}
console.log(
  `Every published ${name} build in ${supported} satisfies the range.`
);
