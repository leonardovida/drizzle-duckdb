import { describe, expect, it, vi } from 'vitest';

describe('client-safe helpers entry', () => {
  it('uses helpers import base for introspection', async () => {
    const { DEFAULT_IMPORT_BASE } = await import('../src/introspect.ts');
    expect(DEFAULT_IMPORT_BASE).toBe('@duckdbfan/drizzle-duckdb/helpers');
  });

  it('helpers entry stays free of native binding imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(testDir, '../src/helpers.ts'), 'utf8');
    expect(content.includes('@duckdb/node-api')).toBe(false);
  });
});
