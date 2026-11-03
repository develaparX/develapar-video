export interface HookTemplate {
  archetype: "problem_agitator" | "price_drop_deal" | "shock_counterintuitive" | "relatable_pov" | "sensory_curiosity" | "social_proof_secret";
  category: "health_supplement" | "general_commercial";
  hook_text_3s: string;
  retention_promise: string;
  share_trigger: string;
  cta_mode: "cart_checkout" | "dm_share" | "save_bookmark";
}

export const HOOK_LIBRARY: HookTemplate[] = [
  // Health & Supplement
  {
    archetype: "problem_agitator",
    category: "health_supplement",
    hook_text_3s: "Bangun tidur badan pegal semua?",
    retention_promise: "Penyebab sepele yang sering diabaikan tubuh",
    share_trigger: "Kirim ke orang tua atau teman yang suka mengeluh pegal",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "price_drop_deal",
    category: "health_supplement",
    hook_text_3s: "Dulu beli mahal, sekarang cuma segini?",
    retention_promise: "Diskon paket sehat resmi BPOM hemat kantong",
    share_trigger: "Kirim ke teman pemburu diskon kesehatan",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "shock_counterintuitive",
    category: "health_supplement",
    hook_text_3s: "Jangan minum air hangat campur ini!",
    retention_promise: "Fakta medis cara konsumsi herbal yang tepat",
    share_trigger: "Kirim ke grup keluarga biar tidak salah paham",
    cta_mode: "save_bookmark"
  },
  {
    archetype: "relatable_pov",
    category: "health_supplement",
    hook_text_3s: "POV: Pas lagi capek-capeknya di kantor...",
    retention_promise: "Kebiasaan 1 menit kembalikan stamina tubuh",
    share_trigger: "Relate banget sama teman se-divisi",
    cta_mode: "dm_share"
  },
  {
    archetype: "sensory_curiosity",
    category: "health_supplement",
    hook_text_3s: "Aromanya beda dari suplemen biasa...",
    retention_promise: "Bahan alami tanpa aroma kimia menyengat",
    share_trigger: "Penasaran sama rasa dan aromanya",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "social_proof_secret",
    category: "health_supplement",
    hook_text_3s: "Kenapa orang Jepang jarang ngeluh sendi?",
    retention_promise: "Rahasia pola hidup dan nutrisi alami pendamping",
    share_trigger: "Simpan buat jaga kesehatan nanti",
    cta_mode: "save_bookmark"
  },

  // General Commercial (Beauty, F&B, Gadget, Fashion, Home)
  {
    archetype: "problem_agitator",
    category: "general_commercial",
    hook_text_3s: "Baru sadar barang ini bikin repot!",
    retention_promise: "Solusi praktis 1 detik tanpa buang waktu",
    share_trigger: "Kirim ke teman yang sering repot hal serupa",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "price_drop_deal",
    category: "general_commercial",
    hook_text_3s: "Spill diskon racun belanja hari ini!",
    retention_promise: "Flash sale spesial sebelum kehabisan stok",
    share_trigger: "Tag teman buat checkout bareng",
    cta_mode: "cart_checkout"
  },
  {
    archetype: "shock_counterintuitive",
    category: "general_commercial",
    hook_text_3s: "Ternyata cara pakai kita salah besar!",
    retention_promise: "Trik pakai yang bikin hasil 3x lebih awet",
    share_trigger: "Kirim ke teman biar nggak salah lagi",
    cta_mode: "dm_share"
  },
  {
    archetype: "relatable_pov",
    category: "general_commercial",
    hook_text_3s: "POV: Pas nemu barang idaman estetik...",
    retention_promise: "Review jujur unboxing langsung di rumah",
    share_trigger: "Kirim kode barang ke ayang atau bestie",
    cta_mode: "dm_share"
  },
  {
    archetype: "sensory_curiosity",
    category: "general_commercial",
    hook_text_3s: "Dengerin suara renyahnya pas pertama dibuka!",
    retention_promise: "Sensasi tekstur premium bikin nagih",
    share_trigger: "Bikin ngiler yang lewat timeline",
    cta_mode: "save_bookmark"
  },
  {
    archetype: "social_proof_secret",
    category: "general_commercial",
    hook_text_3s: "Barang viral yang akhirnya kebeli juga!",
    retention_promise: "Worth it atau cuma menang viral di sosmed?",
    share_trigger: "Rekomendasi racun belanja wajib punya",
    cta_mode: "cart_checkout"
  }
];

export type PlatformPreset = "tiktok_fyp" | "reels_brand" | "custom";

export interface ResolvedPlatformConfig {
  platform: PlatformPreset;
  video_model: string;
  duration_target: number;
  duration_actual: number;
  clips_count: number;
  clip_durations: number[];
  style_id: string;
  tone_id: string;
  preset_id: "free" | "health_softsell" | "general_commercial";
  subject_mode: "hands" | "pov" | "product" | "character";
  cta_mode: "cart_checkout" | "dm_share" | "save_bookmark";
}

