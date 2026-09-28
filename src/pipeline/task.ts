import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Ctx, PhaseName } from "../config.ts";
import { describeDenials, mergeDenied } from "../denials.ts";
import { domainOf, emptyState, exitGate, markDirty, recordFeedbackAndCheckLoop, recordResult, touchedDomains } from "../feedback.ts";
import { formatGateFailures, gateLog, runGates, type GateResult } from "../gates.ts";
import * as git from "../git.ts";
import { log } from "../log.ts";
import { record, type Manifest, type Task } from "../manifest.ts";
import { writeFragment } from "../memory.ts";
import { cleanCommitMessage } from "../naming.ts";
import {
  developerRequest,
  formatReview,
  formatTester,
  reviewerRequest,
  simplifierRequest,
  testerRequest,
  type Exec,
  type TaskContext,
} from "../roles.ts";
import { runAgent } from "../runner/claude.ts";
import { formatSecretFindings, scanDiffForSecrets } from "../secrets.ts";
import { renderSkills, selectSkills, type Skill } from "../skills.ts";

// Satu tugas melewati fase: Implement → gate → scan secret → Simplify → Test →
// Review → commit. Setiap perubahan Developer menandai domain yang disentuh
// "kotor"; commit hanya boleh kalau semua domain itu PASS di Test dan Review.

export type RunMode = "normal" | "compact" | "post";

export interface TaskRun {
  ctx: Ctx;
  config: Config;
  manifest: Manifest;
  task: Task;
  plan: string;
  exec: Exec;
  skills: Skill[];
  memory: string;
  mode: RunMode;
  save: () => void;
  logDir: string;
}

export type TaskOutcome = { status: "done"; commit?: string } | { status: "blocked"; reason: string };

const RESUMED_SUMMARY =
  "(Tidak ada Developer di percobaan ini: perubahan dipasang ulang dari patch percobaan sebelumnya lewat `bondowoso resume`, dan mungkin sudah diedit manusia.)";
const POST_SUMMARY = "(Fase susulan dari `work --compact`: kode tugas ini sudah di-commit; periksa, sederhanakan, dan lengkapi test-nya.)";

export function phasesFor(config: Config, scope: string | undefined, mode: RunMode): Record<"simplify" | "test" | "review", boolean> {
  if (mode === "compact") return { simplify: false, test: false, review: false };
  const skip: PhaseName[] = config.pipeline.skip[scope ?? ""] ?? [];
  return {
    simplify: config.pipeline.simplify && !skip.includes("simplify"),
    test: config.pipeline.test && !skip.includes("test"),
    review: config.pipeline.review && !skip.includes("review"),
  };
}

function logFile(r: TaskRun, step: string, attempt: number, ext: string, suffix = ""): string {
  mkdirSync(r.logDir, { recursive: true });
  return join(r.logDir, `${r.task.id}-${step}-${attempt}${suffix}.${ext}`);
}

function gatesPass(r: TaskRun, step: string, attempt: number): GateResult[] {
  const results = runGates(r.exec.root, r.config.gates);
  writeFileSync(logFile(r, step, attempt, "log"), gateLog(results));
  return results.filter((g) => !g.ok).length ? results : [];
}

function trackDenials(r: TaskRun, denials: unknown[], who: string): string | undefined {
  const denied = describeDenials(denials);
  if (!denied.length) return undefined;
  r.task.denied = mergeDenied(r.task.denied, denied);
  log.warn(`${r.task.id}: ${denied.length} aksi ${who} ditolak (lihat \`bondowoso status\`)`);
  return `${denied.length} aksi ditolak`;
}

