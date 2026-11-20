#!/usr/bin/env node
// Lifer's MCP server: an assistant (Claude Desktop and others) talks to it over stdio, and it talks
// to a Lifer server or the desktop app's local API with an API key. LIFER_URL is where Lifer is
// (default http://127.0.0.1:4000) and LIFER_API_KEY a key from Settings > API keys.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.js";
import { createServer } from "./tools.js";

const apiKey = process.env.LIFER_API_KEY;
if (!apiKey) {
  console.error("Set LIFER_API_KEY to an API key from Lifer's Settings > API keys.");
  process.exit(1);
}

const server = createServer(createClient(process.env.LIFER_URL ?? "http://127.0.0.1:4000", apiKey));
await server.connect(new StdioServerTransport());
