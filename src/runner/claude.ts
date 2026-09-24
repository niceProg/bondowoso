import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// Kalau salah satu variabel ini ada, Claude Code akan menagih API alih-alih
// memakai login langganan Max. Selalu dibuang dari env subprocess.
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

const RATE_LIMIT_RE = /rate.?limit|usage limit|limit (?:reached|exceeded)|out of (?:extra )?usage|too many requests/i;

export class RateLimitError extends Error {
  resetAt: Date | undefined;
  constructor(message: string, resetAt?: Date) {
    super(message);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
  }
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentRequest<T> {
  role: string;
  prompt: string;
  systemPrompt: string;
  tools: string[];
  allowedTools: string[];
  model: string;
  effort: string;
  schema: z.ZodType<T>;
  cwd: string;
  logFile: string;
  timeoutMs: number;
}

export interface AgentResponse<T> {
  output: T;
  costUsd: number;
  denials: unknown[];
}

export function claudeBin(): string {
  return process.env.BONDOWOSO_CLAUDE_BIN ?? "claude";
}

export function buildArgs(req: AgentRequest<unknown>): string[] {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--append-system-prompt", req.systemPrompt,
    "--tools", req.tools.join(","),
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--model", req.model,
    "--effort", req.effort,
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  // Opsi variadic: harus paling akhir supaya tidak menelan opsi lain.
  if (req.allowedTools.length > 0) args.push("--allowedTools", ...req.allowedTools);
  return args;
}

export async function runAgent<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
  const env: NodeJS.ProcessEnv = { ...process.env, BONDOWOSO_ROLE: req.role };
  for (const key of SCRUBBED_ENV) delete env[key];

  const { code, stdout, stderr, timedOut } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(claudeBin(), buildArgs(req), { cwd: req.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, req.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new AgentError(`gagal menjalankan ${claudeBin()}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
    // Prompt lewat stdin: diff bisa besar, tidak perlu lewat argv.
    child.stdin.end(req.prompt);
  });

  mkdirSync(dirname(req.logFile), { recursive: true });
  writeFileSync(req.logFile, stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ""));

  if (timedOut) throw new AgentError(`${req.role} melewati batas waktu ${Math.round(req.timeoutMs / 60000)} menit`);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout);
  } catch {
    const text = `${stdout}\n${stderr}`;
    if (RATE_LIMIT_RE.test(text)) throw new RateLimitError(text.trim(), parseResetTime(text));
    throw new AgentError(`${req.role}: claude keluar dengan kode ${code}, output bukan JSON:\n${text.trim().slice(-2000)}`);
  }

  if (data.is_error) {
    const message = String(data.result ?? data.subtype ?? "error tanpa pesan");
    if (data.api_error_status === 429 || RATE_LIMIT_RE.test(message)) {
      throw new RateLimitError(message, parseResetTime(message));
    }
    throw new AgentError(`${req.role}: ${message}`);
  }

  const parsed = req.schema.safeParse(data.structured_output);
  if (!parsed.success) {
    throw new AgentError(`${req.role}: output tidak sesuai schema:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    output: parsed.data,
    costUsd: Number(data.total_cost_usd ?? 0),
    denials: Array.isArray(data.permission_denials) ? data.permission_denials : [],
  };
}

// Ambil jam reset dari pesan seperti "resets 3pm" atau "resets at 15:30".
// Formatnya belum pasti, jadi kalau tidak cocok kembalikan undefined.
export function parseResetTime(message: string, now = new Date()): Date | undefined {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}
