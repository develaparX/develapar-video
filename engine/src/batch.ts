import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCheckpointDir, getScriptsDir } from "./platform.js";
import { loadAccountsRegistry, type FlowAccount } from "./accounts.js";
import type { HookArchetype } from "./presets.js";

export interface BatchPlanItem {
  index: number;
  title: string;
  angle: string;
  key_message: string;
  hook_archetype: HookArchetype;
  must_avoid: string[];
  /** @deprecated Legacy field from the old cross-video linking mode. Never generated anymore. */
  link_from_prev?: string;
  /** @deprecated Legacy field from the old cross-video linking mode. Never generated anymore. */
  link_to_next?: string;
}

export interface PipelineCheckpoint {
  job_id: string;
  batch_id?: string;
  video_index: number;
  total_videos: number;
  video_title?: string;
  status: "in_progress" | "paused" | "completed" | "failed";
  duration_target: number;
  platform_preset: string;
  video_model: string;
  clips_count: number;
  clip_durations: number[];
  completed_scenes: number[];
  completed_clips: string[];
  completed_durations: number[];
  failed_scene?: number;
  last_error?: string;
  script_data?: Record<string, unknown>;
  request_body: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BatchItemState {
  index: number;
  job_id: string;
  title: string;
  hook_type?: string;
  status: "pending" | "generating" | "done" | "paused" | "failed";
  current_scene: number;
  clips_count: number;
  duration: number;
  credits_spent: number;
  checkpoint_id?: string;
  failed_scene?: number;
  last_video?: string;
  error?: string;
  script_data?: Record<string, unknown>;
}

export interface BatchPipelineState {
  batch_id: string;
  running: boolean;
  cancelled?: boolean;
  batch_count: number;
  batch_mode: "variations" | "series" | "theme";
  auto_skip: boolean;
  auto_retry_end: boolean;
  current_index: number;
  items: BatchItemState[];
  logs: string[];
  status_text: string;
  created_at: string;
}

export interface SavedBatchScripts {
  batch_id: string;
  batch_count: number;
  batch_mode: "variations" | "series" | "theme";
  duration_target: number;
  platform_preset: string;
  video_model: string;
  product_files?: unknown[];
  prompt?: string;
  theme?: string;
  linked?: boolean;
  plan?: BatchPlanItem[];
  scripts: Array<Record<string, unknown>>;
  updated_at: string;
}

export function saveActiveBatchScripts(data: SavedBatchScripts): void {
  try {
    const dir = getScriptsDir();
    data.updated_at = new Date().toISOString();
    const activePath = join(dir, "active_batch_scripts.json");
    writeFileSync(activePath, JSON.stringify(data, null, 2), "utf8");
    if (data.batch_id) {
      const archivePath = join(dir, `${data.batch_id}.scripts.json`);
      writeFileSync(archivePath, JSON.stringify(data, null, 2), "utf8");
    }
  } catch (err) {
    console.warn("[ScriptsVault] Gagal menyimpan active_batch_scripts:", err);
  }
}

export function loadActiveBatchScripts(): SavedBatchScripts | null {
  try {
    const filePath = join(getScriptsDir(), "active_batch_scripts.json");
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SavedBatchScripts;
  } catch {
    return null;
  }
}

export function getJobCheckpointDir(jobId: string): string {
  const dir = join(getCheckpointDir(), jobId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function saveCheckpoint(cp: PipelineCheckpoint): void {
  try {
    const dir = getJobCheckpointDir(cp.job_id);
    cp.updated_at = new Date().toISOString();
    const filePath = join(dir, "checkpoint.json");
    writeFileSync(filePath, JSON.stringify(cp, null, 2), "utf8");
  } catch (err) {
    console.error(`[Checkpoint] Gagal menyimpan checkpoint untuk job ${cp.job_id}:`, err);
  }
}

export function loadCheckpoint(jobId: string): PipelineCheckpoint | null {
  try {
    const filePath = join(getJobCheckpointDir(jobId), "checkpoint.json");
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as PipelineCheckpoint;
  } catch (err) {
    console.warn(`[Checkpoint] Gagal membaca checkpoint untuk job ${jobId}:`, err);
    return null;
  }
}

export function listCheckpoints(): PipelineCheckpoint[] {
  try {
    const baseDir = getCheckpointDir();
    if (!existsSync(baseDir)) return [];
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const result: PipelineCheckpoint[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const cp = loadCheckpoint(entry.name);
        if (cp) result.push(cp);
      }
    }
    result.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return result;
  } catch {
    return [];
  }
}

export function deleteCheckpoint(jobId: string): void {
  try {
    const dir = join(getCheckpointDir(), jobId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

export interface CreditPoolSummary {
  total_pool_credits: number;
  accounts: Array<{
    id: string;
    label: string;
    email?: string;
    credits: number;
    status: string;
    is_active: boolean;
  }>;
}

export function getCreditPoolSummary(): CreditPoolSummary {
  const reg = loadAccountsRegistry();
  const accounts = reg.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    email: a.email,
    credits: typeof a.credits === "number" && a.credits >= 0 ? a.credits : 0,
    status: a.status,
    is_active: a.id === reg.active_account_id,
  }));

  const total = accounts
    .filter((a) => a.status === "signed_in")
    .reduce((sum, a) => sum + a.credits, 0);

  return { total_pool_credits: total, accounts };
}

export function findAccountForCredits(
  requiredCredits: number,
  excludeId?: string
): FlowAccount | undefined {
  const reg = loadAccountsRegistry();
  const signedIn = reg.accounts.filter(
    (a) => a.status === "signed_in" && (!excludeId || a.id !== excludeId)
  );

  // First sort by largest balance so we pick the account with the most credits
  signedIn.sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0));
  return signedIn.find((a) => (a.credits ?? 0) >= requiredCredits);
}

