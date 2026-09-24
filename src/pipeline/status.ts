import { styleText } from "node:util";
import type { Ctx } from "../config.ts";
import { log } from "../log.ts";
import { loadManifest, saveManifest, type Task } from "../manifest.ts";

const COLOR: Record<Task["status"], Parameters<typeof styleText>[0]> = {
  pending: "dim",
  in_progress: "cyan",
  done: "green",
  blocked: "red",
};

export function status(ctx: Ctx): void {
  const m = loadManifest(ctx);
  console.log(`Run      ${m.run_id}`);
  console.log(`Request  ${m.request}`);
  console.log(`Branch   ${m.branch ?? "(belum dibuat)"}`);
  console.log(`Approve  ${m.plan_hash ? "ya" : "belum"}\n`);
  for (const t of m.tasks) {
    const state = styleText(COLOR[t.status], t.status.padEnd(11));
    const extra = t.commit ? ` ${styleText("dim", t.commit)}` : "";
    console.log(`${t.id.padEnd(4)} ${state} ${String(t.attempts).padStart(1)}x  ${t.title}${extra}`);
    if (t.status === "blocked" && t.blocked_reason) {
      console.log(styleText("dim", `     ${t.blocked_reason.split("\n").join("\n     ")}`));
    }
  }
}

export function reset(ctx: Ctx, id: string): void {
  const m = loadManifest(ctx);
  const task = m.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Tugas ${id} tidak ada.`);
  if (task.status === "done") throw new Error(`${id} sudah selesai (commit ${task.commit}); tidak bisa di-reset.`);
  task.status = "pending";
  task.attempts = 0;
  delete task.feedback;
  delete task.blocked_reason;
  saveManifest(ctx, m);
  log.ok(`${id} kembali ke pending`);
}
