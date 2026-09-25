import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, type Config, type Ctx } from "../config.ts";
import { describeDenials, formatDenied, mergeDenied } from "../denials.ts";
import { formatGateFailures, gateLog, runGates } from "../gates.ts";
import * as git from "../git.ts";
import { log } from "../log.ts";
import { cleanCommitMessage, fallbackBranch } from "../naming.ts";
import { loadManifest, nextTask, record, saveManifest, type Manifest, type Task } from "../manifest.ts";
import { developerRequest, formatReview, reviewerRequest } from "../roles.ts";
import { RateLimitError, runAgent } from "../runner/claude.ts";
import { planHash, runDir } from "./plan.ts";

export const EXIT_RATE_LIMIT = 75;
const RATE_LIMIT_POLL_MS = 15 * 60_000;

const RESUMED_SUMMARY =
  "(Tidak ada Developer di percobaan ini: perubahan dipasang ulang dari patch percobaan sebelumnya lewat `bondowoso resume`, dan mungkin sudah diedit manusia.)";

interface WorkOptions {
  wait: boolean;
}

export async function work(ctx: Ctx, opts: WorkOptions): Promise<number> {
  const config = loadConfig(ctx);
  const manifest = loadManifest(ctx);
  if (!manifest.plan_hash || manifest.tasks.length === 0) {
    throw new Error("Rencana belum di-approve. Jalankan `bondowoso approve` dulu.");
  }
  if (planHash(ctx) !== manifest.plan_hash) {
    throw new Error("plan.md berubah setelah approve. Jalankan `bondowoso approve --force` supaya tugas dipecah ulang.");
  }
  const plan = readFileSync(ctx.planPath, "utf8");
  const { root } = ctx;
  const resumed = manifest.tasks.find((t) => t.status === "resumed");

  if (manifest.branch && git.currentBranch(root) !== manifest.branch) {
    if (resumed) {
      throw new Error(`${resumed.id} sedang di-resume di branch ${manifest.branch}. Pindah dulu ke branch itu.`);
    }
    assertClean(root);
    git.switchBranch(root, manifest.branch, false);
    log.info(`Pindah ke branch ${manifest.branch}`);
  }
  recoverInterrupted(ctx, manifest);
  // Tugas yang di-resume memang membawa perubahan di working tree.
  if (!resumed) assertClean(root);
  if (!manifest.branch) createBranch(ctx, manifest);

  if (!manifest.baseline_ok && !resumed) {
    log.step("Menjalankan gate pada kondisi awal (baseline)…");
    const results = runGates(root, config.gates);
    writeLog(ctx, manifest, "baseline-gates.log", gateLog(results));
    if (results.some((r) => !r.ok)) {
      throw new Error(
        `Gate sudah gagal sebelum ada perubahan apa pun. Perbaiki dulu, atau sesuaikan gates di config.yaml:\n\n${formatGateFailures(results, 40)}`,
      );
    }
    manifest.baseline_ok = true;
    saveManifest(ctx, manifest);
    log.ok("Baseline hijau");
  }

  for (;;) {
    const task = nextTask(manifest);
    if (!task) break;
    try {
      await runTask(ctx, config, manifest, task, plan);
    } catch (e) {
      // Apa pun yang memutus tugas di tengah jalan: simpan perubahannya sebagai
      // patch, bersihkan working tree, dan kembalikan tugas ke antrean tanpa
      // menghitung percobaan itu.
      discard(ctx, manifest, task);
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      if (!(e instanceof RateLimitError)) {
        saveManifest(ctx, manifest);
        throw e;
      }
      record(task, "rate_limit", task.attempts + 1, "paused", e.message.slice(0, 300));
      saveManifest(ctx, manifest);
      const resume = e.resetAt ? `, reset sekitar ${e.resetAt.toLocaleString("id-ID")}` : "";
      log.warn(`Kuota Max habis saat ${task.id}${resume}.`);
      if (!opts.wait) {
        log.info("Jalankan `bondowoso work` lagi nanti, atau `bondowoso work --wait` supaya menunggu sendiri.");
        return EXIT_RATE_LIMIT;
      }
      const waitMs = e.resetAt ? Math.max(60_000, e.resetAt.getTime() - Date.now() + 60_000) : RATE_LIMIT_POLL_MS;
      log.info(`Menunggu ${Math.round(waitMs / 60_000)} menit…`);
      await sleep(waitMs);
    }
  }

  return summarize(manifest);
}

