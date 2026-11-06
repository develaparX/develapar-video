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
  type BatchPlanItem,
} from "../src/batch.js";
import {
  buildDeterministicBatchPlan,
  planBatchWithLLM,
  generateBatchScriptsWithLLM,
  batchPlanSchema,
} from "../src/server.js";

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

  it("generates deterministic fallback outline with unique titles and distinct hooks", () => {
    const plan = buildDeterministicBatchPlan("Learn and Unlearn", 4, "theme", undefined, true);
    expect(plan.length).toBe(4);

    const titles = plan.map((p) => p.title);
    expect(new Set(titles).size).toBe(4);

    const archetypes = plan.map((p) => p.hook_archetype);
    expect(new Set(archetypes).size).toBe(4);

    // Batch videos are standalone: no cross-video linking fields anywhere.
    for (const item of plan) {
      expect(item.link_from_prev).toBeUndefined();
      expect(item.link_to_next).toBeUndefined();
      expect(item.title).not.toMatch(/\b(part|episode|bagian|lanjutan)\b/i);
    }
    expect(plan[1].must_avoid).toContain(plan[0].key_message);
  });

  it("respects user provided titles in deterministic fallback outline", () => {
    const userTitles = ["Cara Belajar Cepat", "Membongkar Mitos Lama"];
    const plan = buildDeterministicBatchPlan("Tips Sukses", 3, "theme", userTitles, true);
    expect(plan.length).toBe(3);
    expect(plan[0].title).toBe("Cara Belajar Cepat");
    expect(plan[1].title).toBe("Membongkar Mitos Lama");
    expect(plan[2].title).toContain("Tips Sukses");
  });

  it("validates batch plan with Zod schema and rejects invalid or duplicate outlines", () => {
    const validPlan: BatchPlanItem[] = [
      {
        index: 0,
        title: "Video 1",
        angle: "Angle 1",
        key_message: "Message 1",
        hook_archetype: "problem_agitator",
        must_avoid: [],
      },
      {
        index: 1,
        title: "Video 2",
        angle: "Angle 2",
        key_message: "Message 2",
        hook_archetype: "shock_counterintuitive",
        must_avoid: ["Message 1"],
      },
    ];

    const parsed = batchPlanSchema.safeParse(validPlan);
    expect(parsed.success).toBe(true);

    const invalidPlan = [
      {
        index: 0,
        title: "", // Empty title invalid
        angle: "Angle 1",
        key_message: "Message 1",
        hook_archetype: "invalid_hook_type",
        must_avoid: [],
      },
    ];
    const invalidResult = batchPlanSchema.safeParse(invalidPlan);
    expect(invalidResult.success).toBe(false);
  });

  it("generates N theme scripts with different titles and plan items using mock LLM", async () => {
    const prevMock = process.env.FLOW_MOCK_LLM;
    process.env.FLOW_MOCK_LLM = "1";
    try {
      const res = await generateBatchScriptsWithLLM(
        {
          batch_mode: "theme",
          batch_theme: "Learn & Unlearn",
          batch_count: 2,
          duration: 60,
        },
        2,
        "theme"
      );

      expect(res.scripts.length).toBe(2);
      expect(res.scripts[0].title).toBeDefined();
      expect(res.scripts[1].title).toBeDefined();
      expect(res.scripts[0].title).not.toBe(res.scripts[1].title);
      expect(res.scripts[0].plan_item?.index).toBe(0);
      expect(res.scripts[1].plan_item?.index).toBe(1);
      expect(res.theme).toBe("Learn & Unlearn");
      expect(res.linked).toBe(false);
      expect(res.plan?.length).toBe(2);
      expect(res.plan?.every((p) => !p.link_from_prev && !p.link_to_next)).toBe(true);

      const allText = res.scripts
        .flatMap((s) => s.scenes.map((scene) => `${scene.title} ${scene.script} ${scene.prompt}`))
        .join(" ");
      expect(allText).not.toMatch(/melanjutkan|kelanjutannya|video sebelumnya|video berikutnya|\bpart\s+\d/i);
    } finally {
      process.env.FLOW_MOCK_LLM = prevMock;
    }
  });

  it("handles partial failure where failed item is returned with error and valid items succeed", async () => {
    const prevMock = process.env.FLOW_MOCK_LLM;
    process.env.FLOW_MOCK_LLM = "1";
    try {
      const res = await generateBatchScriptsWithLLM(
        {
          batch_mode: "theme",
          prompt: "SIMULATE_PARTIAL_FAILURE",
          batch_theme: "Test Theme",
          batch_count: 2,
          duration: 60,
        },
        2,
        "theme"
      );

      expect(res.scripts.length).toBe(2);
      expect(res.scripts[0].error).toBeUndefined();
      expect(res.scripts[0].scenes.length).toBeGreaterThan(0);

      // Video 2 failed but was returned gracefully as script object with error
      expect(res.scripts[1].error).toContain("Simulated LLM network error");
      expect(res.scripts[1].scenes.length).toBe(0);
      expect(res.scripts[1].title).toBeDefined();
    } finally {
      process.env.FLOW_MOCK_LLM = prevMock;
    }
  });

  it("persists and restores theme and plan in Script Vault", () => {
    const scriptsDir = getScriptsDir();
    const activePath = join(scriptsDir, "active_batch_scripts.json");
    const archivePath = join(scriptsDir, "batch_vault_theme_test.scripts.json");
    const prevRaw = existsSync(activePath) ? readFileSync(activePath, "utf8") : null;

    try {
      const plan: BatchPlanItem[] = [
        {
          index: 0,
          title: "Video 1: Mindset Unlearn",
          angle: "Unlearn",
          key_message: "Hapus kebiasaan lama",
          hook_archetype: "shock_counterintuitive",
          must_avoid: [],
        },
        {
          index: 1,
          title: "Video 2: Cara Belajar Cepat",
          angle: "Learn",
          key_message: "Metode baru",
          hook_archetype: "relatable_pov",
          must_avoid: ["Hapus kebiasaan lama"],
        },
      ];

      const scripts = [
        {
          title: "Video 1: Mindset Unlearn",
          plan_item: plan[0],
          scenes: [{ num: 1, duration: 10, prompt: "Scene 1", script: "Halo" }],
        },
        {
          title: "Video 2: Cara Belajar Cepat",
          plan_item: plan[1],
          scenes: [{ num: 1, duration: 10, prompt: "Scene 1", script: "Halo 2" }],
        },
      ];

      saveActiveBatchScripts({
        batch_id: "batch_vault_theme_test",
        batch_count: 2,
        batch_mode: "theme",
        duration_target: 60,
        platform_preset: "custom",
        video_model: "Omni 1.1 Flash",
        theme: "Learn & Unlearn",
        linked: false,
        plan,
        scripts,
        updated_at: new Date().toISOString(),
      });

      const loaded = loadActiveBatchScripts();
      expect(loaded).not.toBeNull();
      expect(loaded?.batch_mode).toBe("theme");
      expect(loaded?.theme).toBe("Learn & Unlearn");
      expect(loaded?.linked).toBe(false);
      expect(loaded?.plan?.length).toBe(2);
      expect(loaded?.plan?.[0].title).toBe("Video 1: Mindset Unlearn");
      expect(loaded?.plan?.[0].link_to_next).toBeUndefined();
      expect(loaded?.plan?.[1].link_from_prev).toBeUndefined();
      expect(loaded?.scripts[0].title).toBe("Video 1: Mindset Unlearn");
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
});
