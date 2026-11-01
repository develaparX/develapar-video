#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FALLBACK_ENC =
  "dMYyNe/teUbX7iIk3DW9orjC0tmuyKYKb01xXmV0s0mgh2NHe/O8/T07oA86vCIygiYHzURKdYRlKYuz6k4y21/FuBBhoj16dgmfUq77U0rvtVyImcstx3H/ysRZj2EpeX4jFWrjJBb8xC45yk2v8AZzl79ypleleCHG69O993xOl56nlSfnHx7xJw/Q3QLPDJNg20akK50aQ0kG38sEBKaC6z5bUuwSLK03nPi4DTBDMuD3W6/HCm5L5KJjn76U4gpe2IHRYzsuRShY4QzYCRF8zMKJwdbQ+YP6nuck9QBiLkOIiphF/gGxyP/hffUcgFaFe9c7YkKgNGJtmmZKd0FWkenh82o4qppaGAi+V1W/hpgv/OlSwN+ixo0cNbLHT1NGfmU5RjU5udLfq2K7sjJmr+S1GcljjHomscmnUzkru3nmHzO7IssSpv/ePwplfTQY5pyj54+OnaAT.2OXHCopTQzGB1qrpSCKcQg==";

function normalizeCandidate(input) {
  let raw = (input || "").trim();
  if (!raw) return "";

  if (!raw.includes("untrusted comment:")) {
    try {
      const cleanedB64 = raw.replace(/[^A-Za-z0-9+/=]/g, "");
      const dec = Buffer.from(cleanedB64, "base64").toString("utf8");
      if (dec.includes("untrusted comment:")) {
        raw = dec;
      }
    } catch {}
  }

  if (raw.includes("untrusted comment:")) {
    let body = raw;
    if (/secret key/i.test(raw)) {
      body = raw.split(/secret key/i).slice(1).join("");
    } else if (raw.includes("\n")) {
      body = raw.slice(raw.indexOf("\n") + 1);
    }
    body = body.replace(/[^A-Za-z0-9+/=]/g, "");
    while (body.length % 4 !== 0) {
      body += "=";
    }
    const reconstructed = `untrusted comment: rsign encrypted secret key\n${body}\n`;
    return Buffer.from(reconstructed, "utf8").toString("base64");
  }

  return raw.replace(/[^A-Za-z0-9+/=]/g, "");
}

function decryptFallback() {
  const [encB64, tagB64] = FALLBACK_ENC.split(".");
  const key = createHash("sha256")
    .update("ae4a8362e4ec59075817f1e22baf4f3d:com.develapar.devideo")
    .digest();
  const iv = Buffer.alloc(12, 7);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8").trim();
}

function canSign(privateKeyB64, password) {
  if (!privateKeyB64) return false;
  const dummyPath = join(tmpdir(), `tauri-sign-check-${Date.now()}.txt`);
  const sigPath = `${dummyPath}.sig`;
  try {
    writeFileSync(dummyPath, "devideo-sign-check", "utf8");
    const bunBin = process.execPath || "bun";
    execFileSync(bunBin, ["tauri", "signer", "sign", dummyPath], {
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: privateKeyB64,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
      },
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(dummyPath); } catch {}
    try { unlinkSync(sigPath); } catch {}
  }
}

const rawKey = process.env.RAW_KEY || "";
const rawPassword = process.env.RAW_PASSWORD || "";

const normalizedFromSecret = normalizeCandidate(rawKey);
const candidates = [
  { label: "GitHub Secret (normalized + provided password)", key: normalizedFromSecret, pw: rawPassword },
  { label: "GitHub Secret (normalized + empty password)", key: normalizedFromSecret, pw: "" },
  { label: "Verified devideo.key fallback", key: decryptFallback(), pw: "" },
];

let chosen = null;
for (const c of candidates) {
  if (canSign(c.key, c.pw)) {
    chosen = c;
    break;
  }
}

if (!chosen) {
  console.warn("⚠️ Fallback: using decryptFallback directly without pre-sign CLI check");
  chosen = { label: "Direct fallback", key: decryptFallback(), pw: "" };
}

console.log(`✅ Tauri signing key ready via: ${chosen.label} (base64 length: ${chosen.key.length})`);

if (process.env.GITHUB_ENV) {
  appendFileSync(
    process.env.GITHUB_ENV,
    `TAURI_SIGNING_PRIVATE_KEY=${chosen.key}\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD=${chosen.pw}\n`,
    "utf8"
  );
}
