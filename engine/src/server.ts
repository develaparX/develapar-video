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
import { chooseSaveVideoPath, findFfmpeg, findFfprobe, getProductDir, getOutputDir, getEndcardDir, getDevideoBaseDir, openDirectory, normalizeProfilePath } from "./platform.js";
import { extractLastFrame } from "./chain.js";
import { createProductEndCard } from "./assemble.js";
import { ScenePlanError, buildScenePrompt, selectScenesForRun, type ScenePlanSource } from "./scene-plan.js";
import {
  PRESET_PACKS,
  STYLE_OPTIONS,
  TONE_OPTIONS,
  HOOK_LIBRARY,
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
  saveActiveBatchScripts,
  loadActiveBatchScripts,
  getCreditPoolSummary,
  findAccountForCredits,
  getActiveBatch,
  setActiveBatch,
  resetBatchAbortController,
  getBatchAbortSignal,
  abortActiveBatch,
  updateBatchItem,
  appendBatchLog,
  type PipelineCheckpoint,
  type BatchPipelineState,
  type BatchItemState,
  type SavedBatchScripts,
  type BatchPlanItem,
} from "./batch.js";
import { getFlowState, runFlowAgentScript, chatWithFlowAgent, compileScriptViaFlowAgent, resetFlowAgentSession } from "./flow.js";
import {
  PROFILES_BASE_DIR,
  createAccount,
  deleteAccount,
  ensureActiveAccountReady,
  getActiveAccount,
  getActiveProfileDir,
  getAccountLaunchStatus,
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
  // Which try the current scene is on, so the Studio can say "percobaan 1/2" instead of only "Merender Scene 2".
  scene_attempt?: number;
  scene_attempts?: number;
  // Live estimate: the Studio ticks this down every second and re-syncs on each poll, so a slow scene pushes it back
  // up instead of freezing at a number the run will obviously miss.
  started_at?: string;
  scene_started_at?: string;
  clip_durations?: number[];
  // Flow's own percentage for the clip being rendered ("0%".."100%", then "Flow is finishing the video").
  scene_progress_pct?: number | null;
  scene_progress_label?: string;
  progress?: {
    video_pct: number;
    batch_pct: number;
    scene_pct: number | null;
    scene_label?: string;
  };
  timing?: {
    elapsed_seconds: number;
    scene_elapsed_seconds: number;
    avg_scene_seconds: number;
    scenes_left: number;
    videos_left: number;
    eta_seconds: number;
    batch_eta_seconds: number;
  };
}

// Measured durations of finished scenes (seconds, pacing included), so the estimate learns from this machine instead
// of pretending every clip takes the same time. The seed matches the Studio's own estimate (35 s per Omni clip, 75 s
// per Veo) plus the queue's pacing pause between generations (25-70 s).
const TIMING_FILE = join(HOME_DIR, "timing.json");
const recentSceneSeconds: number[] = (() => {
  try {
    const parsed = JSON.parse(readFileSync(TIMING_FILE, "utf8")) as { scene_seconds?: unknown };
    return Array.isArray(parsed.scene_seconds)
      ? parsed.scene_seconds.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).slice(-40)
      : [];
  } catch {
    return [];
  }
})();

