# Contributing

Thanks for helping improve `@duckdbfan/drizzle-duckdb`. This guide covers local
setup, checks, and releases. See `AGENTS.md` for code style and test layout.

## Setup

The project uses [Bun](https://bun.sh) for installs and scripts.

```sh
bun install
```

## Checks

Run these before opening a pull request. CI runs the same commands.

```sh
bun run test                                      # Vitest suite
bunx tsc --noEmit --project tsconfig.check.json   # type check
bunx prettier --check .                           # formatting
bun run build                                     # build dist/
```

Use `bunx prettier --write .` to fix formatting. Tests that need MotherDuck
skip unless `MOTHERDUCK_TOKEN` is set.

## Git hooks

The repository ships hooks in `.githooks/`. They are not enabled by default.
To run the formatting and type checks before each commit and the test suite
before each push, point Git at them once per clone:

```sh
git config core.hooksPath .githooks
```

If you use [pre-commit](https://pre-commit.com), run `pre-commit install`
instead. It uses `.pre-commit-config.yaml`, which adds file checks and gitleaks.

## Pull requests

- Keep changes focused and add tests for DuckDB specific behavior.
- Use short, imperative commit subjects, for example `Add migrator to exports`.
- Describe behavior changes and schema or migration updates in the PR.

## Releases

1. Bump `version` in `package.json`.
2. Run `bun run build` and `bun run test`.
3. Commit with a message like `Release v1.3.2` and merge the release PR.
4. Tag the merged commit as `v1.3.2` and push the tag. This triggers the publish
   workflow, which creates a GitHub release after publication succeeds.

Creating a GitHub release from an existing tag also triggers publication.

The publish workflow checks that the tag equals `v` plus the `package.json`
version and skips versions that are already on npm. Versions with a
prerelease suffix, such as `1.6.0-1`, publish under the `next` dist-tag.
Other versions publish under `latest`. For manually created GitHub releases,
the release's prerelease flag determines the dist-tag.
