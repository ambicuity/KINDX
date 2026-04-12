import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";

export type IngestionResult = {
  text: string;
  metadata: {
    format: string;
    extractor: string;
    bytes: number;
  };
  warnings: string[];
};

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".text", ".org", ".rst",
  ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".cfg", ".env",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".php", ".scala", ".sql", ".sh", ".bash", ".zsh", ".fish",
  ".html", ".css", ".scss", ".less", ".xml", ".vue", ".svelte",
  ".dockerfile", ".makefile",
]);

function envToggle(name: string, fallback = true): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "disabled");
}

function extractorFallbackPolicy(): "fallback" | "strict" {
  const raw = String(process.env.KINDX_EXTRACTOR_FALLBACK_POLICY ?? "fallback").trim().toLowerCase();
  return raw === "strict" ? "strict" : "fallback";
}

function safeCommand(command: string, args: string[], timeoutMs = 8_000): { ok: boolean; stdout: string; stderr: string } {
  const out = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return {
    ok: out.status === 0 && !out.error,
    stdout: String(out.stdout || ""),
    stderr: String(out.stderr || ""),
  };
}

function decodeXmlEntities(input: string): string {
  const entities: Record<string, string> = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
  };
  // Decode only one entity token at a time to avoid chained replacement edge cases.
  return input.replace(/&(lt|gt|amp|quot|#39);/g, (entity) => entities[entity] ?? entity);
}

function stripXml(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:p[^>]*>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function ingestDocx(path: string): IngestionResult {
  const warnings: string[] = [];
  if (!envToggle("KINDX_EXTRACTOR_DOCX", true)) {
    warnings.push("extractor_disabled:docx");
    return {
      text: "",
      metadata: { format: "docx", extractor: "disabled", bytes: statSync(path).size },
      warnings,
    };
  }
  const unzip = safeCommand("unzip", ["-p", path, "word/document.xml"]);
  if (!unzip.ok || !unzip.stdout.trim()) {
    warnings.push("extractor_failed:docx_unzip");
    return {
      text: "",
      metadata: { format: "docx", extractor: "docx_unzip", bytes: statSync(path).size },
      warnings,
    };
  }
  return {
    text: stripXml(unzip.stdout),
    metadata: { format: "docx", extractor: "docx_unzip", bytes: statSync(path).size },
    warnings,
  };
}

function ingestPdf(path: string): IngestionResult {
  const warnings: string[] = [];
  if (!envToggle("KINDX_EXTRACTOR_PDF", true)) {
    warnings.push("extractor_disabled:pdf");
    return {
      text: "",
      metadata: { format: "pdf", extractor: "disabled", bytes: statSync(path).size },
      warnings,
    };
  }
  const primary = safeCommand("pdftotext", ["-q", path, "-"]);
  if (primary.ok && primary.stdout.trim()) {
    return {
      text: primary.stdout.trim(),
      metadata: { format: "pdf", extractor: "pdftotext", bytes: statSync(path).size },
      warnings,
    };
  }

  if (extractorFallbackPolicy() === "strict") {
    warnings.push("extractor_failed:pdf_pdftotext");
    return {
      text: "",
      metadata: { format: "pdf", extractor: "pdftotext", bytes: statSync(path).size },
      warnings,
    };
  }

  const fallback = safeCommand("strings", ["-n", "4", path]);
  if (fallback.ok && fallback.stdout.trim()) {
    warnings.push("extractor_degraded:pdf_strings_fallback");
    return {
      text: fallback.stdout.trim(),
      metadata: { format: "pdf", extractor: "strings_fallback", bytes: statSync(path).size },
      warnings,
    };
  }

  warnings.push("extractor_failed:pdf_no_output");
  return {
    text: "",
    metadata: { format: "pdf", extractor: "unavailable", bytes: statSync(path).size },
    warnings,
  };
}

export function ingestFile(path: string): IngestionResult {
  const ext = extname(path).toLowerCase();
  const bytes = statSync(path).size;

  if (ext === ".pdf") return ingestPdf(path);
  if (ext === ".docx") return ingestDocx(path);

  if (TEXT_EXTENSIONS.has(ext) || ext === "") {
    const text = readFileSync(path, "utf-8");
    return {
      text,
      metadata: { format: ext || "text", extractor: "native_utf8", bytes },
      warnings: [],
    };
  }

  return {
    text: "",
    metadata: { format: ext || "unknown", extractor: "unsupported", bytes },
    warnings: [`extractor_unsupported_extension:${ext || "none"}`],
  };
}
