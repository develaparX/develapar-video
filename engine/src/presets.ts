export interface HookTemplate {
  archetype: "problem_agitator" | "price_drop_deal" | "shock_counterintuitive" | "relatable_pov" | "sensory_curiosity" | "social_proof_secret";
  category: "health_supplement" | "general_commercial";
  hook_text_3s: string;
  retention_promise: string;
  share_trigger: string;
  cta_mode: "cart_checkout" | "dm_share" | "save_bookmark";
}

// Hook library: observation-only opening lines. No medical claims, no certification
// claims, no absolute guarantees, no unverified multipliers. Max 7 words per hook.
export const HOOK_LIBRARY: HookTemplate[] = [
  // Health & Supplement
  {
    archetype: "problem_agitator",
    category: "health_supplement",
    hook_text_3s: "Badan pegal padahal baru bangun?",
    retention_promise: "Kebiasaan pagi yang sering terlewat",
    share_trigger: "Kirim ke yang sering pegal saat bangun",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "price_drop_deal",
    category: "health_supplement",
    hook_text_3s: "Harga paketnya lagi turun hari ini.",
    retention_promise: "Isi paket dan varian yang ikut turun",
    share_trigger: "Kirim ke yang sedang cari stok",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "shock_counterintuitive",
    category: "health_supplement",
    hook_text_3s: "Ternyata urutan minumnya berpengaruh.",
    retention_promise: "Cara baca aturan pakai di kemasan",
    share_trigger: "Kirim ke grup keluarga biar tidak salah",
    cta_mode: "save_bookmark"
  },
  {
    archetype: "relatable_pov",
    category: "health_supplement",
    hook_text_3s: "POV: jam kantor, badan sudah protes.",
    retention_promise: "Rutinitas dua menit di sela kerja",
    share_trigger: "Relate sama teman se-divisi",
    cta_mode: "dm_share"
  },
  {
    archetype: "sensory_curiosity",
    category: "health_supplement",
    hook_text_3s: "Buka tutupnya, aromanya langsung terasa.",
    retention_promise: "Tekstur dan aroma sebelum diminum",
    share_trigger: "Penasaran sama aroma kemasannya",
    cta_mode: "save_bookmark"
  },
  {
    archetype: "social_proof_secret",
    category: "health_supplement",
    hook_text_3s: "Komentar paling sering tanya varian ini.",
    retention_promise: "Varian yang paling sering ditanyakan",
    share_trigger: "Kirim ke yang ikut menanyakan varian",
    cta_mode: "cart_checkout"
  },

  // General Commercial (Beauty, F&B, Gadget, Fashion, Home)
  {
    archetype: "problem_agitator",
    category: "general_commercial",
    hook_text_3s: "Barang ini bikin meja jadi sempit.",
    retention_promise: "Ukuran asli dan cara melipatnya",
    share_trigger: "Kirim ke yang kamarnya sempit",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "price_drop_deal",
    category: "general_commercial",
    hook_text_3s: "Harga lama masih nempel di label.",
    retention_promise: "Selisih harga sebelum dan sesudah",
    share_trigger: "Kirim ke yang menunggu harga turun",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "shock_counterintuitive",
    category: "general_commercial",
    hook_text_3s: "Ternyata cara pakainya bukan begitu.",
    retention_promise: "Urutan pakai yang mengubah hasil",
    share_trigger: "Kirim ke yang masih salah pakai",
    cta_mode: "dm_share"
  },
  {
    archetype: "relatable_pov",
    category: "general_commercial",
    hook_text_3s: "POV: nemu barang ini di rak terakhir.",
    retention_promise: "Alasan rak itu cepat kosong",
    share_trigger: "Kirim kode barang ke bestie",
    cta_mode: "dm_share"
  },
  {
    archetype: "sensory_curiosity",
    category: "general_commercial",
    hook_text_3s: "Dengar bunyi klik pertama kali dibuka.",
    retention_promise: "Tekstur dan bunyi saat dipakai",
    share_trigger: "Bikin penasaran yang lewat",
    cta_mode: "save_bookmark"
  },
  {
    archetype: "social_proof_secret",
    category: "general_commercial",
    hook_text_3s: "Tiap kali dipajang, pasti ditanya.",
    retention_promise: "Alasan orang balik menanyakan barang ini",
    share_trigger: "Tag yang kemarin ikut bertanya",
    cta_mode: "cart_checkout"
  }
];

export type PlatformPreset = "tiktok_fyp" | "reels_brand" | "custom";

export interface VideoModelDefinition {
  id: string;
  name: string;
  family: "omni" | "veo";
  durations: number[];
  default_duration: number;
  has_duration_picker: boolean;
  resolutions: string[];
  native_audio: boolean;
  credits_per_clip: Record<number, number> | number;
  base_cost: number;
  description: string;
}

export const SUPPORTED_VIDEO_MODELS: Record<string, VideoModelDefinition> = {
  "Omni 1.1 Flash": {
    id: "Omni 1.1 Flash",
    name: "Omni 1.1 Flash",
    family: "omni",
    durations: [4, 6, 8, 10],
    default_duration: 10,
    has_duration_picker: true,
    resolutions: ["360p", "720p"],
    native_audio: true,
    credits_per_clip: {
      4: 7,
      6: 10,
      8: 12,
      10: 15,
    },
    base_cost: 15,
    description: "Omni 1.1 Flash: durasi 4s/6s/8s/10s (7–15 cr), resolusi 360p/720p, audio native.",
  },
  "Veo 3.1 - Lite": {
    id: "Veo 3.1 - Lite",
    name: "Veo 3.1 - Lite",
    family: "veo",
    durations: [8],
    default_duration: 8,
    has_duration_picker: false,
    resolutions: ["720p"],
    native_audio: false,
    credits_per_clip: 10,
    base_cost: 10,
    description: "Veo 3.1 - Lite: durasi 8s (10 cr), 720p, tanpa audio.",
  },
  "Veo 3.1 - Fast": {
    id: "Veo 3.1 - Fast",
    name: "Veo 3.1 - Fast",
    family: "veo",
    durations: [8],
    default_duration: 8,
    has_duration_picker: false,
    resolutions: ["720p"],
    native_audio: false,
    credits_per_clip: 20,
    base_cost: 20,
    description: "Veo 3.1 - Fast: durasi 8s (20 cr), 720p, tanpa audio.",
  },
  "Veo 3.1 - Quality": {
    id: "Veo 3.1 - Quality",
    name: "Veo 3.1 - Quality",
    family: "veo",
    durations: [8],
    default_duration: 8,
    has_duration_picker: false,
    resolutions: ["720p"],
    native_audio: false,
    credits_per_clip: 100,
    base_cost: 100,
    description: "Veo 3.1 - Quality: durasi 8s (100 cr), 720p, tanpa audio.",
  },
};

export type SupportedVideoModel = keyof typeof SUPPORTED_VIDEO_MODELS;

export function getVideoModelCost(model: string, duration?: number): number {
  const norm = Object.keys(SUPPORTED_VIDEO_MODELS).find((k) => k.toLowerCase() === model.toLowerCase());
  const def = norm ? SUPPORTED_VIDEO_MODELS[norm] : undefined;
  if (!def) {
    if (/quality/i.test(model)) return 100;
    if (/fast/i.test(model)) return 20;
    if (/lite/i.test(model)) return 10;
    if (/veo/i.test(model)) return 20;
    const d = duration ?? 10;
    if (d <= 4) return 7;
    if (d <= 6) return 10;
    if (d <= 8) return 12;
    return 15;
  }
  if (typeof def.credits_per_clip === "number") {
    return def.credits_per_clip;
  }
  const d = duration ?? 10;
  return def.credits_per_clip[d] ?? (d <= 4 ? 7 : d <= 6 ? 10 : d <= 8 ? 12 : 15);
}

export interface PipelineCreditCalculation {
  total_required: number;
  unit_cost: number;
  clips_count: number;
  scene1_variants: number;
  scenes_cost: number[];
  video_model: string;
}

