# DevRel and research workflows

Youtubebrief CLI/MCP is useful for turning public technical videos into reusable context for docs, FAQ, enablement, and research.

Example inputs:

- product demos
- webinars
- conference talks
- sets of tutorial video URLs
- public competitor demos

Youtubebrief beta processes explicit video URLs and URL lists. Playlist/channel crawling is not part of this beta surface.

Example outputs:

- speaker/topic notes in Markdown
- JSON records for internal tooling
- `combined.md` for LLM comparison prompts
- `manifest.json` for reproducibility

## Sample

Public sample manifest:

https://youtubebrief.com/samples/devrel-research/manifest.json

Local placeholder:

```text
examples/sample-manifests/devrel-research.manifest.json
```
