#!/usr/bin/env node
// Pengganti `claude` untuk test. Skenario dibaca dari BONDOWOSO_FAKE_SCRIPT:
// { "<peran>": [langkah panggilan ke-0, ke-1, ...] }. Setiap panggilan dicatat
// ke <script>.calls.jsonl supaya test bisa memeriksa prompt yang dikirim.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Step {
  output?: unknown;
  write?: Record<string, string>;
  remove?: string[];
  run?: string[]; // perintah shell, mis. "git rm old.txt"
  denials?: unknown[];
  rateLimit?: boolean;
}

const role = process.env.BONDOWOSO_ROLE ?? "unknown";
const scriptPath = process.env.BONDOWOSO_FAKE_SCRIPT!;
const script: Record<string, Step[]> = JSON.parse(readFileSync(scriptPath, "utf8"));

const counterPath = `${scriptPath}.${role}.count`;
const n = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(n + 1));

const prompt = readFileSync(0, "utf8");
appendFileSync(`${scriptPath}.calls.jsonl`, `${JSON.stringify({ role, n, args: process.argv.slice(2), prompt })}\n`);

const reply = (data: Record<string, unknown>, code = 0): never => {
  console.log(JSON.stringify({ type: "result", total_cost_usd: 0.01, permission_denials: [], ...data }));
  process.exit(code);
};

const step = script[role]?.[n];
if (!step) reply({ is_error: true, subtype: "error", result: `fake: tidak ada langkah ${role}#${n}` }, 1);

for (const [path, content] of Object.entries(step!.write ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
for (const path of step!.remove ?? []) rmSync(path, { force: true });
for (const cmd of step!.run ?? []) execSync(cmd, { stdio: "ignore" });

if (step!.rateLimit) {
  reply({ is_error: true, subtype: "error", api_error_status: 429, result: "Claude usage limit reached. Your limit resets 3pm" }, 1);
}
reply({
  is_error: false,
  subtype: "success",
  result: JSON.stringify(step!.output),
  structured_output: step!.output,
  permission_denials: step!.denials ?? [],
});
