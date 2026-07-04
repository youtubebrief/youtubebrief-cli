# 🎬 Youtubebrief CLI/MCP

🌐 Browser for account and billing.  
⌨️ Terminal for clean YouTube briefs.

Youtubebrief turns explicit YouTube URLs into structured, timestamp-backed Markdown and agent-readable brief bundles for research, notes, DevRel handoffs, and AI-agent workflows.

It is **not** a generic consumer YouTube summarizer. It is a CLI/MCP beta for developers, researchers, DevRel teams, RAG pipelines, and local agent workflows.

## 📦 Install

```bash
npm install -g @youtubebrief/cli@beta
```

## ✅ Quick check

```bash
yb --version
yb --help
yb doctor
```

Run without global install:

```bash
npx -y --package @youtubebrief/cli@beta yb --help
```

Release/marketing registry verification:

```bash
npm view @youtubebrief/cli@beta version --json
```

The source version in this repo is `0.1.0-beta.3`. If registry verification still returns an older version, public npm install works but the npm beta channel is behind this repository.

## 🔐 Login and credits

```bash
yb login
yb credits
```

`yb` with no subcommand opens a Codex-style browser-assisted setup flow in a real terminal. It prints and best-effort opens <https://youtubebrief.com/cli>, then guides account setup, API-key storage, credit checks, and Codex MCP setup commands. In CI, pipes, and other non-TTY hosts, it prints deterministic help and never opens a browser.

For scripts, store an API key without shell history exposure:

```bash
printf "%s\n" "$YB_API_KEY" | yb login --token-stdin
```

## 📝 Create a brief

```bash
yb brief "https://www.youtube.com/watch?v=..."
```

Brief output is Markdown-focused video analysis: title, source, TL;DR, section notes, and timestamp evidence.

Credits/API access may be required for actual brief generation. During beta, access is handled through beta credits, prepaid minute packs, or operator-assisted rollout depending on availability. Do **not** treat this beta as a full self-serve paid launch until live payment setup is explicitly confirmed.

Beta access and credits request flow:

https://youtubebrief.com/beta

## 🗂️ Batch bundles

Create a no-spend bundle-shape check from a repo checkout:

```bash
yb batch "https://youtu.be/LPZh9BOjkQs" --out-dir ./yb-out --dry-run
```

When credits/API access is available, create a bundle from multiple explicit URLs:

```bash
yb batch --input examples/urls.txt --out-dir ./yb-out --combined-md --jsonl --allow-partial
```

A batch bundle can include:

```text
yb-out/
  manifest.json
  combined.md
  videos.jsonl
  videos/
    <video-id>.md
    <video-id>.json
```

`manifest.json` is the source of truth for status, output paths, billing facts, and retry information.

## 🔌 MCP local stdio

Youtubebrief ships a local stdio MCP server for Codex, Claude Code, Cursor-style agents, and other MCP clients.

```bash
npx -y --package @youtubebrief/cli@beta yb mcp
```

If the package is installed globally, this also works:

```bash
yb mcp
```

or:

```bash
youtubebrief-mcp
```

## 🤖 Use with Codex MCP

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

## 🚧 Current beta status

- 📦 Public npm install is available.
- 🧪 Use `@beta` in install commands for now.
- 🌐 Browser-assisted setup starts at <https://youtubebrief.com/cli>.
- 🔑 Credits/API access may require beta access.
- 💳 Prepaid minute access may be available depending on rollout stage.
- 🚧 Live payment availability may vary while beta payment setup is finalized.
- 🔒 Do not use it for undisclosed private or sensitive video workflows unless you understand the data handling model.

## 📚 Sample bundles

MCP/agent workflow:

https://youtubebrief.com/samples/mcp-agent-workflow/manifest.json

RAG/JSONL pipeline:

https://youtubebrief.com/samples/rag-jsonl-pipeline/manifest.json

DevRel/research workflow:

https://youtubebrief.com/samples/devrel-research/manifest.json

Local synthetic examples are also included under [`examples/sample-bundles/`](examples/sample-bundles/).

## 🧭 Use cases

### 🤖 AI agents and MCP

Use Youtubebrief when you want Codex, Claude Code, Cursor-style agents, or other MCP clients to work with YouTube-derived context through files and manifests instead of pasting large transcripts into chat.

https://youtubebrief.com/use-cases/mcp-agents

### 🧱 RAG and JSONL pipelines

Use Youtubebrief when you want to normalize explicit YouTube videos or URL lists into JSONL and Markdown before indexing.

https://youtubebrief.com/use-cases/youtube-to-jsonl-rag

### 🧪 DevRel and research

Use Youtubebrief when you need to turn public product demos, webinars, conference talks, or tutorials into reusable documentation, FAQ, enablement, or research material.

https://youtubebrief.com/use-cases/devrel-research

## 📖 Documentation

- [CLI guide](docs/cli.md)
- [Login and credits](docs/login-and-credits.md)
- [MCP guide](docs/mcp.md)
- [Codex MCP setup](docs/codex-mcp.md)
- [RAG/JSONL workflows](docs/rag-jsonl.md)
- [DevRel/research workflows](docs/devrel-research.md)
- [Samples](docs/samples.md)
- [Beta access](docs/beta-access.md)
- [Beta credits](docs/beta-credits.md)
- [Troubleshooting](docs/troubleshooting.md)

## 🛟 Support

For beta credits, request access here:

https://youtubebrief.com/beta

For installation or MCP setup issues, open a GitHub issue in this repository.

Report security issues to `contact@youtubebrief.com`. See [`SECURITY.md`](SECURITY.md). Do not include API keys, npm tokens, recovery codes, or private video data in issues.

## 📄 License

MIT. See [`LICENSE`](LICENSE).
