import { randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR, getFlowPage } from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { chooseSaveVideoPath, findFfmpeg, findFfprobe, getProductDir, getOutputDir, getDevideoBaseDir, openDirectory } from "./platform.js";
import { extractLastFrame } from "./chain.js";
import { createProductEndCard } from "./assemble.js";
import {
  PRESET_PACKS,
  STYLE_OPTIONS,
  TONE_OPTIONS,
  HOOK_LIBRARY,
  TRANSITION_SECONDS,
  PlatformPresetError,
  type PlatformPreset,
  type ResolvedPlatformConfig,
  type HookArchetype,
  resolvePlatformPreset,
  buildLayeredSystemPrompt,
  type ImageAttachmentInput,
  SUPPORTED_VIDEO_MODELS,
  getVideoModelCost,
  calculatePipelineCredits,
  type SupportedVideoModel,
  type PipelineCreditCalculation,
} from "./presets.js";
import { getFlowState } from "./flow.js";

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

export interface SceneStatusItem {
  scene_num: number;
  title: string;
  status: "pending" | "generating" | "done" | "failed";
  clip_file?: string;
  duration?: number;
  variants_count?: number;
  variant_files?: string[];
}

interface PipelineState {
  job_id?: string;
  running: boolean;
  duration: number;
  duration_actual?: number;
  video_model?: string;
  platform_preset?: string;
  clips_count: number;
  current_scene: number;
  status_text: string;
  logs: string[];
  product_file: string;
  last_video?: string;
  error?: string;
  cancelled?: boolean;
  scene_statuses?: SceneStatusItem[];
}

let isPipelineCancelled = false;
let currentRunningJobId: string | null = null;

let activePipeline: PipelineState = {
  running: false,
  cancelled: false,
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
  hook_type?: string;
  hook_text_3s?: string;
  retention_promise?: string;
  share_trigger?: string;
  cta_mode?: string;
  subject_mode?: "hands" | "pov" | "product" | "character";
}

export interface StreamEvent {
  type: "think" | "status" | "content";
  text: string;
}

export interface ScriptResult {
  thinking?: string;
  product_identified?: string;
  product_slug?: string;
  product_category?: string;
  platform_preset?: string;
  hook_type?: string;
  hook_text_3s?: string;
  retention_promise?: string;
  share_trigger?: string;
  cta_mode?: string;
  subject_mode?: "hands" | "pov" | "product" | "character";
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
  platform_preset?: PlatformPreset;
  style_id?: string;
  tone_id?: string;
  voice_language?: string;
  model?: string;
  video_model?: string;
  endpoint?: string;
  api_key?: string;
  stream?: boolean;
  enable_endcard?: boolean;
  hook_archetype?: HookArchetype;
  cta_mode?: "cart_checkout" | "dm_share" | "save_bookmark";
  subject_mode?: "hands" | "pov" | "product" | "character";
}

export interface PipelineRequestBody extends ScriptRequestBody {
  product_identified?: string;
  product_slug?: string;
  style?: string;
  video_model?: string;
  platform_preset?: PlatformPreset;
  enable_endcard?: boolean;
  hook_type?: string;
  hook_text_3s?: string;
  retention_promise?: string;
  share_trigger?: string;
  cta_mode?: "cart_checkout" | "dm_share" | "save_bookmark";
  subject_mode?: "hands" | "pov" | "product" | "character";
  voiceover_persona?: string;
  character_anchor?: string;
  setting_anchor?: string;
  scenes?: ScriptScene[];
  variants?: number;
  scene1_variants?: number;
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
  hook_type: z.string().optional(),
  hook_text_3s: z.string().optional(),
  retention_promise: z.string().optional(),
  share_trigger: z.string().optional(),
  cta_mode: z.string().optional(),
  subject_mode: z.enum(["hands", "pov", "product", "character"]).optional(),
});

