import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function switchBranch(root: string, name: string, create: boolean, startPoint?: string): void {
  git(root, create ? ["switch", "-q", "-c", name, ...(startPoint ? [startPoint] : [])] : ["switch", "-q", name]);
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

// Semua path yang berubah dibanding HEAD selama tugas: tracked (termasuk yang
// dihapus/dipindah) plus berkas baru.
export function changedFiles(root: string, untrackedBefore: string[]): string[] {
  const state = workingState(root);
  return [...new Set([...state.tracked, ...newFiles(root, untrackedBefore)])].sort();
}

// Isi berkas yang sedang berubah; null berarti berkas tidak ada di disk.
export type Snapshot = Map<string, Buffer | null>;

export function snapshot(root: string, untrackedBefore: string[]): Snapshot {
  const snap: Snapshot = new Map();
  for (const f of changedFiles(root, untrackedBefore)) {
    const abs = join(root, f);
    snap.set(f, existsSync(abs) ? readFileSync(abs) : null);
  }
  return snap;
}

function isInHead(root: string, path: string): boolean {
  return run(root, ["cat-file", "-e", `HEAD:${path}`]).code === 0;
}

function restorePath(root: string, path: string, content: Buffer | null | undefined): void {
  const abs = join(root, path);
  run(root, ["reset", "-q", "--", path]);
  if (content === undefined) {
    // Sebelumnya tidak berubah: kembalikan ke HEAD, atau hapus kalau berkas baru.
    if (isInHead(root, path)) git(root, ["checkout", "-q", "HEAD", "--", path]);
    else rmSync(abs, { force: true });
  } else if (content === null) {
    rmSync(abs, { force: true });
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

// Kembalikan ke kondisi snapshot setiap berkas yang diubah sejak snapshot
// diambil dan tidak lolos `allowed`. Mengembalikan daftar path yang dipulihkan.
export function restoreOutside(root: string, snap: Snapshot, untrackedBefore: string[], allowed: (path: string) => boolean): string[] {
  const restored: string[] = [];
  const candidates = new Set([...changedFiles(root, untrackedBefore), ...snap.keys()]);
  // Kandidat di luar snapshot pasti sedang berubah, jadi `before === undefined`
  // berarti "kembalikan ke HEAD".
  for (const f of candidates) {
    if (allowed(f)) continue;
    const abs = join(root, f);
    const now = existsSync(abs) ? readFileSync(abs) : null;
    const before = snap.has(f) ? snap.get(f)! : undefined;
    const same = before === undefined ? false : before === null ? now === null : now !== null && before.equals(now);
    if (same) continue;
    restorePath(root, f, before);
    restored.push(f);
  }
  return restored.sort();
}

// Diff sebuah commit lama digabung dengan perubahan working tree di berkas
// yang sama; dipakai fase susulan (`work --full`) untuk tugas yang sudah commit.
export function commitFilesDiff(root: string, commit: string): { files: string[]; diff: string } {
  const files = git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split("\n").filter(Boolean);
  const diff = files.length ? run(root, ["diff", `${commit}^`, "--", ...files]).stdout : "";
  return { files, diff };
}

// ---------------------------------------------------------------- worktree

export function addWorktree(root: string, path: string, rev: string): void {
  run(root, ["worktree", "prune"]);
  if (existsSync(path)) {
    run(root, ["worktree", "remove", "--force", path]);
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(dirname(path), { recursive: true });
  git(root, ["worktree", "add", "--detach", "-q", path, rev]);
}

export function removeWorktree(root: string, path: string): void {
  run(root, ["worktree", "remove", "--force", path]);
  rmSync(path, { recursive: true, force: true });
  run(root, ["worktree", "prune"]);
}

// Pasang commit dari worktree ke branch kerja. Bentrok → batalkan, kembalikan false.
export function cherryPick(root: string, sha: string): boolean {
  if (run(root, ["cherry-pick", sha]).code === 0) return true;
  run(root, ["cherry-pick", "--abort"]);
  return false;
}

export function commitPatch(root: string, sha: string): string {
  return git(root, ["format-patch", "--stdout", "--binary", "-1", sha]);
}
