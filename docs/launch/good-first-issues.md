# Good first issue backlog

These issue drafts are safe to open after the public repo/community files are live. Keep labels focused: `good first issue`, `docs`, `mcp`, `cli`, `security`, or `help wanted`.

## 1. [docs] Add Warp terminal setup guide

Document how to install `@youtubebrief/cli@beta`, run `yb login`, and keep `YB_API_KEY` out of shell history in Warp.

Acceptance criteria:
- Includes install, login, doctor, and brief commands.
- Notes that browser login is interactive but scripts should use `yb login --token-stdin`.
- Does not include secrets or private videos.

## 2. [docs] Add Ghostty terminal setup guide

Create a short Ghostty-focused terminal setup guide for the CLI beta.

Acceptance criteria:
- Covers install and `yb doctor`.
- Includes troubleshooting for `yb: command not found`.
- Links back to README login/credits docs.

## 3. [docs] Add tmux troubleshooting notes

Document common tmux/non-TTY behavior for browser-assisted login.

Acceptance criteria:
- Explains why non-TTY hosts print URLs instead of launching browsers.
- Shows `yb login --token-stdin` for deterministic setup.
- Avoids recommending API keys in command arguments.

## 4. [docs] Add WezTerm keybinding example

Add an example workflow for sending selected YouTube URLs to `yb brief` from WezTerm or a shell function.

Acceptance criteria:
- Keeps API keys out of shell history.
- Uses explicit YouTube URLs only.
- Describes expected Markdown output.

## 5. [mcp] Add Cursor MCP setup example

Add a documented local stdio MCP configuration example for Cursor-style MCP clients.

Acceptance criteria:
- Uses `npx -y --package @youtubebrief/cli@beta yb mcp`.
- Shows auth through environment/config, not prompt text.
- Mentions beta credits may be required for paid tools.

## 6. [mcp] Add Claude Code MCP setup example

Expand docs with a Claude Code local stdio MCP setup path.

Acceptance criteria:
- Uses the same no-global-install MCP command shape.
- Includes verification steps to confirm tools are visible.
- Avoids claiming hosted remote MCP availability.

## 7. [cli] Improve browser-open fallback wording

Review `yb login` and default `yb` fallback copy for clarity in terminals where browser opening fails.

Acceptance criteria:
- Keeps CI/non-TTY deterministic.
- Mentions the account URL clearly.
- Tests cover fallback text.

## 8. [doctor] Add clearer guidance for missing credits

Improve `yb doctor` or `yb credits` troubleshooting text when auth exists but credits are zero.

Acceptance criteria:
- Points to account/beta access without overclaiming live payments.
- Does not leak stored config paths beyond existing safe output.
- Test coverage included.

## 9. [security] Add cleanup retention examples

Document safe handling and deletion/retention examples for generated local brief bundles.

Acceptance criteria:
- Covers `yb-out/` bundle contents.
- Warns against committing private generated briefs.
- Shows `.gitignore` examples.

## 10. [docs] Add sample-output walkthrough

Create a walkthrough explaining the fields in a generated Markdown brief and batch manifest.

Acceptance criteria:
- Uses synthetic sample bundles already in this repository.
- Explains timestamp evidence and billing facts at a high level.
- Avoids private/customer data.
