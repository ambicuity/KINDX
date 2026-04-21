import { posix } from "node:path";
import { handelize } from "./repository.js";

/**
 * Extracts and normalizes target paths from markdown text.
 * @param content The text content of the markdown file.
 * @param sourcePath The relative repository path of the source file (e.g. "docs/guide.md").
 * @returns Array of relative target document normalized paths (e.g. "docs/api.md").
 */
export function extractInternalLinks(content: string, sourcePath: string): string[] {
  const targets = new Set<string>();

  // Strip code blocks to avoid extracting links from within code examples
  const codeBlockStripped = content.replace(/```[\s\S]*?```/g, "");

  const addTarget = (target: string | undefined) => {
    if (!target) return;
    let t = target.split("#")[0]?.trim(); // Strip intra-page anchors
    if (!t) return;
    
    // Ignore external URLs
    if (/^[a-z]+:\/\//i.test(t)) return;
    if (t.startsWith("mailto:")) return;
    if (t.startsWith("tel:")) return;
    if (t.startsWith("data:")) return;

    try {
      t = decodeURI(t);
    } catch {}

    let resolved = "";
    if (t.startsWith("/")) {
      resolved = t.substring(1);
    } else {
      const sourceDir = posix.dirname(sourcePath);
      resolved = sourceDir === "." ? t : posix.join(sourceDir, t);
    }
    
    try {
      // Must handelize the path so it matches our document paths format
      targets.add(handelize(resolved));
    } catch {
      // Ignored if handelize fails
    }
  };

  // Match standard markdown links: [text](target)
  const mdLinkRegex = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
  let match;
  while ((match = mdLinkRegex.exec(codeBlockStripped)) !== null) {
    addTarget(match[1]);
  }

  // Match wiki links: [[target]] or [[target|text]]
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  while ((match = wikiLinkRegex.exec(codeBlockStripped)) !== null) {
    let t = match[1]?.trim();
    if (t) {
      const [base, anchor] = t.split("#", 2);
      if (base && !base.includes(".")) {
        t = anchor ? `${base}.md#${anchor}` : `${base}.md`;
      }
    }
    addTarget(t);
  }

  return Array.from(targets);
}
