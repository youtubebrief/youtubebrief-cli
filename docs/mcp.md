# Youtubebrief MCP guide

Youtubebrief exposes a local stdio MCP server through the npm package.

```bash
npx -y --package @youtubebrief/cli@beta yb mcp
```

If installed globally, you can also run:

```bash
yb mcp
youtubebrief-mcp
```

Do not use the shorter package-name-only npx form for MCP. Because this package has multiple binaries, use `npx -y --package @youtubebrief/cli@beta yb mcp` so npm knows which command to execute.

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

Credits/API access may require beta access. During beta, prepaid minute access may be available depending on rollout stage; do not treat this as a full self-serve paid launch until live payment setup is explicitly confirmed.

See:

- [Codex MCP setup](codex-mcp.md)
- `examples/codex-config.toml`
- `examples/claude-code-mcp.json`
