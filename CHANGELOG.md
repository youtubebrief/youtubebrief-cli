# Changelog

## Unreleased

- Reframed public docs around the install -> login/credits -> `yb brief` beta flow.
- Added `docs/login-and-credits.md`.
- Clarified that credits/API access remains beta-gated and live payment availability may vary during rollout.
- Documented why MCP npx examples use the explicit `--package ... yb mcp` form.

## 0.1.0-beta.2 - 2026-07-03

Prepared docs/package metadata for public GitHub repo and corrected one-off npx MCP examples to use `npx --package @youtubebrief/cli@beta yb mcp`.

## 0.1.0-beta.1 - 2026-07-03

Initial public npm beta for Youtubebrief CLI/MCP.

- Published `@youtubebrief/cli@beta`.
- Added `yb`, `youtubebrief`, and `youtubebrief-mcp` binaries.
- Added single-video brief command.
- Added batch bundle workflow with `manifest.json`, per-video Markdown/JSON, optional `combined.md`, and optional `videos.jsonl`.
- Added local stdio MCP server for agent workflows.
- Added synthetic sample bundles for MCP, RAG/JSONL, and DevRel/research use cases.
- Added beta docs and troubleshooting guidance.
