import { describe, expect, it } from "bun:test";
import { estimateBatchPipeline } from "../src/presets.js";
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  getCreditPoolSummary,
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
});
