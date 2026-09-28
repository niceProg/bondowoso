// Pemeriksaan akhir sebelum commit: cari secret di baris yang DITAMBAHKAN
// sebuah diff. Polanya mengikuti sanitize-output Jonggrang, ditambah pola
// umum `key = "nilai-panjang"`. Nilai contoh yang jelas palsu diabaikan.

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
}

const PATTERNS: [string, RegExp][] = [
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["AWS secret key", /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}/i],
  ["private key", /-----BEGIN [A-Z ]*(PRIVATE|OPENSSH|EC) KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["URL database dengan password", /\b(postgres(ql)?|mongodb(\+srv)?|mysql|redis):\/\/[^:\s/]+:[^@\s]{3,}@/i],
  ["token GitHub", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["kunci API Stripe/Slack", /\b(sk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/],
  ["nilai rahasia", /\b(api[_-]?key|secret|token|passw(or)?d)\w*\s*[:=]\s*['"][A-Za-z0-9/+_\-.]{16,}['"]/i],
];

const PLACEHOLDER_RE = /(example|sample|dummy|placeholder|changeme|your[_-]|xxxx|test|fake|<[^>]+>|\$\{)/i;

export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      for (const [kind, re] of PATTERNS) {
        const m = re.exec(text);
        if (m && !PLACEHOLDER_RE.test(m[0])) {
          findings.push({ file, line, kind });
          break;
        }
      }
      line++;
    } else if (!raw.startsWith("-")) {
      line++;
    }
  }
  return findings;
}

export function formatSecretFindings(findings: SecretFinding[]): string {
  return [
    "Pemeriksaan secret sebelum commit menemukan nilai yang tampak seperti rahasia. Hapus dan ganti dengan konfigurasi/env; jangan pernah meng-commit rahasia:",
    ...findings.map((f) => `- ${f.file}:${f.line}: ${f.kind}`),
  ].join("\n");
}
