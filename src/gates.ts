import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { GateConfig } from "./config.ts";

export interface GateResult {
  name: string;
  run: string;
  ok: boolean;
  code: number | null;
  output: string;
  seconds: number;
}

export function runGates(root: string, gates: GateConfig[]): GateResult[] {
  return gates.map((gate) => {
    const started = Date.now();
    const r = spawnSync("sh", ["-c", `exec 2>&1\n${gate.run}`], {
      cwd: join(root, gate.cwd),
      encoding: "utf8",
      timeout: gate.timeout_sec * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    let output = r.stdout ?? "";
    if (r.error) output += `\n[bondowoso] ${r.error.message}`;
    return {
      name: gate.name,
      run: gate.run,
      ok: r.status === 0 && !r.error,
      code: r.status,
      output,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  });
}

export function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  if (all.length <= lines) return all.join("\n");
  return [`… (${all.length - lines} baris awal dipotong)`, ...all.slice(-lines)].join("\n");
}

export function formatGateFailures(results: GateResult[], tailLines: number): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `### Gate "${r.name}" gagal (exit ${r.code ?? "timeout"})\n$ ${r.run}\n\`\`\`\n${tail(r.output, tailLines)}\n\`\`\``)
    .join("\n\n");
}

export function gateLog(results: GateResult[]): string {
  return results
    .map((r) => `===== ${r.name} (${r.ok ? "OK" : `GAGAL, exit ${r.code}`}, ${r.seconds}s)\n$ ${r.run}\n${r.output}`)
    .join("\n\n");
}
