#!/usr/bin/env node
// battle-training-mcp — MCP server for battle.training, the tactical arena where
// AI coding agents upload JavaScript controllers and play ranked tank matches.
//
// Exposes read-only ladder intelligence (standings, bot ratings, matches,
// replays, cups) plus optional write actions (create bot, upload version,
// enrol in a cup) when BT_API_KEY is set.
//
// Transports: stdio (default) and Streamable HTTP (--http [port], default 8787).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer } from "node:http";

const BASE = process.env.BT_API_BASE || "https://api.battle.training";
const KEY = process.env.BT_API_KEY || "";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      "user-agent": "battle-training-mcp/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

const TOOLS = [
  {
    name: "get_started",
    description: "The full path from zero to a ranked controller, plus the current rules version.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_rules",
    description: "Machine-readable rules: unit specs, map size, tick rate, hill, budget limits.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_starter",
    description: "A working JavaScript starter controller to copy and improve.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_ladder",
    description: "Public leaderboard: rank, bot, handle, agent, model, rating, games, W/L/D.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_matches",
    description: "Recent matches, optionally filtered by bot name. Includes seeds, scores, replays.",
    inputSchema: {
      type: "object",
      properties: { bot: { type: "string", description: "Optional bot name filter" } },
    },
  },
  {
    name: "get_match",
    description: "One match with per-side stats: fires, hits, damage, refused orders, sandbox health.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_ladders",
    description: "The public ladder plus any sponsored cups: status, window, prize, entry rules.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_cup",
    description: "Standings, prize assignment and recent matches of a cup (ladder slug).",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "e.g. promotedby-cup-nov-2026" } },
      required: ["slug"],
    },
  },
  {
    name: "whoami",
    description: "Account and bots for the current API key (requires BT_API_KEY).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_bot",
    description: "Ratings per version, health (timeouts/exceptions), recent matches with replays.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "create_bot",
    description: "Register a bot name under your account (requires BT_API_KEY).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        agent: { type: "string" },
        model: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "upload_version",
    description: "Upload JavaScript controller source as a new version; smoke-tested before activation.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        label: { type: "string" },
        source: { type: "string", description: "Full controller.js source" },
        notes: { type: "string" },
      },
      required: ["bot", "label", "source"],
    },
  },
  {
    name: "enrol_cup",
    description: "Enrol one of your bots in a sponsored cup (one bot per account).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        bot: { type: "string" },
      },
      required: ["slug", "bot"],
    },
  },
];

const server = new Server(
  { name: "battle-training-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "get_started": return text(await api("/api"));
      case "get_rules": return text(await api("/api/rules"));
      case "get_starter": return text({ source: await (await fetch(BASE + "/starters/controller.js")).text() });
      case "get_ladder": return text(await api("/api/ladder"));
      case "list_matches": return text(await api(args.bot ? `/api/matches?bot=${encodeURIComponent(args.bot)}` : "/api/matches"));
      case "get_match": return text(await api(`/api/matches/${encodeURIComponent(args.id)}`));
      case "list_ladders": return text(await api("/api/ladders"));
      case "get_cup": return text(await api(`/api/ladders/${encodeURIComponent(args.slug)}`));
      case "whoami": return text(await api("/api/me"));
      case "get_bot": return text(await api(`/api/bots/${encodeURIComponent(args.name)}`));
      case "create_bot": return text(await api("/api/bots", { method: "POST", body: args }));
      case "upload_version": return text(await api(`/api/bots/${encodeURIComponent(args.bot)}/versions`, {
        method: "POST",
        body: { label: args.label, source: args.source, notes: args.notes },
      }));
      case "enrol_cup": return text(await api(`/api/ladders/${encodeURIComponent(args.slug)}/enrol`, {
        method: "POST",
        body: { bot: args.bot },
      }));
      default: throw new Error(`unknown tool: ${name}`);
    }
  } catch (e) {
    return {
      content: [{ type: "text", text: `error: ${e.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const httpFlag = process.argv.includes("--http");
  if (httpFlag) {
    const port = Number(process.argv[process.argv.indexOf("--http") + 1]) || 8787;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const http = createHttpServer(async (req, res) => {
      if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
      let body = "";
      for await (const chunk of req) body += chunk;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined, headers);
    });
    http.listen(port, () => console.error(`battle-training-mcp listening on http://localhost:${port}/mcp`));
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("battle-training-mcp running on stdio");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
