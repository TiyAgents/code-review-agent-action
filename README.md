# AI Code Review Agent Action

Reusable GitHub Action for automated Pull Request code review using `@openai/agents` (OpenAI Agents SDK).

This action:
- Runs on `pull_request` events.
- Reviews all changed files that match `include`/`exclude` filters.
- Uses planner + subagents (general/security/performance/testing) in multi-round batches for large diffs.
- Publishes:
  - one PR Review (`pulls.createReview`) with inline comments (`LEFT`/`RIGHT`), and
  - one updatable summary issue comment (marker-based, no spam).
- Tracks coverage and budget limits; outputs uncovered files + reasons when budget is exhausted.

## Features

- Full coverage target over filtered file set, including no-patch/binary files as file-level review entries.
- Structured schema output validation with one repair retry.
- Degradation mode: if structured output still fails after repair, posts summary-only with explicit reason.
- Duplicate suppression for same `head_sha` + same digest.
- Configurable review language via `review_language` (default `English`).
- Supports custom OpenAI base URL via `OPENAI_API_BASE` or `openai_api_base` input.
- Automatically loads project guidance from `AGENTS.md`, `AGENT.md`, or `CLAUDE.md` (priority order) and passes it to review agents.

## Usage

```yaml
name: PR AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  ai-review:
    runs-on: ubuntu-latest
    steps:
      - name: AI Code Review
        uses: owner/code-review-agent-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          openai_api_base: ${{ vars.OPENAI_API_BASE }}
          include: |
            **/*.js
            **/*.ts
            **/*.py
          exclude: |
            **/*.lock
            **/dist/**
            **/*.min.js
          planner_model: gpt-5.3-codex
          reviewer_model: gpt-5.3-codex
          review_dimensions: general,security,performance,testing
          review_language: English
          max_rounds: 8
          max_model_calls: 40
          max_files_per_batch: 8
          max_context_chars: 128000
          max_findings: 60
          max_inline_comments: 30
```

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `github_token` | yes | - | GitHub token with review/comment write permissions |
| `openai_api_key` | no | env `OPENAI_API_KEY` | OpenAI API key |
| `openai_api_base` | no | env `OPENAI_API_BASE` | Optional custom OpenAI-compatible base URL |
| `include` | no | `**` | Include globs (comma/newline separated) |
| `exclude` | no | empty | Exclude globs (comma/newline separated) |
| `planner_model` | no | `gpt-5.3-codex` | Planner model |
| `reviewer_model` | no | `gpt-5.3-codex` | Subagent model |
| `review_dimensions` | no | `general,security,performance,testing` | Subagent dimensions |
| `review_language` | no | `English` | Preferred language for review comments and summary |
| `max_rounds` | no | `8` | Max planning/review rounds |
| `max_model_calls` | no | `40` | Hard cap for model calls |
| `max_files_per_batch` | no | `8` | Batch size cap |
| `max_context_chars` | no | `128000` | Per-batch context cap |
| `max_findings` | no | `60` | Max findings retained after dedupe/sort |
| `max_inline_comments` | no | `30` | Max inline comments posted |

## Outputs

| Name | Description |
| --- | --- |
| `covered_files` | Number of covered files in filtered target set |
| `target_files` | Number of files in filtered target set |
| `uncovered_files` | Number of uncovered files |
| `degraded` | `true` if summary-only degradation was triggered |

## Fork PR Notes

- For public fork PRs, repository secrets are typically unavailable on `pull_request`.
- If `OPENAI_API_KEY` is unavailable, this action cannot call the model.
- If you choose to run on `pull_request_target`, evaluate security risk carefully before using untrusted code context.

## Publishing

1. Push this repository to GitHub.
2. Tag a release, for example `v1.0.0`.
3. Consumers reference: `uses: TiyAgents/code-review-agent-action@v1`.

## Implementation Notes

- Trigger support: this action expects `pull_request` event payload.
- Inline comments use `path` + `side` + `line`, with fallback to summary-only file-level entries when mapping is invalid.
- Summary comment update uses marker metadata and deduplicates by `head_sha` + digest.