export function calculatePipelineCredits(
  body: {
    video_model?: string;
    variants?: number;
    scene1_variants?: number;
    scenes_count?: number;
    scenes?: Array<{ duration?: number }>;
  },
  resolved?: ResolvedPlatformConfig
): PipelineCreditCalculation {
  const videoModel = body.video_model || resolved?.video_model || "Omni 1.1 Flash";
  const clipsCount = resolved?.clips_count ?? body.scenes_count ?? (body.scenes?.length ? body.scenes.length : 2);
  const clipDurations = resolved?.clip_durations ?? (body.scenes ? body.scenes.map((s) => s.duration ?? 10) : Array(clipsCount).fill(10));

  const scene1Variants = Math.max(1, Math.min(4, body.scene1_variants ?? body.variants ?? 1));
  const scenesCost: number[] = [];

  for (let i = 0; i < clipsCount; i++) {
    const dur = clipDurations[i] ?? 10;
    const unit = getVideoModelCost(videoModel, dur);
    const variants = i === 0 ? scene1Variants : 1;
    scenesCost.push(unit * variants);
  }

  const totalRequired = scenesCost.reduce((sum, cost) => sum + cost, 0);
  const primaryUnitCost = getVideoModelCost(videoModel, clipDurations[0] ?? 10);

  return {
    total_required: totalRequired,
    unit_cost: primaryUnitCost,
    clips_count: clipsCount,
    scene1_variants: scene1Variants,
    scenes_cost: scenesCost,
    video_model: videoModel,
  };
}

export interface BatchPipelineEstimate {
  platform: PlatformPreset;
  video_model: string;
  duration_target: number;
  clips_count: number;
  clip_durations: number[];
  scene1_variants: number;
  scenes_cost: number[];
  credits_per_video: number;
  time_seconds_per_video: number;
  time_formatted_per_video: string;
  batch_count: number;
  total_credits: number;
  total_time_seconds: number;
  total_time_formatted: string;
  per_scene_breakdown: Array<{
    scene_num: number;
    duration: number;
    credits: number;
    estimated_seconds: number;
  }>;
}

export function estimateBatchPipeline(options: {
  platform_preset?: PlatformPreset;
  duration_target?: number;
  video_model?: string;
  batch_count?: number;
  scene1_variants?: number;
  enable_endcard?: boolean;
}): BatchPipelineEstimate {
  const platform = (options.platform_preset || "custom") as PlatformPreset;
  const duration = options.duration_target || 60;
  const videoModel = options.video_model || "Omni 1.1 Flash";
  const batchCount = Math.max(1, Math.round(options.batch_count || 1));
  const scene1Variants = Math.max(1, Math.min(4, options.scene1_variants ?? 1));

  const resolved = resolvePlatformPreset(platform, {
    video_model: videoModel,
    duration_target: duration,
    enable_endcard: options.enable_endcard !== false,
  });

  const creditCalc = calculatePipelineCredits(
    { video_model: videoModel, scene1_variants: scene1Variants },
    resolved
  );

  const isVeo = /veo/i.test(videoModel);
  const secondsPerClip = isVeo ? 75 : 35;
  const stitchingSeconds = 12;

  const perSceneBreakdown = resolved.clip_durations.map((dur, idx) => {
    const cost = creditCalc.scenes_cost[idx] ?? getVideoModelCost(videoModel, dur);
    const estSec = secondsPerClip * (idx === 0 ? scene1Variants : 1);
    return {
      scene_num: idx + 1,
      duration: dur,
      credits: cost,
      estimated_seconds: estSec,
    };
  });

  const timePerVideo = perSceneBreakdown.reduce((sum, s) => sum + s.estimated_seconds, 0) + stitchingSeconds;
  const totalCredits = creditCalc.total_required * batchCount;
  const totalTimeSeconds = timePerVideo * batchCount;

  function formatDuration(sec: number): string {
    const mins = Math.floor(sec / 60);
    const remainder = Math.round(sec % 60);
    if (mins === 0) return `${remainder} detik`;
    if (remainder === 0) return `~${mins} menit`;
    return `~${mins} menit ${remainder} dtk`;
  }

  return {
    platform: resolved.platform,
    video_model: resolved.video_model,
    duration_target: resolved.duration_target,
    clips_count: resolved.clips_count,
    clip_durations: resolved.clip_durations,
    scene1_variants: scene1Variants,
    scenes_cost: creditCalc.scenes_cost,
    credits_per_video: creditCalc.total_required,
    time_seconds_per_video: timePerVideo,
    time_formatted_per_video: formatDuration(timePerVideo),
    batch_count: batchCount,
    total_credits: totalCredits,
    total_time_seconds: totalTimeSeconds,
    total_time_formatted: formatDuration(totalTimeSeconds),
    per_scene_breakdown: perSceneBreakdown,
  };
}

export const ENDCARD_SECONDS = 2.5;
// Clips are joined end to end. Crossfades re-timed Flow's clips (each came back a shade shorter than requested) and
// showed as stutter at every join, so the resolver now plans whole clips that add up instead.
export const TRANSITION_SECONDS = 0;

export type HookArchetype = HookTemplate["archetype"];
export type HookCategory = HookTemplate["category"];

export interface PlatformResolveOptions {
  video_model?: string;
  duration_target?: number;
  style_id?: string;
  tone_id?: string;
  preset_id?: "free" | "health_softsell" | "general_commercial";
  subject_mode?: "hands" | "pov" | "product" | "character";
  cta_mode?: "cart_checkout" | "dm_share" | "save_bookmark";
  enable_endcard?: boolean;
  hook_archetype?: HookArchetype;
}

export interface ResolvedPlatformConfig {
  platform: PlatformPreset;
  video_model: string;
  /** Final video duration requested by the user, including the static end-card. */
  duration_target: number;
  /** Estimated final duration: content timeline + end-card. */
  duration_actual: number;
  /** Sum of the generated scene clip durations (before crossfade overlap). */
  clip_total: number;
  /** Extra freeze-frame hold on the final scene so the content timeline hits its budget. */
  tail_pad: number;
  endcard_seconds: number;
  clips_count: number;
  clip_durations: number[];
  style_id: string;
  tone_id: string;
  preset_id: "free" | "health_softsell" | "general_commercial";
  subject_mode: "hands" | "pov" | "product" | "character";
  cta_mode: "cart_checkout" | "dm_share" | "save_bookmark";
  hook_category: HookCategory;
  hook_archetype?: HookArchetype;
}

export class PlatformPresetError extends Error {
  readonly code = "INVALID_PLATFORM_PRESET";
  readonly allowed_durations: number[];

  constructor(message: string, allowedDurations: number[] = []) {
    super(message);
    this.name = "PlatformPresetError";
    this.allowed_durations = allowedDurations;
  }
}

// Longest first, so 30 s becomes three 10 s clips rather than a 8+8+8+4+4 split.
const OMNI_PLAN_UNITS = [10, 8, 6, 4];

function roundDuration(value: number): number {
  return Math.round(value * 100) / 100;
}

function contentTimeline(durations: number[]): number {
  const total = durations.reduce((sum, value) => sum + value, 0);
  return total - Math.max(0, durations.length - 1) * TRANSITION_SECONDS;
}

interface PlannedDurations {
  durations: number[];
  tailPad: number;
  score: number;
}

// Scores a candidate schedule against the content budget. Overshoot is trimmed
// from the last clip; a sub-frame-size shortfall is absorbed by holding the
// last frame. Anything else is rejected so the final duration stays exact.
function evaluatePlan(durations: number[], required: number): PlannedDurations | null {
  const timeline = contentTimeline(durations);
  const diff = roundDuration(required - timeline);
  const clipPenalty = durations.length * 0.5;

  if (Math.abs(diff) <= 0.051) {
    return { durations, tailPad: 0, score: clipPenalty };
  }
  if (diff > 0) {
    if (diff > TRANSITION_SECONDS + 0.05) return null;
    return { durations, tailPad: diff, score: clipPenalty + 0.5 + diff * 0.1 };
  }

  const over = -diff;
  const last = durations[durations.length - 1];
  if (last - over < 0.9) return null;
  const trimmed = [...durations];
  trimmed[trimmed.length - 1] = roundDuration(last - over);
  return { durations: trimmed, tailPad: 0, score: clipPenalty + 0.6 + over * 0.2 };
}

