#!/usr/bin/env node
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";

console.log("=== DEVELAPAR VIDEO ENGINE STARTING ===");

// Watchdog: If orphaned on POSIX (parent reparented to init/launchd PID 1), exit immediately
if (process.platform !== "win32" && process.ppid && process.ppid !== 1) {
  const initialPpid = process.ppid;
  setInterval(() => {
    if (process.ppid === 1 && initialPpid !== 1) {
      console.log("Engine orphaned (parent died). Exiting...");
      process.exit(0);
    }
  }, 1000);
}

import { shutdownChrome } from "./chrome.js";

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down Develapar Video Engine and all child processes...");
  await shutdownChrome().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  const core = new LocalCore();
  const role = await startServer(core);
  const url = `http://127.0.0.1:${PORT}`;

  if (role === "none") {
    console.error(`Port ${PORT} is occupied by an unrelated program. Please set FLOW_MCP_PORT.`);
    await shutdown();
  }

  console.log(`[DEVELAPAR_ENGINE_READY] Server running at ${url} (Role: ${role})`);
} catch (err) {
  console.error("Fatal error starting Develapar Video Engine:", err);
  await shutdown();
}
