import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../src/config.ts";
import { draftPath, readRequest, stripComments } from "../src/request.ts";

let ctx: Ctx;
let root = "";
const saved = { visual: process.env.VISUAL, editor: process.env.EDITOR, tty: process.stdin.isTTY };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bondowoso-req-"));
  ctx = makeCtx(root);
  mkdirSync(ctx.stateDir);
  delete process.env.VISUAL;
  // Editor dijalankan tanpa terminal di test, jadi pura-pura ada TTY.
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  // process.env mengubah undefined menjadi string "undefined", jadi hapus saja.
  if (saved.editor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = saved.editor;
  if (saved.visual !== undefined) process.env.VISUAL = saved.visual;
  Object.defineProperty(process.stdin, "isTTY", { value: saved.tty, configurable: true });
});

describe("stripComments", () => {
  it("membuang blok komentar HTML dan spasi di tepi", () => {
    expect(stripComments("<!-- a\nb -->\n\nhalo\n<!-- c -->\n")).toBe("halo");
  });
});

describe("readRequest dari editor", () => {
  it("memakai isi yang ditulis editor, tanpa komentar petunjuk", () => {
    process.env.EDITOR = `printf 'Tambah ekspor CSV\\n\\n- kolom nama\\n' >>`;
    expect(readRequest(ctx, { words: [] })).toBe("Tambah ekspor CSV\n\n- kolom nama");
  });

  it("membatalkan kalau editor ditutup tanpa menulis apa pun", () => {
    process.env.EDITOR = "true";
    expect(() => readRequest(ctx, { words: [] })).toThrow(/kosong/);
    // Draf tetap ada supaya bisa dilanjutkan.
    expect(readFileSync(draftPath(ctx), "utf8")).toContain("<!--");
  });

  it("membuka draf sebelumnya kalau masih ada", () => {
    writeFileSync(draftPath(ctx), "draf lama\n");
    process.env.EDITOR = "true";
    expect(readRequest(ctx, { words: [] })).toBe("draf lama");
  });

  it("membatalkan kalau editor keluar dengan error", () => {
    process.env.EDITOR = "false";
    expect(() => readRequest(ctx, { words: [] })).toThrow(/keluar dengan error/);
  });
});
