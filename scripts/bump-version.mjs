#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const targetVersion = process.argv[2];

if (!targetVersion) {
  console.error("❌ Masukkan nomor versi baru! Contoh: bun run bump 0.1.1");
  process.exit(1);
}

const cleanVer = targetVersion.replace(/^v/, "").trim();
const ROOT = resolve(import.meta.dir, "..");
const MONITOR_ROOT = resolve(ROOT, "../devideo-monitor");

console.log(`🚀 Memperbarui versi devideo ke v${cleanVer} di seluruh codebase...`);

// 1. Root package.json
updateJson(`${ROOT}/package.json`, (data) => { data.version = cleanVer; });

// 2. src-tauri/tauri.conf.json
updateJson(`${ROOT}/src-tauri/tauri.conf.json`, (data) => { data.version = cleanVer; });

// 3. src-tauri/Cargo.toml
updateFile(`${ROOT}/src-tauri/Cargo.toml`, (content) => {
  return content.replace(/^version = ".*"/m, `version = "${cleanVer}"`);
});

// 4. engine/package.json
updateJson(`${ROOT}/engine/package.json`, (data) => { data.version = cleanVer; });

// 5. ui/package.json
updateJson(`${ROOT}/ui/package.json`, (data) => { data.version = cleanVer; });

// 6. ui/index.html
updateFile(`${ROOT}/ui/index.html`, (content) => {
  return content
    .replace(/const currentVersion = "v[^"]*"/g, `const currentVersion = "v${cleanVer}"`)
    .replace(/(<span class="brand-badge"[^>]*>)v[0-9.]+(<\/span>)/g, `$1v${cleanVer}$2`);
});

// 7. .github/workflows/release.yml
updateFile(`${ROOT}/.github/workflows/release.yml`, (content) => {
  return content
    .replace(/devideo_[0-9.]+_aarch64\.dmg/g, `devideo_${cleanVer}_aarch64.dmg`)
    .replace(/devideo_[0-9.]+_x64-setup\.exe/g, `devideo_${cleanVer}_x64-setup.exe`);
});

// 8. Halaman /release sekarang dynamic dari R2 latest.json — tidak perlu update file statis.
//    Nama file installer di release.yml sudah di-update di step 7.
//    CI akan enrich latest.json dengan release_downloads sebelum upload ke R2.

console.log(`✅ Sukses! Semua file berhasil diperbarui ke versi v${cleanVer}.`);
console.log(`📝 Jalankan: git commit -am "chore: bump version to v${cleanVer}"`);

function updateJson(path, mutate) {
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    mutate(json);
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf8");
    console.log(`  ✓ Updated: ${path.replace(ROOT, "")}`);
  } catch (e) {
    console.warn(`  ⚠️ Gagal update ${path}: ${e.message}`);
  }
}

function updateFile(path, mutate) {
  try {
    const raw = readFileSync(path, "utf8");
    const updated = mutate(raw);
    writeFileSync(path, updated, "utf8");
    console.log(`  ✓ Updated: ${path.replace(ROOT, "")}`);
  } catch (e) {
    console.warn(`  ⚠️ Gagal update ${path}: ${e.message}`);
  }
}
