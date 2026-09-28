import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, type Config, type Ctx } from "../config.ts";
import { formatDenied } from "../denials.ts";
import { formatGateFailures, gateLog, runGates } from "../gates.ts";
import * as git from "../git.ts";
import { releaseLocks } from "../hooks/checks.ts";
import { log } from "../log.ts";
import { loadManifest, record, saveManifest, type Manifest, type Task } from "../manifest.ts";
import { compactAndPromote, recall } from "../memory.ts";
import { fallbackBranch } from "../naming.ts";
import { RateLimitError } from "../runner/claude.ts";
import { loadSkills, type Skill } from "../skills.ts";
import { planHash, runDir } from "./plan.ts";
import { phasesFor, runTask, type RunMode } from "./task.ts";

export const EXIT_RATE_LIMIT = 75;
const RATE_LIMIT_POLL_MS = 15 * 60_000;
const MAX_CONFLICT_RETRIES = 1;

export interface WorkOptions {
  wait: boolean;
  task?: string; // hanya tugas ini (plus dependensinya yang masih pending)
  compact?: boolean; // berhenti setelah Implement + gate; fase lain ditunda
  full?: boolean; // jalankan fase yang ditunda oleh --compact
  parallel?: number;
}

interface Session {
  ctx: Ctx;
  config: Config;
  manifest: Manifest;
  plan: string;
  skills: Skill[];
  opts: WorkOptions;
  selected?: Set<string>;
  save: () => void;
}

export async function work(ctx: Ctx, opts: WorkOptions): Promise<number> {
  const config = loadConfig(ctx);
  const manifest = loadManifest(ctx);
  if (!manifest.plan_hash || manifest.tasks.length === 0) {
    throw new Error("Rencana belum di-approve. Jalankan `bondowoso approve` dulu.");
  }
  if (manifest.pending_append) {
    throw new Error("Ada tambahan rencana (`plan --append`) yang belum dipecah. Jalankan `bondowoso approve` dulu.");
  }
  if (planHash(ctx) !== manifest.plan_hash) {
    throw new Error("plan.md berubah setelah approve. Jalankan `bondowoso approve --force` supaya tugas dipecah ulang.");
  }
  const { root } = ctx;
  const resumed = manifest.tasks.find((t) => t.status === "resumed");

  if (manifest.branch && git.currentBranch(root) !== manifest.branch) {
    if (resumed) throw new Error(`${resumed.id} sedang di-resume di branch ${manifest.branch}. Pindah dulu ke branch itu.`);
    assertClean(root);
    git.switchBranch(root, manifest.branch, false);
    log.info(`Pindah ke branch ${manifest.branch}`);
  }
  recoverInterrupted(ctx, manifest);
  if (!resumed) assertClean(root);
  if (!manifest.branch) createBranch(ctx, manifest);

  if (!manifest.baseline_ok && !resumed) {
    log.step("Menjalankan gate pada kondisi awal (baseline)…");
    const results = runGates(root, config.gates);
    writeLog(ctx, manifest, "baseline-gates.log", gateLog(results));
    if (results.some((r) => !r.ok)) {
      throw new Error(`Gate sudah gagal sebelum ada perubahan apa pun. Perbaiki dulu, atau sesuaikan gates di config.yaml:\n\n${formatGateFailures(results, 40)}`);
    }
    manifest.baseline_ok = true;
    saveManifest(ctx, manifest);
    log.ok("Baseline hijau");
  }

  const s: Session = {
    ctx,
    config,
    manifest,
    plan: readFileSync(ctx.planPath, "utf8"),
    skills: loadSkills(ctx),
    opts,
    selected: opts.task ? withPendingDeps(manifest, opts.task) : undefined,
    save: () => saveManifest(ctx, manifest),
  };

  const parallel = Math.max(1, opts.parallel ?? config.parallel.max);
  const mode: RunMode = opts.compact ? "compact" : "normal";
  const code = parallel > 1 && !resumed ? await runParallel(s, mode, parallel) : await runSequential(s, mode);
  if (code !== 0) return code;

  if (opts.full) {
    const post = await runPostPass(s);
    if (post !== 0) return post;
  }
  return await finish(s);
}