function planOmniDurations(required: number): PlannedDurations {
  if (required <= 0) return { durations: [4], tailPad: 0, score: 0 };

  // Long custom durations (minutes) are filled with 10s clips; the last clip
  // absorbs the remainder so the total stays on target.
  if (required > 55) {
    let best: PlannedDurations | null = null;
    for (let count = 1; count <= 40; count++) {
      const evaluated = evaluatePlan(Array.from({ length: count }, () => 10), required);
      if (evaluated && (!best || evaluated.score < best.score - 1e-9)) best = evaluated;
    }
    return best ?? { durations: [10], tailPad: 0, score: 0 };
  }

  let best: PlannedDurations | null = null;
  for (let count = 1; count <= 7; count++) {
    const stack: number[] = [];
    const walk = (): void => {
      if (stack.length === count) {
        const evaluated = evaluatePlan([...stack], required);
        if (evaluated && (!best || evaluated.score < best.score - 1e-9)) best = evaluated;
        return;
      }
      for (const unit of OMNI_PLAN_UNITS) {
        stack.push(unit);
        walk();
        stack.pop();
      }
    };
    walk();
  }
  return best ?? { durations: [10], tailPad: 0, score: 0 };
}

function planVeoDurations(required: number): PlannedDurations {
  let best: PlannedDurations | null = null;
  for (let count = 1; count <= 8; count++) {
    const evaluated = evaluatePlan(Array.from({ length: count }, () => 8), required);
    if (evaluated && (!best || evaluated.score < best.score - 1e-9)) best = evaluated;
  }
  return best ?? { durations: [8], tailPad: 0, score: 0 };
}

export function resolvePlatformPreset(
  platform?: PlatformPreset,
  options: PlatformResolveOptions = {}
): ResolvedPlatformConfig {
  const p = platform || "tiktok_fyp";
  if (p !== "tiktok_fyp" && p !== "reels_brand" && p !== "custom") {
    throw new PlatformPresetError(
      `Platform preset "${String(p)}" tidak dikenal. Gunakan tiktok_fyp, reels_brand, atau custom.`,
      []
    );
  }
  const videoModel = options.video_model || "Omni 1.1 Flash";
  const isVeo = /veo/i.test(videoModel);
  const endcardSeconds = options.enable_endcard === false ? 0 : ENDCARD_SECONDS;

  let allowedDurations: number[] = [];
  let defaultDuration = 16;
  let styleId = "G1";
  let toneId = "T8";
  let presetId: ResolvedPlatformConfig["preset_id"] = "general_commercial";
  let subjectMode: ResolvedPlatformConfig["subject_mode"] = "hands";
  let ctaMode: ResolvedPlatformConfig["cta_mode"] = "cart_checkout";

  if (p === "tiktok_fyp") {
    allowedDurations = isVeo ? [16] : [16, 20];
    defaultDuration = 16;
    styleId = "G1";
    toneId = "T8";
    subjectMode = "hands";
    ctaMode = "cart_checkout";
  } else if (p === "reels_brand") {
    allowedDurations = [16, 24];
    defaultDuration = 16;
    styleId = "G1";
    toneId = "T8";
    subjectMode = "pov";
    ctaMode = "dm_share";
  } else {
    defaultDuration = isVeo ? 24 : 30;
    allowedDurations = isVeo ? [8, 16, 24, 32] : [];
    styleId = "auto";
    toneId = "auto";
    presetId = "free";
    subjectMode = "product";
    ctaMode = "cart_checkout";
  }

  const requested = options.duration_target;
  const target = requested ?? defaultDuration;

  if (!Number.isFinite(target) || target <= 0) {
    throw new PlatformPresetError(
      `Durasi ${String(requested)} tidak valid. Gunakan angka detik yang didukung.`,
      allowedDurations
    );
  }
  if (p !== "custom" && !allowedDurations.includes(target)) {
    throw new PlatformPresetError(
      `Kombinasi tidak valid: preset ${p} + ${videoModel} + ${target}s. Durasi yang didukung: ${allowedDurations.join("/")} detik.`,
      allowedDurations
    );
  }
  if (p === "custom") {
    if (isVeo && !allowedDurations.includes(target)) {
      throw new PlatformPresetError(
        `Veo hanya mendukung klip 8 detik. Durasi ${target}s tidak valid; pilih ${allowedDurations.join("/")} detik.`,
        allowedDurations
      );
    }
    if (!isVeo && (target < 4 || target > 300)) {
      throw new PlatformPresetError(
        `Durasi ${target}s di luar rentang yang didukung (4–300 detik).`,
        allowedDurations
      );
    }
  }

  const resolvedPreset = options.preset_id || presetId;
  const requiredContent = Math.max(2, target - endcardSeconds);
  const plan = isVeo ? planVeoDurations(requiredContent) : planOmniDurations(requiredContent);
  const clipDurations = plan.durations;
  const clipTotal = clipDurations.reduce((sum, value) => sum + value, 0);
  const durationActual = roundDuration(contentTimeline(clipDurations) + plan.tailPad + endcardSeconds);

  return {
    platform: p,
    video_model: videoModel,
    duration_target: target,
    duration_actual: durationActual,
    clip_total: roundDuration(clipTotal),
    tail_pad: plan.tailPad,
    endcard_seconds: endcardSeconds,
    clips_count: clipDurations.length,
    clip_durations: clipDurations,
    style_id: options.style_id || styleId,
    tone_id: options.tone_id || toneId,
    preset_id: resolvedPreset,
    subject_mode: options.subject_mode || subjectMode,
    cta_mode: p === "custom" ? (options.cta_mode || ctaMode) : ctaMode,
    hook_category: resolvedPreset === "health_softsell" ? "health_supplement" : "general_commercial",
    hook_archetype: options.hook_archetype,
  };
}

export interface StyleOption {
  id: string;
  code: string;
  name: string;
  preset: "health_softsell" | "general_commercial";
  summary: string;
  suitableFor: string;
  goodTones: string[];
  words30s: string;
  structure: string[];
  visualDna: string;
  riskNote?: string;
}

export interface ToneOption {
  id: string;
  code: string;
  name: string;
  summary: string;
  example: string;
  goodStyles: string[];
}

export interface PresetPack {
  id: "free" | "health_softsell" | "general_commercial";
  name: string;
  description: string;
  rules: string;
}

