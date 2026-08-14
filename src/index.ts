#!/usr/bin/env node
/**
 * stdio MCP server for the ClickUp REST API v2.
 *
 * Exists because ClickUp's hosted MCP (mcp.clickup.com) caps a Free workspace at
 * 50 calls per 24 hours and refuses personal API tokens, while the same account's
 * REST API allows 100 requests per minute. Talking to REST directly trades a daily
 * ceiling for a per-minute one.
 */

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ClickUpClient } from "./clickup.js";
import { registerTools } from "./tools.js";

// Read the project's own gitignored .env so the token never has to be written into
// Claude Code's config (where `claude mcp add -e` would store it in plaintext).
// Anything already in the environment wins.
try {
  process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
} catch {
  // No .env — the token is expected to come from the environment instead.
}

const token = process.env.CLICKUP_API_TOKEN;
if (!token) {
  console.error(
    [
      "CLICKUP_API_TOKEN is not set.",
      "Generate one in ClickUp: avatar -> Settings -> Apps -> API Token -> Generate,",
      "then copy .env.example to .env and put it there. Never paste it into a chat.",
    ].join("\n"),
  );
  process.exit(1);
}

const rateLimit = Number(process.env.CLICKUP_RATE_LIMIT);
const clickup = new ClickUpClient(token, {
  teamId: process.env.CLICKUP_TEAM_ID || undefined,
  ratePerMinute: Number.isFinite(rateLimit) && rateLimit > 0 ? rateLimit : undefined,
});

const server = new McpServer({ name: "clickup-custom-mcp", version: "0.1.0" });
registerTools(server, clickup);

// stdout is the JSON-RPC channel — every diagnostic in this server goes to stderr.
console.error(`[clickup] server ready (token ${token.slice(0, 6)}…)`);

const transport = new StdioServerTransport();
await server.connect(transport);
