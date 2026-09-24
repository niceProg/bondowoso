import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Ctx } from "./config.ts";

export const TaskSpecSchema = z.object({
  id: z.string().regex(/^T\d+$/),
  title: z.string().min(1),
  description: z.string(),
  acceptance: z.array(z.string()).min(1),
  files_hint: z.array(z.string()),
  depends_on: z.array(z.string()),
});

const HistoryEntry = z.object({
  step: z.enum(["developer", "gates", "reviewer", "commit", "rollback", "rate_limit", "resume"]),
  attempt: z.number().int(),
  result: z.string(),
  at: z.string(),
  note: z.string().optional(),
});

const TaskSchema = TaskSpecSchema.extend({
  // resumed: patch percobaan terakhir sudah dipasang lagi lewat `bondowoso resume`
  // dan menunggu `work` (mungkin setelah diedit manusia).
  status: z.enum(["pending", "in_progress", "resumed", "done", "blocked"]),
  attempts: z.number().int().min(0),
  commit: z.string().optional(),
  untracked_before: z.array(z.string()).optional(),
  feedback: z.string().optional(),
  blocked_reason: z.string().optional(),
  // Patch perubahan yang terakhir dibuang (relatif ke .bondowoso/), untuk `resume`.
  last_patch: z.string().optional(),
  // Perintah/tool yang ditolak permission selama tugas ini, tanpa duplikat.
  denied: z.array(z.string()).optional(),
  history: z.array(HistoryEntry),
});

const ManifestSchema = z.object({
  run_id: z.string(),
  request: z.string(),
  scope: z.string().optional(),
  branch: z.string().optional(),
  base_commit: z.string().optional(),
  plan_hash: z.string().optional(),
  baseline_ok: z.boolean().optional(),
  tasks: z.array(TaskSchema),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type HistoryStep = z.infer<typeof HistoryEntry>["step"];

export function hasManifest(ctx: Ctx): boolean {
  return existsSync(ctx.manifestPath);
}

export function loadManifest(ctx: Ctx): Manifest {
  if (!existsSync(ctx.manifestPath)) {
    throw new Error("Belum ada rencana. Jalankan `bondowoso plan \"<permintaan>\"` dulu.");
  }
  const result = ManifestSchema.safeParse(parse(readFileSync(ctx.manifestPath, "utf8")));
  if (!result.success) {
    throw new Error(`manifest.yaml rusak:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// Tulis ke file sementara lalu rename, supaya crash di tengah penulisan
// tidak meninggalkan manifest setengah jadi.
export function saveManifest(ctx: Ctx, manifest: Manifest): void {
  const tmp = `${ctx.manifestPath}.tmp`;
  writeFileSync(tmp, stringify(manifest, { lineWidth: 0 }));
  renameSync(tmp, ctx.manifestPath);
}

export function record(task: Task, step: HistoryStep, attempt: number, result: string, note?: string): void {
  task.history.push({ step, attempt, result, at: new Date().toISOString(), ...(note ? { note } : {}) });
}

export function nextTask(manifest: Manifest): Task | undefined {
  const resumed = manifest.tasks.find((t) => t.status === "resumed");
  if (resumed) return resumed;
  const done = new Set(manifest.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return manifest.tasks.find((t) => t.status === "pending" && t.depends_on.every((d) => done.has(d)));
}

// Validasi hasil dekomposisi Lead: id unik, dependensi ada, tanpa siklus.
export function validateTaskGraph(tasks: TaskSpec[]): void {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`id tugas ganda: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (!ids.has(d)) throw new Error(`${t.id} bergantung pada ${d} yang tidak ada`);
      if (d === t.id) throw new Error(`${t.id} bergantung pada dirinya sendiri`);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new Error(`dependensi melingkar di ${id}`);
    state.set(id, "visiting");
    for (const d of byId.get(id)!.depends_on) visit(d);
    state.set(id, "done");
  };
  for (const t of tasks) visit(t.id);
}
