import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCheckpointDir } from "./platform.js";
import { loadAccountsRegistry, type FlowAccount } from "./accounts.js";

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
}

export interface BatchPipelineState {
  batch_id: string;
  running: boolean;
  cancelled?: boolean;
  batch_count: number;
  batch_mode: "variations" | "series";
  auto_skip: boolean;
  auto_retry_end: boolean;
  current_index: number;
  items: BatchItemState[];
  logs: string[];
  status_text: string;
  created_at: string;
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

// Active Batch Singleton State
let activeBatchState: BatchPipelineState | null = null;

export function getActiveBatch(): BatchPipelineState | null {
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
