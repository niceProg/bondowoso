# Bondowoso — Desain

> Orkestrator AI coding agent berbasis Claude Code (akun Max, tanpa API key).
> Nama dari Bandung Bondowoso, yang menyuruh ribuan pekerja membangun candi dalam
> semalam. Desainnya mengikuti dokumentasi [Jonggrang](https://github.com/porcupine-md/jonggrang).

Status: **v2 (2026-09-29)**. v1 (MVP) disetujui 2026-09-25 dan diuji di digiboost.

---

## 1. Prinsip

1. **Stateless agent, stateful orchestrator.** Setiap agent adalah proses `claude -p`
   baru dengan konteks bersih; semua state ada di `.bondowoso/manifest.yaml`.
2. **Kode yang memutuskan, bukan LLM.** Lulus/gagal gate, dirty-bit, retry, pemulihan
   berkas di luar wewenang, commit, dan penggabungan ditentukan TypeScript.
3. **Output agent terstruktur.** Setiap peran membalas JSON sesuai schema (`--json-schema`).
4. **Batas peran ditegakkan oleh tool dan orkestrator, bukan prompt.**
5. **Manusia menyetujui rencana** dan memegang push/merge.

Riset atas kode Jonggrang (September 2026) menemukan banyak bagian dokumentasinya
belum benar-benar ditegakkan di kode: batas peran hanya lewat prompt, verdict
Reviewer tidak dibaca, loop dirty-bit tidak pernah aktif, router skill tidak
dipanggil. Bondowoso mengikuti **desain yang didokumentasikan**, tetapi
menegakkannya secara deterministik.

---

## 2. Perintah

```
bondowoso init
bondowoso plan [permintaan] [--file f] [--deep] [--src f] [--base b] [--no-ask] [--yes]
bondowoso plan --revise "<instruksi>"      # plan belum di-approve
bondowoso plan --append "<permintaan>"     # tambah ke run yang sudah di-approve
bondowoso approve [--force]
bondowoso work [--parallel n] [--task T3] [--compact] [--full] [--wait]
bondowoso work "<permintaan>" --yes        # plan + approve + work sekaligus
bondowoso status | resume <id> | reset <id>
bondowoso memory show|recall|compact|promote
bondowoso skills list|show
```

---

## 3. Fase

| # | Fase | Peran | Kapan |
|---|---|---|---|
| 1 | Klarifikasi | Lead | `plan` di terminal interaktif, kecuali `--no-ask`/`--yes`; ≤ 6 pertanyaan pilihan/teks |
| 2 | Discovery | Lead | `plan --deep` |
| 3 | Analisis (2–3 pendekatan + rekomendasi + triage scope) | Lead | `plan --deep` |
| 4 | Rencana (`plan.md`, usulan branch) | Lead | selalu |
| 5 | Dekomposisi (tugas atomik + skill per tugas) | Lead | `approve` |
| 6 | Test planning (kasus test per tugas) | Test Lead | `approve`, kecuali scope bugfix |
| 7 | Implement | Developer | per tugas |
| 8 | Gate (lint/test/build dari config) | orkestrator | per tugas |
| 9 | Scan secret pada baris diff yang ditambahkan | orkestrator | per tugas |
| 10 | Simplify (tanpa ubah perilaku; hanya berkas tugas) | Simplifier | kecuali scope bugfix |
| 11 | Test (tulis/jalankan test; hanya berkas test) | Tester | per tugas |
| 12 | Review (design verification, domain compliance, code quality, test quality) | Reviewer | per tugas |
| 13 | Commit + fragmen memory | orkestrator | per tugas |
| 14 | Memory compact → promote | Lead (tanpa tool) | akhir run |

Fase yang dilewati per scope diatur `pipeline.skip` (bawaan: bugfix melewati
simplify dan test planning, seperti `PHASE_SKIP_MAP` Jonggrang). `work --compact`
berhenti setelah fase 9 dan mencatat `deferred`; `work --full` menjalankan fase
10–12 untuk tugas itu sebagai commit susulan.

Berbeda dari Jonggrang (Simplify/Test/Review sekali di level fitur setelah semua
tugas), Bondowoso menjalankannya **per tugas**, sehingga setiap commit sudah teruji
dan direview.

### Peran dan tool

| Peran | Tool | Catatan |
|---|---|---|
| Lead, Test Lead | `Read, Grep, Glob, Bash` (hanya read-only yang lolos `dontAsk`) | |
| Developer | `Read, Grep, Glob, Edit, Write, Bash(developer_bash)` | boleh `git rm`/`git mv`, tidak boleh commit/push |
| Simplifier | sama dengan Developer | perubahan di luar berkas tugas dikembalikan; gate merah → Simplify dibatalkan |
| Tester | sama dengan Developer | perubahan di luar berkas test (domain `testing`) dikembalikan; bug dilaporkan, tidak diperbaiki |
| Reviewer | `Read, Grep, Glob` | secara fisik tidak bisa menulis |
| Memory | tanpa tool | |

Model per peran di `roles` config; `simplifier`, `test_lead`, dan `tester` opsional
(bawaan mengikuti Developer/Lead).

### Dirty-bit dan loop

Berkas dipetakan ke domain lewat regex `domains` (bawaan: testing, database,
frontend, api, sisanya backend). Setiap perubahan menandai domain yang disentuh
`PENDING`; Tester dan Reviewer menulis `PASS`/`FAIL` per domain; FAIL di satu domain
mengembalikan domain lain ke `PENDING`. Commit hanya kalau semua domain yang
disentuh PASS di fase yang aktif. Feedback yang ≥ 90% mirip (Jaccard) dengan salah
satu feedback sebelumnya dianggap loop dan tugas dihentikan lebih awal.
Batas percobaan: `limits.max_attempts`.

---

## 4. Hook

`src/hooks/hook.ts` dipasang lewat `claude --settings` (PreToolUse untuk
Read/Edit/Write/MultiEdit/NotebookEdit/Grep/Glob/Bash), konfigurasi dikirim lewat
env `BONDOWOSO_HOOK_CONFIG`. Penolakan dikirim sebagai `permissionDecision: "deny"`
sehingga agent membaca alasannya dan orkestrator mencatatnya di `permission_denials`.

- **Berkas sensitif:** `.env*` (kecuali `.example/.sample/.template/.dist`), `*.pem/key/p12/pfx/jks/keystore/ppk`,
  `id_rsa|dsa|ecdsa|ed25519`, `credentials*`, `secrets*`, `.npmrc/.pypirc/.netrc/.git-credentials/.pgpass`,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.config/gh`.
- **Perintah:** `printenv`/`env`/`export`/`set` tanpa argumen, `$…TOKEN|SECRET|PASSWORD|API_KEY…`,
  keychain macOS, `gh auth token`, kredensial AWS, `git push`, `curl … | sh`, dan
  token apa pun yang menunjuk berkas sensitif.
- **Compaction gate:** membaca token pesan asisten terakhir dari transcript sesi;
  di atas `hooks.compaction_block_pct` (bawaan 85%) dari `hooks.context_window`
  semua tool ditolak dan agent diminta mengembalikan output sekarang. Karena itu
  sesi disimpan (tanpa `--no-session-persistence`) lalu transcript-nya dihapus
  orkestrator setelah agent selesai.
- **Kunci berkas (paralel):** first-writer-wins lewat `mkdir` atomik di
  `~/.bondowoso/locks/<repo>/<run>/`; dilepas saat tugas selesai/blocked.

Catatan riset: hook Jonggrang memblokir dengan exit 2 tetapi menulis alasan ke
stdout, sehingga alasannya kemungkinan tidak sampai ke model. Bondowoso memakai
JSON `permissionDecision` yang sudah diuji sampai ke agent.

---

## 5. Skill

Format mengikuti Jonggrang: `skills/core/<nama>/SKILL.md` (selalu dimuat untuk
`roles`-nya) dan `skills/library/<domain>/<nama>/SKILL.md` (just-in-time), dengan
frontmatter `name, description, tier, domains, roles, trigger`. Skill proyek di
`.bondowoso/skills/**` menimpa skill bawaan bernama sama.

Pemilihan deterministik per tugas: skill yang ditetapkan Lead saat dekomposisi
(dari katalog), lalu skill library yang kata kuncinya cocok dengan teks tugas
(dengan bonus domain berkas), maksimal `skills.max_per_task`, dipotong di
`skills.max_chars`. Isinya disisipkan ke prompt Developer, Tester, dan Reviewer.

---

## 6. Memory

```
.bondowoso/memory/fragments/<run>/<tugas>.md   catatan per tugas (commit, what/why, lessons, catatan minor)
.bondowoso/memory/runs/<run>.md                 hasil compact satu run
.bondowoso/memory/archive/<run>/                fragmen yang sudah di-compact
.bondowoso/MEMORY.md                            pelajaran proyek (Conventions, Known Pitfalls,
                                                Architectural Decisions, Repeated Lessons)
```

Setiap tugas yang ter-commit menulis fragmen dari `lessons` Developer/Reviewer.
Di akhir run yang selesai semua, fragmen di-compact ke memory run lalu (bila
`memory.auto_promote`) pelajaran stabil dipromosikan ke `MEMORY.md`. Keduanya
diperiksa pola secret sebelum ditulis. Recall deterministik (potongan bagian
paling relevan, ≤ 5 potongan dan `memory.recall_chars`) disisipkan ke prompt Lead
dan Developer sebagai konteks, bukan instruksi.

---

## 7. Paralel

`work --parallel n` (atau `parallel.max`) menjalankan hingga n tugas siap
bersamaan, masing-masing di worktree detached
`~/.bondowoso/worktrees/<repo>/<run>/<tugas>` yang dibuat dari HEAD branch kerja.
Tugas hanya dijadwalkan bersama kalau `files_hint`-nya tidak beririsan; selama
jalan, hook kunci berkas menangani sisanya. Path di `parallel.link` (mis.
`web/node_modules`) di-symlink ke worktree supaya gate tidak perlu install ulang.

Setiap tugas menjalankan pipeline penuhnya di worktree dan commit di sana; commit
lalu dipasang ke branch kerja satu per satu dengan cherry-pick. Kalau bentrok:
cherry-pick dibatalkan, hasilnya disimpan sebagai patch, dan tugas diulang sekali
dari HEAD terbaru; bentrok kedua → blocked (bisa `resume`). Worktree, kunci, dan
folder run yang kosong dibersihkan. Kuota habis di satu tugas menghentikan
penjadwalan baru; tugas lain yang sedang jalan dibiarkan selesai.

---

## 8. Git

- `work` menolak jalan kalau ada perubahan tracked (kecuali tugas hasil `resume`).
  File untracked milik user tidak pernah dihapus atau di-commit.
- Branch dibuat dari HEAD atau `--base`; nama dari baris **Branch:** plan.md
  (divalidasi `git check-ref-format`, tanpa nama orkestrator, cadangan
  `feat/<5 kata>`, bentrok → `-2`).
- Pesan commit ditulis agent mengikuti subject commit terbaru repo; id tugas dan
  trailer AI dibuang.
- Pemulihan setelah terputus: HEAD dicatat (`commit_base`) sebelum commit; patch
  disimpan sebelum setiap rollback; worktree paralel yang tertinggal dibereskan.
- Tidak pernah push atau merge.

---

## 9. Riwayat keputusan

- 2026-09-25: nama `bondowoso`; uji coba di `~/Working/digiboost`; model Lead
  Opus, Developer Sonnet (xhigh), Reviewer Opus; commit otomatis per tugas di
  branch terpisah, tanpa push.
- 2026-09-25: patch sebelum rollback dan `resume` (T1 digiboost sempat kehilangan
  16 menit kerja); `git rm`/`git mv` diizinkan; daftar izin masuk prompt.
- 2026-09-25: branch dan commit mengikuti konvensi repo, tanpa jejak orkestrator.
- 2026-09-29: v2 mengikuti Jonggrang: Simplify, Test Lead/Tester, dirty-bit per
  domain, hook, skill, memory, flag perencanaan, `--compact/--full/--task`, dan
  paralel dengan worktree.
