#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE_ROOT = resolve(import.meta.dir, "..");
const pwDir = resolve(ENGINE_ROOT, "node_modules/playwright-core");

if (!existsSync(pwDir)) {
  console.warn("⚠️ playwright-core not found at", pwDir);
  process.exit(0);
}

const pkgJsonStr = JSON.stringify(
  JSON.parse(readFileSync(resolve(pwDir, "package.json"), "utf8"))
);
const browsersJsonStr = JSON.stringify(
  JSON.parse(readFileSync(resolve(pwDir, "browsers.json"), "utf8"))
);

const targetFiles = [
  resolve(pwDir, "lib/package.js"),
  resolve(pwDir, "lib/serverRegistry.js"),
  resolve(pwDir, "lib/coreBundle.js"),
];

for (const file of targetFiles) {
  if (!existsSync(file)) continue;
  let content = readFileSync(file, "utf8");
  let changed = false;

  // Replace dynamic require(...join(packageRoot, "package.json")) with inlined JSON
  const nextPkg = content.replace(
    /require\([^)\n]*join\(packageRoot,\s*["']package\.json["']\)\)/g,
    `(${pkgJsonStr})`
  );
  if (nextPkg !== content) {
    content = nextPkg;
    changed = true;
  }

  // Replace dynamic require(...join(packageRoot, "browsers.json")) with inlined JSON
  const nextBrowsers = content.replace(
    /require\([^)\n]*join\(packageRoot,\s*["']browsers\.json["']\)\)/g,
    `(${browsersJsonStr})`
  );
  if (nextBrowsers !== content) {
    content = nextBrowsers;
    changed = true;
  }

  if (changed) {
    writeFileSync(file, content, "utf8");
    console.log(`✅ Patched static playwright-core metadata in ${file.replace(ENGINE_ROOT, "")}`);
  } else {
    console.log(`ℹ️ Already patched or no dynamic metadata require in ${file.replace(ENGINE_ROOT, "")}`);
  }
}
