import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR } from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { findFfmpeg } from "./platform.js";

const run = promisify(execFile);
const MCP_DIR = resolve(fileURLToPath(import.meta.url), "../..");
const PRODUCT_DIR = join(MCP_DIR, "product");
const OUTPUT_DIR = join(MCP_DIR, "output");
const FFMPEG = findFfmpeg();

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
export const TOKEN_FILE = join(HOME_DIR, "token");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;

interface PipelineState {
  running: boolean;
  duration: number;
  clips_count: number;
  current_scene: number;
  status_text: string;
  logs: string[];
  product_file: string;
  last_video?: string;
  error?: string;
}

let activePipeline: PipelineState = {
  running: false,
  duration: 60,
  clips_count: 6,
  current_scene: 0,
  status_text: "Sistem siap",
  logs: ["Flow Studio siap untuk generate video."],
  product_file: "bvflow.jpg",
  last_video: "naturindo_bvflow_1menit.mp4"
};
const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

export interface ScriptScene {
  num: number;
  time: string;
  title: string;
  prompt: string;
  script: string;
}

export interface ScriptResult {
  character_anchor: string;
  setting_anchor: string;
  scenes: ScriptScene[];
}

export interface ScriptRequestBody {
  duration?: number;
  prompt?: string;
  product_file?: string;
  model?: string;
  endpoint?: string;
  api_key?: string;
}

export interface PipelineRequestBody extends ScriptRequestBody {
  character_anchor?: string;
  setting_anchor?: string;
  scenes?: ScriptScene[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface GenResult {
  jobs: Array<{ id: string; scene: string }>;
}

interface WaitResult {
  finished: boolean;
  jobs: Array<{ id: string; status: string; files?: string[]; error?: string }>;
}

const sceneItemSchema = z.object({
  num: z.number().optional(),
  time: z.string().optional(),
  title: z.string().optional(),
  prompt: z.string(),
  script: z.string().optional(),
  voiceover: z.string().optional(),
});

const scriptEnvelopeSchema = z.object({
  character_anchor: z.string().optional(),
  setting_anchor: z.string().optional(),
  scenes: z.array(sceneItemSchema),
});

const scriptArraySchema = z.array(sceneItemSchema);

async function generateScriptWithLLM(body: ScriptRequestBody): Promise<ScriptResult> {
  const duration = Number(body.duration ?? 60);
  const userPrompt = String(body.prompt || "generate video dengan foto product yang terlampir dan generate scriptnya sekalian");
  const productFile = String(body.product_file || "product.jpg");
  const productBase = productFile.replace(/\.[^.]+$/, "");
  const clipsCount = duration === 10 ? 1 : duration === 15 ? 2 : duration === 30 ? 3 : duration === 60 ? 6 : Math.max(1, Math.min(10, Math.round(duration / 10)));
  const apiKey = body.api_key || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  let endpoint = body.endpoint || "https://generativelanguage.googleapis.com/v1beta/openai";
  const model = body.model || "gemini-2.5-flash";

  if (!apiKey) {
    throw new Error("API Key LLM belum diisi. Masukkan API Key Anda di panel 'Chat Brief & AI Script Generator' untuk menganalisis foto produk dan membuat naskah.");
  }

  if (!endpoint.endsWith("/chat/completions")) {
    endpoint = endpoint.replace(/\/+$/, "") + "/chat/completions";
  }
  const sysPrompt = `Generate a video script for Google Flow Omni in 9:16 vertical format across ${clipsCount} consecutive 10-second scenes (total: ${duration}s).
Follow the user's prompt directly: '${userPrompt}'.
Use the attached product photo for context.

Output JSON structure:
{
  "character_anchor": "Description of person / subject",
  "setting_anchor": "Description of location / environment",
  "scenes": [
    {
      "num": 1,
      "time": "00–10s",
      "title": "Short scene title",
      "prompt": "Visual action and camera description in English for Google Flow Omni",
      "script": "Voiceover line spoken in this scene"
    }
  ]
}
Return raw JSON only, no markdown.`;

  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: userPrompt
    }
  ];

