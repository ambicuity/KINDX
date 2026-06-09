function fenceRegex(marker: string): RegExp {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<!--\\s*${m}:start\\s+v=\\d+\\s*-->[\\s\\S]*?<!--\\s*${m}:end\\s*-->`,
    "g",
  );
}

export function readFence(text: string, marker: string): string | null {
  const match = fenceRegex(marker).exec(text);
  if (!match) return null;
  const block = match[0];
  const inner = block
    .replace(new RegExp(`^<!--\\s*${marker}:start\\s+v=\\d+\\s*-->\\n?`), "")
    .replace(new RegExp(`\\n?<!--\\s*${marker}:end\\s*-->$`), "");
  return inner.trim();
}

export function upsertFence(text: string, marker: string, body: string, version = 1): string {
  const block = `<!-- ${marker}:start v=${version} -->\n${body.trim()}\n<!-- ${marker}:end -->`;
  if (fenceRegex(marker).test(text)) {
    return text.replace(fenceRegex(marker), block);
  }
  const sep = text.endsWith("\n") ? "\n" : "\n\n";
  return text + sep + block + "\n";
}
