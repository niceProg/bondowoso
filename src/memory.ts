import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Ctx } from "./config.ts";
import { log } from "./log.ts";
import type { Manifest, Task } from "./manifest.ts";
import { memoryRequest } from "./roles.ts";
import { runAgent } from "./runner/claude.ts";
import { scanDiffForSecrets } from "./secrets.ts";

// Memory berlapis ala Jonggrang:
//   .bondowoso/memory/fragments/<run>/<task>.md  catatan mentah per tugas
//   .bondowoso/memory/runs/<run>.md               hasil compact satu run
//   .bondowoso/MEMORY.md                           pelajaran proyek (hasil promote)
// Recall deterministik: potongan bagian (##) yang paling relevan dengan kueri,
// maksimal 5 potongan dan `memory.recall_chars` karakter.

export function memoryPaths(ctx: Ctx, runId: string) {
  const dir = join(ctx.stateDir, "memory");
  return {
    project: join(ctx.stateDir, "MEMORY.md"),
    run: join(dir, "runs", `${runId}.md`),
    fragments: join(dir, "fragments", runId),
    archive: join(dir, "archive", runId),
  };
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export interface FragmentInput {
  commit?: string;
  commitMessage: string;
  summary: string;
  lessons: string[];
  minorIssues: string[];
}

export function writeFragment(ctx: Ctx, runId: string, task: Task, f: FragmentInput): void {
  const lines = [
    `# ${task.id}: ${task.title}`,
    "",
    `Commit: ${f.commit ?? "(tanpa perubahan)"}`,
    "",
    "## What Done",
    "",
    f.commitMessage.split("\n")[0],
    "",
    "## Why",
    "",
    f.summary,
  ];
  if (f.lessons.length) lines.push("", "## Lessons", "", ...f.lessons.map((l) => `- ${l}`));
  if (f.minorIssues.length) lines.push("", "## Follow-ups (catatan minor Reviewer)", "", ...f.minorIssues.map((l) => `- ${l}`));
  writeAtomic(join(memoryPaths(ctx, runId).fragments, `${task.id}.md`), `${lines.join("\n")}\n`);
}

interface Snippet {
  source: string;
  heading: string;
  text: string;
  score: number;
}

function sections(source: string, text: string): Snippet[] {
  const out: Snippet[] = [];
  let heading = "(awal)";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push({ source, heading, text: body, score: 0 });
    buf = [];
  };
  for (const line of text.split("\n")) {
    const m = /^#{2,4}\s+(.*)/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// Ambil potongan memory paling relevan untuk sebuah kueri. Tanpa kueri yang
// cocok, bagian Conventions/Known Pitfalls tetap dianggap relevan.
export function recall(ctx: Ctx, config: Config, query: string, runId?: string): string {
  if (!config.memory.enabled) return "";
  const sources: [string, string][] = [["MEMORY.md", read(memoryPaths(ctx, "_").project)]];
  if (runId) sources.push([`runs/${runId}.md`, read(memoryPaths(ctx, runId).run)]);
  const words = new Set(query.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []);
  const snippets = sources.flatMap(([src, text]) => sections(src, text));
  for (const s of snippets) {
    const hay = `${s.heading}\n${s.text}`.toLowerCase();
    for (const w of words) if (hay.includes(w)) s.score++;
    if (/convention|pitfall|konvensi|jebakan/i.test(s.heading)) s.score += 0.5;
  }
  const picked = snippets.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  let out = "";
  for (const s of picked) {
    const block = `### ${s.heading} (${s.source})\n${s.text}\n\n`;
    if (out.length + block.length > config.memory.recall_chars) break;
    out += block;
  }
  return out.trim();
}

function hasSecrets(text: string): boolean {
  return scanDiffForSecrets(text.split("\n").map((l) => `+${l}`).join("\n")).length > 0;
}

// Gabungkan fragmen tugas ke memory run, lalu (opsional) promosikan pelajaran
// yang stabil ke MEMORY.md proyek. Kegagalan dilaporkan tapi tidak menggagalkan run.
export async function compactAndPromote(ctx: Ctx, config: Config, manifest: Manifest, runLogDir: string, opts: { promote: boolean }): Promise<void> {
  if (!config.memory.enabled) return;
  const paths = memoryPaths(ctx, manifest.run_id);
  const fragments = existsSync(paths.fragments)
    ? readdirSync(paths.fragments).filter((f) => f.endsWith(".md")).sort()
    : [];
  try {
    if (fragments.length) {
      log.step(`Memory: merangkum ${fragments.length} fragmen tugas…`);
      const prompt = [
        `## Run\n\n${manifest.run_id}: ${manifest.request}`,
        `## Existing run memory\n\n${read(paths.run) || "(none)"}`,
        `## Tasks\n\n${manifest.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.commit ? ` (${t.commit})` : ""}`).join("\n")}`,
        `## New fragments\n\n${fragments.map((f) => read(join(paths.fragments, f))).join("\n\n---\n\n")}`,
      ].join("\n\n");
      const { output } = await runAgent(memoryRequest(ctx, config, "compact", prompt, join(runLogDir, "memory-compact.json")));
      if (hasSecrets(output.markdown)) throw new Error("hasil compact mengandung pola secret; tidak disimpan");
      writeAtomic(paths.run, `${output.markdown.trim()}\n`);
      mkdirSync(paths.archive, { recursive: true });
      for (const f of fragments) renameSync(join(paths.fragments, f), join(paths.archive, f));
      log.ok(`Memory run disimpan di .bondowoso/memory/runs/${manifest.run_id}.md`);
    }
    if (opts.promote && existsSync(paths.run)) {
      log.step("Memory: mempromosikan pelajaran stabil ke MEMORY.md…");
      const prompt = [`## Existing project memory\n\n${read(paths.project) || "(empty)"}`, `## Run memory (${manifest.run_id})\n\n${read(paths.run)}`].join("\n\n");
      const { output } = await runAgent(memoryRequest(ctx, config, "promote", prompt, join(runLogDir, "memory-promote.json")));
      if (hasSecrets(output.markdown)) throw new Error("hasil promote mengandung pola secret; tidak disimpan");
      writeAtomic(paths.project, `${output.markdown.trim()}\n`);
      log.ok("MEMORY.md proyek diperbarui");
    }
  } catch (e) {
    log.warn(`Memory tidak diperbarui: ${(e as Error).message}. Fragmen tetap disimpan; coba \`bondowoso memory compact\`.`);
  }
}