// ---------------------------------------------------------------- berurutan

async function runSequential(s: Session, mode: RunMode): Promise<number> {
  for (;;) {
    const task = pick(s, new Set());
    if (!task) return 0;
    const result = await guarded(s, task, ctxExec(s, task), mode);
    if (result.kind === "rate_limit") {
      const code = await rateLimitPause(s, task, result.error);
      if (code !== 0) return code;
    }
  }
}

function ctxExec(s: Session, task: Task) {
  return { root: s.ctx.root, taskId: task.id };
}

type Guarded = { kind: "done" | "blocked" } | { kind: "rate_limit"; error: RateLimitError };

// Jalankan satu tugas di root tertentu; urus hasil, blocked, error dan rate limit.
async function guarded(s: Session, task: Task, exec: { root: string; taskId: string; locksDir?: string }, mode: RunMode): Promise<Guarded> {
  try {
    const outcome = await runTask({
      ctx: s.ctx,
      config: s.config,
      manifest: s.manifest,
      task,
      plan: s.plan,
      exec,
      skills: s.skills,
      memory: recall(s.ctx, s.config, `${task.title}\n${task.description}`, s.manifest.run_id),
      mode,
      save: s.save,
      logDir: runDir(s.ctx, s.manifest),
    });
    if (outcome.status === "blocked") {
      block(s, task, outcome.reason, exec.root);
      return { kind: "blocked" };
    }
    if (exec.root === s.ctx.root) {
      markDone(s, task, outcome.commit, mode);
    } else {
      task.status = "done"; // di mode paralel commit masih di worktree; pemanggil yang memasangnya
    }
    return { kind: "done" };
  } catch (e) {
    discard(s, task, exec.root);
    task.status = "pending";
    task.attempts = Math.max(0, task.attempts - 1);
    if (e instanceof RateLimitError) {
      record(task, "rate_limit", task.attempts + 1, "paused", e.message.slice(0, 300));
      s.save();
      return { kind: "rate_limit", error: e };
    }
    s.save();
    throw e;
  }
}

async function rateLimitPause(s: Session, task: Task | undefined, e: RateLimitError | undefined): Promise<number> {
  const resume = e?.resetAt ? `, reset sekitar ${e.resetAt.toLocaleString("id-ID")}` : "";
  log.warn(`Kuota Max habis${task ? ` saat ${task.id}` : ""}${resume}.`);
  if (!s.opts.wait) {
    log.info("Jalankan `bondowoso work` lagi nanti, atau `bondowoso work --wait` supaya menunggu sendiri.");
    return EXIT_RATE_LIMIT;
  }
  const waitMs = e?.resetAt ? Math.max(60_000, e.resetAt.getTime() - Date.now() + 60_000) : RATE_LIMIT_POLL_MS;
  log.info(`Menunggu ${Math.round(waitMs / 60_000)} menit…`);
  await sleep(waitMs);
  return 0;
}

function markDone(s: Session, task: Task, commit: string | undefined, mode: RunMode): void {
  if (mode === "post") {
    task.followup_commit = commit;
    delete task.deferred;
  } else {
    task.commit = commit;
    if (mode === "compact") {
      const full = phasesFor(s.config, s.manifest.scope, "normal");
      const deferred = (["simplify", "test", "review"] as const).filter((p) => full[p]);
      if (deferred.length) task.deferred = [...deferred];
    }
  }
  task.status = "done";
  s.save();
  const note = mode === "compact" && task.deferred?.length ? ` (ditunda: ${task.deferred.join(", ")})` : "";
  log.ok(`${task.id} selesai${commit ? ` (commit ${commit})` : " (tanpa perubahan)"}${note}`);
}

// ---------------------------------------------------------------- paralel

