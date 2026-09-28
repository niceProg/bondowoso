import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { askQuestions } from "../ask.ts";
import { loadConfig, type Config, type Ctx } from "../config.ts";
import * as git from "../git.ts";
import { log } from "../log.ts";
import { hasManifest, loadManifest, saveManifest, validateTaskGraph, type Manifest, type Task } from "../manifest.ts";
import { recall } from "../memory.ts";
import { acceptableBranch, fallbackBranch, parsePlanBranch, planBranchLine } from "../naming.ts";
import { draftPath, readRequest, type RequestSource } from "../request.ts";
import {
  leadAnalysisRequest,
  leadAppendRequest,
  leadAskRequest,
  leadDecomposeRequest,
  leadDiscoveryRequest,
  leadPlanRequest,
  leadReviseRequest,
  testLeadRequest,
  type PlanInput,
  type PlanOutput,
} from "../roles.ts";
import { RateLimitError, runAgent } from "../runner/claude.ts";
import { catalog, loadSkills } from "../skills.ts";

const SRC_MAX_CHARS = 60_000;

export interface PlanOptions {
  force: boolean;
  deep?: boolean;
  src?: string;
  base?: string;
  append?: boolean;
  noAsk?: boolean;
  yes?: boolean;
  revise?: string;
}

export function planHash(ctx: Ctx): string {
  return createHash("sha256").update(readFileSync(ctx.planPath)).digest("hex").slice(0, 16);
}

function usableBranch(ctx: Ctx, name: string | undefined): string | undefined {
  return acceptableBranch(name) && git.isValidBranchName(ctx.root, name) ? name : undefined;
}

export function runDir(ctx: Ctx, manifest: Pick<Manifest, "run_id">): string {
  return join(ctx.runsDir, manifest.run_id);
}

function newRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function readSrc(path: string | undefined): PlanInput["src"] {
  if (!path) return undefined;
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Dokumen sumber tidak ditemukan: ${abs}`);
  const text = readFileSync(abs, "utf8");
  return { path, content: text.length > SRC_MAX_CHARS ? `${text.slice(0, SRC_MAX_CHARS)}\n… (dipotong)` : text };
}

function renderPlan(request: string, output: PlanOutput, branch: string, extra: { clarifications?: string; deep?: boolean }): string {
  const [title, ...rest] = request.split("\n");
  const lines = [`# Rencana: ${title.trim()}`, "", `**Scope:** ${output.scope}  `, planBranchLine(branch), ...(extra.deep ? ["", "_Mode: deep_"] : []), ""];
  // Permintaan multi-baris (dari editor/--file) tidak muat di judul.
  if (rest.some((l) => l.trim())) lines.push("## Permintaan", "", request, "");
  lines.push(output.summary, "", output.plan_markdown.trim());
  if (extra.clarifications) lines.push("", "## Klarifikasi", "", extra.clarifications);
  if (output.open_questions.length) lines.push("", "## Pertanyaan terbuka", "", ...output.open_questions.map((q) => `- ${q}`));
  return `${lines.join("\n")}\n`;
}

