import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChoice } from "../src/ask.ts";
import { ConfigSchema } from "../src/config.ts";
import { emptyState, exitGate, jaccard, markDirty, recordFeedbackAndCheckLoop, recordResult, touchedDomains } from "../src/feedback.ts";
import { restoreOutside, snapshot } from "../src/git.ts";
import { phasesFor, splitDiffByFile } from "../src/pipeline/task.ts";
import { scanDiffForSecrets } from "../src/secrets.ts";

const r = { model: "m", effort: "high" as const };
import { nextTask, validateTaskGraph, type Manifest, type TaskSpec } from "../src/manifest.ts";
import { buildArgs, parseResetTime } from "../src/runner/claude.ts";
import { DeveloperOutput } from "../src/roles.ts";
import { describeDenials, mergeDenied, suggestPattern } from "../src/denials.ts";
import { acceptableBranch, cleanCommitMessage, fallbackBranch, parsePlanBranch, planBranchLine } from "../src/naming.ts";

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

describe("naming", () => {
  it("membersihkan pesan commit dari id tugas dan trailer AI", () => {
    expect(cleanCommitMessage("T3: fix(api): tangani nil\n\nBody.\n\nCo-Authored-By: Claude <a@b>\n🤖 Generated with [Claude Code](x)", "cadangan")).toBe(
      "fix(api): tangani nil\n\nBody.",
    );
    expect(cleanCommitMessage("", "Judul tugas")).toBe("Judul tugas");
    expect(cleanCommitMessage(undefined, "Judul tugas")).toBe("Judul tugas");
  });
  it("membaca dan menulis baris Branch di plan.md", () => {
    expect(parsePlanBranch(`# Rencana\n\n${planBranchLine("feat/x-y")}\n`)).toBe("feat/x-y");
    expect(parsePlanBranch("# tanpa branch")).toBeUndefined();
  });
  it("nama cadangan dipotong di batas kata dan tanpa nama orkestrator", () => {
    expect(fallbackBranch("Redesign dashboard user yang lebih tertata, menarik")).toBe("feat/redesign-dashboard-user-yang-lebih");
    expect(fallbackBranch("!!!")).toBe("feat/update");
    expect(acceptableBranch("bondowoso/x")).toBe(false);
    expect(acceptableBranch("feat/x")).toBe(true);
  });
});

describe("dirty-bit per domain", () => {
  const config = { domains: ConfigSchema.parse({ roles: { lead: r, developer: r, reviewer: r } }).domains };
  it("memetakan berkas ke domain", () => {
    expect(touchedDomains(["web/app/pages/a.vue", "api/internal/x.go", "api/internal/x_test.go"], config)).toEqual(["api", "frontend", "testing"]);
  });
  it("commit baru boleh setelah review DAN testing PASS di semua domain yang disentuh", () => {
    const s = emptyState();
    markDirty(s, ["api", "frontend"]);
    expect(exitGate(s, ["api", "frontend"], { review: true, testing: true }).allowed).toBe(false);
    recordResult(s, ["api", "frontend"], "testing", "PASS");
    recordResult(s, ["api"], "review", "PASS");
    expect(exitGate(s, ["api", "frontend"], { review: true, testing: true }).blocked).toEqual(["frontend: review=PENDING, testing=PASS"]);
    recordResult(s, ["frontend"], "review", "FAIL");
    // FAIL di satu domain mengembalikan domain lain ke PENDING.
    expect(s.domains.api).toEqual({ review: "PENDING", testing: "PENDING" });
    expect(exitGate(s, ["api"], { review: false, testing: false }).allowed).toBe(true);
  });
  it("mendeteksi feedback yang berulang", () => {
    const s = emptyState();
    expect(recordFeedbackAndCheckLoop(s, "tambahkan validasi email di handler register")).toBe(false);
    expect(recordFeedbackAndCheckLoop(s, "perbaiki test login yang gagal karena timeout")).toBe(false);
    expect(recordFeedbackAndCheckLoop(s, "tambahkan validasi email di handler register")).toBe(true);
    expect(jaccard("a b c", "x y z")).toBe(1); // kata < 3 huruf diabaikan → sama-sama kosong
  });
});