// Active Batch Singleton State & AbortController
let activeBatchState: BatchPipelineState | null = null;
let batchAbortController: AbortController | null = null;
let restoredOnBoot = false;

export function resetBatchAbortController(): AbortController {
  if (batchAbortController) {
    try {
      batchAbortController.abort(new Error("Digantikan oleh batch baru"));
    } catch {}
  }
  batchAbortController = new AbortController();
  return batchAbortController;
}

export function getBatchAbortSignal(): AbortSignal | undefined {
  return batchAbortController?.signal;
}

export function abortActiveBatch(reason = "Dibatalkan oleh pengguna"): void {
  if (batchAbortController) {
    try {
      batchAbortController.abort(new Error(reason));
    } catch {}
  }
  if (activeBatchState) {
    activeBatchState.cancelled = true;
    activeBatchState.running = false;
    activeBatchState.status_text = reason;
    for (const item of activeBatchState.items) {
      if (item.status === "generating" || item.status === "pending") {
        item.status = item.checkpoint_id ? "paused" : "failed";
        if (!item.error) item.error = reason;
      }
    }
  }
}

export function getActiveBatch(): BatchPipelineState | null {
  if (!activeBatchState && !restoredOnBoot) {
    restoredOnBoot = true;
    try {
      const checkpoints = listCheckpoints();
      const resumable = checkpoints.filter((c) => c.status === "paused" || c.status === "in_progress");
      if (resumable.length > 0) {
        const latestBatchId = resumable[0].batch_id || "batch_restored";
        const group = checkpoints
          .filter((c) => (c.batch_id || "batch_restored") === latestBatchId)
          .sort((a, b) => a.video_index - b.video_index);
        if (group.length > 0) {
          const items: BatchItemState[] = group.map((cp, idx) => ({
            index: cp.video_index ?? idx,
            job_id: cp.job_id,
            title: cp.video_title || `Video ${(cp.video_index ?? idx) + 1}`,
            status: cp.status === "completed" ? "done" : "paused",
            current_scene: cp.completed_scenes.length,
            clips_count: cp.clips_count,
            duration: cp.duration_target,
            credits_spent: 0,
            checkpoint_id: cp.job_id,
            failed_scene: cp.failed_scene || cp.completed_scenes.length + 1,
            error: cp.last_error,
            script_data: cp.script_data || (cp.request_body as Record<string, unknown>),
          }));
          const doneCount = items.filter((i) => i.status === "done").length;
          const pausedCount = items.filter((i) => i.status === "paused").length;
          activeBatchState = {
            batch_id: latestBatchId,
            running: false,
            cancelled: false,
            batch_count: Math.max(items.length, group[0].total_videos || items.length),
            batch_mode: "variations",
            auto_skip: true,
            auto_retry_end: true,
            current_index: 0,
            items,
            logs: [
              `[${new Date().toLocaleTimeString()}] ♻️ Memulihkan ${pausedCount} sesi video tertahan dari penyimpanan lokal.`
            ],
            status_text: `${doneCount}/${items.length} selesai, ${pausedCount} tertahan (Siap dilanjutkan)`,
            created_at: group[0].created_at,
          };
        }
      }
    } catch {}
  }
  return activeBatchState;
}

export function setActiveBatch(batch: BatchPipelineState | null): void {
  activeBatchState = batch;
}

export function updateBatchItem(
  batchId: string,
  index: number,
  patch: Partial<BatchItemState>
): void {
  if (!activeBatchState || activeBatchState.batch_id !== batchId) return;
  const item = activeBatchState.items[index];
  if (item) {
    Object.assign(item, patch);
  }
}

export function appendBatchLog(batchId: string, logLine: string): void {
  if (!activeBatchState || activeBatchState.batch_id !== batchId) return;
  activeBatchState.logs.push(logLine);
}