export async function plan(ctx: Ctx, source: RequestSource, opts: PlanOptions): Promise<void> {
  const config = loadConfig(ctx);
  if (opts.revise) return revise(ctx, config, opts.revise);
  if (opts.append) return appendPlan(ctx, config, source, opts);

  if (hasManifest(ctx) && !opts.force) {
    const old = loadManifest(ctx);
    if (old.tasks.length > 0 && old.tasks.some((t) => t.status !== "done")) {
      throw new Error(`Run ${old.run_id} masih punya tugas yang belum selesai. Pakai --force untuk membuang rencana itu, atau --append untuk menambah.`);
    }
  }
  if (opts.base) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(opts.base) || !git.isValidBranchName(ctx.root, opts.base)) throw new Error(`Nama branch dasar tidak valid: ${opts.base}`);
    if (!git.branchExists(ctx.root, opts.base)) throw new Error(`Branch dasar ${opts.base} tidak ada.`);
    if (git.currentBranch(ctx.root) !== opts.base) {
      if (git.workingState(ctx.root).tracked.length) throw new Error("Ada perubahan yang belum di-commit; tidak bisa pindah ke branch dasar.");
      git.switchBranch(ctx.root, opts.base, false);
      log.info(`Pindah ke branch dasar ${opts.base} supaya Lead membaca kode dari sana`);
    }
  }
  // Setelah pengecekan di atas, supaya editor tidak terbuka untuk plan yang toh ditolak.
  const request = readRequest(ctx, source);
  const manifest: Manifest = { run_id: newRunId(), request, tasks: [], ...(opts.base ? { base_ref: opts.base } : {}) };
  const dir = runDir(ctx, manifest);
  mkdirSync(dir, { recursive: true });
  const input: PlanInput = { request, src: readSrc(opts.src), memory: recall(ctx, config, request) };

  // Klarifikasi: hanya di terminal interaktif, dan bisa dimatikan.
  if (!opts.noAsk && !opts.yes && process.stdin.isTTY) {
    log.step(`Lead (${config.roles.lead.model}) memeriksa apakah ada yang perlu ditanyakan…`);
    const { output } = await runAgent(leadAskRequest(ctx, config, input, join(dir, "lead-ask.json")));
    if (output.questions.length) {
      log.info(`Lead punya ${output.questions.length} pertanyaan. ${output.goal_analysis}`);
      input.clarifications = await askQuestions(output.questions);
    } else {
      log.ok("Permintaan sudah jelas; tidak ada pertanyaan.");
    }
  }

  if (opts.deep) {
    log.step("Deep 1/3: discovery…");
    input.discovery = (await runAgent(leadDiscoveryRequest(ctx, config, input, join(dir, "lead-deep-discovery.json")))).output.discovery_markdown;
    writeFileSync(join(dir, "deep-discovery.md"), input.discovery);
    log.step("Deep 2/3: analisis pendekatan…");
    input.analysis = (await runAgent(leadAnalysisRequest(ctx, config, input, join(dir, "lead-deep-analysis.json")))).output.analysis_markdown;
    writeFileSync(join(dir, "deep-analysis.md"), input.analysis);
  }

  log.step(`${opts.deep ? "Deep 3/3: " : ""}Lead (${config.roles.lead.model}) menyusun rencana…`);
  const { output, costUsd } = await runAgent(leadPlanRequest(ctx, config, input, join(dir, "lead-plan.json")));
  const branch = usableBranch(ctx, output.branch_name.trim()) ?? fallbackBranch(request);
  writeFileSync(ctx.planPath, renderPlan(request, output, branch, { clarifications: input.clarifications, deep: opts.deep }));
  manifest.scope = output.scope;
  manifest.branch_name = branch;
  saveManifest(ctx, manifest);
  if (source.words.length === 0 && !source.file) rmSync(draftPath(ctx), { force: true });

  log.ok(`Rencana ditulis ke ${ctx.planPath} (scope: ${output.scope}, estimasi harga list $${costUsd.toFixed(2)})`);
  log.info(`Usulan branch: ${branch}${opts.base ? ` dari ${opts.base}` : ""} (ubah baris **Branch:** di plan.md kalau mau nama lain)`);
  if (output.open_questions.length) log.warn(`Ada ${output.open_questions.length} pertanyaan terbuka. Jawab langsung di plan.md sebelum approve.`);
  if (opts.yes) {
    await approve(ctx, { force: false });
    return;
  }
  log.info("Baca dan edit plan.md seperlunya, lalu jalankan `bondowoso approve`.");
}

