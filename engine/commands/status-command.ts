/**
 * status-command.ts — Extracted status display logic from kindx.ts
 *
 * Renders index health, collection inventory, model info, device capabilities,
 * and operational warnings to the terminal.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { Database } from "../runtime.js";
import {
  getStatus,
  getHashesNeedingEmbedding,
  getIndexHealth,
  listCollections,
} from "../repository.js";
import {
  getCollection as getCollectionFromYaml,
  listAllContexts,
} from "../catalogs.js";
import {
  buildOperationalStatus,
} from "../diagnostics.js";
import {
  getShardHealthSummary,
} from "../sharding.js";
import { getDefaultLLM, DEFAULT_EMBED_MODEL_URI, DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI } from "../inference.js";
import {
  c,
  formatTimeAgo,
  formatBytes,
} from "../utils/ui.js";

export interface StatusDeps {
  getDb: () => Database;
  getDbPath: () => string;
  closeDb: () => void;
  getKindxCacheDir: () => string;
}

export async function runStatusCommand(deps: StatusDeps): Promise<void> {
  const { getDb, getDbPath, closeDb, getKindxCacheDir } = deps;
  const dbPath = getDbPath();
  const db = getDb();

  // Index size
  let indexSize = 0;
  try {
    indexSize = statSync(dbPath).size;
  } catch { }

  const collections = listCollections(db);
  const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
  const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const status = getStatus(db);
  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };

  console.log(`${c.bold}KINDX Status${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Size:  ${formatBytes(indexSize)}`);

  // MCP daemon status
  const mcpCacheDir = getKindxCacheDir();
  const mcpPidPath = resolve(mcpCacheDir, "mcp.pid");
  if (existsSync(mcpPidPath)) {
    const mcpPid = parseInt(readFileSync(mcpPidPath, "utf-8").trim());
    try {
      process.kill(mcpPid, 0);
      console.log(`MCP:   ${c.green}running${c.reset} (PID ${mcpPid})`);
    } catch {
      try { unlinkSync(mcpPidPath); } catch { }
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
      try { unlinkSync(watchPidPath); } catch { }
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

  // Contexts
  const allContexts = listAllContexts();
  const contextsByCollection = new Map<string, { path_prefix: string; context: string }[]>();
  for (const ctx of allContexts) {
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
          const pathDisplay = (ctx.path_prefix === '' || ctx.path_prefix === '/') ? '/' : `/${ctx.path_prefix}`;
          const contextPreview = ctx.context.length > 60
            ? ctx.context.substring(0, 57) + '...'
            : ctx.context;
          console.log(`      ${c.dim}${pathDisplay}:${c.reset} ${contextPreview}`);
        }
      }
    }

    console.log(`\n${c.bold}Examples${c.reset}`);
    console.log(`  ${c.dim}# List files in a collection${c.reset}`);
    if (collections[0]) {
      console.log(`  kindx ls ${collections[0].name}`);
    }
    console.log(`  ${c.dim}# Get a document${c.reset}`);
    if (collections[0]) {
      console.log(`  kindx get kindx://${collections[0].name}/path/to/file.md`);
    }
    console.log(`  ${c.dim}# Search within a collection${c.reset}`);
    if (collections[0]) {
      console.log(`  kindx search "query" -c ${collections[0].name}`);
    }
  } else {
    console.log(`\n${c.dim}No collections. Run 'kindx collection add .' to index markdown files.${c.reset}`);
  }

  // Models
  {
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

  // Tips
  const tips: string[] = [];
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
