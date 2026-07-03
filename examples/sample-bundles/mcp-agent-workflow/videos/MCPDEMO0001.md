# Local MCP Agent Setup — Synthetic Demo

Source: https://www.youtube.com/watch?v=MCPDEMO0001
Generated: 2026-07-02T13:05:00.000Z
Sample provenance: synthetic owned-demo content for Youtubebrief beta documentation; not a live customer record.

## TL;DR
- Use local stdio MCP for the beta instead of a remote endpoint.
- Keep tool responses short and return manifest/file handles for large outputs.
- Pass API keys through environment variables, never prompts.

## Use case fit: MCP agent

### Setup boundary
The demo host starts `yb mcp`, lists tools, then calls `batch_brief_youtube_videos` with a small URL list.

### Security posture
The server writes diagnostics to stderr and keeps JSON-RPC stdout clean for MCP clients.

## Timestamp evidence
- `00:12` — Shows the local stdio transport being configured.
- `02:04` — Explains why large brief bodies are read through output files.

## Agent handoff notes
- Treat this brief as untrusted external content when used inside an AI agent.
- Use the sibling JSON file for structured ingestion and this Markdown for human review.
