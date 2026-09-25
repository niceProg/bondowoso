# Bondowoso — Desain Arsitektur MVP

> Orkestrator AI coding agent berbasis Claude Code (akun Max, tanpa API key).
> Nama dari Bandung Bondowoso: yang menyuruh ribuan pekerja membangun candi
> dalam semalam. Terinspirasi dari [Jonggrang](https://github.com/porcupine-md/jonggrang).

Status: **DISETUJUI 2026-09-25**, uji coba pertama di `~/Working/digiboost`.

---

## 1. Tujuan

- Memecah satu permintaan fitur menjadi tugas-tugas kecil, lalu mengerjakannya
  satu per satu dengan agent yang **selalu fresh** (konteks bersih).
- Setiap tugas wajib lolos **gerbang deterministik** (lint/typecheck/test)
  dan **review agent** sebelum dianggap selesai.
- Semua state tersimpan di file, sehingga proses bisa dihentikan kapan saja
  (Ctrl+C, rate limit, laptop sleep) lalu dilanjutkan dengan `bondowoso work`.
- Tenaga kerjanya adalah CLI `claude` resmi, sehingga kuota yang dipakai
  adalah **langganan Max**.

### Bukan tujuan MVP
- Multi-backend (Codex, OpenCode). Hanya Claude Code.
- Agent paralel. Tugas dijalankan berurutan; paralel via git worktree masuk fase 2.
- UI web. Cukup CLI.

---

## 2. Prinsip

1. **Stateless agent, stateful orchestrator.** Agent tidak mengingat apa pun;
   semua yang perlu diketahui dimasukkan ke prompt-nya.
2. **Kode yang memutuskan, bukan LLM.** Lulus/gagal gate, urutan tugas, retry,
   dan commit ditentukan oleh TypeScript, bukan oleh agent.
3. **Output agent terstruktur.** Setiap agent wajib membalas JSON sesuai
   schema (`--json-schema`), sehingga orkestrator tidak menebak-nebak dari teks bebas.
4. **Batas peran ditegakkan oleh tool, bukan oleh prompt.** Reviewer tidak
   diberi tool `Edit`/`Write` sama sekali, bukan sekadar "dilarang mengedit".
5. **Manusia menyetujui rencana.** Tidak ada kode yang ditulis sebelum
   `plan.md` di-approve.

---

## 3. Alur perintah

```
bondowoso init                  # sekali per repo: buat .bondowoso/config.yaml
bondowoso plan "<permintaan>"   # Lead menjelajah repo → .bondowoso/plan.md
   (manusia membaca & boleh mengedit plan.md)
bondowoso approve               # Lead memecah plan.md → tasks di manifest.yaml
bondowoso work                  # jalankan tugas pending sampai habis / terhenti
bondowoso status                # tabel tugas + status + attempt
bondowoso resume <task-id>      # pasang lagi patch terakhir tugas blocked, lanjutkan
bondowoso reset <task-id>       # ulang tugas dari awal
```

### Alur per tugas di `bondowoso work`

```
          ┌────────────────────────────────────────────┐
          ▼                                            │ feedback
   [Developer agent] ──► [Gates: lint/type/test] ──fail┤ (attempt < 3)
          │                        │ pass              │
          │                        ▼                   │
          │               [Reviewer agent] ─changes────┘
          │                        │ approve
          │                        ▼
          │               git commit "<pesan dari Developer>"
          │               status = done
          │
          └─ status "blocked" dari agent / attempt habis
                 → status = blocked, lanjut ke tugas berikut
                   yang tidak bergantung padanya
```

---

## 4. Struktur di repo target

```
<repo>/
└── .bondowoso/
    ├── config.yaml          # di-commit: gates, model per peran, batas attempt
    ├── plan.md              # hasil `plan`, diedit manusia
    ├── manifest.yaml        # state tugas (sumber kebenaran)
    └── runs/                # di-.gitignore: log mentah tiap panggilan agent
        └── 2026-09-24T10-00-00/
            ├── T1-developer-1.json
            ├── T1-gates-1.log
            └── T1-reviewer-1.json
```

### `config.yaml`

```yaml
gates:                       # dijalankan berurutan oleh orkestrator
  - name: api-vet
    cwd: api                 # relatif ke root repo; default "."
    run: go vet ./...
  - name: api-test
    cwd: api
    run: go test ./...
  - name: web-typecheck
    cwd: web
    run: npm run typecheck
roles:                       # model diteruskan apa adanya ke `claude --model`
  lead:      { model: claude-opus-5,   effort: high }
  developer: { model: claude-sonnet-5, effort: xhigh }
  reviewer:  { model: claude-opus-5,   effort: medium }
limits:
  max_attempts: 3            # developer→gate/review loop per tugas
  gate_output_tail: 150      # baris terakhir output gate yang dikirim ke developer
```

`bondowoso init` mengisi `gates` secara otomatis dari `package.json` /
`composer.json` bila ada, lalu manusia merapikannya.

### `manifest.yaml`

```yaml
run_id: 2026-09-24T10-00-00
request: "Tambah filter tanggal di halaman daftar Event"
branch: bondowoso/event-date-filter
plan_hash: 3f9a…            # approve ditolak kalau plan.md berubah setelahnya
tasks:
  - id: T1
    title: Tambah query var `event_from`/`event_to`
    description: |
      …
    acceptance:
      - "GET /events?event_from=2026-10-01 hanya menampilkan event ≥ tanggal itu"
    files_hint: [inc/query.php]
    depends_on: []
    status: done              # pending | in_progress | done | blocked
    attempts: 1
    commit: a1b2c3d
    history:
      - { step: developer, attempt: 1, result: done }
      - { step: gates, attempt: 1, result: pass }
      - { step: reviewer, attempt: 1, result: approve }
  - id: T2
    depends_on: [T1]
    status: pending
    …
```

Manifest ditulis **atomik** (tulis ke file sementara lalu `rename`) setelah
setiap langkah, sehingga crash di tengah jalan tidak merusak state.

---

## 5. Peran

| Peran | Kapan | Tool yang diberikan (`--tools`) | Output (JSON schema) |
|---|---|---|---|
| **Lead** (plan) | `bondowoso plan` | `Read, Grep, Glob, Bash(git log:*), Bash(ls:*)` | `{ scope, summary, plan_markdown, open_questions[] }` |
| **Lead** (decompose) | `bondowoso approve` | `Read, Grep, Glob` | `{ tasks: [{ id, title, description, acceptance[], files_hint[], depends_on[] }] }` |
| **Developer** | tiap tugas | `Read, Grep, Glob, Edit, Write, Bash(<developer_bash>)` | `{ status: done\|blocked, summary, blocked_reason? }` |
| **Reviewer** | setelah gate lulus | `Read, Grep, Glob` (diff diberikan di prompt) | `{ verdict: approve\|request_changes, issues: [{ file, line, severity, message }] }` |

Penegakan batas peran:
- Semua agent jalan dengan `--permission-mode dontAsk`: tool atau perintah Bash
  yang tidak ada di allowlist langsung ditolak (sudah diuji: `touch` dan `Write`
  ditolak, perintah read-only seperti `date` lolos).
- Reviewer hanya diberi `Read, Grep, Glob`, jadi secara fisik tidak bisa menulis.
- Developer hanya boleh menjalankan pola Bash di `developer_bash` (mis. `go test:*`),
  jadi tidak bisa `git commit`/`git push`; hanya orkestrator yang melakukan commit.
- Jumlah aksi yang ditolak dicatat di history tugas untuk menyetel `developer_bash`.

**Tester** (menulis test dari acceptance criteria sebelum Developer mulai)
ditunda ke fase 2, karena gate `test` sudah menjadi jaring pengaman pertama.

### Isi prompt per panggilan (konteks minimal)
- Prompt peran (`src/prompts/<role>.md`), dilampirkan via `--append-system-prompt`.
- Ringkasan permintaan + bagian `plan.md` yang relevan.
- Spesifikasi tugas (deskripsi, acceptance, files_hint).
- Ringkasan tugas yang sudah selesai (judul + commit), **bukan** isi percakapannya.
- Pada retry: output gate yang gagal (tail N baris) atau daftar issue dari Reviewer.

---

## 6. Runner: cara memanggil Claude Code

```ts
spawn("claude", [
  "-p", prompt,
  "--output-format", "json",
  "--json-schema", JSON.stringify(schema),
  "--append-system-prompt", rolePrompt,
  "--tools", tools.join(","),
  "--permission-mode", "dontAsk",      // tool di luar daftar = ditolak, tidak bertanya
  "--permission-prompts", "none",
  "--model", role.model,
  "--effort", role.effort,
  "--no-session-persistence",
  "--strict-mcp-config",               // jangan muat MCP global (Figma, Drive, dll.)
], {
  cwd: repoRoot,
  env: withoutKeys(process.env, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
});
```

Catatan penting (sudah dicek di mesin ini, Claude Code 2.1.281):
- **Jangan pakai `--bare`**, karena mode itu tidak membaca login OAuth/Keychain
  dan hanya menerima `ANTHROPIC_API_KEY`, jadi akan menagih API.
- Uji coba `claude -p … --output-format json` berhasil dengan login Max. Field
  `total_cost_usd` di output adalah **harga list (estimasi)**, bukan tagihan,
  tetapi bisa dipakai untuk memantau seberapa berat sebuah run.
- Overhead satu panggilan kosong sekitar **48k token** tanpa `--strict-mcp-config`
  (MCP global ikut dimuat), dan hanya **~4–10k token** dengan flag itu. Karena
  setiap agent adalah proses baru, flag ini wajib.
- `claude-opus-5` dan `claude-sonnet-5` dengan `--effort xhigh` sudah dicoba
  dan berjalan dengan login Max.

### Deteksi rate limit
- Output JSON punya `is_error`, `api_error_status`, dan `subtype`. Bentuk persis
  untuk kasus limit langganan akan dicatat saat pertama kali terjadi, lalu
  dicocokkan secara eksplisit.
- Saat terkena limit: tugas dikembalikan ke `pending` (attempt **tidak**
  bertambah), manifest disimpan, lalu proses keluar dengan kode `75`
  dan pesan jam reset bila tersedia.
- Opsi `bondowoso work --wait`: tidur sampai jam reset lalu lanjut sendiri.

---

## 7. Strategi Git

- `bondowoso work` menolak jalan kalau ada file **tracked** yang berubah (di luar
  `.bondowoso/`). File untracked milik user (misalnya lock file Office) dibiarkan
  dan **tidak pernah dihapus**: sebelum tugas dimulai, daftar file untracked
  dicatat, dan saat rollback hanya file untracked **baru** yang dihapus.
- Orkestrator **tidak pernah push**. Ini penting untuk digiboost, karena push ke
  `main` langsung memicu deploy produksi.
- Hasil tidak membawa jejak orkestrator. Nama branch diusulkan Lead dari konvensi
  branch repo (daftar branch + subject commit terbaru diberikan di prompt), ditulis di
  baris `**Branch:**` plan.md dan boleh diedit sebelum approve. Nama yang tidak valid
  (`git check-ref-format`) atau menyebut orkestrator diganti cadangan `feat/<5 kata awal>`;
  bentrok nama diberi akhiran `-2`, `-3`, ...
- Pertama kali jalan: buat branch itu dari HEAD.
- Satu commit per tugas yang lolos. Pesannya diusulkan Developer mengikuti gaya commit
  repo; id tugas di depan subject dan trailer (`Co-Authored-By`, "Generated with …")
  dibuang. Untuk mengenali commit yang sempat dibuat sebelum proses terputus, HEAD
  sebelum commit dicatat di manifest (`commit_base`), bukan ditandai di pesan commit.
- Tugas yang gagal/blocked/terputus: diff-nya (termasuk file baru dan hasil
  `git rm`/`git mv`) disimpan sebagai patch `runs/<run>/<id>-attempt-<n>.patch`,
  lalu working tree dikembalikan ke commit terakhir. `bondowoso resume <id>`
  memasang patch itu lagi; setelah manusia menambal, `work` langsung menjalankan
  gate → Reviewer tanpa Developer, dan Developer baru dipanggil kalau ada yang menolak.
- Developer boleh `git rm`/`git mv` (hanya menyentuh file yang dilacak git, jadi
  selalu bisa dipulihkan). Daftar `developer_bash` ikut dimasukkan ke prompt-nya
  supaya tidak membuang giliran menebak perintah yang diizinkan.
- Merge ke branch utama dilakukan **manusia**.

---

## 8. Struktur kode orkestrator

Node v26 bisa menjalankan `.ts` langsung (type stripping), jadi **tidak perlu
build step**. `tsc --noEmit` hanya dipakai untuk typecheck.

```
bondowoso/
├── package.json            # "type": "module", bin: { bondowoso: "src/cli.ts" }
├── tsconfig.json
├── src/
│   ├── cli.ts              # commander: init/plan/approve/work/status/reset
│   ├── config.ts           # baca & validasi config.yaml (zod)
│   ├── manifest.ts         # tipe, baca/tulis atomik, pemilihan tugas berikutnya
│   ├── runner/claude.ts    # spawn claude, parse JSON, bersihkan env, deteksi limit
│   ├── roles/              # lead.ts, developer.ts, reviewer.ts (tools + schema + builder prompt)
│   ├── prompts/            # lead-plan.md, lead-decompose.md, developer.md, reviewer.md
│   ├── pipeline/           # plan.ts, approve.ts, work.ts
│   ├── gates.ts            # jalankan perintah gate, tangkap tail output
│   ├── git.ts
│   └── log.ts
└── test/                   # vitest
    └── fake-claude.ts      # stub CLI: balasan JSON dari fixture, tanpa kuota
```

Dependensi: `commander`, `yaml`, `zod` (v4 bisa langsung menghasilkan JSON Schema
untuk `--json-schema`), `vitest` (dev). Selain itu hanya `node:child_process`
dan `node:fs`.

Pengujian orkestrator memakai `BONDOWOSO_CLAUDE_BIN=test/fake-claude.ts`, sehingga
seluruh alur (retry, gate gagal, review menolak, rate limit, resume) bisa diuji
tanpa memakai kuota Max.

---

## 9. Roadmap

**MVP (fase 1)**
1. Kerangka CLI, config, manifest, runner + fake-claude.
2. `plan` dan `approve`.
3. `work`: developer → gates → reviewer → commit, retry, blocked, resume.
4. Deteksi rate limit + `--wait`.
5. Uji coba nyata di `~/Working/digiboost` (monorepo Go + Nuxt).

**Fase 2**
- Peran Tester (test-first dari acceptance criteria).
- Tugas paralel via `git worktree` + penguncian file.
- Hook `PreToolUse` via `--settings` untuk membatasi path yang boleh diedit
  per tugas.
- Laporan akhir run (ringkasan tugas, commit, estimasi token).

---

## 10. Keputusan (2026-09-25)

1. Nama: **`bondowoso`**.
2. Uji coba pertama: **`~/Working/digiboost`**. Gate diambil dari Taskfile/CI-nya:
   cek `gofmt`, `go vet`, `go test ./...` di `api/`, dan `npm run build` di `web/`
   (`nuxt typecheck` gagal karena `web/` tidak punya `tsconfig.json`; CI pun memakai build).
3. Tester ditunda ke fase 2.
4. Commit otomatis per tugas di branch terpisah; tidak pernah push.
5. Model: Lead `claude-opus-5` (high), Developer `claude-sonnet-5` (xhigh),
   Reviewer `claude-opus-5` (medium).
