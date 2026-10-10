# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run build     # tsc -> dist/  (this is the only automated check that exists)
npm start         # node dist/index.js — needs CLICKUP_API_TOKEN
```

There is **no test framework and no linter** in this project. Don't invent a `npm test`
invocation; verification is `npm run build` plus exercising the server through an MCP
client. `npm start` fails fast with a usage message when the token is missing.

Manual smoke test without an MCP client. Startup issues no ClickUp request, so any
placeholder token gets you a full `tools/list` dump:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | CLICKUP_API_TOKEN=pk_placeholder node dist/index.js
```

## What this is

A stdio MCP server over the ClickUp REST API v2. It exists because ClickUp's hosted MCP
caps a Free workspace at 50 calls/24h and refuses personal tokens, while REST allows 100
requests/minute. See `README.md` for setup, env vars, and the tool list.

## Architecture

Four files, layered so that the **request budget is enforced in exactly one place**:

```
index.ts    wiring only: .env load, token check, client + server construction, stdio transport
tools.ts    six job-shaped MCP tools; owns all fan-out and all request-count reporting
clickup.ts  the only thing that speaks HTTP: rate gate, 429 backoff, TTL cache, pagination
format.ts   pure projection: raw ClickUp JSON -> CompactTask -> markdown
```

The organising idea is that **the model should never orchestrate**. One `get_my_work` call
costs 2 HTTP requests; letting the model walk space → folder → list → task costs thirty.
When adding capability, prefer widening an existing coarse tool over adding an endpoint
wrapper the model has to chain.

### Rules that new code must follow

- **All HTTP goes through `ClickUpClient.request()`.** A raw `fetch` bypasses the sliding-
  window gate, the 429 backoff, and the request counter, which silently breaks the budget
  the whole design rests on. The one exception is `ClickUpClient.download()`, which fetches
  attachment bytes from the `*.clickup-attachments.com` CDN: not the REST API, no auth sent.
- **stdout is the JSON-RPC channel.** Every diagnostic uses `console.error`. A stray
  `console.log` corrupts the protocol stream.
- **Cache structure, never task data.** Hierarchy, custom fields, members and `/user` go
  through `clickup.cached(key, STRUCTURE_TTL_MS, …)`. Task reads are always live —
  a stale task list is worse than a slow one.
- **Report cost and truncation.** Tools capture `clickup.calls` before their work and emit
  the delta; anything that hit the page cap says so (`Paged.truncated`) rather than
  returning a short list that looks complete.
- **Bulk tools don't abort.** `create_task` / `update_task` take arrays and report each
  item's success or failure individually.

### ClickUp API gotchas encoded here

- Auth header is the **raw personal token** — `Bearer` is the OAuth form and is rejected.
- Array filters use repeated `key[]=v`; `ClickUpClient.url()` handles that.
- `assignees[]` takes **numeric user ids only**. A literal `"me"` returns an empty list
  rather than an error — hence `clickup.me()` resolving the id first.
- Timestamps are unix **milliseconds**. `toClickUpTimestamp()` in `tools.ts` accepts
  `YYYY-MM-DD` or raw millis on the way in; `format.ts` renders dates with the `sv-SE`
  locale so they stay in the machine's timezone (`toISOString` would shift Bangkok dates
  back a day).
- `/team/{id}/task` pages at 100; a short page means the end.

## TypeScript setup

`NodeNext` modules with `strict` and `noUncheckedIndexedAccess`. Relative imports must
carry the `.js` extension (`./clickup.js`, not `./clickup`). Target is ES2022 on Node 20+.

## Configuration

`index.ts` loads the repo-root `.env` via `process.loadEnvFile` relative to
`import.meta.dirname/..`, so `dist/` must remain one level below the repo root for the
token to be found. Environment variables already set win over `.env`, and a missing `.env`
is not an error. This exists so the token never lands in Claude Code's config, where
`claude mcp add -e` would store it in plaintext.
