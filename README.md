# Bondowoso

Orkestrator AI coding agent berbasis Claude Code, mengikuti desain
[Jonggrang](https://jonggrang.dev). Satu permintaan dipecah jadi tugas-tugas kecil;
setiap tugas dikerjakan agent yang selalu fresh dan harus melewati pipeline:

```
Implement → gate → scan secret → Simplify → Test → Review → commit
```

Commit baru terjadi kalau setiap domain yang disentuh (frontend, api, database, …)
lolos Test **dan** Review (dirty-bit per domain). Hasilnya satu commit per tugas di
branch terpisah, dengan nama branch dan pesan commit yang mengikuti konvensi repo.

Memakai CLI `claude` resmi dengan login langganan (Max), bukan API key.
`ANTHROPIC_API_KEY` selalu dibuang dari env agent supaya tidak menagih API.

## Instalasi

Butuh Node 24+ (menjalankan TypeScript langsung, tanpa build) dan Claude Code
yang sudah login dengan akun langganan.

```bash
git clone git@github.com:niceProg/bondowoso.git
cd bondowoso
npm install
npm link          # pasang perintah `bondowoso` secara global
```

## Pakai

Jalankan dari dalam repo yang mau dikerjakan:

```bash
cd <repo>
bondowoso init                  # buat .bondowoso/config.yaml, rapikan gate-nya
bondowoso plan "<permintaan>"   # Lead bertanya bila perlu, lalu menulis .bondowoso/plan.md
bondowoso approve               # pecah jadi tugas; Test Lead merancang kasus test
bondowoso work                  # kerjakan semua tugas
bondowoso status
```

Sekali jalan tanpa berhenti: `bondowoso work "<permintaan>" --yes`.
Dari luar repo, pakai `-C`: `bondowoso -C <repo> status`.

### Perencanaan

```bash
bondowoso plan "Tambah filter tanggal"        # satu baris
bondowoso plan                                # tulis di $EDITOR
bondowoso plan --file permintaan.md           # dari file Markdown
bondowoso plan --deep "…"                     # discovery → analisis 2–3 pendekatan → rencana
bondowoso plan --src docs/brd.md "…"          # dokumen kebutuhan sebagai referensi
bondowoso plan --base develop "…"             # potong branch kerja dari develop
bondowoso plan --no-ask "…"                   # lewati pertanyaan klarifikasi
bondowoso plan --yes "…"                      # tanpa pertanyaan, langsung approve
bondowoso plan --revise "persingkat fase 2"   # revisi plan.md yang belum di-approve
bondowoso plan --append "tambah ekspor CSV"   # tambah ke rencana yang sudah jalan
```

Nama branch diusulkan Lead dari konvensi repo dan bisa diubah di baris
**Branch:** `plan.md` sebelum approve. Di editor dan file, blok `<!-- komentar -->`
diabaikan.

### Mengerjakan

```bash
bondowoso work                  # berurutan
bondowoso work --parallel 3     # sampai 3 tugas bersamaan, masing-masing di worktree
bondowoso work --task T3        # hanya T3 (plus dependensinya yang belum selesai)
bondowoso work --compact        # implement + gate saja; simplify/test/review ditunda
bondowoso work --full           # jalankan fase yang ditunda, jadi commit susulan
bondowoso work --wait           # saat kuota Max habis, tunggu lalu lanjut sendiri
```

Kode keluar `work`: `0` selesai, `2` ada tugas blocked, `75` kuota Max habis
(jalankan lagi nanti), `1` error lain.

### Kalau tugas macet (blocked)

Perubahan tugas yang blocked, error, atau terputus tidak pernah dibuang begitu saja:
diff-nya disimpan sebagai patch di `.bondowoso/runs/<run>/`. `bondowoso status`
menampilkan alasannya, aksi yang ditolak, dan saran pola `developer_bash`.

```bash
bondowoso resume T1   # pasang lagi hasil terakhir T1, tambal manual bila perlu
bondowoso work        # gate → test → review → commit; Developer lanjut dari situ bila perlu
bondowoso reset T1    # atau: ulang T1 dari awal
```

### Skill dan memory

```bash
bondowoso skills list           # skill bawaan + .bondowoso/skills/**/SKILL.md
bondowoso skills show go-idioms
bondowoso memory show           # .bondowoso/MEMORY.md (pelajaran proyek)
bondowoso memory recall "auth"  # potongan memory yang relevan
bondowoso memory compact        # rangkum fragmen tugas run aktif
bondowoso memory promote        # promosikan pelajaran stabil ke MEMORY.md
```

Skill dipilih per tugas (penugasan Lead + kata kunci + domain berkas) dan
disisipkan ke prompt Developer, Tester, dan Reviewer. Setelah run selesai, catatan
per tugas dirangkum lalu pelajaran yang stabil dipromosikan ke `MEMORY.md`, yang
dibaca Lead dan Developer di run berikutnya. `MEMORY.md` dan `.bondowoso/skills/`
boleh di-commit.

## Pengaman

- Peran dibatasi lewat daftar tool, bukan prompt: Lead, Test Lead, dan Reviewer hanya
  membaca; perubahan Tester di luar berkas test dan perubahan Simplifier di luar
  berkas tugas dikembalikan otomatis.
- Hook Claude Code (`src/hooks/`) memblokir baca/tulis berkas rahasia (`.env`, kunci,
  kredensial), perintah yang membocorkan secret atau `git push`, pemakaian konteks di
  atas 85% (compaction gate), dan penulisan berkas yang sedang dipegang tugas paralel
  lain (first-writer-wins).
- Diff diperiksa pola secret sebelum setiap commit.
- Orkestrator tidak pernah push dan tidak pernah merge; review, push, dan merge
  dilakukan manusia.

## Pengembangan

```bash
npm test          # vitest; memakai test/fake-claude.ts, tanpa kuota
npm run typecheck
```

Desain lengkap: [docs/DESIGN.md](docs/DESIGN.md).
