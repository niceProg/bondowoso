// Nama branch dan pesan commit harus terlihat seperti buatan developer biasa:
// tanpa id tugas, tanpa nama orkestrator, tanpa trailer AI.

const TOOLING_RE = /bondowoso|orchestrat/i;
const TRAILER_RE = /^(co-authored-by|signed-off-by|generated-by|generated with)\b|claude code|🤖/i;

export function cleanCommitMessage(raw: string | undefined, fallback: string): string {
  const lines = (raw ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !TRAILER_RE.test(line.trim()));
  // Buang id tugas di depan subject kalau agent tetap menulisnya ("T3: ...").
  lines[0] = (lines[0] ?? "").replace(/^\s*T\d+\s*[:\-–]\s*/, "").trim();
  const message = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return message || fallback;
}

const BRANCH_LINE_RE = /^\*\*Branch:\*\*\s*`([^`\n]+)`/m;

export function planBranchLine(name: string): string {
  return `**Branch:** \`${name}\``;
}

export function parsePlanBranch(plan: string): string | undefined {
  return BRANCH_LINE_RE.exec(plan)?.[1]?.trim() || undefined;
}

// Nama cadangan kalau Lead tidak memberi nama yang layak: feat/<5 kata awal>.
export function fallbackBranch(request: string): string {
  const words = request
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 5);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 40) break;
    slug = next;
  }
  return `feat/${slug || "update"}`;
}

export function acceptableBranch(name: string | undefined): name is string {
  return !!name && !TOOLING_RE.test(name);
}
