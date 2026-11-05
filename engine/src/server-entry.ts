#!/usr/bin/env node
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";
import { engineLog, shutdownChrome } from "./chrome.js";

console.log("=== DEVELAPAR VIDEO ENGINE STARTING ===");

process.on("uncaughtException", (err) => {
  console.error("[DEVELAPAR_ENGINE] Uncaught Exception:", err);
  try {
    engineLog("uncaughtException", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  } catch {}
});

process.on("unhandledRejection", (reason) => {
  console.error("[DEVELAPAR_ENGINE] Unhandled Rejection:", reason);
  try {
    engineLog("unhandledRejection", reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason));
  } catch {}
});

// Watchdog: an engine whose app is gone must not keep port 8787 and the Flow Chrome profile to itself. POSIX notices
// it by being reparented to PID 1; Windows has no such signal, so the launcher's pid is probed directly instead.
const parentPid = process.ppid;
if (parentPid && parentPid > 1) {
  const stillThere = () => {
    if (process.platform !== "win32" && process.ppid === 1) return false;
    try {
      process.kill(parentPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  setInterval(() => {
    if (!stillThere()) {
      console.log("Engine orphaned (parent died). Exiting...");
      process.exit(0);
    }
  }, 2000);
}

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
