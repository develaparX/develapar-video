import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

// Everything that differs between macOS, Windows and Linux lives here, so the rest of the code stays the same on all
// three. macOS is the tested platform; the Windows and Linux branches are written to each system's own documented
// tools but have not been run on a real machine yet.
export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

// How the panel names this computer and its bin, so nothing says "Mac" on a PC.
export const COMPUTER = IS_MAC ? "this Mac" : IS_WIN ? "this PC" : "this computer";
export const BIN = IS_MAC ? "the Mac's Trash" : IS_WIN ? "the Recycle Bin" : "the Trash";

export const FFMPEG_HINT = IS_MAC ? "brew install ffmpeg" : IS_WIN ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

function findWinGetTool(exeName: string): string {
  if (!IS_WIN || !process.env.LOCALAPPDATA) return "";
  const pkgsRoot = join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  if (!existsSync(pkgsRoot)) return "";
  try {
    for (const pkg of readdirSync(pkgsRoot)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const pkgDir = join(pkgsRoot, pkg);
      const directBin = join(pkgDir, "bin", exeName);
      if (existsSync(directBin)) return directBin;
      for (const sub of readdirSync(pkgDir)) {
        const subBin = join(pkgDir, sub, "bin", exeName);
        if (existsSync(subBin)) return subBin;
      }
    }
  } catch {}
  return "";
}

export function findFfmpeg(): string {
  if (process.env.FLOW_MCP_FFMPEG && existsSync(process.env.FLOW_MCP_FFMPEG)) return process.env.FLOW_MCP_FFMPEG;
  const execDir = process.execPath ? dirname(process.execPath) : process.cwd();
  const candidates = IS_WIN ? [
    join(execDir, "ffmpeg.exe"),
    join(execDir, "binaries", "ffmpeg.exe"),
    join(execDir, "..", "binaries", "ffmpeg.exe"),
    join(execDir, "..", "Resources", "binaries", "ffmpeg.exe"),
    join(process.cwd(), "ffmpeg.exe"),
    join(process.cwd(), "binaries", "ffmpeg.exe"),
    join(process.cwd(), "..", "binaries", "ffmpeg.exe"),
    join(process.cwd(), "..", "Resources", "binaries", "ffmpeg.exe"),
    findWinGetTool("ffmpeg.exe"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "apps", "ffmpeg", "current", "bin", "ffmpeg.exe") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "shims", "ffmpeg.exe") : "",
    "C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
  ].filter(Boolean) : [
    join(execDir, "ffmpeg"),
    join(execDir, "binaries", "ffmpeg"),
    join(execDir, "..", "binaries", "ffmpeg"),
    join(execDir, "..", "Resources", "binaries", "ffmpeg"),
    join(process.cwd(), "ffmpeg"),
    join(process.cwd(), "binaries", "ffmpeg"),
    join(process.cwd(), "..", "Resources", "binaries", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.FLOW_MCP_FFMPEG = c;
      return c;
    }
  }
  const bunObj = (globalThis as unknown as { Bun?: { which?: (cmd: string) => string | null } }).Bun;
  const whichFfmpeg = typeof bunObj?.which === "function" ? bunObj.which("ffmpeg") : null;
  if (whichFfmpeg) {
    process.env.FLOW_MCP_FFMPEG = whichFfmpeg;
    return whichFfmpeg;
  }
  return "ffmpeg";
}

export function findFfprobe(): string {
  if (process.env.FLOW_MCP_FFPROBE && existsSync(process.env.FLOW_MCP_FFPROBE)) return process.env.FLOW_MCP_FFPROBE;
  const execDir = process.execPath ? dirname(process.execPath) : process.cwd();
  const candidates = IS_WIN ? [
    join(execDir, "ffprobe.exe"),
    join(execDir, "binaries", "ffprobe.exe"),
    join(execDir, "..", "binaries", "ffprobe.exe"),
    join(execDir, "..", "Resources", "binaries", "ffprobe.exe"),
    join(process.cwd(), "ffprobe.exe"),
    join(process.cwd(), "binaries", "ffprobe.exe"),
    join(process.cwd(), "..", "binaries", "ffprobe.exe"),
    join(process.cwd(), "..", "Resources", "binaries", "ffprobe.exe"),
    findWinGetTool("ffprobe.exe"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffprobe.exe") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "apps", "ffmpeg", "current", "bin", "ffprobe.exe") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "shims", "ffprobe.exe") : "",
    "C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\ffmpeg\\bin\\ffprobe.exe",
  ].filter(Boolean) : [
    join(execDir, "ffprobe"),
    join(execDir, "binaries", "ffprobe"),
    join(execDir, "..", "binaries", "ffprobe"),
    join(execDir, "..", "Resources", "binaries", "ffprobe"),
    join(process.cwd(), "ffprobe"),
    join(process.cwd(), "binaries", "ffprobe"),
    join(process.cwd(), "..", "Resources", "binaries", "ffprobe"),
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.FLOW_MCP_FFPROBE = c;
      return c;
    }
  }
  const bunObj = (globalThis as unknown as { Bun?: { which?: (cmd: string) => string | null } }).Bun;
  const whichFfprobe = typeof bunObj?.which === "function" ? bunObj.which("ffprobe") : null;
  if (whichFfprobe) {
    process.env.FLOW_MCP_FFPROBE = whichFfprobe;
    return whichFfprobe;
  }
  return "ffprobe";
}

