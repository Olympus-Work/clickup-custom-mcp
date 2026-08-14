/**
 * ClickUp REST API v2 client.
 *
 * The point of this file is not "wrap the API" — it is to keep a whole session's
 * worth of tool calls inside ClickUp's 100 requests/minute budget. Three layers do
 * that: a request gate (sliding window + concurrency cap), 429 backoff driven by
 * ClickUp's own reset header, and a TTL cache for the parts of a workspace that
 * do not change between calls.
 */

const BASE = "https://api.clickup.com/api/v2";

/** Requests/minute we allow ourselves. ClickUp's floor is 100; the gap is headroom. */
const DEFAULT_RATE_LIMIT = 90;
const CONCURRENCY = 4;
const WINDOW_MS = 60_000;
const MAX_RETRIES = 3;

/** Hierarchy, custom fields and member lists barely move within a session. */
export const STRUCTURE_TTL_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thrown for any non-2xx that survived retrying, so tools can surface ClickUp's own message. */
export class ClickUpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`ClickUp ${status} on ${path}: ${body}`);
    this.name = "ClickUpError";
  }
}

type Query = Record<string, string | number | boolean | string[] | number[] | undefined>;

/**
 * Sliding-window rate gate with a concurrency cap.
 *
 * A fixed `setInterval` refill would let a burst of 90 fire in the first second
 * and then stall for 59; tracking actual send times spreads the same budget.
 */
class Gate {
  private sent: number[] = [];
  private active = 0;
  private waiting: Array<() => void> = [];
  /** Set from a 429 (or a nearly-exhausted quota) — every request holds until it passes. */
  private pauseUntil = 0;

  constructor(
    private readonly perMinute: number,
    private readonly concurrency: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;

    for (;;) {
      const now = Date.now();
      if (now < this.pauseUntil) {
        await sleep(this.pauseUntil - now);
        continue;
      }
      this.sent = this.sent.filter((t) => now - t < WINDOW_MS);
      if (this.sent.length < this.perMinute) {
        this.sent.push(now);
        return;
      }
      // Wait just past the moment the oldest request leaves the window.
      const oldest = this.sent[0]!;
      await sleep(WINDOW_MS - (now - oldest) + 50);
    }
  }

  release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  /** Hold every caller until `until` (epoch ms). Never shortens an existing pause. */
  pause(until: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, until);
  }
}

export interface ClickUpUser {
  id: number;
  username: string;
  email: string;
}

export interface Paged<T> {
  items: T[];
  /** True when the page cap was hit before ClickUp ran out of results. */
  truncated: boolean;
  pages: number;
}

export class ClickUpClient {
  private readonly gate: Gate;
  private readonly cache = new Map<string, { value: unknown; expires: number }>();
  private teamId: string | undefined;
  /** Requests issued since startup — the number the plan's acceptance criteria measure. */
  private requestCount = 0;

  constructor(
    private readonly token: string,
    opts: { teamId?: string; ratePerMinute?: number } = {},
  ) {
    this.teamId = opts.teamId;
    this.gate = new Gate(opts.ratePerMinute ?? DEFAULT_RATE_LIMIT, CONCURRENCY);
  }

  get calls(): number {
    return this.requestCount;
  }

  private url(path: string, query?: Query): string {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // ClickUp expects repeated `key[]=v` for list filters.
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T>(
    path: string,
    opts: { method?: string; query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const url = this.url(path, opts.query);

    for (let attempt = 0; ; attempt++) {
      await this.gate.acquire();
      let response: Response;
      try {
        this.requestCount++;
        response = await fetch(url, {
          method,
          headers: {
            // Personal tokens go in raw — `Bearer` is the OAuth form and is rejected here.
            Authorization: this.token,
            "Content-Type": "application/json",
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } finally {
        this.gate.release();
      }

      const remaining = response.headers.get("X-RateLimit-Remaining");
      const reset = response.headers.get("X-RateLimit-Reset");
      console.error(
        `[clickup] ${method} ${path} -> ${response.status} remaining=${remaining ?? "?"} (call #${this.requestCount})`,
      );

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new ClickUpError(429, path, "rate limited after retries");
        }
        // `X-RateLimit-Reset` is a unix timestamp in seconds.
        const resetMs = reset ? Number(reset) * 1000 : 0;
        const until = resetMs > Date.now() ? resetMs : Date.now() + 5_000;
        this.gate.pause(until + 250);
        console.error(
          `[clickup] 429 — holding ${Math.ceil((until - Date.now()) / 1000)}s, retry ${attempt + 1}/${MAX_RETRIES}`,
        );
        continue;
      }

      // Coast down before ClickUp cuts us off, rather than spending the last few
      // requests and taking a 429 mid-fan-out.
      if (remaining !== null && Number(remaining) <= 2 && reset) {
        this.gate.pause(Number(reset) * 1000 + 250);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ClickUpError(response.status, path, text.slice(0, 500));
      }

      return (await response.json()) as T;
    }
  }

  /** Memoise structural reads. Task data is deliberately never cached. */
  async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const value = await load();
    this.cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  /** The authenticated user's numeric id — ClickUp's `assignees[]` filter rejects names. */
  async me(): Promise<ClickUpUser> {
    return this.cached("me", STRUCTURE_TTL_MS, async () => {
      const data = await this.request<{ user: ClickUpUser }>("/user");
      return data.user;
    });
  }

  async getTeamId(): Promise<string> {
    if (this.teamId) return this.teamId;
    const teams = await this.cached("teams", STRUCTURE_TTL_MS, async () => {
      const data = await this.request<{ teams: Array<{ id: string; name: string }> }>("/team");
      return data.teams;
    });
    const first = teams[0];
    if (!first) throw new Error("This token can see no ClickUp workspace.");
    if (teams.length > 1) {
      console.error(
        `[clickup] token sees ${teams.length} workspaces, using "${first.name}" — set CLICKUP_TEAM_ID to pin another`,
      );
    }
    this.teamId = first.id;
    return first.id;
  }

  /**
   * Walk `GET /team/{id}/task` until ClickUp runs dry or `maxPages` is reached.
   *
   * Hitting the cap is reported, never silently swallowed — a truncated report that
   * looks complete is worse than a short one that says so.
   */
  async searchTasks(query: Query, maxPages = 10): Promise<Paged<Record<string, unknown>>> {
    const teamId = await this.getTeamId();
    const items: Array<Record<string, unknown>> = [];
    let page = 0;

    for (; page < maxPages; page++) {
      const data = await this.request<{
        tasks: Array<Record<string, unknown>>;
        last_page?: boolean;
      }>(`/team/${teamId}/task`, { query: { ...query, page } });

      items.push(...data.tasks);
      // ClickUp pages at 100; a short page means we reached the end.
      if (data.last_page === true || data.tasks.length < 100) {
        return { items, truncated: false, pages: page + 1 };
      }
    }
    return { items, truncated: true, pages: page };
  }
}
