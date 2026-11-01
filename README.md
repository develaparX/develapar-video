# Develapar Video

Aplikasi desktop ringan untuk automasi pembuatan video komersial menggunakan **Google Flow** (`flow.google.com`) dan AI multimodal chaining. Dibuat dengan **Tauri v2** (Rust) dan **Bun Engine Sidecar** (TypeScript / Playwright CDP).

Fokus platform: **macOS** & **Windows**.

---

## Arsitektur

```
┌─────────────────────────────────────────────────────────────┐
│                 Develapar Video (Desktop App)               │
│                                                             │
│  ┌──────────────────────────┐  Tauri IPC /    ┌───────────┐ │
│  │ Webview UI (Studio)      │◄─ Local REST ──►│ Rust Core │ │
│  │ Vite + Tailwind (52 KB)  │                 │ (14 MB)   │ │
│  └──────────────────────────┘                 └─────┬─────┘ │
│                                                     │ Spawns│
│                                                     ▼       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Engine Sidecar (Bun Standalone Executable)             │ │
│  │ - Playwright CDP driver (Chrome Port 9333)             │ │
│  │ - REST API (8787), Gemini TTS & Script Generator       │ │
│  │ - FFmpeg video stitching & crossfade                   │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ Chrome DevTools Protocol
                               ▼
            ┌──────────────────────────────────────┐
            │ Google Chrome (Dedicated Profile)    │
            │ https://flow.google.com              │
            └──────────────────────────────────────┘
```

- **Ringan**: UI dijalankan oleh webview bawaan OS (WKWebView di macOS, WebView2 di Windows). Memory footprint sangat kecil dibandingkan Electron.
- **Standalone Engine**: Backend di-compile menggunakan `bun build --compile` menjadi binary tunggal, tidak membutuhkan runtime Node.js terpisah pada perangkat user.
- **Automasi Flow Asli**: Menghubungkan Chrome profil terpisah via CDP port 9333 sehingga aman dari deteksi bot dan menggunakan kuota kredit langganan Google Flow (gratis 50/hari atau plan Pro).

---

## Persyaratan Sistem

- **OS**: macOS 12+ (Apple Silicon / Intel) atau Windows 10/11.
- **Google Chrome**: Versi terbaru.
- **Akun Google**: Untuk login ke `flow.google.com`.
- **FFmpeg**: Terpasang di sistem (`brew install ffmpeg` / `winget install Gyan.FFmpeg`) atau disediakan otomatis.

---

## Pengembangan (Development)

### Menggunakan Nix (Direkomendasikan)

Proyek ini dilengkapi dengan `flake.nix` yang mengonfigurasi seluruh toolchain (Rust, Bun, Node, Frameworks macOS, FFmpeg) secara otomatis:

```bash
# Masuk ke environment Nix
nix develop

# Jalankan dalam mode development
bun run dev
```

### Menggunakan Toolchain Lokal (Tanpa Nix)

Pastikan **Rust** (`cargo`) dan **Bun** (`bun.sh`) sudah terpasang:

```bash
# 1. Install dependensi
bun install
cd engine && bun install
cd ../ui && bun install
cd ..

# 2. Compile binary engine sidecar
bun run engine:build

# 3. Jalankan aplikasi desktop dalam mode dev
bun run dev
```

---

## Build Release (Installer)

Untuk mengompilasi installer produksi:

```bash
# Compile engine sidecar terlebih dahulu
bun run engine:build

# Build installer aplikasi desktop
bun run build
```

Hasil build akan berada di:
- **macOS**: `src-tauri/target/release/bundle/dmg/Develapar Video_0.1.0_aarch64.dmg` dan `.app`
- **Windows**: `src-tauri/target/release/bundle/msi/` dan `.exe`

---

## Struktur Folder

```
flow-videogenerate/
├── flake.nix                 # Konfigurasi Nix environment
├── .envrc                    # Auto-hook direnv
├── package.json              # Script root workspace
├── src-tauri/                # Core Tauri v2 (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json       # Konfigurasi window & bundle
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs            # Manajemen lifecycle sidecar & IPC
│   ├── icons/                # App icon multiplatform (.icns, .ico, .png)
│   └── binaries/             # Output binary engine sidecar
├── engine/                   # Engine automasi & REST API (TypeScript)
│   ├── package.json
│   └── src/
│       ├── server-entry.ts   # Entry point server sidecar
│       ├── flow.ts           # Playwright CDP driver
│       ├── server.ts         # Endpoint REST API & pipeline
│       ├── assemble.ts       # FFmpeg video stitcher & mixer
│       └── gemini.ts         # TTS & AI script generator
├── ui/                       # Frontend Studio Dashboard
│   ├── index.html            # Dashboard UI (Dark theme)
│   ├── vite.config.ts
│   └── package.json
├── product/                  # Folder foto produk target
└── output/                   # Folder hasil video MP4 yang di-generate
```
