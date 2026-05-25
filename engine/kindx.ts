import { openDatabase } from "./runtime.js";
import type { Database } from "./runtime.js";
import fastGlob from "fast-glob";
import { execSync, spawn as nodeSpawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import { parseArgs } from "util";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { readFileSync, realpathSync, statSync, existsSync, unlinkSync, writeFileSync, openSync, closeSync, mkdirSync } from "fs";
import {
  getPwd,
  getRealPath,
  homedir,
  resolve,
  enableProductionMode,
  searchFTS,
  extractSnippet,
  getContextForFile,
  getContextForPath,
  listCollections,
  removeCollection,
  renameCollection,
  findSimilarFiles,
  findDocumentByDocid,
  isDocid,
  matchFilesByGlob,
  getHashesNeedingEmbedding,
  getHashesForEmbedding,
  clearAllEmbeddings,
  insertEmbedding,
  bulkInsertEmbeddings,
  getStatus,
  hashContent,
  extractTitle,
  formatDocForEmbedding,
  chunkDocumentByTokens,
  clearCache,
  getCacheKey,
  getCachedResult,
  setCachedResult,
  getIndexHealth,
  parseVirtualPath,
  buildVirtualPath,
  isVirtualPath,
  resolveVirtualPath,
  toVirtualPath,
  insertContent,
  upsertDocumentIngestion,
  insertDocument,
  findActiveDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  getDocumentVersions,
  getDocumentAtTime,
  findDocumentAtTime,
  cleanupOrphanedContent,
  deleteLLMCache,
  deleteInactiveDocuments,
  cleanupOrphanedVectors,
  cleanupSqliteSidecars,
  vacuumDatabase,
  walCheckpointTruncate,
  getCollectionsWithoutContext,
  getTopLevelPathsWithoutContext,
  handelize,
  hybridQuery,
  vectorSearchQuery,
  structuredSearchWithDiagnostics,
  addLineNumbers,
  findDocument,
  type ExpandedQuery,
  type HybridQueryExplain,
  type StructuredSubSearch,
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GLOB,
  DEFAULT_MULTI_GET_MAX_BYTES,
  createStore,
  getDefaultDbPath,
} from "./repository.js";
import { ingestFile } from "./ingestion.js";
import { disposeDefaultLLM, getDefaultLLM, withLLMScope, withLLMSession, pullModels, DEFAULT_EMBED_MODEL_URI, DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI, DEFAULT_MODEL_CACHE_DIR } from "./inference.js";
import {
  formatSearchResults,
  formatDocuments,
  escapeXml,
  escapeCSV,
  type OutputFormat,
} from "./renderer.js";
import {
  getCollection as getCollectionFromYaml,
  listCollections as yamlListCollections,
  getDefaultCollectionNames,
  addContext as yamlAddContext,
  removeContext as yamlRemoveContext,
  setGlobalContext,
  listAllContexts,
  setConfigIndexName,
} from "./catalogs.js";
import {
  upsertMemory,
  semanticSearchMemory,
  textSearchMemory,
  getMemoryHistory,
  getMemoryStats,
  markMemoryAccessed,
  embedMemories,
  resolveMemoryScope as resolveMemoryScopeShared,
  deriveWorkspaceMemoryScope,
} from "./memory.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import {
  buildOperationalStatus,
  checkDatabaseIntegrity,
  checkModelReadiness,
  checkSqliteVecCapability,
  checkTrustedUpdateCommands,
  checkWalHealth,
  getDefaultBackupName,
} from "./diagnostics.js";
import { configureLogger } from "./utils/logger.js";
import { executeEmbedCommand } from "./commands/embed-command.js";
import { executeQueryCommand } from "./commands/query-command.js";
import { runSchedulerStatusCommand } from "./commands/scheduler-status-command.js";
import { runStatusCommand } from "./commands/status-command.js";
import { runDoctorCommand, runRepairCheckCommand } from "./commands/doctor-command.js";
import { runBackupCommand as runBackupCmd } from "./commands/backup-command.js";
import { runInitCommand } from "./commands/init-command.js";
import { runTenantCommand } from "./commands/tenant-command.js";
import {
  getSchedulerCheckpointState,
  getSchedulerQueueState,
  getShardHealthSummary,
  getShardRuntimeStatus,
  syncCollectionShardsFromMainDb,
} from "./sharding.js";
import { recordDirectUsage, flushAiUsageQueue } from "./ai-usage.js";
import { getArchConfig, getArchStatus, buildAndDistillArch } from "./integrations/arch/adapter.js";
import { KindxError, toKindxError, errorEnvelope } from "./cli/errors.js";
import { jsonEnvelopeEnabled, resolveOutputMode, glyphsFor, paletteFor } from "./cli/output.js";
import { renderSearchResults } from "./cli/renderers/search.js";
import { createProgressReporter, type ProgressReporter } from "./cli/progress.js";
import { renderMcpStatus, redactedMcpStatus, type McpStatusData } from "./cli/renderers/mcp-status.js";
import { renderMemorySearch, renderMemoryEntry } from "./cli/renderers/memory.js";
import { renderRootHelp, renderCommandHelp, renderSubcommandList, renderSubcommandHelp } from "./cli/help.js";
import { suggestCommandNames } from "./cli/registry.js";

// Enable production mode - allows using default database path
// Tests must set INDEX_PATH or use createStore() with explicit path
enableProductionMode();

// =============================================================================
// Store/DB lifecycle (no legacy singletons in repository.ts)
// =============================================================================

let store: ReturnType<typeof createStore> | null = null;
let storeDbPathOverride: string | undefined;

function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
  }
  return store;
}

function getDb(): Database {
  return getStore().db;
}

function closeDb(): void {
  if (store) {
    flushAiUsageQueue();
    store.close();
    store = null;
  }
}

function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

function getKindxCacheDir(): string {
  return process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "kindx")
    : resolve(homedir(), ".cache", "kindx");
}

function setIndexName(name: string | null): void {
  let normalizedName = name;
  // Normalize relative paths to prevent malformed database paths
  if (name && name.includes('/')) {
    const absolutePath = resolve(process.cwd(), name);
    // Replace path separators with underscores to create a valid filename
    normalizedName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  }
  storeDbPathOverride = normalizedName ? getDefaultDbPath(normalizedName) : undefined;
  // Reset open handle so next use opens the new index
  closeDb();
}

function ensureVecTable(_db: Database, dimensions: number): void {
  // Store owns the DB; ignore `_db` and ensure vec table on the active store
  getStore().ensureVecTable(dimensions);
}

import {
  c,
  cursor,
  progress,
  formatETA,
  formatTimeAgo,
  formatMs,
  formatBytes,
  renderProgressBar,
  spinner,
  Spinner,
  registerCursorCleanup,
} from "./utils/ui.js";

const isTTY = process.stderr.isTTY;
// Module-level default. The actual `useColor` value is *recomputed* inside
// main() after parseCLI() so the parsed --color / --no-color flags take
// precedence (today they are ignored when stdout isn't a TTY). Keep a sane
// default for code paths that touch `useColor` before main() runs — e.g.
// the top-level error handler installed at module load.
let useColor = !process.env.NO_COLOR && process.stdout.isTTY;

// Lazy module-level progress reporter. Built from resolveOutputMode() on first
// access so its paint mode reflects the actual CLI invocation (TTY, --quiet,
// --format=json, etc.). Tests can override it via setProgressReporter().
let _reporter: ProgressReporter | null = null;
let _reporterFormatHint: string | undefined;
function getReporter(): ProgressReporter {
  if (_reporter) return _reporter;
  const resolved = resolveOutputMode({ format: _reporterFormatHint, quiet: _reporterQuietHint });
  _reporter = createProgressReporter({
    mode: resolved.progress,
    color: resolved.color,
    glyphs: glyphsFor(),
  });
  return _reporter;
}
/** Inform the lazy reporter of the active --format before first use. */
export function setReporterFormatHint(format: string | undefined, opts: { quiet?: boolean } = {}): void {
  _reporterFormatHint = format;
  _reporterQuietHint = !!opts.quiet;
  _reporter = null; // force rebuild on next access
}
let _reporterQuietHint = false;
export function setProgressReporter(reporter: ProgressReporter | null): void {
  if (_reporter && _reporter !== reporter) _reporter.done();
  _reporter = reporter;
}


// Check index health and print warnings/tips
function checkIndexHealth(db: Database): void {
  const { needsEmbedding, totalDocs, daysStale } = getIndexHealth(db);
  const reporter = getReporter();

  // Warn if many docs need embedding
  if (needsEmbedding > 0) {
    const pct = Math.round((needsEmbedding / totalDocs) * 100);
    reporter.warn(
      "missing-embeddings",
      `${needsEmbedding} documents (${pct}%) need embeddings. Run 'kindx embed' for better results.`,
      { count: needsEmbedding, totalDocs, pct },
    );
  }

  // Check if most recent document update is older than 2 weeks
  if (daysStale !== null && daysStale >= 14) {
    reporter.warn(
      "stale-index",
      `Index last updated ${daysStale} days ago. Run 'kindx update' to refresh.`,
      { daysStale },
    );
  }
}

// Compute unique display path for a document
// Always include at least parent folder + filename, add more parent dirs until unique
function computeDisplayPath(
  filepath: string,
  collectionPath: string,
  existingPaths: Set<string>
): string {
  // Get path relative to collection (include collection dir name)
  const collectionDir = collectionPath.replace(/\/$/, '');
  const collectionName = collectionDir.split('/').pop() || '';

  let relativePath: string;
  if (filepath.startsWith(collectionDir + '/')) {
    // filepath is under collection: use collection name + relative path
    relativePath = collectionName + filepath.slice(collectionDir.length);
  } else {
    // Fallback: just use the filepath
    relativePath = filepath;
  }

  const parts = relativePath.split('/').filter(p => p.length > 0);

  // Always include at least parent folder + filename (minimum 2 parts if available)
  // Then add more parent dirs until unique
  const minParts = Math.min(2, parts.length);
  for (let i = parts.length - minParts; i >= 0; i--) {
    const candidate = parts.slice(i).join('/');
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }

  // Absolute fallback: use full path (should be unique)
  return filepath;
}




async function showStatus(): Promise<void> {
  const dbPath = getDbPath();
  const db = getDb();

  // Collections are defined in YAML; no duplicate cleanup needed.

  // Index size
  let indexSize = 0;
  try {
    const stat = statSync(dbPath).size;
    indexSize = stat;
  } catch { }

  // Collections info (from YAML + database stats)
  const collections = listCollections(db);

  // Overall stats
  const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
  const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const status = getStatus(db);

  // Most recent update across all collections
  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };

  console.log(`${c.bold}KINDX Status${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Size:  ${formatBytes(indexSize)}`);

  // MCP daemon status (check PID file liveness)
  const mcpCacheDir = getKindxCacheDir();
  const mcpPidPath = resolve(mcpCacheDir, "mcp.pid");
  if (existsSync(mcpPidPath)) {
    const mcpPid = parseInt(readFileSync(mcpPidPath, "utf-8").trim());
    try {
      process.kill(mcpPid, 0);
      console.log(`MCP:   ${c.green}running${c.reset} (PID ${mcpPid})`);
    } catch {
      try {
        unlinkSync(mcpPidPath);
      } catch {
        // Ignore stale PID cleanup failures in read-only or sandboxed environments.
      }
      // Stale PID file cleaned up silently
    }
  }

  // Watch daemon status
  const watchPidPath = resolve(mcpCacheDir, "watch.pid");
  if (existsSync(watchPidPath)) {
    const watchPid = parseInt(readFileSync(watchPidPath, "utf-8").trim());
    try {
      process.kill(watchPid, 0);
      console.log(`Watch: ${c.green}running${c.reset} (PID ${watchPid})`);
    } catch {
      try {
        unlinkSync(watchPidPath);
      } catch {
        // Ignore stale PID cleanup failures in read-only or sandboxed environments.
      }
    }
  }
  console.log("");

  console.log(`${c.bold}Documents${c.reset}`);
  console.log(`  Total:    ${totalDocs.count} files indexed`);
  console.log(`  Vectors:  ${vectorCount.count} embedded`);
  const opsStatus = buildOperationalStatus(db, dbPath, vectorCount.count > 0);
  console.log(`  Capability: vector=${opsStatus.vector_available ? "available" : "unavailable"}, models=${opsStatus.models_ready ? "ready" : "missing"}, db=${opsStatus.db_integrity}`);
  const capabilitySummary = Object.entries(status.capabilities || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  if (capabilitySummary) {
    console.log(`  Index Caps: ${capabilitySummary}`);
  }
  console.log(`  Encryption: ${status.encryption.encrypted ? "encrypted" : "plaintext"} (key=${status.encryption.keyConfigured ? "set" : "unset"})`);
  console.log(`  ANN:        ${status.ann.mode} (${status.ann.state}) probes=${status.ann.probeCount} shortlist=${status.ann.shortlistLimit}`);
  if ((status.ingestion?.warnedDocuments ?? 0) > 0) {
    console.log(`  Ingestion: ${c.yellow}${status.ingestion.warnedDocuments} file(s) with extractor warnings${c.reset}`);
    const topWarnings = status.ingestion.byWarning.slice(0, 5).map((w) => `${w.warning}:${w.count}`).join(", ");
    if (topWarnings) {
      console.log(`  Warning types: ${topWarnings}`);
    }
  }
  if (needsEmbedding > 0) {
    console.log(`  ${c.yellow}Pending:  ${needsEmbedding} need embedding${c.reset} (run 'kindx embed')`);
  }
  if (mostRecent.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    console.log(`  Updated:  ${formatTimeAgo(lastUpdate)}`);
  }

  if (Array.isArray((collections as any)) && (status.shards?.enabledCollections.length ?? 0) > 0) {
    const shardStatus = status.shards!;
    const shardHealth = getShardHealthSummary(db, dbPath, 16);
    console.log(`  Shards:   ${shardStatus.enabledCollections.map((c) => `${c.collection}:${c.shardCount}`).join(", ")}`);
    console.log(`  Queue:    ${shardStatus.checkpointExists ? "checkpoint present" : "no checkpoint"}`);
    console.log(`  Health:   ${shardHealth.status}`);
  }

  // Get all contexts grouped by collection (from YAML)
  const allContexts = listAllContexts();
  const contextsByCollection = new Map<string, { path_prefix: string; context: string }[]>();

  for (const ctx of allContexts) {
    // Group contexts by collection name
    if (!contextsByCollection.has(ctx.collection)) {
      contextsByCollection.set(ctx.collection, []);
    }
    contextsByCollection.get(ctx.collection)!.push({
      path_prefix: ctx.path,
      context: ctx.context
    });
  }

  if (collections.length > 0) {
    console.log(`\n${c.bold}Collections${c.reset}`);
    for (const col of collections) {
      const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
      const contexts = contextsByCollection.get(col.name) || [];

      console.log(`  ${c.cyan}${col.name}${c.reset} ${c.dim}(kindx://${col.name}/)${c.reset}`);
      console.log(`    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}`);
      console.log(`    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`);

      if (contexts.length > 0) {
        console.log(`    ${c.dim}Contexts:${c.reset} ${contexts.length}`);
        for (const ctx of contexts) {
          // Handle both empty string and '/' as root context
          const pathDisplay = (ctx.path_prefix === '' || ctx.path_prefix === '/') ? '/' : `/${ctx.path_prefix}`;
          const contextPreview = ctx.context.length > 60
            ? ctx.context.substring(0, 57) + '...'
            : ctx.context;
          console.log(`      ${c.dim}${pathDisplay}:${c.reset} ${contextPreview}`);
        }
      }
    }

    // Show examples of virtual paths
    console.log(`\n${c.bold}Examples${c.reset}`);
    console.log(`  ${c.dim}# List files in a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  kindx ls ${collections[0].name}`);
    }
    console.log(`  ${c.dim}# Get a document${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  kindx get kindx://${collections[0].name}/path/to/file.md`);
    }
    console.log(`  ${c.dim}# Search within a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  kindx search "query" -c ${collections[0].name}`);
    }
  } else {
    console.log(`\n${c.dim}No collections. Run 'kindx collection add .' to index markdown files.${c.reset}`);
  }

  // Models
  {
    // hf:org/repo/file.gguf → https://huggingface.co/org/repo
    const hfLink = (uri: string) => {
      const match = uri.match(/^hf:([^/]+\/[^/]+)\//);
      return match ? `https://huggingface.co/${match[1]}` : uri;
    };
    console.log(`\n${c.bold}Models${c.reset}`);
    console.log(`  Embedding:   ${hfLink(DEFAULT_EMBED_MODEL_URI)}`);
    console.log(`  Reranking:   ${hfLink(DEFAULT_RERANK_MODEL_URI)}`);
    console.log(`  Generation:  ${hfLink(DEFAULT_GENERATE_MODEL_URI)}`);
  }

  // Device / GPU info
  try {
    const llm = getDefaultLLM();
    if (typeof llm.getDeviceInfo === "function") {
      const device = await llm.getDeviceInfo();
      console.log(`\n${c.bold}Device${c.reset}`);
      if (device.gpu) {
        console.log(`  GPU:      ${c.green}${device.gpu}${c.reset} (offloading: ${device.gpuOffloading ? 'yes' : 'no'})`);
        if (device.gpuDevices.length > 0) {
          // Deduplicate and count GPUs
          const counts = new Map<string, number>();
          for (const name of device.gpuDevices) {
            counts.set(name, (counts.get(name) || 0) + 1);
          }
          const deviceStr = Array.from(counts.entries())
            .map(([name, count]) => count > 1 ? `${count}× ${name}` : name)
            .join(', ');
          console.log(`  Devices:  ${deviceStr}`);
        }
        if (device.vram) {
          console.log(`  VRAM:     ${formatBytes(device.vram.free)} free / ${formatBytes(device.vram.total)} total`);
        }
      } else {
        console.log(`  GPU:      ${c.yellow}none${c.reset} (running on CPU — models will be slow)`);
        console.log(`  ${c.dim}Tip: Install CUDA, Vulkan, or Metal support for GPU acceleration.${c.reset}`);
      }
      console.log(`  CPU:      ${device.cpuCores} math cores`);
    } else {
      console.log(`\n${c.bold}Device${c.reset}`);
      console.log(`  Accelerator: ${c.cyan}Remote API${c.reset} (API backend)`);
    }
  } catch {
    // Don't fail status if LLM init fails
  }

  // Tips section
  const tips: string[] = [];

  // Check for collections without context
  const collectionsWithoutContext = collections.filter(col => {
    const contexts = contextsByCollection.get(col.name) || [];
    return contexts.length === 0;
  });
  if (collectionsWithoutContext.length > 0) {
    const names = collectionsWithoutContext.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutContext.length > 3 ? ` +${collectionsWithoutContext.length - 3} more` : '';
    tips.push(`Add context to collections for better search results: ${names}${more}`);
    tips.push(`  ${c.dim}kindx context add kindx://<name>/ "What this collection contains"${c.reset}`);
    tips.push(`  ${c.dim}kindx context add kindx://<name>/meeting-notes "Weekly team meeting notes"${c.reset}`);
  }

  // Check for collections without update commands
  const collectionsWithoutUpdate = collections.filter(col => {
    const yamlCol = getCollectionFromYaml(col.name);
    return !yamlCol?.update;
  });
  if (collectionsWithoutUpdate.length > 0 && collections.length > 1) {
    const names = collectionsWithoutUpdate.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutUpdate.length > 3 ? ` +${collectionsWithoutUpdate.length - 3} more` : '';
    tips.push(`Add update commands to keep collections fresh: ${names}${more}`);
    tips.push(`  ${c.dim}kindx collection update-cmd <name> 'git stash && git pull --rebase --ff-only && git stash pop'${c.reset}`);
  }

  if (tips.length > 0) {
    console.log(`\n${c.bold}Tips${c.reset}`);
    for (const tip of tips) {
      console.log(`  ${tip}`);
    }
  }

  if (opsStatus.warnings.length > 0) {
    console.log(`\n${c.bold}Warnings${c.reset}`);
    for (const warning of opsStatus.warnings) {
      console.log(`  ${c.yellow}!${c.reset} ${warning}`);
    }
  }

  closeDb();
}

function runDoctor(output: OutputFormat, paritySampleSize: number = 16): number {
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

function runRepairCheckOnly(output: OutputFormat): number {
  const code = runDoctor(output);
  if (output !== "json") {
    if (code === 0) {
      console.log(`${c.green}Repair check: no action required.${c.reset}`);
    } else {
      console.log(`${c.yellow}Repair check: run 'kindx cleanup' or 'kindx embed' depending on failed checks.${c.reset}`);
    }
  }
  return code;
}

function runBackupCommand(args: string[], values: Record<string, unknown>, output: OutputFormat): number {
  const sub = args[0];
  const dbPath = getDbPath();

  if (sub === "create") {
    const requested = typeof values.path === "string" ? values.path : args[1];
    const backupPath = requested || resolve(dirname(dbPath), getDefaultBackupName(dbPath));
    const result = createBackup(dbPath, backupPath);
    if (output === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${c.green}✓${c.reset} Backup created: ${result.backupPath}`);
      console.log(`  Size: ${formatBytes(result.bytes)}`);
      console.log(`  WAL checkpoint: ${result.checkpointed ? "yes" : "no"}`);
      console.log(`  Encrypted: ${result.encrypted ? "yes" : "no"}`);
    }
    return 0;
  }

  if (sub === "verify") {
    const pathArg = typeof values.path === "string" ? values.path : args[1];
    if (!pathArg) {
      console.error("Usage: kindx backup verify <backup-file>");
      return 1;
    }
    const result = verifyBackup(pathArg);
    if (output === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.integrity === "ok") {
      console.log(`${c.green}✓${c.reset} Backup verified: ${result.backupPath}`);
      console.log(`  Size: ${formatBytes(result.bytes)}`);
      console.log(`  Encrypted: ${result.encrypted ? "yes" : "no"}${result.keyRequired ? " (key required)" : ""}`);
    } else {
      console.error(`${c.yellow}!${c.reset} Backup verify failed: ${result.detail}`);
    }
    return result.integrity === "ok" ? 0 : 2;
  }

  if (sub === "restore") {
    const pathArg = typeof values.path === "string" ? values.path : args[1];
    if (!pathArg) {
      console.error("Usage: kindx backup restore <backup-file> [--force]");
      return 1;
    }
    const force = values.force === true || values.force === "true";
    const result = restoreBackup(pathArg, dbPath, Boolean(force));
    if (output === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${c.green}✓${c.reset} Restored backup to ${result.restoredTo}`);
    }
    return 0;
  }

  console.error("Usage: kindx backup <create|verify|restore> [path] [--force]");
  return 1;
}

