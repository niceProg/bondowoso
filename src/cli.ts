#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { makeCtx, type Ctx } from "./config.ts";
import { repoRoot } from "./git.ts";
import { log } from "./log.ts";
import { init } from "./pipeline/init.ts";
import { approve, plan } from "./pipeline/plan.ts";
import { reset, status } from "./pipeline/status.ts";
import { resume, work } from "./pipeline/work.ts";

const program = new Command()
  .name("bondowoso")
  .description("Orkestrator AI coding agent berbasis Claude Code (akun Max)")
  .option("-C, --dir <path>", "jalankan di repositori lain", ".");

function ctx(): Ctx {
  return makeCtx(repoRoot(resolve(program.opts<{ dir: string }>().dir)));
}

program
  .command("init")
  .description("buat .bondowoso/config.yaml dengan gate yang terdeteksi")
  .action(() => init(ctx()));

program
  .command("plan")
  .description("Lead menjelajah repo dan menulis .bondowoso/plan.md")
  .argument("[request...]", "permintaan fitur atau perbaikan; kosongkan untuk menulis di $EDITOR")
  .option("-f, --file <path>", "baca permintaan dari file (mis. permintaan.md)")
  .option("--force", "buang run lama yang belum selesai")
  .action((words: string[], opts: { file?: string; force?: boolean }) =>
    plan(ctx(), { words, file: opts.file }, { force: !!opts.force }),
  );

program
  .command("approve")
  .description("setujui plan.md dan pecah menjadi tugas")
  .option("--force", "pecah ulang walau tugas sudah mulai dikerjakan")
  .action((opts: { force?: boolean }) => approve(ctx(), { force: !!opts.force }));

program
  .command("work")
  .description("kerjakan tugas pending: developer → gate → reviewer → commit")
  .option("--wait", "saat kuota Max habis, tunggu lalu lanjut sendiri")
  .action(async (opts: { wait?: boolean }) => {
    process.exitCode = await work(ctx(), { wait: !!opts.wait });
  });

program
  .command("status")
  .description("tampilkan status tugas")
  .action(() => status(ctx()));

program
  .command("resume")
  .description("pasang lagi hasil percobaan terakhir tugas blocked, tambal manual, lalu `work`")
  .argument("<id>", "id tugas, mis. T3")
  .action((id: string) => resume(ctx(), id));

program
  .command("reset")
  .description("ulang tugas blocked dari awal")
  .argument("<id>", "id tugas, mis. T3")
  .action((id: string) => reset(ctx(), id));

try {
  await program.parseAsync();
} catch (e) {
  log.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
