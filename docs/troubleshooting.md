# Troubleshooting

## `yb: command not found`

If you installed globally, check npm global bin path:

```bash
npm bin -g
npm prefix -g
```

You can avoid global PATH issues with:

```bash
npx -y --package @youtubebrief/cli@beta yb --help
```

If your shell asks to autocorrect `yb` to another command, answer `n`. In zsh you can disable that behavior with `unsetopt correct`.

## npm install fails

Confirm Node.js 20 or newer:

```bash
node --version
```

Then retry:

```bash
npm install -g @youtubebrief/cli@beta
```

## `yb doctor` reports missing API key

Public install does not automatically grant API access. Request beta credits:

https://youtubebrief.com/beta

For terminal setup, run:

```bash
yb login
```

In an interactive terminal, `yb` and `yb login` print and best-effort open Youtubebrief setup pages in your browser. If browser opening is blocked, copy the printed URL manually; use `yb --no-browser` or `yb login --no-browser` to suppress browser launch attempts.

For scripts or CI, avoid interactive prompts and pass a key through stdin or the environment:

```bash
printf "%s\n" "$YB_API_KEY" | yb login --token-stdin
```

## MCP server not visible in Codex

Re-add the server:

```bash
codex mcp add youtubebrief -- npx -y --package @youtubebrief/cli@beta yb mcp
```

Then open Codex and run:

```text
/mcp
```

If using config, verify `~/.codex/config.toml` contains:

```toml
[mcp_servers.youtubebrief]
command = "npx"
args = ["-y", "--package", "@youtubebrief/cli@beta", "yb", "mcp"]
```

## `npx` says `could not determine executable to run`

Use the explicit package form:

```bash
npx -y --package @youtubebrief/cli@beta yb mcp
```

The package exposes multiple binaries (`yb`, `youtubebrief`, and `youtubebrief-mcp`), so npm cannot always infer the executable from a package-name-only command.

## Credits or billing questions

Open a beta credits issue or request access through:

https://youtubebrief.com/beta

Do not paste API keys, npm tokens, recovery codes, or private video data into GitHub issues.
