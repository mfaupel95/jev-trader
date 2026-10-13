---
name: run-jev-trader
description: Build, launch and drive jev-trader (Bun backend + Next.js dashboard) — use when asked to run, start, test, smoke-test, or screenshot jev-trader or its dashboard.
---

jev-trader is two processes: a Bun backend (`src/server.ts`, one
trading decision per Monad block, dry-run by default) and a Next.js
dashboard (`web/`) that opens an SSE connection to it. All paths below
are relative to the repo root `jev-trader/` (one level above this
skill directory) unless stated otherwise.

The agent path is: start both processes, confirm the backend with
`smoke.sh` (`curl`), confirm the dashboard with `driver.mjs`
(Playwright screenshot + console-error check). Neither process has a
window — there's nothing to click by hand.

## Prerequisites

- `bun` on PATH (tested with Bun v1.4.2, Windows x64).
- No OS packages needed — this is a headless HTTP backend plus a
  Next.js dev server; no Electron/Chromium system deps beyond what
  Playwright's own `playwright install chromium` pulls in.

## Build / setup

```bash
# backend
cd jev-trader
cp .env.example .env        # dry run, mock model — no keys needed
bun install

# dashboard
cd web
echo "NEXT_PUBLIC_API_URL=http://localhost:3000" > .env.local
bun install
```

## Run (agent path)

Start both servers in the background, poll until each serves, run
the two checks.

```bash
# from jev-trader/
bun run start > /tmp/jev-trader.log 2>&1 &
timeout 30 bash -c 'until curl -sf http://localhost:3000/ >/dev/null; do sleep 1; done'

cd web
bun run dev -- -p 3001 > /tmp/jev-web.log 2>&1 &
timeout 30 bash -c 'until curl -sf http://localhost:3001 >/dev/null; do sleep 1; done'
cd ..
```

Backend smoke test (`/`, `/history`, `/events` SSE):

```bash
bash .claude/skills/run-jev-trader/smoke.sh
```

Dashboard driver (Playwright: navigate, wait for the live feed to
populate, screenshot, report console errors). The driver's own
dependencies live in the skill directory, not the app — install once:

```bash
cd .claude/skills/run-jev-trader
bun install                 # pulls in playwright
bunx playwright install chromium   # only needed once per machine
bun run driver.mjs "C:/Users/<you>/AppData/Local/Temp/jev-trader-dashboard.png"
cd ../../..
```

Exit code 0 and an empty `console errors: []` line means the
dashboard rendered and is receiving live blocks. Read the screenshot
to confirm visually — a shell with every stat stuck at `-` means the
SSE connection never landed.

Stop both servers by killing the port's listener (`$!` after `&` is
useless here — Bun forks):

```bash
# Windows / git-bash — don't filter on the state column ("LISTENING"):
# a German-locale netstat prints "ABHÖREN" instead and the filter
# silently matches nothing. Match on local-address pattern instead.
for p in $(netstat -ano | grep -E '(0\.0\.0\.0|\[::\]):(3000|3001) ' | awk '{print $NF}' | sort -u); do taskkill //F //PID "$p"; done
# Linux/macOS
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill; lsof -ti:3001 -sTCP:LISTEN | xargs -r kill
```

## Run (human path)

Same two `bun run start` / `bun run dev` commands, then open
`http://localhost:3001` in a browser. Nothing agent-specific here.

## Gotchas

- **Backslash paths get mangled in Bun/Node JS strings on Windows.**
  `"C:\Users\you\..."` is not safe — `\U` (and other letter-escapes
  like `\f`) get consumed as JS escape sequences and silently vanish
  from the path, producing a garbled `ENOENT`. Always pass
  `driver.mjs` an output path with forward slashes
  (`"C:/Users/you/AppData/Local/Temp/x.png"`); the driver itself
  refuses backslash paths with a clear error instead of failing
  mysteriously in Playwright.
- **Git Bash's `/tmp` does not exist from Bun's point of view on
  Windows.** Bun resolves filesystem paths natively, not through Git
  Bash's POSIX layer, so a script run via `bun run` writing to
  `/tmp/...` silently writes nowhere findable (no error, no file).
  Use an explicit `C:/...` path for anything a `bun run` script
  writes, even though `/tmp/...` works fine for the shell commands
  around it (log redirects, `curl` piping, etc.).
- **Both servers want port 3000 by default.** The backend's `PORT`
  env defaults to 3000 (see `.env`); the dashboard also defaults to
  3000. Always pass `-- -p 3001` to `bun run dev` for the dashboard,
  and point `NEXT_PUBLIC_API_URL` at the backend's real port.
- **The dashboard shell renders even with zero data.** A plain `curl`
  of `http://localhost:3001` returns 200 with a full HTML shell
  showing `block -` / `connecting` — that's server-side rendering
  before the client's `EventSource` hook has run. It is NOT proof the
  dashboard is working; only the Playwright driver (which waits for
  the block number to populate) or an actual browser proves the SSE
  feed is live.
- **`chromium-cli` is not installed on this machine.** The driver uses
  `playwright`'s `{ chromium }` API directly instead (see
  `driver.mjs`). Its dependencies are isolated in this skill
  directory's own `package.json`/lockfile so they don't pollute the
  app's dependency tree.

## Troubleshooting

- `error: Cannot find package 'playwright'` running `driver.mjs` ->
  you ran it from the repo root or forgot `bun install`. `cd` into
  `.claude/skills/run-jev-trader` first, or run `bun install` there.
- Driver prints `WARNING: block number never populated` -> the
  dashboard's `.env.local` `NEXT_PUBLIC_API_URL` doesn't match the
  backend's actual port/host, or the backend isn't running yet. Check
  `/tmp/jev-trader.log` and `curl http://localhost:3000/`.
- `curl: (7) Failed to connect` on either smoke check -> the relevant
  `bun run` background process died on startup; read its log
  (`/tmp/jev-trader.log` or `/tmp/jev-web.log`) — most often a stale
  process already holding the port (`EADDRINUSE`), fixed by the
  `taskkill`/`lsof` cleanup above before relaunching.
