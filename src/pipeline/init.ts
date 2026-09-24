import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Ctx } from "../config.ts";
import { log } from "../log.ts";

interface DetectedGate {
  name: string;
  cwd: string;
  run: string;
}

// Cari proyek Node/Go di root dan satu tingkat di bawahnya (monorepo seperti
// api/ + web/), lalu tebak gate dan izin Bash Developer dari sana.
function detect(root: string): { gates: DetectedGate[]; bash: Set<string> } {
  const gates: DetectedGate[] = [];
  const bash = new Set<string>();
  const dirs = ["."];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") dirs.push(entry.name);
  }
  for (const dir of dirs) {
    const abs = join(root, dir);
    const prefix = dir === "." ? "" : `${dir}-`;
    if (existsSync(join(abs, "go.mod"))) {
      gates.push({ name: `${prefix}gofmt`, cwd: dir, run: 'test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }' });
      gates.push({ name: `${prefix}vet`, cwd: dir, run: "go vet ./..." });
      gates.push({ name: `${prefix}test`, cwd: dir, run: "go test ./..." });
      for (const p of ["go build:*", "go test:*", "go vet:*", "gofmt:*", "go mod tidy:*"]) bash.add(p);
    }
    const pkgPath = join(abs, "package.json");
    if (existsSync(pkgPath)) {
      const scripts: Record<string, string> = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
      for (const s of ["lint", "typecheck", "test"]) {
        if (!scripts[s] || /no test specified/.test(scripts[s])) continue;
        gates.push({ name: `${prefix}${s}`, cwd: dir, run: s === "test" ? "npm test" : `npm run ${s}` });
      }
      for (const p of ["npm run:*", "npm test:*"]) bash.add(p);
    }
  }
  return { gates, bash };
}

export function init(ctx: Ctx): void {
  if (existsSync(ctx.configPath)) {
    log.warn(`${ctx.configPath} sudah ada, tidak ditimpa.`);
    return;
  }
  mkdirSync(ctx.stateDir, { recursive: true });
  const { gates, bash } = detect(ctx.root);

  const config = {
    language: "Indonesian",
    gates,
    roles: {
      lead: { model: "claude-opus-5", effort: "high" },
      developer: { model: "claude-sonnet-5", effort: "xhigh" },
      reviewer: { model: "claude-opus-5", effort: "medium" },
    },
    developer_bash: [...bash],
    limits: { max_attempts: 3, gate_output_tail: 150, agent_timeout_min: 45, max_diff_chars: 150000 },
    git: { branch_prefix: "bondowoso/" },
  };
  const header = [
    "# Konfigurasi Bondowoso. Gate dijalankan berurutan oleh orkestrator setelah",
    "# setiap tugas; semuanya harus lulus sebelum Reviewer dipanggil.",
    "# `developer_bash` = pola Bash yang boleh dijalankan Developer tanpa bertanya.",
    "",
  ].join("\n");
  writeFileSync(ctx.configPath, header + stringify(config, { lineWidth: 0 }));
  // Hanya config.yaml yang layak di-commit; state run tetap lokal.
  writeFileSync(join(ctx.stateDir, ".gitignore"), "*\n!.gitignore\n!config.yaml\n");

  log.ok(`Dibuat ${ctx.configPath}`);
  if (gates.length) {
    for (const g of gates) log.info(`  gate ${g.name}: (${g.cwd}) ${g.run}`);
  } else {
    log.warn("Tidak ada gate terdeteksi. Isi `gates` di config.yaml secara manual.");
  }
  log.info("Periksa dan rapikan config.yaml, lalu jalankan `bondowoso plan \"<permintaan>\"`.");
}