export async function runTask(r: TaskRun): Promise<TaskOutcome> {
  const { config, task, exec } = r;
  const root = exec.root;
  const max = config.limits.max_attempts;
  const phases = phasesFor(config, r.manifest.scope, r.mode);
  const tc: TaskContext = { plan: r.plan, memory: r.memory };
  const skillsFor = (role: "developer" | "tester" | "reviewer") => renderSkills(selectSkills(r.skills, config, role, task), config.skills.max_chars);

  const resumed = task.status === "resumed";
  let skipDeveloper = resumed || r.mode === "post";
  if (!resumed) task.untracked_before = git.workingState(root).untracked;
  const before = task.untracked_before ?? [];
  task.status = "in_progress";
  task.feedback_loop ??= emptyState();
  const state = task.feedback_loop;
  r.save();
  const label = r.mode === "post" ? " (fase susulan)" : resumed ? " (lanjutan dari resume)" : "";
  log.step(`${task.id}: ${task.title}${label}`);

  const lessons: string[] = [];
  let summary = "";
  // Di mode susulan kode fiturnya sudah ter-commit; commit barunya berisi test
  // atau perapian, jadi pesannya diambil dari Tester/Simplifier.
  let commitMessage = r.mode === "post" ? "" : (task.commit_message ?? "");

  // Berkas milik tugas: perubahan di working tree, plus berkas commit-nya di mode susulan.
  const taskFiles = (): string[] => {
    const files = new Set(git.changedFiles(root, before));
    if (r.mode === "post" && task.commit) for (const f of git.commitFilesDiff(root, task.commit).files) files.add(f);
    return [...files].sort();
  };
  const taskDiff = (): string => {
    if (r.mode === "post" && task.commit) {
      const { diff } = git.commitFilesDiff(root, task.commit);
      const extra = git.taskDiff(root, before);
      return [diff, extra].filter(Boolean).join("\n");
    }
    return git.taskDiff(root, before);
  };
  const fail = (text: string): TaskOutcome | undefined => {
    task.feedback = text;
    r.save();
    if (recordFeedbackAndCheckLoop(state, text)) {
      return { status: "blocked", reason: `Loop terdeteksi: feedback yang sama berulang.\n${text}` };
    }
    return undefined;
  };

  while (task.attempts < max) {
    task.attempts++;
    const n = task.attempts;
    let minorIssues: string[] = [];
    r.save();

    // ---- Implement
    if (skipDeveloper) {
      skipDeveloper = false;
      summary = r.mode === "post" ? POST_SUMMARY : RESUMED_SUMMARY;
      record(task, "resume", n, r.mode === "post" ? "post-pass" : "skip-developer");
    } else {
      log.step(`${task.id} percobaan ${n}/${max}: Developer (${config.roles.developer.model}) bekerja…`);
      const dev = await runAgent(developerRequest(r.ctx, config, r.manifest, task, { ...tc, skills: skillsFor("developer") }, task.feedback ?? "", logFile(r, "developer", n, "json"), exec));
      summary = dev.output.summary;
      if (dev.output.commit_message.trim()) commitMessage = task.commit_message = dev.output.commit_message;
      lessons.push(...dev.output.lessons);
      record(task, "developer", n, dev.output.status, trackDenials(r, dev.denials, "Developer"));
      if (dev.output.status === "blocked") {
        return { status: "blocked", reason: `Developer: ${dev.output.blocked_reason || dev.output.summary}` };
      }
    }

    const files = taskFiles();
    const domains = touchedDomains(files, config);
    markDirty(state, domains);

    // ---- Gate
    log.step(`${task.id}: menjalankan gate…`);
    const failedGates = gatesPass(r, "gates", n);
    record(task, "gates", n, failedGates.length ? "fail" : "pass", failedGates.filter((g) => !g.ok).map((g) => g.name).join(", ") || undefined);
    if (failedGates.length) {
      log.warn(`${task.id}: gate gagal (${failedGates.filter((g) => !g.ok).map((g) => g.name).join(", ")})`);
      const stop = fail(formatGateFailures(failedGates, config.limits.gate_output_tail));
      if (stop) return stop;
      continue;
    }

    // ---- Scan secret di baris yang ditambahkan
    const secrets = scanDiffForSecrets(taskDiff());
    record(task, "secrets", n, secrets.length ? "fail" : "pass");
    if (secrets.length) {
      log.warn(`${task.id}: ${secrets.length} kemungkinan secret di diff`);
      const stop = fail(formatSecretFindings(secrets));
      if (stop) return stop;
      continue;
    }

    // ---- Simplify
    if (phases.simplify) {
      const simplified = await simplify(r, n, files);
      if (!commitMessage && simplified) commitMessage = simplified;
    }

    // ---- Test
    if (phases.test) {
      const snap = git.snapshot(root, before);
      log.step(`${task.id}: Tester (${config.roles.tester.model}) menulis dan menjalankan test…`);
      const tester = await runAgent(testerRequest(r.ctx, config, task, { ...tc, skills: skillsFor("tester") }, taskDiff(), "", logFile(r, "tester", n, "json"), exec));
      trackDenials(r, tester.denials, "Tester");
      const reverted = git.restoreOutside(root, snap, before, (p) => domainOf(p, config) === "testing");
      if (reverted.length) log.warn(`${task.id}: perubahan Tester di luar berkas test dikembalikan: ${reverted.join(", ")}`);
      if (tester.output.commit_message.trim() && (!commitMessage || r.mode === "post")) commitMessage = tester.output.commit_message;
      const afterTests = gatesPass(r, "gates-tests", n);
      const ok = tester.output.status === "pass" && afterTests.length === 0;
      recordResult(state, domains, "testing", ok ? "PASS" : "FAIL");
      record(task, "tester", n, ok ? "pass" : tester.output.status === "pass" ? "gates-fail" : tester.output.status, `${tester.output.passed}/${tester.output.total}`);
      if (!ok) {
        log.warn(`${task.id}: fase Test gagal (${tester.output.failed} test gagal, ${tester.output.bugs.length} bug dilaporkan)`);
        const text = [formatTester(tester.output), afterTests.length ? formatGateFailures(afterTests, config.limits.gate_output_tail) : ""].filter(Boolean).join("\n\n");
        const stop = fail(text);
        if (stop) return stop;
        continue;
      }
    }

    // ---- Review
    if (phases.review) {
      log.step(`${task.id}: Reviewer (${config.roles.reviewer.model}) memeriksa…`);
      const review = await runAgent(
        reviewerRequest(r.ctx, config, r.manifest, task, { summary, diff: taskDiff(), skills: skillsFor("reviewer") }, logFile(r, "reviewer", n, "json"), exec),
      );
      lessons.push(...review.output.lessons);
      record(task, "reviewer", n, review.output.verdict, review.output.issues.length ? `${review.output.issues.length} issue` : undefined);
      if (review.output.verdict === "request_changes") {
        const serious = review.output.issues.filter((i) => i.severity !== "minor").map((i) => domainOf(i.file, config));
        recordResult(state, serious.length ? [...new Set(serious)] : domains, "review", "FAIL");
        log.warn(`${task.id}: Reviewer meminta perubahan (${review.output.issues.length} issue)`);
        const stop = fail(formatReview(review.output));
        if (stop) return stop;
        continue;
      }
      recordResult(state, domains, "review", "PASS");
      minorIssues = review.output.issues.map((i) => `${i.file}${i.line > 0 ? `:${i.line}` : ""}: ${i.message}`);
    }

    const gate = exitGate(state, domains, { review: phases.review, testing: phases.test });
    if (!gate.allowed) {
      const stop = fail(`Dirty bit belum bersih:\n${gate.blocked.join("\n")}`);
      if (stop) return stop;
      continue;
    }

    // ---- Commit
    task.commit_base = git.head(root);
    r.save();
    const message = cleanCommitMessage(commitMessage, task.title);
    const commit = git.commitTask(root, before, message);
    delete task.commit_base;
    delete task.feedback;
    record(task, "commit", n, commit ?? "no-changes");
    writeFragment(r.ctx, r.manifest.run_id, task, {
      commit,
      commitMessage: message,
      summary,
      lessons: [...new Set(lessons)],
      minorIssues,
    });
    return { status: "done", commit };
  }

  return { status: "blocked", reason: `Gagal setelah ${max} percobaan. Feedback terakhir:\n${task.feedback ?? "-"}` };
}

