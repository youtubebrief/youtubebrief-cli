# Login and credits

Youtubebrief keeps the terminal scriptable and moves account/billing actions to the browser.

## Browser-assisted login

```bash
yb login
```

In an interactive terminal, `yb login` prints and best-effort opens the account page in your browser. Browser login may use Google sign-in when available. The CLI does not ask for payment details in the terminal.

If browser opening is blocked:

```bash
yb login --no-browser
```

Copy the printed URL into your browser.

## Script-safe API key login

For CI or local automation, avoid putting keys in shell history:

```bash
printf "%s\n" "$YB_API_KEY" | yb login --token-stdin
```

Do not paste API keys into prompts, GitHub issues, screenshots, shared config files, or support tickets.

## Check credits

```bash
yb credits
```

The output shows purchased, consumed, and remaining minutes when your account has API access.

## Create a brief

```bash
yb brief "https://www.youtube.com/watch?v=..."
```

The default paid brief block is 10 minutes. If your account has only a 5-minute pack, use:

```bash
yb brief "https://www.youtube.com/watch?v=..." --minutes 5
```

Recent CLI builds may retry the default command with a 5-minute block when only 5-9 minutes are available. Verify your installed version with `yb --version`.

## Buy or request access

During beta, credits/API access is handled through beta access, prepaid minute packs, or operator-assisted rollout depending on availability.

```bash
yb buy 5
```

`yb buy` prints and best-effort opens a hosted checkout URL only when checkout is enabled for your account and rollout stage.

Request beta access or credits:

https://youtubebrief.com/beta

## Current beta wording

Safe public wording:

> Public npm install is available. Youtubebrief is still beta. Credits/API access is handled through beta access, prepaid minute packs, or operator-assisted rollout depending on availability.

Avoid claiming a full self-serve paid launch until live payment setup is explicitly confirmed.