// Satu worktree per tugas di ~/.bondowoso/worktrees; tugas siap jalan bersamaan
// selama berkas yang diperkirakan (files_hint) tidak beririsan. Selama jalan,
// hook first-writer-wins mengunci berkas yang disentuh. Commit tiap tugas
// dipasang ke branch kerja secara berurutan dengan cherry-pick.
async function runParallel(s: Session, mode: RunMode, max: number): Promise<number> {
  const slug = repoSlug(s.ctx.root);
  const locksDir = join(bondowosoHome(), "locks", slug, s.manifest.run_id);
  const running = new Map<string, Promise<void>>();
  let stop: "rate_limit" | "error" | undefined;
  let error: unknown;
  let limitError: RateLimitError | undefined;
  let mergeQueue: Promise<unknown> = Promise.resolve();

  const start = (task: Task): Promise<void> => {
    const wt = join(bondowosoHome(), "worktrees", slug, s.manifest.run_id, task.id);
    git.addWorktree(s.ctx.root, wt, "HEAD");
    const base = git.head(wt);
    linkPaths(s.ctx.root, wt, s.config.parallel.link);
    task.worktree = wt;
    s.save();
    log.info(`${task.id}: dikerjakan paralel di ${wt}`);
    return (async () => {
      try {
        const result = await guarded(s, task, { root: wt, taskId: task.id, locksDir }, mode);
        if (result.kind === "rate_limit") {
          stop ??= "rate_limit";
          limitError = result.error;
        }
        if (result.kind === "done") {
          const head = git.head(wt);
          const sha = head !== base ? head : undefined;
          // Commit dipasang satu per satu supaya cherry-pick tidak saling tabrak.
          mergeQueue = mergeQueue.then(() => merge(s, task, wt, sha, mode));
          await mergeQueue;
        }
      } catch (e) {
        stop = "error";
        error ??= e;
      } finally {
        releaseLocks(locksDir, task.id);
        git.removeWorktree(s.ctx.root, wt);
        delete task.worktree;
        s.save();
      }
    })();
  };

  for (;;) {
    while (!stop && running.size < max) {
      const task = pick(s, new Set(running.keys()));
      if (!task) break;
      running.set(task.id, start(task).finally(() => running.delete(task.id)));
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  removeEmptyDirs(join(bondowosoHome(), "worktrees", slug, s.manifest.run_id), join(bondowosoHome(), "worktrees", slug));
  removeEmptyDirs(locksDir, join(bondowosoHome(), "locks", slug));
  if (stop === "error") throw error;
  if (stop === "rate_limit") {
    // Tugas lain yang masih jalan dibiarkan selesai dulu; baru jeda lalu lanjut.
    const code = await rateLimitPause(s, undefined, limitError);
    return code !== 0 ? code : runParallel(s, mode, max);
  }
  return 0;
}

async function merge(s: Session, task: Task, wt: string, sha: string | undefined, mode: RunMode): Promise<void> {
  if (!sha) {
    markDone(s, task, undefined, mode);
    return;
  }
  if (git.cherryPick(s.ctx.root, sha)) {
    markDone(s, task, git.head(s.ctx.root).slice(0, 7), mode);
    return;
  }
  // Bentrok dengan tugas lain yang lebih dulu masuk: simpan hasilnya sebagai
  // patch, lalu ulang sekali dari HEAD terbaru sebelum menyerah.
  const file = logPath(s, task, "conflict", task.attempts, "patch");
  writeFileSync(file, git.commitPatch(wt, sha));
  task.last_patch = relative(s.ctx.stateDir, file);
  const retries = task.history.filter((h) => h.step === "commit" && h.result === "conflict").length;
  record(task, "commit", task.attempts, "conflict");
  if (retries < MAX_CONFLICT_RETRIES) {
    task.status = "pending";
    task.attempts = 0;
    delete task.feedback_loop;
    log.warn(`${task.id}: bentrok saat digabung ke branch kerja; diulang dari HEAD terbaru`);
  } else {
    task.status = "blocked";
    task.blocked_reason = "Bentrok berulang saat menggabungkan hasil ke branch kerja. Patch tersimpan; lanjutkan dengan `bondowoso resume`.";
    log.error(`${task.id} blocked: bentrok berulang saat merge`);
  }
  s.save();
}

function linkPaths(root: string, wt: string, paths: string[]): void {
  for (const p of paths) {
    const src = join(root, p);
    const dst = join(wt, p);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
  }
}

// Worktree dan kunci paralel disimpan di luar repo (seperti centralized
// worktrees Jonggrang), supaya Grep/Glob agent di root tidak ikut menyisir.
function bondowosoHome(): string {
  return process.env.BONDOWOSO_HOME ?? join(homedir(), ".bondowoso");
}

// Hapus folder run (dan induknya) kalau sudah kosong setelah semua worktree dilepas.
function removeEmptyDirs(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // folder dipakai run lain; biarkan
    }
  }
}

