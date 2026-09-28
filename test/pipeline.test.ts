import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { approveReview, calls, cleanup, cli, committedFiles, dev, gitLog, gitOut, h, manifest, PLAN, rejectReview, setup, task, blockedDev } from "./helpers.ts";

afterEach(cleanup);

describe("pipeline", () => {
  it("plan → approve → work sampai semua tugas ter-commit", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1"), task("T2", ["T1"])] } }],
      developer: [
        dev({ "app.txt": "good\n" }, "T1: feat(app): tambah app.txt"),
        dev({ "lib/util.txt": "util\n" }, "feat(util): tambah util\n\nAlasannya di sini.\n\nCo-Authored-By: Claude <noreply@anthropic.com>"),
      ],
      reviewer: [approveReview, approveReview],
    });

    expect(cli("plan", "tambah", "fitur", "app").code).toBe(0);
    const planMd = readFileSync(join(h.repo, ".bondowoso", "plan.md"), "utf8");
    expect(planMd).toContain("## Langkah");
    expect(planMd).toContain("**Branch:** `feat/tambah-fitur-app`");
    // Konvensi h.repo ikut dikirim ke Lead dan Developer.
    expect(calls("lead")[0].prompt).toMatch(/Existing branches[\s\S]*- main/);
    expect(calls("lead")[0].prompt).toMatch(/Recent commit subjects[\s\S]*- awal/);
    expect(cli("approve").code).toBe(0);

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    // Pesan commit dari Developer, tanpa id tugas dan tanpa trailer AI.
    expect(gitLog().slice(0, 2)).toEqual(["feat(util): tambah util", "feat(app): tambah app.txt"]);
    const body = gitOut("log", "-1", "--format=%B");
    expect(body).toContain("Alasannya di sini.");
    expect(body).not.toMatch(/co-authored-by|bondowoso/i);
    expect(calls("developer")[0].prompt).toMatch(/Recent commit subjects in this repository[\s\S]*- awal/);
    expect(manifest().branch).toBe("feat/tambah-fitur-app");
    expect(gitOut("branch", "--show-current")).toBe("feat/tambah-fitur-app");
    expect(manifest().tasks.map((t: any) => t.status)).toEqual(["done", "done"]);
    expect(committedFiles()).toEqual(expect.arrayContaining(["app.txt", "lib/util.txt"]));
    expect(committedFiles()).not.toContain("notes.txt");
    expect(existsSync(join(h.repo, "notes.txt"))).toBe(true);

    // Batas peran ditegakkan lewat daftar tool, bukan hanya lewat prompt.
    const reviewerArgs = calls("reviewer")[0].args;
    expect(reviewerArgs[reviewerArgs.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    // T2 melihat T1 sebagai tugas yang sudah selesai.
    expect(calls("developer")[1].prompt).toMatch(/- T1: Tugas T1 \(commit [0-9a-f]+\)/);
  });

  it("gate gagal dan review menolak memicu percobaan ulang dengan feedback", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [dev({ "app.txt": "bad\n" }), dev({ "app.txt": "good\n" }), dev({ "app.txt": "good\nfixed\n" })],
      reviewer: [rejectReview, approveReview],
    });
    cli("plan", "fitur");
    cli("approve");

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    const devCalls = calls("developer");
    expect(devCalls[1].prompt).toContain('Gate "app" gagal');
    expect(devCalls[2].prompt).toContain("tambahkan baris fixed");
    expect(manifest().tasks[0]).toMatchObject({ status: "done", attempts: 3 });
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("good\nfixed\n");
  });

  it("rate limit menjeda tanpa menghitung percobaan, lalu bisa dilanjutkan", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [{ write: { "app.txt": "setengah\n" }, rateLimit: true }, dev({ "app.txt": "good\n" })],
      reviewer: [approveReview],
    });
    cli("plan", "fitur");
    cli("approve");

    const first = cli("work");
    expect(first.code, first.out).toBe(75);
    expect(first.out).toContain("Kuota Max habis");
    expect(manifest().tasks[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(existsSync(join(h.repo, "app.txt"))).toBe(false);
    expect(existsSync(join(h.repo, "notes.txt"))).toBe(true);
    // Pekerjaan setengah jadi tidak hilang: tersimpan sebagai patch.
    expect(readFileSync(join(h.repo, ".bondowoso", manifest().tasks[0].last_patch), "utf8")).toContain("+setengah");

    const second = cli("work");
    expect(second.code, second.out).toBe(0);
    expect(manifest().tasks[0]).toMatchObject({ status: "done", attempts: 1 });
  });

  it("tugas yang terus gagal jadi blocked, dependennya tertahan, perubahan dibuang", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1"), task("T2", ["T1"])] } }],
        developer: [dev({ "app.txt": "bad\n" }), dev({ "app.txt": "bad lagi\n" })],
        reviewer: [],
      },
      { max_attempts: 2 },
    );
    cli("plan", "fitur");
    cli("approve");

    const r = cli("work");
    expect(r.code, r.out).toBe(2);
    expect(manifest().tasks.map((t: any) => t.status)).toEqual(["blocked", "pending"]);
    expect(existsSync(join(h.repo, "app.txt"))).toBe(false);
    expect(existsSync(join(h.repo, "notes.txt"))).toBe(true);
    expect(gitLog()).toEqual(["awal"]);
  });

  it("menolak mulai kalau gate sudah merah sebelum ada perubahan", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [],
      reviewer: [],
    });
    cli("plan", "fitur");
    cli("approve");
    writeFileSync(join(h.repo, "app.txt"), "bad\n");
    spawnSync("git", ["add", "app.txt"], { cwd: h.repo });
    spawnSync("git", ["commit", "-q", "-m", "rusak"], { cwd: h.repo });

    const r = cli("work");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Gate sudah gagal sebelum ada perubahan");
  });

  it("plan --file membaca permintaan multi-baris dari file", () => {
    setup({ lead: [{ output: PLAN }], developer: [], reviewer: [] });
    const file = join(h.repo, "..", `${h.repo.split("/").pop()}-permintaan.md`);
    writeFileSync(file, "<!-- catatan -->\nTambah filter tanggal\n\n- dari\n- sampai\n");

    const r = cli("plan", "--file", file);
    rmSync(file);
    expect(r.code, r.out).toBe(0);
    expect(calls("lead")[0].prompt).toContain("Tambah filter tanggal\n\n- dari\n- sampai");
    expect(calls("lead")[0].prompt).not.toContain("catatan");
    const planMd = readFileSync(join(h.repo, ".bondowoso", "plan.md"), "utf8");
    expect(planMd).toMatch(/^# Rencana: Tambah filter tanggal\n/);
    expect(planMd).toContain("## Permintaan");
  });

  it("plan menolak teks dan --file sekaligus", () => {
    setup({ lead: [], developer: [], reviewer: [] });
    const r = cli("plan", "--file", "x.md", "fitur");
    expect(r.code).toBe(1);
    expect(r.out).toContain("jangan keduanya");
  });

  it("plan tanpa teks di luar terminal memberi petunjuk, bukan membuka editor", () => {
    setup({ lead: [], developer: [], reviewer: [] });
    const r = cli("plan");
    expect(r.code).toBe(1);
    expect(r.out).toContain("--file");
  });

  it("nama branch di plan.md boleh diedit sebelum approve", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [dev({ "app.txt": "good\n" })],
      reviewer: [approveReview],
    });
    cli("plan", "fitur");
    const planPath = join(h.repo, ".bondowoso", "plan.md");
    writeFileSync(planPath, readFileSync(planPath, "utf8").replace("feat/tambah-fitur-app", "feat/redesign-dashboard-user"));
    cli("approve");

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(manifest().branch).toBe("feat/redesign-dashboard-user");
  });

  it("nama branch yang menyebut orkestrator diganti cadangan, dan bentrok nama diberi akhiran", () => {
    setup({
      lead: [{ output: { ...PLAN, branch_name: "bondowoso/run-1" } }, { output: { tasks: [task("T1")] } }],
      developer: [dev({ "app.txt": "good\n" })],
      reviewer: [approveReview],
    });
    spawnSync("git", ["branch", "feat/redesign-dashboard-user-yang-lebih"], { cwd: h.repo });
    cli("plan", "Redesign", "dashboard", "user", "yang", "lebih", "tertata");
    expect(readFileSync(join(h.repo, ".bondowoso", "plan.md"), "utf8")).toContain("`feat/redesign-dashboard-user-yang-lebih`");
    cli("approve");

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(manifest().branch).toBe("feat/redesign-dashboard-user-yang-lebih-2");
  });

  it("menolak work kalau plan.md diedit setelah approve", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [],
      reviewer: [],
    });
    cli("plan", "fitur");
    cli("approve");
    writeFileSync(join(h.repo, ".bondowoso", "plan.md"), "# diubah\n");

    const r = cli("work");
    expect(r.code).toBe(1);
    expect(r.out).toContain("plan.md berubah setelah approve");
  });
});



