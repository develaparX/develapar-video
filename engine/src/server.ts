import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import {
  FLOW_HOSTS,
  FLOW_URL,
  HOME_DIR,
  bringChromeToFront,
  captureBrowserStorageState,
  engineLog,
  ensureChromeForProfile,
  getBrowser,
  inEnglish,
  isChromeRunning,
  runningProfileDir,
  setProfileDir,
  shutdownChrome,
} from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { flowLockOwner, tryFlowLock, withFlowLock } from "./flowlock.js";
import { probeSession } from "./session.js";
import { chooseSaveVideoPath, findFfmpeg, findFfprobe, getProductDir, getOutputDir, getEndcardDir, getDevideoBaseDir, openDirectory } from "./platform.js";
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
  estimateBatchPipeline,
  type BatchPipelineEstimate,
  type SupportedVideoModel,
  type PipelineCreditCalculation,
} from "./presets.js";
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  getJobCheckpointDir,
  getCreditPoolSummary,
  findAccountForCredits,
  getActiveBatch,
  setActiveBatch,
  updateBatchItem,
  appendBatchLog,
  type PipelineCheckpoint,
  type BatchPipelineState,
  type BatchItemState,
} from "./batch.js";
import { getFlowState, runFlowAgentScript, chatWithFlowAgent, compileScriptViaFlowAgent, resetFlowAgentSession } from "./flow.js";
import {
  PROFILES_BASE_DIR,
  createAccount,
  deleteAccount,
  ensureActiveAccountReady,
  getActiveAccount,
  getActiveProfileDir,
  isMockMode,
  listAccounts,
  loadAccountsRegistry,
  nextAccountLabel,
  normalizeAccount,
  refreshAccountCredits,
  renameAccount,
  saveAccountsRegistry,
  switchAccount,
  updateActiveAccountState,
  type FlowAccount,
} from "./accounts.js";

const run = promisify(execFile);
const PRODUCT_DIR = getProductDir();
const OUTPUT_DIR = getOutputDir();
const ENDCARD_DIR = getEndcardDir();
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
  script_mode?: "custom_api" | "flow_agent";
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

