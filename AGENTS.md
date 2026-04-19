# Repository Guidelines

## Project Structure & Module Organization
- `src/`: core action runtime.
  - `index.js`: orchestration entrypoint (PR file loading, planner/sub-agent parallel loop, publish).
  - `agents.js`: planner and reviewer agent setup with structured-output schemas.
  - `model-runtime.js`: AI SDK structured-output execution with repair retry.
  - `provider.js`: multi-provider factory (OpenAI, Anthropic, Google, Mistral, OpenAI-compatible).
  - `config.js`: action input parsing, validation, and defaults.
  - `diff-map.js`: diff hunk parsing and inline comment line resolution.
  - `aggregate.js`: finding normalization, deduplication, and sorting.
  - `globs.js`: include/exclude glob filtering.
  - `publish.js`: PR review and summary comment publishing with marker-based dedup.
  - `inline-key.js`: stable inline comment key generation for cross-run dedup.
  - `public-error.js`: error message sanitization for public-facing outputs.
  - `repo-guidance.js`: project guidance loader (AGENTS.md / AGENT.md / CLAUDE.md).
- `test/`: Node built-in test suite (`*.test.js`) for all modules above.
- `.github/workflows/`: CI and self-test workflows.
- `examples/`: non-executed example workflow templates for consumers.
- `action.yml`: public action contract (inputs/outputs/defaults).

## Build, Test, and Development Commands
- `npm ci`: install locked dependencies exactly (same as CI).
- `npm run check`: syntax check for `src/index.js`.
- `npm test`: run all unit tests via `node --test`.
- `npm run test:schema-support`: run local compatibility check script.
- `npm start`: run action entrypoint locally (requires GitHub Actions env context to be meaningful).

Use Node `22` (see CI and `package.json` engines).

## Coding Style & Naming Conventions
- Language: Node.js CommonJS (`require/module.exports`), no TypeScript.
- Indentation: 2 spaces; keep files ASCII unless a file already requires non-ASCII.
- Naming:
  - files/modules: lowercase with hyphen where needed (for example `diff-map.js`);
  - functions/variables: `camelCase`;
  - constants: `UPPER_SNAKE_CASE`.
- Keep modules small and single-purpose; add brief comments only when logic is non-obvious.

## Architecture Notes
- Multi-provider support via AI SDK: OpenAI, Anthropic, Google, Mistral, and OpenAI-compatible endpoints.
- Parallel execution within each round: batches run concurrently via `Promise.allSettled` with a shared semaphore (`max_concurrency`); within each batch, `general` dimension runs first, then remaining dimensions run in parallel.
- Round-level execution remains serial (each round depends on updated `coverageState`).
- Budget pre-allocation with 2x multiplier to account for structured-output repair retries.

## Testing Guidelines
- Framework: Node built-in `node:test` + `node:assert/strict`.
- Test files: `test/<module>.test.js`.
- Add/extend tests whenever changing:
  - diff line resolution (`LEFT`/`RIGHT`),
  - finding normalization/deduplication/sorting,
  - publish/update marker behavior,
  - config parsing or validation,
  - provider creation or model instantiation,
  - concurrency control (semaphore) behavior.
- Run locally before PR: `npm run check && npm test`.

## Commit & Pull Request Guidelines
- Follow Conventional Commits with emoji, as used in history:
  - `feat(action): ✨ ...`
  - `ci(workflows): 👷 ...`
- Prefer atomic commits (separate feature, CI, docs, and test-only changes when practical).
- PRs should include:
  - change summary and motivation,
  - impacted inputs/outputs in `action.yml`,
  - test evidence (`npm test`, CI status),
  - any behavior changes for fork PR/security/token handling.

## Security & Configuration Tips
- Required secrets/permissions for real runs: `api_key` (or provider-specific env), `pull-requests: write`, `issues: write`.
- `GITHUB_TOKEN` is runtime-injected by Actions; do not hardcode tokens.
- Keep `api_base` optional and enforce HTTPS-only with hostname allowlist.
- Legacy `OPENAI_API_KEY` / `OPENAI_API_BASE` env vars are still supported as fallbacks.
