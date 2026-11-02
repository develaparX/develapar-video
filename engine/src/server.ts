import { randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR, getFlowPage } from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { chooseSaveVideoPath, findFfmpeg, getProductDir, getOutputDir, getDevideoBaseDir, openDirectory } from "./platform.js";
import {
  PRESET_PACKS,
  STYLE_OPTIONS,
  TONE_OPTIONS,
  buildLayeredSystemPrompt,
  computeClipSchedule,
  type ImageAttachmentInput,
} from "./presets.js";

const run = promisify(execFile);
const PRODUCT_DIR = getProductDir();
const OUTPUT_DIR = getOutputDir();
const FFMPEG = findFfmpeg();

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
export const TOKEN_FILE = join(HOME_DIR, "token");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
// @ts-ignore
import EMBEDDED_STUDIO_HTML from "../../ui/index.html" with { type: "text" };
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
  duration: 30,
  clips_count: 3,
  current_scene: 0,
  status_text: "Sistem siap",
  logs: ["Flow Studio siap untuk generate video."],
  product_file: "",
  last_video: ""
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

const inside = (file: string, dir: string) => {
  const rf = resolve(file);
  const rd = resolve(dir) + sep;
  return process.platform === "win32"
    ? rf.toLowerCase().startsWith(rd.toLowerCase())
    : rf.startsWith(rd);
};

export interface ScriptScene {
  num: number;
  time: string;
  duration?: number;
  title: string;
  speaker?: string;
  prompt: string;
  script: string;
  on_screen_text?: string;
  refs?: string[];
}

export interface ScriptResult {
  product_identified?: string;
  product_slug?: string;
  product_category?: string;
  pronunciation?: string;
  recommended_style?: string;
  recommended_tone?: string;
  recommendation_reason?: string;
  research_summary?: string;
  facts_used?: string[];
  claim_warnings?: string[];
  style?: string;
  voiceover_persona?: string;
  character_anchor: string;
  setting_anchor: string;
  scenes: ScriptScene[];
}

export interface ScriptRequestBody {
  duration?: number;
  prompt?: string;
  product_file?: string;
  product_files?: Array<string | ImageAttachmentInput>;
  preset_id?: string;
  style_id?: string;
  tone_id?: string;
  voice_language?: string;
  model?: string;
  endpoint?: string;
  api_key?: string;
}

