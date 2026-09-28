import type { Config } from "./config.ts";

// Dirty-bit per domain, mengikuti feedback loop Jonggrang: setiap perubahan
// Developer membuat domain yang disentuh "kotor"; bit itu baru bersih kalau
// Reviewer DAN Tester sama-sama PASS untuk domain tersebut. FAIL di satu domain
// mengembalikan domain lain ke PENDING, karena perbaikannya bisa merembet.

export type PhaseStatus = "PENDING" | "PASS" | "FAIL";
export type LoopPhase = "review" | "testing";

export interface DomainState {
  review: PhaseStatus;
  testing: PhaseStatus;
}

export interface FeedbackState {
  domains: Record<string, DomainState>;
  outputs: string[]; // feedback terakhir, untuk deteksi loop
}

export function domainOf(path: string, config: Pick<Config, "domains">): string {
  for (const d of config.domains) {
    if (new RegExp(d.match).test(path)) return d.name;
  }
  return "backend";
}

export function touchedDomains(files: string[], config: Pick<Config, "domains">): string[] {
  return [...new Set(files.map((f) => domainOf(f, config)))].sort();
}

export function emptyState(): FeedbackState {
  return { domains: {}, outputs: [] };
}

export function markDirty(state: FeedbackState, domains: string[]): void {
  for (const d of domains) state.domains[d] = { review: "PENDING", testing: "PENDING" };
}

export function recordResult(state: FeedbackState, domains: string[], phase: LoopPhase, status: PhaseStatus): void {
  for (const d of domains) {
    state.domains[d] ??= { review: "PENDING", testing: "PENDING" };
    state.domains[d][phase] = status;
  }
  if (status === "FAIL") {
    for (const [d, s] of Object.entries(state.domains)) {
      if (!domains.includes(d)) {
        s.review = "PENDING";
        s.testing = "PENDING";
      }
    }
  }
}

// Boleh commit kalau setiap domain yang disentuh lolos semua fase yang aktif.
export function exitGate(
  state: FeedbackState,
  domains: string[],
  required: { review: boolean; testing: boolean },
): { allowed: boolean; blocked: string[] } {
  const blocked: string[] = [];
  for (const d of domains) {
    const s = state.domains[d] ?? { review: "PENDING", testing: "PENDING" };
    const bad = (required.review && s.review !== "PASS") || (required.testing && s.testing !== "PASS");
    if (bad) blocked.push(`${d}: review=${required.review ? s.review : "skip"}, testing=${required.testing ? s.testing : "skip"}`);
  }
  return { allowed: blocked.length === 0, blocked };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

export function jaccard(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

// Deteksi loop seperti Jonggrang: feedback yang ≥ 90% mirip dengan salah satu
// dari 5 feedback terakhir, setelah minimal 3 feedback tercatat.
export function recordFeedbackAndCheckLoop(state: FeedbackState, text: string): boolean {
  const recent = state.outputs.slice(-5);
  const looping = state.outputs.length >= 2 && recent.some((o) => jaccard(o, text) >= 0.9);
  state.outputs = [...state.outputs, text.slice(0, 2000)].slice(-5);
  return looping;
}
