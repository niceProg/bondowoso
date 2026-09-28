#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadConfig, makeCtx, type Ctx } from "./config.ts";
import { repoRoot } from "./git.ts";
import { log } from "./log.ts";
import { loadManifest, saveManifest } from "./manifest.ts";
import { compactAndPromote, memoryPaths, recall } from "./memory.ts";
import { init } from "./pipeline/init.ts";
import { approve, plan, runDir } from "./pipeline/plan.ts";
import { reset, status } from "./pipeline/status.ts";
import { resume, work } from "./pipeline/work.ts";
import { loadSkills } from "./skills.ts";

const program = new Command()
  .name("bondowoso")
  .description("Orkestrator AI coding agent berbasis Claude Code (akun Max)")
  .option("-C, --dir <path>", "jalankan di repositori lain", ".");

function ctx(): Ctx {
  return makeCtx(repoRoot(resolve(program.opts<{ dir: string }>().dir)));
}

const toInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Harus bilangan bulat ≥ 1: ${v}`);
  return n;
};

program
  .command("init")
  .description("buat .bondowoso/config.yaml dengan gate yang terdeteksi")
  .action(() => init(ctx()));

interface PlanFlags {
  file?: string;
  force?: boolean;
  deep?: boolean;
  src?: string;
  base?: string;
  append?: boolean;
  ask?: boolean;
  yes?: boolean;
  revise?: string;
}

program
  .command("plan")
  .description("Lead menjelajah repo dan menulis .bondowoso/plan.md")
  .argument("[request...]", "permintaan fitur atau perbaikan; kosongkan untuk menulis di $EDITOR")
  .option("-f, --file <path>", "baca permintaan dari file (mis. permintaan.md)")
  .option("--deep", "perencanaan 3 tahap: discovery → analisis pendekatan → rencana")
  .option("--src <path>", "dokumen kebutuhan (BRD/PRD) sebagai referensi")
  .option("--base <branch>", "potong branch kerja dari branch ini (bawaan: branch aktif)")
  .option("--append", "tambahkan ke rencana yang sudah di-approve")
  .option("--revise <instruksi>", "revisi plan.md yang belum di-approve sesuai instruksi")
  .option("--no-ask", "lewati pertanyaan klarifikasi")
  .option("-y, --yes", "tanpa pertanyaan, langsung approve")
  .option("--force", "buang run lama yang belum selesai")
  .action((words: string[], o: PlanFlags) =>
    plan(ctx(), { words, file: o.file }, { force: !!o.force, deep: o.deep, src: o.src, base: o.base, append: o.append, noAsk: o.ask === false, yes: o.yes, revise: o.revise }),
  );

program
  .command("approve")
  .description("setujui plan.md (atau tambahannya) dan pecah menjadi tugas; Test Lead merancang test")
  .option("--force", "pecah ulang walau tugas sudah mulai dikerjakan")
  .action((o: { force?: boolean }) => approve(ctx(), { force: !!o.force }));

interface WorkFlags {
  wait?: boolean;
  task?: string;
  compact?: boolean;
  full?: boolean;
  parallel?: number;
  yes?: boolean;
  deep?: boolean;
}

program
  .command("work")
  .description("kerjakan tugas: implement → gate → simplify → test → review → commit")
  .argument("[request...]", "dengan --yes: plan + approve + work sekaligus untuk permintaan ini")
  .option("--wait", "saat kuota Max habis, tunggu lalu lanjut sendiri")
  .option("--task <id>", "kerjakan satu tugas saja (plus dependensinya yang belum selesai)")
  .option("--compact", "berhenti setelah implement + gate; simplify/test/review ditunda")
  .option("--full", "jalankan fase yang ditunda oleh --compact")
  .option("-p, --parallel <n>", "jumlah tugas paralel (worktree terpisah)", toInt)
  .option("-y, --yes", "dengan permintaan: jalankan semuanya tanpa berhenti")
  .option("--deep", "dengan --yes: pakai perencanaan deep")
  .action(async (words: string[], o: WorkFlags) => {
    const c = ctx();
    if (words.length) {
      if (!o.yes) throw new Error("Permintaan langsung di `work` butuh --yes (plan + approve + work).");
      await plan(c, { words }, { force: false, yes: true, noAsk: true, deep: o.deep });
    }
    process.exitCode = await work(c, { wait: !!o.wait, task: o.task, compact: o.compact, full: o.full, parallel: o.parallel });
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

const memory = program.command("memory").description("memory proyek dan run");

memory
  .command("show")
  .description("tampilkan MEMORY.md proyek (atau memory run dengan --run)")
  .option("--run", "memory run aktif")
  .action((o: { run?: boolean }) => {
    const c = ctx();
    const path = o.run ? memoryPaths(c, loadManifest(c).run_id).run : memoryPaths(c, "_").project;
    console.log(existsSync(path) ? readFileSync(path, "utf8") : `(belum ada: ${path})`);
  });

memory
  .command("recall")
  .description("potongan memory yang relevan untuk sebuah kueri")
  .argument("<query...>")
  .action((q: string[]) => {
    const c = ctx();
    console.log(recall(c, loadConfig(c), q.join(" ")) || "(tidak ada yang relevan)");
  });

for (const [name, promote, desc] of [
  ["compact", false, "rangkum fragmen tugas run aktif ke memory run"],
  ["promote", true, "rangkum lalu promosikan pelajaran stabil ke MEMORY.md"],
] as const) {
  memory
    .command(name)
    .description(desc)
    .action(async () => {
      const c = ctx();
      const m = loadManifest(c);
      await compactAndPromote(c, loadConfig(c), m, runDir(c, m), { promote });
      m.memory_done = promote || m.memory_done;
      saveManifest(c, m);
    });
}

const skills = program.command("skills").description("skill yang dipakai agent");

skills
  .command("list")
  .description("daftar skill (bawaan + .bondowoso/skills)")
  .action(() => {
    for (const s of loadSkills(ctx())) {
      const who = s.tier === "core" ? `core → ${s.roles.join(", ")}` : `library [${s.domains.join(", ")}]`;
      console.log(`${s.name.padEnd(26)} ${who.padEnd(32)} ${s.description}`);
    }
  });

skills
  .command("show")
  .argument("<name>")
  .description("isi sebuah skill")
  .action((name: string) => {
    const s = loadSkills(ctx()).find((x) => x.name === name);
    if (!s) throw new Error(`Skill ${name} tidak ada. Lihat \`bondowoso skills list\`.`);
    console.log(`# ${s.name} (${s.source})\n\n${s.body}`);
  });

try {
  await program.parseAsync();
} catch (e) {
  log.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