export interface PipelineRequestBody extends ScriptRequestBody {
  product_identified?: string;
  product_slug?: string;
  style?: string;
  voiceover_persona?: string;
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
  duration: z.number().optional(),
  title: z.string().optional(),
  speaker: z.string().optional(),
  prompt: z.string(),
  script: z.string().optional(),
  voiceover: z.string().optional(),
  on_screen_text: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

const scriptEnvelopeSchema = z.object({
  product_identified: z.string().optional(),
  product_slug: z.string().optional(),
  product_category: z.string().optional(),
  pronunciation: z.string().optional(),
  recommended_style: z.string().optional(),
  recommended_tone: z.string().optional(),
  recommendation_reason: z.string().optional(),
  research_summary: z.string().optional(),
  facts_used: z.array(z.string()).optional(),
  claim_warnings: z.array(z.string()).optional(),
  style: z.string().optional(),
  voiceover_persona: z.string().optional(),
  character_anchor: z.string().optional(),
  setting_anchor: z.string().optional(),
  scenes: z.array(sceneItemSchema),
});

const scriptArraySchema = z.array(sceneItemSchema);

function normalizeImageAttachments(body: ScriptRequestBody): ImageAttachmentInput[] {
  const list: ImageAttachmentInput[] = [];
  if (Array.isArray(body.product_files) && body.product_files.length > 0) {
    for (const item of body.product_files) {
      if (typeof item === "string" && item.trim()) {
        list.push({ file: item.trim(), role: list.length === 0 ? "product_main" : "product_variant" });
      } else if (item && typeof item === "object" && typeof item.file === "string" && item.file.trim()) {
        list.push({ file: item.file.trim(), role: item.role || (list.length === 0 ? "product_main" : "product_variant") });
      }
    }
  }
  if (list.length === 0 && body.product_file && body.product_file.trim()) {
    list.push({ file: body.product_file.trim(), role: "product_main" });
  }
  return list.slice(0, 6);
}

async function generateScriptWithLLM(body: ScriptRequestBody): Promise<ScriptResult> {
  const duration = Number(body.duration ?? 30);
  const { clipsCount, clipDurations } = computeClipSchedule(duration);
  const images = normalizeImageAttachments(body);
  if (images.length === 0) {
    throw new Error("Pilih minimal 1 foto produk terlebih dahulu.");
  }

  const userPrompt = String(
    body.prompt ||
      "Analisis seluruh foto produk terlampir, riset manfaat utamanya, dan susun naskah serta storyboard video sesuai preset/style/tone yang dipilih."
  );
  const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");
  const apiKey = body.api_key || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  let endpoint = body.endpoint || "https://generativelanguage.googleapis.com/v1beta/openai";
  const model = body.model || "gemini-2.5-flash";

  if (!apiKey) {
    throw new Error("API Key LLM belum diisi. Masukkan API Key Anda di panel 'Brief kreatif' untuk menganalisis foto produk dan membuat naskah.");
  }

  if (!endpoint.endsWith("/chat/completions")) {
    endpoint = endpoint.replace(/\/+$/, "") + "/chat/completions";
  }

  const sysPrompt = buildLayeredSystemPrompt({
    duration,
    clipsCount,
    clipDurations,
    presetId: body.preset_id,
    styleId: body.style_id,
    toneId: body.tone_id,
    voiceLanguage,
    userPrompt,
    images,
  });

  const imageListSummary = images
    .map((im, idx) => `- img${idx + 1}: "${im.file}" (peran: ${im.role || "product_main"})`)
    .join("\n");

  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: `INI USER PROMPT (INSTRUKSI KREATIF UTAMA):
"""
${userPrompt}
"""

[DAFTAR GAMBAR TERLAMPIR (${images.length} GAMBAR)]:
${imageListSummary}

Instruksi Eksekusi:
1. Periksa setiap gambar terlampir secara menyeluruh (baca nama produk, merek, komposisi, izin edar, bentuk sediaan, dan detail visual).
2. Buat tepat ${clipsCount} scene untuk total target durasi ${duration} detik.
3. Kembalikan hanya raw JSON valid sesuai struktur schema yang diminta.`
    }
  ];

  for (const im of images) {
    const imgPath = join(PRODUCT_DIR, im.file);
    if (existsSync(imgPath)) {
      const ext = extname(im.file).toLowerCase().replace(/^\./, "");
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const b64 = readFileSync(imgPath).toString("base64");
      userContent.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` }
      });
    }
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
      temperature: 0.65,
      stream: false
    }),
    signal: AbortSignal.timeout(75000)
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

  const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  let characterAnchor = "";
  let settingAnchor = "";
  let scenesList: ScriptScene[] = [];
  let productIdentified = "";
  let productSlug = "";
  let productCategory = "";
  let pronunciation = "";
  let recommendedStyle = "";
  let recommendedTone = "";
  let recommendationReason = "";
  let researchSummary = "";
  let factsUsed: string[] = [];
  let claimWarnings: string[] = [];
  let detectedStyle = "cinematic";
  let voiceoverPersona = "Warm Indonesian narrator";

  try {
    const rawJson: unknown = JSON.parse(clean);
    const envelopeResult = scriptEnvelopeSchema.safeParse(rawJson);
    if (envelopeResult.success) {
      const d = envelopeResult.data;
      if (d.product_identified) productIdentified = d.product_identified;
      if (d.product_slug) productSlug = d.product_slug;
      if (d.product_category) productCategory = d.product_category;
      if (d.pronunciation) pronunciation = d.pronunciation;
      if (d.recommended_style) recommendedStyle = d.recommended_style;
      if (d.recommended_tone) recommendedTone = d.recommended_tone;
      if (d.recommendation_reason) recommendationReason = d.recommendation_reason;
      if (d.research_summary) researchSummary = d.research_summary;
      if (Array.isArray(d.facts_used)) factsUsed = d.facts_used;
      if (Array.isArray(d.claim_warnings)) claimWarnings = d.claim_warnings;
      if (d.style) detectedStyle = d.style;
      if (d.voiceover_persona) voiceoverPersona = d.voiceover_persona;
      if (d.character_anchor) characterAnchor = d.character_anchor;
      if (d.setting_anchor) settingAnchor = d.setting_anchor;

      scenesList = d.scenes.map((item, idx) => {
        const clipDur = clipDurations[idx] ?? item.duration ?? 10;
        const startSec = clipDurations.slice(0, idx).reduce((a, b) => a + b, 0);
        const endSec = startSec + clipDur;
        const speakerDesc = item.speaker ? `${item.speaker} (${voiceoverPersona})` : voiceoverPersona;
        const spokenScript = item.script || item.voiceover || "";
        return {
          num: idx + 1,
          time: item.time || `${String(startSec).padStart(2, "0")}–${String(endSec).padStart(2, "0")}s`,
          duration: clipDur,
          title: item.title || `Scene ${idx + 1}`,
          speaker: item.speaker,
          prompt: item.prompt.includes("Audio:") ? item.prompt : `${item.prompt} Audio: Voiceover in ${voiceLanguage} by ${speakerDesc} speaking: '${spokenScript}'`,
          script: spokenScript,
          on_screen_text: item.on_screen_text,
          refs: Array.isArray(item.refs) && item.refs.length > 0 ? item.refs.slice(0, 3) : ["img1"],
        };
      });
    } else {
      const arrayResult = scriptArraySchema.safeParse(rawJson);
      if (arrayResult.success) {
        scenesList = arrayResult.data.map((item, idx) => {
          const clipDur = clipDurations[idx] ?? item.duration ?? 10;
          const startSec = clipDurations.slice(0, idx).reduce((a, b) => a + b, 0);
          const endSec = startSec + clipDur;
          const spokenScript = item.script || item.voiceover || "";
          return {
            num: idx + 1,
            time: item.time || `${String(startSec).padStart(2, "0")}–${String(endSec).padStart(2, "0")}s`,
            duration: clipDur,
            title: item.title || `Scene ${idx + 1}`,
            speaker: item.speaker,
            prompt: item.prompt.includes("Audio:") ? item.prompt : `${item.prompt} Audio: Voiceover in ${voiceLanguage} by ${voiceoverPersona} speaking: '${spokenScript}'`,
            script: spokenScript,
            on_screen_text: item.on_screen_text,
            refs: Array.isArray(item.refs) && item.refs.length > 0 ? item.refs.slice(0, 3) : ["img1"],
          };
        });
      }
    }
  } catch (err: unknown) {
    throw new Error(`Gagal mem-parse naskah JSON dari LLM: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (scenesList.length === 0) {
    throw new Error("Format naskah JSON dari LLM tidak menghasilkan daftar adegan.");
  }

  return {
    product_identified: productIdentified,
    product_slug: productSlug,
    product_category: productCategory,
    pronunciation,
    recommended_style: recommendedStyle,
    recommended_tone: recommendedTone,
    recommendation_reason: recommendationReason,
    research_summary: researchSummary,
    facts_used: factsUsed,
    claim_warnings: claimWarnings,
    style: detectedStyle,
    voiceover_persona: voiceoverPersona,
    character_anchor: characterAnchor,
    setting_anchor: settingAnchor,
    scenes: scenesList,
  };
}

async function runPipelineAsync(core: Core, body: PipelineRequestBody): Promise<void> {
  const duration = Number(body.duration ?? 30);
  const { clipsCount, clipDurations } = computeClipSchedule(duration);
  const images = normalizeImageAttachments(body);
  const primaryFile = images[0]?.file || String(body.product_file || "product.jpg");
  const productBase = primaryFile.replace(/\.[^.]+$/, "");
  const projectFolder = `Flow_${productBase}_${duration}s`;

  // Map img1..imgN to actual file paths in PRODUCT_DIR
  const imageIdToPath = new Map<string, string>();
  images.forEach((im, idx) => {
    const p = join(PRODUCT_DIR, im.file);
    if (existsSync(p)) {
      imageIdToPath.set(`img${idx + 1}`, p);
      imageIdToPath.set(im.file, p);
    }
  });
  // Fallback visual reference paths (excluding label-only detail images unless it's the only image)
  const visualFallbackPaths = images
    .filter((im, idx) => idx === 0 || im.role !== "product_detail")
    .map((im) => join(PRODUCT_DIR, im.file))
    .filter((p) => existsSync(p))
    .slice(0, 3);

  activePipeline.running = true;
  activePipeline.duration = duration;
  activePipeline.clips_count = clipsCount;
  activePipeline.current_scene = 0;
  activePipeline.product_file = primaryFile;
  activePipeline.error = undefined;
  activePipeline.logs = [
    `[${new Date().toLocaleTimeString()}] Memulai generate video ${duration}s (${clipsCount} klip, ${images.length} gambar referensi) untuk ${images.map((i) => i.file).join(", ")}`
  ];

  try {
    const downloadedClips: string[] = [];
    const downloadedClipDurations: number[] = [];
    let scenes = body.scenes;
    let characterAnchor = String(body.character_anchor || "");
    let settingAnchor = String(body.setting_anchor || "");
    let voiceoverPersona = String(body.voiceover_persona || "Warm Indonesian narrator");
    let pipelineStyle = String(body.style || "cinematic");
    const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");

    let draft: ScriptResult | null = null;
    if (!Array.isArray(scenes) || scenes.length < clipsCount) {
      activePipeline.status_text = "Menyusun naskah & storyboard otomatis via AI...";
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Menyusun naskah otomatis (${clipsCount} scene)...`);
      draft = await generateScriptWithLLM(body);
      scenes = draft.scenes;
      characterAnchor = characterAnchor || draft.character_anchor;
      settingAnchor = settingAnchor || draft.setting_anchor;
      if (draft.voiceover_persona) voiceoverPersona = draft.voiceover_persona;
      if (draft.style) pipelineStyle = draft.style;
    }

    const scenesToRun = scenes.slice(0, clipsCount);
    // Storyline overview uses ONLY scene titles so Flow Omni doesn't speak or render other scenes' scripts
    const storylineOverview = scenesToRun
      .map((sc) => `- Scene ${sc.num} (${sc.time}): ${sc.title}`)
      .join("\n");

    for (let i = 0; i < clipsCount; i++) {
      const s = scenesToRun[i];
      const sceneNum = i + 1;
      const rawClipDur = clipDurations[i] ?? s.duration ?? 10;
      const validOmniDur: 4 | 6 | 8 | 10 = rawClipDur <= 4 ? 4 : rawClipDur <= 6 ? 6 : rawClipDur <= 8 ? 8 : 10;

      activePipeline.current_scene = sceneNum;
      activePipeline.status_text = `Generating Scene ${sceneNum}/${clipsCount}: ${s.title || ""}`;

      // Resolve up to 3 reference images for this specific scene
      const sceneRefPaths: string[] = [];
      if (Array.isArray(s.refs) && s.refs.length > 0) {
        for (const refId of s.refs) {
          const resolved = imageIdToPath.get(refId);
          if (resolved && !sceneRefPaths.includes(resolved)) {
            sceneRefPaths.push(resolved);
          }
        }
      }
      if (sceneRefPaths.length === 0) {
        sceneRefPaths.push(...visualFallbackPaths);
      }
      const finalSceneRefs = sceneRefPaths.slice(0, 3);

      activePipeline.logs.push(
        `[${new Date().toLocaleTimeString()}] Scene ${sceneNum}/${clipsCount} (${validOmniDur}s, ${finalSceneRefs.length} ref img) dikirim ke Google Flow Omni 1.1 Flash`
      );

      const currentAction = s.prompt.replace(/Audio:.*$/i, "").trim();
      const speakerLabel = s.speaker ? `${s.speaker} (${voiceoverPersona})` : voiceoverPersona;
      const hierarchicalPrompt = `[SCENE ${sceneNum} OF ${clipsCount} — DEPICT ONLY THIS SCENE]:
${currentAction}
${s.script ? `Audio: Voiceover in ${voiceLanguage} by ${speakerLabel} speaking: '${s.script}'` : ""}

[CONTINUITY REFERENCE ONLY — DO NOT DEPICT OR SPEAK OTHER SCENES]:
Product Packaging Rule: Keep product shape, packaging, and printed brand label faithful to the attached reference image(s). Do not add overlaid subtitles, captions, or watermarks.
Character / Mascot / Subject: ${characterAnchor || "Consistent with scene style"}
Setting / Environment: ${settingAnchor || "Consistent with scene style"}
Voiceover Persona: ${voiceoverPersona}
Story Arc Titles (context only):
${storylineOverview}
Maintain 100% strict visual consistency for all characters/mascots/subjects and exact same vocal persona and pace across all shots.`;

      const genRes = (await (core.generate as unknown as (args: unknown) => Promise<GenResult>)({
        project: projectFolder,
        scenes: [
          {
            prompt: hierarchicalPrompt,
            type: "video",
            model: "Omni 1.1 Flash",
            aspect_ratio: "9:16",
            duration: validOmniDur,
            resolution: "720p",
            max_credits: 50,
            reference_images: finalSceneRefs.length > 0 ? finalSceneRefs : undefined
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
        downloadedClipDurations.push(validOmniDur);
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Scene ${sceneNum} selesai: ${basename(clipFile)}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Stitching with ffmpeg
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const rawProductBrand = body.product_slug || (draft ? draft.product_slug : "") || body.product_identified || (draft ? draft.product_identified : "") || "";
    const cleanProductBrand = rawProductBrand
      .toLowerCase()
      .replace(/\b(whatsapp|image|screenshot|img|photo|foto|picture|file|jpeg|jpg|png|webp)\b/gi, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);

    const productSlug = cleanProductBrand || productBase.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) || "product";
    const rawStyle = body.style || pipelineStyle || "cinematic";
    const styleSlug = rawStyle.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "cinematic";
    const baseStem = `${productSlug}_${styleSlug}_${duration}s`;
    let outputFilename = `${baseStem}.mp4`;
    let dupIndex = 1;
    while (existsSync(join(OUTPUT_DIR, outputFilename))) {
      outputFilename = `${baseStem}-${dupIndex}.mp4`;
      dupIndex++;
    }
    const finalVideoPath = join(OUTPUT_DIR, outputFilename);
    activePipeline.status_text = "Menggabungkan klip video (FFmpeg crossfade)...";
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🎞️ Menggabungkan ${downloadedClips.length} klip video (${outputFilename}) dengan transisi crossfade audio & visual...`);
    if (downloadedClips.length === 1) {
      writeFileSync(finalVideoPath, readFileSync(downloadedClips[0]));
    } else {
      const transitionDuration = 0.5;
      let vFilter = "";
      let aFilter = "";
      let lastV = "0:v";
      let lastA = "0:a";
      let currentOffset = (downloadedClipDurations[0] ?? 10) - transitionDuration;

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
        currentOffset += ((downloadedClipDurations[i] ?? 10) - transitionDuration);
      }

      args.push(
        "-filter_complex", `${vFilter}${aFilter}`,
        "-map", `[${lastV}]`,
        "-map", `[${lastA}]`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac"
      );
      if (duration === 15) {
        args.push("-t", "15");
      }
      args.push(finalVideoPath);

      await run(findFfmpeg(), args);
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
function sendMedia(req: IncomingMessage, res: ServerResponse, file: string, forceDownload = false) {
  const isAllowed = inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR) || inside(file, OUTPUT_DIR) || inside(file, PRODUCT_DIR);
  if (!isAllowed || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const dispHeader: Record<string, string> = forceDownload
    ? { "content-disposition": `attachment; filename="${basename(file).replace(/"/g, "")}"` }
    : {};
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && !forceDownload) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, ...dispHeader });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, ...dispHeader });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// owns the port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
export async function startServer(core: Core): Promise<ServerRole> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = process.env.FLOW_MCP_TOKEN ?? randomBytes(24).toString("hex");
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
        return res.end(EMBEDDED_STUDIO_HTML.replace("__FLOW_TOKEN__", token));
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      const origin = req.headers.origin ?? "";
      const isInternalApp =
        origin.startsWith("tauri://") ||
        origin.startsWith("http://tauri.") ||
        origin.startsWith("https://tauri.") ||
        origin === "http://localhost:5173" ||
        origin === `http://127.0.0.1:${PORT}` ||
        origin === `http://localhost:${PORT}`;

      if (!isInternalApp && given !== token) {
        return json(res, 401, { error: "Missing or wrong token." });
      }

      if (req.method === "GET" && url.pathname === "/api/paths") {
        return json(res, 200, {
          base: getDevideoBaseDir(),
          product: PRODUCT_DIR,
          output: OUTPUT_DIR,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/open-folder") {
        const type = url.searchParams.get("type") ?? "output";
        const target = type === "product" ? PRODUCT_DIR : OUTPUT_DIR;
        openDirectory(target);
        return json(res, 200, { success: true, opened: target });
      }

      if (req.method === "GET" && url.pathname === "/media") {
        return sendMedia(req, res, url.searchParams.get("path") ?? "", url.searchParams.get("download") === "1");
      }

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

      if (req.method === "POST" && url.pathname === "/api/outputs/save-as") {
        const rawBody = (await readBody(req, 64 * 1024)).toString();
        const body = rawBody ? (JSON.parse(rawBody) as { name?: string }) : {};
        const name = basename(body.name || url.searchParams.get("name") || "");
        const full = join(OUTPUT_DIR, name);
        if (!name || !existsSync(full) || !inside(full, OUTPUT_DIR)) {
          return json(res, 404, { error: "File video tidak ditemukan di folder output." });
        }
        const destPath = chooseSaveVideoPath(name);
        if (!destPath) {
          return json(res, 200, { success: false, cancelled: true });
        }
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(full, destPath);
        return json(res, 200, { success: true, saved_to: destPath, name });
      }

      // Chrome Login Window Trigger
      if (req.method === "POST" && url.pathname === "/api/flow/login") {
        try {
          const page = await getFlowPage();
          await page.bringToFront().catch(() => {});
          return json(res, 200, { success: true, message: "Chrome login window opened" });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { error: `Gagal membuka Chrome: ${message}` });
        }
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

      // Presets, Styles & Tones API
      if (req.method === "GET" && url.pathname === "/api/presets") {
        return json(res, 200, {
          presets: PRESET_PACKS,
          styles: STYLE_OPTIONS,
          tones: TONE_OPTIONS,
        });
      }

      // Preview assembled system prompt
      if (req.method === "POST" && url.pathname === "/api/llm/preview-prompt") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as ScriptRequestBody;
        const duration = Number(body.duration ?? 30);
        const { clipsCount, clipDurations } = computeClipSchedule(duration);
        const images = normalizeImageAttachments(body);
        const sysPrompt = buildLayeredSystemPrompt({
          duration,
          clipsCount,
          clipDurations,
          presetId: body.preset_id,
          styleId: body.style_id,
          toneId: body.tone_id,
          voiceLanguage: body.voice_language || "Bahasa Indonesia",
          userPrompt: body.prompt,
          images: images.length > 0 ? images : [{ file: "product.jpg", role: "product_main" }],
        });
        return json(res, 200, { success: true, system_prompt: sysPrompt });
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