async function revise(ctx: Ctx, config: Config, instruction: string): Promise<void> {
  const manifest = loadManifest(ctx);
  if (manifest.plan_hash) throw new Error("Rencana sudah di-approve. Pakai `plan --append` untuk menambah, atau `plan --force` untuk rencana baru.");
  const current = readFileSync(ctx.planPath, "utf8");
  log.step(`Lead (${config.roles.lead.model}) merevisi rencana…`);
  const { output } = await runAgent(leadReviseRequest(ctx, config, current, instruction, join(runDir(ctx, manifest), `lead-revise-${Date.now()}.json`)));
  const branch = usableBranch(ctx, output.branch_name.trim()) ?? manifest.branch_name ?? fallbackBranch(manifest.request);
  const clar = /\n## Klarifikasi\n\n([\s\S]*?)(\n## |\s*$)/.exec(current)?.[1];
  writeFileSync(ctx.planPath, renderPlan(manifest.request, output, branch, { clarifications: clar?.trim(), deep: current.includes("_Mode: deep_") }));
  manifest.scope = output.scope;
  manifest.branch_name = branch;
  saveManifest(ctx, manifest);
  log.ok("plan.md direvisi. Baca lagi, lalu `bondowoso approve`.");
}

// Tambahan pada rencana yang sudah di-approve: Lead menulis rencana delta yang
// ditempel ke plan.md; `approve` lalu memecah bagian itu saja jadi tugas baru.
async function appendPlan(ctx: Ctx, config: Config, source: RequestSource, opts: PlanOptions): Promise<void> {
  const manifest = loadManifest(ctx);
  if (!manifest.plan_hash) throw new Error("Belum ada rencana yang di-approve untuk ditambah. Jalankan `bondowoso plan` biasa.");
  if (manifest.pending_append) throw new Error("Tambahan sebelumnya belum di-approve. Jalankan `bondowoso approve` dulu.");
  const request = readRequest(ctx, source);
  const current = readFileSync(ctx.planPath, "utf8");
  const n = (current.match(/<!-- bondowoso:append \d+ -->/g) ?? []).length + 1;
  const marker = `<!-- bondowoso:append ${n} -->`;
  log.step(`Lead (${config.roles.lead.model}) menyusun rencana tambahan…`);
  const input: PlanInput = { request, src: readSrc(opts.src), memory: recall(ctx, config, request) };
  if (opts.deep) {
    input.discovery = (await runAgent(leadDiscoveryRequest(ctx, config, input, join(runDir(ctx, manifest), `lead-append-discovery-${n}.json`)))).output.discovery_markdown;
    input.analysis = (await runAgent(leadAnalysisRequest(ctx, config, input, join(runDir(ctx, manifest), `lead-append-analysis-${n}.json`)))).output.analysis_markdown;
  }
  const { output } = await runAgent(leadAppendRequest(ctx, config, manifest, current, input, join(runDir(ctx, manifest), `lead-append-${n}.json`)));
  const body = output.plan_markdown.trim().replace(/^(#{2,5}) /gm, "#$1 ");
  const section = [`## Tambahan ${n}: ${request.split("\n")[0].trim()}`, marker, "", output.summary, "", body];
  if (output.open_questions.length) section.push("", "### Pertanyaan terbuka", "", ...output.open_questions.map((q) => `- ${q}`));
  writeFileSync(ctx.planPath, `${current.trimEnd()}\n\n${section.join("\n")}\n`);
  manifest.pending_append = { request, marker };
  saveManifest(ctx, manifest);
  log.ok(`Rencana tambahan ${n} ditempel ke plan.md.`);
  if (opts.yes) {
    await approve(ctx, { force: false });
    return;
  }
  log.info("Baca bagian tambahan di plan.md, lalu `bondowoso approve` untuk memecahnya jadi tugas baru.");
}

export async function approve(ctx: Ctx, opts: { force: boolean }): Promise<void> {
  const config = loadConfig(ctx);
  const manifest = loadManifest(ctx);
  if (!existsSync(ctx.planPath)) throw new Error("plan.md tidak ditemukan.");
  const appending = !!manifest.pending_append;
  if (!appending && manifest.tasks.some((t) => t.status !== "pending") && !opts.force) {
    throw new Error("Tugas di run ini sudah mulai dikerjakan. Pakai --force untuk memecah ulang dari awal, atau `plan --append` untuk menambah.");
  }

  const planText = readFileSync(ctx.planPath, "utf8");
  const edited = parsePlanBranch(planText);
  if (edited && usableBranch(ctx, edited)) {
    if (!manifest.branch) manifest.branch_name = edited;
  } else if (edited) {
    log.warn(`Nama branch "${edited}" di plan.md tidak valid; tetap memakai ${manifest.branch_name ?? fallbackBranch(manifest.request)}.`);
  }

  const skills = loadSkills(ctx);
  const existing = appending ? manifest.tasks : [];
  let prompt = planText;
  if (appending) {
    const at = planText.indexOf(manifest.pending_append!.marker);
    const addition = at >= 0 ? planText.slice(Math.max(0, planText.lastIndexOf("\n## Tambahan", at))) : "";
    prompt = `${planText}\n\n## Addition to decompose (only this part becomes new tasks)\n\n${addition.trim()}`;
  }
  log.step(`Lead (${config.roles.lead.model}) memecah ${appending ? "rencana tambahan" : "rencana"} menjadi tugas…`);
  const { output } = await runAgent(
    leadDecomposeRequest(ctx, config, prompt, catalog(skills), existing, join(runDir(ctx, manifest), `lead-decompose${appending ? `-${Date.now()}` : ""}.json`)),
  );

  const clash = output.tasks.find((t) => existing.some((e) => e.id === t.id));
  if (clash) throw new Error(`Lead memakai id ${clash.id} yang sudah ada; jalankan approve lagi.`);
  validateTaskGraph([...existing, ...output.tasks]);
  const known = new Set(skills.map((s) => s.name));
  const fresh: Task[] = output.tasks.map(({ skills: sk, ...t }) => ({ ...t, skills: sk.filter((n) => known.has(n)), status: "pending", attempts: 0, history: [] }));

  await planTests(ctx, config, manifest, planText, fresh);

  manifest.tasks = appending ? [...manifest.tasks, ...fresh] : fresh;
  manifest.plan_hash = planHash(ctx);
  delete manifest.pending_append;
  manifest.memory_done = false;
  saveManifest(ctx, manifest);

  log.ok(`${fresh.length} tugas ${appending ? "baru ditambahkan" : "siap"}:`);
  for (const t of fresh) {
    const extra = [t.depends_on.length ? `setelah ${t.depends_on.join(", ")}` : "", t.skills?.length ? `skill: ${t.skills.join(", ")}` : "", t.test_plan ? `${t.test_plan.cases.length} kasus test` : ""].filter(Boolean).join("; ");
    log.info(`  ${t.id}  ${t.title}${extra ? `  (${extra})` : ""}`);
  }
  log.info("Jalankan `bondowoso work` untuk mulai mengerjakan.");
}

// Fase test-planning: Test Lead merancang kasus test per tugas.
async function planTests(ctx: Ctx, config: Config, manifest: Manifest, planText: string, tasks: Task[]): Promise<void> {
  const skip = config.pipeline.skip[manifest.scope ?? ""] ?? [];
  if (!config.pipeline.test || skip.includes("test") || skip.includes("test_plan") || tasks.length === 0) return;
  log.step(`Test Lead (${config.roles.test_lead.model}) merancang test…`);
  try {
    const { output } = await runAgent(testLeadRequest(ctx, config, planText, tasks, join(runDir(ctx, manifest), `test-lead-${Date.now()}.json`)));
    for (const p of output.tasks) {
      const task = tasks.find((t) => t.id === p.task_id);
      if (task) task.test_plan = { test_files: p.test_files, cases: p.cases, notes: p.notes };
    }
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    // Tanpa rencana test, Tester tetap jalan dari acceptance criteria.
    log.warn(`Test Lead gagal (${(e as Error).message.split("\n")[0]}); Tester akan bekerja dari acceptance criteria.`);
  }
}
