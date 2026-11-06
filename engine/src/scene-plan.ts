// Scene planning shared by the pipeline. The duration planner decides how many
// clips a video needs; this module makes sure a script really has that many
// scenes and builds the prompt for one of them. Everything here is pure so it
// can be tested without Flow, an LLM or the rest of the engine.

export type ScenePlanSource = "request" | "llm" | "checkpoint";

export class ScenePlanError extends Error {
  readonly code = "SCENE_COUNT_MISMATCH";

  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly source: ScenePlanSource
  ) {
    super(sceneMismatchMessage(expected, actual, source));
    this.name = "ScenePlanError";
  }
}

function sceneMismatchMessage(expected: number, actual: number, source: ScenePlanSource): string {
  const guidance =
    source === "request"
      ? "Naskah dari pratinjau tidak dipakai ulang. Klik \"Pratinjau naskah\" untuk membuat naskah baru sesuai durasi ini, atau pilih durasi lain."
      : source === "checkpoint"
        ? "Checkpoint ini dibuat untuk jumlah scene yang berbeda. Mulai job baru untuk durasi ini."
        : "AI tidak mengembalikan scene yang cukup. Coba generate naskah lagi.";
  const found = actual === 0 ? "tidak ada scene" : `hanya ${actual} scene`;
  return `Naskah berisi ${found}, sedangkan durasi ini membutuhkan ${expected} scene. ${guidance}`;
}

export interface SceneSelection<T> {
  /** Exactly `clipsCount` scenes, in script order. */
  scenes: T[];
  /** Extra scenes that were not used (the script was longer than the plan). */
  dropped: T[];
}

/**
 * Slice a script down to the number of scenes the duration planner asked for.
 *
 * A short script is an error instead of silently generating fewer clips: the
 * pipeline would otherwise read a missing scene and stop with a vague
 * "Cannot read properties of undefined" after the script step.
 */
export function selectScenesForRun<T>(
  scenes: readonly T[] | null | undefined,
  clipsCount: number,
  source: ScenePlanSource = "llm"
): SceneSelection<T> {
  const list = Array.isArray(scenes) ? scenes : [];
  if (list.length < clipsCount) {
    throw new ScenePlanError(clipsCount, list.length, source);
  }
  return {
    scenes: list.slice(0, clipsCount),
    dropped: list.slice(clipsCount),
  };
}

export interface ScenePromptInput {
  sceneNum: number;
  clipsCount: number;
  /** Visual prompt/action from the script (an old "Audio: …" suffix is ignored). */
  prompt: string;
  /** Voiceover line for this scene. */
  script?: string;
  speaker?: string;
  voiceLanguage: string;
  voiceoverPersona: string;
  characterAnchor?: string;
  settingAnchor?: string;
  /** One-line list of every scene title, for continuity context only. */
  storylineOverview: string;
}

/** Prompt sent to Flow for one scene, with the audio and continuity rules. */
export function buildScenePrompt(input: ScenePromptInput): string {
  const action = String(input.prompt || "").replace(/Audio:.*$/i, "").trim();
  const speakerLabel = input.speaker
    ? `${input.speaker} (${input.voiceoverPersona})`
    : input.voiceoverPersona;
  const audio = input.script
    ? `Audio: Voiceover in ${input.voiceLanguage} by ${speakerLabel}. Read this line exactly once, word for word, at a natural steady pace. Do not repeat, echo, stutter, restart, or add any word or phrase; say each word only once: '${input.script}'`
    : "";

  return `[SCENE ${input.sceneNum} OF ${input.clipsCount} — DEPICT ONLY THIS SCENE]:
${action}
${audio}

[CONTINUITY REFERENCE ONLY — DO NOT DEPICT OR SPEAK OTHER SCENES]:
Product Packaging Rule: Keep product shape, packaging, and printed brand label faithful to the attached reference image(s). Do not add overlaid subtitles, captions, or watermarks.
Character / Mascot / Subject: ${input.characterAnchor || "Consistent with scene style"}
Setting / Environment: ${input.settingAnchor || "Consistent with scene style"}
Voiceover Persona: ${input.voiceoverPersona}
Story Arc Titles (context only):
${input.storylineOverview}
Maintain 100% strict visual consistency for all characters/mascots/subjects and exact same vocal persona and pace across all shots. The voice must match the on-screen character's gender and age. Movements and object interactions must flow naturally, with no objects appearing, vanishing, or changing abruptly.`;
}