// Simplify: pass kejelasan tanpa mengubah perilaku, hanya pada berkas tugas.
// Berkas di luar daftar dikembalikan; kalau gate jadi merah, semua perubahan
// Simplifier dibatalkan dan tugas lanjut dengan versi sebelum Simplify.
async function simplify(r: TaskRun, attempt: number, files: string[]): Promise<string | undefined> {
  const { config, task, exec } = r;
  const root = exec.root;
  const before = task.untracked_before ?? [];
  const allowed = new Set(files);
  const snap = git.snapshot(root, before);
  const fullDiff = git.taskDiff(root, before);
  const budgetChars = config.limits.simplify_budget_tokens * 4;
  // Di atas anggaran, satu Simplifier per berkas (seperti planSimplify Jonggrang).
  const perFile = splitDiffByFile(fullDiff);
  const batches: { files: string[]; diff: string }[] =
    fullDiff.length <= budgetChars ? [{ files, diff: fullDiff }] : files.map((f) => ({ files: [f], diff: perFile.get(f) ?? "" }));

  log.step(`${task.id}: Simplifier (${config.roles.simplifier.model}) merapikan ${files.length} berkas${batches.length > 1 ? ` dalam ${batches.length} bagian` : ""}…`);
  let message: string | undefined;
  for (const [i, batch] of batches.entries()) {
    const res = await runAgent(simplifierRequest(r.ctx, config, task, batch.files, batch.diff, logFile(r, "simplifier", attempt, "json", batches.length > 1 ? `-${i + 1}` : ""), exec));
    trackDenials(r, res.denials, "Simplifier");
    message ||= res.output.commit_message.trim() || undefined;
  }
  const outside = git.restoreOutside(root, snap, before, (p) => allowed.has(p));
  if (outside.length) log.warn(`${task.id}: perubahan Simplifier di luar berkas tugas dikembalikan: ${outside.join(", ")}`);

  const failed = gatesPass(r, "gates-simplify", attempt);
  if (failed.length) {
    git.restoreOutside(root, snap, before, () => false);
    record(task, "simplifier", attempt, "reverted", "gate merah setelah simplify");
    log.warn(`${task.id}: gate merah setelah Simplify; perubahan Simplifier dibatalkan`);
    return undefined;
  }
  record(task, "simplifier", attempt, "ok");
  return message;
}

// Pecah diff gabungan menjadi potongan per berkas (dikunci path tujuan, atau
// path asal untuk berkas yang dihapus).
export function splitDiffByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of diff.split(/(?=^diff --git )/m)) {
    const file = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? /^--- a\/(.+)$/m.exec(chunk)?.[1];
    if (file) out.set(file.trim(), (out.get(file.trim()) ?? "") + chunk);
  }
  return out;
}
