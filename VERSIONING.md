# ATURAN KERAS VERSI & RELEASE (VERSIONING RULES)

> ⚠️ **PERATURAN WAJIB SETIAP KALI ADA PEMBARUAN / UPDATE FITUR**:
> Jangan pernah push atau rilis pembaruan ke branch `main` tanpa menaikkan nomor versi!
> Kenaikan versi wajib serentak di seluruh komponen agar sistem in-app auto-updater (`tauri-plugin-updater`) dan Cloudflare R2 mengenali versi baru.

---

## 1. Standar Penomoran Versi (SemVer)

Gunakan format: `MAJOR.MINOR.PATCH` (contoh: `0.1.0` -> `0.1.1` -> `0.2.0`)
- **PATCH** (`0.1.0` -> `0.1.1`): Perbaikan bug kecil, perapihan UI, penyesuaian teks/styling.
- **MINOR** (`0.1.0` -> `0.2.0`): Penambahan fitur baru, endpoint baru, atau model AI baru.
- **MAJOR** (`0.1.0` -> `1.0.0`): Perombakan arsitektur besar atau perubahan alur mendasar.

---

## 2. Cara Update Versi Otomatis (1 Perintah)

Gunakan skrip otomatis yang sudah disediakan di root folder `flow-videogenerate`:

```bash
# Contoh naik versi ke 0.1.1
bun run bump 0.1.1

# Atau naik versi minor ke 0.2.0
bun run bump 0.2.0
```

Skrip ini akan secara otomatis menyinkronkan 8 berkas sekaligus:
1. `package.json` (`version`)
2. `src-tauri/tauri.conf.json` (`version`)
3. `src-tauri/Cargo.toml` (`version`)
4. `engine/package.json` (`version`)
5. `ui/package.json` (`version`)
6. `ui/index.html` (`currentVersion`)
7. `.github/workflows/release.yml` (nama file target upload DMG & EXE)
8. `../devideo-monitor/src/routes/release.tsx` (tampilan halaman /release)

---

## 3. Alur Kerja Setelah Naik Versi

```bash
# 1. Naikkan versi
bun run bump 0.1.1

# 2. Commit perubahan
git add -A
git commit -m "chore: bump version to v0.1.1"

# 3. Push ke branch main (Memicu GitHub Actions untuk build & upload ke R2)
git push origin main
```