export function getDevideoBaseDir(): string {
  if (IS_WIN) {
    const videos = process.env.USERPROFILE ? join(process.env.USERPROFILE, "Videos") : homedir();
    const candidate = join(videos, "devideo");
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      const fallback = join(homedir(), "devideo");
      try { mkdirSync(fallback, { recursive: true }); } catch {}
      return fallback;
    }
  }
  return join(homedir(), "Movies", "devideo");
}

export function getProductDir(): string {
  const dir = join(getDevideoBaseDir(), "product");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function getOutputDir(): string {
  const dir = join(getDevideoBaseDir(), "output");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function getEndcardDir(): string {
  const dir = join(getDevideoBaseDir(), "endcard");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function getCheckpointDir(): string {
  const dir = join(getDevideoBaseDir(), "checkpoints");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function openDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    if (IS_MAC) execFileSync("open", [dir], { stdio: "ignore" });
    else if (IS_WIN) execFileSync("explorer.exe", [dir], { stdio: "ignore" });
    else execFileSync("xdg-open", [dir], { stdio: "ignore" });
  } catch {}
}

export function chooseSaveVideoPath(defaultName: string): string | null {
  const safeName = basename(defaultName || "video.mp4").replace(/[/\\?%*:|"<>]/g, "_") || "video.mp4";
  const downloadsDir = join(homedir(), "Downloads");
  try { mkdirSync(downloadsDir, { recursive: true }); } catch {}

  if (IS_MAC) {
    const appleScript = [
      "on run argv",
      "  set defName to item 1 of argv",
      "  tell application \"SystemUIServer\"",
      "    activate",
      "    set targetFile to choose file name with prompt \"Simpan Video MP4 ke:\" default name defName default location (path to downloads folder)",
      "  end tell",
      "  return POSIX path of targetFile",
      "end run",
    ].join("\n");
    try {
      const out = execFileSync("osascript", ["-e", appleScript, safeName], {
        encoding: "utf8",
        timeout: 300_000,
      }).trim();
      if (!out) return null;
      return out.toLowerCase().endsWith(".mp4") ? out : `${out}.mp4`;
    } catch {
      // User clicked Cancel (-128)
      return null;
    }
  }

  if (IS_WIN) {
    const psScript = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "[System.Windows.Forms.Application]::EnableVisualStyles()",
      "$dlg = New-Object System.Windows.Forms.SaveFileDialog",
      "$dlg.Title = 'Simpan Video MP4'",
      "$dlg.Filter = 'MP4 Video (*.mp4)|*.mp4|All Files (*.*)|*.*'",
      "$dlg.DefaultExt = 'mp4'",
      "$dlg.AddExtension = $true",
      "$dlg.OverwritePrompt = $true",
      "$dlg.FileName = $env:SAVEDLG_FILENAME",
      "if (Test-Path $env:SAVEDLG_INITDIR) { $dlg.InitialDirectory = $env:SAVEDLG_INITDIR }",
      "$top = New-Object System.Windows.Forms.Form",
      "$top.TopMost = $true",
      "$top.StartPosition = 'CenterScreen'",
      "$top.Opacity = 0",
      "$top.ShowInTaskbar = $false",
      "if ($dlg.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }",
      "$top.Dispose()",
    ].join("; ");
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", psScript],
        {
          encoding: "utf8",
          timeout: 300_000,
          windowsHide: true,
          env: {
            ...process.env,
            SAVEDLG_FILENAME: safeName,
            SAVEDLG_INITDIR: downloadsDir,
          },
        }
      ).trim();
      if (!out) return null;
      return out.toLowerCase().endsWith(".mp4") ? out : `${out}.mp4`;
    } catch {
      return null;
    }
  }

  // Linux fallback (zenity -> Downloads folder)
  try {
    const out = execFileSync(
      "zenity",
      ["--file-selection", "--save", "--confirm-overwrite", `--filename=${join(downloadsDir, safeName)}`],
      { encoding: "utf8", timeout: 300_000 }
    ).trim();
    if (!out) return null;
    return out.toLowerCase().endsWith(".mp4") ? out : `${out}.mp4`;
  } catch {
    return join(downloadsDir, safeName);
  }
}
// PowerShell single-quoted string: the only character that needs escaping is the quote itself.
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function powershell(script: string, timeout = 120_000): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

// Puts a file or folder in the system's own bin so it can be restored: the Mac's Trash, Windows' Recycle Bin, or the
// freedesktop Trash on Linux. Never deletes anything outright.
export function moveToBin(target: string): string {
  if (IS_MAC) {
    const bin = join(homedir(), ".Trash");
    const name = basename(target);
    const ext = extname(name);
    const dest = existsSync(join(bin, name)) ? join(bin, `${name.slice(0, name.length - ext.length)}-${Date.now()}${ext}`) : join(bin, name);
    renameSync(target, dest);
    return dest;
  }
  if (IS_WIN) {
    const kind = statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
    powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    );
    return BIN;
  }
  try {
    execFileSync("gio", ["trash", target], { stdio: "ignore" });
    return BIN;
  } catch {
    const bin = join(homedir(), ".local", "share", "Trash", "files");
    mkdirSync(bin, { recursive: true });
    const dest = join(bin, `${basename(target)}-${Date.now()}`);
    renameSync(target, dest);
    return dest;
  }
}

// Unpacks a ZIP with the system's own tools: tar on macOS and Windows 10+ is bsdtar, which reads ZIPs; unzip is the
// fallback (Linux, older Windows). Returns every file inside, however deeply the archive nested them.
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dest);
  return files;
}

// Opens a page in the default browser.
export function openUrl(url: string): void {
  try {
    if (IS_MAC) execFileSync("open", [url], { stdio: "ignore" });
    else if (IS_WIN) execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // Opening the browser is a convenience; the address is printed either way.
  }
}
