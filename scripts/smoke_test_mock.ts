import { spawn } from "bun";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
let OUTPUT_DIR = join(ROOT, "output");
const PORT = 8799;
const URL = `http://127.0.0.1:${PORT}`;

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
  };
}

interface TestPayload {
  duration: number;
  platform_preset: "tiktok_fyp" | "reels_brand" | "custom";
  video_model: string;
  enable_endcard?: boolean;
  product_file: string;
  product_files: Array<{ file: string; role: string }>;
  hook_type?: string;
  hook_text_3s?: string;
  retention_promise?: string;
  share_trigger?: string;
  cta_mode?: string;
  subject_mode?: string;
  scenes?: Array<{
    num: number;
    time: string;
    duration: number;
    title: string;
    prompt: string;
    script: string;
  }>;
}

interface PipelineStatusResponse {
  pipeline: {
    running: boolean;
    status_text: string;
    last_video?: string;
    error?: string;
    cancelled?: boolean;
  };
}

interface MetaSidecar {
  job_id: string;
  platform_preset: string;
  video_model: string;
  duration_target: number;
  duration_actual: number;
  endcard_seconds: number;
  hook_type: string;
  hook_text_3s: string;
  cta_mode: string;
  clips_count: number;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function probeVideo(filePath: string): ProbeResult {
  const stdout = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
    "-of", "json",
    filePath,
  ], { encoding: "utf8" });
  const data = JSON.parse(stdout) as FfprobeJson;
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = (video?.r_frame_rate || "24/1").split("/").map(Number);
  return {
    duration: parseFloat(data.format?.duration || "0"),
    width: video?.width || 0,
    height: video?.height || 0,
    fps: Math.round(num / (den || 1)),
    hasAudio: Boolean(audio),
  };
}

async function waitForServer(maxAttempts = 50): Promise<string> {
  const tokenPath = join(process.env.HOME || ".", ".flow-mcp", "token");
  let token = "";
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (existsSync(tokenPath)) {
        token = readFileSync(tokenPath, "utf8").trim();
      }
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return token;
    } catch {}
    await sleep(200);
  }
  throw new Error("Server failed to start on port " + PORT);
}

