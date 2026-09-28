#!/usr/bin/env node
// Dispatcher hook Claude Code untuk agent Bondowoso. Dipasang lewat
// `claude --settings`; konfigurasinya dikirim orkestrator lewat env
// BONDOWOSO_HOOK_CONFIG (JSON). Keputusan menolak dikirim sebagai
// permissionDecision "deny", sehingga ikut tercatat di permission_denials.
import { readFileSync } from "node:fs";
import { checkBashCommand, checkCompaction, checkLock, checkSensitiveFiles, contextTokens, type Verdict } from "./checks.ts";

export interface HookConfig {
  role: string;
  task?: string;
  compaction?: { context_window: number; block_pct: number };
  locks_dir?: string; // hanya di mode paralel
}

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  transcript_path?: string;
  cwd?: string;
}

function decide(config: HookConfig, input: HookInput): Verdict {
  const tool = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const checks: (() => Verdict)[] = [
    () => (config.compaction ? checkCompaction(contextTokens(input.transcript_path ?? ""), config.compaction.context_window, config.compaction.block_pct) : { deny: false }),
    () => checkSensitiveFiles(tool, toolInput),
    () => (tool === "Bash" ? checkBashCommand(String(toolInput.command ?? "")) : { deny: false }),
    () => (config.locks_dir && config.task ? checkLock(config.locks_dir, config.task, input.cwd ?? process.cwd(), tool, toolInput) : { deny: false }),
  ];
  for (const check of checks) {
    const verdict = check();
    if (verdict.deny) return verdict;
  }
  return { deny: false };
}

try {
  const config = JSON.parse(process.env.BONDOWOSO_HOOK_CONFIG ?? "{}") as HookConfig;
  const input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
  if (input.hook_event_name === "PreToolUse") {
    const verdict = decide(config, input);
    if (verdict.deny) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
        }),
      );
    }
  }
} catch (e) {
  // Hook yang rusak tidak boleh diam-diam meloloskan aksi berbahaya, tapi juga
  // tidak boleh mematikan agent: laporkan ke stderr dan biarkan permission
  // allowlist yang tetap berlaku.
  process.stderr.write(`[bondowoso hook] ${(e as Error).message}\n`);
}