async function updateCollections(
  collectionFilter?: string | string[],
  options: { pull?: boolean } = {}
): Promise<void> {
  const db = getDb();
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Clear Ollama cache on update
  clearCache(db);

  let collections = listCollections(db);

  if (collections.length === 0) {
    console.log(`${c.dim}No collections found. Run 'kindx collection add .' to index markdown files.${c.reset}`);
    closeDb();
    return;
  }

  // Filter to a single collection if --collection flag was provided
  if (collectionFilter) {
    const filterName = Array.isArray(collectionFilter)
      ? collectionFilter[0]
      : collectionFilter;
    collections = collections.filter(col => col.name === filterName);
    if (collections.length === 0) {
      console.error(`${c.yellow}Collection not found: ${filterName}${c.reset}`);
      console.error(`Run 'kindx collection list' to see available collections.`);
      closeDb();
      process.exit(1);
    }
  }

  // Don't close db here - indexFiles will reuse it and close at the end
  console.log(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (!col) continue;
    console.log(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.name}${c.reset} ${c.dim}(${col.glob_pattern})${c.reset}`);

    if (options.pull) {
      const pullResult = await new Promise<{ isGitRepo: boolean; output: string; error: string; code: number }>((resolve) => {
        const proc = nodeSpawn("git", ["pull", "--ff-only"], {
          cwd: col.pwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
        proc.on("close", (code) => {
          const notRepo = /not a git repository|fatal: no upstream configured/i.test(err);
          resolve({
            isGitRepo: !notRepo,
            output: out,
            error: err,
            code: code ?? 1,
          });
        });
        proc.on("error", () => resolve({ isGitRepo: false, output: "", error: "", code: 1 }));
      });

      if (pullResult.isGitRepo) {
        console.log(`${c.dim}    --pull: git pull --ff-only${c.reset}`);
        if (pullResult.output.trim()) process.stdout.write(pullResult.output);
        if (pullResult.error.trim()) process.stderr.write(pullResult.error);
        if (pullResult.code !== 0) {
          console.error(`${c.yellow}    ! --pull failed (exit ${pullResult.code}); continuing with local files.${c.reset}`);
        }
      } else {
        console.log(`${c.dim}    --pull skipped (not a git repository).${c.reset}`);
      }
    }

    // Execute custom update command if specified in YAML
    const yamlCol = getCollectionFromYaml(col.name);
    if (yamlCol?.update) {
      console.log(`${c.dim}    Update command found: ${yamlCol.update}${c.reset}`);
      
      // P0-3: Trust gate for arbitrary shell execution
      const isAutoTrusted = process.env.KINDX_TRUST_UPDATE_CMDS === "1" || process.env.KINDX_TRUST_UPDATE_CMDS === "true";
      const trustFile = pathJoin(dirname(getDbPath()), "trusted-commands.json");
      const cmdHash = createHash("sha256").update(`${col.name}|${col.pwd}|${yamlCol.update}`).digest("hex");
      
      let isTrusted = isAutoTrusted;
      let trustedHashes: string[] = [];
      
      if (!isTrusted) {
        try {
          if (existsSync(trustFile)) {
            trustedHashes = JSON.parse(readFileSync(trustFile, "utf-8"));
            isTrusted = trustedHashes.includes(cmdHash);
          }
        } catch {
          // File missing or malformed, will prompt
        }
      }

      if (!isTrusted) {
        if (!process.stdin.isTTY) {
          console.error(`${c.yellow}✗ Cannot prompt in non-TTY environment. Set KINDX_TRUST_UPDATE_CMDS=1 to allow this command.${c.reset}`);
          process.exit(1);
        }

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        console.log(`\n${c.yellow}⚠️  Security Warning: Collection '${col.name}' has configured a shell command to run before indexing:${c.reset}`);
        console.log(`\n  $ ${yamlCol.update}\n`);
        console.log(`  Directory: ${col.pwd}`);

        const answer = await new Promise<string>((resolve) => {
          rl.question(`Allow executing this command? [y/N]: `, resolve);
        });
        rl.close();

        if (answer.trim().toLowerCase() !== "y") {
          console.log(`${c.yellow}✗ Command execution cancelled.${c.reset}`);
          process.exit(1);
        }

        trustedHashes.push(cmdHash);
        try {
          writeFileSync(trustFile, JSON.stringify(trustedHashes), { encoding: "utf-8", mode: 0o600 });
          console.log(`${c.green}✓ Command trusted for future runs.${c.reset}`);
        } catch (err) {
          console.error(`Failed to save trust marker: ${err}`);
        }
      }

      console.log(`${c.dim}    Executing...${c.reset}`);
      try {
        const proc = nodeSpawn("bash", ["-c", yamlCol.update], {
          cwd: col.pwd,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const [output, errorOutput, exitCode] = await new Promise<[string, string, number]>((resolve, reject) => {
          let out = "";
          let err = "";
          proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
          proc.on("error", reject);
          proc.on("close", (code) => resolve([out, err, code ?? 1]));
        });

        if (output.trim()) {
          console.log(output.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }
        if (errorOutput.trim()) {
          console.log(errorOutput.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }

        if (exitCode !== 0) {
          console.log(`${c.yellow}✗ Update command failed with exit code ${exitCode}${c.reset}`);
          process.exit(exitCode);
        }
      } catch (err) {
        console.log(`${c.yellow}✗ Update command failed: ${err}${c.reset}`);
        process.exit(1);
      }
    }

    await indexFiles(col.pwd, col.glob_pattern, col.name, true, yamlCol?.ignore);
    console.log("");
  }

  // Check if any documents need embedding (show once at end)
  const finalDb = getDb();
  const needsEmbedding = getHashesNeedingEmbedding(finalDb);
  closeDb();

  console.log(`${c.green}✓ All collections updated.${c.reset}`);
  if (needsEmbedding > 0) {
    console.log(`\nRun 'kindx embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }
}

/**
 * Detect which collection (if any) contains the given filesystem path.
 * Returns { collectionId, collectionName, relativePath } or null if not in any collection.
 */
function detectCollectionFromPath(db: Database, fsPath: string): { collectionName: string; relativePath: string } | null {
  const realPath = getRealPath(fsPath);

  // Find collections that this path is under from YAML
  const allCollections = yamlListCollections();

  // Find longest matching path
  let bestMatch: { name: string; path: string } | null = null;
  for (const coll of allCollections) {
    if (realPath.startsWith(coll.path + '/') || realPath === coll.path) {
      if (!bestMatch || coll.path.length > bestMatch.path.length) {
        bestMatch = { name: coll.name, path: coll.path };
      }
    }
  }

  if (!bestMatch) return null;

  // Calculate relative path
  let relativePath = realPath;
  if (relativePath.startsWith(bestMatch.path + '/')) {
    relativePath = relativePath.slice(bestMatch.path.length + 1);
  } else if (relativePath === bestMatch.path) {
    relativePath = '';
  }

  return {
    collectionName: bestMatch.name,
    relativePath
  };
}

async function contextAdd(pathArg: string | undefined, contextText: string): Promise<void> {
  const db = getDb();

  // Handle "/" as global context (applies to all collections)
  if (pathArg === '/') {
    setGlobalContext(contextText);
    console.log(`${c.green}✓${c.reset} Set global context`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Resolve path - defaults to current directory if not provided
  let fsPath = pathArg || '.';
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/') && !fsPath.startsWith('kindx://')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  // Handle virtual paths (kindx://collection/path)
  if (isVirtualPath(fsPath)) {
    const parsed = parseVirtualPath(fsPath);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${fsPath}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    yamlAddContext(parsed.collectionName, parsed.path, contextText);

    const displayPath = parsed.path
      ? `kindx://${parsed.collectionName}/${parsed.path}`
      : `kindx://${parsed.collectionName}/ (collection root)`;
    console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Detect collection from filesystem path
  const detected = detectCollectionFromPath(db, fsPath);
  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    console.error(`${c.dim}Run 'kindx status' to see indexed collections${c.reset}`);
    process.exit(1);
  }

  yamlAddContext(detected.collectionName, detected.relativePath, contextText);

  const displayPath = detected.relativePath ? `kindx://${detected.collectionName}/${detected.relativePath}` : `kindx://${detected.collectionName}/`;
  console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
  console.log(`${c.dim}Context: ${contextText}${c.reset}`);
  closeDb();
}

function contextList(): void {
  const db = getDb();

  const allContexts = listAllContexts();

  if (allContexts.length === 0) {
    console.log(`${c.dim}No contexts configured. Use 'kindx context add' to add one.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

  let lastCollection = '';
  for (const ctx of allContexts) {
    if (ctx.collection !== lastCollection) {
      console.log(`${c.cyan}${ctx.collection}${c.reset}`);
      lastCollection = ctx.collection;
    }

    const displayPath = ctx.path ? `  ${ctx.path}` : '  / (root)';
    console.log(`${displayPath}`);
    console.log(`    ${c.dim}${ctx.context}${c.reset}`);
  }

  closeDb();
}

function contextRemove(pathArg: string): void {
  if (pathArg === '/') {
    // Remove global context
    setGlobalContext(undefined);
    console.log(`${c.green}✓${c.reset} Removed global context`);
    return;
  }

  // Handle virtual paths
  if (isVirtualPath(pathArg)) {
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    const success = yamlRemoveContext(coll.name, parsed.path);

    if (!success) {
      console.error(`${c.yellow}No context found for: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    console.log(`${c.green}✓${c.reset} Removed context for: ${pathArg}`);
    return;
  }

  // Handle filesystem paths
  let fsPath = pathArg;
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  const db = getDb();
  const detected = detectCollectionFromPath(db, fsPath);
  closeDb();

  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    process.exit(1);
  }

  const success = yamlRemoveContext(detected.collectionName, detected.relativePath);

  if (!success) {
    console.error(`${c.yellow}No context found for: kindx://${detected.collectionName}/${detected.relativePath}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.green}✓${c.reset} Removed context for: kindx://${detected.collectionName}/${detected.relativePath}`);
}

function getDocument(filename: string, fromLine?: number, maxLines?: number, lineNumbers?: boolean): void {
  const db = getDb();

  // Parse :linenum suffix from filename (e.g., "file.md:100")
  let inputPath = filename;
  const colonMatch = inputPath.match(/:(\d+)$/);
  if (colonMatch && !fromLine) {
    const matched = colonMatch[1];
    if (matched) {
      fromLine = parseInt(matched, 10);
      inputPath = inputPath.slice(0, -colonMatch[0].length);
    }
  }

  // Handle docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  if (isDocid(inputPath)) {
    const docidMatch = findDocumentByDocid(db, inputPath);
    if (docidMatch) {
      inputPath = docidMatch.filepath;
    } else {
      console.error(`Document not found: ${filename}`);
      closeDb();
      process.exit(1);
    }
  }

  let doc: { collectionName: string; path: string; body: string } | null = null;
  let virtualPath: string;

  // Handle virtual paths (kindx://collection/path)
  if (isVirtualPath(inputPath)) {
    const parsed = parseVirtualPath(inputPath);
    if (!parsed) {
      console.error(`Invalid virtual path: ${inputPath}`);
      closeDb();
      process.exit(1);
    }

    // Try exact match on collection + path
    doc = db.prepare(`
      SELECT d.collection as collectionName, d.path, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(parsed.collectionName, parsed.path) as typeof doc;

    if (!doc) {
      // Try fuzzy match by path ending
      doc = db.prepare(`
        SELECT d.collection as collectionName, d.path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(parsed.collectionName, `%${parsed.path}`) as typeof doc;
    }

    virtualPath = inputPath;
  } else {
    // Try to interpret as collection/path format first (before filesystem path)
    // If path is relative (no / or ~ prefix), check if first component is a collection name
    if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
      const parts = inputPath.split('/');
      if (parts.length >= 2) {
        const possibleCollection = parts[0];
        const possiblePath = parts.slice(1).join('/');

        // Check if this collection exists
        const collExists = possibleCollection ? db.prepare(`
          SELECT 1 FROM documents WHERE collection = ? AND active = 1 LIMIT 1
        `).get(possibleCollection) : null;

        if (collExists) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT d.collection as collectionName, d.path, content.doc as body
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(possibleCollection || "", possiblePath || "") as { collectionName: string; path: string; body: string } | null;

          if (!doc) {
            // Try fuzzy match by path ending
            doc = db.prepare(`
              SELECT d.collection as collectionName, d.path, content.doc as body
              FROM documents d
              JOIN content ON content.hash = d.hash
              WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
              LIMIT 1
            `).get(possibleCollection || "", `%${possiblePath}`) as { collectionName: string; path: string; body: string } | null;
          }

          if (doc) {
            virtualPath = buildVirtualPath(doc.collectionName, doc.path);
            // Skip the filesystem path handling below
          }
        }
      }
    }

    // If not found as collection/path, handle as filesystem paths
    if (!doc) {
      let fsPath = inputPath;

      // Expand ~ to home directory
      if (fsPath.startsWith('~/')) {
        fsPath = homedir() + fsPath.slice(1);
      } else if (!fsPath.startsWith('/')) {
        // Relative path - resolve from current directory
        fsPath = resolve(getPwd(), fsPath);
      }
      fsPath = getRealPath(fsPath);

      // Try to detect which collection contains this path
      const detected = detectCollectionFromPath(db, fsPath);

      if (detected) {
        // Found collection - query by collection name + relative path
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(detected.collectionName, detected.relativePath) as { collectionName: string; path: string; body: string } | null;
      }

      // Fuzzy match by filename (last component of path)
      if (!doc) {
        const filename = inputPath.split('/').pop() || inputPath;
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${filename}`) as { collectionName: string; path: string; body: string } | null;
      }

      if (doc) {
        virtualPath = buildVirtualPath(doc.collectionName, doc.path);
      } else {
        virtualPath = inputPath;
      }
    }
  }

  // Ensure doc is not null before proceeding
  if (!doc) {
    console.error(`Document not found: ${filename}`);
    closeDb();
    process.exit(1);
  }

  // Get context for this file
  const context = getContextForPath(db, doc.collectionName, doc.path);

  let output = doc.body;
  const startLine = fromLine || 1;

  // Apply line filtering if specified
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = output.split('\n');
    const start = startLine - 1; // Convert to 0-indexed
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    output = lines.slice(start, end).join('\n');
  }

  // Add line numbers if requested
  if (lineNumbers) {
    output = addLineNumbers(output, startLine);
  }

  // Output context header if exists
  if (context) {
    console.log(`Folder Context: ${context}\n---\n`);
  }
  console.log(output);
  closeDb();
}

// Multi-get: fetch multiple documents by glob pattern or comma-separated list
function multiGet(pattern: string, maxLines?: number, maxBytes: number = DEFAULT_MULTI_GET_MAX_BYTES, format: OutputFormat = "cli"): void {
  const db = getDb();

  // Check if it's a comma-separated list or a glob pattern
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?');

  let files: { filepath: string; displayPath: string; bodyLength: number; collection?: string; path?: string }[];

  if (isCommaSeparated) {
    // Comma-separated list of files (can be virtual paths, local paths, or #docids)
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    files = [];
    for (const name of names) {
      const found = findDocument(db, name, { includeBody: false });
      if (!("error" in found)) {
        files.push({
          filepath: found.filepath,
          displayPath: found.displayPath,
          bodyLength: found.bodyLength,
          collection: found.collectionName,
          path: found.filepath.replace(`kindx://${found.collectionName}/`, '')
        });
      } else {
        console.error(`File not found: ${name}`);
      }
    }
  } else {
    // Glob pattern - matchFilesByGlob now returns virtual paths
    files = matchFilesByGlob(db, pattern).map(f => ({
      ...f,
      collection: undefined,  // Will be fetched later if needed
      path: undefined
    }));
    if (files.length === 0) {
      console.error(`No files matched pattern: ${pattern}`);
      closeDb();
      process.exit(1);
    }
  }

  // Collect results for structured output
  const results: { file: string; displayPath: string; title: string; body: string; context: string | null; skipped: boolean; skipReason?: string }[] = [];

  for (const file of files) {
    // Parse virtual path to get collection info if not already available
    let collection = file.collection;
    let path = file.path;

    if (!collection || !path) {
      const parsed = parseVirtualPath(file.filepath);
      if (parsed) {
        collection = parsed.collectionName;
        path = parsed.path;
      }
    }

    // Get context using collection-scoped function
    const context = collection && path ? getContextForPath(db, collection, path) : null;

    // Check size limit
    if (file.bodyLength > maxBytes) {
      results.push({
        file: file.filepath,
        displayPath: file.displayPath,
        title: file.displayPath.split('/').pop() || file.displayPath,
        body: "",
        context,
        skipped: true,
        skipReason: `File too large (${Math.round(file.bodyLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB). Use 'kindx get ${file.displayPath}' to retrieve.`,
      });
      continue;
    }

    // Fetch document content using collection and path
    if (!collection || !path) continue;

    const doc = db.prepare(`
      SELECT content.doc as body, d.title
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(collection, path) as { body: string; title: string } | null;

    if (!doc) continue;

    let body = doc.body;

    // Apply line limit if specified
    if (maxLines !== undefined) {
      const lines = body.split('\n');
      body = lines.slice(0, maxLines).join('\n');
      if (lines.length > maxLines) {
        body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
      }
    }

    results.push({
      file: file.filepath,
      displayPath: file.displayPath,
      title: doc.title || file.displayPath.split('/').pop() || file.displayPath,
      body,
      context,
      skipped: false,
    });
  }

  closeDb();

  // Output based on format
  if (format === "json") {
    const output = results.map(r => ({
      file: r.displayPath,
      title: r.title,
      ...(r.context && { context: r.context }),
      ...(r.skipped ? { skipped: true, reason: r.skipReason } : { body: r.body }),
    }));
    console.log(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    console.log("file,title,context,skipped,body");
    for (const r of results) {
      console.log([r.displayPath, r.title, r.context, r.skipped ? "true" : "false", r.skipped ? r.skipReason : r.body].map(escapeField).join(","));
    }
  } else if (format === "files") {
    for (const r of results) {
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      console.log(`${r.displayPath}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      console.log(`## ${r.displayPath}\n`);
      if (r.title && r.title !== r.displayPath) console.log(`**Title:** ${r.title}\n`);
      if (r.context) console.log(`**Context:** ${r.context}\n`);
      if (r.skipped) {
        console.log(`> ${r.skipReason}\n`);
      } else {
        console.log("```");
        console.log(r.body);
        console.log("```\n");
      }
    }
  } else if (format === "xml") {
    console.log('<?xml version="1.0" encoding="UTF-8"?>');
    console.log("<documents>");
    for (const r of results) {
      console.log("  <document>");
      console.log(`    <file>${escapeXml(r.displayPath)}</file>`);
      console.log(`    <title>${escapeXml(r.title)}</title>`);
      if (r.context) console.log(`    <context>${escapeXml(r.context)}</context>`);
      if (r.skipped) {
        console.log(`    <skipped>true</skipped>`);
        console.log(`    <reason>${escapeXml(r.skipReason || "")}</reason>`);
      } else {
        console.log(`    <body>${escapeXml(r.body)}</body>`);
      }
      console.log("  </document>");
    }
    console.log("</documents>");
  } else {
    // CLI format (default)
    for (const r of results) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`File: ${r.displayPath}`);
      console.log(`${'='.repeat(60)}\n`);

      if (r.skipped) {
        console.log(`[SKIPPED: ${r.skipReason}]`);
        continue;
      }

      if (r.context) {
        console.log(`Folder Context: ${r.context}\n---\n`);
      }
      console.log(r.body);
    }
  }
}

