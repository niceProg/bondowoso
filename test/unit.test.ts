import { describe, expect, it } from "vitest";
import { nextTask, validateTaskGraph, type Manifest, type TaskSpec } from "../src/manifest.ts";
import { buildArgs, parseResetTime } from "../src/runner/claude.ts";
import { DeveloperOutput } from "../src/roles.ts";
import { describeDenials, mergeDenied, suggestPattern } from "../src/denials.ts";

const spec = (id: string, depends_on: string[] = []): TaskSpec => ({
  id,
  title: id,
  description: "",
  acceptance: ["x"],
  files_hint: [],
  depends_on,
});

describe("validateTaskGraph", () => {
  it("menerima graf yang valid", () => {
    expect(() => validateTaskGraph([spec("T1"), spec("T2", ["T1"])])).not.toThrow();
  });
  it("menolak id ganda, dependensi hilang, dan siklus", () => {
    expect(() => validateTaskGraph([spec("T1"), spec("T1")])).toThrow(/ganda/);
    expect(() => validateTaskGraph([spec("T1", ["T9"])])).toThrow(/tidak ada/);
    expect(() => validateTaskGraph([spec("T1", ["T2"]), spec("T2", ["T1"])])).toThrow(/melingkar/);
  });
});

describe("nextTask", () => {
  it("melewati tugas yang dependensinya belum selesai", () => {
    const m: Manifest = {
      run_id: "r",
      request: "x",
      tasks: [
        { ...spec("T1"), status: "blocked", attempts: 3, history: [] },
        { ...spec("T2", ["T1"]), status: "pending", attempts: 0, history: [] },
        { ...spec("T3"), status: "pending", attempts: 0, history: [] },
      ],
    };
    expect(nextTask(m)?.id).toBe("T3");
  });
});

describe("parseResetTime", () => {
  const now = new Date(2026, 8, 25, 10, 0);
  it("membaca jam am/pm dan 24 jam", () => {
    expect(parseResetTime("limit resets 3pm", now)?.getHours()).toBe(15);
    expect(parseResetTime("resets at 14:30", now)?.getMinutes()).toBe(30);
  });
  it("jam yang sudah lewat berarti besok", () => {
    expect(parseResetTime("resets 9am", now)?.getDate()).toBe(26);
  });
  it("undefined kalau formatnya tidak dikenal", () => {
    expect(parseResetTime("coba lagi nanti", now)).toBeUndefined();
  });
});

describe("buildArgs", () => {
  it("tidak memakai --bare dan menaruh --allowedTools paling akhir", () => {
    const args = buildArgs({
      role: "developer",
      prompt: "",
      systemPrompt: "s",
      tools: ["Read", "Edit"],
      allowedTools: ["Edit", "Bash(go test:*)"],
      model: "claude-sonnet-5",
      effort: "xhigh",
      schema: DeveloperOutput,
      cwd: ".",
      logFile: "x",
      timeoutMs: 1,
    });
    expect(args).not.toContain("--bare");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(-3)).toEqual(["--allowedTools", "Edit", "Bash(go test:*)"]);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).not.toHaveProperty("$schema");
  });
});

describe("denials", () => {
  it("meringkas permission_denials jadi satu baris per aksi", () => {
    expect(
      describeDenials([
        { tool_name: "Bash", tool_input: { command: "rm a.vue\nrm b.vue" } },
        { tool_name: "Glob", tool_input: { pattern: "/opt/*" } },
      ]),
    ).toEqual(["rm a.vue", 'Glob({"pattern":"/opt/*"})']);
  });
  it("menebak pola developer_bash", () => {
    expect(suggestPattern("cd web && git rm app/x.vue")).toBe("git rm:*");
    expect(suggestPattern("npx eslint app/")).toBe("npx eslint:*");
    expect(suggestPattern("rm -f a.vue")).toBe("rm:*");
    expect(suggestPattern("Glob({})")).toBeUndefined();
  });
  it("menggabungkan tanpa duplikat", () => {
    expect(mergeDenied(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });
});
