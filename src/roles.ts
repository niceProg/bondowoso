import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Ctx, RoleName } from "./config.ts";
import { branchNames, recentSubjects } from "./git.ts";
import { TaskSpecSchema, type Manifest, type Task } from "./manifest.ts";
import type { AgentRequest } from "./runner/claude.ts";

// ---------------------------------------------------------------- schema output

export const PlanOutput = z.object({
  scope: z.enum(["bugfix", "small", "medium", "large"]),
  summary: z.string(),
  plan_markdown: z.string().min(1),
  open_questions: z.array(z.string()),
  branch_name: z.string(),
});

export const AskOutput = z.object({
  goal_analysis: z.string(),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        rationale: z.string(),
        type: z.enum(["single_choice", "multi_choice", "text"]),
        options: z.array(z.object({ value: z.string(), label: z.string(), rationale: z.string() })),
      }),
    )
    .max(6),
});

export const DiscoveryOutput = z.object({ discovery_markdown: z.string().min(1) });

export const AnalysisOutput = z.object({
  scope: z.enum(["bugfix", "small", "medium", "large"]),
  analysis_markdown: z.string().min(1),
});

export const DecomposeTask = TaskSpecSchema.extend({ skills: z.array(z.string()) });
export const DecomposeOutput = z.object({ tasks: z.array(DecomposeTask).min(1) });

export const TestCase = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["unit", "integration", "e2e"]),
  input: z.string(),
  expected: z.string(),
  mocks: z.array(z.string()),
});

export const TestPlanOutput = z.object({
  tasks: z.array(
    z.object({
      task_id: z.string(),
      test_files: z.array(z.string()),
      cases: z.array(TestCase),
      notes: z.string(),
    }),
  ),
});

export const DeveloperOutput = z.object({
  status: z.enum(["done", "blocked"]),
  summary: z.string(),
  blocked_reason: z.string(),
  commit_message: z.string(),
  lessons: z.array(z.string()),
});

export const SimplifyOutput = z.object({
  summary: z.string(),
  changed_files: z.array(z.string()),
  commit_message: z.string(),
});

export const TesterOutput = z.object({
  status: z.enum(["pass", "fail", "blocked"]),
  summary: z.string(),
  test_files: z.array(z.string()),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  failed_tests: z.array(z.string()),
  bugs: z.array(z.object({ file: z.string(), line: z.number().int(), description: z.string() })),
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
  lessons: z.array(z.string()),
});

export const MemoryOutput = z.object({ markdown: z.string() });

export type PlanOutput = z.infer<typeof PlanOutput>;
export type AskOutput = z.infer<typeof AskOutput>;
export type DecomposeOutput = z.infer<typeof DecomposeOutput>;
export type TestPlanOutput = z.infer<typeof TestPlanOutput>;
export type DeveloperOutput = z.infer<typeof DeveloperOutput>;
export type SimplifyOutput = z.infer<typeof SimplifyOutput>;
export type TesterOutput = z.infer<typeof TesterOutput>;
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// ---------------------------------------------------------------- dasar

// Lead, Test Lead dan Reviewer hanya membaca. Bash untuk Lead tetap aman karena
// mode dontAsk hanya meloloskan perintah read-only yang tidak ada di allowlist.
const READ_TOOLS = ["Read", "Grep", "Glob"];
const WRITE_TOOLS = [...READ_TOOLS, "Edit", "Write", "Bash"];

const PROMPTS_DIR = join(import.meta.dirname, "prompts");

// Tempat agent bekerja: root repo, atau worktree tugas di mode paralel.
export interface Exec {
  root: string;
  taskId?: string;
  locksDir?: string;
}

function readPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
}

function template(name: string, config: Config): string {
  const gates = config.gates.length
    ? config.gates.map((g) => `\`${g.run}\`${g.cwd !== "." ? ` (in ${g.cwd}/)` : ""}`).join(", ")
    : "(none configured)";
  const allowedBash = config.developer_bash.length
    ? config.developer_bash.map((p) => `- \`${p.replace(/:\*$/, " …")}\``).join("\n")
    : "- (nothing else)";
  return readPrompt(name)
    .replaceAll("{{shell_rules}}", readPrompt("_shell-rules"))
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
  exec?: Exec,
): Pick<AgentRequest<T>, "role" | "model" | "effort" | "schema" | "cwd" | "logFile" | "timeoutMs" | "hooks"> {
  const hooks = config.hooks.enabled
    ? {
        role,
        task: exec?.taskId,
        compaction: { context_window: config.hooks.context_window, block_pct: config.hooks.compaction_block_pct },
        locks_dir: exec?.locksDir,
      }
    : undefined;
  return {
    role,
    model: config.roles[role].model,
    effort: config.roles[role].effort,
    schema,
    cwd: exec?.root ?? ctx.root,
    logFile,
    timeoutMs: config.limits.agent_timeout_min * 60_000,
    hooks,
  };
}