// Pasang lagi patch percobaan terakhir sebuah tugas ke working tree, supaya
// manusia bisa menambal bagian yang tidak bisa dikerjakan agent lalu
// melanjutkan dengan `bondowoso work` (gate → Reviewer → commit).
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
  record(task, "resume", 0, "applied", task.last_patch);
  saveManifest(ctx, manifest);

  log.ok(`Patch ${id} dipasang ke working tree (${task.last_patch}).`);
  log.info("Tambal manual kalau perlu, lalu jalankan `bondowoso work`: gate → Reviewer → commit.");
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
  manifest.base_commit = git.head(ctx.root);
  git.switchBranch(ctx.root, name, true);
  manifest.branch = name;
  saveManifest(ctx, manifest);
  log.ok(`Branch baru ${name} dari ${manifest.base_commit.slice(0, 7)}`);
}

// Tugas yang masih in_progress berarti proses sebelumnya terputus (Ctrl+C,
// crash, laptop mati). Kalau commit-nya sempat dibuat (HEAD tepat satu commit
// di atas commit_base), tandai selesai; kalau belum, simpan sisa perubahannya
// sebagai patch lalu bersihkan.
function recoverInterrupted(ctx: Ctx, manifest: Manifest): void {
  for (const task of manifest.tasks.filter((t) => t.status === "in_progress")) {
    const head = git.head(ctx.root);
    if (task.commit_base && head !== task.commit_base && git.parentOf(ctx.root, head) === task.commit_base) {
      delete task.commit_base;
      task.status = "done";
      task.commit = git.head(ctx.root).slice(0, 7);
      log.info(`${task.id} ternyata sudah ter-commit sebelum terputus`);
    } else {
      task.untracked_before ??= git.workingState(ctx.root).untracked;
      discard(ctx, manifest, task);
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      record(task, "rollback", task.attempts + 1, "interrupted");
      log.warn(`${task.id} terputus sebelumnya; working tree dibersihkan`);
    }
    saveManifest(ctx, manifest);
  }
}

async function runTask(ctx: Ctx, config: Config, manifest: Manifest, task: Task, plan: string): Promise<void> {
  const { root } = ctx;
  const max = config.limits.max_attempts;
  // Tugas hasil `resume` langsung ke gate + Reviewer; Developer baru dipanggil
  // kalau salah satunya menolak.
  let skipDeveloper = task.status === "resumed";
  if (!skipDeveloper) task.untracked_before = git.workingState(root).untracked;
  task.status = "in_progress";
  saveManifest(ctx, manifest);
  log.step(`${task.id}: ${task.title}${skipDeveloper ? " (lanjutan dari resume)" : ""}`);

  while (task.attempts < max) {
    task.attempts++;
    const n = task.attempts;
    saveManifest(ctx, manifest);

    let summary: string;
    if (skipDeveloper) {
      skipDeveloper = false;
      summary = RESUMED_SUMMARY;
      record(task, "resume", n, "skip-developer");
    } else {
      log.step(`${task.id} percobaan ${n}/${max}: Developer (${config.roles.developer.model}) bekerja…`);
      const dev = await runAgent(
        developerRequest(ctx, config, manifest, task, plan, task.feedback ?? "", logPath(ctx, manifest, task, "developer", n, "json")),
      );
      summary = dev.output.summary;
      if (dev.output.commit_message.trim()) task.commit_message = dev.output.commit_message;
      const denied = describeDenials(dev.denials);
      if (denied.length) {
        task.denied = mergeDenied(task.denied, denied);
        log.warn(`${task.id}: ${denied.length} aksi ditolak permission (lihat \`bondowoso status\`)`);
      }
      record(task, "developer", n, dev.output.status, denied.length ? `${denied.length} aksi ditolak` : undefined);

      if (dev.output.status === "blocked") {
        block(ctx, manifest, task, `Developer: ${dev.output.blocked_reason || dev.output.summary}`);
        return;
      }
    }

    log.step(`${task.id}: menjalankan gate…`);
    const gates = runGates(root, config.gates);
    writeFileSync(logPath(ctx, manifest, task, "gates", n, "log"), gateLog(gates));
    const failed = gates.filter((g) => !g.ok);
    record(task, "gates", n, failed.length ? "fail" : "pass", failed.map((g) => g.name).join(", ") || undefined);
    if (failed.length) {
      task.feedback = formatGateFailures(gates, config.limits.gate_output_tail);
      saveManifest(ctx, manifest);
      log.warn(`${task.id}: gate gagal (${failed.map((g) => g.name).join(", ")})`);
      continue;
    }

    log.step(`${task.id}: Reviewer (${config.roles.reviewer.model}) memeriksa…`);
    const diff = git.taskDiff(root, task.untracked_before ?? []);
    const review = await runAgent(
      reviewerRequest(ctx, config, manifest, task, summary, diff, logPath(ctx, manifest, task, "reviewer", n, "json")),
    );
    record(task, "reviewer", n, review.output.verdict, review.output.issues.length ? `${review.output.issues.length} issue` : undefined);

    if (review.output.verdict === "request_changes") {
      task.feedback = formatReview(review.output);
      saveManifest(ctx, manifest);
      log.warn(`${task.id}: Reviewer meminta perubahan (${review.output.issues.length} issue)`);
      continue;
    }

    task.commit_base = git.head(root);
    saveManifest(ctx, manifest);
    const commit = git.commitTask(root, task.untracked_before ?? [], cleanCommitMessage(task.commit_message, task.title));
    task.status = "done";
    task.commit = commit;
    delete task.feedback;
    delete task.commit_base;
    record(task, "commit", n, commit ?? "no-changes");
    saveManifest(ctx, manifest);
    log.ok(`${task.id} selesai${commit ? ` (commit ${commit})` : " (tanpa perubahan)"}`);
    return;
  }

  block(ctx, manifest, task, `Gagal setelah ${max} percobaan. Feedback terakhir:\n${task.feedback ?? "-"}`);
}