// List files in virtual file tree
function listFiles(pathArg?: string): void {
  const db = getDb();

  if (!pathArg) {
    // No argument - list all collections
    const yamlCollections = yamlListCollections();

    if (yamlCollections.length === 0) {
      console.log("No collections found. Run 'kindx collection add .' to index files.");
      closeDb();
      return;
    }

    // Get file counts from database for each collection
    const collections = yamlCollections.map(coll => {
      const stats = db.prepare(`
        SELECT COUNT(*) as file_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { file_count: number } | null;

      return {
        name: coll.name,
        file_count: stats?.file_count || 0
      };
    });

    console.log(`${c.bold}Collections:${c.reset}\n`);
    for (const coll of collections) {
      console.log(`  ${c.dim}kindx://${c.reset}${c.cyan}${coll.name}/${c.reset}  ${c.dim}(${coll.file_count} files)${c.reset}`);
    }
    closeDb();
    return;
  }

  // Parse the path argument
  let collectionName: string;
  let pathPrefix: string | null = null;

  if (pathArg.startsWith('kindx://')) {
    // Virtual path format: kindx://collection/path
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`Invalid virtual path: ${pathArg}`);
      closeDb();
      process.exit(1);
    }
    collectionName = parsed.collectionName;
    pathPrefix = parsed.path;
  } else {
    // Just collection name or collection/path
    const parts = pathArg.split('/');
    collectionName = parts[0] || '';
    if (parts.length > 1) {
      pathPrefix = parts.slice(1).join('/');
    }
  }

  // Get the collection
  const coll = getCollectionFromYaml(collectionName);
  if (!coll) {
    console.error(`Collection not found: ${collectionName}`);
    console.error(`Run 'kindx ls' to see available collections.`);
    closeDb();
    process.exit(1);
  }

  // List files in the collection with size and modification time
  let query: string;
  let params: any[];

  if (pathPrefix) {
    // List files under a specific path
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name, `${pathPrefix}%`];
  } else {
    // List all files in the collection
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name];
  }

  const files = db.prepare(query).all(...params) as { path: string; title: string; modified_at: string; size: number }[];

  if (files.length === 0) {
    if (pathPrefix) {
      console.log(`No files found under kindx://${collectionName}/${pathPrefix}`);
    } else {
      console.log(`No files found in collection: ${collectionName}`);
    }
    closeDb();
    return;
  }

  // Calculate max widths for alignment
  const maxSize = Math.max(...files.map(f => formatBytes(f.size).length));

  // Output in ls -l style
  for (const file of files) {
    const sizeStr = formatBytes(file.size).padStart(maxSize);
    const date = new Date(file.modified_at);
    const timeStr = formatLsTime(date);

    // Dim the kindx:// prefix, highlight the filename
    console.log(`${sizeStr}  ${timeStr}  ${c.dim}kindx://${collectionName}/${c.reset}${c.cyan}${file.path}${c.reset}`);
  }

  closeDb();
}

// Format date/time like ls -l
function formatLsTime(date: Date): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, ' ');

  // If file is older than 6 months, show year instead of time
  if (date < sixMonthsAgo) {
    const year = date.getFullYear();
    return `${month} ${day}  ${year}`;
  } else {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  }
}

// Collection management commands
function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log("No collections found. Run 'kindx collection add .' to create one.");
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified ? new Date(coll.last_modified) : new Date();
    const timeAgo = formatTimeAgo(updatedAt);

    // Get YAML config to check includeByDefault
    const yamlColl = getCollectionFromYaml(coll.name);
    const excluded = yamlColl?.includeByDefault === false;
    const excludeTag = excluded ? ` ${c.yellow}[excluded]${c.reset}` : '';

    console.log(`${c.cyan}${coll.name}${c.reset} ${c.dim}(kindx://${coll.name}/)${c.reset}${excludeTag}`);
    console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
    if (yamlColl?.ignore?.length) {
      console.log(`  ${c.dim}Ignore:${c.reset}   ${yamlColl.ignore.join(', ')}`);
    }
    console.log(`  ${c.dim}Files:${c.reset}    ${coll.active_count}`);
    console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

async function collectionAdd(pwd: string, globPattern: string, name?: string): Promise<void> {
  // If name not provided, generate from pwd basename
  let collName = name;
  if (!collName) {
    const parts = pwd.split('/').filter(Boolean);
    collName = parts[parts.length - 1] || 'root';
  }

  // Validate that the path exists and is a directory
  if (!existsSync(pwd)) {
    console.error(`Error: Directory does not exist: ${pwd}`);
    process.exit(1);
  }
  const dirStat = statSync(pwd);
  if (!dirStat.isDirectory()) {
    console.error(`Error: Path is not a directory: ${pwd}`);
    process.exit(1);
  }

  // Check if collection with this name already exists in YAML
  const existing = getCollectionFromYaml(collName);
  if (existing) {
    console.error(`${c.yellow}Collection '${collName}' already exists.${c.reset}`);
    console.error(`Use a different name with --name <name>`);
    process.exit(1);
  }

  // Check if a collection with this pwd+glob already exists in YAML
  const allCollections = yamlListCollections();
  const existingPwdGlob = allCollections.find(c => c.path === pwd && c.pattern === globPattern);

  if (existingPwdGlob) {
    console.error(`${c.yellow}A collection already exists for this path and pattern:${c.reset}`);
    console.error(`  Name: ${existingPwdGlob.name} (kindx://${existingPwdGlob.name}/)`);
    console.error(`  Pattern: ${globPattern}`);
    console.error(`\nUse 'kindx update' to re-index it, or remove it first with 'kindx collection remove ${existingPwdGlob.name}'`);
    process.exit(1);
  }

  // Add to YAML config
  const { addCollection } = await import("./catalogs.js");
  addCollection(collName, pwd, globPattern);

  // Create the collection and index files
  console.log(`Creating collection '${collName}'...`);
  const newColl = getCollectionFromYaml(collName);
  await indexFiles(pwd, globPattern, collName, false, newColl?.ignore);
  console.log(`${c.green}✓${c.reset} Collection '${collName}' created successfully`);
}

function collectionRemove(name: string): void {
  // Check if collection exists in YAML
  const coll = getCollectionFromYaml(name);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${name}${c.reset}`);
    console.error(`Run 'kindx collection list' to see available collections.`);
    process.exit(1);
  }

  const db = getDb();
  const result = removeCollection(db, name);
  closeDb();

  console.log(`${c.green}✓${c.reset} Removed collection '${name}'`);
  console.log(`  Deleted ${result.deletedDocs} documents`);
  if (result.cleanedHashes > 0) {
    console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
  }
}

function collectionRename(oldName: string, newName: string): void {
  // Check if old collection exists in YAML
  const coll = getCollectionFromYaml(oldName);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${oldName}${c.reset}`);
    console.error(`Run 'kindx collection list' to see available collections.`);
    process.exit(1);
  }

  // Check if new name already exists in YAML
  const existing = getCollectionFromYaml(newName);
  if (existing) {
    console.error(`${c.yellow}Collection name already exists: ${newName}${c.reset}`);
    console.error(`Choose a different name or remove the existing collection first.`);
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  closeDb();

  console.log(`${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`);
  console.log(`  Virtual paths updated: ${c.cyan}kindx://${oldName}/${c.reset} → ${c.cyan}kindx://${newName}/${c.reset}`);
}

async function indexFiles(pwd?: string, globPattern: string = DEFAULT_GLOB, collectionName?: string, suppressEmbedNotice: boolean = false, ignorePatterns?: string[]): Promise<void> {
  const db = getDb();
  const resolvedPwd = pwd || getPwd();
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  // Clear Ollama cache on index
  clearCache(db);

  // Collection name must be provided (from YAML)
  if (!collectionName) {
    throw new Error("Collection name is required. Collections must be defined in ~/.config/kindx/index.yml");
  }

  console.log(`Collection: ${resolvedPwd} (${globPattern})`);

  progress.indeterminate();
  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(globPattern, {
    cwd: resolvedPwd,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders (dot: false handles top-level but not nested)
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  const hasNoFiles = total === 0;
  if (hasNoFiles) {
    progress.clear();
    console.log("No files found matching pattern.");
    // Continue so the deactivation pass can mark previously indexed docs as inactive.
  }

  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();
  const startTime = Date.now();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(resolvedPwd, relativeFile));
    const path = handelize(relativeFile); // Normalize path for token-friendliness
    seenPaths.add(path);

    let content: string;
    let ingestWarnings: string[] = [];
    let ingestFormat = "unknown";
    let ingestExtractor = "unknown";
    try {
      const ingested = await ingestFile(filepath);
      content = ingested.text;
      ingestWarnings = ingested.warnings;
      ingestFormat = ingested.metadata.format;
      ingestExtractor = ingested.metadata.extractor;
    } catch (err: any) {
      // Skip files that can't be read (e.g. iCloud evicted files returning EAGAIN)
      processed++;
      progress.set((processed / total) * 100);
      continue;
    }

    // Skip empty files - nothing useful to index
    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    // Check if document exists in this collection with this path
    const existing = findActiveDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        // Hash unchanged, but check if title needs updating
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        // Content changed - insert new content hash and update document
        insertContent(db, hash, content, now);
        const stat = statSync(filepath);
        updateDocument(db, existing.id, title, hash,
          stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
      upsertDocumentIngestion(db, collectionName, path, {
        format: ingestFormat,
        extractor: ingestExtractor,
        warnings: ingestWarnings,
        contentHash: hash,
        extractedAt: now,
      });
      // Extract and flush cross-reference links
      const { extractInternalLinks } = await import("./link-extractor.js");
      const { upsertDocumentLinks } = await import("./repository.js");
      const links = extractInternalLinks(content, relativeFile);
      upsertDocumentLinks(db, collectionName, path, links);
    } else {
      // New document - insert content and document
      indexed++;
      insertContent(db, hash, content, now);
      const stat = statSync(filepath);
      insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
      upsertDocumentIngestion(db, collectionName, path, {
        format: ingestFormat,
        extractor: ingestExtractor,
        warnings: ingestWarnings,
        contentHash: hash,
        extractedAt: now,
      });
      // Extract and flush cross-reference links
      const { extractInternalLinks } = await import("./link-extractor.js");
      const { upsertDocumentLinks } = await import("./repository.js");
      const links = extractInternalLinks(content, relativeFile);
      upsertDocumentLinks(db, collectionName, path, links);
    }


    processed++;
    progress.set((processed / total) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const remaining = (total - processed) / rate;
    const eta = processed > 2 ? ` ETA: ${formatETA(remaining)}` : "";
    if (isTTY) process.stderr.write(`\rIndexing: ${processed}/${total}${eta}        `);
  }

  // Deactivate documents in this collection that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  // Clean up orphaned content hashes (content not referenced by any document)
  const orphanedContent = cleanupOrphanedContent(db);

  // Check if vector index needs updating
  const needsEmbedding = getHashesNeedingEmbedding(db);

  progress.clear();
  console.log(`\nIndexed: ${indexed} new, ${updated} updated, ${unchanged} unchanged, ${removed} removed`);
  if (orphanedContent > 0) {
    console.log(`Cleaned up ${orphanedContent} orphaned content hash(es)`);
  }

  if (needsEmbedding > 0 && !suppressEmbedNotice) {
    console.log(`\nRun 'kindx embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }

  closeDb();
}



async function vectorIndex(model: string = DEFAULT_EMBED_MODEL, force: boolean = false, resume: boolean = false): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const reporter = getReporter();
  const palette = paletteFor(useColor);
  // Decide once whether this invocation wants visual chrome (spinners, progress
  // bar, banner lines) or just structured/silent stderr.
  const visualUi = _reporterFormatHint !== "json" && _reporterFormatHint !== "csv" &&
                   _reporterFormatHint !== "md"   && _reporterFormatHint !== "xml"   &&
                   _reporterFormatHint !== "files" && !_reporterQuietHint;

  // If force, clear all vectors
  if (force) {
    reporter.warn("force-reindex", "Force re-indexing: clearing all vectors");
    clearAllEmbeddings(db);
  }

  // Find unique hashes that need embedding (from active documents)
  const hashesToEmbed = getHashesForEmbedding(db);

  if (hashesToEmbed.length === 0) {
    if (visualUi) console.log(`${palette.green("✓")} All content hashes already have embeddings.`);
    reporter.done();
    closeDb();
    return;
  }

  // Prepare documents with chunks
  type ChunkItem = { hash: string; title: string; text: string; seq: number; pos: number; tokens: number; bytes: number; displayName: string };
  const allChunks: ChunkItem[] = [];
  let multiChunkDocs = 0;

  // Chunk all documents using actual token counts
  reporter.start("chunk", `Chunking ${hashesToEmbed.length} documents by token count`);
  for (const item of hashesToEmbed) {
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(item.body).length;
    if (bodyBytes === 0) continue; // Skip empty

    const title = extractTitle(item.body, item.path);
    const displayName = item.path;
    const chunks = await chunkDocumentByTokens(item.body);  // Uses actual tokenizer

    if (chunks.length > 1) multiChunkDocs++;

    for (let seq = 0; seq < chunks.length; seq++) {
      allChunks.push({
        hash: item.hash,
        title,
        text: chunks[seq]!.text, // Chunk is guaranteed to exist by seq loop
        seq,
        pos: chunks[seq]!.pos,
        tokens: chunks[seq]!.tokens,
        bytes: encoder.encode(chunks[seq]!.text).length,
        displayName,
      });
    }
  }

  if (allChunks.length === 0) {
    reporter.end("chunk");
    if (visualUi) console.log(`${palette.green("✓")} No non-empty documents to embed.`);
    reporter.done();
    closeDb();
    return;
  }

  const totalBytes = allChunks.reduce((sum, chk) => sum + chk.bytes, 0);
  const totalChunks = allChunks.length;
  const totalDocs = hashesToEmbed.length;

  reporter.end("chunk", { detail: { docs: totalDocs, chunks: totalChunks, bytes: totalBytes, multiChunkDocs } });

  if (visualUi) {
    console.log(`${palette.bold(`Embedding ${totalDocs} documents`)} ${palette.dim(`(${totalChunks} chunks, ${formatBytes(totalBytes)})`)}`);
    if (multiChunkDocs > 0) {
      console.log(palette.dim(`${multiChunkDocs} documents split into multiple chunks`));
    }
    console.log(palette.dim(`Model: ${model}`) + "\n");
    // Hide cursor during embedding for the in-place progress bar.
    cursor.hide();
  }

  // Wrap all LLM embedding operations in a session for lifecycle management
  // Use 30 minute timeout for large collections
  await withLLMSession(async (session) => {
    // Get embedding dimensions from first chunk
    progress.indeterminate();
    reporter.start("model-load", "Loading embedding model and connecting to GPU/CPU");
    const initSpinner = visualUi ? spinner("Loading embedding model and connecting to GPU/CPU...").start() : null;
    const firstChunk = allChunks[0];
    if (!firstChunk) {
      initSpinner?.fail("No chunks available");
      reporter.error("model-load", "No chunks available");
      throw new Error("No chunks available to embed");
    }
    const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title);
    const firstResult = await session.embed(firstText);
    if (!firstResult) {
      initSpinner?.fail("Model loading failed");
      reporter.error("model-load", `Model loading failed: ${model}`);
      throw new Error(`Failed to embed first chunk. The embedding model may not be available or failed to load.\n  Model: ${model}\n  Check the model exists and you have network access for the initial download.`);
    }
    initSpinner?.succeed("Model loaded successfully");
    reporter.end("model-load");
    // The embed loop renders its own progress bar via renderProgressBar()
    // each batch (see below, ~line 2140). Pass bar: true so the reporter
    // records the phase but does not animate a competing spinner that
    // would overwrite the bar 12× per second.
    reporter.start("embed", `Embedding ${totalDocs} documents (${totalChunks} chunks)`, { bar: true });
    ensureVecTable(db, firstResult.embedding.length);

    let chunksEmbedded = 0, errors = 0, bytesProcessed = 0;
    const startTime = Date.now();

    // Batch embedding for better throughput
    // Process in batches of 32 to balance memory usage and efficiency
    const BATCH_SIZE = 32;

    for (let batchStart = 0; batchStart < allChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, allChunks.length);
      const batch = allChunks.slice(batchStart, batchEnd);

      // Format texts for embedding
      const texts = batch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title));

      try {
        // Batch embed all texts at once
        const batchEmbedStart = Date.now();
        const embeddings = await session.embedBatch(texts);
        const batchEmbedDuration = Date.now() - batchEmbedStart;

        // Collect successful embeddings and insert them in a single transaction.
        // This amortises the WAL flush cost across the entire batch (32 chunks
        // by default), giving a 10-50× throughput improvement over per-row commits.
        const toInsert: {
          hash: string; seq: number; pos: number;
          embedding: Float32Array; model: string; embeddedAt: string;
        }[] = [];

        // Aggregate usage across the batch for a single ledger entry.
        let batchInputTokens = 0;
        let batchTotalTokens = 0;
        let batchSuccessCount = 0;

        for (let i = 0; i < batch.length; i++) {
          const chunk = batch[i]!;
          const embedding = embeddings[i];

          if (embedding) {
            toInsert.push({
              hash: chunk.hash,
              seq: chunk.seq,
              pos: chunk.pos,
              embedding: new Float32Array(embedding.embedding),
              model,
              embeddedAt: now,
            });
            chunksEmbedded++;
            batchSuccessCount++;

            // Accumulate usage from each embedding result.
            if (embedding.usage) {
              batchInputTokens += embedding.usage.prompt_tokens;
              batchTotalTokens += embedding.usage.total_tokens;
            }
          } else {
            errors++;
            reporter.warn("embed-failed", `Error embedding "${chunk.displayName}" chunk ${chunk.seq}`, { hash: chunk.hash, seq: chunk.seq });
          }
          bytesProcessed += chunk.bytes;
        }

        // Commit all successful embeddings atomically
        bulkInsertEmbeddings(db, toInsert);

        // Record batch-level AI usage to the ledger.
        if (batchSuccessCount > 0) {
          const provider = process.env.KINDX_LLM_BACKEND === "remote" ? "remote_openai" as const : "llama_cpp" as const;
          recordDirectUsage(db, {
            operation: "embed_batch",
            model,
            provider,
            usage: {
              prompt_tokens: batchInputTokens,
              completion_tokens: 0,
              total_tokens: batchTotalTokens,
            },
            durationMs: batchEmbedDuration,
            context: { batch_size: batch.length, success_count: batchSuccessCount },
          });
        }
      } catch (err) {
        // If batch fails, try individual embeddings as fallback
        for (const chunk of batch) {
          try {
            const singleEmbedStart = Date.now();
            const text = formatDocForEmbedding(chunk.text, chunk.title);
            const result = await session.embed(text);
            const singleEmbedDuration = Date.now() - singleEmbedStart;
            if (result) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now);
              chunksEmbedded++;

              // Record individual embed usage.
              const provider = process.env.KINDX_LLM_BACKEND === "remote" ? "remote_openai" as const : "llama_cpp" as const;
              recordDirectUsage(db, {
                operation: "embed",
                model,
                provider,
                usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                durationMs: singleEmbedDuration,
                context: { hash: chunk.hash, seq: chunk.seq, fallback: true },
              });
            } else {
              errors++;
            }
          } catch (innerErr) {
            errors++;
            reporter.warn("embed-failed", `Error embedding "${chunk.displayName}" chunk ${chunk.seq}: ${innerErr}`, { hash: chunk.hash, seq: chunk.seq });
          }
          bytesProcessed += chunk.bytes;
        }
      }

      const percent = (bytesProcessed / totalBytes) * 100;
      progress.set(percent);

      const elapsed = (Date.now() - startTime) / 1000;
      const bytesPerSec = bytesProcessed / elapsed;
      const remainingBytes = totalBytes - bytesProcessed;
      const etaSec = remainingBytes / bytesPerSec;

      const throughput = `${formatBytes(bytesPerSec)}/s`;
      const errStr = errors > 0 ? ` ${palette.red(`${errors} err`)}` : "";
      const suffix = `${palette.dim(`${chunksEmbedded}/${totalChunks}`)}${errStr} ${palette.dim(throughput)}`;

      const bar = renderProgressBar(percent, 40, {
        etaSeconds: elapsed > 2 ? etaSec : undefined,
        suffix: suffix
      });

      if (visualUi && isTTY) {
        cursor.clearLine();
        process.stderr.write(`${bar}`);
      }
    }

    progress.clear();
    if (visualUi) cursor.show();
    const totalTimeSec = (Date.now() - startTime) / 1000;
    const avgThroughput = formatBytes(totalBytes / totalTimeSec);

    if (visualUi) {
      if (isTTY) {
        cursor.clearLine();
        console.log(renderProgressBar(100, 40, { suffix: palette.dim(`${chunksEmbedded}/${totalChunks}`) }));
        console.log(`${palette.green("✓ Done!")} Embedded ${palette.bold(`${chunksEmbedded}`)} chunks in ${palette.bold(formatETA(totalTimeSec))} ${palette.dim(`(${avgThroughput}/s)`)}`);
      } else {
        console.log(`\n${palette.green("✓ Done!")} Embedded ${palette.bold(`${chunksEmbedded}`)} chunks from ${palette.bold(`${totalDocs}`)} documents in ${palette.bold(formatETA(totalTimeSec))} ${palette.dim(`(${avgThroughput}/s)`)}`);
      }
      if (errors > 0) {
        console.log(palette.red(`✖ ${errors} chunks failed`));
      }
    }
    reporter.end("embed", { durationMs: Math.round(totalTimeSec * 1000), detail: { chunks: chunksEmbedded, errors, throughputBytesPerSec: Math.round(totalBytes / totalTimeSec) } });
  }, { maxDuration: 30 * 60 * 1000, name: 'embed-command' });

  // Phase 2: optional per-collection shard sync with resumable checkpointing.
  const shardStatus = getShardRuntimeStatus(getDbPath());
  if (shardStatus.enabledCollections.length > 0) {
    reporter.start("shard-sync", "Syncing collection shards");
    if (visualUi) console.log(`\n${palette.bold("Shard Sync")}`);
    const shardResult = await syncCollectionShardsFromMainDb(db, getDbPath(), {
      resume,
      onProgress: ({ collection, processed, total }) => {
        if (processed % 250 === 0 || processed === total) {
          if (visualUi && isTTY) {
            process.stderr.write(`\r${palette.dim(`Syncing shards ${collection}: ${processed}/${total}`)}   `);
          }
        }
      },
    });
    if (visualUi && isTTY) process.stderr.write(`\n`);
    if (visualUi) {
      for (const item of shardResult.collections) {
        console.log(`  ${palette.green("✓")} ${item.collection}: ${item.processed}/${item.total} vectors synced across ${item.shardCount} shards`);
      }
      if (shardResult.collections.length > 0) {
        console.log(`  Checkpoint: ${shardResult.checkpointPath}`);
      }
    }
    reporter.end("shard-sync", { detail: { collections: shardResult.collections.map(c => ({ collection: c.collection, processed: c.processed, total: c.total, shardCount: c.shardCount })) } });
  }

  reporter.done();
  closeDb();
}

// Sanitize a term for FTS5: remove punctuation except apostrophes and underscores
function sanitizeFTS5Term(term: string): string {
  // Preserve underscores so snake_case identifiers (e.g., my_function_name)
  // are treated as single terms, not split into separate words.
  return term.replace(/[^\w']/g, '').trim();
}

// Build FTS5 query: phrase-aware with fallback to individual terms
function buildFTS5Query(query: string): string {
  // Sanitize the full query for phrase matching
  const sanitizedQuery = query.replace(/[^\w\s']/g, '').trim();

  const terms = query
    .split(/\s+/)
    .map(sanitizeFTS5Term)
    .filter(term => term.length >= 2); // Skip single chars and empty

  if (terms.length === 0) return "";
  if (terms.length === 1) return `"${terms[0]!.replace(/"/g, '""')}"`;

  // Strategy: exact phrase OR proximity match OR individual terms
  // Exact phrase matches rank highest, then close proximity, then any term
  const phrase = `"${sanitizedQuery.replace(/"/g, '""')}"`;
  const quotedTerms = terms.map(t => `"${t.replace(/"/g, '""')}"`);

  // FTS5 NEAR syntax: NEAR(term1 term2, distance)
  const nearPhrase = `NEAR(${quotedTerms.join(' ')}, 10)`;
  const orTerms = quotedTerms.join(' OR ');

  // Exact phrase > proximity > any term
  return `(${phrase}) OR (${nearPhrase}) OR (${orTerms})`;
}

// Normalize BM25 score to 0-1 range using sigmoid
function normalizeBM25(score: number): number {
  // BM25 scores are negative in SQLite (lower = better)
  // Typical range: -15 (excellent) to -2 (weak match)
  // Map to 0-1 where higher is better
  const absScore = Math.abs(score);
  // Sigmoid-ish normalization: maps ~2-15 range to ~0.1-0.95
  return 1 / (1 + Math.exp(-(absScore - 5) / 3));
}

type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string | string[];  // Filter by collection name(s)
  lineNumbers?: boolean; // Add line numbers to output
  explain?: boolean;     // Include retrieval score traces (query only)
  context?: string;      // Optional context for query expansion
  candidateLimit?: number;  // Max candidates to rerank (default: 40)
  maxRerankCandidates?: number; // Hard rerank candidate ceiling
  rerankTimeoutMs?: number; // Rerank timeout budget
  rerankQueueLimit?: number; // Queue cap for rerank path
  rerankConcurrency?: number; // Parallel rerank workers
  rerankDropPolicy?: "timeout_fallback" | "wait"; // Queue backpressure policy
  vectorFanoutWorkers?: number; // Vector fanout worker cap
  /**
   * Pretty layout selected via `--format cards|table|lines`. When set, the
   * `format` field above stays `"cli"` (so existing code paths are
   * unaffected) and the renderer reads `layout` to switch presentation.
   */
  layout?: "cards" | "table" | "lines";
  showMetadata?: boolean;
  showScores?: boolean;
};