export const PRESET_PACKS: PresetPack[] = [
  {
    id: "free",
    name: "Bebas / Multi-Produk (Sesuai Brief User)",
    description: "Fleksibel untuk produk apa pun (F&B, Skincare, Fashion, Gadget, Suplemen, Jasa, dll). Mengikuti instruksi brief user sepenuhnya atau otomatis menyesuaikan kategori produk dari foto.",
    rules: `[MODE: BEBAS / MULTI-KATEGORI PRODUK]
- Analisis kategori produk secara akurat dari foto yang dilampirkan (makanan/minuman, skincare/kosmetik, fashion, elektronik/gadget, kesehatan/herbal, kebutuhan rumah, jasa, dll).
- Ikuti instruksi di "INI USER PROMPT" sebagai prioritas utama untuk gaya visual, alur cerita, karakter, dan tone.
- Jika user tidak menentukan gaya atau karakter secara spesifik di brief, pilih konsep kreatif terbaik yang paling menjual dan relevan dengan kategori produk tersebut.`
  },
  {
    id: "health_softsell",
    name: "Edukasi Kesehatan + Soft-Selling (BPOM Safe)",
    description: "Konten edukasi kesehatan berbasis animasi + soft selling (80% edukasi/cerita, 20% produk sebagai pendamping) sesuai aturan klaim BPOM untuk TikTok/Reels/Shorts.",
    rules: `[MODE: EDUKASI KESEHATAN + SOFT SELLING (ATURAN KETAT BPOM)]
1. RISET PRODUK DARI FOTO LABEL & PENGETAHUAN MEDIS DASAR:
   - Baca nama produk, merek, nomor izin edar (POM TR / BPOM / P-IRT / lainnya), bentuk sediaan (kapsul/cair/tablet/serbuk/sachet/oles), komposisi, dan klaim resmi di label foto.
   - Jika ada beberapa foto (mis. tampak depan & label komposisi belakang), gabungkan informasinya. Prioritaskan teks yang tertulis di label foto.
   - Abaikan klaim berlebihan ala marketplace ("ampuh", "tanpa operasi", "sembuh total").

2. PENYEBUTAN PRODUK (SOFT SELLING 80/20):
   - Konten harus layak ditonton sebagai edukasi/cerita (minimal 80% isi adalah edukasi & cerita).
   - Nama produk diambil persis dari label dan disebut 1–2 kali saja, setelah bagian edukasi (di paruh akhir video).
   - Produk hadir sebagai pendamping pola hidup sehat atau kebiasaan baik, BUKAN solusi ajaib.
   - Tanpa CTA beli kasar, harga, promo, atau ajakan klik keranjang kecuali diminta khusus oleh user.

3. KLAIM DAN ATURAN BPOM:
   - Gunakan kata aman: "membantu", "mendampingi", "menjaga", "memelihara", atau "secara tradisional digunakan untuk".
   - DILARANG KERAS menggunakan kata: sembuh, menyembuhkan, ampuh, manjur, pasti, 100%, tanpa operasi, hilang seketika, obat [penyakit], menghancurkan, memperbaiki jaringan, menutup luka.
   - Tanpa klaim before-after instan dan tanpa testimoni kesembuhan penyakit berat.
   - Efek produk di visual selalu bertahap, lembut, dan parsial (tidak instan, tidak ajaib, tidak ada ledakan).
   - Selalu sertakan pesan pola hidup sehat (mis. minum air putih, istirahat, pola makan) dan anjuran periksa ke dokter bila keluhan berlanjut.

4. PRODUK & KEAMANAN VISUAL:
   - Bentuk produk dan bentuk sediaan mengikuti foto referensi secara akurat (misal kapsul, cairan, tablet, sachet).
   - Momen mengonsumsi/menggunakan produk hanya sekali di dekat akhir secara tenang dan natural.
   - Tanpa darah, jaringan mentah, luka, operasi, atau gore. Visual dalam tubuh harus bersih, stylized, dan tidak menyeramkan.`
  },
  {
    id: "general_commercial",
    name: "Iklan Produk Umum / Komersial (Multi-Kategori)",
    description: "Template komersial siap pakai untuk berbagai produk fisik maupun digital (UGC, Studio Hero, Lifestyle, Problem-Solution, ASMR, 3D Stylized).",
    rules: `[MODE: IKLAN PRODUK UMUM / KOMERSIAL MULTI-KATEGORI]
1. IDENTIFIKASI PRODUK & VALUE PROPOSITION:
   - Kenali merek, varian, bentuk fisik/kemasan, tekstur, dan fitur utama dari seluruh foto yang dilampirkan.
   - Tonjolkan daya tarik utama sesuai kategori:
     * Makanan/Minuman: tekstur, kesegaran, appetite appeal, momen menikmati.
     * Skincare/Beauty: tekstur produk, sensasi di kulit, kemasan estetik, rutinitas perawatan.
     * Fashion/Aksesoris: potongan (fit), detail bahan, kepercayaan diri pemakai, mix & match.
     * Gadget/Alat Rumah Tangga: kemudahan pakai, pemecahan masalah praktis (problem -> solution), desain modern.
     * Kesehatan/Suplemen: tetap patuhi batas klaim aman ("membantu menjaga").
2. STRUKTUR KOMERSIAL EFEKTIF:
   - Buka dengan hook kuat di 3 detik pertama, tunjukkan relevansi/kebutuhan, hadirkan produk dengan jelas sesuai foto referensi, dan tutup dengan kesan meyakinkan.`
  }
];

