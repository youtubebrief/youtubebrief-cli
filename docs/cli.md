# Youtubebrief CLI guide

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

`yb` with no subcommand opens a browser-assisted interactive terminal setup flow. It prints and best-effort opens <https://youtubebrief.com/cli> for first-run account setup, checking credits, buying beta credit packs when enabled, trying a no-spend dry run, and printing Codex MCP setup commands. In scripts, CI, pipes, and MCP hosts, keep using explicit subcommands; non-TTY commands do not prompt or open a browser.

## Common commands

Create a single brief:

```bash
yb brief "https://www.youtube.com/watch?v=..."
```

Create a bundle from multiple URLs:

```bash
yb batch --input examples/urls.txt --out-dir ./yb-out --combined-md --jsonl --allow-partial
```

Estimate without spending credits:

```bash
yb batch --input examples/urls.txt --out-dir ./yb-out --estimate-credits
```

Validate and plan without spending credits:

```bash
yb batch "https://youtu.be/LPZh9BOjkQs" --out-dir ./yb-out --dry-run
```

If you use `examples/urls.txt`, replace the placeholder comments with explicit public YouTube URLs first.

Create/sign in to a beta account:

```bash
yb login
# or, for scripts:
printf "%s\n" "$YB_API_KEY" | yb login --token-stdin
```

`yb login` opens <https://youtubebrief.com/account> only in an interactive terminal. Use `--no-browser` to print the URL without launching a browser.

Check and buy credits when checkout is enabled for your account:

```bash
yb credits
yb buy 5
```

If you buy a 5-minute pack, run paid brief commands with `--minutes 5`; the default billing block is 10 minutes.

Resume a previous bundle:

```bash
yb batch --input examples/urls.txt --out-dir ./yb-out --resume --allow-partial
```

Export an existing bundle:

```bash
yb export --from ./yb-out --format combined-md --output ./yb-out/combined.md
yb export --from ./yb-out --format jsonl --output ./yb-out/videos.jsonl
```

## Expected outputs

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

## Beta access

Public npm install is available, but API key and credits access are handled through beta access:

https://youtubebrief.com/beta
