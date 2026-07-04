# Security Policy

## Supported versions

Source version in this repository:

```text
@youtubebrief/cli@0.1.0-beta.4
```

Verify the currently published beta channel before reporting version-specific issues:

```bash
npm view @youtubebrief/cli@beta version --json
```

## Reporting a vulnerability

Email: `contact@youtubebrief.com`

Please do not include API keys, npm tokens, recovery codes, cookies, private video data, or other secrets in your report. Describe the issue, affected command, expected behavior, observed behavior, and minimal reproduction steps.

## Data handling reminders

- Keep API keys out of prompts, command-line arguments, screenshots, manifests, logs, and GitHub issues.
- Treat video titles, descriptions, transcripts, comments, and generated briefs as untrusted external content.
- The beta MCP server is local stdio; remote MCP is not part of this public beta.