export const STYLE_OPTIONS: StyleOption[] = [
  // Health Soft-Selling Styles (S1 - S4)
  {
    id: "S1",
    code: "S1",
    name: "S1 — Cerita 3D Hangat (Karakter Manusia)",
    preset: "health_softsell",
    summary: "Animasi 3D sinematik kelas film, cahaya golden-hour hangat, karakter manusia ekspresif dalam situasi sehari-hari, transisi lembut ke penjelasan dalam tubuh.",
    suitableFor: "Audiens umum, kondisi yang dekat dengan kebiasaan sehari-hari, konten dengan kedekatan emosional.",
    goodTones: ["T1", "T2", "T3", "T6"],
    words30s: "60–70 kata (sekitar 20–23 kata per klip 10 dtk)",
    structure: [
      "Hook relatable: tokoh dalam situasi sehari-hari yang terkait kondisi tubuh.",
      "Konflik ringan & edukasi dalam tubuh: kebiasaan bermasalah lalu transisi lembut ke penampang tubuh 3D bersih yang menjelaskan kondisinya tanpa produk.",
      "Kebiasaan sehat + produk & penutup: tokoh menerapkan pola hidup sehat, mengonsumsi produk sekali secara tenang sebagai pendamping, ditutup pesan pola hidup & anjuran dokter."
    ],
    visualDna: "Vertical 9:16, high-end cinematic 3D animated feature-film look, polished CGI with soft global illumination, stylized proportions, rich textures, expressive character animation. Warm golden-hour sunlight, soft rim light, gentle glow, palette of cream, soft gold, and muted tones with accent colors from the product label. Expressive stylized 3D characters with large glossy eyes, detailed hair strands, soft subsurface skin shading, natural expressions. Inside-the-body scenes: clean stylized translucent cutaway with soft blue-and-gold glow, gentle fluid motion, no blood, no gore. Keep character face, hair, outfit, and proportions identical in every shot."
  },
  {
    id: "S2",
    code: "S2",
    name: "S2 — Sinematik Premium (Produk Sebagai Bintang)",
    preset: "health_softsell",
    summary: "Fotorealistik 3D iklan produk premium + visualisasi ilmiah sinematik. Palet biru-putih-perak bersih, tanpa karakter manusia.",
    suitableFor: "Produk yang ingin tampil premium, kredibel, bersih, dan ilmiah (paling stabil di model video).",
    goodTones: ["T1", "T4", "T5", "T7", "T8"],
    words30s: "55–70 kata (sekitar 18–23 kata per klip 10 dtk)",
    structure: [
      "Pembuka & masuk tubuh: produk tampil elegan di permukaan bersih, sediaan produk menuju siluet tubuh bercahaya sambil mengangkat pemicu masalah sehari-hari.",
      "Dunia mikro dalam tubuh: visual mikro 3D abstrak & bersih tentang kondisi tubuh, partikel cahaya lembut bekerja bertahap membantu menenangkan area tersebut.",
      "Transisi & penutup elegan: siluet tubuh transparan bercahaya lebih seimbang, kembali ke produk di latar bersih dengan pesan pola hidup sehat."
    ],
    visualDna: "Vertical 9:16, photorealistic cinematic 3D, premium product-commercial look combined with high-end scientific visualization. Clean, cool, sterile blue, white, and silver palette with cyan glowing accents. Real-world scenes on elegant minimal surface with soft window light and bokeh. Inside-the-body scenes in deep navy and teal with luminous floating particles, translucent membranes, flowing light ribbons. Body appears only as a transparent glowing silhouette, no human characters. Slow smooth macro camera moves, gradual supportive effect, product packaging faithful to reference photo."
  },
  {
    id: "S3",
    code: "S3",
    name: "S3 — Organ Ngobrol (Komedi Kartun / Stylized)",
    preset: "health_softsell",
    summary: "Animasi kartun ekspresif dengan organ tubuh sebagai karakter berkepribadian yang saling ngobrol dengan komedi situasi ringan.",
    suitableFor: "Konten edukasi ringan, menghibur, mudah viral, dan mudah dibagikan.",
    goodTones: ["T2", "T3", "T6", "T8"],
    words30s: "70–80 kata (sekitar 22–26 kata per klip 10 dtk)",
    structure: [
      "Hook & komplain organ: satu karakter organ langsung komplain dengan ekspresi komedi tentang kebiasaan sehari-hari yang membebaninya.",
      "Masalah & pembalik: dialog komedi singkat yang menjelaskan fakta biologis sederhana, lalu sediaan produk turun dan menyebar sebagai partikel cahaya lembut.",
      "Sisi baik & penutup: partikel membantu secara bertahap bersama pola hidup sehat, organ lebih tenang, menyebut produk 1 kali sebagai pendamping & anjuran dokter."
    ],
    visualDna: "Vertical 9:16, expressive stylized cartoon animation with bold clean outlines, sticker-like cute organ characters with large expressive eyes and distinct silhouettes, smooth squash-and-stretch motion, bright appealing colors. Clean stylized body cross-section background, uncluttered and non-scary. Product particles spread as soft glowing light in label colors working gradually and gently. Snappy comedic timing, character designs identical in every shot."
  },
  {
    id: "S4",
    code: "S4",
    name: "S4 — Maskot Pahlawan 3D (Tokoh Pendamping Imut)",
    preset: "health_softsell",
    summary: "Maskot 3D imut orisinal yang mewakili produk/bahan utama, berkeliling membantu menjaga keseimbangan dengan narasi orang pertama ('Aku...').",
    suitableFor: "Produk dengan bahan utama khas, penjelasan cara kerja versi ringan dan ramah.",
    goodTones: ["T3", "T5", "T7", "T8"],
    words30s: "70–80 kata (sekitar 22–26 kata per klip 10 dtk)",
    riskNote: "Pastikan maskot hanya 'membantu menjaga/mendampingi', tidak menambal luka atau menyembuhkan penyakit.",
    structure: [
      "Hook & pengenalan masalah: maskot imut muncul di dunia mikro tubuh yang stylized, menyapa ceria dan menjelaskan kondisi yang sedang terjadi.",
      "Aksi pendampingan bertahap: partikel bercahaya lembut menyebar, maskot membantu menjaga keseimbangan secara bertahap sesuai klaim label ditambah dukungan air putih/pola hidup sehat.",
      "Hasil lembut & penutup: area tampak lebih tenang, maskot menyebut nama produk 1 kali sebagai pendamping serta pengingat pola hidup sehat & dokter."
    ],
    visualDna: "Vertical 9:16, semi-realistic cinematic 3D animation featuring an original cute round cheerful mascot character with large glossy eyes, small helmet and utility backpack in colors matching the product label, no text on the mascot. Clean stylized microscopic interior in warm coral and soft glowing tones, non-gross. Soft glowing particles and gentle shield-like light symbolizing gradual support. Never depict wound healing or instant magic. Keep mascot design 100% identical in every shot."
  },

  // General Commercial Styles (G1 - G6)
  {
    id: "G1",
    code: "G1",
    name: "G1 — UGC Realistis / Review Kreator TikTok",
    preset: "general_commercial",
    summary: "Gaya video kreator Indonesia yang natural, hangat, seperti direkam di rumah/studio aesthetic, menunjukkan produk langsung ke kamera.",
    suitableFor: "Skincare, F&B, suplemen, barang harian, fashion, gadget konsumen.",
    goodTones: ["T2", "T3", "T6", "T8", "T9"],
    words30s: "65–75 kata",
    structure: [
      "Hook relatable: kreator menyapa ke kamera dengan masalah/kebutuhan sehari-hari yang dekat dengan penonton.",
      "Demo & pengalaman pakai: menunjukkan kemasan produk secara dekat, tekstur/cara pakai, dan manfaat utamanya.",
      "Kesimpulan & rekomendasi: reaksi puas yang natural dan ajakan mencoba."
    ],
    visualDna: "Vertical 9:16, ultra-realistic handheld smartphone creator aesthetic, natural soft indoor daylight in a tidy modern room, shallow depth of field, authentic human creator with warm expressions holding and demonstrating the exact product from the reference image, crisp focus on product packaging."
  },
  {
    id: "G2",
    code: "G2",
    name: "G2 — Product Hero / Studio Komersial Premium",
    preset: "general_commercial",
    summary: "Fokus penuh pada kemewahan produk dengan kamera makro sinematik, pencahayaan studio dramatis, elemen bahan/partikel melayang.",
    suitableFor: "Parfum, skincare, minuman kemasan, elektronik, jam tangan, produk premium semua kategori.",
    goodTones: ["T1", "T4", "T7", "T8", "T9"],
    words30s: "50–65 kata",
    structure: [
      "Hero reveal: siluet dan pencahayaan dramatis membuka tampilan produk utama secara elegan.",
      "Macro detail & bahan/fitur: close-up tekstur, bahan utama, atau fitur unggulan di sekitar produk.",
      "Hero packshot penutup: produk tampil utuh di tengah komposisi studio premium."
    ],
    visualDna: "Vertical 9:16, high-end commercial studio cinematography, macro probe lens camera moves, dramatic rim lighting, glossy reflections, slow-motion atmospheric elements matching the product category, no human characters required, product shape and label 100% faithful to the reference image."
  },
  {
    id: "G3",
    code: "G3",
    name: "G3 — Lifestyle & Day-in-the-Life Sinematik",
    preset: "general_commercial",
    summary: "Mengikuti aktivitas tokoh dalam keseharian modern yang estetik di mana produk menjadi bagian alami dari gaya hidupnya.",
    suitableFor: "Minuman, kopi, fashion, tas, suplemen harian, produk olahraga, aplikasi.",
    goodTones: ["T1", "T3", "T4", "T6", "T9"],
    words30s: "60–70 kata",
    structure: [
      "Momen pembuka: suasana pagi/aktivitas yang sinematik dan relatable.",
      "Integrasi produk: tokoh menggunakan/menikmati produk di tengah aktivitasnya.",
      "Feel-good ending: tokoh tampak segar dan produktif bersama produk."
    ],
    visualDna: "Vertical 9:16, cinematic lifestyle commercial, warm natural sunlight, Golden hour or bright airy modern cafe/home setting, smooth gimbal tracking shots, consistent protagonist appearance and wardrobe across all shots, exact product from reference image."
  },
  {
    id: "G4",
    code: "G4",
    name: "G4 — Problem–Solution & Demo Jelas",
    preset: "general_commercial",
    summary: "Kontras jelas antara kerepotan sebelum memakai produk dan kemudahan/kepraktisan saat menggunakan produk.",
    suitableFor: "Alat rumah tangga, gadget, pembersih, produk otomotif, produk solusi praktis.",
    goodTones: ["T1", "T3", "T8", "T9"],
    words30s: "65–75 kata",
    structure: [
      "Masalah nyata: adegan singkat yang menunjukkan kerepotan umum sehari-hari.",
      "Solusi beraksi: produk digunakan secara langsung memperlihatkan cara kerja yang praktis.",
      "Hasil bersih & mudah: perbandingan suasana yang jauh lebih rapi dan nyaman."
    ],
    visualDna: "Vertical 9:16, crisp modern commercial videography, clear visual storytelling, well-lit real-world environment, smooth camera focus transitions highlighting how the product from the reference image works in action."
  },
  {
    id: "G5",
    code: "G5",
    name: "G5 — ASMR & Sensory Macro Close-Up",
    preset: "general_commercial",
    summary: "Visual jarak sangat dekat yang menonjolkan tekstur, tetesan, uap, kerenyahan, atau kilau produk yang menggugah panca indera.",
    suitableFor: "Makanan, minuman, kopi, coklat, skincare, kosmetik, sabun.",
    goodTones: ["T3", "T4", "T8", "T9"],
    words30s: "45–60 kata",
    structure: [
      "Sensory hook: extreme close-up tekstur atau pembukaan kemasan yang menggoda.",
      "Sensasi detail: gerakan lambat tuangan, olesan, atau bahan segar yang menyatu.",
      "Signature packshot: kemasan produk utuh berdampingan dengan tekstur hasilnya."
    ],
    visualDna: "Vertical 9:16, extreme macro sensory commercial, high-speed slow-motion detail of textures, droplets, steam, or silky surfaces, rich appetizing lighting, shallow depth of field, exact product packaging from reference image."
  },
  {
    id: "G6",
    code: "G6",
    name: "G6 — Animasi 3D Stylized / Dunia Miniatur",
    preset: "general_commercial",
    summary: "Animasi 3D penuh warna atau dunia miniatur menggemaskan yang mengangkat produk sebagai pusat cerita kreatif.",
    suitableFor: "Snack, minuman kekinian, produk anak/keluarga, kampanye kreatif semua produk.",
    goodTones: ["T2", "T3", "T5", "T6", "T8"],
    words30s: "60–70 kata",
    structure: [
      "Dunia 3D pembuka: adegan animasi 3D memikat yang memperkenalkan suasana produk.",
      "Eksplorasi manfaat/keunikan: visualisasi kreatif bahan atau keunggulan produk.",
      "Penutup ceria: produk tampil menonjol di tengah dunia 3D."
    ],
    visualDna: "Vertical 9:16, charming tactile 3D stylized animation, Pixar/claymation inspired soft lighting and global illumination, vibrant harmonious color palette derived from the product packaging, consistent character/object styling across shots."
  }
];

