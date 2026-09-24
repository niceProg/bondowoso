import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "./config.ts";

export interface RequestSource {
  words: string[];
  file?: string;
}

const EDITOR_HINT = `<!--
Tulis permintaan untuk Bondowoso di bawah komentar ini, lalu simpan dan tutup editor.
Boleh beberapa paragraf dan pakai Markdown. Blok komentar seperti ini diabaikan.
Kalau dibiarkan kosong, plan dibatalkan.
-->
`;

// Draf dari editor disimpan di sini, jadi tidak hilang kalau plan gagal dan
// akan dibuka lagi pada `bondowoso plan` berikutnya.
export function draftPath(ctx: Ctx): string {
  return join(ctx.stateDir, "request.md");
}

export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function readRequest(ctx: Ctx, source: RequestSource): string {
  if (source.file && source.words.length > 0) {
    throw new Error("Pilih salah satu: teks permintaan atau --file, jangan keduanya.");
  }
  if (source.words.length > 0) return source.words.join(" ").trim();
  if (source.file) {
    const path = resolve(source.file);
    if (!existsSync(path)) throw new Error(`File permintaan tidak ditemukan: ${path}`);
    const text = stripComments(readFileSync(path, "utf8"));
    if (!text) throw new Error(`File permintaan kosong: ${path}`);
    return text;
  }
  return fromEditor(ctx);
}

function fromEditor(ctx: Ctx): string {
  if (!process.stdin.isTTY) {
    throw new Error('Tidak ada terminal untuk membuka editor. Pakai `bondowoso plan "<permintaan>"` atau `--file <path>`.');
  }
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const path = draftPath(ctx);
  if (!existsSync(path)) writeFileSync(path, `${EDITOR_HINT}\n`);

  // Lewat sh supaya EDITOR yang berisi argumen (mis. "code --wait") tetap jalan.
  const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", path], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    throw new Error(`Editor "${editor}" keluar dengan error; plan dibatalkan. Drafnya tetap di ${path}.`);
  }
  const text = stripComments(readFileSync(path, "utf8"));
  if (!text) throw new Error("Permintaan kosong, plan dibatalkan.");
  return text;
}
