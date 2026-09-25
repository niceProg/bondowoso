import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(root: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function git(root: string, args: string[]): string {
  const r = run(root, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} gagal:\n${r.stderr.trim()}`);
  return r.stdout;
}

export function repoRoot(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cwd} bukan repositori git.`);
  return r.stdout.trim();
}

export interface WorkingState {
  tracked: string[]; // file tracked yang berubah/terhapus/ter-stage
  untracked: string[];
  stagedDeletions: string[]; // sudah hilang dari index, mis. hasil `git rm`
}

const isState = (p: string): boolean => p === STATE_DIR || p.startsWith(`${STATE_DIR}/`);

export function workingState(root: string): WorkingState {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = out.split("\0").filter(Boolean);
  const tracked: string[] = [];
  const untracked: string[] = [];
  const stagedDeletions: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    // Rename/copy menyertakan path asal sebagai entri berikutnya.
    if (code[0] === "R" || code[0] === "C") i++;
    if (isState(path)) continue;
    (code === "??" ? untracked : tracked).push(path);
    if (code[0] === "D") stagedDeletions.push(path);
  }
  return { tracked, untracked, stagedDeletions };
}

export function head(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export function currentBranch(root: string): string {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export function branchExists(root: string, name: string): boolean {
  return run(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).code === 0;
}

export function switchBranch(root: string, name: string, create: boolean): void {
  git(root, create ? ["switch", "-q", "-c", name] : ["switch", "-q", name]);
}

export function newFiles(root: string, untrackedBefore: string[]): string[] {
  const before = new Set(untrackedBefore);
  return workingState(root).untracked.filter((p) => !before.has(p));
}

// Diff perubahan tugas: file tracked + file baru (untracked yang belum ada
// sebelum tugas dimulai). File untracked milik user tidak ikut.
// `binary: true` menghasilkan patch yang bisa dipasang ulang dengan `git apply`.
export function taskDiff(root: string, untrackedBefore: string[], opts: { binary?: boolean } = {}): string {
  const flags = opts.binary ? ["--binary"] : [];
  const parts = [git(root, ["diff", ...flags, "HEAD", "--", ".", `:(exclude)${STATE_DIR}`])];
  for (const file of newFiles(root, untrackedBefore)) {
    // --no-index keluar dengan kode 1 bila ada perbedaan, jadi pakai run().
    parts.push(run(root, ["diff", ...flags, "--no-index", "--", "/dev/null", file]).stdout);
  }
  return parts.filter(Boolean).join(opts.binary ? "" : "\n");
}

export function applyPatch(root: string, patchPath: string): void {
  git(root, ["apply", "--binary", "--whitespace=nowarn", patchPath]);
}

export function commitTask(root: string, untrackedBefore: string[], message: string): string | undefined {
  const state = workingState(root);
  const files = [...state.tracked, ...newFiles(root, untrackedBefore)];
  if (files.length === 0) return undefined;
  // Penghapusan yang sudah ter-stage tidak punya pathspec lagi; `git add`
  // akan gagal kalau path itu disebut.
  const staged = new Set(state.stagedDeletions);
  const toAdd = files.filter((f) => !staged.has(f));
  if (toAdd.length > 0) git(root, ["add", "-A", "--", ...toAdd]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "--short", "HEAD"]).trim();
}

// Kembalikan working tree ke HEAD, tapi hanya menghapus file untracked yang
// muncul setelah tugas dimulai. File untracked milik user tidak disentuh.
export function rollback(root: string, untrackedBefore: string[]): void {
  git(root, ["reset", "-q"]);
  const { tracked } = workingState(root);
  if (tracked.length > 0) git(root, ["checkout", "-q", "HEAD", "--", ...tracked]);
  for (const file of newFiles(root, untrackedBefore)) rmSync(join(root, file), { force: true });
}

export function parentOf(root: string, rev: string): string | undefined {
  const r = run(root, ["rev-parse", "--verify", "--quiet", `${rev}^`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export function recentSubjects(root: string, count: number): string[] {
  const r = run(root, ["log", `-${count}`, "--no-merges", "--format=%s"]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export function branchNames(root: string, count: number): string[] {
  const out = git(root, ["for-each-ref", "--sort=-committerdate", `--count=${count}`, "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  return out.split("\n").filter((b) => b && !b.endsWith("/HEAD"));
}

export function isValidBranchName(root: string, name: string): boolean {
  return run(root, ["check-ref-format", "--branch", name]).code === 0;
}