export const TONE_OPTIONS: ToneOption[] = [
  {
    id: "T1",
    code: "T1",
    name: "T1 — Edukatif Tenang",
    summary: "Jelas, runtut, menenangkan, seperti penjelasan teman yang paham. Kalimat pendek, minim istilah rumit.",
    example: "Ada satu hal kecil yang sering terlewat. Mari kita lihat pelan-pelan, satu per satu.",
    goodStyles: ["S1", "S2", "G2", "G3", "G4"]
  },
  {
    id: "T2",
    code: "T2",
    name: "T2 — Komedi Ringan / Receh",
    summary: "Humor situasi, ekspresi ekspresif, dialog cepat, santai tanpa menertawakan penderitaan.",
    example: "A: Bro, kamu yakin itu ide bagus?! B: Yakin dong, yakin nyesel belakangan.",
    goodStyles: ["S1", "S3", "G1", "G6"]
  },
  {
    id: "T3",
    code: "T3",
    name: "T3 — Hangat & Relatable (Obrolan Santai)",
    summary: "Seperti curhat atau obrolan sehari-hari, empatik, 'ini aku banget', bahasa Indonesia santai dan akrab.",
    example: "Pernah nggak sih, saking sibuknya, hal-hal kecil jadi kelupaan?",
    goodStyles: ["S1", "S3", "S4", "G1", "G3", "G4", "G5", "G6"]
  },
  {
    id: "T4",
    code: "T4",
    name: "T4 — Sinematik Meyakinkan (Premium)",
    summary: "Narasi tenang, dalam, percaya diri, kalimat berjeda elegan, memberi kesan eksklusif dan tepercaya.",
    example: "Setiap detail dirancang untuk menemani langkahmu. Tenang, terukur, dan terjaga.",
    goodStyles: ["S2", "G2", "G3", "G5"]
  },
  {
    id: "T5",
    code: "T5",
    name: "T5 — Ceria Energik (Gaya Maskot / Antusias)",
    summary: "Semangat, antusias, ramah, bisa menggunakan sudut pandang orang pertama ('Aku...'), tetap informatif.",
    example: "Halo! Aku datang buat nemenin harimu, yuk mulai bareng-bareng!",
    goodStyles: ["S4", "S2", "G6"]
  },
  {
    id: "T6",
    code: "T6",
    name: "T6 — Storytelling / Cerita Singkat",
    summary: "Ada tokoh, masalah kecil, dan perubahan kebiasaan. Alur mengalir dari awal hingga penutup yang hangat.",
    example: "Dulu aku pikir itu hal biasa. Sampai akhirnya aku mulai mengubah satu kebiasaan kecil.",
    goodStyles: ["S1", "S3", "G1", "G3", "G6"]
  },
  {
    id: "T7",
    code: "T7",
    name: "T7 — Ilmiah-Kredibel (Ala Pakar / Dokter Ramah)",
    summary: "Istilah dijelaskan secara sederhana, berbasis fakta, nada profesional tapi tetap hangat dan patuh batas klaim.",
    example: "Berdasarkan cara kerjanya, proses ini berlangsung bertahap dan terukur.",
    goodStyles: ["S2", "S4", "G2", "G4"]
  },
  {
    id: "T8",
    code: "T8",
    name: "T8 — Penasaran / Hook Kuat",
    summary: "Dibuka dengan pertanyaan atau fakta unik yang memancing rasa ingin tahu sejak detik pertama.",
    example: "Tahukah kamu apa yang sebenarnya terjadi di balik kebiasaan sepele yang sering kita lakukan tiap hari?",
    goodStyles: ["S2", "S3", "S4", "G1", "G2", "G4", "G5", "G6"]
  },
  {
    id: "T9",
    code: "T9",
    name: "T9 — Komersial Persuasif (Soft/Direct CTA)",
    summary: "Fokus menonjolkan keunggulan produk dan alasan memilihnya dengan penutup ajakan yang jelas (untuk produk umum non-obat).",
    example: "Praktis dan siap menemani harimu. Yuk, rasakan sendiri bedanya hari ini!",
    goodStyles: ["G1", "G2", "G3", "G4", "G5", "G6"]
  }
];

export interface ImageAttachmentInput {
  file: string;
  role?: "product_main" | "product_detail" | "product_variant" | "character" | "setting" | "style_ref";
}

export interface PromptBuildInput {
  duration: number;
  clipsDuration?: number;
  endcardSeconds?: number;
  clipsCount: number;
  clipDurations: number[];
  presetId?: string;
  platformPreset?: PlatformPreset;
  styleId?: string;
  toneId?: string;
  ctaMode?: "cart_checkout" | "dm_share" | "save_bookmark";
  subjectMode?: "hands" | "pov" | "product" | "character";
  hookCategory?: HookCategory;
  hookArchetype?: HookArchetype;
  voiceLanguage?: string;
  userPrompt?: string;
  images: ImageAttachmentInput[];
}

export function computeClipSchedule(duration: number, isVeo = false): { clipsCount: number; clipDurations: number[] } {
  if (isVeo) {
    const count = Math.max(1, Math.round(duration / 8));
    return { clipsCount: count, clipDurations: Array.from({ length: count }, () => 8) };
  }
  if (duration === 8) return { clipsCount: 1, clipDurations: [8] };
  if (duration === 10) return { clipsCount: 1, clipDurations: [10] };
  if (duration === 15) return { clipsCount: 2, clipDurations: [8, 8] };
  if (duration === 16) return { clipsCount: 2, clipDurations: [8, 8] };
  if (duration === 20) return { clipsCount: 2, clipDurations: [10, 10] };
  if (duration === 24) return { clipsCount: 3, clipDurations: [8, 8, 8] };
  if (duration === 30) return { clipsCount: 3, clipDurations: [10, 10, 10] };
  if (duration === 32) return { clipsCount: 4, clipDurations: [8, 8, 8, 8] };
  if (duration === 60) return { clipsCount: 6, clipDurations: [10, 10, 10, 10, 10, 10] };
  const count = Math.max(1, Math.min(30, Math.round(duration / 10)));
  return { clipsCount: count, clipDurations: Array.from({ length: count }, () => 10) };
}

