import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FAKE = join(ROOT, "test", "fake-claude.ts");

const PLAN = { scope: "small", summary: "Ringkasan.", plan_markdown: "## Langkah\n\n- ubah app.txt", open_questions: [] };
const task = (id: string, depends_on: string[] = []) => ({
  id,
  title: `Tugas ${id}`,
  description: "Kerjakan.",
  acceptance: ["app.txt berisi good"],
  files_hint: ["app.txt"],
  depends_on,
});
const dev = (write: Record<string, string>) => ({ write, output: { status: "done", summary: "Ubah file.", blocked_reason: "" } });
const approveReview = { output: { verdict: "approve", summary: "Oke.", issues: [] } };
const rejectReview = {
  output: {
    verdict: "request_changes",
    summary: "Kurang.",
    issues: [{ file: "app.txt", line: 1, severity: "major", message: "tambahkan baris fixed" }],
  },
};

let repo = "";
let scriptPath = "";

interface SetupExtra {
  files?: Record<string, string>; // file tracked tambahan di commit awal
  developer_bash?: string[];
}

function setup(script: Record<string, unknown[]>, limits: Record<string, number> = {}, extra: SetupExtra = {}): void {
  repo = mkdtempSync(join(tmpdir(), "bondowoso-test-"));
  const g = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  for (const [path, content] of Object.entries(extra.files ?? {})) writeFileSync(join(repo, path), content);
  g("add", ".");
  g("commit", "-q", "-m", "awal");
  // File untracked milik user: tidak boleh dihapus atau ikut ter-commit.
  writeFileSync(join(repo, "notes.txt"), "catatan pribadi\n");

  mkdirSync(join(repo, ".bondowoso"));
  writeFileSync(
    join(repo, ".bondowoso", ".gitignore"),
    "*\n!.gitignore\n!config.yaml\n",
  );
  writeFileSync(
    join(repo, ".bondowoso", "config.yaml"),
    stringify({
      gates: [{ name: "app", run: "test ! -f app.txt || grep -q '^good' app.txt" }],
      roles: {
        lead: { model: "fake", effort: "high" },
        developer: { model: "fake", effort: "xhigh" },
        reviewer: { model: "fake", effort: "medium" },
      },
      limits,
      developer_bash: extra.developer_bash ?? [],
    }),
  );
  scriptPath = join(repo, "..", `${repo.split("/").pop()}-script.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
}

function cli(...args: string[]): { code: number; out: string } {
  const r = spawnSync("node", [CLI, "-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, BONDOWOSO_CLAUDE_BIN: FAKE, BONDOWOSO_FAKE_SCRIPT: scriptPath, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}

function manifest(): any {
  return parse(readFileSync(join(repo, ".bondowoso", "manifest.yaml"), "utf8"));
}

function calls(role: string): { prompt: string; args: string[] }[] {
  return readFileSync(`${scriptPath}.calls.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((c) => c.role === role);
}

function gitLog(): string[] {
  return spawnSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n");
}

function committedFiles(): string[] {
  return spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n");
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  for (const suffix of ["", ".calls.jsonl", ".lead.count", ".developer.count", ".reviewer.count"]) {
    rmSync(`${scriptPath}${suffix}`, { force: true });
  }
});

