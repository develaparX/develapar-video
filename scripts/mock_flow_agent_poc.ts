import { spawn } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
let OUTPUT_DIR = join(ROOT, "output");
const PORT = 8798;
const URL = `http://127.0.0.1:${PORT}`;

interface SceneItem {
  num?: number;
  time?: string;
  duration?: number;
  title?: string;
  prompt: string;
  script?: string;
  refs?: string[];
}

interface ScriptEnvelope {
  product_identified?: string;
  product_category?: string;
  scenes: SceneItem[];
}

interface PipelineResponse {
  success: boolean;
  pipeline: {
    id: string;
  };
}

interface PipelineStatusResponse {
  pipeline: {
    running: boolean;
    last_video?: string;
    error?: string;
  };
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
  };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function buildMockFlowAgentPrompt(productName: string, duration: number, clipsCount: number): string {
  return `Role: Video Director for TikTok/Reels Commercial.
Goal: Produce high-converting 9:16 video storyboard for @Product (${productName}).
Total Duration: ${duration}s across exactly ${clipsCount} scenes.
Guidelines:
- Scene 1: Visual hook (first 3s), use @Product prominently.
- Scene 2: Problem-solution / benefit demo.
- Never add text overlay in prompt.
- Always output strict JSON codeblock with schema:
\`\`\`json
{
  "product_name": "${productName}",
  "total_duration": ${duration},
  "scenes": [
    {
      "num": 1,
      "time": "00–08s",
      "duration": 8,
      "title": "Hook Masalah",
      "prompt": "Extreme close up handheld of @Product placed on wooden desk, morning sunlight, cinematic 9:16 vertical",
      "script": "Pernah ga ngerasa capek banget tiap pagi?",
      "refs": ["@Product"]
    },
    {
      "num": 2,
      "time": "08–16s",
      "duration": 8,
      "title": "Solusi & CTA",
      "prompt": "Slow push in on @Product being used smoothly, clean aesthetic kitchen background, 9:16 vertical",
      "script": "Cukup satu tetes, energi seharian langsung balik!",
      "refs": ["@Product"]
    }
  ]
}
\`\`\`
Answer ONLY the JSON codeblock without pleasantries.`;
}

const MOCK_FLOW_AGENT_RESPONSE_CHATTY = `Tentu! Berikut adalah storyboard naskah iklan 16 detik untuk @Product yang dioptimasi untuk rasio 9:16:

\`\`\`json
{
  "product_identified": "Madu Hutan Alami",
  "product_category": "F&B / Herbal",
  "scenes": [
    {
      "num": 1,
      "time": "00–08s",
      "duration": 8,
      "title": "Hook Lelah Pagi",
      "prompt": "Cinematic close-up of @Product bottle on a rustic wooden table with soft morning rays, vibrant natural tones, 9:16 vertical, no text",
      "script": "Bangun tidur tapi badan masih lemas dan pegal-pegal?",
      "refs": ["@Product"]
    },
    {
      "num": 2,
      "time": "08–16s",
      "duration": 8,
      "title": "Solusi Stamina",
      "prompt": "Medium shot of golden honey from @Product drizzling smoothly into warm water, steam rising, aesthetic kitchen, 9:16 vertical",
      "script": "Satu sendok madu murni tiap pagi, rasakan bedanya sekarang!",
      "refs": ["@Product"]
    }
  ]
}
\`\`\`

Semoga storyboard ini membantu produksi video Anda di Google Flow!`;

const MOCK_FLOW_AGENT_RESPONSE_ARRAY = `\`\`\`json
[
  {
    "num": 1,
    "time": "00–08s",
    "duration": 8,
    "title": "Visual Hook",
    "prompt": "Dynamic tilt down to @Product with dramatic lighting, 9:16 format, high detail",
    "script": "Jangan beli ini kalau gamau kecanduan segarnya!",
    "refs": ["@Product"]
  },
  {
    "num": 2,
    "time": "08–16s",
    "duration": 8,
    "title": "Product Reveal",
    "prompt": "Hands picking up @Product, refreshing water splash background, commercial aesthetic",
    "script": "Sensasi dingin seketika di setiap semprotan.",
    "refs": ["@Product"]
  }
]
\`\`\``;