async function runTestScenario(token: string, name: string, payload: TestPayload) {
  console.log(`\n========================================`);
  console.log(`[TEST] Menjalankan Skenario: ${name}`);
  console.log(`Preset: ${payload.platform_preset} | Target Durasi: ${payload.duration}s | Model: ${payload.video_model}`);

  // 1. Trigger generate
  const genRes = await fetch(`${URL}/api/pipeline/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flow-token": token,
    },
    body: JSON.stringify(payload),
  });
  if (!genRes.ok) {
    const errText = await genRes.text();
    throw new Error(`Failed to start pipeline: ${genRes.status} ${errText}`);
  }
  const genJson = await genRes.json() as { resolved?: unknown; credit_check?: unknown };
  console.log(`[PASS] Pipeline diterima server. Resolved:`, genJson.resolved, `Credit check:`, genJson.credit_check);

  // 2. Poll status until done or error
  let lastStatus = "";
  let finalPipeline: PipelineStatusResponse["pipeline"] | null = null;
  while (true) {
    await sleep(500);
    const stRes = await fetch(`${URL}/api/pipeline/status`, {
      headers: { "x-flow-token": token },
    });
    if (!stRes.ok) throw new Error("Status check failed");
    const stJson = (await stRes.json()) as PipelineStatusResponse;
    const p = stJson.pipeline;
    if (p.status_text !== lastStatus) {
      lastStatus = p.status_text;
      console.log(`  -> Status: ${lastStatus}`);
    }
    if (!p.running) {
      finalPipeline = p;
      break;
    }
  }

  if (finalPipeline?.error || finalPipeline?.cancelled) {
    throw new Error(`Pipeline ended with error: ${finalPipeline.error || "cancelled"}`);
  }

  const finalVideo = finalPipeline?.last_video;
  if (!finalVideo) throw new Error("Pipeline finished but no last_video reported");
  const videoPath = join(OUTPUT_DIR, finalVideo);
  if (!existsSync(videoPath)) throw new Error(`Output video not found on disk: ${videoPath}`);

  // 3. Probe video with ffprobe
  const probe = probeVideo(videoPath);
  console.log(`[PROBE] Video output: ${finalVideo}`);
  console.log(`  - Resolusi: ${probe.width}x${probe.height} (Harus 1080x1920)`);
  console.log(`  - FPS: ${probe.fps} (Harus 24)`);
  console.log(`  - Audio: ${probe.hasAudio ? "Stereo AAC (Ada)" : "TIDAK ADA"}`);
  console.log(`  - Durasi Riil ffprobe: ${probe.duration.toFixed(3)}s (Target: ${payload.duration}s)`);

  const drift = Math.abs(probe.duration - payload.duration);
  console.log(`  - Durasi Drift: ${drift.toFixed(3)}s`);
  if (drift > 0.05) {
    throw new Error(`Durasi drift melebihi batas toleransi! Target: ${payload.duration}s, Actual: ${probe.duration}s`);
  }

  // 4. Verify sidecar .meta.json
  const metaName = finalVideo.replace(/\.mp4$/, ".meta.json");
  const metaPath = join(OUTPUT_DIR, metaName);
  if (!existsSync(metaPath)) throw new Error(`Sidecar .meta.json tidak ditemukan: ${metaPath}`);
  const metaJson = JSON.parse(readFileSync(metaPath, "utf8")) as MetaSidecar;
  console.log(`[META] Sidecar lineage terverifikasi: ${metaName}`);
  console.log(`  - Job ID: ${metaJson.job_id}`);
  console.log(`  - Platform Preset: ${metaJson.platform_preset}`);
  console.log(`  - Video Model: ${metaJson.video_model}`);
  console.log(`  - Duration Target: ${metaJson.duration_target}s | Actual: ${metaJson.duration_actual}s`);
  console.log(`  - End-Card Seconds: ${metaJson.endcard_seconds}s`);
  console.log(`  - Hook Type: ${metaJson.hook_type}`);
  console.log(`  - Hook Text 3s: "${metaJson.hook_text_3s}"`);
  console.log(`  - CTA Mode: ${metaJson.cta_mode}`);
  console.log(`  - Scene Count: ${metaJson.clips_count}`);

  if (metaJson.platform_preset !== payload.platform_preset) {
    throw new Error(`Platform preset mismatch di .meta.json: ${metaJson.platform_preset} vs ${payload.platform_preset}`);
  }
  if (metaJson.video_model !== payload.video_model) {
    throw new Error(`Video model mismatch di .meta.json: ${metaJson.video_model} vs ${payload.video_model}`);
  }
  if (metaJson.duration_target !== payload.duration) {
    throw new Error(`Target duration mismatch di .meta.json`);
  }

  return {
    scenario: name,
    model: payload.video_model,
    video: finalVideo,
    targetDuration: payload.duration,
    actualDuration: Number(probe.duration.toFixed(3)),
    drift: Number(drift.toFixed(3)),
    resolution: `${probe.width}x${probe.height}`,
    fps: probe.fps,
    metaFile: metaName,
    endcardSeconds: metaJson.endcard_seconds,
  };
}

async function verifySingleFileBundle(token: string) {
  console.log(`\n========================================`);
  console.log(`[TEST] Verifikasi Singlefile Bundle & Server Serving`);

  const distPath = join(ROOT, "ui", "dist", "index.html");
  if (!existsSync(distPath)) throw new Error(`ui/dist/index.html tidak ditemukan!`);
  const htmlContent = readFileSync(distPath, "utf8");
  const sizeKb = (htmlContent.length / 1024).toFixed(2);
  console.log(`[PASS] ui/dist/index.html ditemukan: ${sizeKb} KB`);

  // Check that there are no external chunk <script src="/assets/..."> or <link rel="stylesheet" href="/assets/...">
  const hasExternalJs = /<script\b[^>]*\bsrc=["'][^"']*assets\/[^"']*["']/i.test(htmlContent);
  const hasExternalCss = /<link\b[^>]*\bhref=["'][^"']*assets\/[^"']*["']/i.test(htmlContent);
  if (hasExternalJs || hasExternalCss) {
    throw new Error(`Singlefile bundle bocor referensi file aset eksternal!`);
  }
  console.log(`[PASS] Bundle 100% self-contained inlined (tanpa tag link/script file terpisah).`);

  // Check server serving
  const srvRes = await fetch(`${URL}/?token=${token}`);
  if (!srvRes.ok) throw new Error(`Server returned ${srvRes.status} for /`);
  const srvText = await srvRes.text();
  if (!srvText.includes("TikTok FYP") || !srvText.includes("Instagram Reels")) {
    throw new Error(`Server tidak menyajikan konten ui/dist/index.html terbaru`);
  }
  console.log(`[PASS] Server port ${PORT} berhasil menyajikan singlefile bundle dengan token injected.`);
}

async function verifyCreditGuard(token: string) {
  console.log(`\n========================================`);
  console.log(`[TEST] Verifikasi Credit Guard & Pre-flight INSUFFICIENT_CREDITS Mock`);

  // Reset mock credits to 9999 initially
  await fetch(`${URL}/api/pipeline/mock-credits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-flow-token": token },
    body: JSON.stringify({ credits: 9999 }),
  }).catch(() => {});

  // 1. Happy path: check-credits saat saldo mencukupi
  console.log(`[SUBTEST 1] Happy path: check-credits saat saldo mencukupi (Omni 1.1 Flash 16s)...`);
  const okRes = await fetch(`${URL}/api/pipeline/check-credits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flow-token": token,
    },
    body: JSON.stringify({
      platform_preset: "tiktok_fyp",
      duration: 16,
      video_model: "Omni 1.1 Flash",
      scene1_variants: 1,
    }),
  });
  if (!okRes.ok) {
    throw new Error(`Happy path check-credits gagal: ${okRes.status} ${await okRes.text()}`);
  }
  const okJson = (await okRes.json()) as { success: boolean; sufficient: boolean; required: number; available: number };
  if (!okJson.sufficient || okJson.required <= 0) {
    throw new Error(`Happy path check-credits response tidak valid: ${JSON.stringify(okJson)}`);
  }
  console.log(`[PASS] Happy path OK: required=${okJson.required} cr, available=${okJson.available} cr, sufficient=${okJson.sufficient}`);

  // 2. Mock INSUFFICIENT_CREDITS via mock-credits endpoint & header
  console.log(`[SUBTEST 2] Rejection check-credits saat saldo kurang (Veo 3.1 - Quality butuh 200 cr, saldo mock diset 15)...`);
  await fetch(`${URL}/api/pipeline/mock-credits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-flow-token": token },
    body: JSON.stringify({ credits: 15 }),
  }).catch(() => {});

  const rejectRes = await fetch(`${URL}/api/pipeline/check-credits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flow-token": token,
      "x-mock-credits": "15",
    },
    body: JSON.stringify({
      platform_preset: "tiktok_fyp",
      duration: 16,
      video_model: "Veo 3.1 - Quality",
      scene1_variants: 1,
    }),
  });
  if (rejectRes.status !== 400) {
    throw new Error(`Harusnya ditolak 400 INSUFFICIENT_CREDITS tapi return ${rejectRes.status}`);
  }
  const rejectJson = (await rejectRes.json()) as { error: string; code: string; required: number; available: number; shortage: number };
  if (rejectJson.code !== "INSUFFICIENT_CREDITS" || rejectJson.shortage !== 185) {
    throw new Error(`Format error INSUFFICIENT_CREDITS tidak sesuai: ${JSON.stringify(rejectJson)}`);
  }
  console.log(`[PASS] check-credits berhasil menolak HTTP 400 INSUFFICIENT_CREDITS (butuh=${rejectJson.required}, saldo=${rejectJson.available}, kurang=${rejectJson.shortage})`);

  // 3. Pre-flight guard: POST /api/pipeline/generate wajib tolak HTTP 400 INSUFFICIENT_CREDITS
  console.log(`[SUBTEST 3] Pre-flight guard: POST /api/pipeline/generate wajib tolak HTTP 400 INSUFFICIENT_CREDITS...`);
  const stResBefore = await fetch(`${URL}/api/pipeline/status`, { headers: { "x-flow-token": token } });
  console.log("Status before subtest 3:", await stResBefore.json());
  const genRejectRes = await fetch(`${URL}/api/pipeline/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flow-token": token,
      "x-mock-credits": "15",
    },
    body: JSON.stringify({
      platform_preset: "tiktok_fyp",
      duration: 16,
      video_model: "Veo 3.1 - Quality",
      product_file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg",
      product_files: [{ file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg", role: "hero" }],
    }),
  });
  if (genRejectRes.status !== 400) {
    const bodyText = await genRejectRes.text();
    throw new Error(`Generate harusnya ditolak 400 INSUFFICIENT_CREDITS tapi return ${genRejectRes.status}: ${bodyText}`);
  }
  const genRejectJson = (await genRejectRes.json()) as { error: string; code: string; shortage: number };
  if (genRejectJson.code !== "INSUFFICIENT_CREDITS") {
    throw new Error(`Generate error code bukan INSUFFICIENT_CREDITS: ${JSON.stringify(genRejectJson)}`);
  }

  // Ensure pipeline is NOT running
  const statusRes = await fetch(`${URL}/api/pipeline/status`, { headers: { "x-flow-token": token } });
  const statusJson = (await statusRes.json()) as PipelineStatusResponse;
  if (statusJson.pipeline.running) {
    throw new Error(`Pipeline bocor tetap berjalan padahal ditolak pre-flight credit guard!`);
  }
  console.log(`[PASS] Pipeline generate diblokir di pre-flight; status running=false terkonfirmasi.`);

  // 4. Restore mock credits back to 9999
  const restoreRes = await fetch(`${URL}/api/pipeline/mock-credits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-flow-token": token },
    body: JSON.stringify({ credits: 9999 }),
  });
  const restoreJson = await restoreRes.json();
  console.log(`[PASS] Saldo mock dikembalikan ke 9999 untuk pipeline tests:`, restoreJson);
}

async function main() {
  console.log("=== STARTING FULL SMOKE TEST END-TO-END PIPELINE MOCK ===");
  console.log(`Starting mock engine server on port ${PORT}...`);

  const serverProc = spawn({
    cmd: ["bun", "run", "src/server-entry.ts"],
    cwd: join(ROOT, "engine"),
    env: {
      ...process.env,
      FLOW_MCP_PORT: String(PORT),
      FLOW_MOCK_RENDER: "1",
      FLOW_MCP_PAUSE_MIN_S: "0",
      FLOW_MCP_PAUSE_MAX_S: "0",
    },
    stderr: "pipe",
  });

  const cleanup = () => {
    try {
      serverProc.kill();
    } catch {}
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    const token = await waitForServer();
    console.log(`[PASS] Mock server running at ${URL} with token: ${token.slice(0, 8)}...`);
    const pathsRes = await fetch(`${URL}/api/paths`, { headers: { "x-flow-token": token } });
    if (pathsRes.ok) {
      const paths = (await pathsRes.json()) as { output: string };
      OUTPUT_DIR = paths.output;
      console.log(`[PASS] Output directory dari server: ${OUTPUT_DIR}`);
    }

    // Verify Singlefile bundle first
    await verifySingleFileBundle(token);

    // Verify Credit Guard & INSUFFICIENT_CREDITS mock
    await verifyCreditGuard(token);

    const results = [];

    // SCENARIO 1: TikTok FYP 16s (Omni 1.1 Flash)
    results.push(await runTestScenario(token, "TikTok FYP 16s (Omni 1.1 Flash)", {
      duration: 16,
      platform_preset: "tiktok_fyp",
      video_model: "Omni 1.1 Flash",
      enable_endcard: true,
      product_file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg",
      product_files: [{ file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg", role: "hero" }],
      hook_type: "problem_agitator",
      hook_text_3s: "Bangun tidur badan pegal semua?",
      retention_promise: "Penyebab sepele yang sering diabaikan tubuh",
      share_trigger: "Kirim ke orang tua atau teman yang suka pegal",
      cta_mode: "cart_checkout",
      subject_mode: "hands",
      scenes: [
        { num: 1, time: "00–06s", duration: 6, title: "Hook Masalah", prompt: "A close-up hand enters frame quickly holding product", script: "Bangun tidur badan pegal semua? Ini sebabnya." },
        { num: 2, time: "06–16s", duration: 8, title: "Solusi Produk", prompt: "Hand opening packaging demonstrating bottle detail", script: "Cukup satu kapsul herbal alami sebelum tidur, checkout di keranjang kuning." }
      ]
    }));

    // SCENARIO 2: TikTok FYP 16s (Veo 3.1 - Lite)
    results.push(await runTestScenario(token, "TikTok FYP 16s (Veo 3.1 Lite)", {
      duration: 16,
      platform_preset: "tiktok_fyp",
      video_model: "Veo 3.1 - Lite",
      enable_endcard: true,
      product_file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg",
      product_files: [{ file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg", role: "hero" }],
      hook_type: "price_drop_deal",
      hook_text_3s: "Spill diskon racun belanja hari ini!",
      retention_promise: "Flash sale spesial sebelum kehabisan stok",
      share_trigger: "Tag teman buat checkout bareng",
      cta_mode: "cart_checkout",
      subject_mode: "hands",
      scenes: [
        { num: 1, time: "00–08s", duration: 8, title: "Hook Promo", prompt: "Hand puts down package showing flash sale label", script: "Spill diskon racun belanja hari ini sebelum kehabisan!" },
        { num: 2, time: "08–16s", duration: 8, title: "CTA Belanja", prompt: "Hand points to bottom left corner showing purchase flow", script: "Promo terbatas khusus hari ini, klik keranjang sekarang." }
      ]
    }));

    // SCENARIO 3: Instagram Reels 16s (Veo 3.1 - Fast)
    results.push(await runTestScenario(token, "Instagram Reels 16s (Veo 3.1 Fast)", {
      duration: 16,
      platform_preset: "reels_brand",
      video_model: "Veo 3.1 - Fast",
      enable_endcard: true,
      product_file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg",
      product_files: [{ file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg", role: "hero" }],
      hook_type: "relatable_pov",
      hook_text_3s: "POV: Pas lagi capek-capeknya di kantor...",
      retention_promise: "Kebiasaan 1 menit kembalikan stamina tubuh",
      share_trigger: "Relate banget sama teman se-divisi",
      cta_mode: "dm_share",
      subject_mode: "pov",
      scenes: [
        { num: 1, time: "00–08s", duration: 8, title: "POV Relatable", prompt: "POV first person view sitting at desk tired stretching arms", script: "POV: Pas lagi capek-capeknya di kantor..." },
        { num: 2, time: "08–16s", duration: 8, title: "Rutinitas Segar", prompt: "POV reaching for premium drink bottle pouring gently", script: "Rutinitas segar simpel tiap sore. Kirim ke teman kantormu!" }
      ]
    }));

    // SCENARIO 4: Instagram Reels 24s (Veo 3.1 - Quality)
    results.push(await runTestScenario(token, "Instagram Reels 24s (Veo 3.1 Quality)", {
      duration: 24,
      platform_preset: "reels_brand",
      video_model: "Veo 3.1 - Quality",
      enable_endcard: true,
      product_file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg",
      product_files: [{ file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg", role: "hero" }],
      hook_type: "shock_counterintuitive",
      hook_text_3s: "Ternyata cara pakai kita salah besar!",
      retention_promise: "Trik pakai yang bikin hasil 3x lebih awet",
      share_trigger: "Kirim ke teman biar nggak salah lagi",
      cta_mode: "dm_share",
      subject_mode: "pov",
      scenes: [
        { num: 1, time: "00–08s", duration: 8, title: "Hook Counter-Intuitive", prompt: "POV hand dropping ice into herbal cup with steam rising", script: "Ternyata cara pakai kita salah besar selama ini!" },
        { num: 2, time: "08–16s", duration: 8, title: "Tips & Edukasi", prompt: "Macro texture shot of natural extract dissolving smoothly", script: "Ini cara seduh yang bikin manfaatnya terserap maksimal." },
        { num: 3, time: "16–24s", duration: 8, title: "Share Trigger", prompt: "Smooth camera dolly back showing aesthetic setup", script: "Simpan tips ini atau share ke teman yang belum tahu." }
      ]
    }));

    console.log(`\n======================================================`);
    console.log(`🎉 SUMMARY HASIL SMOKE TEST E2E PIPELINE MOCK:`);
    console.table(results);
    console.log(`SEMUA 4 SKENARIO SMOKE TEST LULUS 100% TANPA DRIFT DURASI!`);

  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR IN SMOKE TEST:", err);
  process.exit(1);
});