describe("pipeline", () => {
  it("plan → approve → work sampai semua tugas ter-commit", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1"), task("T2", ["T1"])] } }],
      developer: [dev({ "app.txt": "good\n" }), dev({ "lib/util.txt": "util\n" })],
      reviewer: [approveReview, approveReview],
    });

    expect(cli("plan", "tambah", "fitur", "app").code).toBe(0);
    expect(readFileSync(join(repo, ".bondowoso", "plan.md"), "utf8")).toContain("## Langkah");
    expect(cli("approve").code).toBe(0);

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(gitLog().slice(0, 2)).toEqual(["T2: Tugas T2", "T1: Tugas T1"]);
    expect(manifest().branch).toBe("bondowoso/tambah-fitur-app");
    expect(manifest().tasks.map((t: any) => t.status)).toEqual(["done", "done"]);
    expect(committedFiles()).toEqual(expect.arrayContaining(["app.txt", "lib/util.txt"]));
    expect(committedFiles()).not.toContain("notes.txt");
    expect(existsSync(join(repo, "notes.txt"))).toBe(true);

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
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("good\nfixed\n");
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
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(existsSync(join(repo, "notes.txt"))).toBe(true);
    // Pekerjaan setengah jadi tidak hilang: tersimpan sebagai patch.
    expect(readFileSync(join(repo, ".bondowoso", manifest().tasks[0].last_patch), "utf8")).toContain("+setengah");

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
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(existsSync(join(repo, "notes.txt"))).toBe(true);
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
    writeFileSync(join(repo, "app.txt"), "bad\n");
    spawnSync("git", ["add", "app.txt"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "rusak"], { cwd: repo });

    const r = cli("work");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Gate sudah gagal sebelum ada perubahan");
  });

  it("plan --file membaca permintaan multi-baris dari file", () => {
    setup({ lead: [{ output: PLAN }], developer: [], reviewer: [] });
    const file = join(repo, "..", `${repo.split("/").pop()}-permintaan.md`);
    writeFileSync(file, "<!-- catatan -->\nTambah filter tanggal\n\n- dari\n- sampai\n");

    const r = cli("plan", "--file", file);
    rmSync(file);
    expect(r.code, r.out).toBe(0);
    expect(calls("lead")[0].prompt).toContain("Tambah filter tanggal\n\n- dari\n- sampai");
    expect(calls("lead")[0].prompt).not.toContain("catatan");
    const planMd = readFileSync(join(repo, ".bondowoso", "plan.md"), "utf8");
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

  it("menolak work kalau plan.md diedit setelah approve", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [],
      reviewer: [],
    });
    cli("plan", "fitur");
    cli("approve");
    writeFileSync(join(repo, ".bondowoso", "plan.md"), "# diubah\n");

    const r = cli("work");
    expect(r.code).toBe(1);
    expect(r.out).toContain("plan.md berubah setelah approve");
  });
});

function gitOut(...args: string[]): string {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
}

const blockedDev = (reason: string, extra: Record<string, unknown> = {}) => ({
  ...extra,
  output: { status: "blocked", summary: "Sebagian selesai.", blocked_reason: reason },
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
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(manifest().tasks[0].denied).toEqual(["rm old.txt", "cd lib && python3 -c 'import os'"]);
    expect(cli("status").out).toContain("bondowoso resume T1");

    const resumed = cli("resume", "T1");
    expect(resumed.code, resumed.out).toBe(0);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("good\n");
    expect(readFileSync(join(repo, "lib/new.txt"), "utf8")).toBe("baru\n");
    expect(manifest().tasks[0].status).toBe("resumed");

    // Manusia menambal bagian yang tidak bisa dikerjakan agent.
    rmSync(join(repo, "old.txt"));

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
    expect(existsSync(join(repo, "app.txt"))).toBe(true);

    expect(cli("reset", "T1").code).toBe(0);
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(existsSync(join(repo, "notes.txt"))).toBe(true);
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
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("tetap\n");
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(gitOut("status", "--porcelain", "--untracked-files=no")).toBe("");

    // Izin git rm/mv diberitahukan ke Developer di system prompt.
    const args = calls("developer")[0].args;
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("- `git rm …`");

    expect(cli("resume", "T2").code).toBe(0);
    expect(existsSync(join(repo, "keep.txt"))).toBe(false);
    expect(existsSync(join(repo, "app.txt"))).toBe(true);
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
    repo = mkdtempSync(join(tmpdir(), "bondowoso-test-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "web"));
    writeFileSync(join(repo, "web", "package.json"), JSON.stringify({ scripts: { build: "x" }, devDependencies: { eslint: "^9" } }));
    scriptPath = join(repo, "..", `${repo.split("/").pop()}-script.json`);

    expect(cli("init").code).toBe(0);
    const config = parse(readFileSync(join(repo, ".bondowoso", "config.yaml"), "utf8"));
    expect(config.developer_bash).toEqual(
      expect.arrayContaining(["git status:*", "git diff:*", "git rm:*", "git mv:*", "npx eslint:*", "npm run:*"]),
    );
  });
});