function repoSlug(root: string): string {
  return `${basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

// ---------------------------------------------------------------- fase susulan

async function runPostPass(s: Session): Promise<number> {
  const deferred = s.manifest.tasks.filter((t) => t.status === "done" && t.deferred?.length && (!s.selected || s.selected.has(t.id)));
  if (!deferred.length) {
    log.info("Tidak ada fase yang ditunda.");
    return 0;
  }
  assertClean(s.ctx.root);
  log.step(`Menjalankan fase yang ditunda untuk ${deferred.map((t) => t.id).join(", ")}…`);
  for (const task of deferred) {
    task.attempts = 0;
    delete task.feedback_loop;
    const result = await guarded(s, task, ctxExec(s, task), "post");
    if (result.kind === "rate_limit") {
      task.status = "done"; // kode aslinya sudah ter-commit; fase susulan diulang nanti
      s.save();
      return rateLimitPause(s, task, result.error);
    }
    if (result.kind === "blocked") {
      // Kode tugas sudah ter-commit; yang gagal hanya fase susulannya.
      task.status = "done";
      s.save();
    }
  }
  return 0;
}

// ---------------------------------------------------------------- pemilihan tugas

function withPendingDeps(manifest: Manifest, id: string): Set<string> {
  const byId = new Map(manifest.tasks.map((t) => [t.id, t]));
  if (!byId.has(id)) throw new Error(`Tugas ${id} tidak ada.`);
  const out = new Set<string>();
  const visit = (tid: string) => {
    const t = byId.get(tid);
    if (!t || out.has(tid)) return;
    out.add(tid);
    for (const d of t.depends_on) if (byId.get(d)?.status !== "done") visit(d);
  };
  visit(id);
  return out;
}

function pick(s: Session, running: Set<string>): Task | undefined {
  const { manifest, selected } = s;
  const resumed = manifest.tasks.find((t) => t.status === "resumed");
  if (resumed) return resumed;
  const done = new Set(manifest.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const busy = manifest.tasks.filter((t) => running.has(t.id));
  const claimed = new Set(busy.flatMap((t) => t.files_hint));
  return manifest.tasks.find(
    (t) =>
      t.status === "pending" &&
      !running.has(t.id) &&
      (!selected || selected.has(t.id)) &&
      t.depends_on.every((d) => done.has(d)) &&
      !t.files_hint.some((f) => claimed.has(f)),
  );
}

// ---------------------------------------------------------------- akhir run

async function finish(s: Session): Promise<number> {
  const { manifest } = s;
  const count = (st: Task["status"]) => manifest.tasks.filter((t) => t.status === st).length;
  const done = count("done");
  const blocked = count("blocked");
  const waiting = count("pending");
  const deferred = manifest.tasks.filter((t) => t.deferred?.length).length;
  if (blocked === 0 && waiting === 0) {
    log.ok(`Semua ${done} tugas selesai di branch ${manifest.branch}. Review lalu merge secara manual.`);
    if (deferred) log.info(`${deferred} tugas punya fase yang ditunda; jalankan \`bondowoso work --full\`.`);
    if (!manifest.memory_done && !deferred) {
      await compactAndPromote(s.ctx, s.config, manifest, runDir(s.ctx, manifest), { promote: s.config.memory.auto_promote });
      manifest.memory_done = true;
      s.save();
    }
    return 0;
  }
  if (s.selected && [...s.selected].every((id) => manifest.tasks.find((t) => t.id === id)?.status === "done")) {
    log.ok(`${[...s.selected].join(", ")} selesai.`);
    return 0;
  }
  log.warn(`${done} selesai, ${blocked} blocked, ${waiting} tertahan karena dependensinya blocked.`);
  log.info("Lihat `bondowoso status`, lalu `bondowoso resume <id>` atau `bondowoso reset <id>`, dan `bondowoso work`.");
  return 2;
}