export function buildLayeredSystemPrompt(input: PromptBuildInput): string {
  const preset = PRESET_PACKS.find((p) => p.id === input.presetId) || PRESET_PACKS[0];
  const selectedStyle = input.styleId && input.styleId !== "auto"
    ? STYLE_OPTIONS.find((s) => s.id === input.styleId)
    : undefined;
  const selectedTone = input.toneId && input.toneId !== "auto"
    ? TONE_OPTIONS.find((t) => t.id === input.toneId)
    : undefined;
  const langLabel = input.voiceLanguage || "Bahasa Indonesia";
  const clipsDuration = input.clipsDuration ?? input.clipDurations.reduce((sum, value) => sum + value, 0);
  const endcardSeconds = input.endcardSeconds ?? 0;
  const resolvedCta = input.ctaMode || (input.platformPreset === "reels_brand" ? "dm_share" : "cart_checkout");
  const resolvedSubject = input.subjectMode || (input.platformPreset === "reels_brand" ? "pov" : "hands");

  const platformSection = input.platformPreset && input.platformPreset !== "custom"
    ? `[PLATFORM PRESET: ${input.platformPreset}]
- CTA WAJIB: "${resolvedCta}". ${input.platformPreset === "tiktok_fyp"
      ? "Arahkan ke keranjang/checkout dan closing cepat; jangan arahkan ke DM atau link bio."
      : "Arahkan ke kirim DM / simpan; jangan arahkan ke keranjang atau closing hard-sell."}
- Metrik utama: ${input.platformPreset === "tiktok_fyp" ? "completion rate + rewatch + share" : "sends via DM + saves"}.
- Subjek wajib: "${resolvedSubject}". ${resolvedSubject === "character"
      ? "Karakter boleh tampil, tetapi bukan presenter AI berbicara ke kamera."
      : `DILARANG menampilkan presenter/talking-head AI menghadap kamera. Fokus pada ${resolvedSubject === "hands" ? "tangan dan interaksi produk" : resolvedSubject === "pov" ? "sudut pandang orang pertama" : "produk sebagai subjek utama"}.`}
- Total video ${input.duration} detik = ${clipsDuration} detik klip scene + ${endcardSeconds > 0 ? `${endcardSeconds} detik end-card statis` : "tanpa end-card"}. End-card dirender lokal oleh FFmpeg; jangan menulis narasi, dialog, atau teks untuk end-card di dalam scene mana pun.`
    : "";

  const hookCategory: HookCategory = input.hookCategory
    || (preset.id === "health_softsell" ? "health_supplement" : "general_commercial");
  const categoryHooks = HOOK_LIBRARY.filter((hook) => hook.category === hookCategory);
  const matchingHooks = input.hookArchetype
    ? categoryHooks.filter((hook) => hook.archetype === input.hookArchetype)
    : categoryHooks;
  const hooksForPrompt = matchingHooks.length > 0 ? matchingHooks : categoryHooks;
  const hookSection = `[HOOK LIBRARY — WAJIB PILIH DARI DATA BERIKUT, JANGAN KARANG SENDIRI]
Pilih tepat satu arketipe yang paling cocok. Isi "hook_type" dengan arketipe pilihan, lalu pakai "hook_text_3s" dari library (atau variasi maksimal 7 kata tanpa klaim baru), serta isi "retention_promise" dan "share_trigger" yang selaras:
${hooksForPrompt.map((hook) => `- ${hook.archetype}: "${hook.hook_text_3s}" | retention: "${hook.retention_promise}" | share: "${hook.share_trigger}"`).join("\n")}
Aturan hook: maksimal 7 kata, tanpa salam klise, tanpa klaim hasil/sertifikasi/angka tanpa sumber. Hook wajib mengalir ke "script" scene 1, bukan hanya disimpan sebagai metadata.`;

  // Filter candidate styles for auto-recommendation
  const candidateStyles = preset.id === "health_softsell"
    ? STYLE_OPTIONS.filter((s) => s.preset === "health_softsell")
    : STYLE_OPTIONS.filter((s) => s.preset === "general_commercial");

  const styleSection = selectedStyle
    ? `[SELECTED STYLE - WAJIB GUNAKAN STYLE INI (${selectedStyle.code}: ${selectedStyle.name})]:
- Karakteristik: ${selectedStyle.summary}
- Panduan Panjang Narasi (acuan 30 dtk): ${selectedStyle.words30s} (skalakan proporsional untuk ${clipsDuration} dtk).
${selectedStyle.riskNote ? `- Catatan Penting: ${selectedStyle.riskNote}\n` : ""}- Struktur Alur Cerita (bagi proporsional ke dalam ${input.clipsCount} scene):
${selectedStyle.structure.map((st, idx) => `  ${idx + 1}. ${st}`).join("\n")}
- Visual Prompt DNA (wajib diintegrasikan ke dalam "prompt" bahasa Inggris setiap scene):
  "${selectedStyle.visualDna}"`
    : `[AUTO-RECOMMEND STYLE (PILIH SALAH SATU DARI DAFTAR BERIKUT BERDASARKAN RISET PRODUK & BRIEF USER)]:
Pengguna memilih mode Otomatis untuk Style. Pilih 1 Style paling cocok dari daftar ini, jelaskan alasannya dalam 1–2 kalimat di field "recommendation_reason", dan terapkan Visual DNA serta strukturnya secara konsisten:
${candidateStyles.map((s) => `- ${s.code} (${s.name}): ${s.summary} | Cocok untuk: ${s.suitableFor} | Tone cocok: ${s.goodTones.join(", ")}\n  Visual DNA: "${s.visualDna}"`).join("\n")}`;

  const toneSection = selectedTone
    ? `[SELECTED TONE - WAJIB GUNAKAN TONE INI (${selectedTone.code}: ${selectedTone.name})]:
- Ciri Suara & Gaya Bahasa: ${selectedTone.summary}
- Contoh Gaya Kalimat: "${selectedTone.example}"`
    : `[AUTO-RECOMMEND TONE (PILIH SALAH SATU DARI DAFTAR BERIKUT YANG PALING COCOK DENGAN PRODUK & STYLE)]:
Pengguna memilih mode Otomatis untuk Tone. Pilih 1 Tone paling cocok dari daftar ini:
${TONE_OPTIONS.map((t) => `- ${t.code} (${t.name}): ${t.summary} (Cocok dengan style: ${t.goodStyles.join(", ")})`).join("\n")}`;

  const scheduleDesc = input.clipDurations
    .map((d, i) => {
      const start = input.clipDurations.slice(0, i).reduce((a, b) => a + b, 0);
      const end = start + d;
      return `Scene ${i + 1} (${String(start).padStart(2, "0")}–${String(end).padStart(2, "0")}s, durasi klip ${d}s)`;
    })
    .join(", ");

  return `You are an elite creative video director, product researcher, and scriptwriter for TikTok/Reels/Shorts specializing in Google Flow Omni video generation.

=====================================
HIERARKI PRIORITAS ATURAN (WAJIB DIIKUTI)
=====================================
1. BATAS TEKNIS (HARD CONSTRAINTS):
   - Output WAJIB berupa raw JSON valid sesuai schema.
   - Jumlah scene WAJIB tepat ${input.clipsCount} scene (${scheduleDesc}) untuk durasi klip total ${clipsDuration} detik${endcardSeconds > 0 ? `; total video ${input.duration} detik termasuk end-card statis ${endcardSeconds} detik` : `; total video ${input.duration} detik`}.
   - Field "prompt" visual di setiap scene WAJIB ditulis dalam bahasa Inggris yang sinematik dan detail untuk Google Flow Omni/Veo.
   - ZERO TEXT-IN-AI: Frame video harus 100% bersih dari teks/subtitle/watermark/logo tempelan AI buatan generator. NAMUN bentuk fisik produk, kemasan asli, dan merek fisik yang tercetak pada label foto referensi WAJIB tetap utuh dan setia pada foto referensi. Semua teks promosi, harga, logo, dan end-card dirender lokal (FFmpeg/Chromium), bukan oleh model video.
   - ATURAN DETIK 0–3 (RETENTION & HOOK):
     * Scene 1 Frame 0 DILARANG menggunakan establishing shot pasif (pemandangan/ruangan kosong). Wajib langsung aksi bergerak: tangan membuka produk, unboxing cepat, produk jatuh/splash, atau POV interaktif.
     * Kalimat pembuka hook di detik 0-3 ("hook_text_3s") MAKSIMAL 7 KATA. Dilarang keras menggunakan salam klise pembuka ("Halo guys", "Hai semuanya", "Welcome back"). Langsung to the point ke masalah atau hook rasa ingin tahu.
     * "hook_text_3s" WAJIB diucapkan atau tampil sebagai aksi di scene 1; jangan hanya mengisi metadata.
2. INSTRUKSI USER ("INI USER PROMPT"):
   - Jika user menulis permintaan khusus di "INI USER PROMPT" (misal alur cerita spesifik, karakter tertentu, gaya visual khusus, atau bahasa tertentu), utamakan keinginan user tersebut.
3. TEMPLATE PRESET, STYLE, DAN TONE:
   - Terapkan aturan Preset, Style, dan Tone di bawah ini untuk memandu riset produk, struktur cerita, gaya bahasa, dan Visual DNA.

=====================================
${preset.rules}
=====================================

${platformSection ? `${platformSection}\n\n=====================================\n` : ""}${hookSection}

${styleSection}

${toneSection}

=====================================
ATURAN MULTI-GAMBAR, SUARA, & KONSISTENSI
=====================================
1. ANALISIS SELURUH GAMBAR TERLAMPIR (${input.images.length} gambar):
   - Periksa semua foto yang dilampirkan (` + input.images.map((im, i) => `img${i + 1}: "${im.file}" [peran: ${im.role || "product_main"}]`).join(", ") + `).
   - Baca teks pada kemasan/label (merek, nama produk, varian, izin edar/sertifikasi jika ada, komposisi, klaim resmi, bentuk produk).
   - Jangan mengarang klaim atau komposisi di luar label foto dan fakta dasar yang terverifikasi.
   - Untuk setiap scene, pilih maksimal 3 ID gambar referensi ("refs": ["img1", ...]) yang memang relevan dengan apa yang tampil di scene tersebut.

2. BAHASA & VOICEOVER:
   - Semua narasi/dialog ("script") WAJIB menggunakan ${langLabel} yang natural, luwes, dan sesuai Tone terpilih.
   - Panjang kalimat per scene harus pas diucapkan dalam durasi klipnya agar suara tidak terpotong.
   - Berikan panduan ejaan pengucapan nama produk/merek di field "pronunciation" agar pengisi suara AI melafalkannya dengan benar.
   - Jangan menulis teks kurung atau instruksi di dalam "script" karena akan ikut terbaca.

3. KONTINUITAS & KONSISTENSI:
   - Alur gerakan subjek dan interaksinya dengan objek/produk harus wajar dan berkesinambungan, tanpa objek yang muncul, hilang, atau berubah secara tiba-tiba.
   - Jaga konsistensi identitas visual karakter ("character_anchor") dan latar ("setting_anchor") di seluruh scene.
   - Karakter suara ("voiceover_persona") harus selaras dengan tokoh yang tampil (gender, usia, warna suara) dan tetap sama di seluruh scene.
   - Definisikan "character_anchor" secara lengkap, atau tulis "N/A - Product focus without characters" jika tanpa karakter. Definisikan latar di "setting_anchor".

=====================================
FORMAT OUTPUT JSON (WAJIB RAW JSON TANPA MARKDOWN)
=====================================
{
  "product_identified": "Nama merek dan produk lengkap hasil bacaan label foto",
  "product_slug": "nama_produk_singkat_untuk_file (maks 3-4 kata, huruf kecil & underscore)",
  "product_category": "Kategori produk (misal: health_supplement, skincare, food_beverage, fashion, gadget, home_living, service)",
  "platform_preset": "${input.platformPreset || "custom"}",
  "hook_type": "problem_agitator | price_drop_deal | shock_counterintuitive | relatable_pov | sensory_curiosity | social_proof_secret",
  "hook_text_3s": "Kalimat pembuka hook 3 detik pertama (maksimal 7 kata, tanpa halo guys)",
  "retention_promise": "Alasan audiens penasaran tetap menonton (1 kalimat pendek)",
  "share_trigger": "Alasan audiens membagikan video via DM / WhatsApp",
  "cta_mode": "${resolvedCta}",
  "subject_mode": "${resolvedSubject}",
  "pronunciation": "Panduan ejaan baca nama merek/produk untuk voiceover (misal: \"<Nama Merek> (baca: <ejaan fonetis>)\")",
  "recommended_style": "Kode style yang dipakai (misal S1, S2, S3, S4, G1..G6, atau custom)",
  "recommended_tone": "Kode tone yang dipakai (misal T1..T9)",
  "recommendation_reason": "Alasan singkat 1-2 kalimat mengapa kombinasi style dan tone ini paling pas untuk produk & brief user",
  "research_summary": "Ringkasan riset produk: bentuk produk, komposisi/spesifikasi utama di label, izin edar/sertifikasi (jika terlihat), manfaat/klaim resmi, & kaitan dengan kebutuhan konsumen",
  "facts_used": [
    "Fakta produk 1 beserta rujukan umumnya (misal: Label kemasan / sumber resmi terkait)",
    "Fakta 2"
  ],
  "claim_warnings": [
    "Catatan kepatuhan klaim / peringatan jika ada (kosongkan array [] jika seluruh naskah sudah 100% aman)"
  ],
  "style": "slug_gaya_visual",
  "voiceover_persona": "Deskripsi suara dalam bahasa Inggris (gender, usia, warna suara, tempo) yang selaras dengan tokoh utama di character_anchor",
  "character_anchor": "Deskripsi detail karakter/maskot dalam bahasa Inggris untuk konsistensi antar klip, atau 'N/A - Product focus without characters'",
  "setting_anchor": "Deskripsi detail latar tempat/lingkungan dalam bahasa Inggris untuk konsistensi antar klip",
  "scenes": [
    {
      "num": 1,
      "time": "00–10s",
      "duration": 10,
      "title": "Judul Singkat Adegan",
      "speaker": "Nama pembicara (misal: Narator / <nama tokoh> / Maskot)",
      "prompt": "Ultra-detailed English visual prompt for Google Flow Omni/Veo combining the chosen Style Visual DNA + specific scene camera move, subject action, lighting, and environment in 9:16 vertical format. NO overlaid text or watermarks.",
      "script": "Kalimat narasi/dialog dalam ${langLabel} yang pas durasinya dan siap diucapkan langsung",
      "on_screen_text": "Teks singkat bahasa Indonesia untuk catatan editing manual / kinetic text (opsional, bukan digenerate AI di video)",
      "refs": ["img1"]
    }
  ]
}`;
}