// Highlight query terms in text (skip short words < 3 chars)
function highlightTerms(text: string, query: string): string {
  if (!useColor) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `${c.yellow}${c.bold}$1${c.reset}`);
  }
  return result;
}

// Format score with color based on value
function formatScore(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!useColor) return `${pct}%`;
  if (score >= 0.7) return `${c.green}${pct}%${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.dim}${pct}%${c.reset}`;
}

function formatExplainNumber(value: number): string {
  return value.toFixed(4);
}

// Build the per-row explain block as plain (un-dimmed) lines. The snippets
// renderer applies palette.dim when emitting; keeping this function ANSI-free
// means it round-trips cleanly through stripAnsi() in tests.
function formatExplainBlockLines(explain: HybridQueryExplain): string[] {
  const lines: string[] = [];
  const ftsScores = explain.ftsScores.length > 0
    ? explain.ftsScores.map(formatExplainNumber).join(", ")
    : "none";
  const vecScores = explain.vectorScores.length > 0
    ? explain.vectorScores.map(formatExplainNumber).join(", ")
    : "none";
  const contribSummary = explain.rrf.contributions
    .slice()
    .sort((a, b) => b.rrfContribution - a.rrfContribution)
    .slice(0, 3)
    .map(c => `${c.source}/${c.queryType}#${c.rank}:${formatExplainNumber(c.rrfContribution)}`)
    .join(" | ");
  lines.push(`Explain: fts=[${ftsScores}] vec=[${vecScores}]`);
  lines.push(`  RRF: total=${formatExplainNumber(explain.rrf.totalScore)} base=${formatExplainNumber(explain.rrf.baseScore)} bonus=${formatExplainNumber(explain.rrf.topRankBonus)} rank=${explain.rrf.rank}`);
  lines.push(`  Blend: ${Math.round(explain.rrf.weight * 100)}%*${formatExplainNumber(explain.rrf.positionScore)} + ${Math.round((1 - explain.rrf.weight) * 100)}%*${formatExplainNumber(explain.rerankScore)} = ${formatExplainNumber(explain.blendedScore)}`);
  if (contribSummary.length > 0) {
    lines.push(`  Top RRF contributions: ${contribSummary}`);
  }
  return lines;
}

// Shorten directory path for display - relative to $HOME (used for context paths, not documents)
function shortPath(dirpath: string): string {
  const home = homedir();
  if (dirpath.startsWith(home)) {
    return '~' + dirpath.slice(home.length);
  }
  return dirpath;
}

type EmptySearchReason = "no_results" | "min_score";

// Emit format-safe empty output for search commands.
function printEmptySearchResults(format: OutputFormat, reason: EmptySearchReason = "no_results"): void {
  if (format === "json") {
    console.log("[]");
    return;
  }
  if (format === "csv") {
    console.log("docid,score,file,title,context,line,snippet");
    return;
  }
  if (format === "xml") {
    console.log("<results></results>");
    return;
  }
  if (format === "md" || format === "files") {
    return;
  }

  if (reason === "min_score") {
    console.log("No results found above minimum score threshold.");
    return;
  }
  console.log("No results found.");
}

type OutputRow = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context?: string | null;
  chunkPos?: number;
  hash?: string;
  docid?: string;
  explain?: HybridQueryExplain;
};

function outputResults(results: OutputRow[], query: string, opts: OutputOptions): void {
  const filtered = results.filter(r => r.score >= opts.minScore).slice(0, opts.limit);

  if (filtered.length === 0) {
    printEmptySearchResults(opts.format, "min_score");
    return;
  }

  // Helper to create kindx:// URI from displayPath
  const toQmdPath = (displayPath: string) => `kindx://${displayPath}`;

  // Unified pretty dispatch: every pretty layout (snippets|cards|table|lines)
  // routes to engine/cli/renderers/search.ts. The renderer chooses snippets
  // when no layout is specified, preserving today's default look.
  if (opts.format === "cli") {
    const layout = (opts.layout ?? "snippets") as "snippets" | "cards" | "table" | "lines";
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const rows = filtered.map((r, i) => {
      const extracted = extractSnippet(r.body, query, layout === "snippets" ? 500 : 240, r.chunkPos);
      const { line, snippet, body: snippetBodyOnly, bodyStartLine } = extracted;
      // Match-gate the :line suffix exactly like the legacy snippets path did.
      const lowerBody = snippetBodyOnly.toLowerCase();
      const hasMatch = queryTerms.some(t => lowerBody.includes(t));
      const docid = r.docid || (r.hash ? r.hash.slice(0, 6) : undefined);

      let rowBody: string | undefined;
      let rowBodyStartLine: number | undefined;
      if (layout === "snippets") {
        // New default: pass the bare body + start line; renderer composes
        // the human header and the line-number gutter. Highlighting still
        // happens here so the renderer stays pure.
        const baseBody = opts.lineNumbers ? addLineNumbers(snippetBodyOnly, bodyStartLine) : snippetBodyOnly;
        rowBody = highlightTerms(baseBody, query);
        rowBodyStartLine = bodyStartLine;
      } else {
        rowBody = snippet;
      }

      const totalLines = r.body ? r.body.split("\n").length : undefined;
      const row: import("./cli/renderers/search.js").SearchRenderRow = {
        rank: i + 1,
        docid,
        displayPath: r.displayPath,
        absolutePath: r.file,
        title: r.title || undefined,
        context: r.context,
        score: r.score,
        snippet: rowBody,
        bodyStartLine: rowBodyStartLine,
        totalLines,
        matchedLine: hasMatch ? line : undefined,
      };

      if (layout === "snippets" && opts.explain && r.explain) {
        row.explainLines = formatExplainBlockLines(r.explain);
      }
      return row;
    });
    process.stdout.write(renderSearchResults(rows, {
      layout,
      color: useColor,
      showMetadata: !!opts.showMetadata,
      showScores: !!opts.showScores,
      query,
      showHints: layout !== "snippets",
    }) + "\n");
    return;
  }

  if (opts.format === "json") {
    // JSON output for LLM consumption
    const output = filtered.map(row => {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let body = opts.full ? row.body : undefined;
      let snippet = !opts.full ? extractSnippet(row.body, query, 300, row.chunkPos).snippet : undefined;
      if (opts.lineNumbers) {
        if (body) body = addLineNumbers(body);
        if (snippet) snippet = addLineNumbers(snippet);
      }
      return {
        ...(docid && { docid: `#${docid}` }),
        score: Math.round(row.score * 100) / 100,
        file: toQmdPath(row.displayPath),
        title: row.title,
        ...(row.context && { context: row.context }),
        ...(body && { body }),
        ...(snippet && { snippet }),
        ...(opts.explain && row.explain && { explain: row.explain }),
      };
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.format === "files") {
    // Simple docid,score,filepath,context output
    for (const row of filtered) {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const ctx = row.context ? `,"${row.context.replace(/"/g, '""')}"` : "";
      console.log(`#${docid},${row.score.toFixed(2)},${toQmdPath(row.displayPath)}${ctx}`);
    }
  } else if (opts.format === "md") {
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const heading = row.title || row.displayPath;
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      const docidLine = docid ? `**docid:** \`#${docid}\`\n` : "";
      const contextLine = row.context ? `**context:** ${row.context}\n` : "";
      console.log(`---\n# ${heading}\n${docidLine}${contextLine}\n${content}\n`);
    }
  } else if (opts.format === "xml") {
    for (const row of filtered) {
      const titleAttr = row.title ? ` title="${row.title.replace(/"/g, '&quot;')}"` : "";
      const contextAttr = row.context ? ` context="${row.context.replace(/"/g, '&quot;')}"` : "";
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      console.log(`<file docid="#${docid}" name="${toQmdPath(row.displayPath)}"${titleAttr}${contextAttr}>\n${content}\n</file>\n`);
    }
  } else {
    // CSV format
    console.log("docid,score,file,title,context,line,snippet");
    for (const row of filtered) {
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos);
      let content = opts.full ? row.body : snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content, line);
      }
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const snippetText = content || "";
      console.log(`#${docid},${row.score.toFixed(4)},${escapeCSV(toQmdPath(row.displayPath))},${escapeCSV(row.title || "")},${escapeCSV(row.context || "")},${line},${escapeCSV(snippetText)}`);
    }
  }
}

// Resolve -c collection filter: supports single string, array, or undefined.
// Returns validated collection names (exits on unknown collection).
function resolveCollectionFilter(raw: string | string[] | undefined, useDefaults: boolean = false): string[] {
  // If no filter specified and useDefaults is true, use default collections
  if (!raw && useDefaults) {
    return getDefaultCollectionNames();
  }
  if (!raw) return [];
  const names = Array.isArray(raw) ? raw : [raw];
  const validated: string[] = [];
  for (const name of names) {
    const coll = getCollectionFromYaml(name);
    if (!coll) {
      console.error(`Collection not found: ${name}`);
      closeDb();
      process.exit(1);
    }
    validated.push(name);
  }
  return validated;
}

// Post-filter results to only include files from specified collections.
function filterByCollections<T extends { filepath?: string; file?: string }>(results: T[], collectionNames: string[]): T[] {
  if (collectionNames.length <= 1) return results;
  const prefixes = collectionNames.map(n => `kindx://${n}/`);
  return results.filter(r => {
    const path = r.filepath || r.file || '';
    return prefixes.some(p => path.startsWith(p));
  });
}

/**
 * Parse structured search query syntax.
 * Lines starting with lex:, vec:, or hyde: are routed directly.
 * Plain lines without prefix go through query expansion.
 * 
 * Returns null if this is a plain query (single line, no prefix).
 * Returns StructuredSubSearch[] if structured syntax detected.
 * Throws if multiple plain lines (ambiguous).
 * 
 * Examples:
 *   "CAP theorem"                    -> null (plain query, use expansion)
 *   "lex: CAP theorem"               -> [{ type: 'lex', query: 'CAP theorem' }]
 *   "lex: CAP\nvec: consistency"     -> [{ type: 'lex', ... }, { type: 'vec', ... }]
 *   "CAP\nconsistency"               -> throws (multiple plain lines)
 */
function parseStructuredQuery(query: string): StructuredSubSearch[] | null {
  const rawLines = query.split('\n').map((line, idx) => ({
    raw: line,
    trimmed: line.trim(),
    number: idx + 1,
  })).filter(line => line.trimmed.length > 0);

  if (rawLines.length === 0) return null;

  const prefixRe = /^(lex|vec|hyde):\s*/i;
  const expandRe = /^expand:\s*/i;
  const typed: StructuredSubSearch[] = [];

  for (const line of rawLines) {
    if (expandRe.test(line.trimmed)) {
      if (rawLines.length > 1) {
        throw new Error(`Line ${line.number} starts with expand:, but query documents cannot mix expand with typed lines. Submit a single expand query instead.`);
      }
      const text = line.trimmed.replace(expandRe, '').trim();
      if (!text) {
        throw new Error('expand: query must include text.');
      }
      return null; // treat as standalone expand query
    }

    const match = line.trimmed.match(prefixRe);
    if (match) {
      const type = match[1]!.toLowerCase() as 'lex' | 'vec' | 'hyde';
      const text = line.trimmed.slice(match[0].length).trim();
      if (!text) {
        throw new Error(`Line ${line.number} (${type}:) must include text.`);
      }
      if (/\r|\n/.test(text)) {
        throw new Error(`Line ${line.number} (${type}:) contains a newline. Keep each query on a single line.`);
      }
      typed.push({ type, query: text, line: line.number });
      continue;
    }

    if (rawLines.length === 1) {
      // Single plain line -> implicit expand
      return null;
    }

    throw new Error(`Line ${line.number} is missing a lex:/vec:/hyde: prefix. Each line in a query document must start with one.`);
  }

  return typed.length > 0 ? typed : null;
}

function search(query: string, opts: OutputOptions): void {
  const db = getDb();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  // Use large limit for --all, otherwise fetch more than needed and let outputResults filter
  const fetchLimit = opts.all ? 100000 : Math.max(50, opts.limit * 2);
  const results = filterByCollections(
    searchFTS(db, query, fetchLimit, singleCollection),
    collectionNames
  );

  // Add context to results
  const resultsWithContext = results.map(r => ({
    file: r.filepath,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body || "",
    score: r.score,
    context: getContextForFile(db, r.filepath),
    hash: r.hash,
    docid: r.docid,
  }));

  closeDb();

  if (resultsWithContext.length === 0) {
    printEmptySearchResults(opts.format);
    return;
  }
  outputResults(resultsWithContext, query, opts);
}

/**
 * Estimate rerank phase duration so the progress spinner can show
 * `Reranking N candidates (~Ts expected)`. The pretty-tty reporter also uses
 * this to recolor the spinner yellow when actual elapsed exceeds expected.
 *
 * Model: a fixed overhead (model warmup, batching) plus a per-candidate cost.
 * Numbers tuned against observed traces on the current Qwen3-0.6B rerank
 * model. Recalibrate by running `estimateRerankMs(N)` against real timings:
 * the goal is for 80% of queries to complete within 1.5× the estimate.
 */
function estimateRerankMs(candidates: number): number {
  // 400ms model warmup + ~500ms per candidate on a cold rerank session.
  // Once warm the per-item cost drops to ~22ms, but we estimate cold by
  // default because that's the worst-case path for first-query feedback.
  // Per-candidate latency scales sublinearly past 20 (batched).
  const overhead = 400;
  const perCandidate = candidates <= 20 ? 500 : 500 - Math.min(300, (candidates - 20) * 5);
  return Math.round(overhead + perCandidate * candidates);
}

// Build query-expansion tree lines (rendered under the "Expanding query" phase
// by the active ProgressReporter). Returned as plain strings; ANSI dimming is
// applied by the reporter via its palette.
function buildExpansionTreeLines(originalQuery: string, expanded: ExpandedQuery[]): string[] {
  const lines: string[] = [];
  lines.push(`├─ ${originalQuery}`);
  for (const q of expanded) {
    let preview = q.text.replace(/\n/g, ' ');
    if (preview.length > 72) preview = preview.substring(0, 69) + '...';
    lines.push(`├─ ${q.type}: ${preview}`);
  }
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace('├─', '└─');
  }
  return lines;
}

async function vectorSearch(query: string, opts: OutputOptions, _model: string = DEFAULT_EMBED_MODEL): Promise<void> {
  const store = getStore();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db);

  const scopeKey = `cli:${collectionNames.sort().join(",") || "default"}:${opts.context || "default"}`;
  await withLLMScope(scopeKey, () => withLLMSession(async () => {
    let results = await vectorSearchQuery(store, query, {
      collection: singleCollection,
      limit: opts.all ? 500 : (opts.limit || 10),
      minScore: opts.minScore || 0.3,
      hooks: {
        onExpand: (original, expanded) => {
          const reporter = getReporter();
          reporter.detail(buildExpansionTreeLines(original, expanded));
          reporter.start("search", `Searching ${expanded.length + 1} vector queries`);
        },
      },
    });

    // Post-filter for multi-collection
    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `kindx://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    closeDb();

    if (results.length === 0) {
      printEmptySearchResults(opts.format);
      return;
    }

    outputResults(results.map(r => ({
      file: r.file,
      displayPath: r.displayPath,
      title: r.title,
      body: r.body,
      score: r.score,
      context: r.context,
      docid: r.docid,
    })), query, { ...opts, limit: results.length });
  }, { maxDuration: 10 * 60 * 1000, name: 'vectorSearch' }));
}

async function querySearch(query: string, opts: OutputOptions, _embedModel: string = DEFAULT_EMBED_MODEL, _rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {
  const store = getStore();
  const timings = {
    expand_ms: 0,
    embed_ms: 0,
    retrieval_ms: 0,
    rerank_init_ms: 0,
    rerank_ms: 0,
    total_ms: 0,
  };
  const totalStart = Date.now();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db);

  // Check for structured query syntax (lex:/vec:/hyde: prefixes)
  const structuredQueries = parseStructuredQuery(query);

  const scopeKey = `cli:${collectionNames.sort().join(",") || "default"}:${opts.context || "default"}`;
  await withLLMScope(
    scopeKey,
    () => withLLMSession(async () => {
    let results;
    let structuredDiagnostics: { degradedMode?: boolean; fallbackReasons?: string[]; scaleWarnings?: string[] } | undefined;

    const reporter = getReporter();
    if (structuredQueries) {
      // Structured search — user provided their own query expansions
      const typeLabels = structuredQueries.map(s => s.type).join('+');
      reporter.start("structured", `Structured search: ${structuredQueries.length} queries (${typeLabels})`);
      const lines: string[] = [];
      for (let i = 0; i < structuredQueries.length; i++) {
        const s = structuredQueries[i]!;
        let preview = s.query.replace(/\n/g, ' ');
        if (preview.length > 72) preview = preview.substring(0, 69) + '...';
        const prefix = i === structuredQueries.length - 1 ? '└─' : '├─';
        lines.push(`${prefix} ${s.type}: ${preview}`);
      }
      reporter.detail(lines);

      const withDiagnostics = await structuredSearchWithDiagnostics(store, structuredQueries, {
        collections: singleCollection ? [singleCollection] : undefined,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        maxRerankCandidates: opts.maxRerankCandidates,
        rerankTimeoutMs: opts.rerankTimeoutMs,
        explain: !!opts.explain,
        hooks: {
          onEmbedStart: (count) => {
            reporter.start("embed", `Embedding ${count} ${count === 1 ? 'query' : 'queries'}`);
          },
          onEmbedDone: (ms) => {
            timings.embed_ms += ms;
            reporter.end("embed", { durationMs: ms });
          },
          onRetrievalDone: (ms) => {
            timings.retrieval_ms = ms;
          },
          onRerankInitDone: (ms) => {
            timings.rerank_init_ms += ms;
          },
          onRerankStart: (chunkCount) => {
            {
              const expectedMs = estimateRerankMs(chunkCount);
              reporter.start("rerank", `Reranking ${chunkCount} candidates (~${formatMs(expectedMs)} expected)`, { expectedDurationMs: expectedMs });
            }
            progress.indeterminate();
          },
          onRerankDone: (ms) => {
            timings.rerank_ms += ms;
            progress.clear();
            reporter.end("rerank", { durationMs: ms });
          },
        },
      });
      results = withDiagnostics.results;
      structuredDiagnostics = withDiagnostics.diagnostics;
    } else {
      // Standard hybrid query with automatic expansion
      results = await hybridQuery(store, query, {
        collection: singleCollection,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        maxRerankCandidates: opts.maxRerankCandidates,
        rerankTimeoutMs: opts.rerankTimeoutMs,
        explain: !!opts.explain,
        hooks: {
          onStrongSignal: (score) => {
            reporter.warn("strong-bm25", `Strong BM25 signal (${score.toFixed(2)}) — skipping expansion`, { score });
          },
          onExpandStart: () => {
            reporter.start("expand", "Expanding query");
          },
          onExpand: (original, expanded, ms) => {
            timings.expand_ms += ms;
            reporter.detail(buildExpansionTreeLines(original, expanded));
            reporter.end("expand", { durationMs: ms, detail: { variants: expanded.length + 1 } });
            reporter.start("search", `Searching ${expanded.length + 1} queries`);
          },
          onEmbedStart: (count) => {
            reporter.start("embed", `Embedding ${count} ${count === 1 ? 'query' : 'queries'}`);
          },
          onEmbedDone: (ms) => {
            timings.embed_ms += ms;
            reporter.end("embed", { durationMs: ms });
          },
          onRetrievalDone: (ms) => {
            timings.retrieval_ms = ms;
          },
          onRerankInitDone: (ms) => {
            timings.rerank_init_ms += ms;
          },
          onRerankStart: (chunkCount) => {
            {
              const expectedMs = estimateRerankMs(chunkCount);
              reporter.start("rerank", `Reranking ${chunkCount} candidates (~${formatMs(expectedMs)} expected)`, { expectedDurationMs: expectedMs });
            }
            progress.indeterminate();
          },
          onRerankDone: (ms) => {
            timings.rerank_ms += ms;
            progress.clear();
            reporter.end("rerank", { durationMs: ms });
          },
        },
      });
    }

    // Post-filter for multi-collection
    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `kindx://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    // Use first lex/vec query for output context, or original query
    const displayQuery = structuredQueries
      ? (structuredQueries.find(s => s.type === 'lex')?.query || structuredQueries.find(s => s.type === 'vec')?.query || query)
      : query;

    closeDb();

    if (results.length === 0) {
      printEmptySearchResults(opts.format);
      return;
    }

    // Map to CLI output format — use bestChunk for snippet display
    outputResults(results.map(r => ({
      file: r.file,
      displayPath: r.displayPath,
      title: r.title,
      body: r.bestChunk,
      chunkPos: r.bestChunkPos,
      score: r.score,
      context: r.context,
      docid: r.docid,
      explain: r.explain,
    })), displayQuery, { ...opts, limit: results.length });

    if (structuredDiagnostics?.degradedMode) {
      const reasons = (structuredDiagnostics.fallbackReasons || []).join(", ") || "unknown";
      reporter.warn("degraded-mode", `KINDX degraded mode: ${reasons}`, {
        fallbackReasons: structuredDiagnostics.fallbackReasons,
        scaleWarnings: structuredDiagnostics.scaleWarnings,
      });
    }

    timings.total_ms = Date.now() - totalStart;
    if (opts.explain) {
      const palette = paletteFor(useColor);
      process.stderr.write(
        palette.dim(`timings: expand=${formatMs(timings.expand_ms)}, embed=${formatMs(timings.embed_ms)}, retrieval=${formatMs(timings.retrieval_ms)}, rerank_init=${formatMs(timings.rerank_init_ms)}, rerank=${formatMs(timings.rerank_ms)}, total=${formatMs(timings.total_ms)}`) + "\n"
      );
    }
    reporter.done();
    }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' })
  );
}

