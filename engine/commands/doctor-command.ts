/**
 * doctor-command.ts — Extracted diagnostics / repair logic from kindx.ts
 *
 * Runs a deterministic set of health checks against the KINDX index and
 * reports pass/fail status. Covers: sqlite-vec, models, db integrity, WAL,
 * trusted update commands, shard health, index capabilities, ANN state,
 * encryption, ingestion, and metrics surface.
 */
import type { Database } from "../runtime.js";
import type { OutputFormat } from "../renderer.js";
import {
  getStatus,
} from "../repository.js";
import {
  checkDatabaseIntegrity,
  checkModelReadiness,
  checkSqliteVecCapability,
  checkTrustedUpdateCommands,
  checkWalHealth,
} from "../diagnostics.js";
import {
  getShardHealthSummary,
} from "../sharding.js";
import { c } from "../utils/ui.js";

export interface DoctorDeps {
  getDb: () => Database;
  getDbPath: () => string;
  closeDb: () => void;
}

export function runDoctorCommand(
  deps: DoctorDeps,
  output: OutputFormat,
  paritySampleSize: number = 16,
): number {
  const { getDb, getDbPath, closeDb } = deps;
  const db = getDb();
  const dbPath = getDbPath();

  const vec = checkSqliteVecCapability(db);
  const models = checkModelReadiness();
  const integrity = checkDatabaseIntegrity(db);
  const wal = checkWalHealth(db);
  const trust = checkTrustedUpdateCommands(dbPath);
  const shardHealth = getShardHealthSummary(db, dbPath, Math.max(1, paritySampleSize));
  const status = getStatus(db);

  const checks = [
    { id: "sqlite_vec", ok: vec.available, detail: vec.detail },
    { id: "models", ok: models.ready, detail: models.ready ? "all default models present in cache" : `missing: ${models.missing.join(", ")}` },
    { id: "db_integrity", ok: integrity.ok, detail: integrity.result },
    { id: "wal_mode", ok: wal.walHealthy, detail: wal.journalMode },
    {
      id: "trusted_update_cmds",
      ok: trust.untrustedCollections.length === 0,
      detail: trust.untrustedCollections.length > 0
        ? `untrusted collections: ${trust.untrustedCollections.join(", ")}`
        : `${trust.trustedCommands}/${trust.configuredCommands} trusted`,
    },
    {
      id: "shard_health",
      ok: shardHealth.status !== "error",
      detail: `status=${shardHealth.status} warnings=${shardHealth.warnings.length} parity_sample=${Math.max(1, paritySampleSize)} families=${Object.entries(shardHealth.families).map(([k, v]) => `${k}:${v.count}/${v.severity}`).join(",")}`,
    },
    {
      id: "index_capabilities",
      ok: Boolean(status.capabilities?.ann) && Boolean(status.capabilities?.extractors),
      detail: Object.entries(status.capabilities || {}).map(([k, v]) => `${k}=${v}`).join(", "),
    },
    {
      id: "ann_health",
      ok: status.ann.state === "ready",
      detail: `mode=${status.ann.mode} state=${status.ann.state} probes=${status.ann.probeCount} shortlist=${status.ann.shortlistLimit}`,
    },
    {
      id: "encryption_state",
      ok: !status.encryption.keyConfigured || status.encryption.encrypted,
      detail: `encrypted=${status.encryption.encrypted} keyConfigured=${status.encryption.keyConfigured}`,
    },
    {
      id: "ingestion_health",
      ok: (status.ingestion?.warnedDocuments ?? 0) === 0,
      detail: `${status.ingestion?.warnedDocuments ?? 0} documents with extractor warnings; types=${status.ingestion?.byWarning?.length ?? 0}`,
    },
    {
      id: "metrics_surface",
      ok: true,
      detail: "HTTP daemon exposes /metrics in Prometheus format",
    },
  ];
  const failed = checks.filter((check) => !check.ok);

  if (output === "json") {
    console.log(JSON.stringify({
      status: failed.length === 0 ? "ok" : "failed",
      checks,
    }, null, 2));
  } else {
    console.log(`${c.bold}KINDX Doctor${c.reset}`);
    for (const check of checks) {
      const icon = check.ok ? `${c.green}✓${c.reset}` : `${c.yellow}!${c.reset}`;
      console.log(`  ${icon} ${check.id}: ${check.detail}`);
    }
    if (failed.length === 0) {
      console.log(`\n${c.green}All health checks passed.${c.reset}`);
    } else {
      console.log(`\n${c.yellow}${failed.length} check(s) need attention.${c.reset}`);
    }
  }

  closeDb();
  return failed.length === 0 ? 0 : 2;
}

export function runRepairCheckCommand(deps: DoctorDeps, output: OutputFormat): number {
  const code = runDoctorCommand(deps, output);
  if (output !== "json") {
    if (code === 0) {
      console.log(`${c.green}Repair check: no action required.${c.reset}`);
    } else {
      console.log(`${c.yellow}Repair check: run 'kindx cleanup' or 'kindx embed' depending on failed checks.${c.reset}`);
    }
  }
  return code;
}
