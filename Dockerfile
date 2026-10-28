# battle-training-mcp — MCP server for battle.training
# Stdio by default; `--http 8787` switches to Streamable HTTP.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# MCP servers speak JSON-RPC over stdio; no ports by default.
# Expose 8787 for the optional Streamable HTTP transport.
EXPOSE 8787

ENTRYPOINT ["node", "server.js"]
