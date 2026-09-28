import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveReview, calls, cleanup, cli, committedFiles, dev, gitLog, h, manifest, PLAN, rejectReview, setup, task } from "./helpers.ts";

afterEach(cleanup);

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: h.repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const FULL = { config: { pipeline: { simplify: true, test: true }, memory: { enabled: false } } };
const TESTS_ONLY = { config: { pipeline: { simplify: false, test: true }, memory: { enabled: false } } };

const testPlan = (...ids: string[]) => ({
  output: {
    tasks: ids.map((id) => ({
      task_id: id,
      test_files: ["tests/app.test.txt"],
      cases: [{ id: "tc-001", title: "app berisi good", type: "unit", input: "-", expected: "good", mocks: [] }],
      notes: "",
    })),
  },
});
const testerOk = (write: Record<string, string>, commit_message = "") => ({
  write,
  output: { status: "pass", summary: "Test lulus.", test_files: Object.keys(write), total: 2, passed: 2, failed: 0, failed_tests: [], bugs: [], blocked_reason: "", commit_message },
});
const testerBug = {
  write: { "tests/app.test.txt": "gagal\n" },
  output: {
    status: "fail",
    summary: "Ada bug.",
    test_files: ["tests/app.test.txt"],
    total: 2,
    passed: 1,
    failed: 1,
    failed_tests: ["app harus berisi baris fixed"],
    bugs: [{ file: "app.txt", line: 1, description: "baris fixed belum ada" }],
    blocked_reason: "",
    commit_message: "",
  },
};
const simplifyOut = (write: Record<string, string>) => ({ write, output: { summary: "Rapikan.", changed_files: Object.keys(write), commit_message: "" } });

describe("pipeline lengkap: implement → simplify → test → review", () => {
  it("menjalankan semua fase, membatasi Simplifier dan Tester pada wewenangnya, lalu satu commit", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        test_lead: [testPlan("T1")],
        developer: [dev({ "app.txt": "good\n" }, "feat(app): tambah app")],
        simplifier: [simplifyOut({ "app.txt": "good\n", "other.txt": "di luar tugas\n" })],
        tester: [testerOk({ "tests/app.test.txt": "ok\n", "app.txt": "diubah tester\n" })],
        reviewer: [approveReview],
      },
      {},
      FULL,
    );
    cli("plan", "fitur");
    expect(cli("approve").code).toBe(0);
    expect(manifest().tasks[0].test_plan.cases[0].id).toBe("tc-001");

    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("perubahan Simplifier di luar berkas tugas dikembalikan: other.txt");
    expect(r.out).toContain("perubahan Tester di luar berkas test dikembalikan: app.txt");
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("good\n");
    expect(existsSync(join(h.repo, "other.txt"))).toBe(false);
    expect(committedFiles()).toEqual(expect.arrayContaining(["app.txt", "tests/app.test.txt"]));
    expect(gitLog()[0]).toBe("feat(app): tambah app");
    expect(calls("tester")[0].prompt).toContain("tc-001");
    // Skill inti ikut disisipkan ke Developer.
    expect(calls("developer")[0].prompt).toContain("iterating-to-completion");
    const steps = manifest().tasks[0].history.map((x: any) => `${x.step}:${x.result}`);
    expect(steps).toEqual(expect.arrayContaining(["simplifier:ok", "tester:pass", "reviewer:approve", "secrets:pass"]));
    expect(manifest().tasks[0].feedback_loop.domains).toMatchObject({ backend: { review: "PASS", testing: "PASS" } });
  });

  it("bug yang ditemukan Tester dikembalikan ke Developer", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        test_lead: [testPlan("T1")],
        developer: [dev({ "app.txt": "good\n" }), dev({ "app.txt": "good\nfixed\n" })],
        tester: [testerBug, testerOk({ "tests/app.test.txt": "ok\n" })],
        reviewer: [approveReview],
      },
      {},
      TESTS_ONLY,
    );
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(calls("developer")[1].prompt).toContain("Bug di implementasi");
    expect(calls("developer")[1].prompt).toContain("baris fixed belum ada");
    expect(manifest().tasks[0].attempts).toBe(2);
  });

  it("Simplify yang membuat gate merah dibatalkan, tugas tetap lanjut", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        developer: [dev({ "app.txt": "good\n" })],
        simplifier: [simplifyOut({ "app.txt": "bad\n" })],
        reviewer: [approveReview],
      },
      {},
      { config: { pipeline: { simplify: true, test: false }, memory: { enabled: false } } },
    );
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("perubahan Simplifier dibatalkan");
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("good\n");
  });

  it("secret di diff menahan commit sampai dibersihkan", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [
        dev({ "app.txt": "good\n", "config.txt": "aws_key = AKIAQWERTYUIOPASDFGH\n" }),
        dev({ "app.txt": "good\n", "config.txt": "aws_key dibaca dari env\n" }),
      ],
      reviewer: [approveReview],
    });
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(calls("developer")[1].prompt).toContain("AWS access key");
    expect(readFileSync(join(h.repo, "config.txt"), "utf8")).not.toContain("AKIA");
  });

  it("feedback yang berulang sama dianggap loop dan dihentikan lebih awal", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        developer: [dev({ "app.txt": "good\n" }), dev({ "app.txt": "good\n1\n" }), dev({ "app.txt": "good\n2\n" })],
        reviewer: [rejectReview, rejectReview, rejectReview],
      },
      { max_attempts: 5 },
    );
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work");
    expect(r.code).toBe(2);
    expect(manifest().tasks[0]).toMatchObject({ status: "blocked", attempts: 3 });
    expect(manifest().tasks[0].blocked_reason).toContain("Loop terdeteksi");
  });
});

