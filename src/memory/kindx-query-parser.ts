import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

export type KindxQueryResult = {
  docid?: string;
  score?: number;
  collection?: string;
  file?: string;
  snippet?: string;
  body?: string;
};

export function parseKindxQueryJson(stdout: string, stderr: string): KindxQueryResult[] {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  const stdoutIsMarker = trimmedStdout.length > 0 && isKindxNoResultsOutput(trimmedStdout);
  const stderrIsMarker = trimmedStderr.length > 0 && isKindxNoResultsOutput(trimmedStderr);
  if (stdoutIsMarker || (!trimmedStdout && stderrIsMarker)) {
    return [];
  }
  if (!trimmedStdout) {
    const context = trimmedStderr ? ` (stderr: ${summarizeKindxStderr(trimmedStderr)})` : "";
    const message = `stdout empty${context}`;
    log.warn(`kindx query returned invalid JSON: ${message}`);
    throw new Error(`kindx query returned invalid JSON: ${message}`);
  }
  try {
    const parsed = parseKindxQueryResultArray(trimmedStdout);
    if (parsed !== null) {
      return parsed;
    }
    const noisyPayload = extractFirstJsonArray(trimmedStdout);
    if (!noisyPayload) {
      throw new Error("kindx query JSON response was not an array");
    }
    const fallback = parseKindxQueryResultArray(noisyPayload);
    if (fallback !== null) {
      return fallback;
    }
    throw new Error("kindx query JSON response was not an array");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`kindx query returned invalid JSON: ${message}`);
    throw new Error(`kindx query returned invalid JSON: ${message}`, { cause: err });
  }
}

function isKindxNoResultsOutput(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  return lines.some((line) => isKindxNoResultsLine(line));
}

function isKindxNoResultsLine(line: string): boolean {
  if (line === "no results found" || line === "no results found.") {
    return true;
  }
  return /^(?:\[[^\]]+\]\s*)?(?:(?:warn(?:ing)?|info|error|kindx)\s*:\s*)+no results found\.?$/.test(
    line,
  );
}

function summarizeKindxStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
}

function parseKindxQueryResultArray(raw: string): KindxQueryResult[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed as KindxQueryResult[];
  } catch {
    return null;
  }
}

function extractFirstJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}