export interface FlowAgentBriefInput {
  duration: number;
  clipsCount: number;
  userPrompt?: string;
  productHint?: string;
  voiceLanguage?: string;
  platformPreset?: PlatformPreset;
  endcardSeconds?: number;
}

// Brief sent to Google Flow's own agent (zero external LLM key). Flow Agent must answer with a single raw JSON
// codeblock; everything else is guidance. The returned text feeds straight into the existing script -> pipeline path
// (parse -> scenes -> POST /api/pipeline/generate), which is the route proven by scripts/mock_flow_agent_poc.ts.
export function buildFlowAgentBriefPrompt(input: FlowAgentBriefInput): string {
  const endcardSeconds = input.endcardSeconds && input.endcardSeconds > 0 ? input.endcardSeconds : 0;
  const contentDuration = Math.max(1, Math.round((input.duration - endcardSeconds) * 10) / 10);
  const clipDurations = computeClipSchedule(input.duration).clipDurations;
  const clipsTotal = clipDurations.reduce((sum, value) => sum + value, 0);
  const sceneDurations = input.clipsCount > 0
    ? Array.from({ length: input.clipsCount }, (_, i) => clipDurations[i] ?? Math.max(2, Math.round((contentDuration / input.clipsCount) * 10) / 10))
    : clipDurations;
  const scheduleDesc = sceneDurations.map((d, i) => `Scene ${i + 1} (${d}s)`).join(", ");
  const product = input.productHint && input.productHint.trim() ? input.productHint.trim() : "@Product";
  const langLabel = input.voiceLanguage || "Bahasa Indonesia";

  const userSection = input.userPrompt && input.userPrompt.trim()
    ? `\n\nINSTRUKSI USER (WAJIB DIPERHATIKAN):\n${input.userPrompt.trim()}\n\nTetap jawab HANYA blok JSON sesuai aturan di bawah.`
    : "";

  return `You are an elite creative video director, product researcher, and scriptwriter for TikTok/Reels/Shorts specializing in Google Flow Omni video generation.

=====================================
ATURAN UNTUK FLOW AGENT (WAJIB DIIKUTI)
=====================================
1. BATAS TEKNIS (HARD CONSTRAINTS):
   - Jawab HANYA dengan SATU blok kode JSON valid (awalan \`\`\`json) tanpa teks lain, tanpa salam, tanpa penjelasan.
   - Jumlah scene WAJIB tepat ${input.clipsCount} scene (${scheduleDesc}) untuk durasi konten ${contentDuration} detik${endcardSeconds > 0 ? `; total video ${input.duration} detik termasuk static end-card ${endcardSeconds} detik` : `; total video ${input.duration} detik`}.
   - Field "prompt" visual WAJIB ditulis dalam bahasa Inggris sinematik dan detail untuk Google Flow Omni/Veo. NO overlaid text.
   - ZERO TEXT-IN-AI: jangan minta model menulis teks/subtitle/watermark; semua teks promosi dan end-card dirender lokal (FFmpeg/Chromium).
   - Scene 1 Frame 0 DILARANG establishing shot pasif; wajib aksi bergerak. Hook detik 0-3 ("hook_text_3s") MAKSAL maksimal 7 kata, tanpa salam klise.

2. KONTENSI PRODUK & BRIEF:
   - Produk: ${product}.
   - Tujuan: high-converting 9:16 video komersial.

3. FORMAT OUTPUT JSON (WAJIB):
   \`\`\`json
   {
     "product_identified": "nama_produk",
     "product_category": "kategori_produk",
     "scenes": [
       {
         "num": 1,
         "time": "00-08s",
         "duration": 8,
         "title": "Judul Singkat Adegan",
         "prompt": "English visual prompt ...",
         "script": "Narasi dalam ${langLabel} ...",
         "refs": ["@Product"]
       }
     ]
   }
   \`\`\`

${userSection}`;
}
