import { homedir } from "node:os";
import { resolve } from "node:path";

export type ArchConfig = {
  enabled: boolean;
  augmentEnabled: boolean;
  autoRefreshOnUpdate: boolean;
  pythonBin: string;
  repoPath: string;
  artifactDir: string;
  collectionName: string;
  minConfidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  maxHints: number;
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseConfidence(value: string | undefined): "EXTRACTED" | "INFERRED" | "AMBIGUOUS" {
  const v = (value || "INFERRED").trim().toUpperCase();
  if (v === "EXTRACTED" || v === "INFERRED" || v === "AMBIGUOUS") return v;
  return "INFERRED";
}

export function loadArchConfig(): ArchConfig {
  const cacheRoot = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "kindx")
    : resolve(homedir(), ".cache", "kindx");

  return {
    enabled: parseBool(process.env.KINDX_ARCH_ENABLED, false),
    augmentEnabled: parseBool(process.env.KINDX_ARCH_AUGMENT_ENABLED, false),
    autoRefreshOnUpdate: parseBool(process.env.KINDX_ARCH_AUTO_REFRESH_ON_UPDATE, false),
    pythonBin: (process.env.KINDX_ARCH_PYTHON_BIN || "python3").trim(),
    repoPath: resolve(process.env.KINDX_ARCH_REPO_PATH || "./tmp/arch"),
    artifactDir: resolve(process.env.KINDX_ARCH_ARTIFACT_DIR || resolve(cacheRoot, "arch")),
    collectionName: (process.env.KINDX_ARCH_COLLECTION || "__arch").trim(),
    minConfidence: parseConfidence(process.env.KINDX_ARCH_MIN_CONFIDENCE),
    maxHints: parsePositiveInt(process.env.KINDX_ARCH_MAX_HINTS, 3),
  };
}

export function confidenceRank(level: "EXTRACTED" | "INFERRED" | "AMBIGUOUS"): number {
  if (level === "EXTRACTED") return 3;
  if (level === "INFERRED") return 2;
  return 1;
}

export function isConfidenceAllowed(
  value: string | undefined,
  minLevel: "EXTRACTED" | "INFERRED" | "AMBIGUOUS",
): boolean {
  if (!value) return false;
  const normalized = value.toUpperCase();
  if (normalized !== "EXTRACTED" && normalized !== "INFERRED" && normalized !== "AMBIGUOUS") {
    return false;
  }
  return confidenceRank(normalized) >= confidenceRank(minLevel);
}
