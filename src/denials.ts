const MAX_DENIED = 30;

interface Denial {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// Ringkas `permission_denials` dari output Claude Code menjadi satu baris per
// aksi: perintah untuk Bash, atau Tool(input) untuk tool lain.
export function describeDenials(denials: unknown[]): string[] {
  return denials.map((raw) => {
    const d = raw as Denial;
    if (d.tool_name === "Bash") return String(d.tool_input?.command ?? "").split("\n")[0].slice(0, 200);
    return `${d.tool_name ?? "?"}(${JSON.stringify(d.tool_input ?? {}).slice(0, 150)})`;
  });
}

export function mergeDenied(existing: string[] | undefined, fresh: string[]): string[] {
  return [...new Set([...(existing ?? []), ...fresh])].slice(0, MAX_DENIED);
}

// Tebak pola developer_bash untuk perintah yang ditolak, mis.
// "cd web && git rm a.vue" → "git rm:*". Hanya saran; manusia yang memutuskan.
export function suggestPattern(command: string): string | undefined {
  const cmd = command.replace(/^\s*cd\s+\S+\s*&&\s*/, "").trim();
  const words = cmd.split(/\s+/);
  if (!words[0] || /[()]/.test(words[0])) return undefined;
  if (words[1] && /^[a-z][\w-]*$/.test(words[1])) return `${words[0]} ${words[1]}:*`;
  return `${words[0]}:*`;
}

export function formatDenied(denied: string[], limit = 8): string {
  const lines = [`Aksi yang ditolak permission (${denied.length}):`];
  for (const d of denied.slice(0, limit)) lines.push(`  - ${d}`);
  if (denied.length > limit) lines.push(`  … dan ${denied.length - limit} lagi`);
  const patterns = [...new Set(denied.map(suggestPattern).filter((p): p is string => !!p))];
  if (patterns.length) {
    lines.push(`Kalau memang perlu, tambahkan ke developer_bash: ${patterns.slice(0, 8).map((p) => `"${p}"`).join(", ")}`);
  }
  return lines.join("\n");
}