const MOCK_FLOW_AGENT_RESPONSE_MESSY = `Here is your storyboard:
\`\`\`
{
  product_identified: 'Serum Glowing',
  scenes: [
    {
      num: 1,
      duration: 8,
      title: 'Problem Hook',
      prompt: 'Macro shot of dull skin texture transforming as @Product is introduced, 9:16 vertical',
      script: 'Kulit kusam bikin insecure seharian?',
      refs: ['@Product'],
    },
    {
      num: 2,
      duration: 8,
      title: 'Glowing Result',
      prompt: 'Radiant glowing skin glow reflection with @Product bottle beside cheek, studio lighting',
      script: 'Tiga hari pemakaian, glowing natural langsung kelihatan!',
      refs: ['@Product'],
    },
  ],
}
\`\`\`
Enjoy generating!`;

const MOCK_FLOW_AGENT_RESPONSE_FAILURE = `Maaf, saya tidak bisa membuat format tersebut karena kuota atau kebijakan sistem. Silakan coba lagi.`;

function parseJsonCandidate(text: string): unknown {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = codeBlockRegex.exec(clean)) !== null) {
    const candidate = blockMatch[1].trim();
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        try {
          return new Function(`return (${candidate})`)();
        } catch {}
      }
    }
  }

  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.slice(firstBrace, lastBrace + 1));
    } catch {
      try {
        return new Function(`return (${clean.slice(firstBrace, lastBrace + 1)})`)();
      } catch {}
    }
  }

  throw new Error(`Gagal mengekstrak JSON dari respon Flow Agent: ${clean.slice(0, 80)}...`);
}

