# clickup-custom-mcp

A stdio MCP server that talks to the **ClickUp REST API v2** directly.

It exists because ClickUp's hosted MCP (`mcp.clickup.com`) caps a Free workspace at
**50 calls per 24 hours** and refuses personal API tokens, while the same account's REST
API allows **100 requests per minute**. This server trades a daily ceiling for a
per-minute one, and keeps the token on your machine instead of in a hosted integration.

## Requirements

- Node 20+ (see `engines` in `package.json`)
- A ClickUp personal API token

## Setup

```bash
npm install
npm run build
```

Generate a token in ClickUp: **avatar → Settings → Apps → API Token → Generate**.

Copy `.env.example` to `.env` at the repo root (`.env` is gitignored) and fill in the token:

```bash
cp .env.example .env
```

The server loads that file itself via `process.loadEnvFile`, so the token never has to be
written into Claude Code's config — where `claude mcp add -e` would store it in plaintext.
Anything already present in the environment wins over `.env`, and if the file is missing
(or the Node build has no `loadEnvFile`) the server simply falls back to plain environment
variables.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLICKUP_API_TOKEN` | yes | Personal API token. The server exits with a message if it's unset. |
| `CLICKUP_TEAM_ID` | no | Pin a workspace. Without it the first workspace the token can see is used, and a note goes to stderr if there is more than one. |
| `CLICKUP_RATE_LIMIT` | no | Requests/minute the client allows itself. Defaults to 90 — deliberate headroom under ClickUp's 100. |

## Register with Claude Code

```bash
claude mcp add clickup-custom-mcp -- node /absolute/path/to/clickup-custom-mcp/dist/index.js
```

No `-e CLICKUP_API_TOKEN=...` is needed — the `.env` file covers it.

Run it standalone with `npm start`. stdout is the JSON-RPC channel, so every diagnostic
(including a per-request log line with ClickUp's remaining quota) goes to stderr.

## Tools

Six coarse tools, each shaped around a job rather than an endpoint. The fan-out lives in
the server, not in the model: one `get_my_work` call costs 2 HTTP requests where walking
space → folder → list → task from the model side costs thirty.

| Tool | What it does |
| --- | --- |
| `get_workspace_map` | Spaces, folders, lists (with their status names) and members, plus your own numeric user id. Call it first when you need an id for anything else. Cached 15 minutes; optionally includes custom field definitions. |
| `get_my_work` | Every open task assigned to you across the workspace, grouped by overdue / today / this week / later. The one for a standup or a backlog sweep. |
| `search_tasks` | Filtered task query across the whole workspace in one request — lists, spaces, assignees, statuses, tags, due/updated date ranges, ordering. Paginates automatically. |
| `get_task` | Full detail for one task: description, custom field values, subtasks, optionally comments. |
| `create_task` | Create one or many tasks in a single call. Each is reported individually; one failure does not abort the rest. |
| `update_task` | Update one or many tasks — status, assignees, due dates, priority, renames, archive. Also reported individually. |

Every tool reports how many HTTP requests it spent, and any result that hit the page cap
says **Truncated** rather than quietly returning a short list.

## Design notes

- **Rate gate** (`src/clickup.ts`) — a sliding 60-second window plus a concurrency cap of 4.
  A fixed-interval refill would let a burst of 90 fire in the first second and then stall
  for 59; tracking actual send times spreads the same budget.
- **429 handling** — backoff is driven by ClickUp's own `X-RateLimit-Reset` header, retried
  up to 3 times. The client also coasts down when `X-RateLimit-Remaining` drops to 2 rather
  than taking a 429 mid-fan-out.
- **Structure cache** — hierarchy, custom fields and member lists are memoised for 15
  minutes. Task data is deliberately never cached.
- **Compact output** (`src/format.ts`) — raw ClickUp task JSON runs 2–4KB each. Every tool
  projects down to the fields a person actually reads and renders markdown instead of JSON.

## Layout

```
src/index.ts    entrypoint: env loading, client + server wiring, stdio transport
src/clickup.ts  REST client: rate gate, retry/backoff, TTL cache, task pagination
src/tools.ts    the six MCP tool definitions and their fan-out
src/format.ts   task projection and markdown rendering
```
