import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Ctx, RoleName } from "./config.ts";
import { branchNames, recentSubjects } from "./git.ts";
import { TaskSpecSchema, type Manifest, type Task } from "./manifest.ts";
import type { AgentRequest } from "./runner/claude.ts";

export const PlanOutput = z.object({
  scope: z.enum(["bugfix", "small", "medium", "large"]),
  summary: z.string(),
  plan_markdown: z.string().min(1),
  open_questions: z.array(z.string()),
  branch_name: z.string(),
});

export const DecomposeOutput = z.object({
  tasks: z.array(TaskSpecSchema).min(1),
});

export const DeveloperOutput = z.object({
  status: z.enum(["done", "blocked"]),
  summary: z.string(),
  blocked_reason: z.string(),
  commit_message: z.string(),
});

export const ReviewOutput = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summary: z.string(),
  issues: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      severity: z.enum(["blocker", "major", "minor"]),
      message: z.string(),
    }),
  ),
});

export type PlanOutput = z.infer<typeof PlanOutput>;
export type DecomposeOutput = z.infer<typeof DecomposeOutput>;
export type DeveloperOutput = z.infer<typeof DeveloperOutput>;
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// Lead dan Reviewer hanya membaca. Bash untuk Lead tetap aman karena mode
// dontAsk hanya meloloskan perintah read-only yang tidak ada di allowlist.
const READ_TOOLS = ["Read", "Grep", "Glob"];

const PROMPTS_DIR = join(import.meta.dirname, "prompts");

function template(name: string, config: Config): string {
  const gates = config.gates.length
    ? config.gates.map((g) => `\`${g.run}\`${g.cwd !== "." ? ` (in ${g.cwd}/)` : ""}`).join(", ")
    : "(none configured)";
  const allowedBash = config.developer_bash.length
    ? config.developer_bash.map((p) => `- \`${p.replace(/:\*$/, " …")}\``).join("\n")
    : "- (nothing else)";
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8")
    .replaceAll("{{gates}}", gates)
    .replaceAll("{{allowed_bash}}", allowedBash)
    .replaceAll("{{language}}", config.language);
}

function base<T>(
  ctx: Ctx,
  config: Config,
  role: RoleName,
  logFile: string,
  schema: z.ZodType<T>,
): Pick<AgentRequest<T>, "role" | "model" | "effort" | "schema" | "cwd" | "logFile" | "timeoutMs"> {
  return {
    role,
    model: config.roles[role].model,
    effort: config.roles[role].effort,
    schema,
    cwd: ctx.root,
    logFile,
    timeoutMs: config.limits.agent_timeout_min * 60_000,
  };
}

function listBlock(title: string, items: string[]): string {
  return `## ${title}\n\n${items.length ? items.map((i) => `- ${i}`).join("\n") : "(none)"}`;
}

export function leadPlanRequest(ctx: Ctx, config: Config, request: string, logFile: string): AgentRequest<PlanOutput> {
  // Konvensi repo diberikan langsung supaya Lead tidak perlu izin git untuk
  // melihatnya.
  const sections = [
    `## Request\n\n${request}`,
    listBlock("Existing branches (newest first)", branchNames(ctx.root, 30)),
    listBlock("Recent commit subjects", recentSubjects(ctx.root, 15)),
  ];
  return {
    ...base(ctx, config, "lead", logFile, PlanOutput),
    systemPrompt: template("lead-plan", config),
    tools: [...READ_TOOLS, "Bash"],
    allowedTools: [],
    prompt: sections.join("\n\n"),
  };
}

export function leadDecomposeRequest(
  ctx: Ctx,
  config: Config,
  plan: string,
  logFile: string,
): AgentRequest<DecomposeOutput> {
  return {
    ...base(ctx, config, "lead", logFile, DecomposeOutput),
    systemPrompt: template("lead-decompose", config),
    tools: [...READ_TOOLS, "Bash"],
    allowedTools: [],
    prompt: `## Approved plan\n\n${plan}\n`,
  };
}

function taskBlock(task: Task): string {
  const lines = [`## Your task: ${task.id} — ${task.title}`, "", task.description, "", "Acceptance criteria:"];
  for (const a of task.acceptance) lines.push(`- ${a}`);
  if (task.files_hint.length) lines.push("", `Files likely involved: ${task.files_hint.join(", ")}`);
  return lines.join("\n");
}

function completedBlock(manifest: Manifest): string {
  const done = manifest.tasks.filter((t) => t.status === "done");
  if (!done.length) return "(none yet)";
  return done.map((t) => `- ${t.id}: ${t.title}${t.commit ? ` (commit ${t.commit})` : ""}`).join("\n");
}

export function developerRequest(
  ctx: Ctx,
  config: Config,
  manifest: Manifest,
  task: Task,
  plan: string,
  feedback: string,
  logFile: string,
): AgentRequest<DeveloperOutput> {
  const sections = [
    `## Overall request\n\n${manifest.request}`,
    `## Approved plan\n\n${plan}`,
    `## Completed tasks\n\n${completedBlock(manifest)}`,
    listBlock("Recent commit subjects in this repository (follow their style)", recentSubjects(ctx.root, 15)),
    taskBlock(task),
  ];
  if (feedback) {
    sections.push(`## Feedback on the previous attempt (fix these)\n\n${feedback}`);
  }
  return {
    ...base(ctx, config, "developer", logFile, DeveloperOutput),
    systemPrompt: template("developer", config),
    tools: [...READ_TOOLS, "Edit", "Write", "Bash"],
    allowedTools: ["Edit", "Write", ...config.developer_bash.map((p) => `Bash(${p})`)],
    prompt: sections.join("\n\n"),
  };
}

export function reviewerRequest(
  ctx: Ctx,
  config: Config,
  manifest: Manifest,
  task: Task,
  developerSummary: string,
  diff: string,
  logFile: string,
): AgentRequest<ReviewOutput> {
  const max = config.limits.max_diff_chars;
  const shownDiff = diff.length > max ? `${diff.slice(0, max)}\n… (diff dipotong, ${diff.length - max} karakter lagi; baca file langsung)` : diff;
  const sections = [
    `## Overall request\n\n${manifest.request}`,
    taskBlock(task).replace("## Your task:", "## Task under review:"),
    `## Developer's summary\n\n${developerSummary}`,
    `## Diff\n\n\`\`\`diff\n${shownDiff || "(no changes)"}\n\`\`\``,
  ];
  return {
    ...base(ctx, config, "reviewer", logFile, ReviewOutput),
    systemPrompt: template("reviewer", config),
    tools: READ_TOOLS,
    allowedTools: [],
    prompt: sections.join("\n\n"),
  };
}

export function formatReview(review: ReviewOutput): string {
  const issues = review.issues.map(
    (i) => `- [${i.severity}] ${i.file}${i.line > 0 ? `:${i.line}` : ""}: ${i.message}`,
  );
  return [`Reviewer meminta perubahan: ${review.summary}`, ...issues].join("\n");
}
