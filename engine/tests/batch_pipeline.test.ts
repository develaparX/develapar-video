import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateBatchPipeline } from "../src/presets.js";
import { getScriptsDir } from "../src/platform.js";
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  getCreditPoolSummary,
  saveActiveBatchScripts,
  loadActiveBatchScripts,
  setActiveBatch,
  getActiveBatch,
  resetBatchAbortController,
  getBatchAbortSignal,
  abortActiveBatch,
  type PipelineCheckpoint,
} from "../src/batch.js";

describe("Batch Pipeline & Dynamic Estimator", () => {
  it("computes accurate dynamic estimation for 1 video 60s (Omni 1.1 Flash)", () => {
    const est = estimateBatchPipeline({
      platform_preset: "custom",
      duration_target: 60,
      video_model: "Omni 1.1 Flash",
      batch_count: 1,
    });

    expect(est.duration_target).toBe(60);
    expect(est.clips_count).toBeGreaterThanOrEqual(5);
    expect(est.credits_per_video).toBeGreaterThan(0);
    expect(est.total_credits).toBe(est.credits_per_video);
    expect(est.per_scene_breakdown.length).toBe(est.clips_count);
    expect(est.time_seconds_per_video).toBeGreaterThan(100);
  });

  it("computes accurate dynamic estimation for 5 videos 60s in batch", () => {
    const est = estimateBatchPipeline({
      platform_preset: "custom",
      duration_target: 60,
      video_model: "Omni 1.1 Flash",
      batch_count: 5,
    });

    expect(est.batch_count).toBe(5);
    expect(est.total_credits).toBe(est.credits_per_video * 5);
    expect(est.total_time_seconds).toBe(est.time_seconds_per_video * 5);
    expect(est.total_time_formatted).toContain("menit");
  });

  it("saves, loads, and deletes checkpoint correctly", () => {
    const testJobId = "test_job_" + Date.now();
    const cp: PipelineCheckpoint = {
      job_id: testJobId,
      video_index: 0,
      total_videos: 5,
      video_title: "Test Hook 1",
      status: "in_progress",
      duration_target: 60,
      platform_preset: "custom",
      video_model: "Omni 1.1 Flash",
      clips_count: 6,
      clip_durations: [10, 10, 10, 10, 10, 10],
      completed_scenes: [1, 2],
      completed_clips: ["/tmp/sc1.mp4", "/tmp/sc2.mp4"],
      completed_durations: [10, 10],
      request_body: { prompt: "Test prompt" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    saveCheckpoint(cp);
    const loaded = loadCheckpoint(testJobId);
    expect(loaded).not.toBeNull();
    expect(loaded?.job_id).toBe(testJobId);
    expect(loaded?.completed_scenes).toEqual([1, 2]);

    deleteCheckpoint(testJobId);
    expect(loadCheckpoint(testJobId)).toBeNull();
  });

  it("calculates credit pool summary from existing accounts", () => {
    const pool = getCreditPoolSummary();
    expect(typeof pool.total_pool_credits).toBe("number");
    expect(Array.isArray(pool.accounts)).toBe(true);
  });

  it("handles checkpoint status transitions and batch state updates", () => {
    const jobId = "job_test_paused_" + Date.now();
    const cp: PipelineCheckpoint = {
      job_id: jobId,
      batch_id: "batch_123",
      video_index: 0,
      total_videos: 5,
      video_title: "Problem Agitator",
      status: "paused",
      duration_target: 60,
      platform_preset: "custom",
      video_model: "Omni 1.1 Flash",
      clips_count: 6,
      clip_durations: [10, 10, 10, 10, 10, 10],
      completed_scenes: [1, 2],
      completed_clips: ["/tmp/scene_01.mp4", "/tmp/scene_02.mp4"],
      completed_durations: [10, 10],
      failed_scene: 3,
      last_error: "Timeout 30000ms exceeded",
      request_body: { prompt: "Test prompt" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    saveCheckpoint(cp);
    const loaded = loadCheckpoint(jobId);
    expect(loaded?.status).toBe("paused");
    expect(loaded?.failed_scene).toBe(3);
    expect(loaded?.completed_clips.length).toBe(2);

    // Transition to completed upon resume
    cp.status = "completed";
    cp.completed_scenes = [1, 2, 3, 4, 5, 6];
    saveCheckpoint(cp);

    const completed = loadCheckpoint(jobId);
    expect(completed?.status).toBe("completed");
    expect(completed?.completed_scenes.length).toBe(6);

    deleteCheckpoint(jobId);
  });

  it("persists and restores multi-video scripts in Script Vault", () => {
    const scriptsDir = getScriptsDir();
    const activePath = join(scriptsDir, "active_batch_scripts.json");
    const archivePath = join(scriptsDir, "batch_vault_test.scripts.json");
    const prevRaw = existsSync(activePath) ? readFileSync(activePath, "utf8") : null;

    try {
      const scripts = [
        {
          title: "Variasi 1: Problem Agitator",
          selected_style: "G3",
          selected_tone: "T6",
          scenes: [{ number: 1, duration_seconds: 10, voiceover: "Perut sering kembung?", visual_prompt: "Close up bottle" }],
        },
        {
          title: "Variasi 2: Myth Buster",
          selected_style: "G3",
          selected_tone: "T6",
          scenes: [{ number: 1, duration_seconds: 10, voiceover: "Banyak yang salah kaprah soal maag!", visual_prompt: "POV hand holding bottle" }],
        },
      ];

      saveActiveBatchScripts({
        batch_id: "batch_vault_test",
        batch_count: 2,
        batch_mode: "variations",
        duration_target: 60,
        platform_preset: "general_commercial",
        video_model: "Omni 1.1 Flash",
        scripts,
        updated_at: new Date().toISOString(),
      });

      const loaded = loadActiveBatchScripts();
      expect(loaded).not.toBeNull();
      expect(loaded?.batch_count).toBe(2);
      expect(loaded?.batch_mode).toBe("variations");
      expect(loaded?.scripts.length).toBe(2);
      expect(loaded?.scripts[0]?.title).toBe("Variasi 1: Problem Agitator");
      expect(loaded?.scripts[1]?.title).toBe("Variasi 2: Myth Buster");
    } finally {
      try {
        if (existsSync(archivePath)) rmSync(archivePath, { force: true });
        if (prevRaw !== null) {
          writeFileSync(activePath, prevRaw, "utf8");
        } else if (existsSync(activePath)) {
          rmSync(activePath, { force: true });
        }
      } catch {}
    }
  });

  it("aborts active batch signal and transitions generating/pending items cleanly", () => {
    const controller = resetBatchAbortController();
    const signal = getBatchAbortSignal();
    expect(signal).toBe(controller.signal);
    expect(signal?.aborted).toBe(false);

    setActiveBatch({
      batch_id: "batch_cancel_test",
      running: true,
      cancelled: false,
      batch_count: 2,
      batch_mode: "variations",
      auto_skip: true,
      auto_retry_end: true,
      current_index: 0,
      status_text: "Merender Video 1/2...",
      items: [
        {
          index: 0,
          job_id: "job_cancel_1",
          checkpoint_id: "job_cancel_1",
          title: "Video 1 (Variasi 1)",
          status: "generating",
          current_scene: 2,
          clips_count: 6,
          duration: 60,
          credits_spent: 20,
        },
        {
          index: 1,
          job_id: "job_cancel_2",
          title: "Video 2 (Variasi 2)",
          status: "pending",
          current_scene: 0,
          clips_count: 6,
          duration: 60,
          credits_spent: 0,
        },
      ],
      logs: [],
      created_at: new Date().toISOString(),
    });

    abortActiveBatch();

    expect(signal?.aborted).toBe(true);
    const b = getActiveBatch();
    expect(b?.cancelled).toBe(true);
    expect(b?.running).toBe(false);
    expect(b?.items[0]?.status).toBe("paused");
    expect(b?.items[1]?.status).toBe("failed");

    setActiveBatch(null);
  });
});