const scriptEnvelopeSchema = z.object({
  product_identified: z.string().optional(),
  product_slug: z.string().optional(),
  product_category: z.string().optional(),
  platform_preset: z.string().optional(),
  hook_type: z.string().optional(),
  hook_text_3s: z.string().optional(),
  retention_promise: z.string().optional(),
  share_trigger: z.string().optional(),
  cta_mode: z.string().optional(),
  subject_mode: z.enum(["hands", "pov", "product", "character"]).optional(),
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

function tryParseLenientJson(input: string): unknown {
  const attempts = [
    input,
    input.replace(/\\'/g, "'"),
    input.replace(/,\s*([}\]])/g, "$1"),
    input.replace(/\\'/g, "'").replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const s of attempts) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  return null;
}

function parseJsonFromLlmOutput(text: string): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Respon LLM kosong.");
  }

  // 1. Remove deepseek/thinking models tags <think>...</think>
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. Try parsing markdown code blocks (e.g. ```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = codeBlockRegex.exec(clean)) !== null) {
    const candidate = blockMatch[1].trim();
    if (candidate) {
      const parsed = tryParseLenientJson(candidate);
      if (parsed !== null) return parsed;
    }
  }

  // 3. Try parsing cleaned text directly
  const directParsed = tryParseLenientJson(clean);
  if (directParsed !== null) return directParsed;

  // 4. Extract outermost JSON object { ... }
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = clean.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseLenientJson(candidate);
    if (parsed !== null) return parsed;
  }

  // 5. Extract outermost JSON array [ ... ]
  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = clean.slice(firstBracket, lastBracket + 1);
    const parsed = tryParseLenientJson(candidate);
    if (parsed !== null) return parsed;
  }

  throw new Error(`Tidak dapat mengekstrak JSON valid dari respon model LLM. Teks: ${clean.slice(0, 160)}...`);
}

function resolveRequestConfig(body: ScriptRequestBody | PipelineRequestBody): ResolvedPlatformConfig {
  const platform = (body.platform_preset || "custom") as PlatformPreset;
  const pipelineBody = body as PipelineRequestBody;
  const isCustom = platform === "custom";
  return resolvePlatformPreset(platform, {
    video_model: body.video_model,
    duration_target: body.duration,
    style_id: isCustom && body.style_id && body.style_id !== "auto" ? body.style_id : undefined,
    tone_id: isCustom && body.tone_id && body.tone_id !== "auto" ? body.tone_id : undefined,
    preset_id: (body.preset_id as "free" | "health_softsell" | "general_commercial") || undefined,
    subject_mode: isCustom ? body.subject_mode : undefined,
    cta_mode: isCustom ? (body.cta_mode as ResolvedPlatformConfig["cta_mode"] | undefined) : undefined,
    enable_endcard: pipelineBody.enable_endcard !== false,
    hook_archetype: body.hook_archetype,
  });
}

async function generateScriptWithLLM(
  body: ScriptRequestBody,
  onEvent?: (event: StreamEvent) => void,
  abortSignal?: AbortSignal,
  resolvedConfig?: ResolvedPlatformConfig
): Promise<ScriptResult> {
  const resolved = resolvedConfig ?? resolveRequestConfig(body);
  const videoModel = resolved.video_model;
  const duration = resolved.duration_target;
  const clipsCount = resolved.clips_count;
  const clipDurations = resolved.clip_durations;
  const resolvedStyle = resolved.style_id;
  const resolvedTone = resolved.tone_id;
  const resolvedPreset = resolved.preset_id;
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
    clipsDuration: resolved.clip_total,
    endcardSeconds: resolved.endcard_seconds,
    clipsCount,
    clipDurations,
    presetId: resolvedPreset,
    platformPreset: resolved.platform,
    styleId: resolvedStyle,
    toneId: resolvedTone,
    ctaMode: resolved.cta_mode,
    subjectMode: resolved.subject_mode,
    hookCategory: resolved.hook_category,
    hookArchetype: resolved.hook_archetype,
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
2. Buat tepat ${clipsCount} scene untuk durasi klip total ${resolved.clip_total} detik${resolved.endcard_seconds > 0 ? `; total video ${duration} detik termasuk end-card statis ${resolved.endcard_seconds} detik` : ""}.
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

  const wantsStream = Boolean(body.stream || onEvent);
  const internalAbort = new AbortController();
  const timeoutId = setTimeout(() => internalAbort.abort(new Error("Timeout LLM API 90 detik")), 90000);
  if (abortSignal) {
    if (abortSignal.aborted) {
      clearTimeout(timeoutId);
      throw new Error("Penyusunan naskah dibatalkan.");
    }
    abortSignal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      internalAbort.abort(abortSignal.reason);
    });
  }

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userContent }
        ],
        temperature: 0.65,
        stream: wantsStream
      }),
      signal: internalAbort.signal
    });
  } catch (fetchErr: unknown) {
    clearTimeout(timeoutId);
    if (internalAbort.signal.aborted && abortSignal?.aborted) {
      throw new Error("Penyusunan naskah dibatalkan.");
    }
    throw fetchErr;
  }

  if (!resp.ok) {
    clearTimeout(timeoutId);
    const errText = await resp.text().catch(() => "");
    throw new Error(`LLM API gagal (${resp.status}): ${errText || resp.statusText}`);
  }

  let raw = "";
  let thinkingCollected = "";
  const isStreaming = wantsStream && Boolean(resp.body && typeof resp.body.getReader === "function");

  if (isStreaming) {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let insideThinkTag = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: { content?: string; reasoning_content?: string; thinking?: string };
              }>;
            };
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            // 1. Reasoning field (DeepSeek API, OpenRouter, etc.)
            const reasoning = choice.delta?.reasoning_content || choice.delta?.thinking || "";
            if (reasoning) {
              thinkingCollected += reasoning;
              onEvent?.({ type: "think", text: reasoning });
            }

            // 2. Content delta (may contain inline <think>...</think> or JSON)
            const content = choice.delta?.content || "";
            if (content) {
              raw += content;

              let cursor = 0;
              while (cursor < content.length) {
                if (!insideThinkTag) {
                  const startIdx = content.indexOf("<think>", cursor);
                  if (startIdx !== -1) {
                    const before = content.slice(cursor, startIdx);
                    if (before) onEvent?.({ type: "content", text: before });
                    insideThinkTag = true;
                    cursor = startIdx + 7;
                  } else {
                    const rem = content.slice(cursor);
                    if (rem) onEvent?.({ type: "content", text: rem });
                    break;
                  }
                } else {
                  const endIdx = content.indexOf("</think>", cursor);
                  if (endIdx !== -1) {
                    const thinkPart = content.slice(cursor, endIdx);
                    if (thinkPart) {
                      thinkingCollected += thinkPart;
                      onEvent?.({ type: "think", text: thinkPart });
                    }
                    insideThinkTag = false;
                    cursor = endIdx + 8;
                  } else {
                    const thinkPart = content.slice(cursor);
                    if (thinkPart) {
                      thinkingCollected += thinkPart;
                      onEvent?.({ type: "think", text: thinkPart });
                    }
                    break;
                  }
                }
              }
            }
          } catch {}
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    try {
      const rawText = await resp.text();
      if (rawText.trim().startsWith("data:")) {
        for (const line of rawText.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
            try {
              const chunk = JSON.parse(trimmed.slice(5).trim()) as {
                choices?: Array<{
                  delta?: { content?: string; reasoning_content?: string };
                  message?: { content?: string; reasoning_content?: string };
                }>;
              };
              const r = chunk.choices?.[0]?.delta?.reasoning_content || chunk.choices?.[0]?.message?.reasoning_content || "";
              if (r) thinkingCollected += r;
              const delta = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || "";
              raw += delta;
            } catch {}
          }
        }
      } else {
        try {
          const data = JSON.parse(rawText) as ChatCompletionResponse & {
            choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          };
          const msg = data.choices?.[0]?.message;
          raw = msg?.content?.trim() || "";
          if (msg?.reasoning_content) {
            thinkingCollected = msg.reasoning_content.trim();
          }
        } catch {
          raw = rawText.trim();
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!raw) {
    raw = "";
  }

  // Extract <think>...</think> from raw if not already captured
  if (!thinkingCollected) {
    const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      thinkingCollected = thinkMatch[1].trim();
    }
  }

  if (onEvent && thinkingCollected && !isStreaming) {
    onEvent({ type: "think", text: thinkingCollected });
  }

  let characterAnchor = "";
  let settingAnchor = "";
  let scenesList: ScriptScene[] = [];
  let productIdentified = "";
  let productSlug = "";
  let productCategory = "";
  let platformPreset = body.platform_preset || "";
  let hookType = "";
  let hookText3s = "";
  let retentionPromise = "";
  let shareTrigger = "";
  let ctaMode = "";
  let subjectMode: "hands" | "pov" | "product" | "character" | undefined = undefined;
  let pronunciation = "";
  let recommendedStyle = "";
  let recommendedTone = "";
  let recommendationReason = "";
  let researchSummary = "";
  let factsUsed: string[] = [];
  let claimWarnings: string[] = [];
  let detectedStyle = "cinematic";
  let voiceoverPersona = `Warm, natural narrator speaking ${voiceLanguage}`;

  try {
    const rawJson: unknown = parseJsonFromLlmOutput(raw);
    const envelopeResult = scriptEnvelopeSchema.safeParse(rawJson);
    if (envelopeResult.success) {
      const d = envelopeResult.data;
      if (d.product_identified) productIdentified = d.product_identified;
      if (d.product_slug) productSlug = d.product_slug;
      if (d.product_category) productCategory = d.product_category;
      if (d.platform_preset) platformPreset = d.platform_preset;
      if (d.hook_type) hookType = d.hook_type;
      if (d.hook_text_3s) hookText3s = d.hook_text_3s;
      if (d.retention_promise) retentionPromise = d.retention_promise;
      if (d.share_trigger) shareTrigger = d.share_trigger;
      if (d.cta_mode) ctaMode = d.cta_mode;
      if (d.subject_mode) subjectMode = d.subject_mode;
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
          hook_type: item.hook_type || (idx === 0 ? hookType : undefined),
          hook_text_3s: item.hook_text_3s || (idx === 0 ? hookText3s : undefined),
          retention_promise: item.retention_promise || (idx === 0 ? retentionPromise : undefined),
          share_trigger: item.share_trigger || (idx === 0 ? shareTrigger : undefined),
          cta_mode: item.cta_mode || (idx === d.scenes.length - 1 ? ctaMode : undefined),
          subject_mode: item.subject_mode || subjectMode,
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

  const hookPool = HOOK_LIBRARY.filter(
    (hook) => hook.category === resolved.hook_category
      && (!resolved.hook_archetype || hook.archetype === resolved.hook_archetype)
  );
  const fallbackHook = hookPool[0]
    || HOOK_LIBRARY.find((hook) => hook.category === resolved.hook_category)
    || HOOK_LIBRARY[0];

  hookText3s = hookText3s || scenesList[0]?.hook_text_3s || fallbackHook.hook_text_3s;
  hookType = hookType || scenesList[0]?.hook_type || fallbackHook.archetype;
  retentionPromise = retentionPromise || scenesList[0]?.retention_promise || fallbackHook.retention_promise;
  shareTrigger = shareTrigger || scenesList[0]?.share_trigger || fallbackHook.share_trigger;
  ctaMode = ctaMode || scenesList[scenesList.length - 1]?.cta_mode || resolved.cta_mode;
  subjectMode = subjectMode || scenesList[0]?.subject_mode || resolved.subject_mode;

  const firstScene = scenesList[0];
  firstScene.hook_type = firstScene.hook_type || hookType;
  firstScene.hook_text_3s = firstScene.hook_text_3s || hookText3s;
  firstScene.retention_promise = firstScene.retention_promise || retentionPromise;
  firstScene.share_trigger = firstScene.share_trigger || shareTrigger;
  firstScene.subject_mode = firstScene.subject_mode || subjectMode;

  const lastScene = scenesList[scenesList.length - 1];
  lastScene.cta_mode = lastScene.cta_mode || ctaMode;

  return {
    thinking: thinkingCollected.trim() || undefined,
    product_identified: productIdentified,
    product_slug: productSlug,
    product_category: productCategory,
    platform_preset: platformPreset || undefined,
    hook_type: hookType || undefined,
    hook_text_3s: hookText3s || undefined,
    retention_promise: retentionPromise || undefined,
    share_trigger: shareTrigger || undefined,
    cta_mode: ctaMode || undefined,
    subject_mode: subjectMode || undefined,
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

function omniGenerationDuration(planned: number): 4 | 6 | 8 | 10 {
  if (planned <= 4) return 4;
  if (planned <= 6) return 6;
  if (planned <= 8) return 8;
  return 10;
}

async function clipHasAudioTrack(file: string): Promise<boolean> {
  try {
    const { stdout } = await run(findFfprobe(), ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file]);
    const data = JSON.parse(stdout) as { streams?: Array<{ codec_type: string }> };
    return Boolean(data.streams?.some((st) => st.codec_type === "audio"));
  } catch {
    return false;
  }
}

interface StitchOptions {
  contentClips: string[];
  contentDurations: number[];
  outputPath: string;
  totalDuration: number;
  endcardPath?: string;
  endcardDuration?: number;
  tailPad?: number;
}

// Content clips are trimmed to the resolver's planned durations and joined with
// 0.5s crossfades. The static end-card is concatenated after the content with no
// crossfade, then the mux is capped at the requested total duration.
async function stitchFinalVideo(o: StitchOptions): Promise<void> {
  if (o.contentClips.length === 0) throw new Error("Tidak ada klip konten untuk digabungkan.");
  const transition = o.contentClips.length > 1 ? TRANSITION_SECONDS : 0;
  const tailPad = Math.max(0, o.tailPad ?? 0);
  const endcardDuration = Math.max(0, o.endcardDuration ?? 0);
  const hasAudio = await Promise.all(o.contentClips.map((clip) => clipHasAudioTrack(clip)));

  let vFilter = "";
  let aFilter = "";

  o.contentClips.forEach((_, i) => {
    const dur = Math.max(0.1, o.contentDurations[i] ?? 10);
    const isLast = i === o.contentClips.length - 1;
    const tail = isLast && tailPad > 0 ? `,tpad=stop_mode=clone:stop_duration=${tailPad.toFixed(3)}` : "";
    const audioTail = isLast && tailPad > 0 ? `,apad=pad_dur=${tailPad.toFixed(3)}` : "";
    vFilter += `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS${tail},format=yuv420p[sc${i}];`;
    aFilter += hasAudio[i]
      ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS${audioTail}[aud${i}];`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${dur.toFixed(3)}${audioTail}[aud${i}];`;
  });

  let lastV = "sc0";
  let lastA = "aud0";
  let offset = Math.max(0, (o.contentDurations[0] ?? 10) - transition);

  for (let i = 1; i < o.contentClips.length; i++) {
    const nextV = `v${i}`;
    const nextA = `a${i}`;
    vFilter += `[${lastV}][sc${i}]xfade=transition=fade:duration=${transition}:offset=${Math.max(0, offset).toFixed(3)}[${nextV}];`;
    aFilter += `[${lastA}][aud${i}]acrossfade=d=${transition}[${nextA}];`;
    lastV = nextV;
    lastA = nextA;
    offset += (o.contentDurations[i] ?? 10) - transition;
  }

  let videoOut = lastV;
  let audioOut = lastA;

  if (o.endcardPath && endcardDuration > 0) {
    const endcardInput = o.contentClips.length;
    vFilter += `[${endcardInput}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=${endcardDuration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[vend];`;
    aFilter += `anullsrc=r=48000:cl=stereo,atrim=duration=${endcardDuration.toFixed(3)}[aend];`;
    vFilter += `[${lastV}][vend]concat=n=2:v=1:a=0[vout];`;
    aFilter += `[${lastA}][aend]concat=n=2:v=0:a=1[aout];`;
    videoOut = "vout";
    audioOut = "aout";
  }

  const args = ["-y"];
  for (const clip of o.contentClips) args.push("-i", clip);
  if (o.endcardPath) args.push("-i", o.endcardPath);
  args.push(
    "-filter_complex", `${vFilter}${aFilter}`,
    "-map", `[${videoOut}]`,
    "-map", `[${audioOut}]`,
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-t", o.totalDuration.toFixed(3),
    o.outputPath
  );

  await run(findFfmpeg(), args);
}

async function runPipelineAsync(
  core: Core,
  body: PipelineRequestBody,
  preResolved?: ResolvedPlatformConfig
): Promise<void> {
  const resolved = preResolved ?? resolveRequestConfig(body);
  const isVeo = /veo/i.test(resolved.video_model);
  const duration = resolved.duration_target;
  const clipsCount = resolved.clips_count;
  const clipDurations = resolved.clip_durations;
  const videoModel = resolved.video_model;
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
  activePipeline.cancelled = false;
  activePipeline.duration = duration;
  activePipeline.clips_count = clipsCount;
  activePipeline.current_scene = 0;
  activePipeline.product_file = primaryFile;
  activePipeline.error = undefined;
  activePipeline.video_model = videoModel;
  activePipeline.platform_preset = resolved.platform;
  const jobId = randomBytes(8).toString("hex");
  activePipeline.job_id = jobId;
  activePipeline.logs = [
    `[${new Date().toLocaleTimeString()}] [Job ${jobId}] Memulai generate video ${duration}s (${clipsCount} klip @ ${clipDurations.map((d) => `${d}s`).join("+")}${resolved.endcard_seconds > 0 ? ` + end-card ${resolved.endcard_seconds}s` : ""}, ${images.length} gambar referensi, preset: ${activePipeline.platform_preset}, model: ${activePipeline.video_model}) untuk ${images.map((i) => i.file).join(", ")}`
  ];

  isPipelineCancelled = false;
  currentRunningJobId = null;

  try {
    const creditCalc = calculatePipelineCredits(body, resolved);
    const flowState = await getFlowState().catch(() => null);
    if (flowState?.credits_remaining !== undefined && flowState.credits_remaining < creditCalc.total_required) {
      const msg = `Saldo kredit Flow (${flowState.credits_remaining}) tidak mencukupi untuk kebutuhan pipeline (${creditCalc.total_required} kredit).`;
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`);
      activePipeline.status_text = "Gagal: Kredit Flow tidak cukup";
      activePipeline.error = msg;
      activePipeline.running = false;
      throw new Error(`INSUFFICIENT_CREDITS: ${msg}`);
    }

    const downloadedClips: string[] = [];
    const downloadedClipDurations: number[] = [];
    let endCardPath: string | undefined;
    let endCardDuration = 0;
    let scenes = body.scenes;
    let characterAnchor = String(body.character_anchor || "");
    let settingAnchor = String(body.setting_anchor || "");
    const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");
    let voiceoverPersona = String(body.voiceover_persona || `Warm, natural narrator speaking ${voiceLanguage}`);
    let pipelineStyle = String(body.style || "cinematic");

    let draft: ScriptResult | null = null;
    if (!Array.isArray(scenes) || scenes.length < clipsCount) {
      activePipeline.status_text = "Menyusun naskah & storyboard otomatis via AI...";
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Menyusun naskah otomatis (${clipsCount} scene)...`);
      draft = await generateScriptWithLLM(body, undefined, undefined, resolved);
      scenes = draft.scenes;
      characterAnchor = characterAnchor || draft.character_anchor;
      settingAnchor = settingAnchor || draft.setting_anchor;
      if (draft.voiceover_persona) voiceoverPersona = draft.voiceover_persona;
      if (draft.style) pipelineStyle = draft.style;
    }

    const scenesToRun = scenes.slice(0, clipsCount);
    activePipeline.scene_statuses = scenesToRun.map((sc, idx) => ({
      scene_num: idx + 1,
      title: sc.title || `Scene ${idx + 1}`,
      status: "pending" as const,
    }));
    // Storyline overview uses ONLY scene titles so Flow Omni doesn't speak or render other scenes' scripts
    const storylineOverview = scenesToRun
      .map((sc) => `- Scene ${sc.num} (${sc.time}): ${sc.title}`)
      .join("\n");

    for (let i = 0; i < clipsCount; i++) {
      const s = scenesToRun[i];
      const sceneNum = i + 1;
      if (activePipeline.scene_statuses?.[i]) {
        activePipeline.scene_statuses[i].status = "generating";
      }
      const plannedClipDuration = clipDurations[i] ?? s.duration ?? 10;
      const generationDuration = isVeo ? 8 : omniGenerationDuration(plannedClipDuration);

      activePipeline.current_scene = sceneNum;
      activePipeline.status_text = `Generating Scene ${sceneNum}/${clipsCount}: ${s.title || ""}`;

      // Continuity chaining: extract last frame of previous scene as start frame of current scene
      let previousLastFrame: string | undefined = undefined;
      if (downloadedClips.length > 0) {
        const lastClip = downloadedClips[downloadedClips.length - 1];
        try {
          previousLastFrame = await extractLastFrame(lastClip);
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] 🔗 Continuity frame diekstrak dari Scene ${sceneNum - 1} untuk transisi mulus`
          );
        } catch (chainErr) {
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] ⚠️ Ekstraksi continuity frame dilewati (${(chainErr as Error).message})`
          );
        }
      }

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
        `[${new Date().toLocaleTimeString()}] Scene ${sceneNum}/${clipsCount} (generate ${generationDuration}s → trim ${plannedClipDuration}s, ${finalSceneRefs.length} ref img${previousLastFrame ? " + continuity start frame" : ""}) dikirim ke Google Flow [${videoModel}]`
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
Maintain 100% strict visual consistency for all characters/mascots/subjects and exact same vocal persona and pace across all shots. The voice must match the on-screen character's gender and age. Movements and object interactions must flow naturally, with no objects appearing, vanishing, or changing abruptly.`;

      if (isPipelineCancelled) {
        throw new Error("Generasi video dibatalkan oleh pengguna.");
      }

      const sceneVariants = i === 0 ? Math.max(1, Math.min(4, body.scene1_variants ?? body.variants ?? 1)) : 1;
      const unitCost = getVideoModelCost(videoModel, plannedClipDuration);
      const dynamicMaxCredits = (unitCost * sceneVariants) + 15;

      const genRes = (await (core.generate as unknown as (args: unknown) => Promise<GenResult>)({
        project: projectFolder,
        scenes: [
          {
            prompt: hierarchicalPrompt,
            type: "video",
            model: videoModel,
            aspect_ratio: "9:16",
            duration: generationDuration,
            resolution: isVeo ? undefined : "720p",
            max_credits: dynamicMaxCredits,
            variants: sceneVariants,
            reference_images: finalSceneRefs.length > 0 ? finalSceneRefs : undefined,
            download_quality: "upscaled",
            first_frame: previousLastFrame
          }
        ]
      }));

      const job = genRes.jobs[0];
      currentRunningJobId = job.id;
      let completed = false;
      let clipFile: string | null = null;
      let candidateFiles: string[] = [];

      while (!completed) {
        if (isPipelineCancelled) {
          if (job?.id) {
            try {
              await (core.cancel as unknown as (args: unknown) => Promise<unknown>)({ job_id: job.id });
            } catch {}
          }
          throw new Error("Generasi video dibatalkan oleh pengguna.");
        }

        const waitRes = (await (core.wait as unknown as (args: unknown) => Promise<WaitResult>)({ job_ids: [job.id], timeout_seconds: 4 }));
        const current = waitRes.jobs.find((j) => j.id === job.id);
        if (current) {
          if (current.status === "done" && current.files?.length) {
            candidateFiles = current.files;
            clipFile = current.files[0];
            completed = true;
          } else if (current.status === "failed") {
            const sceneLabel = `scene-${String(sceneNum).padStart(2, "0")}`;
            const dl = (await (core.download as unknown as (args: unknown) => Promise<{ files: string[] }>)({
              project: projectFolder,
              assets: [`${projectFolder}-${sceneLabel}`],
              quality: "upscaled"
            }).catch(() => null));
            if (dl?.files?.length) {
              candidateFiles = dl.files;
              clipFile = dl.files[0];
              completed = true;
            } else {
              throw new Error(current.error || `Gagal generate scene ${sceneNum}`);
            }
          }
        }
        if (!completed) {
          for (let w = 0; w < 6; w++) {
            if (isPipelineCancelled) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      currentRunningJobId = null;

      if (clipFile && existsSync(clipFile)) {
        downloadedClips.push(clipFile);
        downloadedClipDurations.push(plannedClipDuration);
        if (activePipeline.scene_statuses?.[i]) {
          activePipeline.scene_statuses[i].status = "done";
          activePipeline.scene_statuses[i].clip_file = clipFile;
          activePipeline.scene_statuses[i].duration = plannedClipDuration;
          activePipeline.scene_statuses[i].variants_count = candidateFiles.length || sceneVariants;
          activePipeline.scene_statuses[i].variant_files = candidateFiles.length ? candidateFiles : [clipFile];
        }
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Scene ${sceneNum} selesai: ${basename(clipFile)} (trim ${plannedClipDuration}s${sceneVariants > 1 ? `, ${candidateFiles.length || sceneVariants} kandidat varian` : ""})`);
      } else {
        if (activePipeline.scene_statuses?.[i]) {
          activePipeline.scene_statuses[i].status = "failed";
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Static Product End-Card (Zero-text-in-AI, 100% brand/packaging faithful)
    if (resolved.endcard_seconds > 0) {
      const productMainImage = images.find((im) => im.role === "product_main" && existsSync(join(PRODUCT_DIR, im.file)));
      const endCardSource = (productMainImage ? join(PRODUCT_DIR, productMainImage.file) : undefined)
        || imageIdToPath.get("img1")
        || visualFallbackPaths[0];
      if (endCardSource) {
        const endCardFile = join(OUTPUT_DIR, `endcard_${jobId}.mp4`);
        try {
          activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🏷️ Membuat Static Product End-Card ${resolved.endcard_seconds}s (zoompan foto produk asli)...`);
          await createProductEndCard(endCardSource, endCardFile, resolved.endcard_seconds);
          endCardPath = endCardFile;
          endCardDuration = resolved.endcard_seconds;
          activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ✅ End-Card ${resolved.endcard_seconds}s siap digabungkan.`);
        } catch (endErr) {
          activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ End-Card dilewati (${(endErr as Error).message}). Durasi final akan lebih pendek ${resolved.endcard_seconds}s dari target.`);
        }
      } else {
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ End-Card dilewati: tidak ada foto produk utama yang bisa dipakai.`);
      }
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
    activePipeline.status_text = "Menggabungkan klip video (upscale FFmpeg 1080x1920)...";
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🎞️ Menggabungkan ${downloadedClips.length} klip konten + ${endCardPath ? `end-card ${endCardDuration}s ` : "tanpa end-card "}(${outputFilename}) dengan transisi crossfade, trim presisi, upscale FFmpeg 1080x1920 (sumber Flow 720p)...`);
    await stitchFinalVideo({
      contentClips: downloadedClips,
      contentDurations: downloadedClipDurations,
      endcardPath: endCardPath,
      endcardDuration: endCardDuration,
      tailPad: resolved.tail_pad,
      totalDuration: duration,
      outputPath: finalVideoPath,
    });

    // Probe duration_actual
    let durationActual = duration;
    try {
      const { stdout } = await run(findFfprobe(), [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        finalVideoPath
      ]);
      const probeData = JSON.parse(stdout) as { format?: { duration?: string } };
      if (probeData.format?.duration) {
        durationActual = parseFloat(probeData.format.duration);
      }
    } catch {}
    activePipeline.duration_actual = durationActual;

    // Write sidecar lineage .meta.json
    const metaPath = join(OUTPUT_DIR, `${basename(outputFilename, ".mp4")}.meta.json`);
    const sidecarMetadata = {
      job_id: jobId,
      created_at: new Date().toISOString(),
      output_filename: outputFilename,
      product_slug: productSlug,
      product_identified: rawProductBrand,
      platform_preset: resolved.platform,
      video_model: videoModel,
      model_tier: videoModel,
      variants_count: body.scene1_variants ?? body.variants ?? 1,
      credits_spent: creditCalc.total_required,
      hook_type: body.hook_type || draft?.hook_type || scenesToRun[0]?.hook_type || "N/A",
      hook_text_3s: body.hook_text_3s || draft?.hook_text_3s || scenesToRun[0]?.hook_text_3s || "N/A",
      retention_promise: body.retention_promise || draft?.retention_promise || scenesToRun[0]?.retention_promise || "N/A",
      share_trigger: body.share_trigger || draft?.share_trigger || scenesToRun[0]?.share_trigger || "N/A",
      cta_mode: body.cta_mode || draft?.cta_mode || scenesToRun[scenesToRun.length - 1]?.cta_mode || resolved.cta_mode,
      subject_mode: body.subject_mode || draft?.subject_mode || scenesToRun[0]?.subject_mode || resolved.subject_mode,
      duration_target: duration,
      duration_actual: Number(durationActual.toFixed(2)),
      clip_total: resolved.clip_total,
      tail_pad: resolved.tail_pad,
      endcard_seconds: endCardDuration,
      clips_count: downloadedClips.length,
      scene_statuses: activePipeline.scene_statuses,
    };
    writeFileSync(metaPath, JSON.stringify(sidecarMetadata, null, 2), "utf-8");
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 📋 Lineage metadata tersimpan: ${basename(metaPath)}`);

    activePipeline.status_text = "Selesai";
    activePipeline.last_video = outputFilename;
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 Video final berhasil dirakit (${durationActual.toFixed(1)}s): ${outputFilename}`);
  } catch (err: unknown) {
    if (isPipelineCancelled) {
      activePipeline.status_text = "Dibatalkan";
      activePipeline.cancelled = true;
      activePipeline.error = "Generasi video dibatalkan oleh pengguna.";
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Generasi video berhasil dibatalkan.`);
    } else {
      activePipeline.status_text = "Error";
      activePipeline.error = err instanceof Error ? err.message : String(err);
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error: ${activePipeline.error}`);
    }
  } finally {
    activePipeline.running = false;
    currentRunningJobId = null;
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
        const distPath = resolve(join(dirname(fileURLToPath(import.meta.url)), "../../ui/dist/index.html"));
        const content = existsSync(distPath) ? readFileSync(distPath, "utf-8") : EMBEDDED_STUDIO_HTML;
        return res.end(content.replace("__FLOW_TOKEN__", token));
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
          hooks: HOOK_LIBRARY,
          models: SUPPORTED_VIDEO_MODELS,
        });
      }

      // Platform Preset Resolver API
      if (req.method === "POST" && url.pathname === "/api/platform/resolve") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as Partial<ScriptRequestBody> & {
          platform?: PlatformPreset;
          duration?: number;
        };
        try {
          const platform = body.platform || body.platform_preset || "custom";
          const isCustom = platform === "custom";
          const resolved = resolvePlatformPreset(platform, {
            video_model: body.video_model,
            duration_target: body.duration,
            style_id: isCustom ? body.style_id : undefined,
            tone_id: isCustom ? body.tone_id : undefined,
            preset_id: body.preset_id as "free" | "health_softsell" | "general_commercial" | undefined,
            subject_mode: isCustom ? body.subject_mode : undefined,
            cta_mode: isCustom ? (body.cta_mode as ResolvedPlatformConfig["cta_mode"] | undefined) : undefined,
            enable_endcard: body.enable_endcard !== false,
            hook_archetype: body.hook_archetype,
          });
          return json(res, 200, { success: true, ...resolved });
        } catch (err) {
          if (err instanceof PlatformPresetError) {
            return json(res, 400, { success: false, error: err.message, code: err.code, allowed_durations: err.allowed_durations });
          }
          throw err;
        }
      }

      // Preview assembled system prompt
      if (req.method === "POST" && url.pathname === "/api/llm/preview-prompt") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as ScriptRequestBody;
        let resolved: ResolvedPlatformConfig;
        try {
          resolved = resolveRequestConfig(body);
        } catch (err) {
          if (err instanceof PlatformPresetError) {
            return json(res, 400, { success: false, error: err.message, code: err.code, allowed_durations: err.allowed_durations });
          }
          throw err;
        }
        const images = normalizeImageAttachments(body);
        const sysPrompt = buildLayeredSystemPrompt({
          duration: resolved.duration_target,
          clipsDuration: resolved.clip_total,
          endcardSeconds: resolved.endcard_seconds,
          clipsCount: resolved.clips_count,
          clipDurations: resolved.clip_durations,
          presetId: resolved.preset_id,
          platformPreset: resolved.platform,
          styleId: resolved.style_id,
          toneId: resolved.tone_id,
          ctaMode: resolved.cta_mode,
          subjectMode: resolved.subject_mode,
          hookCategory: resolved.hook_category,
          hookArchetype: resolved.hook_archetype,
          voiceLanguage: body.voice_language || "Bahasa Indonesia",
          userPrompt: body.prompt,
          images: images.length > 0 ? images : [{ file: "product.jpg", role: "product_main" }],
        });
        return json(res, 200, { success: true, system_prompt: sysPrompt, resolved });
      }

      // LLM Script Generation
      if (req.method === "POST" && url.pathname === "/api/llm/generate-script") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as ScriptRequestBody;
        let resolved: ResolvedPlatformConfig;
        try {
          resolved = resolveRequestConfig(body);
        } catch (err) {
          if (err instanceof PlatformPresetError) {
            return json(res, 400, { success: false, error: err.message, code: err.code, allowed_durations: err.allowed_durations });
          }
          throw err;
        }
        const wantsStream = body.stream === true || (req.headers.accept || "").includes("text/event-stream");

        if (wantsStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Range, Authorization, x-flow-token",
          });
          if (typeof res.flushHeaders === "function") res.flushHeaders();

          const clientAbort = new AbortController();
          req.on("close", () => {
            clientAbort.abort();
          });

          try {
            const result = await generateScriptWithLLM(
              body,
              (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
                if (typeof (res as any).flush === "function") (res as any).flush();
              },
              clientAbort.signal,
              resolved
            );
            res.write(`data: ${JSON.stringify({ type: "done", script: result })}\n\n`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
          } finally {
            res.end();
          }
          return;
        }

        const result = await generateScriptWithLLM(body, undefined, undefined, resolved);
        return json(res, 200, { success: true, ...result });
      }

      // Pre-flight Credit Check API
      if (req.method === "POST" && url.pathname === "/api/pipeline/check-credits") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as PipelineRequestBody & {
          clips_count?: number;
          duration?: number;
          scenes_count?: number;
        };
        let resolved: ResolvedPlatformConfig | undefined;
        try {
          resolved = resolveRequestConfig(body);
        } catch {}
        const creditCalc = calculatePipelineCredits(body, resolved);
        const state = await getFlowState(true).catch(() => getFlowState());
        const available = state.credits_remaining;
        if (available !== undefined && available < creditCalc.total_required) {
          const shortage = creditCalc.total_required - available;
          return json(res, 400, {
            error: "INSUFFICIENT_CREDITS",
            code: "INSUFFICIENT_CREDITS",
            required: creditCalc.total_required,
            available,
            shortage,
            unit_cost: creditCalc.unit_cost,
            clips_count: creditCalc.clips_count,
            scene1_variants: creditCalc.scene1_variants,
            video_model: creditCalc.video_model,
            message: `Kredit Flow tidak cukup. Dibutuhkan ${creditCalc.total_required} kredit, tersedia ${available} kredit.`,
          });
        }
        return json(res, 200, {
          success: true,
          sufficient: true,
          required: creditCalc.total_required,
          available: available ?? null,
          unit_cost: creditCalc.unit_cost,
          clips_count: creditCalc.clips_count,
          scene1_variants: creditCalc.scene1_variants,
          video_model: creditCalc.video_model,
        });
      }

      // Pipeline Supported Video Models API
      if (req.method === "GET" && url.pathname === "/api/pipeline/models") {
        return json(res, 200, {
          success: true,
          models: SUPPORTED_VIDEO_MODELS,
        });
      }

      // Pipeline Generation Trigger
      if (req.method === "POST" && url.pathname === "/api/pipeline/generate") {
        if (activePipeline.running) return json(res, 409, { error: "A video generation pipeline is already running." });
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as PipelineRequestBody;
        let resolved: ResolvedPlatformConfig;
        try {
          resolved = resolveRequestConfig(body);
        } catch (err) {
          if (err instanceof PlatformPresetError) {
            return json(res, 400, { success: false, error: err.message, code: err.code, allowed_durations: err.allowed_durations });
          }
          throw err;
        }

        const creditCalc = calculatePipelineCredits(body, resolved);
        const state = await getFlowState(true).catch(() => getFlowState());
        if (state.credits_remaining !== undefined && state.credits_remaining < creditCalc.total_required) {
          const shortage = creditCalc.total_required - state.credits_remaining;
          return json(res, 400, {
            error: "INSUFFICIENT_CREDITS",
            code: "INSUFFICIENT_CREDITS",
            required: creditCalc.total_required,
            available: state.credits_remaining,
            shortage,
            unit_cost: creditCalc.unit_cost,
            clips_count: creditCalc.clips_count,
            scene1_variants: creditCalc.scene1_variants,
            video_model: creditCalc.video_model,
            message: `Kredit Flow tidak cukup. Dibutuhkan ${creditCalc.total_required} kredit, tersedia ${state.credits_remaining} kredit.`,
          });
        }

        void runPipelineAsync(core, body, resolved);
        return json(res, 200, {
          success: true,
          resolved,
          pipeline: activePipeline,
          credit_check: {
            required: creditCalc.total_required,
            available: state.credits_remaining,
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/pipeline/status") {
        return json(res, 200, { pipeline: activePipeline });
      }

      // Pipeline Cancellation Trigger
      if (req.method === "POST" && url.pathname === "/api/pipeline/cancel") {
        isPipelineCancelled = true;
        activePipeline.status_text = "Dibatalkan";
        activePipeline.cancelled = true;
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Permintaan pembatalan diterima.`);
        if (currentRunningJobId) {
          try {
            await (core.cancel as unknown as (args: unknown) => Promise<unknown>)({ job_id: currentRunningJobId });
          } catch {}
        }
        return json(res, 200, { success: true, message: "Pipeline cancelled", pipeline: activePipeline });
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
