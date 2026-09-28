import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approveReview, calls, cleanup, cli, committedFiles, dev, gitLog, gitOut, h, manifest, PLAN, setup, task } from "./helpers.ts";

let home = "";
beforeAll(() => {
  // realpath: di macOS /var adalah symlink ke /private/var, dan cwd proses agent
  // dilaporkan dalam bentuk aslinya.
  home = realpathSync(mkdtempSync(join(tmpdir(), "bondowoso-home-")));
  process.env.BONDOWOSO_HOME = home;
});
afterAll(() => {
  delete process.env.BONDOWOSO_HOME;
  rmSync(home, { recursive: true, force: true });
});
afterEach(cleanup);

const worktreesLeft = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      if (depth === 0) out.push(join(dir, e));
      else walk(join(dir, e), depth - 1);
    }
  };
  walk(join(home, "worktrees"), 2);
  return out;
};

describe("work --parallel", () => {
  it("tugas independen dikerjakan bersamaan di worktree terpisah lalu digabung", () => {
    const t1 = { ...task("T1"), files_hint: ["a.txt"] };
    const t2 = { ...task("T2"), files_hint: ["b.txt"] };
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [t1, t2] } }],
      "developer:T1": [dev({ "a.txt": "A\n" }, "feat: a")],
      "developer:T2": [dev({ "b.txt": "B\n" }, "feat: b")],
      "reviewer:T1": [approveReview],
      "reviewer:T2": [approveReview],
    });
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work", "--parallel", "2");
    expect(r.code, r.out).toBe(0);
    expect(manifest().tasks.map((t: any) => t.status)).toEqual(["done", "done"]);
    expect(gitLog()).toEqual(expect.arrayContaining(["feat: a", "feat: b"]));
    expect(committedFiles()).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
    expect(gitOut("status", "--porcelain", "--untracked-files=no")).toBe("");

    // Agent bekerja di worktree masing-masing, dengan hook kunci berkas aktif.
    const devs = calls("developer") as unknown as { cwd: string; task: string; hook: { locks_dir?: string } }[];
    expect(new Set(devs.map((c) => c.cwd)).size).toBe(2);
    for (const c of devs) {
      expect(c.cwd.startsWith(join(home, "worktrees"))).toBe(true);
      expect(c.hook.locks_dir).toContain(join(home, "locks"));
    }
    expect(worktreesLeft()).toEqual([]);
    expect(readdirSync(join(home, "worktrees"))).toEqual([]);
    expect(gitOut("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("bentrok saat digabung: tugas diulang dari HEAD terbaru lalu masuk", () => {
    const t1 = { ...task("T1"), files_hint: ["x"] };
    const t2 = { ...task("T2"), files_hint: ["y"] };
    setup({
      lead: [{ output: PLAN }, { output: { tasks: [t1, t2] } }],
      "developer:T1": [dev({ "shared.txt": "dari T1\n" }, "feat: t1"), dev({ "shared.txt": "dari T1\nlagi\n" }, "feat: t1")],
      "developer:T2": [dev({ "shared.txt": "dari T2\n" }, "feat: t2"), dev({ "shared.txt": "dari T2\nlagi\n" }, "feat: t2")],
      "reviewer:T1": [approveReview, approveReview],
      "reviewer:T2": [approveReview, approveReview],
    });
    cli("plan", "fitur");
    cli("approve");
    const r = cli("work", "--parallel", "2");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("bentrok saat digabung ke branch kerja; diulang");
    const tasks = manifest().tasks;
    expect(tasks.map((t: any) => t.status)).toEqual(["done", "done"]);
    const conflicted = tasks.find((t: any) => t.history.some((x: any) => x.result === "conflict"));
    expect(conflicted).toBeDefined();
    expect(existsSync(join(h.repo, ".bondowoso", conflicted.last_patch))).toBe(true);
    expect(readFileSync(join(h.repo, "shared.txt"), "utf8")).toMatch(/lagi\n$/);
    expect(worktreesLeft()).toEqual([]);
  });
});
