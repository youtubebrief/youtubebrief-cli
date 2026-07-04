# Global launch copy drafts

Use these only after `npm view @youtubebrief/cli@beta version` returns the current beta and clean install QA passes.

## One-line positioning

Browser for account and billing. Terminal for clean YouTube briefs.

## Short description

Youtubebrief CLI/MCP turns explicit YouTube URLs into structured, timestamp-backed Markdown for research notes, DevRel handoffs, RAG prep, and local AI-agent workflows.

## Hacker News draft

Title:

```text
Show HN: Youtubebrief CLI/MCP – turn YouTube URLs into timestamped Markdown
```

Body:

```text
I built Youtubebrief CLI/MCP for developers and researchers who need YouTube videos converted into structured, timestamp-backed Markdown rather than a generic chat summary.

Install:

npm install -g @youtubebrief/cli@beta

yb login
yb doctor
yb brief "https://www.youtube.com/watch?v=..."

It also ships a local stdio MCP server:

npx -y --package @youtubebrief/cli@beta yb mcp

The beta is aimed at research notes, DevRel handoffs, RAG/JSONL preparation, and Codex/Claude-style local agent workflows. Account and billing happen in the browser; terminal commands stay scriptable.

Repo: https://github.com/youtubebrief/youtubebrief-cli
Site: https://youtubebrief.com/cli
```

## Product Hunt tagline

```text
Timestamp-backed YouTube briefs for terminal and local AI-agent workflows.
```

## Product Hunt short body

```text
Youtubebrief CLI/MCP turns explicit YouTube URLs into structured Markdown with section notes and timestamp evidence. Use it from the terminal, batch workflows, or local stdio MCP clients such as Codex/Claude-style agents.
```

## Launch caveat

Use `@beta` in install commands. Credits/API access may be required for actual brief generation during beta rollout.
