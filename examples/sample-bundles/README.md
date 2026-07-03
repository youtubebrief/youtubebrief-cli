# Youtubebrief sample bundles

These bundles are synthetic owned-demo artifacts for launch, documentation, and screenshots. They are not live customer records and do not contain provider-internal output.

Each bundle includes:

- `manifest.json` — source of truth for status, provenance, and output paths
- `combined.md` — prompt-friendly review file
- `videos.jsonl` — one JSONL row per video for RAG/data-pipeline demos
- `videos/*.md` and `videos/*.json` — per-video human and structured outputs

Use cases:

- `mcp-agent-workflow/` — local stdio MCP and agent file-handle flow
- `rag-jsonl-pipeline/` — JSONL/vector-indexing demo
- `devrel-research/` — DevRel, FAQ, and competitive-research handoff demo

All sample artifacts declare `sample_source_type`, `generated_with`, `created_at`, and `not_a_live_customer_record`.
