# Bondowoso

Orkestrator AI coding agent berbasis Claude Code. Satu permintaan dipecah jadi
tugas-tugas kecil; tiap tugas dikerjakan Developer yang selalu fresh, lalu harus
lolos gate (lint/test/build) dan Reviewer sebelum di-commit ke branch terpisah.

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
bondowoso plan "<permintaan>"   # Lead menulis .bondowoso/plan.md
# baca & edit .bondowoso/plan.md
bondowoso approve               # pecah rencana menjadi tugas
bondowoso work                  # --wait: tunggu sendiri saat kuota habis
bondowoso status
bondowoso reset <id>            # kembalikan tugas blocked ke pending
```

Dari luar repo, pakai `-C`: `bondowoso -C <repo> status`.

Kode keluar `work`: `0` semua selesai, `2` ada tugas blocked, `75` kuota Max habis
(jalankan `work` lagi nanti untuk melanjutkan), `1` error lain.

Orkestrator tidak pernah push dan tidak pernah merge. Branch `bondowoso/<slug>`
di-review dan di-merge oleh manusia.

## Pengembangan

```bash
npm test          # vitest; memakai test/fake-claude.ts, tanpa kuota
npm run typecheck
```

Desain lengkap: [docs/DESIGN.md](docs/DESIGN.md).
