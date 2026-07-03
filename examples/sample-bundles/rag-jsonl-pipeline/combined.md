# RAG JSONL pipeline sample

Synthetic sample for turning public technical talks into JSONL and Markdown artifacts that can be indexed or reviewed.

Sample provenance: synthetic owned-demo content; not a live customer record.

Use case: RAG/JSONL

## Chunking Conference Talks for RAG — Synthetic Demo

- Source: https://www.youtube.com/watch?v=RAGDEMO0001
- Markdown: `videos/RAGDEMO0001.md`
- JSON: `videos/RAGDEMO0001.json`

- Preserve source URL, video id, and timestamp evidence in every record.
- Chunk boundaries should follow sections rather than arbitrary transcript length.
- Keep generated summaries separate from raw source metadata.

## JSONL Metadata for Video Search — Synthetic Demo

- Source: https://www.youtube.com/watch?v=RAGDEMO0002
- Markdown: `videos/RAGDEMO0002.md`
- JSON: `videos/RAGDEMO0002.json`

- Use JSONL for streaming ingestion and combined Markdown for prompt review.
- Store short summaries, not internal diagnostics.
- Run dry-run/estimate before paid batch execution.

## Evaluation Notes for Video Datasets — Synthetic Demo

- Source: https://www.youtube.com/watch?v=RAGDEMO0003
- Markdown: `videos/RAGDEMO0003.md`
- JSON: `videos/RAGDEMO0003.json`

- Track generation time and sample provenance on every artifact.
- Evaluate answers against timestamp evidence, not only summary fluency.
- Flag synthetic samples clearly in demos.
