import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Ctx } from "../config.ts";
import { log } from "../log.ts";
import { hasManifest, loadManifest, saveManifest, validateTaskGraph, type Manifest } from "../manifest.ts";
import { leadDecomposeRequest, leadPlanRequest } from "../roles.ts";
import { runAgent } from "../runner/claude.ts";

export function planHash(ctx: Ctx): string {
  return createHash("sha256").update(readFileSync(ctx.planPath)).digest("hex").slice(0, 16);
}

export function runDir(ctx: Ctx, manifest: Pick<Manifest, "run_id">): string {
  return join(ctx.runsDir, manifest.run_id);
}

export async function plan(ctx: Ctx, request: string, opts: { force: boolean }): Promise<void> {
  const config = loadConfig(ctx);
  if (hasManifest(ctx) && !opts.force) {
    const old = loadManifest(ctx);
    const unfinished = old.tasks.some((t) => t.status !== "done");
    if (old.tasks.length > 0 && unfinished) {
      throw new Error(`Run ${old.run_id} masih punya tugas yang belum selesai. Pakai --force untuk membuang rencana itu.`);
    }
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const runId = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const manifest: Manifest = { run_id: runId, request, tasks: [] };
  mkdirSync(runDir(ctx, manifest), { recursive: true });

  log.step(`Lead (${config.roles.lead.model}) menyusun rencana…`);
  const { output, costUsd } = await runAgent(
    leadPlanRequest(ctx, config, request, join(runDir(ctx, manifest), "lead-plan.json")),
  );

  const lines = [`# Rencana: ${request}`, "", `**Scope:** ${output.scope}`, "", output.summary, "", output.plan_markdown.trim()];
  if (output.open_questions.length) {
    lines.push("", "## Pertanyaan terbuka", "", ...output.open_questions.map((q) => `- ${q}`));
  }
  writeFileSync(ctx.planPath, `${lines.join("\n")}\n`);
  manifest.scope = output.scope;
  saveManifest(ctx, manifest);

  log.ok(`Rencana ditulis ke ${ctx.planPath} (scope: ${output.scope}, estimasi harga list $${costUsd.toFixed(2)})`);
  if (output.open_questions.length) {
    log.warn(`Ada ${output.open_questions.length} pertanyaan terbuka. Jawab langsung di plan.md sebelum approve.`);
  }
  log.info("Baca dan edit plan.md seperlunya, lalu jalankan `bondowoso approve`.");
}

export async function approve(ctx: Ctx, opts: { force: boolean }): Promise<void> {
  const config = loadConfig(ctx);
  const manifest = loadManifest(ctx);
  if (!existsSync(ctx.planPath)) throw new Error("plan.md tidak ditemukan.");
  if (manifest.tasks.some((t) => t.status !== "pending") && !opts.force) {
    throw new Error("Tugas di run ini sudah mulai dikerjakan. Pakai --force untuk memecah ulang dari awal.");
  }

  const planText = readFileSync(ctx.planPath, "utf8");
  log.step(`Lead (${config.roles.lead.model}) memecah rencana menjadi tugas…`);
  const { output } = await runAgent(
    leadDecomposeRequest(ctx, config, planText, join(runDir(ctx, manifest), "lead-decompose.json")),
  );
  validateTaskGraph(output.tasks);

  manifest.tasks = output.tasks.map((t) => ({ ...t, status: "pending", attempts: 0, history: [] }));
  manifest.plan_hash = planHash(ctx);
  saveManifest(ctx, manifest);

  log.ok(`${manifest.tasks.length} tugas siap:`);
  for (const t of manifest.tasks) {
    log.info(`  ${t.id}  ${t.title}${t.depends_on.length ? `  (setelah ${t.depends_on.join(", ")})` : ""}`);
  }
  log.info("Jalankan `bondowoso work` untuk mulai mengerjakan.");
}