describe("work --compact / --full / --task", () => {
  it("--compact menunda test+review; --full menjalankannya jadi commit susulan", () => {
    setup(
      {
        lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
        test_lead: [testPlan("T1")],
        developer: [dev({ "app.txt": "good\n" }, "feat(app): tambah app")],
        tester: [testerOk({ "tests/app.test.txt": "ok\n" }, "test(app): uji isi app")],
        reviewer: [approveReview],
      },
      {},
      TESTS_ONLY,
    );
    cli("plan", "fitur");
    cli("approve");
    const compact = cli("work", "--compact");
    expect(compact.code, compact.out).toBe(0);
    expect(manifest().tasks[0].deferred).toEqual(["test", "review"]);
    expect(compact.out).toContain("work --full");
    expect(existsSync(`${h.scriptPath}.calls.jsonl`) && calls("tester")).toHaveLength(0);

    const full = cli("work", "--full");
    expect(full.code, full.out).toBe(0);
    expect(gitLog().slice(0, 2)).toEqual(["test(app): uji isi app", "feat(app): tambah app"]);
    expect(manifest().tasks[0].deferred).toBeUndefined();
    expect(manifest().tasks[0].followup_commit).toMatch(/^[0-9a-f]{7}$/);
    expect(calls("developer")).toHaveLength(1);
  });

  it("--task hanya mengerjakan tugas itu dan dependensinya", () => {
    const t3 = { ...task("T3"), files_hint: ["c.txt"] };
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1"), task("T2", ["T1"]), t3] } }],
      developer: [dev({ "app.txt": "good\n" }), dev({ "app.txt": "good\nlagi\n" })],
      reviewer: [approveReview, approveReview],
    });
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work", "--task", "T2");
    expect(r.code, r.out).toBe(0);
    expect(manifest().tasks.map((t: any) => t.status)).toEqual(["done", "done", "pending"]);
  });
});

describe("perencanaan lanjutan", () => {
  it("--deep menjalankan discovery, analisis, lalu rencana; --src ikut dikirim", () => {
    setup({
      lead: [
        { output: { discovery_markdown: "## Temuan\n- app.txt dibaca gate" } },
        { output: { scope: "small", analysis_markdown: "## Pendekatan\n1. tulis langsung (dipilih)" } },
        { output: PLAN },
      ],
      developer: [],
      reviewer: [],
    });
    const src = join(h.repo, "..", `${h.repo.split("/").pop()}-brd.md`);
    writeFileSync(src, "BRD: app harus berisi good\n");
    const r = cli("plan", "--deep", "--src", src, "fitur");
    expect(r.code, r.out).toBe(0);
    const lead = calls("lead");
    expect(lead).toHaveLength(3);
    expect(lead[0].prompt).toContain("BRD: app harus berisi good");
    expect(lead[2].prompt).toContain("Deep planning: discovery notes");
    expect(lead[2].prompt).toContain("tulis langsung (dipilih)");
    expect(readFileSync(join(h.repo, ".bondowoso", "plan.md"), "utf8")).toContain("_Mode: deep_");
  });

  it("--append menambah tugas ke rencana yang sudah jalan", () => {
    const t2 = { ...task("T2", ["T1"]), files_hint: ["b.txt"] };
    setup({
      lead: [
        { output: PLAN },
        { output: { tasks: [task("T1")] } },
        { output: { ...PLAN, summary: "Tambah b.txt.", plan_markdown: "## Langkah\n\n- buat b.txt" } },
        { output: { tasks: [t2] } },
      ],
      developer: [dev({ "app.txt": "good\n" }, "feat: app"), dev({ "b.txt": "b\n" }, "feat: b")],
      reviewer: [approveReview, approveReview],
    });
    cli("plan", "fitur");
    cli("approve");
    expect(cli("work").code).toBe(0);

    expect(cli("plan", "--append", "tambah", "b").code).toBe(0);
    expect(readFileSync(join(h.repo, ".bondowoso", "plan.md"), "utf8")).toContain("## Tambahan 1: tambah b");
    expect(cli("work").out).toContain("belum dipecah");
    expect(cli("approve").code).toBe(0);
    expect(calls("lead")[3].prompt).toContain("Existing tasks");
    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(manifest().tasks.map((t: any) => `${t.id}:${t.status}`)).toEqual(["T1:done", "T2:done"]);
    expect(gitLog().slice(0, 2)).toEqual(["feat: b", "feat: app"]);
  });

  it("--revise menulis ulang plan yang belum di-approve", () => {
    setup({
      lead: [{ output: PLAN }, { output: { ...PLAN, plan_markdown: "## Langkah\n\n- versi revisi" } }],
      developer: [],
      reviewer: [],
    });
    cli("plan", "fitur");
    expect(cli("plan", "--revise", "buat lebih ringkas").code).toBe(0);
    expect(calls("lead")[1].prompt).toContain("buat lebih ringkas");
    expect(readFileSync(join(h.repo, ".bondowoso", "plan.md"), "utf8")).toContain("versi revisi");
  });

  it("--base memotong branch kerja dari branch lain; --yes langsung approve", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [dev({ "app.txt": "good\n" })],
      reviewer: [approveReview],
    });
    const g = git;
    g("switch", "-q", "-c", "develop");
    writeFileSync(join(h.repo, "dev.txt"), "develop\n");
    g("add", "dev.txt");
    g("commit", "-q", "-m", "develop saja");
    g("switch", "-q", "main");

    const p = cli("plan", "--base", "develop", "--yes", "fitur");
    expect(p.code, p.out).toBe(0);
    expect(manifest().tasks).toHaveLength(1);
    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(gitLog()).toContain("develop saja");
  });

  it("`work <permintaan> --yes` menjalankan plan, approve, dan work sekaligus", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [task("T1")] } }],
      developer: [dev({ "app.txt": "good\n" })],
      reviewer: [approveReview],
    });
    const r = cli("work", "fitur", "sekali", "jalan", "--yes");
    expect(r.code, r.out).toBe(0);
    expect(manifest().tasks[0].status).toBe("done");
  });
});

