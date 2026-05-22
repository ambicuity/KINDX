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

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"
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

// Tier-1: cap raw text-file ingestion to defend against accidentally indexing
// gigabyte log files. Default 25 MiB; override with KINDX_MAX_DOC_BYTES.
const MAX_DOC_BYTES = (() => {
  const raw = parseInt(process.env.KINDX_MAX_DOC_BYTES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 25 * 1024 * 1024;
})();

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function ingestCsv(path: string): IngestionResult {
  const warnings: string[] = [];
  const bytes = statSync(path).size;

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter(line => line.trim());

    if (lines.length === 0) {
      warnings.push("extractor_failed:csv_empty");
      return {
        text: "",
        metadata: { format: "csv", extractor: "csv_parser", bytes },
        warnings,
      };
    }

    // Parse header
    const header = parseCsvLine(lines[0]!);
    const schema = header.map(col => `${col}: string`).join(", ");

    // Parse rows
    const rows: string[][] = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim()) {
        rows.push(parseCsvLine(lines[i]!));
      }
    }

    // Create chunks preserving row boundaries
    const maxRowsPerChunk = 100;
    const chunks: string[] = [];

    for (let i = 0; i < rows.length; i += maxRowsPerChunk) {
      const chunkRows = rows.slice(i, i + maxRowsPerChunk);
      const chunkContent = [
        `Schema: ${schema}`,
        `Rows ${i + 1}-${i + chunkRows.length}:`,
        header.join(", "),
        ...chunkRows.map(row => row.join(", "))
      ].join("\n");
      chunks.push(chunkContent);
    }

    // Combine chunks with separator
    const text = chunks.join("\n\n---\n\n");

    return {
      text,
      metadata: { format: "csv", extractor: "csv_parser", bytes },
      warnings,
    };
  } catch (error) {
    warnings.push(`extractor_failed:csv_error:${error instanceof Error ? error.message : String(error)}`);
    return {
      text: "",
      metadata: { format: "csv", extractor: "csv_parser_error", bytes },
      warnings,
    };
  }
}

async function ingestImage(path: string): Promise<IngestionResult> {
  const warnings: string[] = [];
  const bytes = statSync(path).size;

  // Check image size limit (default 10MB)
  const maxImageBytes = (() => {
    const raw = parseInt(process.env.KINDX_MAX_IMAGE_SIZE_MB || "", 10);
    const mb = Number.isFinite(raw) && raw > 0 ? raw : 10;
    return mb * 1024 * 1024;
  })();

  if (bytes > maxImageBytes) {
    warnings.push(`extractor_image_too_large:${bytes}>${maxImageBytes}`);
    return {
      text: "",
      metadata: { format: "image", extractor: "vision_model_skipped_oversize", bytes },
      warnings,
    };
  }

  try {
    const { getDefaultLLM } = await import("./inference.js");
    const llm = getDefaultLLM();

    if (!llm || typeof (llm as any).describeImage !== "function") {
      warnings.push("extractor_failed:vision_model_unavailable");
      return {
        text: "",
        metadata: { format: "image", extractor: "vision_model_unavailable", bytes },
        warnings,
      };
    }

    const description = await (llm as any).describeImage(path);

    if (!description || description === "Image description unavailable") {
      warnings.push("extractor_failed:vision_model_no_description");
      return {
        text: "",
        metadata: { format: "image", extractor: "vision_model_failed", bytes },
        warnings,
      };
    }

    return {
      text: description,
      metadata: { format: "image", extractor: "vision_model", bytes },
      warnings,
    };
  } catch (error) {
    warnings.push(`extractor_failed:vision_model_error:${error instanceof Error ? error.message : String(error)}`);
    return {
      text: "",
      metadata: { format: "image", extractor: "vision_model_error", bytes },
      warnings,
    };
  }
}

export async function ingestFile(path: string): Promise<IngestionResult> {
  const ext = extname(path).toLowerCase();
  const bytes = statSync(path).size;

  if (ext === ".pdf") return ingestPdf(path);
  if (ext === ".docx") return ingestDocx(path);
  if (IMAGE_EXTENSIONS.has(ext)) return ingestImage(path);
  if (ext === ".csv") return ingestCsv(path);

  if (TEXT_EXTENSIONS.has(ext) || ext === "") {
    if (bytes > MAX_DOC_BYTES) {
      return {
        text: "",
        metadata: { format: ext || "text", extractor: "native_utf8_skipped_oversize", bytes },
        warnings: [`extractor_doc_too_large:${bytes}>${MAX_DOC_BYTES}`],
      };
    }
    let text = readFileSync(path, "utf-8");
    // Strip UTF-8 BOM (﻿) so it doesn't end up in the indexed body and
    // disturb FTS tokenization. node's "utf-8" decoder preserves the BOM as
    // a literal U+FEFF in the output string.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
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