describe("macet dan dilanjutkan", () => {
  it("blocked menyimpan patch + aksi yang ditolak; resume + tambal manual lalu work meng-commit tanpa Developer", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        developer: [
          blockedDev("tidak bisa menghapus old.txt", {
            write: { "app.txt": "good\n", "lib/new.txt": "baru\n" },
            denials: [
              { tool_name: "Bash", tool_input: { command: "rm old.txt" } },
              { tool_name: "Bash", tool_input: { command: "cd lib && python3 -c 'import os'" } },
            ],
          }),
        ],
        reviewer: [approveReview],
      },
      {},
      { files: { "old.txt": "lama\n" } },
    );
    cli("plan", "fitur");
    cli("approve");

    const first = cli("work");
    expect(first.code, first.out).toBe(2);
    expect(first.out).toContain("rm old.txt");
    expect(first.out).toContain('"rm:*"');
    expect(first.out).toContain('"python3:*"');
    expect(first.out).toContain("bondowoso resume T1");
    expect(existsSync(join(h.repo, "app.txt"))).toBe(false);
    expect(manifest().tasks[0].denied).toEqual(["rm old.txt", "cd lib && python3 -c 'import os'"]);
    expect(cli("status").out).toContain("bondowoso resume T1");

    const resumed = cli("resume", "T1");
    expect(resumed.code, resumed.out).toBe(0);
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("good\n");
    expect(readFileSync(join(h.repo, "lib/new.txt"), "utf8")).toBe("baru\n");
    expect(manifest().tasks[0].status).toBe("resumed");

    // Manusia menambal bagian yang tidak bisa dikerjakan agent.
    rmSync(join(h.repo, "old.txt"));

    const second = cli("work");
    expect(second.code, second.out).toBe(0);
    expect(calls("developer")).toHaveLength(1);
    const review = calls("reviewer")[0].prompt;
    expect(review).toContain("bondowoso resume");
    expect(review).toContain("deleted file mode");
    expect(committedFiles()).toEqual(expect.arrayContaining(["app.txt", "lib/new.txt"]));
    expect(committedFiles()).not.toContain("old.txt");
    expect(committedFiles()).not.toContain("notes.txt");
    expect(manifest().tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    // Tanpa Developer di percobaan ini, pesan commit dari percobaan sebelumnya dipakai.
    expect(gitLog()[0]).toBe("feat: tambah app dan hapus old");
  });

  it("tugas hasil resume yang gagal gate diteruskan ke Developer dengan working tree utuh", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        developer: [blockedDev("macet", { write: { "app.txt": "bad\n", "extra.txt": "x\n" } }), dev({ "app.txt": "good\n" })],
        reviewer: [approveReview],
      },
    );
    cli("plan", "fitur");
    cli("approve");
    expect(cli("work").code).toBe(2);
    expect(cli("resume", "T1").code).toBe(0);

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(calls("developer")[1].prompt).toContain('Gate "app" gagal');
    // extra.txt dari patch tetap ada dan ikut ter-commit bersama perbaikan Developer.
    expect(committedFiles()).toEqual(expect.arrayContaining(["app.txt", "extra.txt"]));
  });

  it("reset tugas yang sedang di-resume membersihkan working tree", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [blockedDev("macet", { write: { "app.txt": "good\n" } })],
      reviewer: [],
    });
    cli("plan", "fitur");
    cli("approve");
    cli("work");
    cli("resume", "T1");
    expect(existsSync(join(h.repo, "app.txt"))).toBe(true);

    expect(cli("reset", "T1").code).toBe(0);
    expect(existsSync(join(h.repo, "app.txt"))).toBe(false);
    expect(existsSync(join(h.repo, "notes.txt"))).toBe(true);
    expect(manifest().tasks[0].status).toBe("pending");
  });

  it("git rm dan git mv dari Developer ikut ter-commit, dan bisa di-rollback + resume", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1"), task("T2")] } }],
        developer: [
          { ...dev({}), run: ["git mv old.txt moved.txt", "git rm -q gone.txt"] },
          blockedDev("macet", { run: ["git rm -q keep.txt"], write: { "app.txt": "good\n" } }),
        ],
        reviewer: [approveReview],
      },
      {},
      { files: { "old.txt": "lama\n", "gone.txt": "hapus\n", "keep.txt": "tetap\n" }, developer_bash: ["git rm:*", "git mv:*"] },
    );
    cli("plan", "fitur");
    cli("approve");

    const r = cli("work");
    expect(r.code, r.out).toBe(2);
    expect(committedFiles()).toEqual(expect.arrayContaining(["moved.txt", "keep.txt"]));
    expect(committedFiles()).not.toContain("old.txt");
    expect(committedFiles()).not.toContain("gone.txt");
    // T2 di-rollback: keep.txt kembali, app.txt hilang, index bersih.
    expect(readFileSync(join(h.repo, "keep.txt"), "utf8")).toBe("tetap\n");
    expect(existsSync(join(h.repo, "app.txt"))).toBe(false);
    expect(gitOut("status", "--porcelain", "--untracked-files=no")).toBe("");

    // Izin git rm/mv diberitahukan ke Developer di system prompt.
    const args = calls("developer")[0].args;
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("- `git rm …`");

    expect(cli("resume", "T2").code).toBe(0);
    expect(existsSync(join(h.repo, "keep.txt"))).toBe(false);
    expect(existsSync(join(h.repo, "app.txt"))).toBe(true);
  });

  it("resume ditolak untuk tugas tanpa patch", () => {
    setup({ lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }], developer: [], reviewer: [] });
    cli("plan", "fitur");
    cli("approve");
    const r = cli("resume", "T1");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Tidak ada patch tersimpan");
  });
});

describe("init", () => {
  it("mengizinkan git read-only, git rm/mv, dan eslint kalau dipakai", () => {
    h.repo = mkdtempSync(join(tmpdir(), "bondowoso-test-"));
    spawnSync("git", ["init", "-q"], { cwd: h.repo });
    mkdirSync(join(h.repo, "web"));
    writeFileSync(join(h.repo, "web", "package.json"), JSON.stringify({ scripts: { build: "x" }, devDependencies: { eslint: "^9" } }));
    h.scriptPath = join(h.repo, "..", `${h.repo.split("/").pop()}-script.json`);

    expect(cli("init").code).toBe(0);
    const config = parse(readFileSync(join(h.repo, ".bondowoso", "config.yaml"), "utf8"));
    expect(config.developer_bash).toEqual(
      expect.arrayContaining(["git status:*", "git diff:*", "git rm:*", "git mv:*", "npx eslint:*", "npm run:*"]),
    );
  });
});
