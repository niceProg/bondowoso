import { createInterface } from "node:readline/promises";
import type { AskOutput } from "./roles.ts";

type Question = AskOutput["questions"][number];

// Tanya jawab klarifikasi di terminal: pilihan bernomor untuk single/multi
// choice (boleh dijawab bebas kalau tidak ada yang cocok), teks bebas untuk
// sisanya. Hasilnya Markdown yang disisipkan ke prompt Lead dan plan.md.
export async function askQuestions(questions: Question[], io = { input: process.stdin, output: process.stdout }): Promise<string> {
  const rl = createInterface(io);
  const answers: string[] = [];
  try {
    for (const [i, q] of questions.entries()) {
      io.output.write(`\n${i + 1}/${questions.length}. ${q.question}\n`);
      if (q.rationale) io.output.write(`   (${q.rationale})\n`);
      let answer: string;
      if (q.type === "text" || q.options.length === 0) {
        answer = (await rl.question("   Jawaban: ")).trim();
      } else {
        q.options.forEach((o, j) => io.output.write(`   ${j + 1}) ${o.label}${o.rationale ? ` — ${o.rationale}` : ""}\n`));
        const hint = q.type === "multi_choice" ? "nomor, pisahkan dengan koma" : "nomor";
        const raw = (await rl.question(`   Pilih (${hint}, atau ketik jawaban sendiri): `)).trim();
        answer = resolveChoice(q, raw);
      }
      answers.push(`- **${q.question}**\n  ${answer || "(tidak dijawab; Lead memutuskan)"}`);
    }
  } finally {
    rl.close();
  }
  return answers.join("\n");
}

export function resolveChoice(q: Question, raw: string): string {
  if (!raw) return "";
  const nums = raw.split(/[,\s]+/).filter(Boolean);
  if (nums.every((n) => /^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= q.options.length)) {
    const picked = (q.type === "multi_choice" ? nums : nums.slice(0, 1)).map((n) => q.options[Number(n) - 1].label);
    return picked.join(", ");
  }
  return raw;
}