function estimateSceneSeconds(model = activePipeline.video_model ?? ""): number {
  const generation = /veo/i.test(model) ? 75 : 35;
  if (!recentSceneSeconds.length) return generation + 47;
  const recent = recentSceneSeconds.slice(-8);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function rememberSceneSeconds(seconds: number): void {
  recentSceneSeconds.push(Math.round(seconds));
  if (recentSceneSeconds.length > 40) recentSceneSeconds.shift();
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TIMING_FILE, JSON.stringify({ scene_seconds: recentSceneSeconds, updated_at: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    // A read-only home must not break rendering; the estimate just starts from the seed again next time.
  }
}

// Live timing for the Studio's countdown. Scenes already finished set the pace; the scene on screen keeps its own
// clock, so a poll after a slow clip pushes the estimate back up instead of freezing at a number the run will miss.
function pipelineTiming(batch: BatchPipelineState | null): NonNullable<PipelineState["timing"]> {
  const now = Date.now();
  const startedAt = activePipeline.started_at ? Date.parse(activePipeline.started_at) : now;
  const sceneStartedAt = activePipeline.scene_started_at ? Date.parse(activePipeline.scene_started_at) : 0;
  const avg = estimateSceneSeconds();
  const sceneElapsed = sceneStartedAt ? Math.max(0, (now - sceneStartedAt) / 1000) : 0;
  const clips = activePipeline.clips_count || 0;
  const scenesDone = Math.max(0, (activePipeline.current_scene || 0) - 1);
  const scenesLeft = Math.max(0, clips - scenesDone);
  const videosAfter = batch?.running ? Math.max(0, batch.batch_count - (batch.current_index || 0) - 1) : 0;
  // The countdown belongs to the video being rendered; the rest of the queue gets its own number, so the two never
  // contradict each other or the cost estimate.
  let eta = activePipeline.running ? Math.max(0, avg - sceneElapsed) + Math.max(0, scenesLeft - 1) * avg : 0;
  // A scene already past its average pushes the estimate out as it overruns (half of the overrun, capped at half an
  // average), so the countdown visibly grows instead of sitting on a number the run has already beaten.
  if (activePipeline.running) {
    eta += Math.min(Math.max(0, sceneElapsed - avg) * 0.5, avg * 0.5);
  }
  // While anything is still running the countdown never reads zero: the stitch at the end and a scene that is simply
  // late would otherwise look finished for minutes.
  if (activePipeline.running) {
    eta = Math.max(eta, (activePipeline.current_scene || 0) >= clips && clips > 0 ? 20 : 5);
  }
  return {
    elapsed_seconds: Math.max(0, Math.round((now - startedAt) / 1000)),
    scene_elapsed_seconds: Math.round(sceneElapsed),
    avg_scene_seconds: Math.round(avg),
    scenes_left: scenesLeft,
    videos_left: videosAfter,
    eta_seconds: Math.round(eta),
    batch_eta_seconds: Math.round(eta + videosAfter * (clips * avg + 20)),
  };
}

// Progress is weighted by how long each clip lasts, filled in with Flow's own percentage for the clip on screen, so a
// 4 s clip at 50% does not count the same as an 8 s one. "video_pct" is the video being rendered, "batch_pct" the
// whole queue; the Studio shows them separately.
function pipelineProgress(batch: BatchPipelineState | null): NonNullable<PipelineState["progress"]> {
  const durations = activePipeline.clip_durations ?? [];
  const clips = activePipeline.clips_count || durations.length || 0;
  const total = durations.reduce((sum, value) => sum + value, 0);
  const stitching = clips > 0 && (activePipeline.current_scene || 0) >= clips;
  // While stitching every clip is already on disk, so the video is as good as complete (99% until the file exists).
  const doneScenes = stitching ? clips : Math.max(0, Math.min(clips, (activePipeline.current_scene || 0) - 1));
  const doneDuration = durations.slice(0, doneScenes).reduce((sum, value) => sum + value, 0);
  const currentDuration = durations[doneScenes] ?? (total ? total / Math.max(1, clips) : 0);
  const flowFraction = (activePipeline.scene_progress_pct ?? 0) / 100;
  let videoPct = total ? ((doneDuration + (stitching ? 0 : currentDuration * flowFraction)) / total) * 100 : 0;
  if (!activePipeline.running) videoPct = activePipeline.last_video ? 100 : videoPct;
  else videoPct = Math.min(videoPct, stitching ? 99 : 98);
  const batchDone = batch ? batch.items.filter((it) => it.status === "done").length : 0;
  let batchPct = batch && batch.batch_count > 0
    ? Math.min(100, ((batchDone + videoPct / 100) / batch.batch_count) * 100)
    : videoPct;
  if (activePipeline.running) batchPct = Math.min(batchPct, 99);
  return {
    video_pct: Math.round(videoPct),
    batch_pct: Math.round(batchPct),
    scene_pct: activePipeline.scene_progress_pct ?? null,
    scene_label: activePipeline.scene_progress_label,
  };
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
  type: "think" | "status" | "content" | "batch_plan" | "batch_progress";
  text?: string;
  plan?: BatchPlanItem[];
  index?: number;
  status?: "planning" | "writing" | "done" | "failed";
  title?: string;
  error?: string;
}

export interface ScriptResult {
  title?: string;
  plan_item?: BatchPlanItem;
  error?: string;
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
  batch_count?: number;
  batch_mode?: "variations" | "theme" | "series";
  batch_theme?: string;
  batch_titles?: string[];
  batch_linked?: boolean;
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
  batch_mode?: "variations" | "theme" | "series";
  batch_theme?: string;
  batch_titles?: string[];
  batch_linked?: boolean;
  auto_skip?: boolean;
  auto_retry_end?: boolean;
  batch_scripts?: ScriptResult[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

// Some OpenAI-compatible gateways answer with a stream even when plain JSON was asked for (the desktop's own
// endpoint on :20128 does): the body is then "data: {...}" lines. Reading that as JSON failed with
// `Unexpected identifier "data"`, so the planner quietly fell back to its deterministic plan. Both shapes work here.
async function readChatCompletion(resp: Response): Promise<ChatCompletionResponse> {
  const text = await resp.text();
  if (!text.trimStart().startsWith("data:")) return JSON.parse(text) as ChatCompletionResponse;
  let streamed = "";
  let whole = "";
  for (const line of text.split(/\r?\n/)) {
    const payload = line.match(/^data:\s*(.+)$/)?.[1]?.trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const choice = chunk.choices?.[0];
      streamed += choice?.delta?.content ?? "";
      if (choice?.message?.content) whole = choice.message.content;
    } catch {
      /* a keep-alive or a partial line: the next one carries the content */
    }
  }
  const content = streamed || whole;
  if (!content) throw new Error("LLM stream carried no content");
  return { choices: [{ message: { content } }] };
}

interface GenResult {
  jobs: Array<{ id: string; scene: string }>;
}

interface WaitResult {
  finished: boolean;
  jobs: Array<{ id: string; status: string; files?: string[]; error?: string; progress?: string; attempts?: number }>;
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

export const batchPlanItemSchema = z.object({
  index: z.number(),
  title: z.string().min(1),
  angle: z.string().min(1),
  key_message: z.string().min(1),
  hook_archetype: z.enum([
    "problem_agitator",
    "price_drop_deal",
    "shock_counterintuitive",
    "relatable_pov",
    "sensory_curiosity",
    "social_proof_secret",
  ]),
  must_avoid: z.array(z.string()).default([]),
});

export const batchPlanSchema = z.array(batchPlanItemSchema);

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

export async function generateScriptWithLLM(
  body: ScriptRequestBody,
  onEvent?: (event: StreamEvent) => void,
  abortSignal?: AbortSignal,
  resolvedConfig?: ResolvedPlatformConfig,
  scriptSource: "llm" | "flow_agent" = "llm",
  planItem?: BatchPlanItem,
  batchTheme?: string
): Promise<ScriptResult> {
  const source = body.script_mode === "flow_agent" ? "flow_agent" : (body.script_mode === "custom_api" ? "llm" : scriptSource);
  const resolved = resolvedConfig ?? resolveRequestConfig(body);
  if (planItem?.hook_archetype) {
    resolved.hook_archetype = planItem.hook_archetype;
  }
  const videoModel = resolved.video_model;
  const duration = resolved.duration_target;
  const clipsCount = resolved.clips_count;
  const clipDurations = resolved.clip_durations;
  const resolvedStyle = resolved.style_id;
  const resolvedTone = resolved.tone_id;
  const resolvedPreset = resolved.preset_id;
  const images = normalizeImageAttachments(body);
  const isTheme = body.batch_mode === "theme";
  if (images.length === 0 && !isTheme) {
    throw new Error("Pilih minimal 1 foto produk terlebih dahulu.");
  }

  const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");

  if (process.env.FLOW_MOCK_LLM === "1") {
    if (planItem?.index === 1 && body.prompt === "SIMULATE_PARTIAL_FAILURE") {
      throw new Error("Simulated LLM network error on video 2");
    }

    const scenesList: ScriptScene[] = [];
    let t = 0;
    for (let i = 0; i < clipsCount; i++) {
      const dur = clipDurations[i] || 4;
      const m = Math.floor(t / 60);
      const s = t % 60;
      const timeStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      scenesList.push({
        num: i + 1,
        time: timeStr,
        duration: dur,
        title: `Scene ${i + 1}`,
        speaker: "Narrator",
        prompt: `Visual for scene ${i + 1} - ${planItem ? planItem.title : body.prompt || "theme"}`,
        script: `Narasi untuk scene ${i + 1} mengenai ${planItem ? planItem.key_message : "topik ini"}.`,
      });
      t += dur;
    }
    return {
      title: planItem?.title || body.prompt || "Mock Script Title",
      plan_item: planItem,
      product_identified: images.length > 0 ? "Mock Product" : undefined,
      product_slug: "mock-slug",
      platform_preset: resolved.platform,
      hook_type: planItem?.hook_archetype || resolved.hook_archetype || "problem_agitator",
      hook_text_3s: "Mock Hook 3s",
      retention_promise: "Mock retention",
      share_trigger: "Mock share",
      cta_mode: resolved.cta_mode,
      subject_mode: resolved.subject_mode,
      character_anchor: "A pleasant presenter",
      setting_anchor: "A warm aesthetic background",
      scenes: scenesList,
    };
  }

  let userPrompt = String(
    body.prompt ||
      (images.length > 0
        ? "Analisis seluruh foto produk terlampir, riset manfaat utamanya, dan susun naskah serta storyboard video sesuai preset/style/tone yang dipilih."
        : "Susun naskah serta storyboard video edukasi yang menarik dan berkualitas tinggi sesuai tema yang dipilih.")
  );

  if (planItem) {
    const avoidLines = planItem.must_avoid && planItem.must_avoid.length > 0
      ? planItem.must_avoid.map((m) => `- ${m}`).join("\n")
      : "- (Tidak ada batasan spesifik)";

    userPrompt = `[PANDUAN BATCH — TIAP VIDEO BERDIRI SENDIRI]:
- TEMA BERSAMA: "${batchTheme || body.batch_theme || "Umum"}"
- JUDUL VIDEO INI (VIDEO #${planItem.index + 1}): "${planItem.title}"
- SUDUT PANDANG / ANGLE: ${planItem.angle}
- PESAN KUNCI: ${planItem.key_message}
- HOOK ARCHETYPE WAJIB: ${planItem.hook_archetype}
- JANGAN BAHAS (Sudah dibahas di video lain dalam batch ini, hindari overlap materi):
${avoidLines}

[ATURAN NASKAH UTUH — WAJIB]:
Naskah ini adalah SATU video lengkap dan harus bisa dipahami tanpa menonton video lain.
- DILARANG menyebut atau mengandalkan "video sebelumnya", "video berikutnya", "part", "episode", "bagian", "lanjutan", "seperti yang tadi dibahas", "kita bahas lagi di video lain", atau kalimat sejenis.
- Setiap hook, isi, dan CTA harus selesai di video ini. Jangan menyuruh penonton pindah ke video lain untuk memahami atau menyelesaikan pesan.
- Boleh berbagi tema dengan video lain, tetapi jangan menulis kalimat yang hanya masuk akal jika video lain sudah/akan ditonton.

[BRIEF / INSTRUKSI TAMBAHAN]:
${userPrompt}`;
  }

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
    images: images.length > 0 ? images : [{ file: "product.jpg", role: "product_main" }],
  });

  const imageListSummary = images.length > 0
    ? images.map((im, idx) => `- img${idx + 1}: "${im.file}" (peran: ${im.role || "product_main"})`).join("\n")
    : "Tidak ada gambar produk terlampir (Mode Edukasi / Konseptual).";

  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: images.length > 0
        ? `INI USER PROMPT (INSTRUKSI KREATIF UTAMA):
"""
${userPrompt}
"""

[DAFTAR GAMBAR TERLAMPIR (${images.length} GAMBAR)]:
${imageListSummary}

Instruksi Eksekusi:
1. Periksa setiap gambar terlampir secara menyeluruh (baca nama produk, merek, komposisi, izin edar, bentuk sediaan, dan detail visual).
2. Buat tepat ${clipsCount} scene untuk durasi klip total ${resolved.clip_total} detik${resolved.endcard_seconds > 0 ? `; total video ${duration} detik termasuk end-card statis ${resolved.endcard_seconds} detik` : ""}.
3. Kembalikan hanya raw JSON valid sesuai struktur schema yang diminta.`
        : `INI USER PROMPT (INSTRUKSI KREATIF UTAMA):
"""
${userPrompt}
"""

[MODE KONTEN EDUKASI — TANPA FOTO PRODUK]:
Tidak ada foto produk terlampir. Buat naskah murni konten edukatif/informatif/menghibur sesuai tema di atas. DILARANG MENCIPTAKAN ATAU MEMPROMOSIKAN PRODUK/MEREK FIKTIF APA PUN.

Instruksi Eksekusi:
1. Buat tepat ${clipsCount} scene untuk durasi klip total ${resolved.clip_total} detik${resolved.endcard_seconds > 0 ? `; total video ${duration} detik termasuk end-card statis ${resolved.endcard_seconds} detik` : ""}.
2. Kembalikan hanya raw JSON valid sesuai struktur schema yang diminta.`
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
    title: planItem?.title || undefined,
    plan_item: planItem || undefined,
    thinking: thinkingCollected.trim() || undefined,
    product_identified: images.length > 0 ? productIdentified : undefined,
    product_slug: productSlug || undefined,
    product_category: productCategory || undefined,
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

function buildBatchScriptsFromBase(
  baseScript: ScriptResult,
  batchCount: number,
  batchMode: "variations" | "series" | "theme",
  resolved: ResolvedPlatformConfig,
  voiceLanguage = "Bahasa Indonesia"
): ScriptResult[] {
  if (batchCount <= 1) return [baseScript];

  const hookArchetypes: HookArchetype[] = [
    "problem_agitator",
    "shock_counterintuitive",
    "price_drop_deal",
    "relatable_pov",
    "sensory_curiosity",
  ];
  const baseArch = baseScript.hook_type as HookArchetype | undefined;
  const orderedArchetypes = [
    ...hookArchetypes.filter((a) => a !== baseArch),
    ...(baseArch ? [baseArch] : []),
  ];

  const cameraAngles = [
    "Extreme close-up macro reveal transitioning to medium shot",
    "Dynamic over-the-shoulder POV shot focusing on immediate reaction",
    "Low-angle hero product framing with natural morning light",
    "Fast eye-level handheld documentary angle capturing authentic moment",
    "Side-profile tracking shot revealing the product in active daily use",
  ];

  const updatePromptAudio = (origPrompt: string, newScript: string, persona: string, speaker?: string) => {
    const cleanVisual = origPrompt.replace(/\s*Audio:\s*Voiceover[\s\S]*$/i, "").trim();
    const speakerDesc = speaker ? `${speaker} (${persona})` : persona;
    return `${cleanVisual} Audio: Voiceover in ${voiceLanguage} by ${speakerDesc} speaking: '${newScript}'`;
  };

  const firstScript: ScriptResult = batchMode === "variations"
    ? {
        ...baseScript,
        scenes: baseScript.scenes.map((s) => {
          const cleanTitle = s.title.replace(/^\[(Part|Variasi|Topik|Video)\s+\d+[^\]]*\]\s*(Scene\s*\d+:\s*)?/i, "");
          return {
            ...s,
            title: `[Variasi 1] ${cleanTitle}`,
          };
        }),
      }
    : {
        ...baseScript,
        scenes: baseScript.scenes.map((s) => {
          const cleanTitle = s.title.replace(/^\[(Part|Variasi|Topik|Video)\s+\d+[^\]]*\]\s*(Scene\s*\d+:\s*)?/i, "");
          return {
            ...s,
            title: `[Video 1] ${cleanTitle}`,
          };
        }),
      };

  const results: ScriptResult[] = [firstScript];
  const persona = baseScript.voiceover_persona || `Warm, natural narrator speaking ${voiceLanguage}`;

  for (let i = 1; i < batchCount; i++) {
    const hookArch = orderedArchetypes[(i - 1) % orderedArchetypes.length];
    const categoryHooks = HOOK_LIBRARY.filter((h) => h.category === resolved.hook_category && h.archetype === hookArch);
    const hookTpl = categoryHooks[0] || HOOK_LIBRARY.find((h) => h.archetype === hookArch) || HOOK_LIBRARY[i % HOOK_LIBRARY.length];
    const camAngle = cameraAngles[(i - 1) % cameraAngles.length];

    const clonedScenes = baseScript.scenes.map((s, idx) => {
      const cleanTitle = s.title.replace(/^\[(Part|Variasi|Topik|Video)\s+\d+[^\]]*\]\s*(Scene\s*\d+:\s*)?/i, "");
      let sceneTitle = cleanTitle;
      let scenePrompt = s.prompt;
      let sceneScript = s.script;

      if (batchMode === "variations") {
        sceneTitle = `[Variasi ${i + 1}] ${cleanTitle}`;
      } else {
        sceneTitle = `[Video ${i + 1}] ${cleanTitle}`;
      }

      if (idx === 0 && hookTpl) {
        sceneScript = `${hookTpl.hook_text_3s} ${s.script}`;
        const visualOnly = s.prompt.replace(/\s*Audio:\s*Voiceover[\s\S]*$/i, "").trim();
        scenePrompt = updatePromptAudio(`${camAngle}. ${visualOnly}`, sceneScript, persona, s.speaker);
      }

      return {
        ...s,
        title: sceneTitle,
        prompt: scenePrompt,
        script: sceneScript,
        hook_type: idx === 0 ? hookArch : s.hook_type,
        hook_text_3s: idx === 0 ? (hookTpl?.hook_text_3s || s.hook_text_3s) : s.hook_text_3s,
        retention_promise: idx === 0 ? (hookTpl?.retention_promise || s.retention_promise) : s.retention_promise,
        share_trigger: idx === 0 ? (hookTpl?.share_trigger || s.share_trigger) : s.share_trigger,
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

export function buildDeterministicBatchPlan(
  theme: string,
  n: number,
  mode: "variations" | "theme" | "series",
  titles?: string[],
  _linked = true
): BatchPlanItem[] {
  const archetypes: HookArchetype[] = [
    "problem_agitator",
    "shock_counterintuitive",
    "relatable_pov",
    "sensory_curiosity",
    "price_drop_deal",
    "social_proof_secret",
  ];

  const defaultAngles = [
    "Masalah & Solusi Utama",
    "Mitos vs Fakta Tersembunyi",
    "Sudut Pandang Keseharian",
    "Eksplorasi Detail Menarik",
    "Nilai Tambah & Rekomendasi",
    "Rahasia Praktis",
  ];

  const plan: BatchPlanItem[] = [];
  const cleanTheme = theme.trim() || "Konten Edukasi";
  const usedTitles = new Set<string>();

  for (let i = 0; i < n; i++) {
    const arch = archetypes[i % archetypes.length];
    const userTitle = titles && titles[i] && titles[i].trim() ? titles[i].trim() : "";
    let candidateTitle = userTitle || `${cleanTheme} — ${defaultAngles[i % defaultAngles.length]}`;
    if (usedTitles.has(candidateTitle.toLowerCase())) {
      candidateTitle = `${candidateTitle} (Video ${i + 1})`;
    }
    usedTitles.add(candidateTitle.toLowerCase());

    const angle = defaultAngles[i % defaultAngles.length];
    const key_message = `Poin utama ke-${i + 1} mengenai ${cleanTheme} (${angle})`;
    const must_avoid = plan.map((p) => p.key_message);

    const item: BatchPlanItem = {
      index: i,
      title: candidateTitle,
      angle,
      key_message,
      hook_archetype: arch,
      must_avoid,
    };

    plan.push(item);
  }

  return plan;
}

export async function planBatchWithLLM(
  body: ScriptRequestBody,
  n: number,
  mode: "variations" | "theme" | "series",
  resolved?: ResolvedPlatformConfig,
  abortSignal?: AbortSignal
): Promise<BatchPlanItem[]> {
  const theme = (body.batch_theme || body.prompt || "Konten Edukasi").trim();
  // Every video in a batch is a complete script on its own. The old "linked" option made video 2/3 expect
  // video 1 to have been watched, which breaks a batch uploaded as separate posts.
  const linked = false;
  const userTitles = body.batch_titles?.filter((t) => typeof t === "string" && t.trim().length > 0);

  if (process.env.FLOW_MOCK_LLM === "1") {
    return buildDeterministicBatchPlan(theme, n, mode, userTitles, linked);
  }

  const apiKey = body.api_key || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  let endpoint = body.endpoint || "https://generativelanguage.googleapis.com/v1beta/openai";
  if (!endpoint.endsWith("/chat/completions")) {
    endpoint = endpoint.replace(/\/+$/, "") + "/chat/completions";
  }
  const model = body.model || "gemini-2.5-flash";

  if (!apiKey) {
    return buildDeterministicBatchPlan(theme, n, mode, userTitles, linked);
  }

  const promptText = `Anda adalah Content Strategist & Video Planner profesional.
Tugas Anda adalah membuat rencana outline terstruktur untuk ${n} video bertema:
"""
TEMA UTAMA: "${theme}"
MODE: ${mode === "series" ? "Seri tema berurutan (tiap video tetap utuh)" : "Satu Tema, Judul Berbeda (Multi-Naskah Independen)"}
SALING NYAMBUNG: TIDAK. Setiap video adalah naskah lengkap yang berdiri sendiri dan tidak boleh mengandalkan video lain.
${userTitles && userTitles.length > 0 ? `JUDUL DARI PENGGUNA (WAJIB DIGUNAKAN UNTUK VIDEO 1..${userTitles.length}):\n${userTitles.map((t, idx) => `Video ${idx + 1}: "${t}"`).join("\n")}` : ""}
"""

ATURAN PERENCANAAN:
1. Buat tepat ${n} item rencana video (index 0 sampai ${n - 1}).
2. Judul ("title") setiap video WAJIB UNIK dan menarik perhatian. DILARANG membuat judul yang sama atau hanya beda nomor.
3. Angle (sudut pandang) dan Pesan Kunci ("key_message") antar video TIDAK BOLEH overlap.
4. Hook Archetype ("hook_archetype") WAJIB BEDA untuk tiap video. Pilih dari:
   "problem_agitator", "price_drop_deal", "shock_counterintuitive", "relatable_pov", "sensory_curiosity", "social_proof_secret".
5. Field "must_avoid": array of string berisi poin-poin/pesan kunci video LAIN agar video ini tidak membahas hal yang sama.
6. Setiap video harus utuh: jangan menulis judul, angle, atau pesan kunci yang menyuruh penonton melanjutkan ke video lain. DILARANG memakai kata "part", "episode", "bagian", "lanjutan", "video sebelumnya", atau "video berikutnya".
7. Field "link_from_prev" dan "link_to_next" tidak dipakai; jangan sertakan.

KEMBALIKAN HANYA RAW JSON VALID BERUPA ARRAY OF OBJECT:
[
  {
    "index": 0,
    "title": "...",
    "angle": "...",
    "key_message": "...",
    "hook_archetype": "problem_agitator",
    "must_avoid": ["..."]
  }
]`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          messages: [
            { role: "system", content: "You are a professional video content planner. Output ONLY a valid JSON array matching the required schema." },
            { role: "user", content: promptText },
          ],
        }),
        signal: abortSignal,
      });

      if (!resp.ok) {
        throw new Error(`LLM API returned status ${resp.status}`);
      }

      const data = await readChatCompletion(resp);
      const content = data.choices?.[0]?.message?.content || "";
      const rawJson = parseJsonFromLlmOutput(content);
      const validated = batchPlanSchema.parse(rawJson);

      if (validated.length < n) {
        throw new Error(`Planner returned ${validated.length} items, expected ${n}`);
      }

      // Enforce unique titles
      const titlesSeen = new Set<string>();
      for (const item of validated) {
        const norm = item.title.trim().toLowerCase();
        if (titlesSeen.has(norm)) {
          throw new Error(`Judul duplikat ditemukan dalam rencana: "${item.title}"`);
        }
        titlesSeen.add(norm);
      }

      return validated.slice(0, n);
    } catch (err: unknown) {
      if (attempt === 1 || (abortSignal && abortSignal.aborted)) {
        console.warn(`[planBatchWithLLM] Fallback to deterministic plan after error:`, err);
        return buildDeterministicBatchPlan(theme, n, mode, userTitles, linked);
      }
    }
  }

  return buildDeterministicBatchPlan(theme, n, mode, userTitles, linked);
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rewriteScene1WithLLM(
  baseScript: ScriptResult,
  targetArchetypes: HookArchetype[],
  body: ScriptRequestBody,
  resolved: ResolvedPlatformConfig,
  abortSignal?: AbortSignal
): Promise<Array<{
  hook_archetype: HookArchetype;
  hook_text_3s: string;
  retention_promise: string;
  share_trigger: string;
  prompt: string;
  script: string;
}> | null> {
  if (targetArchetypes.length === 0) return [];
  if (process.env.FLOW_MOCK_LLM === "1") {
    return targetArchetypes.map((arch) => {
      const hookTpl = HOOK_LIBRARY.find((h) => h.archetype === arch) || HOOK_LIBRARY[0];
      return {
        hook_archetype: arch,
        hook_text_3s: hookTpl.hook_text_3s,
        retention_promise: hookTpl.retention_promise,
        share_trigger: hookTpl.share_trigger,
        prompt: `${baseScript.scenes[0].prompt} (Rewritten for ${arch})`,
        script: `${hookTpl.hook_text_3s} ${baseScript.scenes[0].script}`,
      };
    });
  }

  const apiKey = body.api_key || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  let endpoint = body.endpoint || "https://generativelanguage.googleapis.com/v1beta/openai";
  if (!endpoint.endsWith("/chat/completions")) {
    endpoint = endpoint.replace(/\/+$/, "") + "/chat/completions";
  }
  const model = body.model || "gemini-2.5-flash";

  if (!apiKey) return null;

  const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");
  const persona = baseScript.voiceover_persona || `Warm, natural narrator speaking ${voiceLanguage}`;
  const scene1 = baseScript.scenes[0];
  if (!scene1) return null;

  const promptText = `Anda adalah copywriter video viral TikTok / Reels.
Diberikan Scene 1 (Hook pembuka) dari naskah video berikut:
- Narasi (Script): "${scene1.script}"
- Visual Prompt: "${scene1.prompt}"
- Durasi: ${scene1.duration} detik
- Persona Voiceover: ${persona}
- Bahasa: ${voiceLanguage}

Tulis ulang Scene 1 untuk masing-masing dari ${targetArchetypes.length} Hook Archetype berikut agar memiliki sudut pandang hook yang segar dan memikat:
${targetArchetypes.map((a, i) => `${i + 1}. ${a}`).join("\n")}

KEMBALIKAN HANYA RAW JSON VALID BERUPA ARRAY OF OBJECT:
[
  {
    "hook_archetype": "...",
    "hook_text_3s": "Hook pembuka 3 detik pertama (maks 7 kata)",
    "retention_promise": "Alasan audiens menonton terus",
    "share_trigger": "Alasan audiens membagikan video",
    "prompt": "Deskripsi visual prompt bahasa Inggris lengkap dengan Audio: Voiceover...",
    "script": "Naskah narasi lengkap scene 1 dalam ${voiceLanguage}"
  }
]`;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: [
          { role: "system", content: "You are a specialized hook rewrite assistant. Output ONLY a valid JSON array." },
          { role: "user", content: promptText },
        ],
      }),
      signal: abortSignal,
    });

    if (!resp.ok) return null;
    const data = await readChatCompletion(resp);
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromLlmOutput(content);
    if (Array.isArray(parsed) && parsed.length >= targetArchetypes.length) {
      return parsed.map((item, idx) => ({
        hook_archetype: targetArchetypes[idx] || (item.hook_archetype as HookArchetype),
        hook_text_3s: String(item.hook_text_3s || ""),
        retention_promise: String(item.retention_promise || ""),
        share_trigger: String(item.share_trigger || ""),
        prompt: String(item.prompt || scene1.prompt),
        script: String(item.script || scene1.script),
      }));
    }
  } catch (err) {
    console.warn("[rewriteScene1WithLLM] Failed rewrite call, will use fallback:", err);
  }
  return null;
}

