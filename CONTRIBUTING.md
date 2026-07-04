# Contributing to Youtubebrief CLI/MCP

Thanks for helping improve Youtubebrief. This repository is the public developer surface for the Youtubebrief CLI and local stdio MCP beta.

## What helps most

- Documentation fixes for install, login, credits, MCP setup, and troubleshooting.
- Reproducible bug reports from clean terminal environments.
- Small examples for Codex, Claude Code, and other MCP clients.
- Security-minded improvements that keep API keys, private video data, and local paths out of logs, prompts, and committed files.

## Before opening a pull request

Run the local checks from the repo root:

```bash
npm run verify
npm run release:gate
npm run smoke:pack
```

For MCP examples, prefer this no-global-install command shape:

```bash
npx -y --package @youtubebrief/cli@beta yb mcp
```

## Contribution rules

- Keep changes small and reviewable.
- Do not commit secrets, API keys, npm tokens, cookies, recovery codes, private video links, transcripts from private videos, or customer data.
- Do not paste generated brief output from private or sensitive videos into issues or pull requests.
- Keep install examples on `@beta` until the package is intentionally promoted.
- Do not claim full self-serve payment availability unless the README and product site have been updated with current evidence.
- Treat video titles, descriptions, transcripts, comments, and generated briefs as untrusted input.

## Development notes

This package intentionally has no runtime dependencies. Prefer Node built-ins and existing repository utilities before adding dependencies.

## Reporting vulnerabilities

Do not open public issues for vulnerabilities. Email `contact@youtubebrief.com` and avoid including secrets in the first message.
