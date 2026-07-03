# YouTube to JSONL for RAG pipelines

Youtubebrief can turn explicit YouTube URL lists into a bundle suitable for downstream RAG preparation.

Typical output:

```text
yb-out/
  manifest.json
  combined.md
  videos.jsonl
  videos/
    <video-id>.md
    <video-id>.json
```

## Why JSONL

`videos.jsonl` is convenient for ingestion jobs because each line is one structured record. A pipeline can stream the file, transform fields, chunk text, and write embeddings without parsing one giant Markdown document.

## Why manifest first

`manifest.json` tracks which items succeeded, failed, were skipped, or were billed. Automation should use the manifest as the source of truth instead of guessing from files present on disk.

## Sample

Public sample manifest:

https://youtubebrief.com/samples/rag-jsonl-pipeline/manifest.json

Local placeholder:

```text
examples/sample-manifests/rag-jsonl-pipeline.manifest.json
```