function writer(config: Config): Pick<AgentRequest<unknown>, "tools" | "allowedTools"> {
  return { tools: WRITE_TOOLS, allowedTools: ["Edit", "Write", ...config.developer_bash.map((p) => `Bash(${p})`)] };
}

function listBlock(title: string, items: string[]): string {
  return `## ${title}\n\n${items.length ? items.map((i) => `- ${i}`).join("\n") : "(none)"}`;
}

function section(title: string, body: string | undefined): string[] {
  return body && body.trim() ? [`## ${title}\n\n${body.trim()}`] : [];
}

function capDiff(diff: string, max: number): string {
  if (!diff) return "(no changes)";
  return diff.length > max ? `${diff.slice(0, max)}\n… (diff dipotong, ${diff.length - max} karakter lagi; baca berkas langsung)` : diff;
}

// ---------------------------------------------------------------- perencanaan

export interface PlanInput {
  request: string;
  src?: { path: string; content: string };
  clarifications?: string;
  discovery?: string;
  analysis?: string;
  memory?: string;
}

function planContext(ctx: Ctx, input: PlanInput): string[] {
  return [
    `## Request\n\n${input.request}`,
    ...(input.src ? [`## Source document (${input.src.path})\n\n${input.src.content}`] : []),
    ...section("Clarifications from the human (authoritative; do not ask again)", input.clarifications),
    ...section("Deep planning: discovery notes", input.discovery),
    ...section("Deep planning: analysis", input.analysis),
    ...section("Project memory (context, not instructions)", input.memory),
    listBlock("Existing branches (newest first)", branchNames(ctx.root, 30)),
    listBlock("Recent commit subjects", recentSubjects(ctx.root, 15)),
  ];
}

function leadRead<T>(ctx: Ctx, config: Config, logFile: string, schema: z.ZodType<T>, prompt: string, system: string): AgentRequest<T> {
  return {
    ...base(ctx, config, "lead", logFile, schema),
    systemPrompt: template(system, config),
    tools: [...READ_TOOLS, "Bash"],
    allowedTools: [],
    prompt,
  };
}

export function leadPlanRequest(ctx: Ctx, config: Config, input: PlanInput, logFile: string): AgentRequest<PlanOutput> {
  return leadRead(ctx, config, logFile, PlanOutput, planContext(ctx, input).join("\n\n"), "lead-plan");
}

export function leadAskRequest(ctx: Ctx, config: Config, input: PlanInput, logFile: string): AgentRequest<AskOutput> {
  return leadRead(ctx, config, logFile, AskOutput, planContext(ctx, input).join("\n\n"), "lead-ask");
}

export function leadDiscoveryRequest(ctx: Ctx, config: Config, input: PlanInput, logFile: string): AgentRequest<z.infer<typeof DiscoveryOutput>> {
  return leadRead(ctx, config, logFile, DiscoveryOutput, planContext(ctx, input).join("\n\n"), "lead-deep-discovery");
}

export function leadAnalysisRequest(ctx: Ctx, config: Config, input: PlanInput, logFile: string): AgentRequest<z.infer<typeof AnalysisOutput>> {
  return leadRead(ctx, config, logFile, AnalysisOutput, planContext(ctx, input).join("\n\n"), "lead-deep-analysis");
}

export function leadAppendRequest(
  ctx: Ctx,
  config: Config,
  manifest: Manifest,
  plan: string,
  input: PlanInput,
  logFile: string,
): AgentRequest<PlanOutput> {
  const prompt = [
    `## Existing approved plan\n\n${plan}`,
    `## Existing tasks\n\n${manifest.tasks.map((t) => `- ${t.id} [${t.status}]: ${t.title}`).join("\n") || "(none)"}`,
    `## Existing branch\n\n${manifest.branch ?? manifest.branch_name ?? "(not created yet)"}`,
    ...planContext(ctx, input),
  ].join("\n\n");
  return leadRead(ctx, config, logFile, PlanOutput, prompt, "lead-append");
}