export function resolvePlatformPreset(
  platform?: PlatformPreset,
  overrides?: Partial<ResolvedPlatformConfig>
): ResolvedPlatformConfig {
  const p = platform || "tiktok_fyp";
  if (p === "tiktok_fyp") {
    const isVeo = /veo/i.test(overrides?.video_model || "");
    const dur = overrides?.duration_target === 20 ? 20 : 16;
    const { clipsCount, clipDurations } = computeClipSchedule(dur, isVeo);
    return {
      platform: "tiktok_fyp",
      video_model: overrides?.video_model || "Omni 1.1 Flash",
      duration_target: dur,
      duration_actual: dur,
      clips_count: clipsCount,
      clip_durations: clipDurations,
      style_id: overrides?.style_id || "G1",
      tone_id: overrides?.tone_id || "T8",
      preset_id: overrides?.preset_id || "general_commercial",
      subject_mode: overrides?.subject_mode || "hands",
      cta_mode: "cart_checkout",
      ...overrides,
    };
  }

  if (p === "reels_brand") {
    const isVeo = /veo/i.test(overrides?.video_model || "");
    const dur = overrides?.duration_target === 24 ? 24 : 16;
    const { clipsCount, clipDurations } = computeClipSchedule(dur, isVeo);
    return {
      platform: "reels_brand",
      video_model: overrides?.video_model || "Omni 1.1 Flash",
      duration_target: dur,
      duration_actual: dur,
      clips_count: clipsCount,
      clip_durations: clipDurations,
      style_id: overrides?.style_id || "G2",
      tone_id: overrides?.tone_id || "T4",
      preset_id: overrides?.preset_id || "general_commercial",
      subject_mode: overrides?.subject_mode || "pov",
      cta_mode: "dm_share",
      ...overrides,
    };
  }

  // custom
  const isVeo = /veo/i.test(overrides?.video_model || "");
  const dur = overrides?.duration_target ?? (isVeo ? 24 : 30);
  const { clipsCount, clipDurations } = computeClipSchedule(dur, isVeo);
  return {
    platform: "custom",
    video_model: overrides?.video_model || "Omni 1.1 Flash",
    duration_target: dur,
    duration_actual: dur,
    clips_count: clipsCount,
    clip_durations: clipDurations,
    style_id: overrides?.style_id || "auto",
    tone_id: overrides?.tone_id || "auto",
    preset_id: overrides?.preset_id || "free",
    subject_mode: overrides?.subject_mode || "product",
    cta_mode: overrides?.cta_mode || "cart_checkout",
    ...overrides,
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
  clipsCount: number;
  clipDurations: number[];
  presetId?: string;
  platformPreset?: PlatformPreset;
  styleId?: string;
  toneId?: string;
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

  // Filter candidate styles for auto-recommendation
  const candidateStyles = preset.id === "health_softsell"
    ? STYLE_OPTIONS.filter((s) => s.preset === "health_softsell")
    : STYLE_OPTIONS.filter((s) => s.preset === "general_commercial");

  const styleSection = selectedStyle
    ? `[SELECTED STYLE - WAJIB GUNAKAN STYLE INI (${selectedStyle.code}: ${selectedStyle.name})]:
- Karakteristik: ${selectedStyle.summary}
- Panduan Panjang Narasi (acuan 30 dtk): ${selectedStyle.words30s} (skalakan proporsional untuk ${input.duration} dtk).
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
   - Jumlah scene WAJIB tepat ${input.clipsCount} scene (${scheduleDesc}) untuk total target durasi ${input.duration} detik.
   - Field "prompt" visual di setiap scene WAJIB ditulis dalam bahasa Inggris yang sinematik dan detail untuk Google Flow Omni/Veo.
   - ZERO TEXT-IN-AI: Frame video harus 100% bersih dari teks/subtitle/watermark/logo tempelan AI buatan generator. NAMUN bentuk fisik produk, kemasan asli, dan merek fisik yang tercetak pada label foto referensi WAJIB tetap utuh dan setia pada foto referensi.
   - ATURAN DETIK 0–3 (RETENTION & HOOK):
     * Scene 1 Frame 0 DILARANG menggunakan establishing shot pasif (pemandangan/ruangan kosong). Wajib langsung aksi bergerak: tangan membuka produk, unboxing cepat, produk jatuh/splash, atau POV interaktif.
     * Kalimat pembuka hook di detik 0-3 ("hook_text_3s") MAKSIMAL 7 KATA. Dilarang keras menggunakan salam klise pembuka ("Halo guys", "Hai semuanya", "Welcome back"). Langsung to the point ke masalah atau hook rasa ingin tahu.
2. INSTRUKSI USER ("INI USER PROMPT"):
   - Jika user menulis permintaan khusus di "INI USER PROMPT" (misal alur cerita spesifik, karakter tertentu, gaya visual khusus, atau bahasa tertentu), utamakan keinginan user tersebut.
3. TEMPLATE PRESET, STYLE, DAN TONE:
   - Terapkan aturan Preset, Style, dan Tone di bawah ini untuk memandu riset produk, struktur cerita, gaya bahasa, dan Visual DNA.

=====================================
${preset.rules}
=====================================

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
  "platform_preset": "tiktok_fyp | reels_brand | custom",
  "hook_type": "problem_agitator | price_drop_deal | shock_counterintuitive | relatable_pov | sensory_curiosity | social_proof_secret",
  "hook_text_3s": "Kalimat pembuka hook 3 detik pertama (maksimal 7 kata, tanpa halo guys)",
  "retention_promise": "Alasan audiens penasaran tetap menonton (1 kalimat pendek)",
  "share_trigger": "Alasan audiens membagikan video via DM / WhatsApp",
  "cta_mode": "cart_checkout | dm_share | save_bookmark",
  "subject_mode": "hands | pov | product | character",
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
