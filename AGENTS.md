# Codex Agent Guide

## Instruction Order

- Follow system and developer messages first.
- Then follow workspace or repo guides such as this file.
- More specific AGENTS.md files override broader ones.
- If instructions conflict, ask the user.

## Safety

- Avoid destructive commands unless the user asks.
- Keep changes focused on the task.
- Do not print secrets or private data.

## Workflow

- Read `README.md`, `CONTRIBUTING.md`, and `git status` before edits.
- Prefer `rg` for search and `apply_patch` for edits.
- Use Bun for installs and scripts.
- For multi step tasks, write a short plan and update it.
- Run relevant tests or linters when practical and report results.

## Deliverables

- Summarize what changed, where, and why.
- Reference file paths with line numbers.

# Repository Guidelines

## Project Structure and Modules

- Source lives in `src/` (`driver.ts`, `session.ts`, `dialect.ts`, `columns.ts`, `migrator.ts`, `utils.ts`) with public reexports from `src/index.ts`.
- Build artifacts in `dist/*.mjs` and `dist/*.d.ts` are generated. Do not edit them by hand. `bun.lockb` and `node_modules/` are managed by Bun.
- Tests live in `test/`. `test/duckdb.test.ts` mirrors upstream Drizzle Postgres coverage and is long. Add new specs in `test/<feature>.test.ts` unless you need to touch the big suite. Migration snapshots for integration runs sit in `test/drizzle2/pg` and DuckDB specific migrations in `test/duckdb/pg`. `meta/` holds the journals.

## Build, Test, and Development

- Use Bun. Main commands are `bun install`, `bun run build`, `bun run build:declarations`, `bun test`, and `bun run t`.
- ESM only. `moduleResolution` is `bundler` and imports include `.ts` extensions. Keep relative paths explicit and prefer `import type` when you only need types.
- Do not add Postgres JSON or JSONB columns. The dialect rejects them. Use `duckDbJson` if you need DuckDB JSON.

## Coding Style and Patterns

- Use 2 space indentation and trailing commas on multi line literals. Prefer named exports over defaults. Helpers use camelCase and classes use PascalCase.
- Collapse reexports in `src/index.ts` and stick to modern syntax such as `??` and optional chaining. Avoid `any` unless DuckDB bindings lack types.
- Document DuckDB compared with Postgres behavior inline, such as aliasing or result mapping quirks in `utils.ts` and `DuckDBSelectBuilder`.

## DuckDB Runtime Notes

- Preferred client is `@duckdb/node-api@1.4.4-r.1`. Tests use it. For hermetic runs, use `DuckDBInstance.create(':memory:')` or `DuckDBConnection.create`.
- Clean up connections with `closeSync`, `close`, or `disconnectSync`. Avoid leaving `.duckdb` files in the repo.
- Custom column helpers live in `src/columns.ts` (`duckDbStruct`, `duckDbMap`, `duckDbBlob`). For JSON like structures, use these helpers or Drizzle custom types, not Postgres JSON columns.

## Testing Guidelines

- Use Vitest only. Share utilities via `test/utils.ts`. When exercising migrations, mirror layouts under `test/drizzle2/pg/meta` or `test/duckdb/pg/meta` and keep snapshots in sync.
- The large `test/duckdb.test.ts` sets up sequences and schemas in `beforeAll` and `beforeEach`. Follow that pattern or create fresh tables in new files to avoid cross test bleed.
- Regression tests should cover DuckDB specific branches such as aliasing, selection mapping, transaction handling, and migrator behavior.
- Perf benchmarks use `bun x vitest bench --run test/perf --pool=threads --poolOptions.threads.singleThread=true --no-file-parallelism`. Add `--outputJson perf-results/latest.json` if you need an artifact. Vitest 1.6 rejects the `--runInBand` flag.

## Commit and Pull Request Guidelines

- Use short, imperative subjects under 72 chars, for example `Add migrator to exports`.
- Include a body when documenting workarounds or DuckDB quirks. Reference DuckDB tickets inline.
- PRs should link issues, summarize behavior changes, call out schema and migration updates, and attach `bun test` and `bun run build` output. Screenshots help when showing SQL traces or planner output.

## Writing Style

- Avoid em dashes and sentence dashes.
- Avoid semicolons.
- Avoid heavy adjectives and adverbs.
- Avoid using an ampersand in sentences.
