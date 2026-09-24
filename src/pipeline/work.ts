import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, type Config, type Ctx } from "../config.ts";
import { formatGateFailures, gateLog, runGates } from "../gates.ts";
import * as git from "../git.ts";
import { log } from "../log.ts";
import { loadManifest, nextTask, record, saveManifest, type Manifest, type Task } from "../manifest.ts";
import { developerRequest, formatReview, reviewerRequest } from "../roles.ts";
import { RateLimitError, runAgent } from "../runner/claude.ts";
import { planHash, runDir } from "./plan.ts";

export const EXIT_RATE_LIMIT = 75;
const RATE_LIMIT_POLL_MS = 15 * 60_000;

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

  if (manifest.branch && git.currentBranch(root) !== manifest.branch) {
    assertClean(root);
    git.switchBranch(root, manifest.branch, false);
    log.info(`Pindah ke branch ${manifest.branch}`);
  }
  recoverInterrupted(ctx, manifest);
  assertClean(root);
  if (!manifest.branch) createBranch(ctx, config, manifest);

  if (!manifest.baseline_ok) {
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
      // Apa pun yang memutus tugas di tengah jalan: buang perubahan setengah
      // jadi dan kembalikan tugas ke antrean tanpa menghitung percobaan itu.
      git.rollback(root, task.untracked_before ?? []);
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

function assertClean(root: string): void {
  const { tracked } = git.workingState(root);
  if (tracked.length > 0) {
    throw new Error(`Ada perubahan yang belum di-commit:\n${tracked.map((f) => `  ${f}`).join("\n")}\nCommit atau stash dulu.`);
  }
}

function createBranch(ctx: Ctx, config: Config, manifest: Manifest): void {
  const slug =
    manifest.request
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "run";
  let name = `${config.git.branch_prefix}${slug}`;
  if (git.branchExists(ctx.root, name)) name = `${name}-${manifest.run_id.slice(0, 10)}`;
  manifest.base_commit = git.head(ctx.root);
  git.switchBranch(ctx.root, name, true);
  manifest.branch = name;
  saveManifest(ctx, manifest);
  log.ok(`Branch baru ${name} dari ${manifest.base_commit.slice(0, 7)}`);
}

// Tugas yang masih in_progress berarti proses sebelumnya terputus (Ctrl+C,
// crash, laptop mati). Kalau commit-nya sempat dibuat, tandai selesai;
// kalau belum, buang sisa perubahannya.
function recoverInterrupted(ctx: Ctx, manifest: Manifest): void {
  for (const task of manifest.tasks.filter((t) => t.status === "in_progress")) {
    if (git.lastCommitSubject(ctx.root).startsWith(`${task.id}:`)) {
      task.status = "done";
      task.commit = git.head(ctx.root).slice(0, 7);
      log.info(`${task.id} ternyata sudah ter-commit sebelum terputus`);
    } else {
      git.rollback(ctx.root, task.untracked_before ?? git.workingState(ctx.root).untracked);
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      record(task, "rollback", task.attempts + 1, "interrupted");
      log.warn(`${task.id} terputus sebelumnya; perubahan setengah jadi dibuang`);
    }
    saveManifest(ctx, manifest);
  }
}

async function runTask(ctx: Ctx, config: Config, manifest: Manifest, task: Task, plan: string): Promise<void> {
  const { root } = ctx;
  const max = config.limits.max_attempts;
  task.status = "in_progress";
  task.untracked_before = git.workingState(root).untracked;
  saveManifest(ctx, manifest);
  log.step(`${task.id}: ${task.title}`);

  while (task.attempts < max) {
    task.attempts++;
    const n = task.attempts;
    saveManifest(ctx, manifest);

    log.step(`${task.id} percobaan ${n}/${max}: Developer (${config.roles.developer.model}) bekerja…`);
    const dev = await runAgent(
      developerRequest(ctx, config, manifest, task, plan, task.feedback ?? "", logPath(ctx, manifest, task, "developer", n, "json")),
    );
    const denied = dev.denials.length ? `${dev.denials.length} aksi ditolak` : undefined;
    record(task, "developer", n, dev.output.status, denied);
    if (denied) log.warn(`${task.id}: ${denied}; lihat log dan pertimbangkan menambah developer_bash`);

    if (dev.output.status === "blocked") {
      block(ctx, manifest, task, `Developer: ${dev.output.blocked_reason || dev.output.summary}`);
      return;
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
    const diff = git.taskDiff(root, task.untracked_before);
    const review = await runAgent(
      reviewerRequest(ctx, config, manifest, task, dev.output.summary, diff, logPath(ctx, manifest, task, "reviewer", n, "json")),
    );
    record(task, "reviewer", n, review.output.verdict, review.output.issues.length ? `${review.output.issues.length} issue` : undefined);

    if (review.output.verdict === "request_changes") {
      task.feedback = formatReview(review.output);
      saveManifest(ctx, manifest);
      log.warn(`${task.id}: Reviewer meminta perubahan (${review.output.issues.length} issue)`);
      continue;
    }

    const commit = git.commitTask(root, task.untracked_before, `${task.id}: ${task.title}\n\n${dev.output.summary}`);
    task.status = "done";
    task.commit = commit;
    delete task.feedback;
    record(task, "commit", n, commit ?? "no-changes");
    saveManifest(ctx, manifest);
    log.ok(`${task.id} selesai${commit ? ` (commit ${commit})` : " (tanpa perubahan)"}`);
    return;
  }

  block(ctx, manifest, task, `Gagal setelah ${max} percobaan. Feedback terakhir:\n${task.feedback ?? "-"}`);
}

function block(ctx: Ctx, manifest: Manifest, task: Task, reason: string): void {
  git.rollback(ctx.root, task.untracked_before ?? []);
  task.status = "blocked";
  task.blocked_reason = reason;
  record(task, "rollback", task.attempts, "blocked");
  saveManifest(ctx, manifest);
  log.error(`${task.id} blocked: ${reason.split("\n")[0]}`);
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
  log.info("Lihat `bondowoso status`, perbaiki penyebabnya, lalu `bondowoso reset <id>` dan `bondowoso work`.");
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