// Parse CLI arguments using util.parseArgs
function parseCLI() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), // Skip node and script path
    options: {
      // Global options
      index: {
        type: "string",
      },
      workspace: {
        type: "string",
      },
      context: {
        type: "string",
      },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      skill: { type: "boolean" },
      // Search options
      n: { type: "string" },
      "min-score": { type: "string" },
      all: { type: "boolean" },
      full: { type: "boolean" },
      csv: { type: "boolean" },
      md: { type: "boolean" },
      xml: { type: "boolean" },
      files: { type: "boolean" },
      json: { type: "boolean" },
      explain: { type: "boolean" },
      collection: { type: "string", short: "c", multiple: true },  // Filter by collection(s)
      // Collection options
      name: { type: "string" },  // collection name
      role: { type: "string" },  // tenant role
      mask: { type: "string" },  // glob pattern
      // Embed options
      force: { type: "boolean", short: "f" },
      // Update options
      pull: { type: "boolean" },  // git pull before update
      refresh: { type: "boolean" },
      // Get options
      l: { type: "string" },  // max lines
      from: { type: "string" },  // start line (get) or from-version (diff)
      to: { type: "string" },    // to-version (diff)
      "max-bytes": { type: "string" },  // max bytes for multi-get
      "line-numbers": { type: "boolean" },  // add line numbers to output
      // Query options
      "candidate-limit": { type: "string", short: "C" },
      "max-rerank-candidates": { type: "string" },
      "rerank-timeout-ms": { type: "string" },
      "rerank-queue-limit": { type: "string" },
      "rerank-concurrency": { type: "string" },
      "rerank-drop-policy": { type: "string" },
      "vector-fanout-workers": { type: "string" },
      // Global output revamp flags (additive)
      format: { type: "string" },
      plain: { type: "boolean" },
      "no-color": { type: "boolean" },
      color: { type: "boolean" },
      verbose: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },  // Suppress progress output (stderr)
      debug: { type: "boolean" },
      trace: { type: "boolean" },
      profile: { type: "string" },
      timeout: { type: "string" },
      confirm: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      limit: { type: "string" },
      interactive: { type: "boolean", short: "i" },
      "show-scores": { type: "boolean" },
      "show-metadata": { type: "boolean" },
      open: { type: "boolean" },
      // Memory options
      scope: { type: "string" },
      key: { type: "string" },
      value: { type: "string" },
      tag: { type: "string", multiple: true },
      source: { type: "string" },
      id: { type: "string" },
      semantic: { type: "boolean" },
      text: { type: "boolean" },
      threshold: { type: "string" },
      // MCP HTTP transport options
      http: { type: "boolean" },
      daemon: { type: "boolean" },
      port: { type: "string" },
      "health-check": { type: "boolean" },
      "log-format": { type: "string" },
      "log-level": { type: "string" },
      "check-only": { type: "boolean" },
      cache: { type: "boolean" },
      "parity-sample": { type: "string" },
      path: { type: "string" },
      resume: { type: "boolean" },
      description: { type: "string" },
      // Telemetry — surfaces auto-invocation contract trigger counts.
      "auto-invoke-rate": { type: "boolean" },
      // init (MCP client wiring) options
      "client": { type: "string", multiple: true }, // --client claude-code --client cursor
      "project": { type: "string" },                // --project <path>
      "global": { type: "boolean" },                // --global (skip project file)
    },
    allowPositionals: true,
    strict: false, // Allow unknown options to pass through
  });

  // Select index name (default: "index")
  const indexName = (values.workspace || values.index) as string | undefined;
  if (indexName) {
    setIndexName(indexName);
    setConfigIndexName(indexName);
  }

  // Configure daemon/logger output early so protocol and MCP logs are consistent.
  const logLevel = values["log-level"] ? String(values["log-level"]).toUpperCase() : undefined;
  const logFormat = values["log-format"] ? String(values["log-format"]).toLowerCase() : undefined;
  if (logLevel) process.env.KINDX_LOG_LEVEL = logLevel;
  if (logFormat === "json") process.env.KINDX_LOG_JSON = "1";
  if (logFormat === "text") process.env.KINDX_LOG_JSON = "0";
  configureLogger({ level: logLevel, format: logFormat });

  // Determine output format.
  // Precedence (highest first):
  //   1. --format <value>
  //   2. legacy boolean flags --json/--csv/--md/--xml/--files
  //   3. default "cli"
  // The new --format cards|table|lines values map to format=cli with a
  // `layout` field so existing rendering paths keep working unchanged.
  let format: OutputFormat = "cli";
  let layout: "cards" | "table" | "lines" | undefined;
  const formatFlag = typeof values.format === "string" ? values.format.trim().toLowerCase() : "";
  if (formatFlag) {
    switch (formatFlag) {
      case "json": format = "json"; break;
      case "csv": format = "csv"; break;
      case "md": format = "md"; break;
      case "xml": format = "xml"; break;
      case "files": format = "files"; break;
      case "plain":
      case "pretty":
        format = "cli"; break;
      case "cards":
      case "table":
      case "lines":
        format = "cli";
        layout = formatFlag as "cards" | "table" | "lines";
        break;
      default:
        // Unknown --format: fall through to legacy booleans / cli default.
        break;
    }
  }
  if (format === "cli" && !layout) {
    if (values.csv) format = "csv";
    else if (values.md) format = "md";
    else if (values.xml) format = "xml";
    else if (values.files) format = "files";
    else if (values.json) format = "json";
    else if (values.plain) format = "cli"; // plain == cli without color
  }

  // Default limit: 20 for --files/--json, 5 otherwise
  // --all means return all results (use very large limit)
  const defaultLimit = (format === "files" || format === "json") ? 20 : 5;
  const isAll = !!values.all;

  const opts: OutputOptions = {
    format,
    full: !!values.full,
    limit: isAll ? 100000 : (values.n ? parseInt(String(values.n), 10) || defaultLimit : defaultLimit),
    minScore: values["min-score"] ? parseFloat(String(values["min-score"])) || 0 : 0,
    all: isAll,
    collection: values.collection as string[] | undefined,
    lineNumbers: !!values["line-numbers"],
    candidateLimit: values["candidate-limit"] ? parseInt(String(values["candidate-limit"]), 10) : undefined,
    maxRerankCandidates: values["max-rerank-candidates"] ? parseInt(String(values["max-rerank-candidates"]), 10) : undefined,
    rerankTimeoutMs: values["rerank-timeout-ms"] ? parseInt(String(values["rerank-timeout-ms"]), 10) : undefined,
    rerankQueueLimit: values["rerank-queue-limit"] ? parseInt(String(values["rerank-queue-limit"]), 10) : undefined,
    rerankConcurrency: values["rerank-concurrency"] ? parseInt(String(values["rerank-concurrency"]), 10) : undefined,
    rerankDropPolicy: values["rerank-drop-policy"] === "wait" ? "wait" : values["rerank-drop-policy"] === "timeout_fallback" ? "timeout_fallback" : undefined,
    vectorFanoutWorkers: values["vector-fanout-workers"] ? parseInt(String(values["vector-fanout-workers"]), 10) : undefined,
    explain: !!values.explain,
    layout,
    showMetadata: !!values["show-metadata"],
    showScores: !!values["show-scores"],
  };

  return {
    command: positionals[0] || "",
    args: positionals.slice(1),
    query: positionals.slice(1).join(" "),
    opts,
    values,
  };
}

// =============================================================================
// Version history and diff commands
// =============================================================================

/**
 * Resolve a filename/docid/virtual-path to {collectionName, path} for version queries.
 * Returns null if the document cannot be found (after printing an error).
 */
function resolveDocumentForVersionQuery(
  db: Database,
  filename: string,
): { collectionName: string; path: string; displayName: string } | null {
  const found = findDocument(db, filename, { includeBody: false });
  if ("error" in found) {
    console.error(`Document not found: ${filename}`);
    if (found.similarFiles.length > 0) {
      console.error(`Similar files:`);
      for (const s of found.similarFiles) {
        console.error(`  ${s}`);
      }
    }
    return null;
  }
  // Parse the virtual path to extract the relative path component.
  const parsed = parseVirtualPath(found.filepath);
  if (parsed) {
    return {
      collectionName: parsed.collectionName,
      path: parsed.path,
      displayName: found.displayPath,
    };
  }
  // Fallback: use collectionName from findDocument + filepath.
  return {
    collectionName: found.collectionName,
    path: found.filepath.replace(`kindx://${found.collectionName}/`, ''),
    displayName: found.displayPath,
  };
}

function showDocumentHistory(
  filename: string,
  opts: { format: OutputFormat; limit?: number },
): void {
  const db = getDb();
  const resolved = resolveDocumentForVersionQuery(db, filename);
  if (!resolved) { closeDb(); process.exit(1); }

  const versions = getDocumentVersions(db, resolved.collectionName, resolved.path);
  const limit = opts.limit ?? versions.length;
  const shown = versions.slice(0, limit);

  if (shown.length === 0) {
    if (opts.format === "json") {
      console.log("[]");
    } else {
      console.log(`No version history found for: ${resolved.displayName}`);
    }
    closeDb();
    return;
  }

  if (opts.format === "json") {
    const output = shown.map((v, i) => ({
      version: i + 1,
      timestamp: v.createdAt,
      hash: v.hash.slice(0, 12),
      title: v.title,
    }));
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.format === "csv") {
    console.log("version,timestamp,hash,title");
    for (let i = 0; i < shown.length; i++) {
      const v = shown[i]!;
      const escape = (s: string) => s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      console.log(`${i + 1},${v.createdAt},${v.hash.slice(0, 12)},${escape(v.title)}`);
    }
  } else {
    console.log(`${c.bold}Version history:${c.reset} ${resolved.displayName}\n`);
    const maxVer = String(shown.length).length;
    for (let i = 0; i < shown.length; i++) {
      const v = shown[i]!;
      const ver = String(i + 1).padStart(maxVer);
      const date = new Date(v.createdAt);
      const dateStr = date.toISOString().replace("T", " ").slice(0, 19);
      const hashStr = v.hash.slice(0, 12);
      const tag = i === 0 ? ` ${c.green}(current)${c.reset}` : "";
      console.log(`  ${c.dim}v${ver}${c.reset}  ${c.cyan}${dateStr}${c.reset}  ${c.dim}${hashStr}${c.reset}  ${v.title}${tag}`);
    }
    console.log(`\n${c.dim}${shown.length} version(s)${c.reset}`);
  }

  closeDb();
}

function diffDocuments(
  filename: string,
  opts: { format: OutputFormat; fromVersion?: number; toVersion?: number },
): void {
  const db = getDb();
  const resolved = resolveDocumentForVersionQuery(db, filename);
  if (!resolved) { closeDb(); process.exit(1); }

  const versions = getDocumentVersions(db, resolved.collectionName, resolved.path);
  if (versions.length < 2) {
    console.error(`Not enough versions to diff (found ${versions.length}).`);
    closeDb();
    process.exit(1);
  }

  // Map 1-based version numbers to version entries.
  // v1 = current (index 0), v2 = previous (index 1), etc.
  const fromIdx = (opts.fromVersion ?? 2) - 1; // default: v2 (previous)
  const toIdx = (opts.toVersion ?? 1) - 1;     // default: v1 (current)

  if (fromIdx < 0 || fromIdx >= versions.length) {
    console.error(`Version ${opts.fromVersion ?? 2} out of range (1-${versions.length}).`);
    closeDb();
    process.exit(1);
  }
  if (toIdx < 0 || toIdx >= versions.length) {
    console.error(`Version ${opts.toVersion ?? 1} out of range (1-${versions.length}).`);
    closeDb();
    process.exit(1);
  }
  if (fromIdx === toIdx) {
    console.error("Cannot diff a version against itself.");
    closeDb();
    process.exit(1);
  }

  const fromVersion = versions[fromIdx]!;
  const toVersion = versions[toIdx]!;

  // Retrieve content bodies from the content-addressable store.
  const fromBody = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(fromVersion.hash) as { doc: string } | undefined;
  const toBody = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(toVersion.hash) as { doc: string } | undefined;

  if (!fromBody || !toBody) {
    console.error("Failed to retrieve document content for one or both versions.");
    closeDb();
    process.exit(1);
  }

  const fromLines = fromBody.doc.split("\n");
  const toLines = toBody.doc.split("\n");

  if (opts.format === "json") {
    console.log(JSON.stringify({
      document: resolved.displayName,
      from: { version: fromIdx + 1, timestamp: fromVersion.createdAt, hash: fromVersion.hash.slice(0, 12) },
      to: { version: toIdx + 1, timestamp: toVersion.createdAt, hash: toVersion.hash.slice(0, 12) },
      fromBody: fromBody.doc,
      toBody: toBody.doc,
    }, null, 2));
    closeDb();
    return;
  }

  // Simple line-by-line unified diff.
  const header = `${c.dim}--- a/${resolved.displayName} (v${fromIdx + 1}, ${fromVersion.hash.slice(0, 12)})${c.reset}`;
  const header2 = `${c.dim}+++ b/${resolved.displayName} (v${toIdx + 1}, ${toVersion.hash.slice(0, 12)})${c.reset}`;
  console.log(header);
  console.log(header2);
  console.log("");

  const maxLines = Math.max(fromLines.length, toLines.length);
  let hunks: { startA: number; startB: number; linesA: string[]; linesB: string[] }[] = [];
  let currentHunk: { startA: number; startB: number; linesA: string[]; linesB: string[] } | null = null;

  // Myers-like simplified diff: walk both arrays, emit removals and additions.
  // For a production-quality diff you'd use a proper LCS algorithm; this
  // implementation is sufficient for showing "what changed" in a CLI context.
  const lcs = (a: string[], b: string[]): number[][] => {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
    return dp;
  };

  const diffLines: { type: " " | "-" | "+"; line: string; lineA?: number; lineB?: number }[] = [];
  const buildDiff = (a: string[], b: string[]) => {
    const dp = lcs(a, b);
    let i = a.length, j = b.length;
    const stack: { type: " " | "-" | "+"; line: string; lineA?: number; lineB?: number }[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        stack.push({ type: " ", line: a[i - 1]!, lineA: i, lineB: j });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
        stack.push({ type: "+", line: b[j - 1]!, lineB: j });
        j--;
      } else {
        stack.push({ type: "-", line: a[i - 1]!, lineA: i });
        i--;
      }
    }
    while (stack.length > 0) diffLines.push(stack.pop()!);
  };

  buildDiff(fromLines, toLines);

  // Collapse unchanged lines, showing context around changes.
  const CONTEXT = 3;
  const changedIndices = new Set<number>();
  for (let idx = 0; idx < diffLines.length; idx++) {
    if (diffLines[idx]!.type !== " ") {
      for (let ctx = Math.max(0, idx - CONTEXT); ctx <= Math.min(diffLines.length - 1, idx + CONTEXT); ctx++) {
        changedIndices.add(ctx);
      }
    }
  }

  let lastEmitted = -1;
  for (let idx = 0; idx < diffLines.length; idx++) {
    if (!changedIndices.has(idx)) continue;
    if (lastEmitted !== -1 && idx - lastEmitted > 1) {
      // Emit hunk separator
      const skipped = idx - lastEmitted - 1;
      console.log(`${c.dim}@@ ... (${skipped} unchanged lines) ... @@${c.reset}`);
    }
    lastEmitted = idx;
    const d = diffLines[idx]!;
    if (d.type === "-") {
      console.log(`${c.red}-${c.reset} ${d.line}`);
    } else if (d.type === "+") {
      console.log(`${c.green}+${c.reset} ${d.line}`);
    } else {
      console.log(`  ${d.line}`);
    }
  }

  const adds = diffLines.filter(d => d.type === "+").length;
  const dels = diffLines.filter(d => d.type === "-").length;
  console.log(`\n${c.dim}${adds} addition(s), ${dels} deletion(s)${c.reset}`);

  closeDb();
}

function showSkill(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const relativePath = pathJoin("capabilities", "kindx", "SKILL.md");
  const skillPath = pathJoin(scriptDir, "..", relativePath);

  console.log(`KINDX Skill (${relativePath})`);
  console.log(`Location: ${skillPath}`);
  console.log("");

  if (!existsSync(skillPath)) {
    console.error("SKILL.md not found. If you built from source, ensure capabilities/kindx/SKILL.md exists.");
    return;
  }

  const content = readFileSync(skillPath, "utf-8");
  process.stdout.write(content.endsWith("\n") ? content : content + "\n");
}

function installSkill(): void {
  const argv1 = process.argv[1];
  const actualScriptPath = argv1 ? realpathSync(argv1) : fileURLToPath(import.meta.url);
  const scriptDir = dirname(actualScriptPath);
  const relativePath = pathJoin("capabilities", "kindx", "SKILL.md");
  const skillPath = pathJoin(scriptDir, "..", relativePath);

  if (!existsSync(skillPath)) {
    console.error("SKILL.md not found. If you built from source, ensure capabilities/kindx/SKILL.md exists.");
    process.exit(1);
  }

  const content = readFileSync(skillPath, "utf-8");
  const home = process.env.MOCK_HOMEDIR || homedir();
  const claudeCommandsDir = pathJoin(home, ".claude", "commands");
  
  if (!existsSync(claudeCommandsDir)) {
    mkdirSync(claudeCommandsDir, { recursive: true });
  }

  const destPath = pathJoin(claudeCommandsDir, "kindx.md");
  writeFileSync(destPath, content, "utf-8");
  console.log(`✓ KINDX skill successfully installed to ${destPath}`);
}

