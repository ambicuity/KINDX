import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getCollection, listCollections } from "./catalogs.js";
import {
  isSqliteVecAvailable,
  getIndexCapabilities,
  getStatus,
  verifySqliteVecLoaded,
} from "./repository.js";
import type { Database } from "./runtime.js";
import {
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  DEFAULT_MODEL_CACHE_DIR,
  DEFAULT_RERANK_MODEL_URI,
} from "./inference.js";
import { getShardRuntimeStatus } from "./sharding.js";

export type ModelReadiness = {
  ready: boolean;
  total: number;
  present: number;
  missing: string[];
};

export type IntegrityStatus = {
  ok: boolean;
  result: string;
};

export type TrustStatus = {
  configuredCommands: number;
  trustedCommands: number;
  untrustedCollections: string[];
  trustFile: string;
};

export type OperationalStatus = {
  vector_available: boolean;
  models_ready: boolean;
  db_integrity: "ok" | "failed";
  warnings: string[];
};

function expectedModelFile(model: string): string {
  return model.split("/").pop() || model;
}

function hasModelFile(cacheDir: string, model: string): boolean {
  const needle = expectedModelFile(model);
  if (!needle) return false;
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return false;
  }
  return entries.some((entry) => entry.includes(needle));
}

export function checkModelReadiness(cacheDir: string = DEFAULT_MODEL_CACHE_DIR): ModelReadiness {
  const models = [DEFAULT_EMBED_MODEL_URI, DEFAULT_RERANK_MODEL_URI, DEFAULT_GENERATE_MODEL_URI];
  const missing = models.filter((model) => !hasModelFile(cacheDir, model));
  return {
    ready: missing.length === 0,
    total: models.length,
    present: models.length - missing.length,
    missing,
  };
}

export function checkDatabaseIntegrity(db: Database): IntegrityStatus {
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const result = row?.integrity_check || "unknown";
    return { ok: result === "ok", result };
  } catch (err) {
    return {
      ok: false,
      result: err instanceof Error ? err.message : String(err),
    };
  }
}

export function checkWalHealth(db: Database): { journalMode: string; walHealthy: boolean } {
  try {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    const mode = (row?.journal_mode || "unknown").toLowerCase();
    return { journalMode: mode, walHealthy: mode === "wal" };
  } catch {
    return { journalMode: "unknown", walHealthy: false };
  }
}

export function checkSqliteVecCapability(db: Database): { available: boolean; detail: string } {
  if (!isSqliteVecAvailable()) {
    return {
      available: false,
      detail: "sqlite-vec extension could not be loaded",
    };
  }
  try {
    verifySqliteVecLoaded(db);
    return { available: true, detail: "ok" };
  } catch (err) {
    return {
      available: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function checkTrustedUpdateCommands(dbPath: string): TrustStatus {
  const trustFile = join(dirname(dbPath), "trusted-commands.json");
  const configured = listCollections()
    .map((col) => ({ name: col.name, update: getCollection(col.name)?.update, path: col.path }))
    .filter((item) => typeof item.update === "string" && item.update.trim().length > 0) as {
    name: string;
    update: string;
    path: string;
  }[];

  let trustedHashes = new Set<string>();
  if (existsSync(trustFile)) {
    try {
      const parsed = JSON.parse(readFileSync(trustFile, "utf-8"));
      if (Array.isArray(parsed)) {
        trustedHashes = new Set(parsed.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      // malformed trust file is treated as empty trust set
    }
  }

  const untrustedCollections: string[] = [];
  let trustedCommands = 0;
  for (const item of configured) {
    const hash = createHash("sha256").update(`${item.name}|${item.path}|${item.update}`).digest("hex");
    if (trustedHashes.has(hash)) {
      trustedCommands += 1;
    } else {
      untrustedCollections.push(item.name);
    }
  }

  return {
    configuredCommands: configured.length,
    trustedCommands,
    untrustedCollections,
    trustFile,
  };
}

export function buildOperationalStatus(db: Database, dbPath: string, hasVectorIndex: boolean): OperationalStatus {
  const warnings: string[] = [];
  const vec = checkSqliteVecCapability(db);
  const models = checkModelReadiness();
  const integrity = checkDatabaseIntegrity(db);

  if (!vec.available) warnings.push(`vector_unavailable: ${vec.detail}`);
  if (!hasVectorIndex) warnings.push("vector_index_missing: run 'kindx embed'");
  if (!models.ready) {
    const missing = models.missing.map(expectedModelFile).join(", ");
    warnings.push(`models_missing: ${missing}`);
  }
  if (!integrity.ok) warnings.push(`db_integrity_failed: ${integrity.result}`);

  const trust = checkTrustedUpdateCommands(dbPath);
  if (trust.untrustedCollections.length > 0) {
    warnings.push(
      `untrusted_update_commands: ${trust.untrustedCollections.join(",")}`
    );
  }
  const shardStatus = getShardRuntimeStatus(dbPath);
  if (shardStatus.enabledCollections.length > 0) {
    warnings.push(`shards_enabled:${shardStatus.enabledCollections.map((c) => `${c.collection}:${c.shardCount}`).join(",")}`);
  }
  for (const warning of shardStatus.warnings) {
    warnings.push(`shard_warning:${warning}`);
  }
  const capabilities = getIndexCapabilities(db);
  const status = getStatus(db);
  if (!capabilities.ann) warnings.push("capability_missing:ann");
  if (!capabilities.extractors) warnings.push("capability_missing:extractors");
  const encryptionMode = capabilities.encryption || "none";
  if (process.env.KINDX_ENCRYPTION_KEY && encryptionMode === "none") {
    warnings.push("encryption_key_set_but_index_reports_none");
  }
  if (status.ann.state !== "ready") {
    warnings.push(`ann_state:${status.ann.state}`);
  }
  if (status.encryption.keyConfigured && !status.encryption.encrypted) {
    warnings.push("encryption_key_set_but_index_plaintext");
  }
  if ((status.ingestion.byWarning?.length ?? 0) > 0) {
    warnings.push(`ingestion_warning_types:${status.ingestion.byWarning.length}`);
  }

  return {
    vector_available: vec.available,
    models_ready: models.ready,
    db_integrity: integrity.ok ? "ok" : "failed",
    warnings,
  };
}

export function getDefaultBackupName(indexPath: string): string {
  const stem = basename(indexPath).replace(/\.sqlite$/i, "") || "index";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stem}.backup.${ts}.sqlite`;
}
