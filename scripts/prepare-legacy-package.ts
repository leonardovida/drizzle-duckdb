import { readFile, writeFile } from 'node:fs/promises';

// Run only in a disposable release checkout after installing the locked deps.
// Keep generated schemas and the shipped README usable with the legacy name.
const currentName = '@duckdbfan/drizzle-duckdb';
const legacyName = '@leonardovida-md/drizzle-neo-duckdb';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.name !== currentName) {
  throw new Error(`Expected ${currentName}, received ${manifest.name}`);
}

for (const path of [
  'package.json',
  'README.md',
  'src/introspect.ts',
  'test/helpers-import-path.test.ts',
  'test/introspect.typecheck.test.ts',
]) {
  const content = await readFile(path, 'utf8');
  if (!content.includes(currentName)) {
    throw new Error(`Missing package name in ${path}`);
  }
  await writeFile(path, content.replaceAll(currentName, legacyName));
}