async function runArchCommand(subcommand: string, args: string[]): Promise<void> {
  const config = getArchConfig();

  if (!config.enabled) {
    console.log("Arch integration is disabled. Set KINDX_ARCH_ENABLED=1 to enable.");
    return;
  }

  const sourceRoot = args[0] || process.cwd();

  switch (subcommand) {
    case "status": {
      const status = getArchStatus(config, sourceRoot);
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case "build": {
      console.log(`Building arch artifacts for ${sourceRoot}...`);
      const result = await buildAndDistillArch(sourceRoot, config);
      console.log(`✓ Built arch artifacts:`);
      console.log(`  Nodes: ${result.artifact.nodeCount}`);
      console.log(`  Edges: ${result.artifact.edgeCount}`);
      console.log(`  Communities: ${result.artifact.communityCount}`);
      console.log(`  Hints: ${result.artifact.files.length} files generated`);
      break;
    }
    case "refresh": {
      console.log(`Refreshing arch artifacts for ${sourceRoot}...`);
      await buildAndDistillArch(sourceRoot, config);
      console.log(`✓ Refreshed arch artifacts`);
      break;
    }
    default:
      console.error(`Unknown arch subcommand: ${subcommand}`);
      console.log("Usage: kindx arch <status|build|refresh> [path]");
      process.exit(1);
  }
}

function showHelp(): void {
  // New grouped help comes from the declarative registry. The reference
  // material that follows (query grammar, architecture diagram, storage
  // schema) is preserved verbatim so users who relied on it still find it.
  console.log(renderRootHelp({ color: useColor }));
  console.log("");
  console.log("───── Reference ─────");
  console.log("");
  console.log("Primary commands:");
  console.log("  kindx query <query>             - Hybrid search with auto expansion + reranking (recommended)");
  console.log("  kindx query 'lex:..\\nvec:...'   - Structured query document (you provide lex/vec/hyde lines)");
  console.log("  kindx search <query>            - Full-text BM25 keywords (no LLM)");
  console.log("  kindx vsearch <query>           - Vector similarity only");
  console.log("  kindx get <file>[:line] [--from <line>] [-l N] [--line-numbers]  - Show a single document from specific line, optional line slice");
  console.log("  kindx multi-get <pattern>       - Batch fetch via glob or comma-separated list");
  console.log("  kindx history <file>            - Show document version history with timestamps");
  console.log("  kindx diff <file> [--from v1] [--to v2]  - Diff two versions of a document");
  console.log("  kindx mcp                       - Start the MCP server (stdio transport for AI agents)");
  console.log("  kindx memory <subcommand>       - Store and retrieve scoped agent memories");
  console.log("  kindx pull [--refresh]          - Download/check the default local GGUF models");
  console.log("  kindx skill install             - Copy the KINDX skill to ~/.claude/commands/ for one-command setup");
  console.log("");
  console.log("Collections & context:");
  console.log("  kindx collection add <path> [--name <name>] [--mask <glob>]");
  console.log(`                                         - Add collection. --mask sets glob pattern (default: ${DEFAULT_GLOB})`);
  console.log("  kindx collection list/remove/rename/show/update-cmd/include/exclude");
  console.log("                                         - Manage indexed folders and default-query behavior");
  console.log("  kindx context add/list/rm              - Attach human-written summaries");
  console.log("  kindx ls [collection[/path]]           - Inspect indexed files");
  console.log("");
  console.log("Maintenance:");
  console.log("");
  console.log("  kindx status                    - View index + collection health");
  console.log("  kindx watch [collections...]    - Real-time incremental indexing daemon");
  console.log("  kindx mcp --http [--daemon]     - Run the shared MCP HTTP server");
  console.log("  kindx mcp stop                  - Stop the MCP HTTP daemon");
  console.log("  kindx migrate chroma <path>     - Migrate a ChromaDB sqlite file to KINDX");
  console.log("  kindx migrate openclaw <path>   - Migrate an OpenCLAW repository to use KINDX");
  console.log("  kindx update [--pull]           - Re-index collections (optionally git pull first)");
  console.log("  kindx embed [-f]                - Generate/refresh vector embeddings");
  console.log("                             --resume to continue shard sync from checkpoint");
  console.log("  kindx cleanup                   - Clear caches, vacuum DB");
  console.log("  kindx doctor                    - Run deterministic health diagnostics");
  console.log("  kindx repair --check-only       - Dry-run integrity and repair checks");
  console.log("  kindx backup <create|verify|restore> [path] - Manage SQLite backups");
  console.log("  kindx scheduler status          - Show shard sync checkpoint and queue status");
  console.log("  kindx verify-wipe               - Scan for residual local index artifacts");
  console.log("  kindx memory embed [--scope S] [--force] - Backfill/regenerate memory embeddings");
  console.log("");
  console.log("Query syntax (kindx query):");
  console.log("  KINDX queries are either a single expand query (no prefix) or a multi-line");
  console.log("  document where every line is typed with lex:, vec:, or hyde:. This grammar");
  console.log("  is enforced directly in the CLI and documented in the repository reference.");
  console.log("");
  const grammar = [
    `query          = expand_query | query_document ;`,
    `expand_query   = text | explicit_expand ;`,
    `explicit_expand= "expand:" text ;`,
    `query_document = { typed_line } ;`,
    `typed_line     = type ":" text newline ;`,
    `type           = "lex" | "vec" | "hyde" ;`,
    `text           = quoted_phrase | plain_text ;`,
    `quoted_phrase  = '"' { character } '"' ;`,
    `plain_text     = { character } ;`,
    `newline        = "\\n" ;`,
  ];
  console.log("  Grammar:");
  for (const line of grammar) {
    console.log(`    ${line}`);
  }
  console.log("");
  console.log("  Examples:");
  console.log("    kindx query \"how does auth work\"                # single-line → implicit expand");
  console.log("    kindx query $'lex: CAP theorem\\nvec: consistency'  # typed query document");
  console.log("    kindx query $'lex: \"exact matches\" sports -baseball'  # phrase + negation lex search");
  console.log("    kindx query $'hyde: Hypothetical answer text'       # hyde-only document");
  console.log("");
  console.log("  Constraints:");
  console.log("    - Standalone expand queries cannot mix with typed lines.");
  console.log("    - Query documents allow only lex:, vec:, or hyde: prefixes.");
  console.log("    - Each typed line must be single-line text with balanced quotes.");
  console.log("");
  console.log("AI agents & integrations:");
  console.log("  - Run `kindx mcp` to expose the MCP server (stdio) to agents/IDEs.");
  console.log("  - `kindx --skill` prints the packaged capabilities/kindx/SKILL.md (path + contents).");
  console.log("  - Advanced: `kindx mcp --http ...` and `kindx mcp --http --daemon` are optional for custom transports.");
  console.log("");
  console.log("Global options:");
  console.log("  --help | --version | --skill   - Show help, version, or the packaged skill file");
  console.log("  --index <name>             - Use a named index (default: index)");
  console.log("  --log-format <text|json>   - Logging format for daemon/MCP logs");
  console.log("  --log-level <DEBUG|INFO|WARN|ERROR> - Logging verbosity");
  console.log("");
  console.log("Search options:");
  console.log("  -n <num>                   - Max results (default 5, or 20 for --files/--json)");
  console.log("  --all                      - Return all matches (pair with --min-score)");
  console.log("  --min-score <num>          - Minimum similarity score");
  console.log("  --full                     - Output full document instead of snippet");
  console.log("  -C, --candidate-limit <n>  - Max candidates to rerank (default 40, lower = faster)");
  console.log("  --max-rerank-candidates <n> - Hard ceiling for rerank candidates");
  console.log("  --rerank-timeout-ms <ms>   - Timeout budget for reranker before fallback");
  console.log("  --rerank-queue-limit <n>   - Cap queued rerank requests before fallback");
  console.log("  --rerank-concurrency <n>   - Parallel rerank workers (default 1)");
  console.log("  --rerank-drop-policy <timeout_fallback|wait> - Queue backpressure behavior");
  console.log("  --vector-fanout-workers <n> - Cap parallel vector fanout workers");
  console.log("  --parity-sample <n>        - Doctor shard parity sample size (default 16)");
  console.log("  --resume                   - Resume shard sync checkpoint during embed");
  console.log("  --line-numbers             - Include line numbers in output");
  console.log("  --explain                  - Include retrieval score traces (query --json/CLI)");
  console.log("  --files | --json | --csv | --md | --xml  - Output format");
  console.log("  -c, --collection <name>    - Filter by one or more collections");
  console.log("");
  console.log("Multi-get options:");
  console.log("  -l <num>                   - Maximum lines per file");
  console.log("  --max-bytes <num>          - Skip files larger than N bytes (default 10240)");
  console.log("  --json/--csv/--md/--xml/--files - Same formats as search");
  console.log("");
  console.log("History/diff options:");
  console.log("  -n <num>                   - Limit number of versions shown");
  console.log("  --from <version>           - Source version for diff (default: v2, previous)");
  console.log("  --to <version>             - Target version for diff (default: v1, current)");
  console.log("  --json | --csv             - Output format");
  console.log("");
  console.log("Memory commands:");
  console.log("  kindx memory put --scope <scope> --key <k> --value <v> [--tag t ...] [--source s]");
  console.log("  kindx memory search --scope <scope> <query> [--semantic|--text] [--threshold <n>] [-n <num>]");
  console.log("  kindx memory history --scope <scope> --key <k>");
  console.log("  kindx memory stats --scope <scope>");
  console.log("  kindx memory mark-accessed --scope <scope> --id <id>");
  console.log("  kindx memory embed --scope <scope> [--force]");
  console.log("  Scope resolution: explicit --scope > session scope > workspace scope > default");
  console.log("");
  console.log("Architecture:");
  console.log("");
  console.log("  KINDX is an on-device hybrid search engine for markdown documents. It runs");
  console.log("  entirely locally — no cloud APIs, no network calls — using SQLite for storage,");
  console.log("  local GGUF models for inference, and the Model Context Protocol (MCP) for");
  console.log("  AI agent integration.");
  console.log("");
  console.log("  Engine Modules:");
  console.log("    ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  ┌────────────┐");
  console.log("    │   kindx.ts   │  │ protocol.ts │  │ repository.ts│  │ inference.ts│");
  console.log("    │   (CLI)      │  │ (MCP Server)│  │ (Data Layer) │  │ (LLM/GGUF) │");
  console.log("    └──────┬───────┘  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘");
  console.log("           │                 │                │                │");
  console.log("           └────────┬────────┘                │                │");
  console.log("                    │                         │                │");
  console.log("              ┌─────▼─────┐            ┌─────▼─────┐    ┌─────▼─────┐");
  console.log("              │ session.ts │            │ memory.ts │    │ runtime.ts │");
  console.log("              │ (Lifecycle)│            │ (Scoped)  │    │ (SQLite)   │");
  console.log("              └───────────┘            └───────────┘    └───────────┘");
  console.log("");
  console.log("    kindx.ts          CLI entry point. Parses args, dispatches to commands.");
  console.log("    protocol.ts       MCP server (stdio + HTTP/SSE). Registers tools, resources,");
  console.log("                      and prompts. Handles session init, scope resolution.");
  console.log("    repository.ts     Core data access: indexing, FTS5 search, vector search,");
  console.log("                      smart chunking, structured queries, and reranking.");
  console.log("    inference.ts      Local LLM management. Loads GGUF models via node-llama-cpp.");
  console.log("                      Embedding (GTE-based), reranking (Qwen3), query expansion.");
  console.log("    session.ts        Per-connection lifecycle: embedding cache, AbortController");
  console.log("                      for cooperative cancellation, query log for enrichment.");
  console.log("    memory.ts         Scoped agent memory: upsert with semantic dedup, text/vector");
  console.log("                      search, supersession chains, tag system, hit-rate tracking.");
  console.log("    catalogs.ts       Collection registry (YAML-backed in ~/.config/kindx/).");
  console.log("                      Manages paths, glob patterns, contexts, update commands.");
  console.log("    runtime.ts        SQLite wrapper: better-sqlite3 + sqlite-vec extension loading.");
  console.log("    watcher.ts        Real-time incremental indexing daemon (chokidar-based).");
  console.log("    renderer.ts       Output formatting: CLI, JSON, CSV, Markdown, XML, files.");
  console.log("    instruction-layering.ts");
  console.log("                      Multi-layer instruction loading (global → project AGENTS.md).");
  console.log("    mcp-control-plane.ts");
  console.log("                      Tool policy enforcement, provenance registry, HTTP headers.");
  console.log("");
  console.log("  Storage Layer:");
  console.log("    Single SQLite database (WAL mode, busy_timeout=30s) at ~/.cache/kindx/index.sqlite");
  console.log("    ┌─────────────────────────────────────────────────────────────────────┐");
  console.log("    │  content         Content-addressable store (hash → doc text)        │");
  console.log("    │  documents       File→hash mapping with collection, path, active    │");
  console.log("    │  documents_fts   FTS5 full-text index (porter + unicode61 tokenizer)│");
  console.log("    │  content_vectors Embedding metadata (hash, seq, model, pos)         │");
  console.log("    │  vectors_vec     sqlite-vec virtual table (cosine distance)          │");
  console.log("    │  llm_cache       LLM response cache (query expansion, reranking)    │");
  console.log("    │  memories        Scoped key-value store with supersession chains     │");
  console.log("    │  memory_tags     Tag associations for memories                       │");
  console.log("    │  memory_links    Bidirectional memory relationships                  │");
  console.log("    │  memory_embeddings  Vector embeddings for semantic memory search     │");
  console.log("    └─────────────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log("  Retrieval Pipeline:");
  console.log("    1. Query parsing: structured (lex:/vec:/hyde:) or auto-expand via LLM");
  console.log("    2. BM25 retrieval: FTS5 keyword search with porter stemming");
  console.log("    3. Vector retrieval: cosine similarity via sqlite-vec (if embeddings exist)");
  console.log("    4. Score fusion: weighted combination of BM25 + vector scores");
  console.log("    5. Reranking: cross-encoder LLM reranker (Qwen3 0.6B, up to 40 candidates)");
  console.log("    6. Strong-signal bypass: skips LLM expansion when BM25 score ≥ 0.85");
  console.log("    7. Routing profiles: fast (20 candidates, no rerank), balanced, max_precision (60)");
  console.log("");
  console.log("  Smart Chunking:");
  console.log("    Documents are split at natural boundaries (headings, code fences, paragraphs)");
  console.log("    using scored break-point detection with distance decay.");
  console.log("    Chunk size: ~900 tokens with 15% overlap. Code fences are never split.");
  console.log("");
  console.log("  Inference Stack (Local GGUF):");
  console.log("    Embedding:   GTE-based model (embeddinggemma) via node-llama-cpp");
  console.log("    Reranking:   Qwen3-Reranker 0.6B Q8_0 — cross-encoder scoring");
  console.log("    Expansion:   Qwen3 1.7B — query-to-subquery generation");
  console.log("    Runtime:     LLM sessions with cooperative cancellation (AbortSignal)");
  console.log("    Caching:     Query expansion + rerank results cached in llm_cache table");
  console.log("    Models:      Downloaded to ~/.cache/kindx/models/ via 'kindx pull'");
  console.log("");
  console.log("  MCP Protocol:");
  console.log("    Transports:  stdio (default, for AI agents) or HTTP/SSE (--http, multi-client)");
  console.log("    Tools:       query, get, multi_get, status,");
  console.log("                 memory_put, memory_search, memory_history, memory_stats,");
  console.log("                 memory_mark_accessed");
  console.log("    Resources:   kindx://{collection}/{path} — document access by virtual path");
  console.log("    Sessions:    Per-connection KindxSession with embedding cache, abort signal,");
  console.log("                 query log. SessionRegistry for HTTP transport multiplexing.");
  console.log("    Instructions: Dynamic server instructions injected on initialize,");
  console.log("                 including collection list, instruction layers, memory prefetch.");
  console.log("    Control:     MCP control plane for tool policy, provenance, HTTP headers.");
  console.log("");
  console.log("  Memory Subsystem:");
  console.log("    Scoped key-value store for AI agent state persistence across sessions.");
  console.log("    Scope resolution: explicit > session > workspace > default.");
  console.log("    Dedup: exact match → semantic supersession (cosine ≥ 0.92) → single-cardinality.");
  console.log("    Supersession chains preserve full history (memory_history command).");
  console.log("    Vector embeddings enable semantic search across stored memories.");
  console.log("    Memory prefetch: top-3 accessed memories surfaced in MCP initialize response.");
  console.log("");
  console.log("  Collection System:");
  console.log("    YAML-backed registry at ~/.config/kindx/index.yml.");
  console.log("    Each collection maps a filesystem path + glob pattern to indexed documents.");
  console.log("    Virtual paths: kindx://{collection}/{relative-path} for cross-collection access.");
  console.log("    Context annotations: per-path human-written summaries injected into results.");
  console.log("    Default query behavior: collections can be included/excluded individually.");
  console.log("    Update commands: per-collection pre-index hooks (e.g., 'git pull').");
  console.log("");
  console.log("  Environment:");
  console.log("    INDEX_PATH                  Override database location");
  console.log("    KINDX_CONFIG_DIR            Override config directory (default: ~/.config/kindx)");
  console.log("    XDG_CACHE_HOME              Override cache root (default: ~/.cache)");
  console.log("    KINDX_QUERY_TIMEOUT_MS      Query timeout guard (0 = disabled)");
  console.log("    KINDX_INFLIGHT_DEDUPE       In-flight query dedup: join|off (default: join)");
  console.log("    KINDX_QUERY_REPLAY_DIR      Write query replay artifacts to this directory");
  console.log("    KINDX_ENCRYPTION_KEY        Enable SQLCipher keyed runtime and auto-migration");
  console.log("    KINDX_SQLITE_DRIVER         Force sqlite driver module (default probes sqlcipher-capable first)");
  console.log("    KINDX_ANN_ENABLE            Enable ANN routing for sharded collections (default: 1)");
  console.log("    KINDX_ANN_PROBE_COUNT       ANN centroid probes per shard (default: 4)");
  console.log("    KINDX_ANN_SHORTLIST         ANN shortlist size per shard (default: dynamic)");
  console.log("    KINDX_EXTRACTOR_PDF         Enable PDF extractor (default: 1)");
  console.log("    KINDX_EXTRACTOR_DOCX        Enable DOCX extractor (default: 1)");
  console.log("    KINDX_EXTRACTOR_FALLBACK_POLICY fallback|strict for extractor fallback behavior");
  console.log("");
  console.log(`Index: ${getDbPath()}`);
}

async function showVersion(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(scriptDir, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  let commit = "";
  try {
    commit = execSync(`git -C ${scriptDir} rev-parse --short HEAD`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Not a git repo or git not available
  }

  const versionStr = commit ? `${pkg.version} (${commit})` : pkg.version;
  console.log(`kindx ${versionStr}`);
}

function outputMemoryPayload(payload: unknown, format: OutputFormat): void {
  if (format === "json") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(payload);
}

type VerifyWipeReport = {
  cacheRoot: string;
  configRoot: string;
  indexPath: string;
  residualFiles: string[];
};

function verifyWipe(): VerifyWipeReport {
  const cacheRoot = getKindxCacheDir();
  const configRoot = process.env.KINDX_CONFIG_DIR
    ? resolve(process.env.KINDX_CONFIG_DIR)
    : resolve(homedir(), ".config", "kindx");
  const indexPath = getDbPath();
  const candidates = [
    indexPath,
    `${indexPath}-wal`,
    `${indexPath}-shm`,
    resolve(cacheRoot, "index.sqlite"),
    resolve(cacheRoot, "index.sqlite-wal"),
    resolve(cacheRoot, "index.sqlite-shm"),
  ];

  const globbed = fastGlob.sync([
    `${cacheRoot}/**/index.sqlite*`,
    `${configRoot}/**/index.sqlite*`,
  ], { onlyFiles: true, followSymbolicLinks: false });

  const residualFiles = Array.from(new Set([
    ...candidates.filter((file) => existsSync(file)),
    ...globbed,
  ]));

  return { cacheRoot, configRoot, indexPath, residualFiles };
}

// Main CLI - only run if this is the main module
const __filename = fileURLToPath(import.meta.url);
const argv1 = process.argv[1];
const isMain = argv1 === __filename
  || argv1?.endsWith("/kindx.ts")
  || argv1?.endsWith("/kindx.js")
  || (argv1 != null && realpathSync(argv1) === __filename);
if (isMain) {
  // Tier-2: opt into the cursor-cleanup signal handlers ONLY when this file
  // is invoked as the CLI entrypoint. Library/embedded callers (importing
  // engine modules from another process) are no longer hijacked at module
  // load time.
  registerCursorCleanup();

  // Global error handlers — catch unhandled errors with user-friendly messages.
  //
  // The default path emits the legacy single-line "Error: …" output so existing
  // scripts and test golden files keep working. When KINDX_JSON_ENVELOPE=1 or
  // --format json is in effect, we instead emit the stable JSON error envelope
  // documented in docs/json-schemas.md so machine consumers can recover.
  const reportTopLevelError = (raw: unknown): never => {
    const wantsJson = jsonEnvelopeEnabled(process.env)
      || process.argv.includes("--format=json")
      || (process.argv.includes("--format") && process.argv[process.argv.indexOf("--format") + 1] === "json");
    const err = toKindxError(raw);

    if (wantsJson) {
      process.stdout.write(JSON.stringify(errorEnvelope(err)) + "\n");
      process.exit(err.exitCode);
    }

    // Legacy-compatible pretty output for the well-known SQLite codes that
    // already had bespoke messages, plus the generic fallback.
    const sqliteCode = (raw as { code?: string } | undefined)?.code;
    if (sqliteCode === "SQLITE_NOTADB") {
      console.error(`Error: Index file is corrupted or not a valid database.`);
      console.error(`Path: ${process.env.INDEX_PATH || '~/.cache/kindx/index.sqlite'}`);
      console.error(`Try removing the file and re-indexing your collections.`);
    } else if (sqliteCode === "SQLITE_CANTOPEN") {
      console.error(`Error: Cannot open database file. Check that the path exists and is writable.`);
      console.error(`Path: ${process.env.INDEX_PATH || '~/.cache/kindx/index.sqlite'}`);
    } else if (sqliteCode === "SQLITE_BUSY") {
      console.error(`Error: Database is locked by another process. Retry in a moment.`);
    } else if (raw instanceof KindxError) {
      console.error(`Error: ${err.what}`);
      if (err.why) console.error(`  why: ${err.why}`);
      if (err.fix) console.error(`  fix: ${err.fix}`);
      if (err.examples) {
        for (const ex of err.examples) console.error(`       ${ex}`);
      }
    } else {
      console.error(`Error: ${err.what}`);
    }
    process.exit(err.exitCode);
  };

  process.on('uncaughtException', reportTopLevelError);
  process.on('unhandledRejection', reportTopLevelError);

  const cli = parseCLI();

  // Recompute the module-level `useColor` from the parsed flags so --color /
  // --no-color actually win against TTY auto-detection. resolveOutputMode()
  // already encodes the documented precedence (flag > NO_COLOR > TTY).
  {
    const v = cli.values as Record<string, unknown>;
    const resolved = resolveOutputMode({
      format: typeof v.format === "string" ? v.format : undefined,
      color: v.color as boolean | undefined,
      noColor: v["no-color"] as boolean | undefined,
      json: v.json as boolean | undefined,
      plain: v.plain as boolean | undefined,
      csv: v.csv as boolean | undefined,
      md: v.md as boolean | undefined,
      xml: v.xml as boolean | undefined,
      files: v.files as boolean | undefined,
      quiet: v.quiet as boolean | undefined,
    });
    useColor = resolved.color;
  }

  // Set the progress-mode hint as early as possible so the lazy reporter
  // (built on first checkIndexHealth/hook call) picks the right paint mode.
  // We map the legacy --json/--csv/--md/--xml/--files booleans + --format to
  // a single format string here.
  {
    const v = cli.values as Record<string, unknown>;
    let fmt: string | undefined;
    if (typeof v.format === "string") fmt = v.format;
    else if (v.json) fmt = "json";
    else if (v.csv) fmt = "csv";
    else if (v.md) fmt = "md";
    else if (v.xml) fmt = "xml";
    else if (v.files) fmt = "files";
    setReporterFormatHint(fmt, { quiet: !!v.quiet });
  }

  if (cli.values.version) {
    await showVersion();
    process.exit(0);
  }

  if (cli.values.skill) {
    showSkill();
    process.exit(0);
  }

  if (!cli.command || cli.values.help) {
    // Per-command / per-subcommand help.
    //   `kindx <cmd> <sub> --help` → renderSubcommandHelp (detail block)
    //   `kindx <cmd> --help`       → renderSubcommandList if available,
    //                                else renderCommandHelp (regular block)
    if (cli.command && cli.values.help) {
      const sub = cli.args[0];
      if (sub) {
        const subHelp = renderSubcommandHelp(cli.command, sub, { color: useColor });
        if (subHelp) {
          console.log(subHelp);
          process.exit(0);
        }
      }
      const subList = renderSubcommandList(cli.command, { color: useColor });
      if (subList) {
        console.log(subList);
        process.exit(0);
      }
      const help = renderCommandHelp(cli.command, { color: useColor });
      if (help) {
        console.log(help);
        process.exit(0);
      }
    }
    showHelp();
    process.exit(cli.values.help ? 0 : 1);
  }

  switch (cli.command) {
    case "context": {
      const subcommand = cli.args[0];
      if (!subcommand) {
        console.error("Usage: kindx context <add|list|rm>");
        console.error("");
        console.error("Commands:");
        console.error("  kindx context add [path] \"text\"  - Add context (defaults to current dir)");
        console.error("  kindx context add / \"text\"       - Add global context to all collections");
        console.error("  kindx context list                - List all contexts");
        console.error("  kindx context rm <path>           - Remove context");
        process.exit(1);
      }

      switch (subcommand) {
        case "add": {
          if (cli.args.length < 2) {
            console.error("Usage: kindx context add [path] \"text\"");
            console.error("");
            console.error("Examples:");
            console.error("  kindx context add \"Context for current directory\"");
            console.error("  kindx context add . \"Context for current directory\"");
            console.error("  kindx context add /subfolder \"Context for subfolder\"");
            console.error("  kindx context add / \"Global context for all collections\"");
            console.error("");
            console.error("  Using virtual paths:");
            console.error("  kindx context add kindx://journals/ \"Context for entire journals collection\"");
            console.error("  kindx context add kindx://journals/2024 \"Context for 2024 journals\"");
            process.exit(1);
          }

          let pathArg: string | undefined;
          let contextText: string;

          // Check if first arg looks like a path or if it's the context text
          const firstArg = cli.args[1] || '';
          const secondArg = cli.args[2];

          if (secondArg) {
            // Two args: path + context
            pathArg = firstArg;
            contextText = cli.args.slice(2).join(" ");
          } else {
            // One arg: context only (use current directory)
            pathArg = undefined;
            contextText = firstArg;
          }

          await contextAdd(pathArg, contextText);
          break;
        }

        case "list": {
          contextList();
          break;
        }

        case "rm":
        case "remove": {
          if (cli.args.length < 2 || !cli.args[1]) {
            console.error("Usage: kindx context rm <path>");
            console.error("Examples:");
            console.error("  kindx context rm /");
            console.error("  kindx context rm kindx://journals/2024");
            process.exit(1);
          }
          contextRemove(cli.args[1]);
          break;
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Available: add, list, rm");
          process.exit(1);
      }
      break;
    }

    case "get": {
      if (!cli.args[0]) {
        console.error("Usage: kindx get <filepath>[:line] [--from <line>] [-l <lines>] [--line-numbers]");
        process.exit(1);
      }
      const fromLine = cli.values.from ? parseInt(cli.values.from as string, 10) : undefined;
      const maxLines = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      getDocument(cli.args[0], fromLine, maxLines, cli.opts.lineNumbers);
      break;
    }

    case "history": {
      if (!cli.args[0]) {
        console.error("Usage: kindx history <filepath> [--json|--csv] [-n <limit>]");
        process.exit(1);
      }
      const historyLimit = cli.opts.limit || undefined;
      showDocumentHistory(cli.args[0], { format: cli.opts.format, limit: historyLimit });
      break;
    }

    case "diff": {
      if (!cli.args[0]) {
        console.error("Usage: kindx diff <filepath> [--from <version>] [--to <version>] [--json]");
        process.exit(1);
      }
      const fromVersion = cli.values.from ? parseInt(String(cli.values.from), 10) : undefined;
      const toVersion = cli.values.to ? parseInt(String(cli.values.to), 10) : undefined;
      diffDocuments(cli.args[0], { format: cli.opts.format, fromVersion, toVersion });
      break;
    }

    case "multi-get": {
      if (!cli.args[0]) {
        console.error("Usage: kindx multi-get <pattern> [-l <lines>] [--max-bytes <bytes>] [--json|--csv|--md|--xml|--files]");
        console.error("  pattern: glob (e.g., 'journals/2025-05*.md') or comma-separated list");
        process.exit(1);
      }
      const maxLinesMulti = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      const maxBytes = cli.values["max-bytes"] ? parseInt(cli.values["max-bytes"] as string, 10) : DEFAULT_MULTI_GET_MAX_BYTES;
      multiGet(cli.args[0], maxLinesMulti, maxBytes, cli.opts.format);
      break;
    }

    case "ls": {
      listFiles(cli.args[0]);
      break;
    }

    case "collection": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "list": {
          collectionList();
          break;
        }

        case "add": {
          const pwd = cli.args[1] || getPwd();
          const resolvedPwd = pwd === '.' ? getPwd() : getRealPath(resolve(pwd));
          const globPattern = cli.values.mask as string || DEFAULT_GLOB;
          const name = cli.values.name as string | undefined;

          await collectionAdd(resolvedPwd, globPattern, name);
          break;
        }

        case "remove":
        case "rm": {
          if (!cli.args[1]) {
            console.error("Usage: kindx collection remove <name>");
            console.error("  Use 'kindx collection list' to see available collections");
            process.exit(1);
          }
          collectionRemove(cli.args[1]);
          break;
        }

        case "rename":
        case "mv": {
          if (!cli.args[1] || !cli.args[2]) {
            console.error("Usage: kindx collection rename <old-name> <new-name>");
            console.error("  Use 'kindx collection list' to see available collections");
            process.exit(1);
          }
          collectionRename(cli.args[1], cli.args[2]);
          break;
        }

        case "set-update":
        case "update-cmd": {
          const name = cli.args[1];
          const cmd = cli.args.slice(2).join(' ') || null;
          if (!name) {
            console.error("Usage: kindx collection update-cmd <name> [command]");
            console.error("  Set the command to run before indexing (e.g., 'git pull')");
            console.error("  Omit command to clear it");
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("./catalogs.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          updateCollectionSettings(name, { update: cmd });
          if (cmd) {
            console.log(`✓ Set update command for '${name}': ${cmd}`);
          } else {
            console.log(`✓ Cleared update command for '${name}'`);
          }
          break;
        }

        case "include":
        case "exclude": {
          const name = cli.args[1];
          if (!name) {
            console.error(`Usage: kindx collection ${subcommand} <name>`);
            console.error(`  ${subcommand === 'include' ? 'Include' : 'Exclude'} collection in default queries`);
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("./catalogs.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          const include = subcommand === 'include';
          updateCollectionSettings(name, { includeByDefault: include });
          console.log(`✓ Collection '${name}' ${include ? 'included in' : 'excluded from'} default queries`);
          break;
        }

        case "show":
        case "info": {
          const name = cli.args[1];
          if (!name) {
            console.error("Usage: kindx collection show <name>");
            process.exit(1);
          }
          const { getCollection } = await import("./catalogs.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          console.log(`Collection: ${name}`);
          console.log(`  Path:     ${col.path}`);
          console.log(`  Pattern:  ${col.pattern}`);
          console.log(`  Include:  ${col.includeByDefault !== false ? 'yes (default)' : 'no'}`);
          if (col.update) {
            console.log(`  Update:   ${col.update}`);
          }
          if (col.context) {
            const ctxCount = Object.keys(col.context).length;
            console.log(`  Contexts: ${ctxCount}`);
          }
          break;
        }
        case "update-mask":
        case "set-pattern": {
          const name = cli.args[1];
          const newPattern = cli.args.slice(2).join(' ');
          if (!name || !newPattern) {
            console.error("Usage: kindx collection update-mask <name> <pattern>");
            console.error("  Update the glob pattern for an existing collection");
            console.error("");
            console.error("Examples:");
            console.error("  kindx collection update-mask notes '**/*.md,**/*.txt'");
            console.error("  kindx collection update-mask code '**/*.ts'");
            process.exit(1);
          }
          const { updateCollectionPattern, getCollection } = await import("./catalogs.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          const oldPattern = col.pattern;
          const updated = updateCollectionPattern(name, newPattern);
          if (updated) {
            console.log(`✓ Updated pattern for '${name}': ${oldPattern} → ${newPattern}`);
            console.log(`  Run 'kindx index' to re-index with the new pattern.`);
          } else {
            console.error(`Failed to update pattern for '${name}'.`);
            process.exit(1);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: kindx collection <command> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  list                      List all collections");
          console.log("  add <path> [--name NAME]  Add a collection");
          console.log("  remove <name>             Remove a collection");
          console.log("  rename <old> <new>        Rename a collection");
          console.log("  show <name>               Show collection details");
          console.log("  update-cmd <name> [cmd]   Set pre-update command (e.g., 'git pull')");
          console.log("  update-mask <name> <glob>  Update glob pattern for a collection");
          console.log("  include <name>            Include in default queries");
          console.log("  exclude <name>            Exclude from default queries");
          console.log("");
          console.log("Examples:");
          console.log("  kindx collection add ~/notes --name notes");
          console.log("  kindx collection update-cmd brain 'git pull'");
          console.log("  kindx collection update-mask notes '**/*.md,**/*.txt'");
          console.log("  kindx collection exclude archive");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'kindx collection help' for usage");
          process.exit(1);
      }
      break;
    }

    case "memory": {
      const subcommand = cli.args[0];
      const db = getDb();
      const workspaceScope = deriveWorkspaceMemoryScope(getPwd());
      const scope = resolveMemoryScopeShared({
        explicitScope: cli.values.scope,
        workspaceScope,
      }).scope;

      switch (subcommand) {
        case "put": {
          const key = ((cli.values.key as string | undefined) || "").trim();
          const value = ((cli.values.value as string | undefined) || "").trim();
          if (!key || !value) {
            console.error("Usage: kindx memory put --scope <scope> --key <key> --value <value> [--tag tag ...] [--source source]");
            process.exit(1);
          }
          const tags = (cli.values.tag as string[] | undefined) || [];
          const source = (cli.values.source as string | undefined) || undefined;
          const threshold = cli.values.threshold ? parseFloat(String(cli.values.threshold)) : undefined;
          const memory = await upsertMemory(db, {
            scope,
            key,
            value,
            tags,
            source,
            semanticThreshold: threshold,
          });

          if (cli.opts.format === "json") {
            outputMemoryPayload({ scope, memory }, "json");
          } else {
            console.log(renderMemoryEntry({
              id: memory.id,
              key: memory.key,
              value: memory.value,
              tags: (memory as any).tags,
              createdAt: (memory as any).createdAt,
              updatedAt: (memory as any).updatedAt,
            }, { color: useColor, scope, action: "Stored" }));
          }
          break;
        }

        case "search": {
          const query = cli.args.slice(1).join(" ").trim();
          if (!query) {
            console.error("Usage: kindx memory search --scope <scope> <query> [--semantic|--text] [--threshold <n>] [-n <num>]");
            process.exit(1);
          }
          const limit = cli.opts.limit || 20;
          const threshold = cli.values.threshold ? parseFloat(String(cli.values.threshold)) : 0.3;
          const useText = !!cli.values.text && !cli.values.semantic;
          const mode = useText ? "text" : "semantic";
          const results = useText
            ? textSearchMemory(db, scope, query, limit)
            : await semanticSearchMemory(db, scope, query, limit, threshold);

          if (cli.opts.format === "json") {
            outputMemoryPayload({ scope, mode, query, results }, "json");
          } else {
            console.log(renderMemorySearch(
              { scope, mode, query, totalResults: results.length },
              results.map((r) => ({
                id: r.id,
                key: r.key,
                value: r.value,
                similarity: r.similarity,
                hitRate: r.hitRate,
                createdAt: (r as any).createdAt,
                updatedAt: (r as any).updatedAt,
                lastAccessedAt: (r as any).lastAccessedAt,
                tags: (r as any).tags,
              })),
              { color: useColor },
            ));
          }
          break;
        }

        case "history": {
          const key = ((cli.values.key as string | undefined) || "").trim();
          if (!key) {
            console.error("Usage: kindx memory history --scope <scope> --key <key>");
            process.exit(1);
          }
          const history = getMemoryHistory(db, scope, key);
          if (cli.opts.format === "json") {
            outputMemoryPayload({ scope, key, history }, "json");
          } else {
            console.log(`${c.bold}History for ${key}${c.reset} (${history.length})`);
            for (const h of history) {
              const superseded = h.supersededBy ? ` -> superseded by #${h.supersededBy}` : "";
              console.log(`- #${h.id} ${h.value}${superseded}`);
            }
          }
          break;
        }

        case "stats": {
          const stats = getMemoryStats(db, scope);
          if (cli.opts.format === "json") {
            outputMemoryPayload(stats, "json");
          } else {
            console.log(`${c.bold}Memory stats${c.reset} (scope=${scope})`);
            console.log(`  total: ${stats.totalMemories}`);
            console.log(`  superseded: ${stats.superseded}`);
            console.log(`  embedded: ${stats.embedded}`);
            console.log(`  links: ${stats.links}`);
          }
          break;
        }

        case "mark-accessed": {
          const idRaw = (cli.values.id as string | undefined) || "";
          const id = Number.parseInt(idRaw, 10);
          if (!Number.isFinite(id)) {
            console.error("Usage: kindx memory mark-accessed --scope <scope> --id <id>");
            process.exit(1);
          }
          const ok = markMemoryAccessed(db, scope, id);
          if (!ok) {
            console.error(`Memory id ${id} not found in scope '${scope}'`);
            process.exit(1);
          }
          if (cli.opts.format === "json") {
            outputMemoryPayload({ scope, id, marked: true }, "json");
          } else {
            console.log(`${c.green}✓${c.reset} Marked memory #${id} as accessed`);
          }
          break;
        }

        case "embed": {
          const force = !!cli.values.force;
          const result = await embedMemories(db, scope, force);
          if (cli.opts.format === "json") {
            outputMemoryPayload({ scope, ...result, force }, "json");
          } else {
            console.log(`${c.green}✓${c.reset} Embedded ${result.embedded}/${result.totalCandidates} memories in scope '${scope}'`);
          }
          break;
        }

        case "consolidate": {
          const thresholdRaw = cli.values.threshold as string | undefined;
          const threshold = thresholdRaw ? Number.parseFloat(thresholdRaw) : 0.92;
          const { consolidateMemories } = await import("./memory.js");
          const result = consolidateMemories(db, scope, threshold);
          if (cli.opts.format === "json") {
            outputMemoryPayload({ scope, threshold, ...result }, "json");
          } else {
            console.log(`${c.green}✓${c.reset} Consolidated memories in scope '${scope}'`);
            console.log(`  Merged semantic overlaps: ${result.merged}`);
            console.log(`  Deprecated redundant nodes: ${result.deprecated}`);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: kindx memory <subcommand> [options]");
          console.log("");
          console.log("Subcommands:");
          console.log("  put            Store or update a scoped memory");
          console.log("  search         Semantic/text memory lookup");
          console.log("  history        Show value history for a key");
          console.log("  stats          Show scoped memory stats");
          console.log("  mark-accessed  Bump access counter for a memory id");
          console.log("  embed          Backfill memory embeddings for this scope");
          console.log("  consolidate    Merge semantically redundant active memories");
          console.log("  Scope resolution: explicit --scope > session scope > workspace scope > default");
          process.exit(0);
        }

        default:
          console.error(`Unknown memory subcommand: ${subcommand}`);
          console.error("Run 'kindx memory help' for usage");
          process.exit(1);
      }
      break;
    }

    case "status": {
      // --auto-invoke-rate short-circuits the regular status output and
      // emits only the trigger-source counters aggregated from the
      // mcp_query_log table. Designed for scripts that want to verify the
      // auto-invocation contract is causing agent-auto calls locally.
      if (cli.values["auto-invoke-rate"]) {
        const db = getDb();
        const counts = { totalCalls: 0, agentAuto: 0, userExplicit: 0, unknown: 0 };
        try {
          const rows = db
            .prepare(`SELECT trigger, COUNT(*) as n FROM mcp_query_log GROUP BY trigger`)
            .all() as Array<{ trigger: string | null; n: number }>;
          for (const r of rows) {
            counts.totalCalls += r.n;
            if (r.trigger === "agent-auto") counts.agentAuto += r.n;
            else if (r.trigger === "user-explicit") counts.userExplicit += r.n;
            else counts.unknown += r.n;
          }
        } catch {
          // Table absent (older index) — fall through with zero counts.
        }
        const data = { autoInvocation: counts };
        if (cli.opts.format === "json") {
          // Match the surrounding command pattern: emit the JSON envelope
          // when KINDX_JSON_ENVELOPE is set, otherwise the bare payload.
          const { jsonEnvelope, jsonEnvelopeEnabled } = await import("./cli/output.js");
          if (jsonEnvelopeEnabled(process.env)) {
            console.log(JSON.stringify(jsonEnvelope("status", data), null, 2));
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        } else {
          console.log(
            `Auto-invoke rate: ${counts.agentAuto}/${counts.totalCalls} agent-auto, ` +
            `${counts.userExplicit} user-explicit, ${counts.unknown} unknown.`,
          );
        }
        closeDb();
        break;
      }
      await runStatusCommand({ getDb, getDbPath, closeDb, getKindxCacheDir }, { format: cli.opts.format });
      break;
    }

    case "scheduler": {
      const code = runSchedulerStatusCommand({
        subcommand: cli.args[0],
        format: cli.opts.format,
        color: c,
        loadState: () => {
          const dbPath = getDbPath();
          const db = getDb();
          const checkpoint = getSchedulerCheckpointState(dbPath);
          return {
            shard: getShardRuntimeStatus(dbPath),
            checkpoint,
            queueState: getSchedulerQueueState(db, dbPath),
          };
        },
      });
      if (code !== 0) process.exit(code);
      break;
    }

    case "doctor": {
      const paritySample = cli.values["parity-sample"] ? parseInt(String(cli.values["parity-sample"]), 10) : 16;
      const code = runDoctorCommand(
        { getDb, getDbPath, closeDb },
        cli.opts.format,
        Number.isFinite(paritySample) && paritySample > 0 ? paritySample : 16,
      );
      if (code !== 0) process.exit(code);
      break;
    }

    case "repair": {
      if (cli.values["check-only"] === true || cli.values["check-only"] === "true") {
        const code = runRepairCheckCommand({ getDb, getDbPath, closeDb }, cli.opts.format);
        if (code !== 0) process.exit(code);
        break;
      }
      console.error("Usage: kindx repair --check-only");
      process.exit(1);
    }

    case "backup": {
      const code = runBackupCmd(cli.args, cli.values as Record<string, unknown>, cli.opts.format, getDbPath());
      if (code !== 0) process.exit(code);
      break;
    }

    case "migrate": {
      const target = cli.args[0];
      const dbPath = cli.args[1];
      if (!target || !dbPath) {
        console.error("Usage: kindx migrate <chroma|openclaw> <path>");
        process.exit(1);
      }
      
      if (target === "chroma") {
        const { migrateChroma } = await import("./migrate.js");
        const store = getStore();
        await migrateChroma(dbPath, "chroma_import", store);
        closeDb();
      } else if (target === "openclaw") {
        try {
          const { migrateOpenClawRepository, OpenClawMigrationError } = await import("./migrate-openclaw.js");
          console.log(`🦞 Migrating OpenCLAW integration from QMD to KINDX in ${dbPath}...`);
          const report = migrateOpenClawRepository(dbPath);
          console.log(
            `Renamed ${report.renamed.length} entries; rewrote ${report.rewrittenFiles.length} source files.`
          );
          for (const w of report.warnings) console.warn(`  warn: ${w}`);
          console.log("✅ Migration complete. Please run 'npm run build' inside OpenCLAW to verify.");
          // Reference the named error so the import is preserved if migration becomes optional.
          void OpenClawMigrationError;
        } catch (err) {
          console.error("Migration failed:", err instanceof Error ? err.message : err);
          process.exit(1);
        }
      } else {
        console.error(`Unknown migration target: ${target}`);
        console.error("Usage: kindx migrate <chroma|openclaw> <path>");
        process.exit(1);
      }
      break;
    }

    case "index": {
      const { runIndexCommand } = await import("./commands/index-command.js");
      const code = await runIndexCommand(
        cli.args,
        cli.values as Record<string, unknown>,
      );
      if (code !== 0) process.exit(code);
      break;
    }

    case "tenant":
    case "token": {
      const code = runTenantCommand(cli.args, cli.values as Record<string, unknown>, cli.opts.format);
      if (code !== 0) process.exit(code);
      break;
    }

    case "skill": {
      const subcommand = cli.args[0];
      if (subcommand === "install") {
        installSkill();
      } else {
        console.error("Usage: kindx skill install");
        process.exit(1);
      }
      break;
    }

    case "watch": {
      const { WatchDaemon } = await import("./watcher.js");
      const store = getStore();
      const daemon = new WatchDaemon(store);
      
      // Let it handle graceful shutdown
      process.on("SIGINT", async () => {
        console.log("\nGot SIGINT, stopping watcher...");
        await daemon.stop();
        closeDb();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        console.log("\nGot SIGTERM, stopping watcher...");
        await daemon.stop();
        closeDb();
        process.exit(0);
      });

      // User can pass specific collections: `kindx watch notes brain`
      await daemon.start(cli.args.length > 0 ? cli.args : undefined);
      
      // Keep process alive indefinitely
      await new Promise(() => {});
      break;
    }

    case "tui": {
      // Lazy-load so the TUI module (and its key/readline plumbing) is only
      // pulled in when explicitly requested. Keeps the cold-start cost of
      // `kindx search` and `kindx mcp` unchanged.
      const { runTui } = await import("./cli/tui/app.js");
      const collectionFilter = Array.isArray(cli.values.collection)
        ? (cli.values.collection[0] as string | undefined)
        : (cli.values.collection as string | undefined);
      const code = await runTui({
        initialQuery: cli.args.join(" "),
        initialCollection: collectionFilter ?? null,
        runSearch: async (q, runOpts) => {
          // BM25 search powers the live results panel — fast, deterministic,
          // and works without local models. Future iteration can dispatch by
          // runOpts.mode (lex/vec/hyde/hybrid) once async cancellation is in.
          void runOpts;
          const db = getDb();
          const colNames = collectionFilter ? [collectionFilter] : [];
          const single = colNames.length === 1 ? colNames[0] : undefined;
          const hits = filterByCollections(searchFTS(db, q, 20, single), colNames);
          return hits.slice(0, 12).map((r, i) => ({
            rank: i + 1,
            displayPath: r.displayPath,
            title: r.title || undefined,
            score: r.score,
            snippet: (r.body || "").slice(0, 240),
          }));
        },
      });
      closeDb();
      process.exit(code);
    }

    case "init": {
      // If --client (or --global/--project without positional args) is present,
      // route to the MCP client-wiring init flow (Phase B).
      if (cli.values.client !== undefined || cli.values.global === true) {
        const { runInit } = await import("./init/index.js");
        const clients = (cli.values.client as string[] | undefined) ?? ["auto"];
        const result = runInit({
          clients,
          projectPath: (cli.values.project as string | undefined) ?? process.cwd(),
          globalOnly: Boolean(cli.values.global),
          dryRun: Boolean(cli.values["dry-run"]),
          force: Boolean(cli.values.force),
        });
        console.log("KINDX init summary");
        console.log("──────────────────────────────────────────────────");
        for (const r of result.clientResults) {
          const tag = r.outcome === "skipped" ? "skip" : r.outcome;
          console.log(`  [${tag.padEnd(7)}] ${r.label.padEnd(18)}  ${r.configPath}${r.reason ? "  — " + r.reason : ""}`);
        }
        if (result.projectFile) {
          console.log(`  [${result.projectFile.outcome.padEnd(7)}] Project AGENTS.md   ${result.projectFile.path}`);
        }
        process.exit(0);
      }
      // Default: existing DB/collection setup flow.
      await runInitCommand(cli.args, cli.values as Record<string, unknown>, {
        updateCollections,
        vectorIndex,
        defaultGlob: DEFAULT_GLOB,
        defaultEmbedModel: DEFAULT_EMBED_MODEL,
      });
      break;
    }

    case "update": {
      const collFilter = cli.values.collection as string | string[] | undefined;
      await updateCollections(collFilter, { pull: Boolean(cli.values.pull) });
      
      if (cli.values.embed === true || cli.values.embed === 'true') {
        console.log(`\n${c.magenta}=== Embedding ===${c.reset}`);
        await vectorIndex(DEFAULT_EMBED_MODEL, false, !!cli.values.resume);
      }
      break;
    }

    case "embed":
    {
      const code = await executeEmbedCommand({
        force: !!cli.values.force,
        resume: !!cli.values.resume,
        runVectorIndex: vectorIndex,
      });
      if (code !== 0) process.exit(code);
      break;
    }

    case "pull": {
      const refresh = cli.values.refresh === undefined ? false : Boolean(cli.values.refresh);
      const models = [
        DEFAULT_EMBED_MODEL_URI,
        DEFAULT_GENERATE_MODEL_URI,
        DEFAULT_RERANK_MODEL_URI,
      ];
      console.log(`${c.bold}Pulling models${c.reset}`);
      const results = await pullModels(models, {
        refresh,
        cacheDir: DEFAULT_MODEL_CACHE_DIR,
      });
      for (const result of results) {
        const size = formatBytes(result.sizeBytes);
        const note = result.refreshed ? "refreshed" : "cached/checked";
        console.log(`- ${result.model} -> ${result.path} (${size}, ${note})`);
      }
      break;
    }

    case "search":
      if (cli.values.interactive) {
        const { runTui } = await import("./cli/tui/app.js");
        const code = await runTui({
          initialQuery: cli.query,
          initialCollection: Array.isArray(cli.opts.collection) ? cli.opts.collection[0] ?? null : (cli.opts.collection ?? null),
          runSearch: async (q) => {
            const db = getDb();
            const colNames = Array.isArray(cli.opts.collection) ? cli.opts.collection : (cli.opts.collection ? [cli.opts.collection] : []);
            const single = colNames.length === 1 ? colNames[0] : undefined;
            const hits = filterByCollections(searchFTS(db, q, 20, single), colNames as string[]);
            return hits.slice(0, 12).map((r, i) => ({
              rank: i + 1,
              displayPath: r.displayPath,
              title: r.title || undefined,
              score: r.score,
              snippet: (r.body || "").slice(0, 240),
            }));
          },
        });
        closeDb();
        process.exit(code);
      }
      if (!cli.query) {
        console.error("Usage: kindx search [options] <query>");
        process.exit(1);
      }
      search(cli.query, cli.opts);
      break;

    case "vsearch":
    case "vector-search": // undocumented alias
      if (!cli.query) {
        console.error("Usage: kindx vsearch [options] <query>");
        process.exit(1);
      }
      // Default min-score for vector search is 0.3
      if (!cli.values["min-score"]) {
        cli.opts.minScore = 0.3;
      }
      await vectorSearch(cli.query, cli.opts);
      break;

    case "query":
    case "deep-search": // undocumented alias
    {
      const code = await executeQueryCommand({
        query: cli.query,
        opts: cli.opts,
        runQuerySearch: querySearch as (query: string, opts: unknown) => Promise<void>,
      });
      if (code !== 0) process.exit(code);
      break;
    }

    case "usage": {
      const { getAiUsageSummary, getAiUsageByOperation } = await import("./ai-usage.js");
      const { c, formatMs } = await import("./utils/ui.js");
      const db = getDb();
      
      const summary = getAiUsageSummary(db);
      console.log(`\n${c.bold}KINDX AI Token Usage Ledger${c.reset}`);
      console.log("──────────────────────────────────────────────────");
      console.log(`Total Calls:         ${c.cyan}${summary.total_calls}${c.reset}`);
      console.log(`Total Input Tokens:  ${c.yellow}${summary.total_input_tokens.toLocaleString()}${c.reset}`);
      console.log(`Total Output Tokens: ${c.yellow}${summary.total_output_tokens.toLocaleString()}${c.reset}`);
      console.log(`Total Tokens:        ${c.green}${summary.total_tokens.toLocaleString()}${c.reset}`);
      console.log(`Error Count:         ${summary.error_count > 0 ? c.red : ''}${summary.error_count}${c.reset}`);
      console.log(`Models Used:         ${c.cyan}${summary.models_used}${c.reset}`);
      console.log(`Total Duration:      ${formatMs(summary.total_duration_ms)}\n`);
      
      const byOp = getAiUsageByOperation(db);
      if (byOp.length > 0) {
        console.log(`${c.bold}Usage by Operation${c.reset}`);
        console.log("──────────────────────────────────────────────────");
        for (const op of byOp) {
          console.log(`  ${c.cyan}${op.operation.padEnd(15)}${c.reset} | Calls: ${op.call_count.toString().padEnd(5)} | Tokens: ${c.green}${op.total_tokens.toLocaleString()}${c.reset} | Time: ${formatMs(op.total_duration_ms)}`);
        }
      }
      console.log("");
      closeDb();
      break;
    }

    case "mcp": {
      if (cli.values["health-check"]) {
        try {
          const store = createStore();
          const status = store.getStatus();
          try { store.close?.(); } catch { /* ignore */ }
          console.log(JSON.stringify({ ok: true, totalDocuments: status.totalDocuments, collections: status.collections.length }));
          process.exit(0);
        } catch (err: any) {
          console.error(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
          process.exit(1);
        }
      }

      const sub = cli.args[0]; // stop | status | undefined

      // Cache dir for PID/log files — same dir as the index
      const cacheDir = getKindxCacheDir();
      const pidPath = resolve(cacheDir, "mcp.pid");

      // Subcommands take priority over flags
      if (sub === "stop") {
        const wantsJson = cli.opts.format === "json";
        if (!existsSync(pidPath)) {
          if (wantsJson) {
            const payload = { ok: true, command: "mcp", data: { stopped: false, reason: "not_running" } };
            console.log(JSON.stringify(payload));
          } else {
            console.log("Not running (no PID file).");
          }
          process.exit(0);
        }
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
        try {
          process.kill(pid, 0); // alive?
          process.kill(pid, "SIGTERM");
          unlinkSync(pidPath);
          if (wantsJson) {
            console.log(JSON.stringify({ ok: true, command: "mcp", data: { stopped: true, pid } }));
          } else {
            console.log(`Stopped KINDX MCP server (PID ${pid}).`);
          }
        } catch {
          unlinkSync(pidPath);
          if (wantsJson) {
            console.log(JSON.stringify({ ok: true, command: "mcp", data: { stopped: false, reason: "stale_pid" } }));
          } else {
            console.log("Cleaned up stale PID file (server was not running).");
          }
        }
        process.exit(0);
      }

      // `kindx mcp status` (or `--format json` on the bare `mcp` command):
      // report transport, endpoints, daemon pid/log, masked-token info.
      if (sub === "status" || (cli.opts.format === "json" && !cli.values.http)) {
        const port = Number(cli.values.port) || 8181;
        const logPath = resolve(cacheDir, "mcp.log");
        let pidAlive: number | undefined;
        if (existsSync(pidPath)) {
          const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
          try { process.kill(pid, 0); pidAlive = pid; } catch { /* stale */ }
        }
        const token = process.env.KINDX_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN;
        const data: McpStatusData = pidAlive ? {
          transport: "daemon",
          host: "localhost",
          port,
          authMode: token ? "bearer" : "none",
          token,
          pid: pidAlive,
          pidPath,
          logPath,
          mcpEndpoint: `http://localhost:${port}/mcp`,
          healthEndpoint: `http://localhost:${port}/health`,
          metricsEndpoint: `http://localhost:${port}/metrics`,
          stopCommand: "kindx mcp stop",
        } : {
          transport: "stdio",
          authMode: token ? "bearer" : "none",
          token,
          stopCommand: "kindx mcp stop",
        };
        if (cli.opts.format === "json") {
          const redacted = redactedMcpStatus(data);
          if (jsonEnvelopeEnabled(process.env)) {
            console.log(JSON.stringify({ ok: true, command: "mcp", data: redacted }, null, 2));
          } else {
            console.log(JSON.stringify(redacted, null, 2));
          }
        } else {
          console.log(renderMcpStatus(data, { color: useColor }));
        }
        process.exit(0);
      }

      if (cli.values.http) {
        const port = Number(cli.values.port) || 8181;

        if (cli.values.daemon) {
          // Guard: check if already running
          if (existsSync(pidPath)) {
            const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim());
            try {
              process.kill(existingPid, 0); // alive?
              console.error(`Already running (PID ${existingPid}). Run 'kindx mcp stop' first.`);
              process.exit(1);
            } catch {
              // Stale PID file — continue
            }
          }

          mkdirSync(cacheDir, { recursive: true });
          const logPath = resolve(cacheDir, "mcp.log");
          const logFd = openSync(logPath, "w"); // truncate — fresh log per daemon run
          const selfPath = fileURLToPath(import.meta.url);
          const iName = (cli.values.workspace || cli.values.index) as string | undefined;
          const indexFlag = iName ? ["--workspace", iName] : [];
          const logArgs = [
            ...(cli.values["log-format"] ? ["--log-format", String(cli.values["log-format"])] : []),
            ...(cli.values["log-level"] ? ["--log-level", String(cli.values["log-level"])] : []),
          ];
          const spawnArgs = selfPath.endsWith(".ts")
            ? ["--import", pathJoin(dirname(selfPath), "..", "node_modules", "tsx", "dist", "esm", "index.mjs"), selfPath, "mcp", "--http", "--port", String(port), ...logArgs, ...indexFlag]
            : [selfPath, "mcp", "--http", "--port", String(port), ...logArgs, ...indexFlag];
          const child = nodeSpawn(process.execPath, spawnArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
          });
          child.unref();
          closeSync(logFd); // parent's copy; child inherited the fd

          writeFileSync(pidPath, String(child.pid));
          const token = process.env.KINDX_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN;
          const data: McpStatusData = {
            transport: "daemon",
            host: "localhost",
            port,
            authMode: token ? "bearer" : "none",
            token,
            pid: child.pid,
            pidPath,
            logPath,
            mcpEndpoint: `http://localhost:${port}/mcp`,
            healthEndpoint: `http://localhost:${port}/health`,
            metricsEndpoint: `http://localhost:${port}/metrics`,
            stopCommand: "kindx mcp stop",
          };
          if (cli.opts.format === "json") {
            const redacted = redactedMcpStatus(data);
            if (jsonEnvelopeEnabled(process.env)) {
              console.log(JSON.stringify({ ok: true, command: "mcp", data: redacted }, null, 2));
            } else {
              console.log(JSON.stringify(redacted, null, 2));
            }
          } else {
            console.log(renderMcpStatus(data, { color: useColor }));
          }
          process.exit(0);
        }

        // foreground HTTP mode — remove top-level cursor handlers so the
        // async cleanup handlers in startMcpHttpServer actually run.
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        const { startMcpHttpServer } = await import("./protocol.js");
        try {
          await startMcpHttpServer(port, { dbPath: storeDbPathOverride });
        } catch (e: any) {
          if (e?.code === "EADDRINUSE") {
            console.error(`Port ${port} already in use. Try a different port with --port.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        // Default: stdio transport.
        // If a real user ran `kindx mcp` from a terminal (stdin is a TTY rather
        // than a pipe from an MCP client), print a one-line hint to stderr so
        // they don't think the silent process is broken. Goes to stderr so it
        // never pollutes the JSON-RPC stdout protocol that real MCP clients
        // read from this process.
        if (process.stdin.isTTY) {
          process.stderr.write(
            "kindx mcp is running in stdio mode and waiting for an MCP client on stdin/stdout.\n" +
            "To auto-wire it into your local agents (Claude Code, Cursor, Codex, etc.), press Ctrl+C and run:\n" +
            "    kindx init --client auto\n" +
            "Or run `kindx mcp --http` to talk to it over HTTP, or `kindx mcp --health-check` to verify it works.\n\n"
          );
        }
        const { startMcpServer } = await import("./protocol.js");
        await startMcpServer(storeDbPathOverride);
      }
      break;
    }

    case "cleanup": {
      const dbPath = getDbPath();
      const db = getDb();

      if (cli.values.cache === true || cli.values.cache === "true") {
        const cacheCount = deleteLLMCache(db);
        closeDb();
        if (cli.opts.format === "json") {
          console.log(JSON.stringify({ cache_only: true, cleared: cacheCount }, null, 2));
        } else {
          console.log(`${c.green}✓${c.reset} Cleared ${cacheCount} cached API responses`);
        }
        break;
      }

      // 1. Clear llm_cache
      const cacheCount = deleteLLMCache(db);
      console.log(`${c.green}✓${c.reset} Cleared ${cacheCount} cached API responses`);

      // 2. Remove orphaned vectors
      const orphanedVecs = cleanupOrphanedVectors(db);
      if (orphanedVecs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${orphanedVecs} orphaned embedding chunks`);
      } else {
        console.log(`${c.dim}No orphaned embeddings to remove${c.reset}`);
      }

      // 3. Remove inactive documents
      const inactiveDocs = deleteInactiveDocuments(db);
      if (inactiveDocs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${inactiveDocs} inactive document records`);
      }

      // 4. Checkpoint WAL before vacuum so sidecar pages are consolidated.
      const checkpointed = walCheckpointTruncate(db);
      if (checkpointed) {
        console.log(`${c.green}✓${c.reset} WAL checkpointed (TRUNCATE)`);
      } else {
        console.log(`${c.yellow}!${c.reset} WAL checkpoint skipped (non-WAL mode or unsupported)`);
      }

      // 5. Vacuum to reclaim space
      vacuumDatabase(db);
      console.log(`${c.green}✓${c.reset} Database vacuumed`);

      closeDb();

      // 6. Best-effort sidecar file cleanup after DB handle is closed.
      const sidecar = cleanupSqliteSidecars(dbPath);
      if (sidecar.walRemoved || sidecar.shmRemoved) {
        console.log(`${c.green}✓${c.reset} Removed SQLite sidecars (wal=${sidecar.walRemoved}, shm=${sidecar.shmRemoved})`);
      }
      if (sidecar.lockedFiles.length > 0) {
        console.error(`${c.yellow}!${c.reset} Locked files remain: ${sidecar.lockedFiles.join(", ")}`);
      }

      const cleanupReport = {
        checkpointed,
        wal_removed: sidecar.walRemoved,
        shm_removed: sidecar.shmRemoved,
        locked_files: sidecar.lockedFiles,
      };
      if (cli.opts.format === "json") {
        console.log(JSON.stringify(cleanupReport, null, 2));
      }
      if (sidecar.lockedFiles.length > 0) {
        process.exit(2);
      }
      break;
    }

    case "verify-wipe": {
      const report = verifyWipe();
      const status = report.residualFiles.length === 0 ? "fully_wiped" : "residual_artifacts_found";
      if (cli.opts.format === "json") {
        if (jsonEnvelopeEnabled(process.env)) {
          console.log(JSON.stringify({
            ok: true,
            command: "verify-wipe",
            data: { status, ...report },
          }, null, 2));
        } else {
          console.log(JSON.stringify({ status, ...report }, null, 2));
        }
      } else if (report.residualFiles.length === 0) {
        console.log(`${c.green}✓${c.reset} No residual index artifacts found.`);
      } else {
        console.error(`${c.yellow}!${c.reset} Residual artifacts detected:`);
        for (const file of report.residualFiles) {
          console.error(`- ${file}`);
        }
      }
      if (report.residualFiles.length > 0) {
        process.exit(2);
      }
      break;
    }

    case "arch": {
      const subcommand = cli.args[0] || "status";
      await runArchCommand(subcommand, cli.args.slice(1));
      break;
    }

    default: {
      const cmd = cli.command ?? "";
      const suggestions = suggestCommandNames(cmd);
      console.error(`Unknown command: ${cmd}`);
      if (suggestions.length === 1) {
        console.error(`  Did you mean: ${suggestions[0]}?`);
      } else if (suggestions.length > 1) {
        console.error(`  Did you mean one of: ${suggestions.join(", ")}?`);
      }
      console.error("Run 'kindx --help' for usage.");
      process.exit(1);
    }
  }

  if (cli.command !== "mcp") {
    await disposeDefaultLLM();
    process.exit(0);
  }

} // end if (main module)
