import { describe, expect, it } from "bun:test";
import {
  ScenePlanError,
  buildScenePrompt,
  selectScenesForRun,
} from "../src/scene-plan.js";

describe("Scene plan", () => {
  it("keeps exactly the scenes the duration planner asked for", () => {
    const scenes = ["hook", "problem", "product", "cta"];
    const selection = selectScenesForRun(scenes, 3);

    expect(selection.scenes).toEqual(["hook", "problem", "product"]);
    expect(selection.dropped).toEqual(["cta"]);
  });

  it("does not drop anything when the script matches the plan", () => {
    const selection = selectScenesForRun(["a", "b"], 2);
    expect(selection.scenes).toEqual(["a", "b"]);
    expect(selection.dropped).toEqual([]);
  });

  it("throws an actionable error when the script has too few scenes", () => {
    expect(() => selectScenesForRun(["a", "b"], 3)).toThrow(ScenePlanError);

    try {
      selectScenesForRun(["a", "b"], 3, "request");
    } catch (err) {
      const error = err as ScenePlanError;
      expect(error.code).toBe("SCENE_COUNT_MISMATCH");
      expect(error.expected).toBe(3);
      expect(error.actual).toBe(2);
      expect(error.message).toContain("hanya 2 scene");
      expect(error.message).toContain("3 scene");
      expect(error.message).toContain("Pratinjau naskah");
    }
  });

  it("treats a missing script as zero scenes", () => {
    expect(() => selectScenesForRun(undefined, 1, "llm")).toThrow(ScenePlanError);
    expect(() => selectScenesForRun(undefined, 1, "llm")).toThrow(/tidak ada scene/);
  });
});

describe("Scene prompt", () => {
  const base = {
    sceneNum: 2,
    clipsCount: 3,
    prompt: "Doctor pours the supplement into a glass. Audio: old voiceover line",
    script: "Minum setiap pagi.",
    speaker: "Woman",
    voiceLanguage: "Bahasa Indonesia",
    voiceoverPersona: "Warm narrator",
    characterAnchor: "Same woman, 30s",
    settingAnchor: "Bright kitchen",
    storylineOverview: "- Scene 1: Hook\n- Scene 2: Product",
  };

  it("builds a scene-scoped prompt with the audio line read once", () => {
    const prompt = buildScenePrompt(base);

    expect(prompt).toContain("[SCENE 2 OF 3 — DEPICT ONLY THIS SCENE]");
    expect(prompt).toContain("Doctor pours the supplement into a glass.");
    expect(prompt).not.toContain("old voiceover line");
    expect(prompt).toContain("Woman (Warm narrator)");
    expect(prompt).toContain("'Minum setiap pagi.'");
    expect(prompt).toContain("say each word only once");
    expect(prompt).toContain("Character / Mascot / Subject: Same woman, 30s");
    expect(prompt).toContain("Setting / Environment: Bright kitchen");
    expect(prompt).toContain("- Scene 1: Hook");
  });

  it("omits the audio block when a scene has no voiceover", () => {
    const prompt = buildScenePrompt({ ...base, script: undefined, speaker: undefined });

    expect(prompt).not.toContain("Audio: Voiceover");
    expect(prompt).toContain("[SCENE 2 OF 3 — DEPICT ONLY THIS SCENE]");
  });

  it("falls back to the generic continuity wording", () => {
    const prompt = buildScenePrompt({
      ...base,
      characterAnchor: "",
      settingAnchor: "",
    });

    expect(prompt).toContain("Character / Mascot / Subject: Consistent with scene style");
    expect(prompt).toContain("Setting / Environment: Consistent with scene style");
  });
});
