# Youtubebrief MCP guide

Youtubebrief exposes a local stdio MCP server through the npm package.

```bash
npx -y --package @youtubebrief/cli@beta yb mcp
```

## What the MCP server is for

Use it when an AI agent needs to turn explicit YouTube URLs or URL lists into files it can reference:

- `manifest.json`
- `combined.md`
- `videos.jsonl`
- per-video Markdown
- per-video JSON

## Why manifest/path handles

Large transcripts and briefs should not be dumped directly into every tool result. Youtubebrief MCP returns concise summaries plus manifest/output file handles so agents can read only what they need.

This keeps agent context smaller and makes retries, partial failures, and audit trails easier to understand.

## Tool behavior at a high level

The beta MCP surface is designed around:

- checking credits
- estimating cost
- creating one brief
- creating batch brief bundles
- reading manifests
- reading generated brief outputs

API keys must not appear in tool output, errors, manifests, or screenshots.

## Auth and client setup

For paid tools, either run `yb login --token-stdin` before starting your MCP client, or configure the client to forward `YB_API_KEY` to the local stdio process. Do not put literal API keys in prompts, screenshots, GitHub issues, or shared config.

See:

- [Codex MCP setup](codex-mcp.md)
- `examples/codex-config.toml`
- `examples/claude-code-mcp.json`
