# Repository Guidelines

## Project Structure & Module Organization
- `src/`: core action runtime.
  - `index.js`: orchestration entrypoint (PR file loading, planner/sub-agent loop, publish).
  - `agents.js`: OpenAI Agents setup and structured-output execution.
  - `diff-map.js`, `aggregate.js`, `globs.js`, `publish.js`, `config.js`: focused utility modules.
- `test/`: Node built-in test suite (`*.test.js`) for diff mapping, aggregation, globs, and publish helpers.
- `.github/workflows/`: CI and self-test workflows.
- `examples/`: non-executed example workflow templates for consumers.
- `action.yml`: public action contract (inputs/outputs/defaults).

## Build, Test, and Development Commands
- `npm ci`: install locked dependencies exactly (same as CI).
- `npm run check`: syntax check for `src/index.js`.
- `npm test`: run all unit tests via `node --test`.
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

## Testing Guidelines
- Framework: Node built-in `node:test` + `node:assert/strict`.
- Test files: `test/<module>.test.js`.
- Add/extend tests whenever changing:
  - diff line resolution (`LEFT`/`RIGHT`),
  - finding normalization/deduplication/sorting,
  - publish/update marker behavior.
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
- Required secrets/permissions for real runs: `OPENAI_API_KEY`, `pull-requests: write`, `issues: write`.
- `GITHUB_TOKEN` is runtime-injected by Actions; do not hardcode tokens.
- Keep `OPENAI_API_BASE` optional and compatibility-safe.
