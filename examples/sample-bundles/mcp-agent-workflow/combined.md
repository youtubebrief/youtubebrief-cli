# MCP agent workflow sample

Synthetic local-stdio MCP demo showing how agents consume manifest-backed YouTube brief files without giant tool responses.

Sample provenance: synthetic owned-demo content; not a live customer record.

Use case: MCP agent

## Local MCP Agent Setup — Synthetic Demo

- Source: https://www.youtube.com/watch?v=MCPDEMO0001
- Markdown: `videos/MCPDEMO0001.md`
- JSON: `videos/MCPDEMO0001.json`

- Use local stdio MCP for the beta instead of a remote endpoint.
- Keep tool responses short and return manifest/file handles for large outputs.
- Pass API keys through environment variables, never prompts.

## Manifest-backed Tool Calls — Synthetic Demo

- Source: https://www.youtube.com/watch?v=MCPDEMO0002
- Markdown: `videos/MCPDEMO0002.md`
- JSON: `videos/MCPDEMO0002.json`

- The manifest is the source of truth for status and output paths.
- Agents can request bounded reads through `read_brief_output`.
- Retries should reuse item idempotency keys returned in the manifest.
