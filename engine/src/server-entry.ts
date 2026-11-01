#!/usr/bin/env node
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";

console.log("=== DEVELAPAR VIDEO ENGINE STARTING ===");

try {
  const core = new LocalCore();
  const role = await startServer(core);
  const url = `http://127.0.0.1:${PORT}`;

  if (role === "none") {
    console.error(`Port ${PORT} is occupied by an unrelated program. Please set FLOW_MCP_PORT.`);
    process.exit(1);
  }

  console.log(`[DEVELAPAR_ENGINE_READY] Server running at ${url} (Role: ${role})`);

  const shutdown = () => {
    console.log("Shutting down Develapar Video Engine...");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (err) {
  console.error("Fatal error starting Develapar Video Engine:", err);
  process.exit(1);
}
