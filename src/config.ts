import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const STATE_DIR = ".bondowoso";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const Role = z.object({
  model: z.string().min(1),
  effort: Effort,
});

const Gate = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  cwd: z.string().default("."),
  timeout_sec: z.number().int().positive().default(900),
});

const Domain = z.object({
  name: z.string().min(1),
  match: z.string().min(1), // regex terhadap path relatif ke root repo
});

// Urutan penting: domain pertama yang cocok menang, sisanya jatuh ke "backend".
export const DEFAULT_DOMAINS = [
  { name: "testing", match: String.raw`(\.test\.|\.spec\.|__tests__/|(^|/)tests?/|_test\.go$)` },
  { name: "database", match: String.raw`(^|/)(migrations?|db|database)/|schema\.(sql|prisma|ts)$` },
  { name: "frontend", match: String.raw`(^|/)(frontend|client|web|components|pages|views|layouts|ui)/|\.(vue|svelte|tsx|jsx|css|scss)$` },
  { name: "api", match: String.raw`(^|/)(api|routes?|controllers?|handlers?)/` },
];

const Phase = z.enum(["simplify", "test_plan", "test", "review"]);
export type PhaseName = z.infer<typeof Phase>;

export const ConfigSchema = z
  .object({
    language: z.string().default("Indonesian"),
    gates: z.array(Gate).default([]),
    roles: z.object({
      lead: Role,
      developer: Role,
      reviewer: Role,
      // Peran baru bersifat opsional supaya config lama tetap jalan: bawaannya
      // mengikuti Lead (Test Lead) atau Developer (Simplifier, Tester).
      simplifier: Role.optional(),
      test_lead: Role.optional(),
      tester: Role.optional(),
    }),
    // Pola `Bash(...)` tambahan yang boleh dijalankan Developer, Simplifier, dan
    // Tester tanpa bertanya, mis. "go test:*".
    developer_bash: z.array(z.string()).default([]),
    limits: z
      .object({
        max_attempts: z.number().int().min(1).default(3),
        gate_output_tail: z.number().int().min(10).default(150),
        agent_timeout_min: z.number().positive().default(45),
        max_diff_chars: z.number().int().positive().default(150_000),
        // Anggaran diff Simplifier (≈ 4 karakter per token, seperti Jonggrang):
        // di atasnya Simplifier dijalankan per berkas.
        simplify_budget_tokens: z.number().int().positive().default(200_000),
      })
      .prefault({}),
    pipeline: z
      .object({
        simplify: z.boolean().default(true),
        test: z.boolean().default(true),
        review: z.boolean().default(true),
        // Fase yang dilewati per scope hasil triage (mengikuti PHASE_SKIP_MAP Jonggrang).
        skip: z.record(z.string(), z.array(Phase)).default({ bugfix: ["simplify", "test_plan"], small: [] }),
      })
      .prefault({}),
    domains: z.array(Domain).default(DEFAULT_DOMAINS),
    hooks: z
      .object({
        enabled: z.boolean().default(true),
        context_window: z.number().int().positive().default(200_000),
        compaction_block_pct: z.number().int().min(50).max(99).default(85),
      })
      .prefault({}),
    skills: z
      .object({
        enabled: z.boolean().default(true),
        max_per_task: z.number().int().min(0).default(3),
        max_chars: z.number().int().positive().default(16_000),
      })
      .prefault({}),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        auto_promote: z.boolean().default(true),
        recall_chars: z.number().int().positive().default(2_000),
      })
      .prefault({}),
    parallel: z
      .object({
        max: z.number().int().min(1).default(1),
        // Path (relatif ke root) yang di-symlink ke setiap worktree, mis.
        // web/node_modules, supaya gate tidak perlu install ulang.
        link: z.array(z.string()).default([]),
      })
      .prefault({}),
  })
  .transform((c) => ({
    ...c,
    roles: {
      ...c.roles,
      simplifier: c.roles.simplifier ?? c.roles.developer,
      test_lead: c.roles.test_lead ?? c.roles.lead,
      tester: c.roles.tester ?? c.roles.developer,
    },
  }));

export type Config = z.infer<typeof ConfigSchema>;
export type GateConfig = z.infer<typeof Gate>;
export type RoleConfig = z.infer<typeof Role>;
export type RoleName = keyof Config["roles"];

export interface Ctx {
  root: string;
  stateDir: string;
  configPath: string;
  manifestPath: string;
  planPath: string;
  runsDir: string;
}

export function makeCtx(root: string): Ctx {
  const stateDir = join(root, STATE_DIR);
  return {
    root,
    stateDir,
    configPath: join(stateDir, "config.yaml"),
    manifestPath: join(stateDir, "manifest.yaml"),
    planPath: join(stateDir, "plan.md"),
    runsDir: join(stateDir, "runs"),
  };
}

export function loadConfig(ctx: Ctx): Config {
  if (!existsSync(ctx.configPath)) {
    throw new Error(`${ctx.configPath} belum ada. Jalankan \`bondowoso init\` dulu.`);
  }
  const result = ConfigSchema.safeParse(parse(readFileSync(ctx.configPath, "utf8")));
  if (!result.success) {
    throw new Error(`config.yaml tidak valid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
