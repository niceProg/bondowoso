# Bondowoso

Orkestrator AI coding agent berbasis Claude Code. Satu permintaan dipecah jadi
tugas-tugas kecil; tiap tugas dikerjakan Developer yang selalu fresh, lalu harus
lolos gate (lint/test/build) dan Reviewer sebelum di-commit ke branch terpisah.

Memakai CLI `claude` resmi dengan login langganan (Max), bukan API key.
`ANTHROPIC_API_KEY` selalu dibuang dari env agent supaya tidak menagih API.

## Pakai

```bash
cd <repo target>
node ~/Working/bondowoso/src/cli.ts init            # buat .bondowoso/config.yaml, rapikan gate-nya
node ~/Working/bondowoso/src/cli.ts plan "<permintaan>"
# baca & edit .bondowoso/plan.md
node ~/Working/bondowoso/src/cli.ts approve
node ~/Working/bondowoso/src/cli.ts work             # --wait: tunggu sendiri saat kuota habis
node ~/Working/bondowoso/src/cli.ts status
```

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
