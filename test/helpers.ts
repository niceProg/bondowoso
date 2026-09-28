import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FAKE = join(ROOT, "test", "fake-claude.ts");

export const PLAN = {
  scope: "small",
  summary: "Ringkasan.",
  plan_markdown: "## Langkah\n\n- ubah app.txt",
  open_questions: [],
  branch_name: "feat/tambah-fitur-app",
};
export const task = (id: string, depends_on: string[] = []) => ({
  id,
  title: `Tugas ${id}`,
  description: "Kerjakan.",
  acceptance: ["app.txt berisi good"],
  files_hint: ["app.txt"],
  depends_on,
  skills: [] as string[],
});
export const dev = (write: Record<string, string>, commit_message = "feat: ubah file") => ({
  write,
  output: { status: "done", summary: "Ubah file.", blocked_reason: "", commit_message, lessons: [] as string[] },
});
export const approveReview = { output: { verdict: "approve", summary: "Oke.", issues: [], lessons: [] } };
export const rejectReview = {
  output: {
    verdict: "request_changes",
    summary: "Kurang.",
    issues: [{ file: "app.txt", line: 1, severity: "major", message: "tambahkan baris fixed" }],
    lessons: [],
  },
};

export const h = { repo: "", scriptPath: "" };

export interface SetupExtra {
  files?: Record<string, string>; // file tracked tambahan di commit awal
  developer_bash?: string[];
  config?: Record<string, unknown>; // bagian config yang ditimpa
}

export function setup(script: Record<string, unknown[]>, limits: Record<string, number> = {}, extra: SetupExtra = {}): void {
  h.repo = mkdtempSync(join(tmpdir(), "bondowoso-test-"));
  const g = (...args: string[]) => spawnSync("git", args, { cwd: h.repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(h.repo, "README.md"), "# h.repo\n");
  for (const [path, content] of Object.entries(extra.files ?? {})) writeFileSync(join(h.repo, path), content);
  g("add", ".");
  g("commit", "-q", "-m", "awal");
  // File untracked milik user: tidak boleh dihapus atau ikut ter-commit.
  writeFileSync(join(h.repo, "notes.txt"), "catatan pribadi\n");

  mkdirSync(join(h.repo, ".bondowoso"));
  writeFileSync(
    join(h.repo, ".bondowoso", ".gitignore"),
    "*\n!.gitignore\n!config.yaml\n",
  );
  writeFileSync(
    join(h.repo, ".bondowoso", "config.yaml"),
    stringify({
      gates: [{ name: "app", run: "test ! -f app.txt || grep -q '^good' app.txt" }],
      roles: {
        lead: { model: "fake", effort: "high" },
        developer: { model: "fake", effort: "xhigh" },
        reviewer: { model: "fake", effort: "medium" },
      },
      limits,
      developer_bash: extra.developer_bash ?? [],
      // Bawaan test: pipeline versi pendek dan tanpa memory, kecuali test yang
      // memang mengujinya menimpa bagian ini.
      pipeline: { simplify: false, test: false },
      memory: { enabled: false },
      ...extra.config,
    }),
  );
  h.scriptPath = join(h.repo, "..", `${h.repo.split("/").pop()}-script.json`);
  writeFileSync(h.scriptPath, JSON.stringify(script));
}

export function cli(...args: string[]): { code: number; out: string } {
  const r = spawnSync("node", [CLI, "-C", h.repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, BONDOWOSO_CLAUDE_BIN: FAKE, BONDOWOSO_FAKE_SCRIPT: h.scriptPath, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}

export function manifest(): any {
  return parse(readFileSync(join(h.repo, ".bondowoso", "manifest.yaml"), "utf8"));
}

export function calls(role: string): { prompt: string; args: string[] }[] {
  return readFileSync(`${h.scriptPath}.calls.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((c) => c.role === role);
}

export function gitLog(): string[] {
  return spawnSync("git", ["log", "--format=%s"], { cwd: h.repo, encoding: "utf8" }).stdout.trim().split("\n");
}

export function committedFiles(): string[] {
  return spawnSync("git", ["ls-files"], { cwd: h.repo, encoding: "utf8" }).stdout.trim().split("\n");
}

export function cleanup(): void {
  if (h.repo) rmSync(h.repo, { recursive: true, force: true });
  if (h.scriptPath) {
    const dir = join(h.scriptPath, "..");
    const base = h.scriptPath.split("/").pop()!;
    for (const f of readdirSync(dir)) if (f.startsWith(base)) rmSync(join(dir, f), { force: true });
  }
}

export function gitOut(...args: string[]): string {
  return spawnSync("git", args, { cwd: h.repo, encoding: "utf8" }).stdout.trim();
}


export const blockedDev = (reason: string, extra: Record<string, unknown> = {}) => ({
  ...extra,
  output: { status: "blocked", summary: "Sebagian selesai.", blocked_reason: reason, commit_message: "feat: tambah app dan hapus old", lessons: [] },
});