  const productPath = join(PRODUCT_DIR, productFile);
  if (existsSync(productPath)) {
    const ext = extname(productFile).toLowerCase().replace(/^\./, "");
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const b64 = readFileSync(productPath).toString("base64");
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${b64}` }
    });
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userContent }
      ],
      temperature: 0.7,
      stream: false
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`LLM API gagal (${resp.status}): ${errText || resp.statusText}`);
  }

  const rawText = await resp.text();
  let raw = "";
  if (rawText.trim().startsWith("data:")) {
    for (const line of rawText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
        try {
          const chunk = JSON.parse(trimmed.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
          const delta = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || "";
          raw += delta;
        } catch {}
      }
    }
  } else {
    try {
      const data = JSON.parse(rawText) as ChatCompletionResponse;
      raw = data.choices?.[0]?.message?.content?.trim() || "";
    } catch {}
  }

  const clean = raw.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
  let characterAnchor = "Indonesian protagonist with authentic appearance, consistent clothing items and natural expressions.";
  let settingAnchor = "Consistent aesthetic interior setting by soft natural daylight.";
  let scenesList: ScriptScene[] = [];

  try {
    const rawJson: unknown = JSON.parse(clean);
    const envelopeResult = scriptEnvelopeSchema.safeParse(rawJson);
    if (envelopeResult.success) {
      if (envelopeResult.data.character_anchor) characterAnchor = envelopeResult.data.character_anchor;
      if (envelopeResult.data.setting_anchor) settingAnchor = envelopeResult.data.setting_anchor;
      scenesList = envelopeResult.data.scenes.map((item, idx) => ({
        num: idx + 1,
        time: item.time || `${idx * 10}–${(idx + 1) * 10}s`,
        title: item.title || `Scene ${idx + 1}`,
        prompt: item.prompt.includes("Audio:") ? item.prompt : `${item.prompt} Audio: Clear natural Indonesian voiceover speaking: '${item.script || item.voiceover || ""}'`,
        script: item.script || item.voiceover || "",
      }));
    } else {
      const arrayResult = scriptArraySchema.safeParse(rawJson);
      if (arrayResult.success) {
        scenesList = arrayResult.data.map((item, idx) => ({
          num: idx + 1,
          time: item.time || `${idx * 10}–${(idx + 1) * 10}s`,
          title: item.title || `Scene ${idx + 1}`,
          prompt: item.prompt.includes("Audio:") ? item.prompt : `${item.prompt} Audio: Clear natural Indonesian voiceover speaking: '${item.script || item.voiceover || ""}'`,
          script: item.script || item.voiceover || "",
        }));
      }
    }
  } catch (err: unknown) {
    throw new Error(`Gagal mem-parse naskah JSON dari LLM: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (scenesList.length === 0) {
    throw new Error("Format naskah JSON dari LLM tidak menghasilkan daftar adegan.");
  }

  return {
    character_anchor: characterAnchor,
    setting_anchor: settingAnchor,
    scenes: scenesList,
  };
}

async function runPipelineAsync(core: Core, body: PipelineRequestBody): Promise<void> {
  const duration = Number(body.duration ?? 60);
  const productFile = String(body.product_file || "bvflow.jpg");
  const productBase = productFile.replace(/\.[^.]+$/, "");
  const projectFolder = `Flow_${productBase}_${duration}s`;
  const productPath = join(PRODUCT_DIR, productFile);
  const clipsCount = duration === 10 ? 1 : duration === 15 ? 2 : duration === 30 ? 3 : duration === 60 ? 6 : Math.max(1, Math.min(10, Math.round(duration / 10)));

  activePipeline.running = true;
  activePipeline.duration = duration;
  activePipeline.clips_count = clipsCount;
  activePipeline.current_scene = 0;
  activePipeline.product_file = productFile;
  activePipeline.error = undefined;
  activePipeline.logs = [`[${new Date().toLocaleTimeString()}] Memulai generate video ${duration}s (${clipsCount} clips) untuk ${productFile}`];

  try {
    const downloadedClips: string[] = [];
    let scenes = body.scenes;
    let characterAnchor = String(body.character_anchor || "Indonesian protagonist with authentic appearance, consistent clothing items and natural expressions.");
    let settingAnchor = String(body.setting_anchor || "Consistent aesthetic interior setting by soft natural daylight.");

    if (!Array.isArray(scenes) || scenes.length < clipsCount) {
      const draft = await generateScriptWithLLM(body);
      scenes = draft.scenes;
      characterAnchor = draft.character_anchor;
      settingAnchor = draft.setting_anchor;
    }
    const scenesToRun = scenes.slice(0, clipsCount);
    const storylineOverview = scenesToRun.map((sc) => `- Scene ${sc.num} (${sc.time}): ${sc.title} — ${sc.script}`).join("\n");

    for (let i = 0; i < clipsCount; i++) {
      const s = scenesToRun[i];
      const sceneNum = i + 1;
      activePipeline.current_scene = sceneNum;
      activePipeline.status_text = `Generating Scene ${sceneNum}/${clipsCount}: ${s.title || ""}`;
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Scene ${sceneNum}/${clipsCount} dikirim ke Google Flow Omni 1.1 Flash`);

      const currentAction = s.prompt.replace(/Audio:.*$/i, "").trim();
      const hierarchicalPrompt = `[SCENE ${sceneNum} OF ${clipsCount}]:
${currentAction}
${s.script ? `Audio: Voiceover speaking: '${s.script}'` : ""}

[CONTINUITY CONTEXT]:
Character: ${characterAnchor}
Setting: ${settingAnchor}
All Scenes:
${storylineOverview}
Continuous shot sequence. Keep character likeness, wardrobe, and setting consistent.`;

      const genRes = (await (core.generate as unknown as (args: unknown) => Promise<GenResult>)({
        project: projectFolder,
        scenes: [
          {
            prompt: hierarchicalPrompt,
            type: "video",
            model: "Omni 1.1 Flash",
            aspect_ratio: "9:16",
            duration: 10,
            resolution: "720p",
            max_credits: 50,
            reference_images: existsSync(productPath) ? [productPath] : undefined
          }
        ]
      }));

      const job = genRes.jobs[0];
      let completed = false;
      let clipFile: string | null = null;

      while (!completed) {
        const waitRes = (await (core.wait as unknown as (args: unknown) => Promise<WaitResult>)({ job_ids: [job.id], timeout_seconds: 35 }));
        const current = waitRes.jobs.find((j) => j.id === job.id);
        if (current) {
          if (current.status === "done" && current.files?.length) {
            clipFile = current.files[0];
            completed = true;
          } else if (current.status === "failed") {
            const sceneLabel = `scene-${String(sceneNum).padStart(2, "0")}`;
            const dl = (await (core.download as unknown as (args: unknown) => Promise<{ files: string[] }>)({
              project: projectFolder,
              assets: [`${projectFolder}-${sceneLabel}`],
              quality: "original"
            }).catch(() => null));
            if (dl?.files?.length) {
              clipFile = dl.files[0];
              completed = true;
            } else {
              throw new Error(current.error || `Gagal generate scene ${sceneNum}`);
            }
          }
        }
        if (!completed) await new Promise((r) => setTimeout(r, 4000));
      }

      if (clipFile && existsSync(clipFile)) {
        downloadedClips.push(clipFile);
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Scene ${sceneNum} selesai: ${basename(clipFile)}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Stitching with ffmpeg
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const outputFilename = `${productBase}_${duration}s.mp4`;
    const finalVideoPath = join(OUTPUT_DIR, outputFilename);

    if (downloadedClips.length === 1) {
      await run("cp", [downloadedClips[0], finalVideoPath]);
    } else {
      const transitionDuration = 0.5;
      const clipDuration = 10;
      let vFilter = "";
      let aFilter = "";
      let lastV = "0:v";
      let lastA = "0:a";
      let currentOffset = clipDuration - transitionDuration;

      const args = ["-y"];
      for (const clip of downloadedClips) {
        args.push("-i", clip);
      }

      for (let i = 1; i < downloadedClips.length; i++) {
        const nextV = `v${i}`;
        const nextA = `a${i}`;
        vFilter += `[${lastV}][${i}:v]xfade=transition=fade:duration=${transitionDuration}:offset=${currentOffset.toFixed(1)}[${nextV}];`;
        aFilter += `[${lastA}][${i}:a]acrossfade=d=${transitionDuration}[${nextA}];`;
        lastV = nextV;
        lastA = nextA;
        currentOffset += (clipDuration - transitionDuration);
      }

      args.push(
        "-filter_complex", `${vFilter}${aFilter}`,
        "-map", `[${lastV}]`,
        "-map", `[${lastA}]`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        finalVideoPath
      );

      await run(FFMPEG, args);
    }

    activePipeline.status_text = "Selesai";
    activePipeline.last_video = outputFilename;
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 Video final berhasil dirakit: ${outputFilename}`);
  } catch (err: unknown) {
    activePipeline.status_text = "Error";
    activePipeline.error = err instanceof Error ? err.message : String(err);
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error: ${activePipeline.error}`);
  } finally {
    activePipeline.running = false;
  }
}
function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  const isAllowed = inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR) || inside(file, OUTPUT_DIR) || inside(file, PRODUCT_DIR);
  if (!isAllowed || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// owns the port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
export async function startServer(core: Core): Promise<ServerRole> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  const server = createServer(async (req, res) => {
    try {
      // The Host check blocks DNS-rebinding; the token blocks other local pages from driving the queue.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
       const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
 
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, x-flow-token");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }

       if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { name: "flow-mcp" });
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });

      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      // Products API
      if (req.method === "GET" && url.pathname === "/api/products") {
        mkdirSync(PRODUCT_DIR, { recursive: true });
        const files = readdirSync(PRODUCT_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => {
          const full = join(PRODUCT_DIR, f);
          const st = statSync(full);
          return { name: f, size: st.size, modified: st.mtimeMs, url: `/media?path=${encodeURIComponent(full)}&token=${token}` };
        });
        return json(res, 200, { products: files });
      }

      if (req.method === "POST" && url.pathname === "/api/products/upload") {
        mkdirSync(PRODUCT_DIR, { recursive: true });
        const name = basename(url.searchParams.get("name") ?? "product.jpg").replace(/[^\w.-]+/g, "_");
        const full = join(PRODUCT_DIR, name);
        writeFileSync(full, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { success: true, name, url: `/media?path=${encodeURIComponent(full)}&token=${token}` });
      }

      if (req.method === "DELETE" && url.pathname === "/api/products") {
        const name = basename(url.searchParams.get("name") ?? "");
        const full = join(PRODUCT_DIR, name);
        if (name && existsSync(full) && inside(full, PRODUCT_DIR)) {
          unlinkSync(full);
          return json(res, 200, { success: true, deleted: name });
        }
        return json(res, 404, { error: "File not found." });
      }

      // Outputs API
      if (req.method === "GET" && url.pathname === "/api/outputs") {
        mkdirSync(OUTPUT_DIR, { recursive: true });
        const files = readdirSync(OUTPUT_DIR).filter((f) => /\.mp4$/i.test(f)).map((f) => {
          const full = join(OUTPUT_DIR, f);
          const st = statSync(full);
          return { name: f, size: st.size, modified: st.mtimeMs, url: `/media?path=${encodeURIComponent(full)}&token=${token}` };
        });
        return json(res, 200, { outputs: files });
      }

      if (req.method === "DELETE" && url.pathname === "/api/outputs") {
        const name = basename(url.searchParams.get("name") ?? "");
        const full = join(OUTPUT_DIR, name);
        if (name && existsSync(full) && inside(full, OUTPUT_DIR)) {
          unlinkSync(full);
          return json(res, 200, { success: true, deleted: name });
        }
        return json(res, 404, { error: "File not found." });
      }

      // Chrome Login Window Trigger
      if (req.method === "POST" && url.pathname === "/api/flow/login") {
        const loginScript = join(MCP_DIR, "dist/login.js");
        const child = spawn("node", [loginScript], { detached: true, stdio: "ignore" });
        child.unref();
        return json(res, 200, { success: true, message: "Chrome login window opened" });
      }

      // Fetch Models from LLM /models endpoint
      if (req.method === "POST" && url.pathname === "/api/llm/models") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as { api_key?: string; endpoint?: string };
        const apiKey = body.api_key || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "";
        let endpoint = String(body.endpoint || "https://generativelanguage.googleapis.com/v1beta/openai");
        endpoint = endpoint.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
        if (!endpoint.endsWith("/models")) endpoint = `${endpoint}/models`;

        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
          const resp = await fetch(endpoint, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
          if (resp.ok) {
            const data = (await resp.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> };
            const models: string[] = [];
            if (Array.isArray(data.data)) {
              models.push(...data.data.map((m) => m.id || m.name || "").filter(Boolean));
            } else if (Array.isArray(data.models)) {
              models.push(...data.models.map((m) => (m.name || m.id || "").replace(/^models\//, "")).filter(Boolean));
            }
            return json(res, 200, { success: true, models });
          }
          return json(res, 200, { success: false, models: [] });
        } catch (err: unknown) {
          return json(res, 200, { success: false, models: [], error: err instanceof Error ? err.message : String(err) });
        }
      }

      // LLM Script Generation
      if (req.method === "POST" && url.pathname === "/api/llm/generate-script") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}");
        const result = await generateScriptWithLLM(body);
        return json(res, 200, { success: true, ...result });
      }

      // Pipeline Generation Trigger
      if (req.method === "POST" && url.pathname === "/api/pipeline/generate") {
        if (activePipeline.running) return json(res, 409, { error: "A video generation pipeline is already running." });
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}");
        void runPipelineAsync(core, body);
        return json(res, 200, { success: true, pipeline: activePipeline });
      }

      if (req.method === "GET" && url.pathname === "/api/pipeline/status") {
        return json(res, 200, { pipeline: activePipeline });
      }

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(PORT, "127.0.0.1", () => ok(true));
  });
  if (listening) {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return "owner";
  }
  // The port is taken. Who has it matters enormously: becoming a second LOCAL core means two processes drive the same
  // Flow tab with separate queues, which is how a shot got generated and charged twice while flow_status reported an
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting, or
  // busy inside a Playwright call, so one 2 s health check timing out proves nothing.
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "flow-mcp") return "client";
    // A valid answer from something that is NOT us means the port belongs to an unrelated program, and driving Flow
    // locally is safe.
    if (other) return "none";
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
  // calls fail loudly is far better than a second process silently spending the user's credits.
  return "client";
}
