type SchedulerQueueRow = {
  collection: string;
  shardCount: number;
  checkpointShardCount: number | null;
  completed: boolean;
  processed: number;
  pending: number;
  active: number;
  total: number;
  queueLimit: number | null;
  workers: number;
  batchSize: number;
  lastHashSeq: string | null;
  topologyDrift: boolean;
};

type SchedulerCheckpoint = {
  checkpointExists?: boolean;
  checkpointPath?: string;
  valid?: boolean;
  warnings?: string[];
  collections?: Record<string, { shardCount: number; completed: boolean; lastHashSeq: string | null }>;
};

type SchedulerQueueStateRow = {
  collection: string;
  shardCount: number;
  total: number;
  processed: number;
  pending: number;
  queueLimit: number | null;
  workers: number;
  batchSize: number;
  active: number;
};

export function buildSchedulerQueueRows(
  checkpoint: SchedulerCheckpoint,
  queueState: SchedulerQueueStateRow[],
): SchedulerQueueRow[] {
  const checkpointCollections = checkpoint.collections ?? {};
  return queueState.map((q) => {
    const state = checkpointCollections[q.collection];
    const topologyDrift = !!state && state.shardCount !== q.shardCount;
    return {
      collection: q.collection,
      shardCount: q.shardCount,
      checkpointShardCount: state?.shardCount ?? null,
      completed: state?.completed ?? false,
      processed: q.processed,
      pending: q.pending,
      active: q.active,
      total: q.total,
      queueLimit: q.queueLimit,
      workers: q.workers,
      batchSize: q.batchSize,
      lastHashSeq: state?.lastHashSeq ?? null,
      topologyDrift,
    };
  });
}

export function renderSchedulerStatus(args: {
  format: "cli" | "json" | "csv" | "md" | "xml" | "files";
  shard: unknown;
  checkpoint: unknown;
  queue: SchedulerQueueRow[];
  color: { bold: string; reset: string };
}): void {
  const { format, shard, checkpoint, queue, color } = args;
  if (format === "json") {
    console.log(JSON.stringify({ shard, checkpoint, queue }, null, 2));
    return;
  }

  const shardAny = shard as { enabledCollections?: Array<{ collection: string; shardCount: number }> };
  const checkpointAny = checkpoint as { checkpointExists?: boolean; checkpointPath?: string; valid?: boolean; warnings?: string[] };
  console.log(`${color.bold}Scheduler Status${color.reset}`);
  if ((shardAny.enabledCollections?.length ?? 0) === 0) {
    console.log("  No sharded collections configured.");
  } else {
    console.log(`  Sharded collections: ${shardAny.enabledCollections!.map((s) => `${s.collection}:${s.shardCount}`).join(", ")}`);
  }
  console.log(`  Checkpoint: ${checkpointAny.checkpointExists ? checkpointAny.checkpointPath : "none"}`);
  console.log(`  Checkpoint valid: ${checkpointAny.valid ? "yes" : "no"}`);
  if ((checkpointAny.warnings?.length ?? 0) > 0) {
    console.log("  Checkpoint warnings:");
    for (const warning of checkpointAny.warnings!) {
      console.log(`    - ${warning}`);
    }
  }
  for (const state of queue) {
    const driftSuffix = state.topologyDrift ? " drift=true" : "";
    console.log(
      `  - ${state.collection}: completed=${state.completed} processed=${state.processed}/${state.total} pending=${state.pending} active=${state.active} last=${state.lastHashSeq ?? "none"}${driftSuffix}`
    );
  }
}

export function runSchedulerStatusCommand(args: {
  subcommand: string | undefined;
  format: "cli" | "json" | "csv" | "md" | "xml" | "files";
  color: { bold: string; reset: string };
  loadState: () => {
    shard: unknown;
    checkpoint: SchedulerCheckpoint;
    queueState: SchedulerQueueStateRow[];
  };
  stderr?: NodeJS.WritableStream;
}): number {
  const err = args.stderr ?? process.stderr;
  const sub = args.subcommand || "status";
  if (sub !== "status") {
    err.write("Usage: kindx scheduler status\n");
    return 1;
  }
  const { shard, checkpoint, queueState } = args.loadState();
  const queue = buildSchedulerQueueRows(checkpoint, queueState);
  renderSchedulerStatus({
    format: args.format,
    shard,
    checkpoint,
    queue,
    color: args.color,
  });
  return 0;
}
