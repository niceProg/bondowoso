import { styleText } from "node:util";
import type { Ctx } from "../config.ts";
import { formatDenied } from "../denials.ts";
import { rollback } from "../git.ts";
import { log } from "../log.ts";
import { loadManifest, saveManifest, type Task } from "../manifest.ts";

const COLOR: Record<Task["status"], Parameters<typeof styleText>[0]> = {
  pending: "dim",
  in_progress: "cyan",
  resumed: "magenta",
  done: "green",
  blocked: "red",
};

export function status(ctx: Ctx): void {
  const m = loadManifest(ctx);
  console.log(`Run      ${m.run_id}`);
  console.log(`Request  ${m.request}`);
  console.log(`Branch   ${m.branch ?? `(belum dibuat; usulan ${m.branch_name ?? "-"}${m.base_ref ? ` dari ${m.base_ref}` : ""})`}`);
  console.log(`Scope    ${m.scope ?? "-"}`);
  console.log(`Approve  ${m.plan_hash ? "ya" : "belum"}${m.pending_append ? " (ada tambahan yang belum di-approve)" : ""}\n`);
  for (const t of m.tasks) {
    const state = styleText(COLOR[t.status], t.status.padEnd(11));
    const tags = [
      t.commit,
      t.followup_commit ? `+${t.followup_commit}` : "",
      t.deferred?.length ? `ditunda: ${t.deferred.join(",")}` : "",
      t.test_plan ? `${t.test_plan.cases.length} tc` : "",
      t.skills?.length ? t.skills.join(",") : "",
    ].filter(Boolean);
    const extra = tags.length ? ` ${styleText("dim", tags.join(" · "))}` : "";
    console.log(`${t.id.padEnd(4)} ${state} ${String(t.attempts).padStart(1)}x  ${t.title}${extra}`);
    if (t.status !== "blocked") continue;
    const indent = (text: string) => styleText("dim", `     ${text.split("\n").join("\n     ")}`);
    if (t.blocked_reason) console.log(indent(t.blocked_reason));
    if (t.denied?.length) console.log(indent(formatDenied(t.denied)));
    console.log(
      indent(t.last_patch ? `Lanjutkan: bondowoso resume ${t.id}  |  Ulang: bondowoso reset ${t.id}` : `Ulang: bondowoso reset ${t.id}`),
    );
  }
}

export function reset(ctx: Ctx, id: string): void {
  const m = loadManifest(ctx);
  const task = m.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Tugas ${id} tidak ada.`);
  if (task.status === "done") throw new Error(`${id} sudah selesai (commit ${task.commit}); tidak bisa di-reset.`);
  // Patch yang dipasang `resume` dibuang lagi; aslinya tetap ada di last_patch.
  if (task.status === "resumed") rollback(ctx.root, task.untracked_before ?? []);
  task.status = "pending";
  task.attempts = 0;
  delete task.feedback;
  delete task.blocked_reason;
  delete task.denied;
  saveManifest(ctx, m);
  log.ok(`${id} kembali ke pending; akan dikerjakan ulang dari awal oleh \`bondowoso work\``);
}
