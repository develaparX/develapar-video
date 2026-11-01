#!/usr/bin/env node
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";

console.log("=== DEVELAPAR VIDEO ENGINE STARTING ===");

// Watchdog 1: If parent desktop app closes stdin pipe (exits, killed, or crashes), exit immediately
try {
  process.stdin.resume();
  process.stdin.on("end", () => {
    console.log("Parent desktop process closed stdin pipe. Exiting engine...");
    process.exit(0);
  });
  process.stdin.on("error", () => {
    process.exit(0);
  });
} catch {}

// Watchdog 2: If orphaned (parent reparented to init/launchd PID 1), exit immediately
if (process.ppid && process.ppid !== 1) {
  const initialPpid = process.ppid;
  setInterval(() => {
    if (process.ppid === 1 && initialPpid !== 1) {
      console.log("Engine orphaned (parent died). Exiting...");
      process.exit(0);
    }
  }, 1000);
}

import { killChrome } from "./chrome.js";

const shutdown = () => {
  console.log("Shutting down Develapar Video Engine and all child processes...");
  killChrome();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const core = new LocalCore();
  const role = await startServer(core);
  const url = `http://127.0.0.1:${PORT}`;

  if (role === "none") {
    console.error(`Port ${PORT} is occupied by an unrelated program. Please set FLOW_MCP_PORT.`);
    shutdown();
  }

  console.log(`[DEVELAPAR_ENGINE_READY] Server running at ${url} (Role: ${role})`);
} catch (err) {
  console.error("Fatal error starting Develapar Video Engine:", err);
  shutdown();
}
