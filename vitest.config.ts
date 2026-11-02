import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ hold full copies of test/. Collecting
    // them runs every suite twice, and the copies race on test/.tmp.
    exclude: [...configDefaults.exclude, '.claude/**', 'test/.tmp/**'],
  },
});