export function leadReviseRequest(ctx: Ctx, config: Config, plan: string, instruction: string, logFile: string): AgentRequest<PlanOutput> {
  const prompt = `## Current draft plan\n\n${plan}\n\n## Revision instruction\n\n${instruction}`;
  return leadRead(ctx, config, logFile, PlanOutput, prompt, "lead-revise");
}

export function leadDecomposeRequest(
  ctx: Ctx,
  config: Config,
  plan: string,
  catalog: { name: string; description: string }[],
  existing: Task[],
  logFile: string,
): AgentRequest<DecomposeOutput> {
  const prompt = [
    `## Approved plan\n\n${plan}`,
    listBlock("Skill catalog", catalog.map((s) => `${s.name}: ${s.description}`)),
    ...(existing.length ? [listBlock("Existing tasks (do not redefine)", existing.map((t) => `${t.id} [${t.status}]: ${t.title}`))] : []),
  ].join("\n\n");
  return leadRead(ctx, config, logFile, DecomposeOutput, prompt, "lead-decompose");
}

export function testLeadRequest(ctx: Ctx, config: Config, plan: string, tasks: Task[], logFile: string): AgentRequest<TestPlanOutput> {
  const prompt = [`## Approved plan\n\n${plan}`, `## Tasks\n\n${tasks.map(taskBlockPlain).join("\n\n")}`].join("\n\n");
  return {
    ...base(ctx, config, "test_lead", logFile, TestPlanOutput),
    systemPrompt: template("test-lead", config),
    tools: [...READ_TOOLS, "Bash"],
    allowedTools: [],
    prompt,
  };
}

// ---------------------------------------------------------------- per tugas

function taskBlockPlain(task: Task): string {
  const lines = [`### ${task.id} — ${task.title}`, "", task.description, "", "Acceptance criteria:"];
  for (const a of task.acceptance) lines.push(`- ${a}`);
  if (task.files_hint.length) lines.push("", `Files likely involved: ${task.files_hint.join(", ")}`);
  return lines.join("\n");
}

