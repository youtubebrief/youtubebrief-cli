# Youtubebrief CLI/MCP

**Youtubebrief CLI/MCP** turns explicit YouTube videos and URL lists into reproducible, agent-readable brief bundles for AI agents, RAG pipelines, DevRel teams, and research workflows.

It is **not** a generic consumer YouTube summarizer. It is a developer tool for producing file-based outputs that agents can reuse safely:

- `manifest.json`
- `combined.md`
- `videos.jsonl`
- per-video Markdown
- per-video JSON

## Install

```bash
npm install -g @youtubebrief/cli@beta
```

## Quick check

```bash
yb
yb --version
yb --help
yb doctor
```

Running `yb` with no subcommand opens a Codex-style interactive setup flow in a terminal. It can create/sign in to a beta account, show credit packages when available for your account, open a hosted checkout URL, run a no-spend dry run, and print Codex MCP setup commands.

Run without global install:

```bash
npx -y --package @youtubebrief/cli@beta yb --help
```

No-spend bundle-shape check from a repo checkout:

```bash
yb batch "https://youtu.be/LPZh9BOjkQs" --out-dir ./yb-out --dry-run
```

`--dry-run` validates inputs and writes a planned `manifest.json` without calling the API or spending credits. If you use `examples/urls.txt`, replace the placeholder comments with explicit public YouTube URLs first.

Release/marketing verification:

```bash
npm view @youtubebrief/cli@beta version --json
```

## MCP local stdio

Youtubebrief ships a local stdio MCP server for Codex, Claude Code, Cursor-style agents, and other MCP clients.

```bash
npx -y --package @youtubebrief/cli@beta yb mcp
```

## Use with Codex MCP

Codex can connect to local stdio MCP servers. Add Youtubebrief as a Codex MCP server:

```bash
codex mcp add youtubebrief -- npx -y --package @youtubebrief/cli@beta yb mcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.youtubebrief]
command = "npx"
args = ["-y", "--package", "@youtubebrief/cli@beta", "yb", "mcp"]
env_vars = ["YB_API_KEY"]
```

For paid MCP tools, either run `yb login --token-stdin` before starting Codex, or use the `config.toml` form above to forward `YB_API_KEY`. Do not paste API keys into prompts, commit literal keys, or put keys directly into shared config files.

Then open Codex and run:

```text
/mcp
```

You should see the configured MCP server. See [`docs/codex-mcp.md`](docs/codex-mcp.md).

## Current launch mode

Youtubebrief CLI/MCP is in beta.

- Public npm install is available.
- Credits/API access is handled through the beta access and credits request flow.
- The interactive `yb` setup flow can create/sign in to a beta account and, when enabled for that account, print hosted checkout URLs from `yb buy <5|10|30|60>`.
- Use `@beta` in install commands for now.
- Do not use it for undisclosed private or sensitive video workflows unless you understand the data handling model.

Request beta credits:

https://youtubebrief.com/beta

## Sample bundles

MCP/agent workflow:

https://youtubebrief.com/samples/mcp-agent-workflow/manifest.json

RAG/JSONL pipeline:

https://youtubebrief.com/samples/rag-jsonl-pipeline/manifest.json

DevRel/research workflow:

https://youtubebrief.com/samples/devrel-research/manifest.json

Local synthetic examples are also included under [`examples/sample-bundles/`](examples/sample-bundles/).

## Use cases

### AI agents and MCP

Use Youtubebrief when you want Codex, Claude Code, Cursor-style agents, or other MCP clients to work with YouTube-derived context through files and manifests instead of pasting large transcripts into chat.

https://youtubebrief.com/use-cases/mcp-agents

### RAG and JSONL pipelines

Use Youtubebrief when you want to normalize explicit YouTube videos or URL lists into JSONL and Markdown before indexing.

https://youtubebrief.com/use-cases/youtube-to-jsonl-rag

### DevRel and research

Use Youtubebrief when you need to turn public product demos, webinars, conference talks, or tutorials into reusable documentation, FAQ, enablement, or research material.

https://youtubebrief.com/use-cases/devrel-research

## What this is not

Youtubebrief CLI/MCP is not positioned as a generic consumer YouTube summarizer.

It is built for:

- AI agent workflows
- MCP tool integrations
- RAG data preparation
- DevRel and docs workflows
- competitive research from explicit public URLs

## Status

Source version in this repository:

```text
@youtubebrief/cli@0.1.0-beta.2
```

Published beta channel verification:

```bash
npm view @youtubebrief/cli@beta version --json
```

If the registry still returns `0.1.0-beta.1`, public install works but the npm package page is one patch behind this repository. Use the explicit `npx -y --package @youtubebrief/cli@beta yb mcp` form either way.

Install with:

```bash
npm install -g @youtubebrief/cli@beta
```

## Documentation

- [CLI guide](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/cli.md)
- [MCP guide](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/mcp.md)
- [Codex MCP setup](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/codex-mcp.md)
- [RAG/JSONL workflows](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/rag-jsonl.md)
- [DevRel/research workflows](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/devrel-research.md)
- [Beta credits](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/beta-credits.md)
- [Troubleshooting](https://github.com/youtubebrief/youtubebrief-cli/blob/main/docs/troubleshooting.md)

## Support

For beta credits, request access here:

https://youtubebrief.com/beta

For installation or MCP setup issues, open a GitHub issue in this repository.

Report security issues to `contact@youtubebrief.com`. See [`SECURITY.md`](https://github.com/youtubebrief/youtubebrief-cli/blob/main/SECURITY.md). Do not include API keys, npm tokens, recovery codes, or private video data in issues.

## License

MIT. See [`LICENSE`](LICENSE).
