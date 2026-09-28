import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import type { Config, Ctx, RoleName } from "./config.ts";
import { domainOf } from "./feedback.ts";
import type { Task } from "./manifest.ts";

// Skill = SKILL.md dengan frontmatter YAML, mengikuti format Jonggrang:
//   skills/core/<name>/SKILL.md             selalu dimuat untuk `roles`-nya
//   skills/library/<domain>/<name>/SKILL.md dimuat just-in-time per tugas
// Skill proyek di <repo>/.bondowoso/skills/** menimpa skill bawaan bernama sama.
// Berbeda dari Jonggrang (gateway yang harus dibaca agent sendiri), pemilihan
// di sini deterministik: dari penugasan Lead ditambah pencocokan kata kunci
// dan domain, lalu isinya disisipkan langsung ke prompt.

export interface Skill {
  name: string;
  description: string;
  tier: "core" | "library";
  domains: string[];
  roles: RoleName[];
  triggers: string[];
  body: string;
  source: string;
}

export const BUILTIN_SKILLS_DIR = join(import.meta.dirname, "..", "skills");

function findSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findSkillFiles(p));
    else if (entry === "SKILL.md") out.push(p);
  }
  return out;
}

export function parseSkill(text: string, source: string): Skill | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const fm = (parse(m[1]) ?? {}) as Record<string, unknown>;
  if (typeof fm.name !== "string" || !fm.name) return undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    name: fm.name,
    description: String(fm.description ?? ""),
    tier: fm.tier === "core" ? "core" : "library",
    domains: list(fm.domains ?? fm.domain),
    roles: list(fm.roles) as RoleName[],
    triggers: list(fm.trigger ?? fm.triggers).map((t) => t.toLowerCase()),
    body: m[2].trim(),
    source,
  };
}

export function loadSkills(ctx: Ctx, builtinDir = BUILTIN_SKILLS_DIR): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of [builtinDir, join(ctx.stateDir, "skills")]) {
    for (const file of findSkillFiles(dir)) {
      const skill = parseSkill(readFileSync(file, "utf8"), relative(dir, file));
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function catalog(skills: Skill[]): { name: string; description: string }[] {
  return skills.filter((s) => s.tier === "library").map((s) => ({ name: s.name, description: s.description }));
}

function taskText(task: Task): string {
  return [task.title, task.description, ...task.acceptance, ...task.files_hint].join("\n").toLowerCase();
}

function matchesWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`).test(text);
}

// Skor library skill untuk sebuah tugas: kecocokan kata kunci + domain berkas.
function score(skill: Skill, text: string, domains: Set<string>): number {
  let s = 0;
  for (const t of skill.triggers) {
    if (t && matchesWord(text, t)) s += 2;
  }
  if (s > 0 && skill.domains.some((d) => domains.has(d))) s += 1;
  return s;
}

export function selectSkills(skills: Skill[], config: Config, role: RoleName, task: Task): Skill[] {
  if (!config.skills.enabled) return [];
  const core = skills.filter((s) => s.tier === "core" && s.roles.includes(role));
  const library = skills.filter((s) => s.tier === "library");
  const assigned = (task.skills ?? []).map((n) => library.find((s) => s.name === n)).filter((s): s is Skill => !!s);
  const text = taskText(task);
  const domains = new Set(task.files_hint.map((f) => domainOf(f, config)));
  const routed = library
    .filter((s) => !assigned.includes(s))
    .map((s) => ({ s, score: score(s, text, domains) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s);
  const picked = [...assigned, ...routed].slice(0, config.skills.max_per_task);
  return [...core, ...picked];
}

export function renderSkills(skills: Skill[], maxChars: number): string {
  let out = "";
  for (const s of skills) {
    const block = `### ${s.name}\n\n${s.body}\n\n`;
    if (out.length + block.length > maxChars) {
      out += `(skill ${s.name} dan selanjutnya dipotong karena melebihi anggaran ${maxChars} karakter)\n`;
      break;
    }
    out += block;
  }
  return out.trim();
}
