#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const tauriConf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const version = tauriConf.version;

const DOWNLOAD_BASE = "https://devideo-api.develapar.com/api/auth/update/download";
const LATEST_URL = "https://devideo-api.develapar.com/api/auth/update/latest.json";

function walk(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

const allFiles = walk(join(ROOT, "src-tauri/target"));

const dmgFile = allFiles.find((f) => f.endsWith(".dmg"));
const exeFile = allFiles.find((f) => /setup.*\.exe$/i.test(basename(f)));
const macTarGz = allFiles.find((f) => f.endsWith(".app.tar.gz"));
const macSigFile = allFiles.find((f) => f.endsWith(".app.tar.gz.sig"));
const winNsisZip = allFiles.find((f) => f.endsWith(".nsis.zip"));
const winNsisSigFile = allFiles.find((f) => f.endsWith(".nsis.zip.sig"));
const winExeSigFile = allFiles.find((f) => /setup.*\.exe\.sig$/i.test(basename(f)));

let existing = null;
try {
  const res = await fetch(`${LATEST_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
  if (res.ok) {
    existing = await res.json();
  }
} catch {}

const dmgName = `devideo_${version}_aarch64.dmg`;
const exeName = `devideo_${version}_x64-setup.exe`;

const prevMacSize = existing?.release_downloads?.macos_dmg?.size || "88.5 MB";
const prevWinSize = existing?.release_downloads?.windows_exe?.size || "85.2 MB";

const dmgSizeStr = dmgFile
  ? `${(statSync(dmgFile).size / 1048576).toFixed(1)} MB`
  : prevMacSize;

const exeSizeStr = exeFile
  ? `${(statSync(exeFile).size / 1048576).toFixed(1)} MB`
  : prevWinSize;

const macSig = macSigFile
  ? readFileSync(macSigFile, "utf8").trim()
  : (existing?.version === version ? (existing?.platforms?.["darwin-aarch64"]?.signature || "") : "");

const winSig = winNsisSigFile
  ? readFileSync(winNsisSigFile, "utf8").trim()
  : winExeSigFile
    ? readFileSync(winExeSigFile, "utf8").trim()
    : (existing?.version === version ? (existing?.platforms?.["windows-x86_64"]?.signature || "") : "");

const winUpdateArtifactName = winNsisZip
  ? basename(winNsisZip)
  : exeName;

const manifest = {
  version,
  notes: `Rilis devideo v${version}. Perbaikan koneksi engine lintas platform (Windows & macOS), pembaruan otomatis in-app (auto-updater), dan peningkatan stabilitas render Google Flow Omni.`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      url: `${DOWNLOAD_BASE}/devideo.app.tar.gz`,
      signature: macSig,
    },
    "darwin-x86_64": {
      url: `${DOWNLOAD_BASE}/devideo.app.tar.gz`,
      signature: macSig,
    },
    "windows-x86_64": {
      url: `${DOWNLOAD_BASE}/${winUpdateArtifactName}`,
      signature: winSig,
    },
  },
  release_downloads: {
    macos_dmg: {
      filename: dmgName,
      size: dmgSizeStr,
    },
    windows_exe: {
      filename: exeName,
      size: exeSizeStr,
    },
  },
};

const outPath = join(ROOT, "latest-enriched.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`✅ Generated latest-enriched.json for v${version}:`, JSON.stringify(manifest, null, 2));