// ---------------------------------------------------------------- resume & utilitas

// Pasang lagi patch percobaan terakhir sebuah tugas ke working tree, supaya
// manusia bisa menambal bagian yang tidak bisa dikerjakan agent lalu
// melanjutkan dengan `bondowoso work` (gate → Test → Review → commit).
export function resume(ctx: Ctx, id: string): void {
  const manifest = loadManifest(ctx);
  const task = manifest.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Tugas ${id} tidak ada.`);
  if (task.status !== "blocked" && task.status !== "pending") {
    throw new Error(`${id} berstatus ${task.status}; hanya tugas blocked atau pending yang bisa di-resume.`);
  }
  if (!task.last_patch) {
    throw new Error(`Tidak ada patch tersimpan untuk ${id}. Pakai \`bondowoso reset ${id}\` untuk mengulang dari awal.`);
  }
  const other = manifest.tasks.find((t) => t.status === "resumed");
  if (other) throw new Error(`${other.id} sudah di-resume dan belum selesai. Jalankan \`bondowoso work\` dulu.`);
  const done = new Set(manifest.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const missing = task.depends_on.filter((d) => !done.has(d));
  if (missing.length) throw new Error(`${id} masih menunggu ${missing.join(", ")}.`);

  const { root } = ctx;
  if (manifest.branch && git.currentBranch(root) !== manifest.branch) {
    assertClean(root);
    git.switchBranch(root, manifest.branch, false);
  }
  assertClean(root);
  task.untracked_before = git.workingState(root).untracked;
  const patch = join(ctx.stateDir, task.last_patch);
  try {
    git.applyPatch(root, patch);
  } catch (e) {
    throw new Error(
      `Patch ${task.last_patch} tidak bisa dipasang, mungkin bentrok dengan commit yang lebih baru.\n${(e as Error).message}\nPakai \`bondowoso reset ${id}\` untuk mengulang dari awal.`,
    );
  }

  const why = task.blocked_reason ?? "terputus sebelum selesai";
  task.feedback = `Percobaan sebelumnya berhenti: ${why}\nPerubahannya sudah dipasang lagi di working tree dan mungkin sudah diedit manusia; lanjutkan dari sana.`;
  task.status = "resumed";
  task.attempts = 0;
  delete task.blocked_reason;
  delete task.feedback_loop;
  record(task, "resume", 0, "applied", task.last_patch);
  saveManifest(ctx, manifest);

  log.ok(`Patch ${id} dipasang ke working tree (${task.last_patch}).`);
  log.info("Tambal manual kalau perlu, lalu jalankan `bondowoso work`: gate → Test → Review → commit.");
}

function assertClean(root: string): void {
  const { tracked } = git.workingState(root);
  if (tracked.length > 0) {
    throw new Error(`Ada perubahan yang belum di-commit:\n${tracked.map((f) => `  ${f}`).join("\n")}\nCommit atau stash dulu.`);
  }
}