// Simpan perubahan tugas sebagai patch sebelum working tree dibersihkan, jadi
// hasil kerja agent tidak pernah hilang dan bisa dipasang lagi lewat `resume`.
function discard(ctx: Ctx, manifest: Manifest, task: Task): void {
  const before = task.untracked_before ?? git.workingState(ctx.root).untracked;
  const patch = git.taskDiff(ctx.root, before, { binary: true });
  if (patch.trim()) {
    const file = logPath(ctx, manifest, task, "attempt", Math.max(1, task.attempts), "patch");
    writeFileSync(file, patch);
    task.last_patch = relative(ctx.stateDir, file);
    log.info(`Perubahan ${task.id} disimpan di .bondowoso/${task.last_patch}`);
  }
  git.rollback(ctx.root, before);
}

function block(ctx: Ctx, manifest: Manifest, task: Task, reason: string): void {
  discard(ctx, manifest, task);
  task.status = "blocked";
  task.blocked_reason = reason;
  record(task, "rollback", task.attempts, "blocked");
  saveManifest(ctx, manifest);
  log.error(`${task.id} blocked: ${reason.split("\n")[0]}`);
  if (task.denied?.length) log.info(formatDenied(task.denied));
  if (task.last_patch) {
    log.info(`Lanjutkan dari hasil terakhir: \`bondowoso resume ${task.id}\`, atau ulang dari awal: \`bondowoso reset ${task.id}\`.`);
  }
}

function summarize(manifest: Manifest): number {
  const count = (s: Task["status"]) => manifest.tasks.filter((t) => t.status === s).length;
  const done = count("done");
  const blocked = count("blocked");
  const waiting = count("pending");
  if (blocked === 0 && waiting === 0) {
    log.ok(`Semua ${done} tugas selesai di branch ${manifest.branch}. Review lalu merge secara manual.`);
    return 0;
  }
  log.warn(`${done} selesai, ${blocked} blocked, ${waiting} tertahan karena dependensinya blocked.`);
  log.info("Lihat `bondowoso status`, lalu `bondowoso resume <id>` atau `bondowoso reset <id>`, dan `bondowoso work`.");
  return 2;
}

function logPath(ctx: Ctx, manifest: Manifest, task: Task, step: string, attempt: number, ext: string): string {
  const dir = runDir(ctx, manifest);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${task.id}-${step}-${attempt}.${ext}`);
}

function writeLog(ctx: Ctx, manifest: Manifest, name: string, content: string): void {
  const dir = runDir(ctx, manifest);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}
