# Beta credits

Youtubebrief CLI/MCP is currently in beta.

## What is available now

- Public npm install
- CLI commands
- local stdio MCP command
- sample bundles
- beta request flow
- interactive terminal setup with `yb`

## What still requires beta access

- API key
- credits
- paid brief creation
- batch processing against the Youtubebrief API

Request access:

https://youtubebrief.com/beta

If your account already has beta API access, run:

```bash
yb
```

The interactive setup can sign in, check credits, and print a hosted checkout URL when credit checkout is enabled for your account.

You can also use the focused flow:

```bash
yb login
yb credits
yb brief "https://www.youtube.com/watch?v=..."
```

During beta, credits/API access is handled through beta access, prepaid minute packs, or operator-assisted rollout depending on availability. Do not claim a full self-serve paid launch until live payment setup is explicitly confirmed.

## What to include in a request

- Your email
- Intended use case: MCP, RAG, DevRel, research, or other
- Expected number of videos
- Whether you need CLI only or MCP too
- Any setup error messages, if you already installed the CLI