function createBranch(ctx: Ctx, manifest: Manifest): void {
  const base = manifest.branch_name ?? fallbackBranch(manifest.request);
  let name = base;
  for (let i = 2; git.branchExists(ctx.root, name); i++) name = `${base}-${i}`;
  const start = manifest.base_ref;
  git.switchBranch(ctx.root, name, true, start);
  manifest.base_commit = git.head(ctx.root);
  manifest.branch = name;
  saveManifest(ctx, manifest);
  log.ok(`Branch baru ${name} dari ${start ?? "HEAD"} (${manifest.base_commit.slice(0, 7)})`);
}

// Tugas yang masih in_progress berarti proses sebelumnya terputus (Ctrl+C,
// crash, laptop mati). Kalau commit-nya sempat dibuat (HEAD tepat satu commit
// di atas commit_base), tandai selesai; kalau belum, simpan sisa perubahannya
// sebagai patch lalu bersihkan. Worktree paralel yang tertinggal ikut dibereskan.
function recoverInterrupted(ctx: Ctx, manifest: Manifest): void {
  const s = { ctx, manifest, save: () => saveManifest(ctx, manifest) };
  for (const task of manifest.tasks.filter((t) => t.status === "in_progress")) {
    if (task.worktree) {
      if (existsSync(task.worktree)) {
        discard(s, task, task.worktree);
        git.removeWorktree(ctx.root, task.worktree);
      }
      delete task.worktree;
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      record(task, "rollback", task.attempts + 1, "interrupted");
      log.warn(`${task.id} (paralel) terputus sebelumnya; worktree dibereskan`);
      s.save();
      continue;
    }
    const head = git.head(ctx.root);
    if (task.commit_base && head !== task.commit_base && git.parentOf(ctx.root, head) === task.commit_base) {
      delete task.commit_base;
      task.status = "done";
      task.commit = head.slice(0, 7);
      log.info(`${task.id} ternyata sudah ter-commit sebelum terputus`);
    } else {
      task.untracked_before ??= git.workingState(ctx.root).untracked;
      discard(s, task, ctx.root);
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      record(task, "rollback", task.attempts + 1, "interrupted");
      log.warn(`${task.id} terputus sebelumnya; working tree dibersihkan`);
    }
    s.save();
  }
}

// Simpan perubahan tugas sebagai patch sebelum working tree dibersihkan, jadi
// hasil kerja agent tidak pernah hilang dan bisa dipasang lagi lewat `resume`.
function discard(s: Pick<Session, "ctx" | "manifest">, task: Task, root: string): void {
  const before = root === s.ctx.root ? (task.untracked_before ?? git.workingState(root).untracked) : (task.untracked_before ?? []);
  const patch = git.taskDiff(root, before, { binary: true });
  if (patch.trim()) {
    const file = logPath(s, task, "attempt", Math.max(1, task.attempts), "patch");
    writeFileSync(file, patch);
    task.last_patch = relative(s.ctx.stateDir, file);
    log.info(`Perubahan ${task.id} disimpan di .bondowoso/${task.last_patch}`);
  }
  git.rollback(root, before);
}

function block(s: Session, task: Task, reason: string, root: string): void {
  discard(s, task, root);
  task.status = "blocked";
  task.blocked_reason = reason;
  record(task, "rollback", task.attempts, "blocked");
  s.save();
  log.error(`${task.id} blocked: ${reason.split("\n")[0]}`);
  if (task.denied?.length) log.info(formatDenied(task.denied));
  if (task.last_patch) {
    log.info(`Lanjutkan dari hasil terakhir: \`bondowoso resume ${task.id}\`, atau ulang dari awal: \`bondowoso reset ${task.id}\`.`);
  }
}

function logPath(s: Pick<Session, "ctx" | "manifest">, task: Task, step: string, attempt: number, ext: string): string {
  const dir = runDir(s.ctx, s.manifest);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${task.id}-${step}-${attempt}.${ext}`);
}

function writeLog(ctx: Ctx, manifest: Manifest, name: string, content: string): void {
  const dir = runDir(ctx, manifest);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

