import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

// Pemeriksaan deterministik yang dipakai hook agent. Semua fungsi di sini
// murni atau hanya menyentuh berkas yang diberikan, supaya bisa dites tanpa
// menjalankan Claude Code.

export interface Verdict {
  deny: boolean;
  reason?: string;
}

const ALLOW: Verdict = { deny: false };
const deny = (reason: string): Verdict => ({ deny: true, reason });

// ---------------------------------------------------------------- berkas sensitif

const SAFE_ENV_RE = /^\.env\.(example|sample|template|dist)$/i;
const SENSITIVE_NAME_RE = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^(credentials|secrets?)(\.(json|ya?ml|md|txt|env|toml))?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|pgpass)$/,
  /^service-account.*\.json$/i,
];
const SENSITIVE_DIR_RE = /(^|\/)\.(ssh|aws|gnupg|docker)(\/|$)|(^|\/)\.config\/gh(\/|$)/;

export function isSensitivePath(path: string): boolean {
  const name = basename(path);
  if (SAFE_ENV_RE.test(name)) return false;
  if (SENSITIVE_NAME_RE.some((re) => re.test(name))) return true;
  return SENSITIVE_DIR_RE.test(path);
}

// Path yang disentuh sebuah pemanggilan tool (tanpa Bash).
export function toolPaths(tool: string, input: Record<string, unknown>): string[] {
  const s = (v: unknown) => (typeof v === "string" && v ? [v] : []);
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return s(input.file_path);
    case "NotebookEdit":
      return s(input.notebook_path);
    case "Grep":
    case "Glob":
      return [...s(input.path), ...s(input.glob), ...s(input.pattern).filter(() => tool === "Glob")];
    default:
      return [];
  }
}

export function checkSensitiveFiles(tool: string, input: Record<string, unknown>): Verdict {
  const hit = toolPaths(tool, input).find(isSensitivePath);
  return hit
    ? deny(`Berkas sensitif diblokir: ${hit}. Berkas rahasia (env, kunci, kredensial) tidak boleh dibaca atau diubah agent; pakai nilai contoh atau minta manusia.`)
    : ALLOW;
}

// ---------------------------------------------------------------- perintah shell

const SECRET_COMMAND_RE: [RegExp, string][] = [
  [/(^|[\s;&|(])(printenv|env)\s*($|[;&|)])/, "mencetak seluruh environment"],
  [/(^|[\s;&|(])(export|set)\s*($|[;&|)])/, "mencetak seluruh environment"],
  [/\$\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\}?/i, "membaca variabel rahasia"],
  [/\bsecurity\s+(find|dump)-(generic|internet)-password\b|\bsecurity\s+dump-keychain\b/, "membaca keychain"],
  [/\bgh\s+auth\s+(token|status\s+(-t|--show-token))\b/, "membaca token GitHub"],
  [/\baws\s+configure\s+get\b|\baws\s+sts\s+get-session-token\b/, "membaca kredensial AWS"],
  [/\bgit\s+push\b/, "push dilarang; orkestrator dan manusia yang memutuskan"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "menjalankan skrip dari internet"],
];

export function checkBashCommand(command: string): Verdict {
  for (const [re, why] of SECRET_COMMAND_RE) {
    if (re.test(command)) return deny(`Perintah diblokir (${why}): ${command.split("\n")[0].slice(0, 120)}`);
  }
  // Token yang menunjuk berkas sensitif, mis. `cat .env` atau `source ./.env.local`.
  for (const raw of command.split(/[\s;&|<>()=`'"]+/)) {
    const token = raw.replace(/^@/, "");
    if (token && !token.startsWith("-") && isSensitivePath(token)) {
      return deny(`Perintah menyentuh berkas sensitif (${token}); tidak diizinkan untuk agent.`);
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------- compaction gate

const TAIL_BYTES = 1024 * 1024;

// Jumlah token konteks dari pesan asisten terakhir di transcript JSONL.
export function contextTokens(transcriptPath: string): number | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { usage?: Record<string, number> } };
        const u = entry.type === "assistant" ? entry.message?.usage : undefined;
        if (u) {
          return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
      } catch {
        // baris terpotong di awal jendela baca
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function checkCompaction(tokens: number | undefined, window: number, blockPct: number): Verdict {
  if (tokens === undefined || window <= 0) return ALLOW;
  const pct = Math.round((tokens / window) * 100);
  if (pct <= blockPct) return ALLOW;
  return deny(
    `Konteks sudah ${pct}% (${tokens}/${window} token), melewati batas ${blockPct}%. Jangan memanggil tool lagi: ` +
      "berhenti sekarang dan kembalikan structured output. Kalau tugas belum selesai, pakai status \"blocked\" dan " +
      "jelaskan apa yang sudah dan belum dikerjakan; perubahanmu disimpan dan dilanjutkan agent baru.",
  );
}

// ---------------------------------------------------------------- penguncian berkas

export interface LockOwner {
  task: string;
  path: string;
}

function lockDir(locksDir: string, path: string): string {
  return join(locksDir, createHash("sha1").update(path).digest("hex").slice(0, 20));
}

// First-writer-wins: tugas pertama yang menulis sebuah path memegang kuncinya
// sampai orkestrator melepasnya. Memakai mkdir yang atomik di sistem berkas.
export function claimLock(locksDir: string, task: string, path: string): LockOwner | undefined {
  mkdirSync(locksDir, { recursive: true });
  const dir = lockDir(locksDir, path);
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ task, path }));
    return undefined;
  } catch {
    try {
      const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as LockOwner;
      return owner.task === task ? undefined : owner;
    } catch {
      return undefined; // kunci sedang ditulis pemiliknya; anggap bebas daripada macet
    }
  }
}

export function checkLock(locksDir: string, task: string, root: string, tool: string, input: Record<string, unknown>): Verdict {
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) return ALLOW;
  for (const p of toolPaths(tool, input)) {
    const abs = isAbsolute(p) ? p : resolve(root, p);
    const rel = relative(root, abs);
    if (rel.startsWith("..")) continue;
    const owner = claimLock(locksDir, task, rel);
    if (owner) {
      return deny(
        `${rel} sedang dikerjakan tugas ${owner.task} secara paralel (dikunci lebih dulu). Jangan ubah berkas ini; ` +
          "selesaikan bagian lain, dan kalau tugasmu memang butuh berkas ini, kembalikan status \"blocked\" dengan alasannya.",
      );
    }
  }
  return ALLOW;
}

// Lepas semua kunci milik sebuah tugas (dipanggil orkestrator setelah tugas
// selesai, blocked, atau terputus).
export function releaseLocks(locksDir: string, task: string): void {
  if (!existsSync(locksDir)) return;
  for (const entry of readdirSync(locksDir)) {
    const dir = join(locksDir, entry);
    try {
      const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as LockOwner;
      if (owner.task === task) rmSync(dir, { recursive: true, force: true });
    } catch {
      // kunci setengah jadi atau sudah dilepas
    }
  }
}
