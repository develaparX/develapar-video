import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { IS_MAC, IS_WIN, normalizeProfilePath, powershell } from "./platform.js";

export const FLOW_URL = "https://flow.google.com/";
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that: `hl=es` turned every label Spanish on
// an English account (2026-10-13), the choice holds through Flow's in-app navigation, and the browser's own language
// changes nothing. It only lasts until the next full page load, so every load adds it and ensureEnglish re-checks.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/^\/fx\/[a-z]{2}(?:-[A-Z]{2})?\/tools\/flow(\/|$)/i, "/fx/tools/flow$1");
  u.searchParams.set("hl", "en");
  return u.toString();
};
export const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
export const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;
let connectedProfileDir: string | null = null;
let chromeChild: ChildProcess | null = null;
let currentProfileDir: string = PROFILE_DIR;

export function engineLog(scope: string, message: string): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
    appendFileSync(join(HOME_DIR, "engine.log"), line, "utf8");
  } catch {}
}

export function setProfileDir(dir: string): void {
  currentProfileDir = dir;
}

export function getProfileDir(): string {
  return currentProfileDir;
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0 || Number.isNaN(pid)) return false;
  if (IS_WIN) {
    try {
      const out = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      return out.includes(String(pid));
    } catch {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killPid(pid: number, force = false): void {
  if (!pid || pid <= 0 || Number.isNaN(pid)) return;
  if (IS_WIN) {
    try {
      execFileSync("taskkill.exe", ["/F", "/PID", String(pid), "/T"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {}
}

function lsofBin(): string {
  if (existsSync("/usr/sbin/lsof")) return "/usr/sbin/lsof";
  if (existsSync("/usr/bin/lsof")) return "/usr/bin/lsof";
  return "lsof";
}

function psBin(): string {
  if (existsSync("/bin/ps")) return "/bin/ps";
  if (existsSync("/usr/bin/ps")) return "/usr/bin/ps";
  return "ps";
}

export function runningChromePidSync(): number | null {
  try {
    if (IS_WIN) {
      const out = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("TCP")) continue;
        const parts = trimmed.split(/\s+/);
        // TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 12345
        if (parts.length >= 5 && parts[1]?.endsWith(`:${CDP_PORT}`) && /LISTENING/i.test(parts[3] ?? "")) {
          const pid = Number(parts[4]);
          if (pid > 0) return pid;
        }
      }
      return null;
    }

    const out = execFileSync(lsofBin(), ["-nP", `-iTCP:${CDP_PORT}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (!out) return null;
    const first = Number(out.split(/\s+/)[0]);
    return first > 0 ? first : null;
  } catch {
    return null;
  }
}

export async function runningChromePid(): Promise<number | null> {
  return runningChromePidSync();
}

function extractUserDataDirFromCmd(cmd: string): string | null {
  if (!cmd) return null;
  const m = cmd.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--[a-z-]+|$)/i);
  const raw = (m?.[1] || m?.[2] || m?.[3] || "").trim();
  return raw || null;
}

let cachedCmdPid: number | null = null;
let cachedCmdLine: string | null = null;

function runningChromeCmdLineSync(): string | null {
  const pid = runningChromePidSync();
  if (!pid) {
    cachedCmdPid = null;
    cachedCmdLine = null;
    return null;
  }
  if (pid === cachedCmdPid && cachedCmdLine !== null) {
    return cachedCmdLine;
  }
  try {
    if (IS_WIN) {
      const out =
        powershell(
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
          2500,
        ).trim() || null;
      cachedCmdPid = pid;
      cachedCmdLine = out;
      return out;
    }
    const out =
      execFileSync(psBin(), ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null;
    cachedCmdPid = pid;
    cachedCmdLine = out;
    return out;
  } catch {
    return null;
  }
}

export function isRunningChromeHeadlessSync(): boolean {
  const cmd = runningChromeCmdLineSync();
  if (!cmd) return false;
  return /--headless\b/i.test(cmd);
}

export function runningProfileDirSync(): string | null {
  const pid = runningChromePidSync();
  if (!pid) return null;
  if (chromeChild && chromeChild.pid === pid && currentProfileDir) {
    return currentProfileDir;
  }
  const cmd = runningChromeCmdLineSync();
  if (!cmd) {
    if (chromeChild && chromeChild.pid === pid && currentProfileDir) {
      return currentProfileDir;
    }
    return null;
  }
  return extractUserDataDirFromCmd(cmd);
}

export async function runningProfileDir(): Promise<string | null> {
  return runningProfileDirSync();
}

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function isChromeRunning(): Promise<boolean> {
  return cdpUp();
}

export interface CdpTargetInfo {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
}

export async function listCdpTargets(): Promise<CdpTargetInfo[]> {
  try {
    const res = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as CdpTargetInfo[]) : [];
  } catch {
    return [];
  }
}

export async function disconnectBrowserConnectionOnly(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
  }
  connectedProfileDir = null;
}

async function sendCdpBrowserClose(): Promise<boolean> {
  // 1. Try via existing Playwright browser connection if present
  if (browser?.isConnected()) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => {});
      return true;
    } catch {}
  }

  // 2. Try via raw WebSocket to webSocketDebuggerUrl from /json/version
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const info = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl && typeof WebSocket !== "undefined") {
        await new Promise<void>((resolveWs) => {
          const ws = new WebSocket(info.webSocketDebuggerUrl!);
          const timer = setTimeout(() => {
            try { ws.close(); } catch {}
            resolveWs();
          }, 1500);
          ws.onopen = () => {
            try {
              ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
            } catch {}
            setTimeout(() => {
              clearTimeout(timer);
              try { ws.close(); } catch {}
              resolveWs();
            }, 250);
          };
          ws.onerror = () => {
            clearTimeout(timer);
            resolveWs();
          };
          ws.onclose = () => {
            clearTimeout(timer);
            resolveWs();
          };
        });
        return true;
      }
    }
  } catch {}

  // 3. Fallback: temporary connectOverCDP
  try {
    const tempBrowser = await chromium.connectOverCDP(CDP_URL, { timeout: 2000 });
    const session = await tempBrowser.newBrowserCDPSession();
    await session.send("Browser.close").catch(() => {});
    await tempBrowser.close().catch(() => {});
    return true;
  } catch {}

  return false;
}

/**
 * Gracefully shuts down the Chrome instance holding CDP_PORT (9333):
 * 1. CDP `Browser.close` (flushes SQLite cookies & Local State cleanly) -> wait up to 8s
 * 2. SIGTERM -> wait up to 4s
 * 3. SIGKILL -> last resort
 */
export async function shutdownChrome(): Promise<void> {
  let pid = (await runningChromePid()) ?? chromeChild?.pid ?? null;
  const up = await cdpUp();

  if (!up && (!pid || !isPidAlive(pid))) {
    await disconnectBrowserConnectionOnly();
    chromeChild = null;
    return;
  }

  engineLog("chrome", `shutdownChrome starting (pid=${pid ?? "none"}, cdpUp=${up})`);

  if (up) {
    await sendCdpBrowserClose();
    await disconnectBrowserConnectionOnly();

    // Wait up to 6 seconds for port to go down and process to exit
    for (let i = 0; i < 12; i++) {
      const stillUp = await cdpUp();
      const currentPid = pid ?? (await runningChromePid());
      const stillAlive = currentPid ? isPidAlive(currentPid) : false;
      if (!stillUp && !stillAlive) {
        chromeChild = null;
        engineLog("chrome", `shutdownChrome completed gracefully via CDP Browser.close (pid=${pid ?? "none"})`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    await disconnectBrowserConnectionOnly();
  }

  pid = pid ?? (await runningChromePid()) ?? chromeChild?.pid ?? null;
  if (pid && isPidAlive(pid)) {
    engineLog("chrome", `shutdownChrome terminating pid=${pid}`);
    killPid(pid, false);
    for (let i = 0; i < 6; i++) {
      if (!isPidAlive(pid) && !(await cdpUp())) {
        chromeChild = null;
        engineLog("chrome", `shutdownChrome completed termination for pid=${pid}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  pid = pid ?? (await runningChromePid()) ?? chromeChild?.pid ?? null;
  if (pid && isPidAlive(pid)) {
    engineLog("chrome", `shutdownChrome force-killing pid=${pid}`);
    killPid(pid, true);
    for (let i = 0; i < 4; i++) {
      if (!isPidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  chromeChild = null;
  await disconnectBrowserConnectionOnly();
  engineLog("chrome", `shutdownChrome finished (pid=${pid ?? "none"})`);
}

export function killChrome(): void {
  void shutdownChrome();
}

export async function disconnectBrowser(): Promise<void> {
  await shutdownChrome();
}

export async function captureBrowserStorageState(): Promise<{ cookies?: any[]; origins?: any[] } | undefined> {
  try {
    if (!(await cdpUp())) return undefined;
    if (!browser?.isConnected()) {
      browser = await chromium.connectOverCDP(CDP_URL);
      connectedProfileDir = (await runningProfileDir()) ? resolve((await runningProfileDir())!) : null;
    }
    if (browser?.isConnected()) {
      return await browser.contexts()[0]?.storageState().catch(() => undefined);
    }
  } catch {}
  return undefined;
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
export function chromeExecutable(): string {
  if (process.env.FLOW_MCP_CHROME && existsSync(process.env.FLOW_MCP_CHROME)) {
    return process.env.FLOW_MCP_CHROME;
  }

  const candidates: string[] = [];

  if (IS_WIN) {
    const progFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const progFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const progW6432 = process.env.ProgramW6432;
    const localAppData = process.env.LOCALAPPDATA;

    candidates.push(
      join(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(progFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    );
    if (progW6432) {
      candidates.push(join(progW6432, "Google", "Chrome", "Application", "chrome.exe"));
    }
    if (localAppData) {
      candidates.push(join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
    }

    try {
      const out = execFileSync("where.exe", ["chrome.exe"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      }).trim();
      if (out) {
        for (const line of out.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && existsSync(trimmed)) candidates.push(trimmed);
        }
      }
    } catch {}
  } else if (IS_MAC) {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    );
  }

  const bunObj = (globalThis as unknown as { Bun?: { which?: (cmd: string) => string | null } }).Bun;
  const whichChrome = typeof bunObj?.which === "function" ? bunObj.which("google-chrome") || bunObj.which("chrome") : null;
  if (whichChrome && existsSync(whichChrome)) {
    candidates.push(whichChrome);
  }

  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error(
      "Google Chrome tidak ditemukan. Pastikan Google Chrome terinstal di komputer atau tentukan path pada env FLOW_MCP_CHROME.",
    );
  }
  return found;
}

async function cleanOrVerifySingletonLock(dir: string): Promise<void> {
  const lock = join(dir, "SingletonLock");
  let st;
  try {
    st = lstatSync(lock);
  } catch {
    st = null;
  }

  if (st && st.isSymbolicLink()) {
    let target = "";
    try {
      target = readlinkSync(lock);
    } catch {}
    const pidMatch = target.match(/-(\d+)$/);
    if (pidMatch) {
      const lockPid = Number(pidMatch[1]);
      if (lockPid > 0 && isPidAlive(lockPid)) {
        // Wait up to 2s in case the previous Chrome is still finishing shutdown
        for (let i = 0; i < 4 && isPidAlive(lockPid); i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (isPidAlive(lockPid)) {
          throw new Error(
            `Profil Chrome sedang digunakan oleh proses Chrome lain (PID ${lockPid}). Tutup jendela Chrome tersebut terlebih dahulu.`,
          );
        }
      }
      engineLog("chrome", `Removing stale SingletonLock in ${dir} (dead pid=${lockPid})`);
    }
    try { unlinkSync(lock); } catch {}
    try { unlinkSync(join(dir, "SingletonCookie")); } catch {}
    try { unlinkSync(join(dir, "SingletonSocket")); } catch {}
    return;
  }

  // Regular file (non-symlink) lock (Windows or non-symlink POSIX)
  if (!(await cdpUp())) {
    try { if (existsSync(lock)) unlinkSync(lock); } catch {}
    try {
      const lockfile = join(dir, "lockfile");
      if (existsSync(lockfile)) unlinkSync(lockfile);
    } catch {}
  }
}

export async function ensureChromeForProfile(
  dir: string,
  opts?: { visible?: boolean; openUrl?: string; bringToFront?: boolean },
): Promise<void> {
  try {
    const targetDir = resolve(dir || currentProfileDir || PROFILE_DIR);
    currentProfileDir = targetDir;
    mkdirSync(targetDir, { recursive: true });
    const visible = opts?.visible === true;

    if (await cdpUp()) {
      const runDir = await runningProfileDir();
      if (runDir && normalizeProfilePath(runDir) === normalizeProfilePath(targetDir)) {
        if (visible && isRunningChromeHeadlessSync()) {
          engineLog(
            "chrome",
            `ensureChromeForProfile: profile ${targetDir} is running headless but visible=true requested; restarting visibly`,
          );
          await shutdownChrome();
        } else {
          if (opts?.bringToFront === true && visible) {
            bringChromeToFront();
          }
          return;
        }
      } else {
        engineLog(
          "chrome",
          `ensureChromeForProfile: port ${CDP_PORT} held by ${runDir ?? "unknown"}, shutting down before launching ${targetDir}`,
        );
        await shutdownChrome();
      }
    }

    await cleanOrVerifySingletonLock(targetDir);

    const chromePath = chromeExecutable();
    const initialUrl = opts?.openUrl ?? inEnglish(FLOW_URL);
    const args = [
      `--user-data-dir=${targetDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--lang=en-US",
      "--accept-lang=en-US,en",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (!visible) {
      args.push("--headless=new", "--window-size=1440,900");
    }
    args.push(initialUrl);

    engineLog("chrome", `Launching Chrome for profile ${targetDir} (visible=${visible}, url=${initialUrl})`);
    const spawnOpts = IS_WIN
      ? {
          detached: false,
          stdio: "ignore" as const,
          windowsHide: false,
        }
      : {
          detached: true,
          stdio: "ignore" as const,
          windowsHide: !visible,
        };

    const child = spawn(chromePath, args, spawnOpts);
    child.on("error", (err) => {
      engineLog("chrome", `Chrome child process spawn error: ${err.message}`);
    });
    chromeChild = child;
    child.unref();

    for (let i = 0; i < 40; i++) {
      if (await cdpUp()) {
        const verifyDir = await runningProfileDir();
        if (verifyDir && normalizeProfilePath(verifyDir) !== normalizeProfilePath(targetDir)) {
          throw new Error(
            `wrong_profile: Chrome berjalan pada port ${CDP_PORT} dengan profil berbeda (${verifyDir} != ${targetDir}).`,
          );
        }
        if (opts?.bringToFront === true && visible) {
          bringChromeToFront();
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Chrome started for ${targetDir} but CDP port ${CDP_PORT} never came up.`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    engineLog("chrome", `ensureChromeForProfile failed for ${dir}: ${errorMsg}`);
    throw err instanceof Error ? err : new Error(errorMsg);
  }
}

export function bringChromeToFront(): void {
  if (!IS_MAC) return;
  try {
    execFileSync("osascript", ["-e", 'tell application "Google Chrome" to activate'], {
      stdio: "ignore",
      timeout: 3000,
    });
  } catch {}
}

export async function getBrowser(opts?: { autoLaunch?: boolean }): Promise<Browser> {
  const expectedDir = resolve(currentProfileDir || PROFILE_DIR);
  const up = await cdpUp();

  if (!up) {
    if (opts?.autoLaunch === false) {
      await disconnectBrowserConnectionOnly();
      throw new Error("chrome_off: Chrome sedang tidak berjalan.");
    }
    await ensureChromeForProfile(expectedDir, { visible: false });
  } else {
    const runDir = await runningProfileDir();
    // Compared the same way as ensureChromeForProfile: Windows paths differ only by case and that used to be read
    // as "wrong profile", restarting Chrome under the user mid-job.
    if (runDir && normalizeProfilePath(runDir) !== normalizeProfilePath(expectedDir)) {
      await disconnectBrowserConnectionOnly();
      engineLog("chrome", `getBrowser: wrong_profile (running=${runDir}, expected=${expectedDir})`);
      throw new Error(`wrong_profile: Chrome sedang berjalan dengan profil lain (${runDir} != ${expectedDir}).`);
    }
  }

  if (browser?.isConnected() && connectedProfileDir && normalizeProfilePath(connectedProfileDir) === normalizeProfilePath(expectedDir)) {
    return browser;
  }

  await disconnectBrowserConnectionOnly();
  browser = await chromium.connectOverCDP(CDP_URL);
  connectedProfileDir = expectedDir;
  return browser;
}

export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) {
    await existing.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await ensureEnglish(existing);
    return existing;
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
  await ensureEnglish(page);
  return page;
}

// Reloads Flow in English when it is showing in another language (a page the user opened by hand, or Flow redirecting
// to an address without hl). Sign-in pages are left alone.
export async function ensureEnglish(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (!FLOW_HOSTS.test(currentUrl) || /\/about|accounts\.google\.com/.test(currentUrl)) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  let now = await lang();
  const hasHlEn = (() => {
    try {
      const u = new URL(page.url());
      return u.searchParams.get("hl") === "en" && !/^\/fx\/[a-z]{2}(?:-[A-Z]{2})?\/tools\/flow(\/|$)/i.test(u.pathname);
    } catch {
      return false;
    }
  })();
  if (!now && !hasHlEn) {
    await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 4000 }).catch(() => {});
    now = await lang();
  }
  if (/^en\b/i.test(now) && (hasHlEn || now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(
      `Flow is showing in "${after}" and would not switch to English. flow-mcp finds Flow's buttons by their English names. ` +
        `Add ?hl=en to the end of Flow's address in the Flow Chrome window, or set your Google account's language to English (myaccount.google.com/language).`,
    );
  }
}