describe("scan secret", () => {
  const diff = (lines: string[]) => ["+++ b/cfg.ts", "@@ -0,0 +1,9 @@", ...lines.map((l) => `+${l}`)].join("\n");
  it("menemukan kunci dan password di baris yang ditambahkan", () => {
    const f = scanDiffForSecrets(
      diff([
        "const a = 1",
        "aws = 'AKIAQWERTYUIOPASDFGH'",
        "db = 'postgres://app:hunter22@db:5432/x'",
        "-----BEGIN RSA PRIVATE KEY-----",
        "const apiKey = \"sk9f8a7s6d5f4g3h2j1k0l9z\"",
      ]),
    );
    expect(f.map((x) => `${x.line}:${x.kind}`)).toEqual(["2:AWS access key", "3:URL database dengan password", "4:private key", "5:nilai rahasia"]);
  });
  it("mengabaikan placeholder dan baris yang dihapus", () => {
    expect(scanDiffForSecrets(diff(["apiKey = 'your-api-key-here-000000'", "url = 'postgres://user:${PASS}@db/x'"]))).toEqual([]);
    expect(scanDiffForSecrets("+++ b/a\n@@ -1 +1 @@\n-aws = 'AKIAQWERTYUIOPASDFGH'")).toEqual([]);
  });
});

describe("restoreOutside", () => {
  it("mengembalikan berkas di luar wewenang ke kondisi snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "bondowoso-snap-"));
    const g = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@e");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "impl.go"), "v1\n");
    writeFileSync(join(dir, "keep.go"), "asli\n");
    g("add", ".");
    g("commit", "-qm", "awal");
    writeFileSync(join(dir, "impl.go"), "v2 dari developer\n");
    const snap = snapshot(dir, []);
    // "Tester" mengubah implementasi, menambah test, dan menyentuh berkas lain.
    writeFileSync(join(dir, "impl.go"), "diubah tester\n");
    writeFileSync(join(dir, "impl_test.go"), "test\n");
    writeFileSync(join(dir, "keep.go"), "rusak\n");
    const restored = restoreOutside(dir, snap, [], (p) => p.endsWith("_test.go"));
    expect(restored).toEqual(["impl.go", "keep.go"]);
    expect(readFileSync(join(dir, "impl.go"), "utf8")).toBe("v2 dari developer\n");
    expect(readFileSync(join(dir, "keep.go"), "utf8")).toBe("asli\n");
    expect(readFileSync(join(dir, "impl_test.go"), "utf8")).toBe("test\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("lain-lain", () => {
  it("jawaban klarifikasi: nomor, multi, atau teks bebas", () => {
    const q = { question: "?", rationale: "", type: "multi_choice" as const, options: [{ value: "a", label: "A", rationale: "" }, { value: "b", label: "B", rationale: "" }] };
    expect(resolveChoice(q, "1, 2")).toBe("A, B");
    expect(resolveChoice({ ...q, type: "single_choice" }, "2 1")).toBe("B");
    expect(resolveChoice(q, "lainnya saja")).toBe("lainnya saja");
  });
  it("memecah diff per berkas", () => {
    const d = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+1\ndiff --git a/y b/y\n--- a/y\n+++ /dev/null\n@@\n-2\n";
    const m = splitDiffByFile(d);
    expect([...m.keys()]).toEqual(["x", "y"]);
  });
  it("fase dilewati sesuai scope dan mode", () => {
    const c = ConfigSchema.parse({ roles: { lead: r, developer: r, reviewer: r } });
    expect(phasesFor(c, "bugfix", "normal")).toEqual({ simplify: false, test: true, review: true });
    expect(phasesFor(c, "medium", "normal")).toEqual({ simplify: true, test: true, review: true });
    expect(phasesFor(c, "medium", "compact")).toEqual({ simplify: false, test: false, review: false });
  });
});