export interface BatchPipelineRequestBody extends PipelineRequestBody {
  batch_count?: number;
  batch_mode?: "variations" | "series";
  auto_skip?: boolean;
  auto_retry_end?: boolean;
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
  resolvedConfig?: ResolvedPlatformConfig,
  scriptSource: "llm" | "flow_agent" = "llm"
): Promise<ScriptResult> {
  const source = body.script_mode === "flow_agent" ? "flow_agent" : (body.script_mode === "custom_api" ? "llm" : scriptSource);
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

  if (source === "llm" && !apiKey) {
    throw new Error("API Key LLM belum diisi. Masukkan API Key Anda di panel 'Brief kreatif' atau pilih mode 'Flow Agent Native (Gratis)'.");
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

  let resp: Response | undefined;
  let raw = "";
  let thinkingCollected = "";
  let isStreaming = false;
  if (source === "flow_agent") {
    onEvent?.({ type: "status", text: "Menyiapkan brief terstruktur ke Flow Agent (Zero API Key)..." });
    const firstProduct = body.product_files?.[0];
    const productHint = body.product_file || (typeof firstProduct === "string" ? firstProduct : firstProduct?.file);
    const agentText = await runFlowAgentScript({
      duration,
      clipsCount,
      userPrompt: body.prompt,
      productHint,
      voiceLanguage,
      platformPreset: resolved.platform,
      endcardSeconds: resolved.endcard_seconds,
    });
    raw = agentText.trim();
    thinkingCollected = "";
    if (!raw) throw new Error("Flow Agent mengembalikan respons kosong; naskah tidak bisa disusun.");
  } else {
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

    if (!resp || !resp.ok) {
      clearTimeout(timeoutId);
      const errText = await resp.text().catch(() => "");
      throw new Error(`LLM API gagal (${resp.status}): ${errText || resp.statusText}`);
    }

    isStreaming = wantsStream && Boolean(resp?.body && typeof resp.body.getReader === "function");
  }

  if (source !== "flow_agent") {
    if (isStreaming) {
      const reader = resp!.body!.getReader();
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
      const rawText = await resp!.text();
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

async function generateBatchScriptsWithLLM(
  body: ScriptRequestBody,
  batchCount: number,
  batchMode: "variations" | "series",
  onEvent?: (event: StreamEvent) => void,
  abortSignal?: AbortSignal,
  resolvedConfig?: ResolvedPlatformConfig
): Promise<ScriptResult[]> {
  const resolved = resolvedConfig ?? resolveRequestConfig(body);
  if (batchCount <= 1) {
    const single = await generateScriptWithLLM(body, onEvent, abortSignal, resolved);
    return [single];
  }

  // Generate the first anchor script using the comprehensive model/vision call
  onEvent?.({ type: "status", text: `Menyusun naskah anchor untuk ${batchCount} video batch...` });
  const baseScript = await generateScriptWithLLM(body, onEvent, abortSignal, resolved);
  const results: ScriptResult[] = [baseScript];

  const hookArchetypes: HookArchetype[] = [
    "problem_agitator",
    "shock_counterintuitive",
    "price_drop_deal",
    "relatable_pov",
    "sensory_curiosity",
  ];

  for (let i = 1; i < batchCount; i++) {
    const hookArch = hookArchetypes[(i - 1) % hookArchetypes.length];
    const hookTpl = HOOK_LIBRARY.find((h) => h.archetype === hookArch);
    const clonedScenes = baseScript.scenes.map((s, idx) => {
      let sceneTitle = s.title;
      let scenePrompt = s.prompt;
      let sceneScript = s.script;

      if (batchMode === "series") {
        sceneTitle = `[Part ${i + 1}] Scene ${idx + 1}: ${s.title.replace(/^\[Part \d+\]\s*/i, "")}`;
      } else {
        sceneTitle = `[Variasi ${i + 1}] Scene ${idx + 1}: ${s.title.replace(/^\[Variasi \d+[^\]]*\]\s*/i, "")}`;
        if (idx === 0 && hookTpl) {
          sceneScript = `${hookTpl.hook_text_3s} ${s.script}`;
        }
      }

      return {
        ...s,
        title: sceneTitle,
        prompt: scenePrompt,
        script: sceneScript,
      };
    });

    results.push({
      ...baseScript,
      hook_type: hookArch,
      hook_text_3s: hookTpl?.hook_text_3s || baseScript.hook_text_3s,
      retention_promise: hookTpl?.retention_promise || baseScript.retention_promise,
      share_trigger: hookTpl?.share_trigger || baseScript.share_trigger,
      scenes: clonedScenes,
    });
  }

  return results;
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
  preResolved?: ResolvedPlatformConfig,
  opts?: {
    batchId?: string;
    videoIndex?: number;
    totalVideos?: number;
    autoSkip?: boolean;
    resumeJobId?: string;
    existingJobId?: string;
  }
): Promise<{ success: boolean; skipped?: boolean; paused?: boolean; last_video?: string; jobId?: string; failed_scene?: number; error?: string }> {
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
  const jobId = opts?.resumeJobId || opts?.existingJobId || randomBytes(8).toString("hex");
  activePipeline.job_id = jobId;
  activePipeline.logs = [
    `[${new Date().toLocaleTimeString()}] [Job ${jobId}] Memulai generate video ${duration}s (${clipsCount} klip @ ${clipDurations.map((d) => `${d}s`).join("+")}${resolved.endcard_seconds > 0 ? ` + end-card ${resolved.endcard_seconds}s` : ""}, ${images.length} gambar referensi, preset: ${activePipeline.platform_preset}, model: ${activePipeline.video_model}) untuk ${images.map((i) => i.file).join(", ")}`
  ];

  isPipelineCancelled = false;
  currentRunningJobId = null;

  try {
    return await withFlowLock("pipeline", async () => {
    await ensureActiveAccountReady();
    const creditCalc = calculatePipelineCredits(body, resolved);
    const flowState = await getFlowState().catch(() => null);
    const pool = getCreditPoolSummary();
    if (flowState?.credits_remaining !== undefined && flowState.credits_remaining < creditCalc.total_required) {
      if (pool.total_pool_credits >= creditCalc.total_required) {
        activePipeline.logs.push(
          `[${new Date().toLocaleTimeString()}] 💡 Saldo akun aktif (${flowState.credits_remaining} cr) kurang dari target (${creditCalc.total_required} cr), namun pool kredit akun (${pool.total_pool_credits} cr) mencukupi. Auto-switch akun akan aktif jika diperlukan.`
        );
      } else {
        const msg = `Saldo kredit Flow (akun aktif: ${flowState.credits_remaining}, total pool: ${pool.total_pool_credits}) tidak mencukupi untuk kebutuhan pipeline (${creditCalc.total_required} kredit).`;
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`);
        activePipeline.status_text = "Gagal: Kredit Flow tidak cukup";
        activePipeline.error = msg;
        activePipeline.running = false;
        throw new Error(`INSUFFICIENT_CREDITS: ${msg}`);
      }
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

    // Checkpoint restoration check
    let resumedCheckpoint: PipelineCheckpoint | null = null;
    if (opts?.resumeJobId) {
      resumedCheckpoint = loadCheckpoint(opts.resumeJobId);
    }
    if (resumedCheckpoint && resumedCheckpoint.completed_clips.length > 0) {
      for (let c = 0; c < resumedCheckpoint.completed_clips.length; c++) {
        if (existsSync(resumedCheckpoint.completed_clips[c])) {
          downloadedClips.push(resumedCheckpoint.completed_clips[c]);
          downloadedClipDurations.push(resumedCheckpoint.completed_durations[c] || clipDurations[c] || 10);
        }
      }
      activePipeline.logs.push(
        `[${new Date().toLocaleTimeString()}] ♻️ Melanjutkan job ${jobId}: ${downloadedClips.length} klip sudah ada di disk. Melanjutkan dari Scene ${downloadedClips.length + 1}/${clipsCount}...`
      );
    }
    const startIndex = downloadedClips.length;

    activePipeline.scene_statuses = scenesToRun.map((sc, idx) => {
      const isDone = idx < startIndex;
      return {
        scene_num: idx + 1,
        title: sc.title || `Scene ${idx + 1}`,
        status: isDone ? ("done" as const) : ("pending" as const),
        clip_file: isDone ? downloadedClips[idx] : undefined,
        duration: isDone ? downloadedClipDurations[idx] : undefined,
      };
    });

    const storylineOverview = scenesToRun
      .map((sc) => `- Scene ${sc.num} (${sc.time}): ${sc.title}`)
      .join("\n");

    const MAX_SCENE_ATTEMPTS = 3;

    for (let i = startIndex; i < clipsCount; i++) {
      const s = scenesToRun[i];
      const sceneNum = i + 1;
      if (activePipeline.scene_statuses?.[i]) {
        activePipeline.scene_statuses[i].status = "generating";
      }
      const plannedClipDuration = clipDurations[i] ?? s.duration ?? 10;
      const generationDuration = isVeo ? 8 : omniGenerationDuration(plannedClipDuration);

      activePipeline.current_scene = sceneNum;
      activePipeline.status_text = `Generating Scene ${sceneNum}/${clipsCount}: ${s.title || ""}`;

      let sceneSuccess = false;
      let sceneError: Error | null = null;
      let clipFile: string | null = null;
      let candidateFiles: string[] = [];

      for (let attempt = 1; attempt <= MAX_SCENE_ATTEMPTS; attempt++) {
        try {
          if (isPipelineCancelled) {
            throw new Error("Generasi video dibatalkan oleh pengguna.");
          }
          if (attempt > 1) {
            activePipeline.logs.push(
              `[${new Date().toLocaleTimeString()}] 🔄 Mencoba ulang Scene ${sceneNum}/${clipsCount} (Percobaan ${attempt}/${MAX_SCENE_ATTEMPTS})...`
            );
            await new Promise((r) => setTimeout(r, 2500));
          }

          const sceneVariants = i === 0 ? Math.max(1, Math.min(4, body.scene1_variants ?? body.variants ?? 1)) : 1;
          const unitCost = getVideoModelCost(videoModel, plannedClipDuration);
          const dynamicMaxCredits = (unitCost * sceneVariants) + 15;

          // Smart Credit Pooling & Auto Account Switch
          const currentAcc = getActiveAccount();
          if (currentAcc && typeof currentAcc.credits === "number" && currentAcc.credits < dynamicMaxCredits) {
            const candidate = findAccountForCredits(dynamicMaxCredits, currentAcc.id);
            if (candidate) {
              activePipeline.logs.push(
                `[${new Date().toLocaleTimeString()}] 🔄 Kredit akun aktif "${currentAcc.label}" (${currentAcc.credits} cr) kurang dari kebutuhan Scene ${sceneNum} (${dynamicMaxCredits} cr). Beralih otomatis ke "${candidate.label}" (${candidate.credits} cr)...`
              );
              await switchAccount(candidate.id, { visible: false, launch: true });
              await ensureActiveAccountReady();
            }
          }

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
              const resolvedRef = imageIdToPath.get(refId);
              if (resolvedRef && !sceneRefPaths.includes(resolvedRef)) {
                sceneRefPaths.push(resolvedRef);
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
            sceneSuccess = true;
            break;
          }
        } catch (attemptErr: unknown) {
          sceneError = attemptErr instanceof Error ? attemptErr : new Error(String(attemptErr));
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] ⚠️ Scene ${sceneNum} gagal pada percobaan ${attempt}/${MAX_SCENE_ATTEMPTS}: ${sceneError.message}`
          );
          if (isPipelineCancelled) throw attemptErr;
        }
      }

      if (!sceneSuccess || !clipFile) {
        if (activePipeline.scene_statuses?.[i]) {
          activePipeline.scene_statuses[i].status = "failed";
        }

        // Save checkpoint with status "paused"
        const pausedCp: PipelineCheckpoint = {
          job_id: jobId,
          batch_id: opts?.batchId,
          video_index: opts?.videoIndex ?? 0,
          total_videos: opts?.totalVideos ?? 1,
          video_title: scenesToRun[0]?.title || `Video ${opts?.videoIndex !== undefined ? opts.videoIndex + 1 : 1}`,
          status: "paused",
          duration_target: duration,
          platform_preset: resolved.platform,
          video_model: videoModel,
          clips_count: clipsCount,
          clip_durations: clipDurations,
          completed_scenes: Array.from({ length: downloadedClips.length }, (_, k) => k + 1),
          completed_clips: [...downloadedClips],
          completed_durations: [...downloadedClipDurations],
          failed_scene: sceneNum,
          last_error: sceneError?.message || `Gagal generate scene ${sceneNum}`,
          request_body: body as Record<string, unknown>,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        saveCheckpoint(pausedCp);

        if (opts?.autoSkip) {
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] ⏩ [Auto-Skip] Video ${opts.videoIndex !== undefined ? opts.videoIndex + 1 : 1} tertahan di Scene ${sceneNum}. Klip 1 s/d ${downloadedClips.length} tersimpan di disk. Melanjutkan ke video berikutnya...`
          );
          if (opts.batchId && opts.videoIndex !== undefined) {
            updateBatchItem(opts.batchId, opts.videoIndex, {
              status: "paused",
              failed_scene: sceneNum,
              checkpoint_id: jobId,
              error: sceneError?.message,
            });
          }
          return { success: false, skipped: true, paused: true, jobId, failed_scene: sceneNum, error: sceneError?.message };
        } else {
          throw sceneError || new Error(`Gagal generate scene ${sceneNum} setelah ${MAX_SCENE_ATTEMPTS} percobaan.`);
        }
      }

      // Scene succeeded! Save persistent copy in checkpoint directory
      const checkpointClipDir = getJobCheckpointDir(jobId);
      const persistentClip = join(checkpointClipDir, `scene_${String(sceneNum).padStart(2, "0")}.mp4`);
      try {
        copyFileSync(clipFile, persistentClip);
        downloadedClips.push(persistentClip);
      } catch {
        downloadedClips.push(clipFile);
      }
      downloadedClipDurations.push(plannedClipDuration);

      if (activePipeline.scene_statuses?.[i]) {
        activePipeline.scene_statuses[i].status = "done";
        activePipeline.scene_statuses[i].clip_file = persistentClip;
        activePipeline.scene_statuses[i].duration = plannedClipDuration;
        activePipeline.scene_statuses[i].variants_count = candidateFiles.length || 1;
        activePipeline.scene_statuses[i].variant_files = candidateFiles.length ? candidateFiles : [persistentClip];
      }
      activePipeline.logs.push(
        `[${new Date().toLocaleTimeString()}] Scene ${sceneNum} selesai: ${basename(clipFile)} (trim ${plannedClipDuration}s)`
      );

      saveCheckpoint({
        job_id: jobId,
        batch_id: opts?.batchId,
        video_index: opts?.videoIndex ?? 0,
        total_videos: opts?.totalVideos ?? 1,
        video_title: scenesToRun[0]?.title || `Video ${opts?.videoIndex !== undefined ? opts.videoIndex + 1 : 1}`,
        status: "in_progress",
        duration_target: duration,
        platform_preset: resolved.platform,
        video_model: videoModel,
        clips_count: clipsCount,
        clip_durations: clipDurations,
        completed_scenes: Array.from({ length: downloadedClips.length }, (_, k) => k + 1),
        completed_clips: [...downloadedClips],
        completed_durations: [...downloadedClipDurations],
        request_body: body as Record<string, unknown>,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      await new Promise((r) => setTimeout(r, 2000));
    }

    // Static Product End-Card (Zero-text-in-AI, 100% brand/packaging faithful)
    if (resolved.endcard_seconds > 0) {
      const productMainImage = images.find((im) => im.role === "product_main" && existsSync(join(PRODUCT_DIR, im.file)));
      const endCardSource = (productMainImage ? join(PRODUCT_DIR, productMainImage.file) : undefined)
        || imageIdToPath.get("img1")
        || visualFallbackPaths[0];
      if (endCardSource) {
        mkdirSync(ENDCARD_DIR, { recursive: true });
        const endCardFile = join(ENDCARD_DIR, `endcard_${jobId}.mp4`);
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

    saveCheckpoint({
      job_id: jobId,
      batch_id: opts?.batchId,
      video_index: opts?.videoIndex ?? 0,
      total_videos: opts?.totalVideos ?? 1,
      video_title: scenesToRun[0]?.title || `Video ${opts?.videoIndex !== undefined ? opts.videoIndex + 1 : 1}`,
      status: "completed",
      duration_target: duration,
      platform_preset: resolved.platform,
      video_model: videoModel,
      clips_count: clipsCount,
      clip_durations: clipDurations,
      completed_scenes: Array.from({ length: downloadedClips.length }, (_, k) => k + 1),
      completed_clips: [...downloadedClips],
      completed_durations: [...downloadedClipDurations],
      request_body: body as Record<string, unknown>,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    activePipeline.status_text = "Selesai";
    activePipeline.last_video = outputFilename;
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 Video final berhasil dirakit (${durationActual.toFixed(1)}s): ${outputFilename}`);
    return { success: true, last_video: outputFilename, jobId };
    });
  } catch (err: unknown) {
    if (isPipelineCancelled) {
      activePipeline.status_text = "Dibatalkan";
      activePipeline.cancelled = true;
      activePipeline.error = "Generasi video dibatalkan oleh pengguna.";
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Generasi video berhasil dibatalkan.`);
      return { success: false, jobId, error: "Generasi video dibatalkan oleh pengguna." };
    } else {
      activePipeline.status_text = "Error";
      activePipeline.error = err instanceof Error ? err.message : String(err);
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error: ${activePipeline.error}`);
      return { success: false, jobId, error: activePipeline.error };
    }
  } finally {
    activePipeline.running = false;
    currentRunningJobId = null;
  }
}

async function runBatchPipelineAsync(
  core: Core,
  body: BatchPipelineRequestBody,
  resolved: ResolvedPlatformConfig
): Promise<void> {
  const batchCount = Math.max(1, body.batch_count || 1);
  const batchMode = body.batch_mode || "variations";
  const autoSkip = body.auto_skip !== false;
  const autoRetryEnd = body.auto_retry_end !== false;
  const batchId = "batch_" + randomBytes(6).toString("hex");

  const items: BatchItemState[] = Array.from({ length: batchCount }, (_, idx) => ({
    index: idx,
    job_id: "",
    title: `Video ${idx + 1} (${batchMode === "series" ? `Part ${idx + 1}` : `Variasi ${idx + 1}`})`,
    status: "pending" as const,
    current_scene: 0,
    clips_count: resolved.clips_count,
    duration: resolved.duration_target,
    credits_spent: 0,
  }));

  const batchState: BatchPipelineState = {
    batch_id: batchId,
    running: true,
    cancelled: false,
    batch_count: batchCount,
    batch_mode: batchMode,
    auto_skip: autoSkip,
    auto_retry_end: autoRetryEnd,
    current_index: 0,
    items,
    logs: [
      `[${new Date().toLocaleTimeString()}] 🚀 Memulai Batch Pipeline (${batchCount} video @ ${resolved.duration_target}s, mode: ${batchMode === "series" ? "Cerita Bersambung" : "Variasi Hook A/B Test"})...`
    ],
    status_text: `Menyiapkan ${batchCount} naskah AI...`,
    created_at: new Date().toISOString(),
  };
  setActiveBatch(batchState);

  try {
    let scripts: ScriptResult[] = [];
    try {
      scripts = await generateBatchScriptsWithLLM(body, batchCount, batchMode, undefined, undefined, resolved);
      for (let i = 0; i < scripts.length && i < items.length; i++) {
        items[i].title = scripts[i].scenes?.[0]?.title
          ? `Video ${i + 1}: "${scripts[i].scenes[0].title}"`
          : (scripts[i].hook_text_3s ? `Video ${i + 1}: "${scripts[i].hook_text_3s}"` : items[i].title);
        items[i].hook_type = scripts[i].hook_type;
      }
      batchState.logs.push(`[${new Date().toLocaleTimeString()}] ✅ ${scripts.length} naskah siap digunakan.`);
    } catch (scriptErr: unknown) {
      batchState.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ Susun naskah AI terkendala (${(scriptErr as Error).message}). Menggunakan naskah default.`);
    }

    for (let idx = 0; idx < batchCount; idx++) {
      if (batchState.cancelled || isPipelineCancelled) {
        batchState.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Eksekusi batch dihentikan oleh pengguna.`);
        break;
      }

      batchState.current_index = idx;
      items[idx].status = "generating";
      batchState.status_text = `Memproses Video ${idx + 1} dari ${batchCount}...`;

      const videoBody: PipelineRequestBody = {
        ...body,
        scenes: scripts[idx]?.scenes || body.scenes,
        hook_type: scripts[idx]?.hook_type || body.hook_type,
        hook_text_3s: scripts[idx]?.hook_text_3s || body.hook_text_3s,
        character_anchor: scripts[idx]?.character_anchor || body.character_anchor,
        setting_anchor: scripts[idx]?.setting_anchor || body.setting_anchor,
        voiceover_persona: scripts[idx]?.voiceover_persona || body.voiceover_persona,
        style: scripts[idx]?.style || body.style,
      };

      const res = await runPipelineAsync(core, videoBody, resolved, {
        batchId,
        videoIndex: idx,
        totalVideos: batchCount,
        autoSkip,
      });

      if (res.jobId) items[idx].job_id = res.jobId;

      if (res.skipped || res.paused) {
        items[idx].status = "paused";
        items[idx].failed_scene = res.failed_scene;
        items[idx].checkpoint_id = res.jobId;
      } else if (res.success) {
        items[idx].status = "done";
        items[idx].last_video = res.last_video;
      } else {
        items[idx].status = "failed";
      }
    }

    // Auto-Retry Second Pass for skipped/paused videos
    if (autoRetryEnd && !batchState.cancelled && !isPipelineCancelled) {
      const pausedItems = items.filter((it) => it.status === "paused" && it.checkpoint_id);
      if (pausedItems.length > 0) {
        batchState.logs.push(
          `[${new Date().toLocaleTimeString()}] 🔄 [Auto-Retry Second Pass] Memulai kembali ${pausedItems.length} video yang tertahan...`
        );
        for (const it of pausedItems) {
          if (batchState.cancelled || isPipelineCancelled) break;
          batchState.logs.push(
            `[${new Date().toLocaleTimeString()}] 🔄 Melanjutkan ${it.title} dari Scene ${it.failed_scene ?? "berikutnya"}...`
          );
          it.status = "generating";
          const res = await runPipelineAsync(core, body, resolved, {
            batchId,
            videoIndex: it.index,
            totalVideos: batchCount,
            autoSkip: false,
            resumeJobId: it.checkpoint_id,
          });
          if (res.success) {
            it.status = "done";
            it.last_video = res.last_video;
          } else {
            it.status = "paused";
          }
        }
      }
    }

    const doneCount = items.filter((i) => i.status === "done").length;
    const pausedCount = items.filter((i) => i.status === "paused").length;
    batchState.status_text = `Batch Selesai: ${doneCount}/${batchCount} sukses${pausedCount > 0 ? `, ${pausedCount} tertahan` : ""}`;
    batchState.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 ${batchState.status_text}`);
  } catch (err: unknown) {
    batchState.status_text = "Error dalam batch";
    batchState.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error: ${(err as Error).message}`);
  } finally {
    batchState.running = false;
  }
}
function migrateLooseEndcards(): void {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    mkdirSync(ENDCARD_DIR, { recursive: true });
    for (const f of readdirSync(OUTPUT_DIR)) {
      if (/^endcard_.*\.(mp4|mov|webm)$/i.test(f)) {
        const src = join(OUTPUT_DIR, f);
        const dest = join(ENDCARD_DIR, f);
        try {
          renameSync(src, dest);
        } catch {
          try {
            copyFileSync(src, dest);
            unlinkSync(src);
          } catch {}
        }
      }
    }
  } catch {}
}

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string, forceDownload = false) {
  const isAllowed = inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR) || inside(file, OUTPUT_DIR) || inside(file, ENDCARD_DIR) || inside(file, PRODUCT_DIR);
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
  loadAccountsRegistry();
  migrateLooseEndcards();
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
          endcard: ENDCARD_DIR,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/open-folder") {
        const type = url.searchParams.get("type") ?? "output";
        const target = type === "product" ? PRODUCT_DIR : type === "endcard" ? ENDCARD_DIR : OUTPUT_DIR;
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
        migrateLooseEndcards();
        mkdirSync(OUTPUT_DIR, { recursive: true });
        const files = readdirSync(OUTPUT_DIR)
          .filter((f) => /\.mp4$/i.test(f) && !/^endcard_/i.test(f))
          .map((f) => {
            const full = join(OUTPUT_DIR, f);
            const st = statSync(full);
            return { name: f, size: st.size, modified: st.mtimeMs, url: `/media?path=${encodeURIComponent(full)}&token=${token}` };
          })
          .sort((a, b) => b.modified - a.modified);
        return json(res, 200, { outputs: files });
      }

      if (
        (req.method === "DELETE" && url.pathname === "/api/outputs") ||
        (req.method === "POST" && url.pathname === "/api/outputs/bulk-delete")
      ) {
        mkdirSync(OUTPUT_DIR, { recursive: true });
        const queryName = url.searchParams.get("name");
        const queryAll = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
        let body: { names?: string[]; all?: boolean } = {};
        try {
          const rawBody = (await readBody(req, 256 * 1024)).toString();
          if (rawBody) body = JSON.parse(rawBody);
        } catch {}

        const deleteSingleOutput = (fileName: string): boolean => {
          const safe = basename(fileName);
          const full = join(OUTPUT_DIR, safe);
          if (safe && existsSync(full) && inside(full, OUTPUT_DIR)) {
            unlinkSync(full);
            const metaPath = join(OUTPUT_DIR, `${basename(safe, extname(safe))}.meta.json`);
            if (existsSync(metaPath) && inside(metaPath, OUTPUT_DIR)) {
              try { unlinkSync(metaPath); } catch {}
            }
            return true;
          }
          return false;
        };

        if (queryName && !body.names && !body.all && !queryAll) {
          const safe = basename(queryName);
          if (deleteSingleOutput(safe)) {
            return json(res, 200, { success: true, deleted: safe });
          }
          return json(res, 404, { error: "File not found." });
        }

        const targets = (body.all || queryAll)
          ? readdirSync(OUTPUT_DIR).filter((f) => /\.mp4$/i.test(f))
          : Array.isArray(body.names)
          ? body.names
          : [];
        const deletedNames: string[] = [];
        for (const t of targets) {
          const safe = basename(t);
          if (deleteSingleOutput(safe)) {
            deletedNames.push(safe);
          }
        }
        return json(res, 200, { success: true, deleted: deletedNames, count: deletedNames.length });
      }

      // Endcards API
      if (req.method === "GET" && url.pathname === "/api/endcards") {
        migrateLooseEndcards();
        mkdirSync(ENDCARD_DIR, { recursive: true });
        const files = readdirSync(ENDCARD_DIR)
          .filter((f) => /\.(mp4|mov|webm)$/i.test(f))
          .map((f) => {
            const full = join(ENDCARD_DIR, f);
            const st = statSync(full);
            return { name: f, size: st.size, modified: st.mtimeMs, url: `/media?path=${encodeURIComponent(full)}&token=${token}` };
          })
          .sort((a, b) => b.modified - a.modified);
        return json(res, 200, { endcards: files, path: ENDCARD_DIR });
      }

      if (
        (req.method === "DELETE" && url.pathname === "/api/endcards") ||
        (req.method === "POST" && url.pathname === "/api/endcards/bulk-delete")
      ) {
        mkdirSync(ENDCARD_DIR, { recursive: true });
        const queryName = url.searchParams.get("name");
        const queryAll = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
        let body: { names?: string[]; all?: boolean } = {};
        try {
          const rawBody = (await readBody(req, 256 * 1024)).toString();
          if (rawBody) body = JSON.parse(rawBody);
        } catch {}

        const targets = (body.all || queryAll)
          ? readdirSync(ENDCARD_DIR).filter((f) => /\.(mp4|mov|webm)$/i.test(f))
          : Array.isArray(body.names)
          ? body.names
          : queryName
          ? [queryName]
          : [];

        const deletedNames: string[] = [];
        for (const t of targets) {
          const safe = basename(t);
          const full = join(ENDCARD_DIR, safe);
          if (safe && existsSync(full) && inside(full, ENDCARD_DIR)) {
            try {
              unlinkSync(full);
              deletedNames.push(safe);
            } catch {}
          }
        }
        return json(res, 200, { success: true, deleted: deletedNames, count: deletedNames.length });
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
        const rawBody = (await readBody(req, 64 * 1024)).toString();
        const body = rawBody ? (JSON.parse(rawBody) as { account_id?: string; label?: string; name?: string }) : {};
        try {
          const result = await withFlowLock("login", async () => {
            let reg = loadAccountsRegistry();
            let targetAcc = body.account_id
              ? reg.accounts.find((a) => a.id === body.account_id)
              : getActiveAccount();

            // If no accounts exist at all, create the first account automatically
            if (!targetAcc && reg.accounts.length === 0) {
              targetAcc = await createAccount(body.label || body.name);
              reg = loadAccountsRegistry();
            } else if (body.account_id && !targetAcc) {
              throw new Error(`Akun "${body.account_id}" tidak ditemukan.`);
            } else if (!targetAcc && reg.accounts.length > 0) {
              targetAcc = reg.accounts[0];
            }

            if (!targetAcc) {
              throw new Error("Belum ada akun Google Flow.");
            }

            if (reg.active_account_id !== targetAcc.id) {
              reg.active_account_id = targetAcc.id;
              reg.generation = (reg.generation || 1) + 1;
              targetAcc.last_active = Date.now();
              saveAccountsRegistry(reg);
            }
            setProfileDir(targetAcc.profile_dir);

            if (!isMockMode()) {
              await ensureChromeForProfile(targetAcc.profile_dir, { visible: true, bringToFront: true });
              const b = await getBrowser({ autoLaunch: false });
              const context = b.contexts()[0];
              if (context) {
                const pages = context.pages();
                const existingTab = pages.find(
                  (p) =>
                    FLOW_HOSTS.test(p.url()) ||
                    /accounts\.google\.com|\/ServiceLogin|\/InteractiveLogin|\/AccountChooser/i.test(p.url()),
                );
                if (existingTab) {
                  await existingTab.bringToFront().catch(() => {});
                } else {
                  const blankTab = pages.find((p) => !p.url() || p.url() === "about:blank" || p.url().startsWith("chrome://newtab"));
                  const tab = blankTab ?? (await context.newPage());
                  await tab.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" }).catch(() => {});
                  await tab.bringToFront().catch(() => {});
                }
              }
              bringChromeToFront();
            }

            const probe = await probeSession(targetAcc.id, { detailed: false });
            const latestReg = loadAccountsRegistry();
            return {
              success: true,
              message: "Chrome login window opened",
              account_id: targetAcc.id,
              active_account_id: latestReg.active_account_id,
              generation: latestReg.generation,
              accounts: latestReg.accounts,
              state: probe.status,
              flow: {
                url: probe.url,
                state: probe.status,
                signedIn: probe.signedIn,
                inProject: probe.inProject,
                credits_remaining: probe.credits_remaining,
                plan: probe.plan,
                email: probe.email,
                hint: probe.hint,
              },
            };
          });
          return json(res, 200, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: `Gagal membuka Chrome: ${message}` });
        }
      }

      // Flow Session Heartbeat (Passive probe via tryFlowLock)
      if (req.method === "POST" && url.pathname === "/api/flow/heartbeat") {
        const rawBody = (await readBody(req, 64 * 1024)).toString();
        const body = rawBody ? (JSON.parse(rawBody) as { detailed?: boolean; auto_launch?: boolean }) : {};
        let reg = loadAccountsRegistry();
        const activeAcc = reg.active_account_id ? reg.accounts.find((a) => a.id === reg.active_account_id) : undefined;

        const probe = activePipeline.running
          ? null
          : await tryFlowLock("heartbeat", () =>
              probeSession(reg.active_account_id, { detailed: Boolean(body.detailed) }),
            );

        if (!probe) {
          const owner = flowLockOwner() || (activePipeline.running ? "pipeline" : "busy");
          return json(res, 200, {
            success: true,
            busy: true,
            lock_owner: owner,
            chrome_running: true,
            account_id: reg.active_account_id,
            active_account_id: reg.active_account_id,
            generation: reg.generation,
            state: "busy",
            accounts: reg.accounts,
            flow: {
              url: "",
              state: "busy",
              signedIn: Boolean(activeAcc?.signed_in),
              inProject: true,
              credits_remaining: activeAcc?.credits,
              plan: activeAcc?.plan,
              email: activeAcc?.email,
              hint: `Sedang aktif (${owner})`,
            },
          });
        }

        reg = loadAccountsRegistry();
        return json(res, 200, {
          success: probe.status !== "error",
          busy: false,
          chrome_running: probe.chrome_running,
          timestamp: Date.now(),
          account_id: probe.account_id,
          active_account_id: reg.active_account_id,
          generation: reg.generation,
          state: probe.status,
          accounts: reg.accounts,
          error: probe.error,
          flow: {
            url: probe.url,
            state: probe.status,
            signedIn: probe.signedIn,
            inProject: probe.inProject,
            credits_remaining: probe.credits_remaining,
            plan: probe.plan,
            email: probe.email,
            composer: probe.composer,
            hint: probe.hint,
          },
        });
      }

      // Config & Session Export / Import API (Encrypted AES-256-GCM + scrypt when include_sessions=true)
      if (req.method === "POST" && url.pathname === "/api/config/export") {
        const rawBody = (await readBody(req, 5 * 1024 * 1024)).toString();
        const body = rawBody
          ? (JSON.parse(rawBody) as {
              ui_config?: Record<string, unknown>;
              include_sessions?: boolean;
              passphrase?: string;
            })
          : {};

        if (body.include_sessions) {
          if (!body.passphrase || typeof body.passphrase !== "string" || body.passphrase.length < 8) {
            return json(res, 400, {
              success: false,
              error: "Passphrase minimal 8 karakter wajib diisi saat menyertakan sesi login.",
            });
          }
        }

        const reg = loadAccountsRegistry();
        let encryptedSessions:
          | { alg: string; salt: string; iv: string; tag: string; data: string }
          | undefined = undefined;

        if (body.include_sessions && body.passphrase) {
          const passphrase = body.passphrase;
          encryptedSessions = await withFlowLock("config-export", async () => {
            const sessionMap: Record<string, { cookies?: any[]; origins?: any[] }> = {};
            const wasRunningDir = isMockMode() ? null : await runningProfileDir();

            for (const acc of reg.accounts) {
              if (isMockMode()) {
                sessionMap[acc.id] = {
                  cookies: [{ name: "SID", value: `mock_${acc.id}`, domain: ".google.com", path: "/" }],
                  origins: [],
                };
                continue;
              }
              if (!existsSync(acc.profile_dir)) continue;

              const curDir = await runningProfileDir();
              const alreadyThisProfile = Boolean(curDir && resolve(curDir) === resolve(acc.profile_dir));
              if (!alreadyThisProfile) {
                await ensureChromeForProfile(acc.profile_dir, { visible: false, openUrl: "about:blank" });
              }
              const st = await captureBrowserStorageState();
              if (st?.cookies?.length) {
                sessionMap[acc.id] = st;
              }
              if (!alreadyThisProfile) {
                await shutdownChrome();
              }
            }

            // Restore previously running profile if any
            if (wasRunningDir && existsSync(wasRunningDir)) {
              const curAfter = await runningProfileDir();
              if (!curAfter || resolve(curAfter) !== resolve(wasRunningDir)) {
                await ensureChromeForProfile(wasRunningDir, { visible: false }).catch(() => {});
              }
            }

            const salt = randomBytes(16);
            const iv = randomBytes(12);
            const key = scryptSync(passphrase, salt, 32);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            const plaintext = JSON.stringify(sessionMap);
            const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();

            return {
              alg: "aes-256-gcm+scrypt",
              salt: salt.toString("base64"),
              iv: iv.toString("base64"),
              tag: tag.toString("base64"),
              data: ciphertext.toString("base64"),
            };
          });
        }

        // Export account metadata WITHOUT plaintext cookies or machine-specific profile paths
        const sanitizedAccounts = reg.accounts.map((a) => ({
          id: a.id,
          label: a.label,
          name: a.label,
          email: a.email,
          status: a.status,
          signed_in: a.status === "signed_in",
          credits: a.credits,
          credits_checked_at: a.credits_checked_at,
          plan: a.plan,
          created_at: a.created_at,
          last_active: a.last_active,
        }));

        return json(res, 200, {
          success: true,
          warning: "Google bisa meminta login ulang di perangkat baru.",
          export_data: {
            app: "develapar-video",
            version: "0.3.0",
            exported_at: new Date().toISOString(),
            ui_config: body.ui_config ?? {},
            flow_accounts: {
              version: 2,
              active_account_id: reg.active_account_id,
              accounts: sanitizedAccounts,
            },
            ...(encryptedSessions ? { sessions: encryptedSessions } : {}),
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/config/import") {
        const rawBody = (await readBody(req, 10 * 1024 * 1024)).toString();
        const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, any>) : {};
        const payload = parsed.export_data && typeof parsed.export_data === "object" ? parsed.export_data : parsed;
        const passphrase = typeof parsed.passphrase === "string" ? parsed.passphrase : undefined;

        const importedUiConfig = payload.ui_config && typeof payload.ui_config === "object" ? payload.ui_config : {};
        const flowAccountsData = payload.flow_accounts && typeof payload.flow_accounts === "object" ? payload.flow_accounts : null;
        const encSessions = payload.sessions && typeof payload.sessions === "object" ? payload.sessions : null;

        let decryptedSessions: Record<string, { cookies?: any[]; origins?: any[] }> | null = null;
        let sessionError: string | undefined = undefined;

        if (encSessions && typeof encSessions.data === "string") {
          if (!passphrase) {
            sessionError = "File konfigurasi berisi sesi terenkripsi, namun passphrase tidak diisi. Akun dibuat tanpa sesi login.";
          } else {
            try {
              const salt = Buffer.from(String(encSessions.salt || ""), "base64");
              const iv = Buffer.from(String(encSessions.iv || ""), "base64");
              const tag = Buffer.from(String(encSessions.tag || ""), "base64");
              const data = Buffer.from(String(encSessions.data || ""), "base64");
              const key = scryptSync(passphrase, salt, 32);
              const decipher = createDecipheriv("aes-256-gcm", key, iv);
              decipher.setAuthTag(tag);
              const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
              decryptedSessions = JSON.parse(plain) as Record<string, { cookies?: any[]; origins?: any[] }>;
            } catch {
              sessionError = "Passphrase salah atau data sesi rusak. Akun tetap dibuat tanpa sesi login.";
            }
          }
        }

        const importResult = await withFlowLock("config-import", async () => {
          const reg = loadAccountsRegistry();
          const createdPairs: Array<{ oldId: string; account: FlowAccount }> = [];
          const idMap = new Map<string, string>();

          if (flowAccountsData && Array.isArray(flowAccountsData.accounts)) {
            let ts = Date.now();
            for (const rawAcc of flowAccountsData.accounts) {
              if (!rawAcc || typeof rawAcc !== "object") continue;
              const oldId = String(rawAcc.id || `acc_${ts}`);
              let newId = oldId !== "default" && /^acc_\w+$/.test(oldId) ? oldId : `acc_${ts}`;
              while (reg.accounts.some((a) => a.id === newId) || existsSync(join(PROFILES_BASE_DIR, newId))) {
                ts += 1;
                newId = `acc_${ts}`;
              }
              idMap.set(oldId, newId);

              const profileDir = join(PROFILES_BASE_DIR, newId);
              mkdirSync(profileDir, { recursive: true });

              const rawLabel = String(rawAcc.label || rawAcc.name || "").trim();
              const email = rawAcc.email ? String(rawAcc.email) : undefined;
              const label =
                rawLabel && rawLabel !== "Akun Utama" && rawLabel !== "default"
                  ? rawLabel
                  : email || nextAccountLabel(reg.accounts);

              const newAcc = normalizeAccount({
                id: newId,
                label,
                email,
                profile_dir: profileDir,
                status: "unknown",
                credits: undefined,
                credits_checked_at: undefined,
                plan: rawAcc.plan ? String(rawAcc.plan) : undefined,
                created_at: typeof rawAcc.created_at === "number" ? rawAcc.created_at : Date.now(),
                last_active: Date.now(),
              });

              reg.accounts.push(newAcc);
              createdPairs.push({ oldId, account: newAcc });
            }

            if (createdPairs.length > 0) {
              reg.generation = (reg.generation || 1) + 1;
              const mappedActive = flowAccountsData.active_account_id
                ? idMap.get(String(flowAccountsData.active_account_id))
                : undefined;
              if (!reg.active_account_id) {
                reg.active_account_id = mappedActive || createdPairs[0].account.id;
              }
              saveAccountsRegistry(reg);
              setProfileDir(getActiveProfileDir());
            }

            // Inject decrypted cookies ONCE per imported account into its fresh profile and close gracefully
            if (decryptedSessions && !sessionError) {
              for (const { oldId, account } of createdPairs) {
                const sess = decryptedSessions[oldId];
                if (sess?.cookies && Array.isArray(sess.cookies) && sess.cookies.length > 0) {
                  if (!isMockMode()) {
                    try {
                      await ensureChromeForProfile(account.profile_dir, { visible: false, openUrl: "about:blank" });
                      const b = await getBrowser({ autoLaunch: false });
                      await b.contexts()[0]?.addCookies(sess.cookies).catch(() => {});
                      await shutdownChrome();
                      account.status = "signed_in";
                      account.signed_in = true;
                    } catch (err) {
                      engineLog(
                        "accounts",
                        `Failed to restore cookies for imported account ${account.id}: ${(err as Error).message}`,
                      );
                    }
                  } else {
                    account.status = "signed_in";
                    account.signed_in = true;
                  }
                }
              }
              saveAccountsRegistry(reg);
            }
          }

          return reg;
        });

        return json(res, 200, {
          success: true,
          sessions_restored: Boolean(decryptedSessions && !sessionError),
          session_error: sessionError,
          warning: "Google bisa meminta login ulang di perangkat baru.",
          ui_config: importedUiConfig,
          active_account_id: importResult.active_account_id,
          generation: importResult.generation,
          accounts: importResult.accounts,
        });
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
              resolved,
              body.script_mode === "flow_agent" ? "flow_agent" : "llm"
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

        const result = await generateScriptWithLLM(body, undefined, undefined, resolved, body.script_mode === "flow_agent" ? "flow_agent" : "llm");
        return json(res, 200, { success: true, ...result });
      }

      // Flow Agent In-App Bridge Chat API
      if (req.method === "POST" && url.pathname === "/api/flow-agent/chat") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as {
          message?: string;
          product_file?: string;
          voice_language?: string;
          duration?: number;
        };
        const message = (body.message || "").trim();
        if (!message) {
          return json(res, 400, { success: false, error: "Pesan chat tidak boleh kosong." });
        }
        try {
          const reply = await chatWithFlowAgent({
            message,
            productHint: body.product_file,
            voiceLanguage: body.voice_language,
            duration: body.duration,
          });
          return json(res, 200, { success: true, reply });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      // Flow Agent Script Compilation API (Chat-to-Storyboard)
      if (req.method === "POST" && url.pathname === "/api/flow-agent/compile-script") {
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
        try {
          const result = await generateScriptWithLLM(body, undefined, undefined, resolved, "flow_agent");
          return json(res, 200, { success: true, ...result });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      // Flow Agent Session Reset API
      if (req.method === "POST" && url.pathname === "/api/flow-agent/reset") {
        try {
          await resetFlowAgentSession();
          return json(res, 200, { success: true });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      // Flow Multi-Account Profile Management API
      if (req.method === "GET" && url.pathname === "/api/flow/accounts") {
        const reg = loadAccountsRegistry();
        const isMock = isMockMode();
        const running = isMock ? Boolean(reg.active_account_id) : await isChromeRunning();
        const profileDir = isMock
          ? getActiveAccount()?.profile_dir ?? null
          : running
            ? await runningProfileDir()
            : null;
        const chromeAcc = profileDir
          ? reg.accounts.find((a) => resolve(a.profile_dir) === resolve(profileDir))
          : undefined;
        return json(res, 200, {
          success: true,
          version: 2,
          active_account_id: reg.active_account_id,
          generation: reg.generation,
          accounts: reg.accounts,
          chrome: {
            running,
            profile_dir: profileDir,
            account_id: chromeAcc?.id ?? null,
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/flow/accounts/switch") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as {
          account_id?: string;
          visible?: boolean;
          launch?: boolean;
        };
        if (!body.account_id) {
          return json(res, 400, { success: false, error: "account_id wajib diisi." });
        }
        try {
          const result = await switchAccount(body.account_id, {
            visible: body.visible,
            launch: body.launch,
          });
          const reg = loadAccountsRegistry();
          return json(res, 200, {
            success: true,
            active_account_id: reg.active_account_id,
            generation: reg.generation,
            account: result.account,
            accounts: reg.accounts,
            state: result.state.status,
            flow: result.state,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/flow/accounts/add") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as {
          label?: string;
          name?: string;
        };
        try {
          const newAcc = await createAccount(body.label ?? body.name);
          const reg = loadAccountsRegistry();
          return json(res, 200, {
            success: true,
            account: newAcc,
            active_account_id: reg.active_account_id,
            generation: reg.generation,
            accounts: reg.accounts,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/flow/accounts/rename") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as {
          account_id?: string;
          label?: string;
          name?: string;
        };
        const newLabel = (body.label ?? body.name ?? "").trim();
        if (!body.account_id || !newLabel) {
          return json(res, 400, { success: false, error: "account_id dan label wajib diisi." });
        }
        try {
          const updated = await renameAccount(body.account_id, newLabel);
          const reg = loadAccountsRegistry();
          return json(res, 200, {
            success: true,
            account: updated,
            active_account_id: reg.active_account_id,
            generation: reg.generation,
            accounts: reg.accounts,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      if ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/api/flow/accounts/delete") {
        const rawBody = (await readBody(req, 1024 * 1024)).toString();
        const body = rawBody ? (JSON.parse(rawBody) as { account_id?: string }) : {};
        const accountId = body.account_id || url.searchParams.get("account_id") || "";
        if (!accountId) {
          return json(res, 400, { success: false, error: "account_id wajib diisi." });
        }
        try {
          await deleteAccount(accountId);
          const reg = loadAccountsRegistry();
          return json(res, 200, {
            success: true,
            deleted_id: accountId,
            active_account_id: reg.active_account_id,
            generation: reg.generation,
            accounts: reg.accounts,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/flow/accounts/refresh-credits") {
        const rawBody = (await readBody(req, 64 * 1024)).toString();
        const body = rawBody
          ? (JSON.parse(rawBody) as { account_id?: string; all?: boolean })
          : {};
        try {
          const result = await refreshAccountCredits({
            accountId: body.account_id,
            all: body.all,
          });
          return json(res, 200, {
            success: true,
            active_account_id: result.active_account_id,
            generation: result.generation,
            accounts: result.accounts,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      // Set/Override mock credits for test suites (FLOW_MOCK_RENDER only)
      if ((process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true") && req.method === "POST" && url.pathname === "/api/pipeline/mock-credits") {
        const body = JSON.parse((await readBody(req, 1024)).toString() || "{}") as { credits?: number };
        if (body.credits !== undefined) {
          process.env.FLOW_MOCK_CREDITS = String(body.credits);
        } else {
          delete process.env.FLOW_MOCK_CREDITS;
        }
        return json(res, 200, { success: true, credits: process.env.FLOW_MOCK_CREDITS !== undefined ? Number(process.env.FLOW_MOCK_CREDITS) : 9999 });
      }

      // Pre-flight Credit Check API
      if (req.method === "POST" && url.pathname === "/api/pipeline/check-credits") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as PipelineRequestBody & {
          clips_count?: number;
          duration?: number;
          scenes_count?: number;
        };
        try {
          await ensureActiveAccountReady();
        } catch (accErr: unknown) {
          const msg = accErr instanceof Error ? accErr.message : String(accErr);
          const code = (accErr as { code?: string })?.code || "ACCOUNT_NOT_SIGNED_IN";
          return json(res, 400, { success: false, error: msg, code, message: msg });
        }
        let resolved: ResolvedPlatformConfig | undefined;
        try {
          resolved = resolveRequestConfig(body);
        } catch {}
        const creditCalc = calculatePipelineCredits(body, resolved);
        const state = await getFlowState(true).catch(() => getFlowState());
        const mockHeader = (process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true") && req.headers["x-mock-credits"] !== undefined
          ? Number(req.headers["x-mock-credits"])
          : undefined;
        const available = mockHeader !== undefined ? mockHeader : state.credits_remaining;
        if (available !== undefined && available < creditCalc.total_required) {
          const shortage = creditCalc.total_required - available;
          const reg = loadAccountsRegistry();
          const fallbackAcc = reg.accounts.find((a) => a.id !== reg.active_account_id && (a.credits ?? 0) >= creditCalc.total_required);
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
            fallback_account: fallbackAcc
              ? { id: fallbackAcc.id, label: fallbackAcc.label, name: fallbackAcc.label, credits: fallbackAcc.credits }
              : null,
            message: `Kredit Flow tidak cukup. Dibutuhkan ${creditCalc.total_required} kredit, tersedia ${available} kredit.`,
          });
        }
        if (available !== undefined) {
          updateActiveAccountState({ credits: available, status: "signed_in" }).catch(() => {});
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

      // Dynamic Batch & Credit Pool Estimator
      if (req.method === "POST" && url.pathname === "/api/pipeline/estimate-batch") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}");
        const est = estimateBatchPipeline({
          platform_preset: body.platform_preset,
          duration_target: body.duration,
          video_model: body.video_model,
          batch_count: body.batch_count,
          scene1_variants: body.scene1_variants,
          enable_endcard: body.enable_endcard !== false,
        });
        const pool = getCreditPoolSummary();
        return json(res, 200, {
          success: true,
          estimate: est,
          credit_pool: pool,
          is_sufficient: pool.total_pool_credits >= est.total_credits,
          pool_shortage: Math.max(0, est.total_credits - pool.total_pool_credits),
        });
      }

      // Pipeline Generation Trigger (Single & Batch)
      if (req.method === "POST" && url.pathname === "/api/pipeline/generate") {
        if (activePipeline.running) return json(res, 409, { error: "A video generation pipeline is already running." });
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as BatchPipelineRequestBody;
        try {
          await ensureActiveAccountReady();
        } catch (accErr: unknown) {
          const msg = accErr instanceof Error ? accErr.message : String(accErr);
          const code = (accErr as { code?: string })?.code || "ACCOUNT_NOT_SIGNED_IN";
          return json(res, 400, { success: false, error: msg, code, message: msg });
        }
        let resolved: ResolvedPlatformConfig;
        try {
          resolved = resolveRequestConfig(body);
        } catch (err) {
          if (err instanceof PlatformPresetError) {
            return json(res, 400, { success: false, error: err.message, code: err.code, allowed_durations: err.allowed_durations });
          }
          throw err;
        }

        const batchCount = Math.max(1, body.batch_count || 1);
        const creditCalc = calculatePipelineCredits(body, resolved);
        const totalRequiredBatch = creditCalc.total_required * batchCount;
        const state = await getFlowState(true).catch(() => getFlowState());
        const pool = getCreditPoolSummary();
        const mockHeader = (process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true") && req.headers["x-mock-credits"] !== undefined
          ? Number(req.headers["x-mock-credits"])
          : undefined;
        const available = mockHeader !== undefined ? mockHeader : (state.credits_remaining ?? 0);

        if (mockHeader === undefined && pool.total_pool_credits < creditCalc.total_required) {
          const shortage = creditCalc.total_required - pool.total_pool_credits;
          return json(res, 400, {
            error: "INSUFFICIENT_CREDITS",
            code: "INSUFFICIENT_CREDITS",
            required: creditCalc.total_required,
            available: pool.total_pool_credits,
            shortage,
            unit_cost: creditCalc.unit_cost,
            clips_count: creditCalc.clips_count,
            scene1_variants: creditCalc.scene1_variants,
            video_model: creditCalc.video_model,
            message: `Kredit Flow (seluruh akun: ${pool.total_pool_credits} cr) tidak cukup. Dibutuhkan minimal ${creditCalc.total_required} kredit.`,
          });
        }

        if (batchCount > 1) {
          void runBatchPipelineAsync(core, body, resolved);
          return json(res, 200, {
            success: true,
            batch_mode: true,
            batch_count: batchCount,
            resolved,
            pipeline: activePipeline,
            credit_check: {
              required_total: totalRequiredBatch,
              pool_available: pool.total_pool_credits,
            },
          });
        } else {
          void runPipelineAsync(core, body, resolved);
          return json(res, 200, {
            success: true,
            batch_mode: false,
            resolved,
            pipeline: activePipeline,
            credit_check: {
              required: creditCalc.total_required,
              available: state.credits_remaining,
            },
          });
        }
      }

      // Resume a Paused/Skipped Pipeline Job
      if (req.method === "POST" && url.pathname === "/api/pipeline/resume") {
        if (activePipeline.running) return json(res, 409, { error: "A video generation pipeline is already running." });
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as { job_id?: string };
        if (!body.job_id) {
          return json(res, 400, { error: "job_id diperlukan untuk melanjutkan render." });
        }
        const cp = loadCheckpoint(body.job_id);
        if (!cp) {
          return json(res, 404, { error: `Checkpoint untuk job "${body.job_id}" tidak ditemukan.` });
        }
        if (cp.status === "completed") {
          return json(res, 400, { error: "Job ini sudah selesai sebelumnya." });
        }

        void runPipelineAsync(core, cp.request_body as PipelineRequestBody, undefined, {
          resumeJobId: body.job_id,
          autoSkip: false,
        });

        return json(res, 200, {
          success: true,
          message: `Melanjutkan render job ${body.job_id} dari Scene ${(cp.completed_scenes.length || 0) + 1}...`,
          checkpoint: cp,
        });
      }

      // Batch Status API
      if (req.method === "GET" && url.pathname === "/api/pipeline/batch-status") {
        return json(res, 200, {
          success: true,
          batch: getActiveBatch(),
          pipeline: activePipeline,
        });
      }

      // Batch Cancel API
      if (req.method === "POST" && url.pathname === "/api/pipeline/batch-cancel") {
        isPipelineCancelled = true;
        const b = getActiveBatch();
        if (b) {
          b.cancelled = true;
          b.running = false;
          b.status_text = "Dibatalkan oleh pengguna";
          b.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Antrean batch dibatalkan.`);
        }
        activePipeline.status_text = "Dibatalkan";
        activePipeline.cancelled = true;
        if (currentRunningJobId) {
          try {
            await (core.cancel as unknown as (args: unknown) => Promise<unknown>)({ job_id: currentRunningJobId });
          } catch {}
        }
        return json(res, 200, { success: true, message: "Batch cancelled" });
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