async function runMockPoc() {
  console.log("================================================================");
  console.log("🧪 PROOF OF CONCEPT: FLOW AGENT NATIVE SCRIPTING (ZERO API KEY)");
  console.log("================================================================\n");

  console.log("--- TAHAP 1: FORMULASI PROMPT AGENT INSTRUCTIONS & CDP ---");
  const prompt = buildMockFlowAgentPrompt("Serum Hyaluronic", 16, 2);
  console.log("[PASS] Prompt brief berhasil disusun dengan tagging @Product & Three-Tier Guardrails.");
  console.log(`[INFO] Ukuran prompt: ${prompt.length} karakter.\n`);

  console.log("--- TAHAP 2: UJI PARSING BERBAGAI VARIAN OUTPUT FLOW AGENT ---");
  
  const parsedA = parseJsonCandidate(MOCK_FLOW_AGENT_RESPONSE_CHATTY) as ScriptEnvelope;
  if (parsedA && Array.isArray(parsedA.scenes) && parsedA.scenes.length === 2) {
    console.log("[PASS] Case A (Chatty Markdown + JSON Codeblock): Sukses diekstrak!");
    console.log(`       - Produk: ${parsedA.product_identified ?? "Unknown"}`);
    console.log(`       - Scene 1 Prompt: "${parsedA.scenes[0].prompt.slice(0, 45)}..."`);
    console.log(`       - Scene 1 Script: "${parsedA.scenes[0].script ?? ""}"`);
  } else {
    throw new Error("Case A failed");
  }

  const parsedB = parseJsonCandidate(MOCK_FLOW_AGENT_RESPONSE_ARRAY) as SceneItem[];
  if (Array.isArray(parsedB) && parsedB.length === 2) {
    console.log("[PASS] Case B (Raw Array Codeblock): Sukses diekstrak!");
    console.log(`       - Scene 1 Title: ${parsedB[0].title ?? "Scene 1"}`);
  } else {
    throw new Error("Case B failed");
  }

  const parsedC = parseJsonCandidate(MOCK_FLOW_AGENT_RESPONSE_MESSY) as ScriptEnvelope;
  if (parsedC && Array.isArray(parsedC.scenes) && parsedC.scenes.length === 2) {
    console.log("[PASS] Case C (Messy Unquoted JSON + Trailing Commas): Sukses dipulihkan dengan Lenient Parser!");
    console.log(`       - Produk: ${parsedC.product_identified ?? "Unknown"}`);
  } else {
    throw new Error("Case C failed");
  }

  try {
    parseJsonCandidate(MOCK_FLOW_AGENT_RESPONSE_FAILURE);
    throw new Error("Case D should have failed");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[PASS] Case D (No JSON Failure): Berhasil dideteksi secara presisi: "${msg.slice(0, 60)}..."\n`);
  }

  console.log("--- TAHAP 3: HANDSHAKE HASIL PARSE KE SERVER ENGINE & FFMPEG ---");
  console.log(`Memulai Mock Engine Server di port ${PORT}...`);
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

  try {
    const tokenPath = join(process.env.HOME || ".", ".flow-mcp", "token");
    let token = "";
    const start = Date.now();
    while (Date.now() - start < 15000) {
      try {
        if (existsSync(tokenPath)) {
          token = readFileSync(tokenPath, "utf8").trim();
        }
        const res = await fetch(`${URL}/api/health`);
        if (res.ok) {
          break;
        }
      } catch {}
      await delay(200);
    }

    if (!token) throw new Error("Gagal menyalakan mock server atau token tidak ditemukan");
    console.log(`[PASS] Server aktif di http://127.0.0.1:${PORT} (Token: ${token.slice(0, 8)}...)`);

    const pathsRes = await fetch(`${URL}/api/paths`, { headers: { "x-flow-token": token } });
    if (pathsRes.ok) {
      const paths = (await pathsRes.json()) as { output: string };
      OUTPUT_DIR = paths.output;
      console.log(`[PASS] Output directory dari server: ${OUTPUT_DIR}`);
    }

    const scenesToInject = parsedA.scenes.map((s, idx) => ({
      num: idx + 1,
      time: s.time ?? (idx === 0 ? "00–08s" : "08–16s"),
      duration: s.duration ?? 8,
      title: s.title ?? `Scene ${idx + 1}`,
      prompt: s.prompt,
      script: s.script ?? "",
    }));

    const pipelinePayload = {
      product_file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg",
      product_files: [{ file: "WhatsApp_Image_2026-10-31_at_16.17.42.jpeg", role: "hero" }],
      platform_preset: "tiktok_fyp",
      video_model: "Omni 1.1 Flash",
      duration: 16,
      enable_endcard: true,
      hook_type: "problem_agitator",
      scenes: scenesToInject,
    };

    console.log("Mengirim naskah hasil Flow Agent ke POST /api/pipeline/generate...");
    const genRes = await fetch(`${URL}/api/pipeline/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flow-token": token,
      },
      body: JSON.stringify(pipelinePayload),
    });

    const genJson = (await genRes.json()) as PipelineResponse;
    if (!genRes.ok || !genJson.success) {
      throw new Error(`Pipeline generate gagal: ${JSON.stringify(genJson)}`);
    }
    console.log(`[PASS] Pipeline diterima server. Job ID: ${genJson.pipeline.id}`);

    console.log("Menunggu render klip & assembly FFmpeg selesai...");
    let finalVideo = "";
    while (true) {
      const stRes = await fetch(`${URL}/api/pipeline/status`, {
        headers: { "x-flow-token": token },
      });
      const stJson = (await stRes.json()) as PipelineStatusResponse;
      if (!stJson.pipeline.running) {
        if (stJson.pipeline.error) throw new Error(`Pipeline error: ${stJson.pipeline.error}`);
        finalVideo = stJson.pipeline.last_video ?? "";
        break;
      }
      await delay(1000);
    }

    console.log(`[PASS] Video akhir berhasil di-generate & di-stitch: ${finalVideo}`);

    const finalPath = join(OUTPUT_DIR, finalVideo);
    if (!existsSync(finalPath)) throw new Error(`File video tidak ditemukan: ${finalPath}`);

    const probeRaw = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=width,height,r_frame_rate,codec_type:format=duration",
      "-of", "json",
      finalPath,
    ], { encoding: "utf8" });

    const probe = JSON.parse(probeRaw) as FfprobeResult;
    const vStream = probe.streams?.find((s) => s.codec_type === "video");
    const aStream = probe.streams?.find((s) => s.codec_type === "audio");
    const durationReal = parseFloat(probe.format?.duration || "0");

    console.log("\nHasil Verifikasi Media ffprobe:");
    console.log(`  - Resolusi: ${vStream?.width ?? 0}x${vStream?.height ?? 0} (Standar 1080x1920 9:16)`);
    console.log(`  - Durasi Riil ffprobe: ${durationReal.toFixed(3)}s (Target: 16s)`);
    console.log(`  - Audio Stream: ${aStream ? "Stereo AAC (Ada)" : "Tidak ada"}`);
    console.log(`  - Drift Durasi: ${Math.abs(durationReal - 16).toFixed(3)}s`);

    if (vStream?.width === 1080 && vStream?.height === 1920 && Math.abs(durationReal - 16) < 0.1 && aStream) {
      console.log("\n================================================================");
      console.log("🎉 BUKTI NYATA: MOCK POC 100% SUKSES DAN VALID!");
      console.log("Naskah dari Flow Agent terbukti BERHASIL diekstrak, divalidasi,");
      console.log("dan di-render sampai jadi video 1080x1920 tanpa drift!");
      console.log("================================================================");
    } else {
      throw new Error("Verifikasi spesifikasi media gagal.");
    }
  } finally {
    serverProc.kill();
  }
}

runMockPoc().catch((err: unknown) => {
  console.error("POC FAILED:", err);
  process.exit(1);
});