describe("skill dan memory", () => {
  it("skill yang ditetapkan Lead dan skill proyek disisipkan ke prompt", () => {
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [{ ...task("T1"), skills: ["go-idioms", "tidak-ada"] }] } }],
      developer: [dev({ "app.txt": "good\n" })],
      reviewer: [approveReview],
    });
    mkdirSync(join(h.repo, ".bondowoso", "skills", "custom"), { recursive: true });
    writeFileSync(
      join(h.repo, ".bondowoso", "skills", "custom", "SKILL.md"),
      "---\nname: aturan-proyek\ndescription: aturan khusus repo ini\ntier: library\ntrigger: kerjakan\n---\nSelalu tulis good di baris pertama.\n",
    );
    cli("plan", "fitur");
    cli("approve");
    expect(calls("lead")[1].prompt).toContain("aturan-proyek: aturan khusus repo ini");
    expect(manifest().tasks[0].skills).toEqual(["go-idioms"]);
    expect(cli("work").code).toBe(0);
    const prompt = calls("developer")[0].prompt;
    expect(prompt).toContain("### go-idioms");
    expect(prompt).toContain("Selalu tulis good di baris pertama.");
  });

  it("fragmen tugas di-compact dan dipromosikan ke MEMORY.md, lalu dipakai run berikutnya", () => {
    const withLesson = { ...dev({ "app.txt": "good\n" }), output: { ...dev({}).output, lessons: ["gate membaca baris pertama app.txt"] } };
    setup(
      {
        lead: [
          { output: PLAN },
          { output: { tasks: [task("T1")] } },
          { output: { markdown: "## Context\nRun pertama.\n\n## Lessons Learned\n- gate membaca baris pertama app.txt" } },
          { output: { markdown: "## Conventions\n- Baris pertama app.txt harus good (run-1)\n\n## Known Pitfalls\n\n## Architectural Decisions\n\n## Repeated Lessons\n" } },
          { output: PLAN },
        ],
        developer: [withLesson],
        reviewer: [approveReview],
      },
      {},
      { config: { pipeline: { simplify: false, test: false }, memory: { enabled: true } } },
    );
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work");
    expect(r.code, r.out).toBe(0);
    expect(calls("lead")[2].prompt).toContain("gate membaca baris pertama app.txt");
    const mem = readFileSync(join(h.repo, ".bondowoso", "MEMORY.md"), "utf8");
    expect(mem).toContain("Baris pertama app.txt harus good");
    expect(manifest().memory_done).toBe(true);
    expect(cli("memory", "recall", "baris", "pertama").out).toContain("Baris pertama app.txt harus good");

    cli("plan", "fitur", "berikutnya");
    expect(calls("lead")[4].prompt).toContain("Project memory");
    expect(calls("lead")[4].prompt).toContain("Baris pertama app.txt harus good");
  });
});