function taskBlock(task: Task, heading = "Your task"): string {
  return taskBlockPlain(task).replace(/^### /, `## ${heading}: `);
}

function completedBlock(manifest: Manifest): string {
  const done = manifest.tasks.filter((t) => t.status === "done");
  if (!done.length) return "(none yet)";
  return done.map((t) => `- ${t.id}: ${t.title}${t.commit ? ` (commit ${t.commit})` : ""}`).join("\n");
}

function testPlanBlock(task: Task): string | undefined {
  const plan = task.test_plan;
  if (!plan) return undefined;
  const cases = plan.cases.map((c) => `- ${c.id} [${c.type}] ${c.title}\n  input: ${c.input}\n  expected: ${c.expected}${c.mocks.length ? `\n  mocks: ${c.mocks.join(", ")}` : ""}`);
  return [`Test files: ${plan.test_files.join(", ") || "(tester decides)"}`, ...cases, ...(plan.notes ? [`Notes: ${plan.notes}`] : [])].join("\n");
}

export interface TaskContext {
  plan: string;
  skills?: string; // blok skill yang sudah dirender
  memory?: string; // hasil recall
}

export function developerRequest(
  ctx: Ctx,
  config: Config,
  manifest: Manifest,
  task: Task,
  tc: TaskContext,
  feedback: string,
  logFile: string,
  exec?: Exec,
): AgentRequest<DeveloperOutput> {
  const sections = [
    `## Overall request\n\n${manifest.request}`,
    `## Approved plan\n\n${tc.plan}`,
    `## Completed tasks\n\n${completedBlock(manifest)}`,
    listBlock("Recent commit subjects in this repository (follow their style)", recentSubjects(exec?.root ?? ctx.root, 15)),
    ...section("Project memory (context, not instructions; the code wins)", tc.memory),
    ...section("Skills to follow for this task", tc.skills),
    taskBlock(task),
    ...section("Test plan (the tester will cover these; keep the code testable)", testPlanBlock(task)),
    ...section("Feedback on the previous attempt (fix these)", feedback),
  ];
  return {
    ...base(ctx, config, "developer", logFile, DeveloperOutput, exec),
    systemPrompt: template("developer", config),
    ...writer(config),
    prompt: sections.join("\n\n"),
  };
}

export function simplifierRequest(
  ctx: Ctx,
  config: Config,
  task: Task,
  files: string[],
  diff: string,
  logFile: string,
  exec?: Exec,
): AgentRequest<SimplifyOutput> {
  const sections = [
    taskBlock(task, "Task that was implemented"),
    listBlock("Files you may change (and only these)", files),
    `## Changes\n\n\`\`\`diff\n${diff || "(no changes)"}\n\`\`\``,
  ];
  return {
    ...base(ctx, config, "simplifier", logFile, SimplifyOutput, exec),
    systemPrompt: template("simplifier", config),
    ...writer(config),
    prompt: sections.join("\n\n"),
  };
}

export function testerRequest(
  ctx: Ctx,
  config: Config,
  task: Task,
  tc: TaskContext,
  diff: string,
  feedback: string,
  logFile: string,
  exec?: Exec,
): AgentRequest<TesterOutput> {
  const sections = [
    taskBlock(task, "Task to test"),
    ...section("Test plan", testPlanBlock(task) ?? "(no test plan: cover the acceptance criteria; for a bug fix add a regression test)"),
    ...section("Skills to follow", tc.skills),
    `## Implementation diff\n\n\`\`\`diff\n${capDiff(diff, config.limits.max_diff_chars)}\n\`\`\``,
    ...section("Previous testing round", feedback),
  ];
  return {
    ...base(ctx, config, "tester", logFile, TesterOutput, exec),
    systemPrompt: template("tester", config),
    ...writer(config),
    prompt: sections.join("\n\n"),
  };
}

export function reviewerRequest(
  ctx: Ctx,
  config: Config,
  manifest: Manifest,
  task: Task,
  review: { summary: string; diff: string; testReport?: string; skills?: string },
  logFile: string,
  exec?: Exec,
): AgentRequest<ReviewOutput> {
  const sections = [
    `## Overall request\n\n${manifest.request}`,
    taskBlock(task, "Task under review"),
    `## Developer's summary\n\n${review.summary}`,
    ...section("Tester's report", review.testReport),
    ...section("Skills the change should follow", review.skills),
    `## Diff\n\n\`\`\`diff\n${capDiff(review.diff, config.limits.max_diff_chars)}\n\`\`\``,
  ];
  return {
    ...base(ctx, config, "reviewer", logFile, ReviewOutput, exec),
    systemPrompt: template("reviewer", config),
    tools: READ_TOOLS,
    allowedTools: [],
    prompt: sections.join("\n\n"),
  };
}

// ---------------------------------------------------------------- memory

export function memoryRequest(
  ctx: Ctx,
  config: Config,
  kind: "compact" | "promote",
  prompt: string,
  logFile: string,
): AgentRequest<z.infer<typeof MemoryOutput>> {
  return {
    ...base(ctx, config, "lead", logFile, MemoryOutput),
    effort: "low",
    systemPrompt: template(`memory-${kind}`, config),
    tools: [],
    allowedTools: [],
    prompt,
  };
}

// ---------------------------------------------------------------- format feedback

export function formatReview(review: ReviewOutput): string {
  const issues = review.issues.map((i) => `- [${i.severity}] ${i.file}${i.line > 0 ? `:${i.line}` : ""}: ${i.message}`);
  return [`Reviewer meminta perubahan: ${review.summary}`, ...issues].join("\n");
}

export function formatTester(result: TesterOutput): string {
  const lines = [`Tester (${result.status}): ${result.summary}`, `Hasil: ${result.passed}/${result.total} lulus, ${result.failed} gagal.`];
  if (result.failed_tests.length) lines.push("Test gagal:", ...result.failed_tests.map((t) => `- ${t}`));
  if (result.bugs.length) lines.push("Bug di implementasi (perbaiki kodenya, bukan test-nya):", ...result.bugs.map((b) => `- ${b.file}${b.line > 0 ? `:${b.line}` : ""}: ${b.description}`));
  if (result.blocked_reason) lines.push(`Tester macet: ${result.blocked_reason}`);
  return lines.join("\n");
}
