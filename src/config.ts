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

export const ConfigSchema = z.object({
  language: z.string().default("Indonesian"),
  gates: z.array(Gate).default([]),
  roles: z.object({
    lead: Role,
    developer: Role,
    reviewer: Role,
  }),
  // Pola `Bash(...)` tambahan yang boleh dijalankan Developer tanpa bertanya,
  // mis. "go test:*". Perintah read-only sudah diizinkan Claude Code sendiri.
  developer_bash: z.array(z.string()).default([]),
  limits: z
    .object({
      max_attempts: z.number().int().min(1).default(3),
      gate_output_tail: z.number().int().min(10).default(150),
      agent_timeout_min: z.number().positive().default(45),
      max_diff_chars: z.number().int().positive().default(150_000),
    })
    .prefault({}),
});

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
