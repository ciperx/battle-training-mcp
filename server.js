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
      "user-agent": "battle-training-mcp/1.1",
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

// Build "?a=1&b=2" from the defined entries of an object ("" when none are set).
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

// Fetch a non-JSON resource (starter source, docs, replay JSONL) as text.
async function fetchText(path) {
  const res = await fetch(BASE + path, { headers: { "user-agent": "battle-training-mcp/1.1" } });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  return body;
}

// Tools that act on an account fail fast with a clear hint instead of a bare 401.
const KEY_TOOLS = new Set(["whoami", "create_bot", "upload_version", "enrol_cup", "scrimmage"]);

const STARTERS = { armor: "/starters/controller.js", sub: "/starters/controller-sub.js", urban: "/starters/controller-urban.js" };
const API_DOCS = { armor: "/docs/controller-api.md", urban: "/docs/controller-api.md", sub: "/docs/controller-api-sub.md" };
const THEATER = { type: "string", enum: ["armor", "sub", "urban"], description: "armor (default), sub (Silent Service) or urban (Armor: New Terrain preview)" };

const TOOLS = [
  {
    name: "get_started",
    description: "The full path from zero to a ranked controller, plus the current rules version.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_rules",
    description: "Machine-readable rules: unit specs, map size, tick rate, objectives, budget limits.",
    inputSchema: {
      type: "object",
      properties: { version: { type: "string", description: "Optional rules version, e.g. s2.0.0, sub-s1.0.0" } },
    },
  },
  {
    name: "get_starter",
    description: "A working JavaScript starter controller to copy and improve.",
    inputSchema: { type: "object", properties: { theater: THEATER } },
  },
  {
    name: "get_controller_api",
    description: "The controller API reference (markdown): hello(), draft(), tick(), observations and orders.",
    inputSchema: { type: "object", properties: { theater: THEATER } },
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
      properties: {
        bot: { type: "string", description: "Optional bot name filter" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Optional page size" },
      },
    },
  },
  {
    name: "get_replay",
    description: "Replay of one game of a match as JSONL (header + per-tick states), for local re-simulation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Match id" },
        game: { type: "integer", minimum: 1, description: "Game number within the set (default 1)" },
        max_chars: { type: "integer", minimum: 1000, description: "Truncate the returned text (default 100000)" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_live",
    description: "Matches being played right now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_meta",
    description: "Draft meta: what the arena drafts and how squads fare against each other.",
    inputSchema: {
      type: "object",
      properties: {
        theater: { type: "string", enum: ["armor", "sub"] },
        days: { type: "integer", minimum: 1, maximum: 30, description: "Window in days (default 7)" },
      },
    },
  },
  {
    name: "get_agents",
    description: "Agent standings: which coding agents and models build the strongest bots.",
    inputSchema: { type: "object", properties: {} },
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
    name: "get_bot_history",
    description: "A bot's rating over time, per version (public).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_bot_opponents",
    description: "A bot's record against each opponent it has met (public).",
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
  {
    name: "scrimmage",
    description: "Unrated two-game scrimmage on a chosen seed vs a bot, sparring partner or house style (e.g. house:hunter), or a Bench practice game (pool + index + vs R1..R5). Requires BT_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Your bot" },
        vs: { type: "string", description: "Opponent bot, house:<style>, or R1..R5 with pool" },
        seed: { type: "integer" },
        theater: { type: "string", enum: ["armor", "sub"] },
        pool: { type: "string", description: "e.g. bench-public" },
        index: { type: "integer", minimum: 0, maximum: 15 },
        side: { type: "integer", enum: [0, 1] },
        games: { type: "integer", enum: [1, 2] },
      },
      required: ["bot", "vs"],
    },
  },
];

function createMcpServer() {
  const server = new Server(
    { name: "battle-training-mcp", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      if (KEY_TOOLS.has(name) && !KEY) {
        throw new Error(`${name} needs an API key: set BT_API_KEY (shown once by POST ${BASE}/api/accounts)`);
      }
      return text(await callTool(name, args));
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function callTool(name, args) {
  const enc = encodeURIComponent;
  const theater = args.theater || "armor";
  switch (name) {
    case "get_started": return api("/api");
    case "get_rules": return api(`/api/rules${qs({ version: args.version })}`);
    case "get_starter": return { theater, source: await fetchText(STARTERS[theater] || STARTERS.armor) };
    case "get_controller_api": return { theater, markdown: await fetchText(API_DOCS[theater] || API_DOCS.armor) };
    case "get_ladder": return api("/api/ladder");
    case "list_matches": return api(`/api/matches${qs({ bot: args.bot, limit: args.limit })}`);
    case "get_match": return api(`/api/matches/${enc(args.id)}`);
    case "get_replay": {
      const max = args.max_chars || 100000;
      const body = await fetchText(`/api/replays/${enc(args.id)}.jsonl${qs({ game: args.game })}`);
      return { id: args.id, game: args.game || 1, bytes: body.length, truncated: body.length > max, jsonl: body.slice(0, max) };
    }
    case "get_live": return api("/api/live");
    case "get_meta": return api(`/api/meta${qs({ theater: args.theater, days: args.days })}`);
    case "get_agents": return api("/api/agents");
    case "list_ladders": return api("/api/ladders");
    case "get_cup": return api(`/api/ladders/${enc(args.slug)}`);
    case "whoami": return api("/api/me");
    case "get_bot": return api(`/api/bots/${enc(args.name)}`);
    case "get_bot_history": return api(`/api/bots/${enc(args.name)}/history`);
    case "get_bot_opponents": return api(`/api/bots/${enc(args.name)}/opponents`);
    case "create_bot": return api("/api/bots", { method: "POST", body: args });
    case "upload_version": return api(`/api/bots/${enc(args.bot)}/versions`, {
      method: "POST",
      body: { label: args.label, source: args.source, notes: args.notes },
    });
    case "enrol_cup": return api(`/api/ladders/${enc(args.slug)}/enrol`, {
      method: "POST",
      body: { bot: args.bot },
    });
    case "scrimmage": {
      const body = {};
      for (const k of ["bot", "vs", "seed", "theater", "pool", "index", "side", "games"]) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      return api("/api/scrimmage", { method: "POST", body });
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// Stateless Streamable HTTP: the SDK refuses to reuse a stateless transport, so
// every POST gets its own server + transport (the pattern the SDK documents).
async function handleHttp(req, res) {
  if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" })
      .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
}

async function main() {
  const httpFlag = process.argv.includes("--http");
  if (httpFlag) {
    const port = Number(process.argv[process.argv.indexOf("--http") + 1]) || 8787;
    const http = createHttpServer((req, res) => { handleHttp(req, res); });
    http.listen(port, () => console.error(`battle-training-mcp listening on http://localhost:${port}/mcp`));
  } else {
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
    console.error("battle-training-mcp running on stdio");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
