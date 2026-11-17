import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ hold full copies of test/. Collecting
    // them runs every suite twice, and the copies race on test/.tmp.
    exclude: [...configDefaults.exclude, '.claude/**', 'test/.tmp/**'],
    benchmark: {
      // The warning counts every module export getter call in a shared Map,
      // which slows per-row paths measurably. Vitest 4 did not count them, so
      // turning it off keeps results comparable with the benchmark history.
      suppressExportGetterWarnings: true,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLI entry point runs in a subprocess, which v8 coverage of the
      // test process cannot see. Its argument parsing is covered directly.
      exclude: ['src/bin/duckdb-introspect.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Floors a few points under the measured totals, to catch a change
      // that lands without tests.
      thresholds: { lines: 88, statements: 88, functions: 92, branches: 80 },
    },
  },
});