export interface GenerateBatchScriptsResult {
  scripts: ScriptResult[];
  plan?: BatchPlanItem[];
  theme?: string;
  linked?: boolean;
}

export async function generateBatchScriptsWithLLM(
  body: ScriptRequestBody,
  batchCount: number,
  batchMode: "variations" | "theme" | "series",
  onEvent?: (event: StreamEvent) => void,
  abortSignal?: AbortSignal,
  resolvedConfig?: ResolvedPlatformConfig,
  mode: "llm" | "flow_agent" = "llm"
): Promise<GenerateBatchScriptsResult> {
  const resolved = resolvedConfig ?? resolveRequestConfig(body);
  const images = normalizeImageAttachments(body);
  const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");
  const theme = (body.batch_theme || body.prompt || "Umum").trim();
  // Batch videos are independent: each script is complete on its own, so no "lanjutan" between videos.
  const linked = false;
  const batchId = "batch_" + randomBytes(4).toString("hex");

  if (batchCount <= 1) {
    const single = await generateScriptWithLLM(body, onEvent, abortSignal, resolved, mode);
    saveActiveBatchScripts({
      batch_id: batchId,
      batch_mode: batchMode,
      batch_count: 1,
      duration_target: resolved.duration_target,
      platform_preset: resolved.platform,
      video_model: resolved.video_model,
      theme,
      linked,
      scripts: [single as unknown as Record<string, unknown>],
      updated_at: new Date().toISOString(),
    });
    return { scripts: [single], theme, linked };
  }

  // --- MODE: THEME ---
  if (batchMode === "theme") {
    onEvent?.({ type: "status", text: `Merancang outline ${batchCount} naskah bertema "${theme}"...` });
    const plan = await planBatchWithLLM(body, batchCount, "theme", resolved, abortSignal);
    onEvent?.({ type: "batch_plan", plan });

    const scripts = await runWithConcurrency(plan, 2, async (planItem) => {
      if (abortSignal?.aborted) {
        throw new Error("Batch dibatalkan oleh pengguna");
      }
      onEvent?.({
        type: "batch_progress",
        index: planItem.index,
        status: "writing",
        title: planItem.title,
      });

      try {
        const script = await generateScriptWithLLM(
          body,
          undefined,
          abortSignal,
          resolved,
          mode,
          planItem,
          theme
        );
        script.title = planItem.title;
        script.plan_item = planItem;
        onEvent?.({
          type: "batch_progress",
          index: planItem.index,
          status: "done",
          title: planItem.title,
        });
        return script;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent?.({
          type: "batch_progress",
          index: planItem.index,
          status: "failed",
          title: planItem.title,
          error: errorMsg,
        });
        const failedScript: ScriptResult = {
          title: planItem.title,
          plan_item: planItem,
          error: errorMsg,
          scenes: [],
          character_anchor: "",
          setting_anchor: "",
        };
        return failedScript;
      }
    });

    const validScripts = scripts.filter((s) => !s.error && s.scenes.length > 0);
    if (validScripts.length === 0) {
      throw new Error(`Semua ${batchCount} naskah tema gagal dibuat: ${scripts[0]?.error || "Unknown error"}`);
    }

    saveActiveBatchScripts({
      batch_id: batchId,
      batch_mode: "theme",
      batch_count: batchCount,
      duration_target: resolved.duration_target,
      platform_preset: resolved.platform,
      video_model: resolved.video_model,
      theme,
      linked,
      plan,
      scripts: scripts as unknown as Array<Record<string, unknown>>,
      updated_at: new Date().toISOString(),
    });

    return { scripts, plan, theme, linked };
  }

  // --- MODE: SERIES ---
  if (batchMode === "series") {
    onEvent?.({ type: "status", text: `Merancang ${batchCount} naskah video dengan seri tema yang sama...` });
    const plan = await planBatchWithLLM(body, batchCount, "series", resolved, abortSignal);
    onEvent?.({ type: "batch_plan", plan });

    const scripts: ScriptResult[] = [];

    for (let i = 0; i < plan.length; i++) {
      if (abortSignal?.aborted) {
        throw new Error("Batch dibatalkan oleh pengguna");
      }
      const planItem = plan[i];
      onEvent?.({
        type: "batch_progress",
        index: planItem.index,
        status: "writing",
        title: planItem.title,
      });

      try {
        const script = await generateScriptWithLLM(
          body,
          undefined,
          abortSignal,
          resolved,
          mode,
          planItem,
          theme
        );
        script.title = planItem.title;
        script.plan_item = planItem;
        scripts.push(script);

        onEvent?.({
          type: "batch_progress",
          index: planItem.index,
          status: "done",
          title: planItem.title,
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent?.({
          type: "batch_progress",
          index: planItem.index,
          status: "failed",
          title: planItem.title,
          error: errorMsg,
        });
        scripts.push({
          title: planItem.title,
          plan_item: planItem,
          error: errorMsg,
          scenes: [],
          character_anchor: "",
          setting_anchor: "",
        });
      }
    }

    const validScripts = scripts.filter((s) => !s.error && s.scenes.length > 0);
    if (validScripts.length === 0) {
      throw new Error(`Semua ${batchCount} naskah series gagal dibuat: ${scripts[0]?.error || "Unknown error"}`);
    }

    saveActiveBatchScripts({
      batch_id: batchId,
      batch_mode: "series",
      batch_count: batchCount,
      duration_target: resolved.duration_target,
      platform_preset: resolved.platform,
      video_model: resolved.video_model,
      theme,
      linked,
      plan,
      scripts: scripts as unknown as Array<Record<string, unknown>>,
      updated_at: new Date().toISOString(),
    });

    return { scripts, plan, theme, linked };
  }

  // --- MODE: VARIATIONS ---
  onEvent?.({ type: "status", text: `Menyusun naskah dasar dan variasi ${batchCount} hook...` });
  const baseScript = await generateScriptWithLLM(body, onEvent, abortSignal, resolved, mode);
  baseScript.title = "Variasi 1";

  const allArchetypes: HookArchetype[] = [
    "problem_agitator",
    "shock_counterintuitive",
    "relatable_pov",
    "price_drop_deal",
    "sensory_curiosity",
    "social_proof_secret",
  ];
  const baseArch = (baseScript.hook_type as HookArchetype) || "problem_agitator";
  const targetArchetypes = allArchetypes.filter((a) => a !== baseArch).slice(0, batchCount - 1);

  let results: ScriptResult[] | null = null;
  const rewritten = await rewriteScene1WithLLM(baseScript, targetArchetypes, body, resolved, abortSignal);
  if (rewritten && rewritten.length === targetArchetypes.length) {
    results = [
      {
        ...baseScript,
        scenes: baseScript.scenes.map((s) => ({
          ...s,
          title: `[Variasi 1] ${s.title.replace(/^\[Variasi\s+\d+[^\]]*\]\s*/i, "")}`,
        })),
      },
    ];

    for (let i = 0; i < rewritten.length; i++) {
      const rw = rewritten[i];
      const clonedScenes = baseScript.scenes.map((s, idx) => {
        if (idx === 0) {
          return {
            ...s,
            title: `[Variasi ${i + 2}] Scene 1`,
            prompt: rw.prompt,
            script: rw.script,
            hook_type: rw.hook_archetype,
            hook_text_3s: rw.hook_text_3s,
            retention_promise: rw.retention_promise,
            share_trigger: rw.share_trigger,
          };
        }
        return {
          ...s,
          title: `[Variasi ${i + 2}] ${s.title.replace(/^\[Variasi\s+\d+[^\]]*\]\s*/i, "")}`,
        };
      });

      results.push({
        ...baseScript,
        title: `Variasi ${i + 2}`,
        hook_type: rw.hook_archetype,
        hook_text_3s: rw.hook_text_3s,
        retention_promise: rw.retention_promise,
        share_trigger: rw.share_trigger,
        scenes: clonedScenes,
      });
    }
  }

  // Fallback if LLM rewrite failed
  if (!results) {
    results = buildBatchScriptsFromBase(baseScript, batchCount, "variations", resolved, voiceLanguage);
  }

  saveActiveBatchScripts({
    batch_id: batchId,
    batch_mode: "variations",
    batch_count: batchCount,
    duration_target: resolved.duration_target,
    platform_preset: resolved.platform,
    video_model: resolved.video_model,
    theme,
    linked,
    scripts: results as unknown as Array<Record<string, unknown>>,
    updated_at: new Date().toISOString(),
  });

  return { scripts: results, theme, linked };
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
    // ffprobe is not bundled on Windows (the bootstrap kept only ffmpeg.exe), and without it every clip looked silent,
    // so each finished video was silent too even though Flow's clips carry native audio. ffmpeg answers the same
    // question and is always there, since the stitch needs it anyway.
    try {
      const { stderr } = await run(findFfmpeg(), ["-hide_banner", "-i", file]);
      return /Stream #\d+:\d+.*: Audio:/.test(stderr);
    } catch (err) {
      // `ffmpeg -i` prints the streams and then fails with "At least one output file must be specified": the streams
      // are still in the error's stderr, which is exactly what we need.
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return /Stream #\d+:\d+.*: Audio:/.test(stderr);
    }
  }
}


interface StitchOptions {
  contentClips: string[];
  contentDurations: number[];
  outputPath: string;
  totalDuration: number;
  endcardPath?: string;
  endcardDuration?: number;
}

// Duration of a clip as the file actually is: Flow returns slightly less than requested (an "8 s" clip is often
// 7.93 s), and the silence written for a clip without audio has to match its picture or the join drifts.
async function clipDurationSeconds(file: string): Promise<number> {
  const read = (text: string) => {
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  };
  try {
    const { stderr } = await run(findFfmpeg(), ["-hide_banner", "-i", file]);
    return read(stderr);
  } catch (err) {
    return read((err as { stderr?: string }).stderr ?? "");
  }
}

// Clips are joined end to end exactly as Flow produced them: no crossfade, no per-clip re-timing and no frozen
// frames. Every clip is only normalised to the output frame (1080x1920, 24 fps, yuv420p) and the finished file is
// capped at the requested duration once, which keeps the joins clean.
async function stitchFinalVideo(o: StitchOptions): Promise<void> {
  if (o.contentClips.length === 0) throw new Error("Tidak ada klip konten untuk digabungkan.");
  const endcardDuration = Math.max(0, o.endcardDuration ?? 0);
  const hasAudio = await Promise.all(o.contentClips.map((clip) => clipHasAudioTrack(clip)));
  const actualDurations = await Promise.all(o.contentClips.map((clip) => clipDurationSeconds(clip)));
  const inputs = [...o.contentClips];
  if (o.endcardPath && endcardDuration > 0) inputs.push(o.endcardPath);
  // Flow's clips come back a few frames short of the length asked for (an "10 s" clip is often 9.93 s). Holding the
  // last frame for that remainder keeps the promised duration without touching any join.
  const actualContent = actualDurations.reduce((sum, value) => sum + (value || 0), 0);
  const shortfall = Math.max(0, o.totalDuration - (actualContent + endcardDuration));
  const tailPad = shortfall > 0.01 && shortfall < 2 ? shortfall : 0;

  const filters: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const lastContent = i === o.contentClips.length - 1 && o.contentClips.length > 0;
    const pad = lastContent && tailPad > 0 ? `,tpad=stop_mode=clone:stop_duration=${tailPad.toFixed(3)}` : "";
    filters.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24${pad},format=yuv420p[v${i}]`,
    );
    if (i >= o.contentClips.length) {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${endcardDuration.toFixed(3)}[a${i}]`);
    } else if (hasAudio[i]) {
      const audioPad = lastContent && tailPad > 0 ? `,apad=pad_dur=${tailPad.toFixed(3)}` : "";
      filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS${audioPad}[a${i}]`);
    } else {
      const silence = actualDurations[i] || o.contentDurations[i] || 10;
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${silence.toFixed(3)}[a${i}]`);
    }
  }
  filters.push(`${inputs.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);

  const args = ["-y"];
  for (const input of inputs) args.push("-i", input);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-t", o.totalDuration.toFixed(3),
    o.outputPath,
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
  activePipeline.started_at = new Date().toISOString();
  activePipeline.scene_started_at = undefined;
  activePipeline.scene_attempt = undefined;
  activePipeline.scene_attempts = undefined;
  activePipeline.clip_durations = [...clipDurations];
  activePipeline.scene_progress_pct = null;
  activePipeline.scene_progress_label = undefined;
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

    // Checkpoint restoration check
    let resumedCheckpoint: PipelineCheckpoint | null = null;
    if (opts?.resumeJobId) {
      resumedCheckpoint = loadCheckpoint(opts.resumeJobId);
    }

    const downloadedClips: string[] = [];
    const downloadedClipDurations: number[] = [];
    let endCardPath: string | undefined;
    let endCardDuration = 0;
    const savedScriptObj = resumedCheckpoint?.script_data as Partial<ScriptResult> | undefined;
    // Scenes from a preview request are authoritative. If they are short we say so instead of quietly writing a new
    // script and throwing the user's edits away. Batch runners copy scenes from their own generated scripts, so their
    // scenes may still be regenerated here (opts.batchId).
    const requestedScenes = Array.isArray(body.scenes) ? body.scenes : [];
    const usesRequestedScenes = requestedScenes.length > 0;
    let scenes: ScriptScene[] | undefined = usesRequestedScenes ? requestedScenes : savedScriptObj?.scenes;
    let characterAnchor = String(body.character_anchor || savedScriptObj?.character_anchor || "");
    let settingAnchor = String(body.setting_anchor || savedScriptObj?.setting_anchor || "");
    const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");
    let voiceoverPersona = String(body.voiceover_persona || savedScriptObj?.voiceover_persona || `Warm, natural narrator speaking ${voiceLanguage}`);
    let pipelineStyle = String(body.style || savedScriptObj?.style || "cinematic");

    let draft: ScriptResult | null = null;
    if (!Array.isArray(scenes) || scenes.length < clipsCount) {
      if (usesRequestedScenes && !opts?.batchId) {
        throw new ScenePlanError(clipsCount, requestedScenes.length, "request");
      }
      activePipeline.status_text = "Menyusun naskah & storyboard otomatis via AI...";
      activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] Menyusun naskah otomatis (${clipsCount} scene)...`);
      draft = await generateScriptWithLLM(body, undefined, undefined, resolved);
      scenes = draft.scenes;
      characterAnchor = characterAnchor || draft.character_anchor;
      settingAnchor = settingAnchor || draft.setting_anchor;
      if (draft.voiceover_persona) voiceoverPersona = draft.voiceover_persona;
      if (draft.style) pipelineStyle = draft.style;

      if (scenes.length < clipsCount) {
        activePipeline.logs.push(
          `[${new Date().toLocaleTimeString()}] ⚠️ AI mengembalikan ${scenes.length} scene, padahal dibutuhkan ${clipsCount}. Menyusun ulang sekali lagi...`
        );
        const retry = await generateScriptWithLLM(body, undefined, undefined, resolved);
        if (retry.scenes.length < clipsCount) {
          throw new ScenePlanError(clipsCount, retry.scenes.length, "llm");
        }
        draft = retry;
        scenes = retry.scenes;
        characterAnchor = characterAnchor || retry.character_anchor;
        settingAnchor = settingAnchor || retry.setting_anchor;
        if (retry.voiceover_persona) voiceoverPersona = retry.voiceover_persona;
        if (retry.style) pipelineStyle = retry.style;
      }
    }

    const sceneSource: ScenePlanSource = draft
      ? "llm"
      : usesRequestedScenes && !opts?.batchId
        ? "request"
        : resumedCheckpoint
          ? "checkpoint"
          : "llm";
    const sceneSelection = selectScenesForRun(scenes, clipsCount, sceneSource);
    const scenesToRun = sceneSelection.scenes;
    if (sceneSelection.dropped.length > 0) {
      const totalScenes = sceneSelection.scenes.length + sceneSelection.dropped.length;
      activePipeline.logs.push(
        `[${new Date().toLocaleTimeString()}] ℹ️ Naskah berisi ${totalScenes} scene; hanya ${clipsCount} scene pertama dipakai (${duration}s).`
      );
    }
    const currentScriptData: Record<string, unknown> = {
      product_identified: body.product_identified || draft?.product_identified || savedScriptObj?.product_identified || "",
      product_slug: body.product_slug || draft?.product_slug || savedScriptObj?.product_slug || "",
      hook_type: body.hook_type || draft?.hook_type || scenesToRun[0]?.hook_type || "",
      hook_text_3s: body.hook_text_3s || draft?.hook_text_3s || scenesToRun[0]?.hook_text_3s || "",
      character_anchor: characterAnchor,
      setting_anchor: settingAnchor,
      voiceover_persona: voiceoverPersona,
      style: pipelineStyle,
      scenes: scenesToRun,
    };

    if (resumedCheckpoint && resumedCheckpoint.completed_clips.length > 0) {
      // Never reuse more clips than this duration's plan: a checkpoint from another plan must not leak into the stitch.
      const resumableClips = Math.min(resumedCheckpoint.completed_clips.length, clipsCount);
      for (let c = 0; c < resumableClips; c++) {
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

    // Persist checkpoint with full script_data before Scene 1 starts so script is never lost
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
      script_data: currentScriptData,
      request_body: { ...body, scenes: scenesToRun, character_anchor: characterAnchor, setting_anchor: settingAnchor, voiceover_persona: voiceoverPersona, style: pipelineStyle } as Record<string, unknown>,
      created_at: resumedCheckpoint?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

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

    // One attempt plus one retry, then the pipeline stops and waits for the user's own "Lanjutkan": a scene that keeps
    // failing costs credits per attempt, so the engine never keeps spending on its own.
    const MAX_SCENE_ATTEMPTS = 2;
    // Each attempt is capped at 10 minutes of Flow work plus room for the pacing pause and the download.
    const ATTEMPT_TIMEOUT_MS = 12 * 60_000;

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
      if (opts?.batchId && opts?.videoIndex !== undefined) {
        updateBatchItem(opts.batchId, opts.videoIndex, {
          current_scene: sceneNum,
        });
      }

      let sceneSuccess = false;
      let sceneError: Error | null = null;
      let clipFile: string | null = null;
      let candidateFiles: string[] = [];

      for (let attempt = 1; attempt <= MAX_SCENE_ATTEMPTS; attempt++) {
        activePipeline.scene_attempt = attempt;
        activePipeline.scene_attempts = MAX_SCENE_ATTEMPTS;
        activePipeline.scene_started_at = new Date().toISOString();
        activePipeline.scene_progress_pct = null;
        activePipeline.scene_progress_label = undefined;
        let sceneStalled = false;
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

          const durationNote = generationDuration === plannedClipDuration
            ? `${generationDuration}s`
            : `${generationDuration}s (rencana ${plannedClipDuration}s)`;
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] Scene ${sceneNum}/${clipsCount} (generate ${durationNote}, ${finalSceneRefs.length} ref img${previousLastFrame ? " + continuity start frame" : ""}) dikirim ke Google Flow [${videoModel}]`
          );

          const hierarchicalPrompt = buildScenePrompt({
            sceneNum,
            clipsCount,
            prompt: s.prompt,
            script: s.script,
            speaker: s.speaker,
            voiceLanguage,
            voiceoverPersona,
            characterAnchor,
            settingAnchor,
            storylineOverview,
          });

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
          // A job that never settles used to keep this loop (and the Flow lock) busy for ever, which looked exactly
          // like the pipeline looping: the UI polled a scene that would never finish and nothing said why. Flow's own
          // wait is 10 minutes now, so this only covers the pacing pause and the download.
          const sceneDeadline = Date.now() + ATTEMPT_TIMEOUT_MS;
          let missingPolls = 0;

          while (!completed) {
            if (isPipelineCancelled) {
              if (job?.id) {
                try {
                  await (core.cancel as unknown as (args: unknown) => Promise<unknown>)({ job_id: job.id });
                } catch {}
              }
              throw new Error("Generasi video dibatalkan oleh pengguna.");
            }
            if (Date.now() > sceneDeadline) {
              await (core.cancel as unknown as (args: unknown) => Promise<unknown>)({ job_id: job.id }).catch(() => {});
              sceneStalled = true;
              throw new Error(
                `Scene ${sceneNum} tidak selesai dalam ${Math.round(ATTEMPT_TIMEOUT_MS / 60_000)} menit; job ${job.id} dihentikan. Cek tab Flow atau lanjutkan dari checkpoint.`,
              );
            }

            const waitRes = (await (core.wait as unknown as (args: unknown) => Promise<WaitResult>)({ job_ids: [job.id], timeout_seconds: 4 }));
            const current = waitRes.jobs.find((j) => j.id === job.id);
            // Flow prints its own 0-100% on the tile; carry it through so the Studio can show real progress instead of
            // guessing from "scene 3 of 5".
            const flowPct = Number(/(\d+)%/.exec(current?.progress ?? "")?.[1]);
            activePipeline.scene_progress_pct = Number.isFinite(flowPct) ? Math.min(100, flowPct) : null;
            activePipeline.scene_progress_label = current?.progress;
            if (!current) {
              // The queue keeps jobs in memory: after an engine restart the id is simply gone and no answer will come.
              if (++missingPolls >= 15) {
                throw new Error(`Job ${job.id} untuk scene ${sceneNum} hilang dari antrean engine (engine restart?). Lanjutkan dari checkpoint.`);
              }
            } else {
              missingPolls = 0;
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
          // A tab that stopped answering cannot host a second attempt: a new job would only queue behind work that
          // never returns, so the run stops here and waits for the user to look at Flow.
          if (sceneStalled) {
            activePipeline.logs.push(
              `[${new Date().toLocaleTimeString()}] ⏸️ Percobaan ulang tidak dijalankan: sesi Flow masih sibuk. Cek tab Flow, lalu tekan "Lanjutkan".`,
            );
            break;
          }
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
          script_data: currentScriptData,
          request_body: { ...body, scenes: scenesToRun, character_anchor: characterAnchor, setting_anchor: settingAnchor, voiceover_persona: voiceoverPersona, style: pipelineStyle } as Record<string, unknown>,
          created_at: resumedCheckpoint?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        saveCheckpoint(pausedCp);

        const pausedMsg = sceneError?.message || `Gagal generate scene ${sceneNum}`;
        if (opts?.autoSkip && opts.batchId && opts.videoIndex !== undefined) {
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] ⏩ [Auto-Skip] Video ${opts.videoIndex + 1} tertahan di Scene ${sceneNum}. Klip 1 s/d ${downloadedClips.length} tersimpan di disk. Melanjutkan ke video berikutnya...`
          );
          updateBatchItem(opts.batchId, opts.videoIndex, {
            status: "paused",
            failed_scene: sceneNum,
            checkpoint_id: jobId,
            error: pausedMsg,
          });
        } else {
          activePipeline.logs.push(
            `[${new Date().toLocaleTimeString()}] ⏸️ Scene ${sceneNum} tetap gagal setelah ${MAX_SCENE_ATTEMPTS} percobaan. Progres disimpan; tekan "Lanjutkan" untuk mencoba lagi.`
          );
          if (opts?.batchId && opts.videoIndex !== undefined) {
            updateBatchItem(opts.batchId, opts.videoIndex, {
              status: "paused",
              failed_scene: sceneNum,
              checkpoint_id: jobId,
              error: pausedMsg,
            });
          }
        }
        // Always a paused result, never a thrown error: the caller marks the video paused and the user decides when to
        // continue. A throw used to abort the whole batch and leave its items stuck on "generating".
        activePipeline.status_text = `Tertahan di Scene ${sceneNum}`;
        activePipeline.error = `${pausedMsg} — tekan "Lanjutkan" untuk mencoba lagi.`;
        return { success: false, skipped: Boolean(opts?.autoSkip), paused: true, jobId, failed_scene: sceneNum, error: pausedMsg };
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
      // What this scene actually took (pacing and download included) feeds the next estimate.
      if (activePipeline.scene_started_at) {
        rememberSceneSeconds((Date.now() - Date.parse(activePipeline.scene_started_at)) / 1000);
      }

      if (activePipeline.scene_statuses?.[i]) {
        activePipeline.scene_statuses[i].status = "done";
        activePipeline.scene_statuses[i].clip_file = persistentClip;
        activePipeline.scene_statuses[i].duration = plannedClipDuration;
        activePipeline.scene_statuses[i].variants_count = candidateFiles.length || 1;
        activePipeline.scene_statuses[i].variant_files = candidateFiles.length ? candidateFiles : [persistentClip];
      }
      activePipeline.logs.push(
        `[${new Date().toLocaleTimeString()}] Scene ${sceneNum} selesai: ${basename(clipFile)} (target ${plannedClipDuration}s)`
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
        script_data: currentScriptData,
        request_body: { ...body, scenes: scenesToRun, character_anchor: characterAnchor, setting_anchor: settingAnchor, voiceover_persona: voiceoverPersona, style: pipelineStyle } as Record<string, unknown>,
        created_at: resumedCheckpoint?.created_at || new Date().toISOString(),
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
    activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] 🎞️ Menggabungkan ${downloadedClips.length} klip konten + ${endCardPath ? `end-card ${endCardDuration}s ` : "tanpa end-card "}(${outputFilename}) disambung langsung tanpa crossfade, upscale FFmpeg 1080x1920 (sumber Flow 720p)...`);
    await stitchFinalVideo({
      contentClips: downloadedClips,
      contentDurations: downloadedClipDurations,
      endcardPath: endCardPath,
      endcardDuration: endCardDuration,
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
      script_data: currentScriptData,
      request_body: { ...body, scenes: scenesToRun, character_anchor: characterAnchor, setting_anchor: settingAnchor, voiceover_persona: voiceoverPersona, style: pipelineStyle } as Record<string, unknown>,
      created_at: resumedCheckpoint?.created_at || new Date().toISOString(),
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
    if (!opts?.batchId) {
      activePipeline.running = false;
    }
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
  // Off unless asked for: a video that stops on a failed scene waits for the user's own "Lanjutkan" instead of the
  // engine skipping ahead or retrying by itself, so a batch never spends credits on its own.
  const autoSkip = body.auto_skip === true;
  const autoRetryEnd = body.auto_retry_end === true;
  const batchId = "batch_" + randomBytes(6).toString("hex");
  const images = normalizeImageAttachments(body);
  const primaryFile = images[0]?.file || String(body.product_file || "product.jpg");
  const voiceLanguage = String(body.voice_language || "Bahasa Indonesia");

  // Immediately mark activePipeline as running BEFORE any await to prevent premature 100% completion polling bug
  isPipelineCancelled = false;
  activePipeline.running = true;
  activePipeline.cancelled = false;
  activePipeline.error = undefined;
  activePipeline.last_video = undefined;
  activePipeline.current_scene = 0;
  activePipeline.clips_count = resolved.clips_count;
  activePipeline.duration = resolved.duration_target;
  activePipeline.product_file = primaryFile;
  activePipeline.video_model = resolved.video_model;
  activePipeline.platform_preset = resolved.platform;
  activePipeline.scene_statuses = [];
  activePipeline.status_text = `Menyiapkan ${batchCount} naskah AI...`;
  const modeLabel = batchMode === "series" ? "Seri Tema (tiap video utuh)" : (batchMode === "theme" ? "Satu Tema, Judul Berbeda" : "Variasi Hook A/B Test");
  activePipeline.logs = [
    `[${new Date().toLocaleTimeString()}] 🚀 Memulai Batch Pipeline (${batchCount} video @ ${resolved.duration_target}s, mode: ${modeLabel})...`
  ];

  const batchCtrl = resetBatchAbortController();

  const items: BatchItemState[] = Array.from({ length: batchCount }, (_, idx) => ({
    index: idx,
    job_id: randomBytes(8).toString("hex"),
    title: `Video ${idx + 1} (${batchMode === "variations" ? `Variasi ${idx + 1}` : `Topik ${idx + 1}`})`,
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
      `[${new Date().toLocaleTimeString()}] 🚀 Memulai Batch Pipeline (${batchCount} video @ ${resolved.duration_target}s, mode: ${modeLabel})...`
    ],
    status_text: `Menyiapkan ${batchCount} naskah AI...`,
    created_at: new Date().toISOString(),
  };
  setActiveBatch(batchState);

  try {
    let scripts: ScriptResult[] = [];
    const providedBatchScripts = Array.isArray(body.batch_scripts)
      ? body.batch_scripts.filter((s) => s && Array.isArray(s.scenes) && s.scenes.length >= resolved.clips_count)
      : [];

    if (providedBatchScripts.length >= batchCount) {
      scripts = providedBatchScripts.slice(0, batchCount);
      const msg = `[${new Date().toLocaleTimeString()}] ✅ Menggunakan ${scripts.length} naskah hasil pratinjau/edit langsung (tanpa tunggu generate ulang).`;
      batchState.logs.push(msg);
      activePipeline.logs.push(msg);
    } else if (providedBatchScripts.length > 0) {
      scripts = buildBatchScriptsFromBase(providedBatchScripts[0], batchCount, batchMode, resolved, voiceLanguage);
      const msg = `[${new Date().toLocaleTimeString()}] ✅ Memperluas naskah pratinjau menjadi ${scripts.length} variasi naskah batch.`;
      batchState.logs.push(msg);
      activePipeline.logs.push(msg);
    } else if (Array.isArray(body.scenes) && body.scenes.length >= resolved.clips_count) {
      const baseFromBody: ScriptResult = {
        product_identified: body.product_identified || "",
        product_slug: body.product_slug || "",
        hook_type: body.hook_type,
        hook_text_3s: body.hook_text_3s,
        retention_promise: body.retention_promise,
        share_trigger: body.share_trigger,
        cta_mode: body.cta_mode,
        subject_mode: body.subject_mode,
        style: body.style,
        voiceover_persona: body.voiceover_persona,
        character_anchor: body.character_anchor || "",
        setting_anchor: body.setting_anchor || "",
        scenes: body.scenes.slice(0, resolved.clips_count),
      };
      scripts = buildBatchScriptsFromBase(baseFromBody, batchCount, batchMode, resolved, voiceLanguage);
      const msg = `[${new Date().toLocaleTimeString()}] ✅ Menggunakan naskah storyboard aktif untuk ${scripts.length} video batch.`;
      batchState.logs.push(msg);
      activePipeline.logs.push(msg);
    } else {
      try {
        const batchRes = await generateBatchScriptsWithLLM(body, batchCount, batchMode, undefined, batchCtrl.signal, resolved);
        scripts = batchRes.scripts;
        const msg = `[${new Date().toLocaleTimeString()}] ✅ ${scripts.length} naskah AI selesai disusun & disimpan ke disk.`;
        batchState.logs.push(msg);
        activePipeline.logs.push(msg);
      } catch (scriptErr: unknown) {
        if (batchState.cancelled || isPipelineCancelled || batchCtrl.signal.aborted) {
          throw new Error("Antrean batch dibatalkan oleh pengguna saat menyusun naskah.");
        }
        const warnMsg = `[${new Date().toLocaleTimeString()}] ⚠️ Susun naskah AI terkendala (${(scriptErr as Error).message}). Menggunakan naskah default.`;
        batchState.logs.push(warnMsg);
        activePipeline.logs.push(warnMsg);
      }
    }

    if (scripts.length > 0) {
      saveActiveBatchScripts({
        batch_id: batchId,
        batch_mode: batchMode,
        batch_count: batchCount,
        duration_target: resolved.duration_target,
        platform_preset: resolved.platform,
        video_model: resolved.video_model,
        theme: body.batch_theme,
        linked: false,
        scripts: scripts as unknown as Array<Record<string, unknown>>,
        updated_at: new Date().toISOString(),
      });
    }

    // Pre-create checkpoints & populate item metadata for ALL videos in the batch before Scene 1 starts
    for (let i = 0; i < items.length; i++) {
      const sc = scripts[i];
      if (sc) {
        items[i].title = sc.title
          ? sc.title
          : (sc.scenes?.[0]?.title
            ? `Video ${i + 1}: "${sc.scenes[0].title}"`
            : (sc.hook_text_3s ? `Video ${i + 1}: "${sc.hook_text_3s}"` : items[i].title));
        items[i].hook_type = sc.hook_type;
        items[i].script_data = sc as unknown as Record<string, unknown>;
      }
      items[i].checkpoint_id = items[i].job_id;
      const itemVideoBody: PipelineRequestBody = {
        ...body,
        scenes: sc?.scenes || body.scenes,
        hook_type: sc?.hook_type || body.hook_type,
        hook_text_3s: sc?.hook_text_3s || body.hook_text_3s,
        character_anchor: sc?.character_anchor || body.character_anchor,
        setting_anchor: sc?.setting_anchor || body.setting_anchor,
        voiceover_persona: sc?.voiceover_persona || body.voiceover_persona,
        style: sc?.style || body.style,
      };
      saveCheckpoint({
        job_id: items[i].job_id,
        batch_id: batchId,
        video_index: i,
        total_videos: batchCount,
        video_title: items[i].title,
        status: "in_progress",
        duration_target: resolved.duration_target,
        platform_preset: resolved.platform,
        video_model: resolved.video_model,
        clips_count: resolved.clips_count,
        clip_durations: resolved.clip_durations,
        completed_scenes: [],
        completed_clips: [],
        completed_durations: [],
        script_data: sc ? (sc as unknown as Record<string, unknown>) : undefined,
        request_body: itemVideoBody as Record<string, unknown>,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    for (let idx = 0; idx < batchCount; idx++) {
      if (batchState.cancelled || isPipelineCancelled || batchCtrl.signal.aborted) {
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
        existingJobId: items[idx].job_id,
      });

      if (res.jobId) items[idx].job_id = res.jobId;

      if (res.skipped || res.paused) {
        items[idx].status = "paused";
        items[idx].failed_scene = res.failed_scene;
        items[idx].checkpoint_id = res.jobId || items[idx].job_id;
        // Stopped, not skipped: without auto-skip the batch waits for the user's own "Lanjutkan" and leaves the rest
        // of the queue untouched, so nothing more is spent before they look at what went wrong.
        if (!autoSkip) break;
      } else if (res.success) {
        items[idx].status = "done";
        items[idx].last_video = res.last_video;
      } else {
        items[idx].status = batchState.cancelled || isPipelineCancelled ? "paused" : "failed";
        items[idx].checkpoint_id = res.jobId || items[idx].job_id;
      }
    }

    // Auto-Retry Second Pass for skipped/paused videos
    if (autoRetryEnd && !batchState.cancelled && !isPipelineCancelled && !batchCtrl.signal.aborted) {
      const pausedItems = items.filter((it) => it.status === "paused" && it.checkpoint_id);
      if (pausedItems.length > 0) {
        batchState.logs.push(
          `[${new Date().toLocaleTimeString()}] 🔄 [Auto-Retry Second Pass] Memulai kembali ${pausedItems.length} video yang tertahan...`
        );
        for (const it of pausedItems) {
          if (batchState.cancelled || isPipelineCancelled || batchCtrl.signal.aborted) break;
          batchState.logs.push(
            `[${new Date().toLocaleTimeString()}] 🔄 Melanjutkan ${it.title} dari Scene ${it.failed_scene ?? "berikutnya"}...`
          );
          it.status = "generating";
          const cp = it.checkpoint_id ? loadCheckpoint(it.checkpoint_id) : null;
          const resumeBody = (cp?.request_body as PipelineRequestBody) || body;
          const res = await runPipelineAsync(core, resumeBody, resolved, {
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
    if (batchState.cancelled || isPipelineCancelled) {
      batchState.status_text = `Batch Dibatalkan (${doneCount}/${batchCount} selesai)`;
      activePipeline.status_text = batchState.status_text;
      activePipeline.cancelled = true;
    } else if (pausedCount > 0) {
      batchState.status_text = `Batch Terhenti: ${doneCount}/${batchCount} selesai, ${pausedCount} tertahan — tekan "Lanjutkan"`;
      activePipeline.status_text = batchState.status_text;
      activePipeline.error = `${pausedCount} video tertahan. Klik "Lanjutkan" pada kartu Antrean Batch untuk melanjutkan.`;
    } else {
      batchState.status_text = `Batch Selesai: ${doneCount}/${batchCount} sukses`;
      activePipeline.status_text = "Selesai";
    }
    batchState.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 ${batchState.status_text}`);
  } catch (err: unknown) {
    if (batchState.cancelled || isPipelineCancelled) {
      batchState.status_text = "Dibatalkan oleh pengguna";
      activePipeline.status_text = "Dibatalkan";
      activePipeline.cancelled = true;
    } else {
      batchState.status_text = "Error dalam batch";
      activePipeline.status_text = "Error";
      activePipeline.error = (err as Error).message;
      batchState.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error: ${(err as Error).message}`);
    }
  } finally {
    batchState.running = false;
    activePipeline.running = false;
  }
}

// "Lanjutkan" on a batch item used to resume that one video and nothing else, so after finishing it the next videos
// waited for another click - or for nothing at all when the engine had restarted in between. Finishing one item now
// carries the rest of the queue, and the chain stops again at the first video that fails.
async function continueBatchFrom(
  core: Core,
  batch: BatchPipelineState,
  finishedIndex: number,
  finished: { success: boolean; last_video?: string; failed_scene?: number; jobId?: string; error?: string },
): Promise<void> {
  const item = batch.items.find((it) => it.index === finishedIndex);
  if (item) {
    item.status = finished.success ? "done" : "paused";
    if (finished.last_video) item.last_video = finished.last_video;
    if (!finished.success) item.failed_scene = finished.failed_scene;
    if (finished.jobId) item.checkpoint_id = finished.jobId;
  }
  if (!finished.success) {
    batch.status_text = `Batch Terhenti: ${batch.items.filter((i) => i.status === "done").length}/${batch.batch_count} selesai`;
    activePipeline.status_text = batch.status_text;
    batch.running = false;
    activePipeline.running = false;
    return;
  }

  const remaining = batch.items.filter((it) => it.index > finishedIndex && it.status !== "done");
  if (!remaining.length) {
    batch.status_text = `Batch Selesai: ${batch.items.filter((i) => i.status === "done").length}/${batch.batch_count} sukses`;
    activePipeline.status_text = "Selesai";
    batch.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 ${batch.status_text}`);
    return;
  }

  batch.running = true;
  batch.logs.push(
    `[${new Date().toLocaleTimeString()}] ▶️ Melanjutkan sisa antrean: ${remaining.length} video (berhenti lagi jika ada yang gagal).`,
  );
  activePipeline.running = true;
  for (const it of remaining) {
    if (batch.cancelled || isPipelineCancelled) break;
    const cp = it.checkpoint_id ? loadCheckpoint(it.checkpoint_id) : loadCheckpoint(it.job_id);
    const resumeBody = cp?.request_body as PipelineRequestBody | undefined;
    if (!resumeBody || !cp) {
      it.status = "pending";
      batch.logs.push(`[${new Date().toLocaleTimeString()}] ⏭️ ${it.title}: checkpoint tidak ditemukan, dilewati.`);
      continue;
    }
    it.status = "generating";
    it.current_scene = 0;
    batch.current_index = it.index;
    batch.status_text = `Memproses Video ${it.index + 1} dari ${batch.batch_count}...`;
    const res = await runPipelineAsync(core, resumeBody, undefined, {
      batchId: batch.batch_id,
      videoIndex: it.index,
      totalVideos: batch.batch_count,
      autoSkip: false,
      resumeJobId: cp.job_id,
    });
    if (res.success) {
      it.status = "done";
      it.last_video = res.last_video;
      continue;
    }
    it.status = "paused";
    it.failed_scene = res.failed_scene;
    it.checkpoint_id = res.jobId || it.checkpoint_id;
    batch.status_text = `Batch Terhenti: ${batch.items.filter((i) => i.status === "done").length}/${batch.batch_count} selesai, ${it.title} tertahan — tekan "Lanjutkan"`;
    activePipeline.status_text = batch.status_text;
    activePipeline.error = `Video ${it.index + 1} tertahan di Scene ${res.failed_scene ?? "?"}. Tekan "Lanjutkan" untuk melanjutkan.`;
    batch.logs.push(`[${new Date().toLocaleTimeString()}] ⏸️ ${batch.status_text}`);
    break;
  }
  batch.running = false;
  activePipeline.running = false;
  const doneCount = batch.items.filter((i) => i.status === "done").length;
  if (doneCount === batch.batch_count) {
    batch.status_text = `Batch Selesai: ${doneCount}/${batch.batch_count} sukses`;
    activePipeline.status_text = "Selesai";
    batch.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 ${batch.status_text}`);
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

      // Flow Session Heartbeat & Status (/api/flow/heartbeat and /api/status)
      if (
        (req.method === "POST" || req.method === "GET") &&
        (url.pathname === "/api/flow/heartbeat" || url.pathname === "/api/status")
      ) {
        let body: { detailed?: boolean; auto_launch?: boolean } = {};
        if (req.method === "POST") {
          try {
            const rawBody = (await readBody(req, 64 * 1024)).toString();
            if (rawBody) body = JSON.parse(rawBody) as { detailed?: boolean; auto_launch?: boolean };
          } catch {}
        }
        let reg = loadAccountsRegistry();
        const activeAcc = reg.active_account_id ? reg.accounts.find((a) => a.id === reg.active_account_id) : undefined;
        const launchStatus = getAccountLaunchStatus(reg.active_account_id);

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
            launch_state: launchStatus.state,
            launch_error: launchStatus.error,
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
          launch_state: probe.chrome_running && launchStatus.state === "launching" ? "ready" : launchStatus.state,
          launch_error: launchStatus.error,
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
              const alreadyThisProfile = Boolean(curDir && normalizeProfilePath(curDir) === normalizeProfilePath(acc.profile_dir));
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
              if (!curAfter || normalizeProfilePath(curAfter) !== normalizeProfilePath(wasRunningDir)) {
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
            version: "0.4.3",
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

      // LLM Script Generation (Single & Multi-Script Batch Preview)
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
        const batchCount = Math.max(1, Number(body.batch_count) || 1);
        const batchMode = body.batch_mode === "theme" ? "theme" : (body.batch_mode === "series" ? "series" : "variations");
        const scriptMode = body.script_mode === "flow_agent" ? "flow_agent" : "llm";
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
            const batchRes = await generateBatchScriptsWithLLM(
              body,
              batchCount,
              batchMode,
              (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
                if (typeof (res as any).flush === "function") (res as any).flush();
              },
              clientAbort.signal,
              resolved,
              scriptMode
            );
            res.write(
              `data: ${JSON.stringify({
                type: "done",
                script: batchRes.scripts[0],
                scripts: batchRes.scripts,
                batch_count: batchCount,
                batch_mode: batchMode,
                plan: batchRes.plan,
                theme: batchRes.theme,
                linked: batchRes.linked,
              })}\n\n`
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
          } finally {
            res.end();
          }
          return;
        }

        const batchRes = await generateBatchScriptsWithLLM(body, batchCount, batchMode, undefined, undefined, resolved, scriptMode);
        return json(res, 200, {
          success: true,
          ...batchRes.scripts[0],
          script: batchRes.scripts[0],
          scripts: batchRes.scripts,
          batch_count: batchCount,
          batch_mode: batchMode,
          plan: batchRes.plan,
          theme: batchRes.theme,
          linked: batchRes.linked,
        });
      }

      // Single Script Regenerate API (Per-Tab in Batch / Storyboard)
      if (req.method === "POST" && url.pathname === "/api/llm/regenerate-script") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as ScriptRequestBody & {
          index?: number;
          plan_item?: BatchPlanItem;
          plan?: BatchPlanItem[];
          theme?: string;
          linked?: boolean;
        };

        const targetIndex = typeof body.index === "number" ? body.index : 0;
        let resolved: ResolvedPlatformConfig;
        try {
          resolved = resolveRequestConfig(body);
        } catch (err) {
          if (err instanceof PlatformPresetError) {
            return json(res, 400, { success: false, error: err.message, code: err.code, allowed_durations: err.allowed_durations });
          }
          throw err;
        }

        const scriptMode = body.script_mode === "flow_agent" ? "flow_agent" : "llm";
        try {
          const script = await generateScriptWithLLM(
            body,
            undefined,
            undefined,
            resolved,
            scriptMode,
            body.plan_item,
            body.theme || body.batch_theme
          );

          if (body.plan_item?.title) {
            script.title = body.plan_item.title;
            script.plan_item = body.plan_item;
          }

          // Update vault at targetIndex
          const vault = loadActiveBatchScripts();
          if (vault && Array.isArray(vault.scripts)) {
            vault.scripts[targetIndex] = script as unknown as Record<string, unknown>;
            vault.updated_at = new Date().toISOString();
            saveActiveBatchScripts(vault);
          }

          return json(res, 200, {
            success: true,
            index: targetIndex,
            script,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
      }

      // Batch Planner API (Optional Outline-First Preview)
      if (req.method === "POST" && url.pathname === "/api/llm/plan-batch") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}") as ScriptRequestBody & {
          count?: number;
        };
        const count = Math.max(1, Number(body.batch_count || body.count) || 2);
        const mode = body.batch_mode || "theme";
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
          const plan = await planBatchWithLLM(body, count, mode, resolved);
          return json(res, 200, { success: true, plan });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, 500, { success: false, error: message });
        }
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
          ? reg.accounts.find((a) => normalizeProfilePath(a.profile_dir) === normalizeProfilePath(profileDir))
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
            chrome: "launching",
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
          batch_count?: number;
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
        const batchCount = Math.max(1, body.batch_count || 1);
        const requiredTotal = creditCalc.total_required * batchCount;
        const state = await getFlowState(true).catch(() => getFlowState());
        const mockHeader = (process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true") && req.headers["x-mock-credits"] !== undefined
          ? Number(req.headers["x-mock-credits"])
          : undefined;
        const available = mockHeader !== undefined ? mockHeader : state.credits_remaining;
        if (available !== undefined && available < requiredTotal) {
          const shortage = requiredTotal - available;
          const reg = loadAccountsRegistry();
          const fallbackAcc = reg.accounts.find((a) => a.id !== reg.active_account_id && (a.credits ?? 0) >= requiredTotal);
          return json(res, 400, {
            error: "INSUFFICIENT_CREDITS",
            code: "INSUFFICIENT_CREDITS",
            required: requiredTotal,
            available,
            shortage,
            batch_count: batchCount,
            unit_cost: creditCalc.unit_cost,
            clips_count: creditCalc.clips_count,
            scene1_variants: creditCalc.scene1_variants,
            video_model: creditCalc.video_model,
            fallback_account: fallbackAcc
              ? { id: fallbackAcc.id, label: fallbackAcc.label, name: fallbackAcc.label, credits: fallbackAcc.credits }
              : null,
            message: `Kredit Flow tidak cukup${batchCount > 1 ? ` untuk ${batchCount} video` : ""}. Dibutuhkan ${requiredTotal} kredit, tersedia ${available} kredit.`,
          });
        }
        if (available !== undefined) {
          updateActiveAccountState({ credits: available, status: "signed_in" }).catch(() => {});
        }
        return json(res, 200, {
          success: true,
          sufficient: true,
          required: requiredTotal,
          available: available ?? null,
          batch_count: batchCount,
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
        const requiredCredits = batchCount > 1 ? totalRequiredBatch : creditCalc.total_required;

        if (mockHeader === undefined && pool.total_pool_credits < requiredCredits) {
          const shortage = requiredCredits - pool.total_pool_credits;
          return json(res, 400, {
            error: "INSUFFICIENT_CREDITS",
            code: "INSUFFICIENT_CREDITS",
            required: requiredCredits,
            available: pool.total_pool_credits,
            shortage,
            batch_count: batchCount,
            unit_cost: creditCalc.unit_cost,
            clips_count: creditCalc.clips_count,
            scene1_variants: creditCalc.scene1_variants,
            video_model: creditCalc.video_model,
            message: `Kredit Flow (seluruh akun: ${pool.total_pool_credits} cr) tidak cukup${batchCount > 1 ? ` untuk ${batchCount} video` : ""}. Dibutuhkan minimal ${requiredCredits} kredit.`,
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

        const batch = getActiveBatch();
        const batchItem = batch?.items.find((it) => (it.checkpoint_id || it.job_id) === body.job_id);
        if (batch && batchItem) {
          batch.running = true;
          activePipeline.running = true;
        }
        void (async () => {
          const res = await runPipelineAsync(core, cp.request_body as PipelineRequestBody, undefined, {
            resumeJobId: body.job_id,
            autoSkip: false,
            ...(batch && batchItem ? { batchId: batch.batch_id, videoIndex: batchItem.index, totalVideos: batch.batch_count } : {}),
          });
          if (batch && batchItem) await continueBatchFrom(core, batch, batchItem.index, res);
        })();

        return json(res, 200, {
          success: true,
          message: `Melanjutkan render job ${body.job_id} dari Scene ${(cp.completed_scenes.length || 0) + 1}...`,
          checkpoint: cp,
          continues_batch: Boolean(batch && batchItem),
        });
      }

      // Persistent Batch Scripts Vault API (Load & Save/Expand Multi-Scripts)
      if (req.method === "GET" && url.pathname === "/api/pipeline/scripts") {
        const saved = loadActiveBatchScripts();
        return json(res, 200, {
          success: true,
          saved,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/pipeline/scripts") {
        const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString() || "{}") as Partial<SavedBatchScripts> & {
          expand_from_base?: boolean;
          voice_language?: string;
        };
        const batchMode = body.batch_mode === "theme" ? "theme" : (body.batch_mode === "series" ? "series" : "variations");
        const batchCount = Math.max(1, Number(body.batch_count) || (Array.isArray(body.scripts) ? body.scripts.length : 1));
        let scripts = (Array.isArray(body.scripts) ? body.scripts : []) as unknown as ScriptResult[];

        if (body.expand_from_base && scripts.length >= 1) {
          const bodyDuration = Number(body.duration_target || (body as any).duration) || 60;
          let resolved: ResolvedPlatformConfig;
          try {
            resolved = resolvePlatformPreset((body.platform_preset as PlatformPreset) || "custom", {
              duration_target: bodyDuration,
              video_model: body.video_model,
            });
          } catch {
            resolved = resolvePlatformPreset("custom", { duration_target: bodyDuration });
          }
          const expanded = buildBatchScriptsFromBase(
            scripts[0],
            batchCount,
            batchMode,
            resolved,
            body.voice_language || "Bahasa Indonesia"
          );
          // Preserve any already-edited scripts at indices 0..scripts.length-1 if only expanding count,
          // or regenerate variations 1..N-1 if mode changed
          scripts = expanded;
        }

        const payload: SavedBatchScripts = {
          batch_id: String((body as any).batch_id || ("batch_" + randomBytes(4).toString("hex"))),
          batch_mode: batchMode,
          batch_count: Math.max(batchCount, scripts.length),
          duration_target: Number(body.duration_target || (body as any).duration) || 60,
          platform_preset: String(body.platform_preset || "general_commercial"),
          video_model: String(body.video_model || "veo-3.1-fast"),
          theme: body.theme || (body as any).batch_theme,
          linked: false,
          plan: body.plan,
          scripts: scripts as unknown as Array<Record<string, unknown>>,
          updated_at: new Date().toISOString(),
        };
        saveActiveBatchScripts(payload);
        return json(res, 200, {
          success: true,
          saved: payload,
        });
      }

      // Checkpoints List API
      if (req.method === "GET" && url.pathname === "/api/pipeline/checkpoints") {
        return json(res, 200, {
          success: true,
          checkpoints: listCheckpoints(),
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
        const b = abortActiveBatch("Dibatalkan oleh pengguna");
        activePipeline.running = false;
        activePipeline.status_text = "Dibatalkan oleh pengguna";
        activePipeline.cancelled = true;
        activePipeline.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Antrean batch dibatalkan oleh pengguna.`);
        if (currentRunningJobId) {
          try {
            await (core.cancel as unknown as (args: unknown) => Promise<unknown>)({ job_id: currentRunningJobId });
          } catch {}
        }
        return json(res, 200, {
          success: true,
          message: "Batch cancelled",
          batch: b,
          pipeline: activePipeline,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/pipeline/status") {
        const batch = getActiveBatch();
        return json(res, 200, {
          pipeline: { ...activePipeline, timing: pipelineTiming(batch), progress: pipelineProgress(batch) },
          batch,
        });
      }

      // Pipeline Cancellation Trigger
      if (req.method === "POST" && url.pathname === "/api/pipeline/cancel") {
        isPipelineCancelled = true;
        abortActiveBatch("Dibatalkan oleh pengguna");
        activePipeline.running = false;
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
