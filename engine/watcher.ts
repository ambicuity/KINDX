import chokidar from "chokidar";
import { resolve } from "path";
import { type Store } from "./repository.js";

interface WatchEvent {
  type: "add" | "change" | "unlink";
  collectionName: string;
  relativePath: string;
  absolutePath: string;
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export class WatchDaemon {
  private store: Store;
  private watchers: chokidar.FSWatcher[] = [];
  private eventQueue: WatchEvent[] = [];
  private isProcessing = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs = 500;
  
  // Track start time for freshness reporting
  public readonly startTime = Date.now();
  public lastUpdateTs = Date.now();
  public eventCount = 0;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Start watching specified collections (or all active if none specified)
   */
  public async start(collectionNames?: string[]): Promise<void> {
    const { listCollections } = await import("./catalogs.js");
    // Since we are reading from the DB/yaml config
    const collections = listCollections();
    
    // Filter if specific collections requested
    const targetCollections = collectionNames && collectionNames.length > 0
      ? collections.filter(c => collectionNames.includes(c.name))
      : collections;

    if (targetCollections.length === 0) {
      console.log("No collections to watch.");
      return;
    }

    try {
      const { resolve } = await import("path");
      const { homedir } = await import("os");
      const { writeFileSync, existsSync, mkdirSync } = await import("fs");
      const cacheDir = process.env.XDG_CACHE_HOME
        ? resolve(process.env.XDG_CACHE_HOME, "kindx")
        : resolve(homedir(), ".cache", "kindx");
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }
      writeFileSync(resolve(cacheDir, "watch.pid"), process.pid.toString(), "utf-8");
    } catch (err) {
      console.error("Warning: could not write watch.pid file", err);
    }

    console.log(`Starting watcher daemon for ${targetCollections.length} collections...`);
    
    for (const coll of targetCollections) {
      // Build absolute watch path based on collection pwd and pattern
      // chokidar handles globs like /path/to/collection/**/*.md
      // We watch the whole directory and filter by pattern later to avoid chokidar glob complexity issues on some platforms
      const watchTarget = coll.path;
      
      console.log(`- Watching [${c.bold}${coll.name}${c.reset}]: ${watchTarget} (pattern: ${coll.pattern})`);
      
      const watcher = chokidar.watch(watchTarget, {
        persistent: true,
        ignoreInitial: true, // Don't trigger 'add' for existing files on startup
        ignored: [/(^|[\/\\])\../, "**/node_modules/**", "dist/**"], // ignore dotfiles and common dirs
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      // Simple matcher for the collection pattern
      const picomatchModule = await import("picomatch");
      const picomatch = picomatchModule.default || picomatchModule;
      const isMatch = (picomatch as any)(coll.pattern);

      const processEvent = (type: WatchEvent["type"], absolutePath: string) => {
        // Normalise path separators
        const normalizedAbs = absolutePath.replace(/\\/g, "/");
        const normalizedPwd = coll.path.replace(/\\/g, "/");
        
        // Extract relative path
        const pwdWithSlash = normalizedPwd.endsWith("/") ? normalizedPwd : normalizedPwd + "/";
        if (!normalizedAbs.startsWith(pwdWithSlash)) {
          return;
        }
        
        const relativePath = normalizedAbs.slice(pwdWithSlash.length);
        
        // Check pattern
        if (!isMatch(relativePath)) return;

        this.enqueue(type, coll.name, relativePath, normalizedAbs);
      };

      watcher
        .on("add", (path) => processEvent("add", path))
        .on("change", (path) => processEvent("change", path))
        .on("unlink", (path) => processEvent("unlink", path))
        .on("error", (error) => console.error(`Watcher error for [${coll.name}]:`, error));

      this.watchers.push(watcher);
    }
    
    console.log("Daemon active. Waiting for file system changes...");
  }

  /**
   * Stop all watchers
   */
  public async stop(): Promise<void> {
    console.log("Stopping watchers...");
    await Promise.all(this.watchers.map(w => w.close()));
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    try {
      const { resolve } = await import("path");
      const { homedir } = await import("os");
      const { unlinkSync, existsSync } = await import("fs");
      const cacheDir = process.env.XDG_CACHE_HOME
        ? resolve(process.env.XDG_CACHE_HOME, "kindx")
        : resolve(homedir(), ".cache", "kindx");
      const pidPath = resolve(cacheDir, "watch.pid");
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch (err) {}
  }

  /**
   * Enqueue a filesystem event and trigger debounced processing
   */
  private enqueue(type: WatchEvent["type"], collectionName: string, relativePath: string, absolutePath: string): void {
    // Deduplicate: if an event for this file already exists in queue, update it
    const existingIdx = this.eventQueue.findIndex(e => e.collectionName === collectionName && e.relativePath === relativePath);
    
    if (existingIdx >= 0) {
      const existing = this.eventQueue[existingIdx]!;
      // If we got 'add' then 'change', it's still an 'add' or 'change'. 
      // If we got 'add' then 'unlink', it's dead.
      // Easiest approach: just overwrite with the latest state
      if (type === "unlink") {
        existing.type = "unlink";
      } else if (existing.type !== "add") {
        existing.type = "change"; 
      }
    } else {
      this.eventQueue.push({ type, collectionName, relativePath, absolutePath });
    }

    // Debounce processing
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.processQueue().catch(err => {
        console.error("Error processing watch queue:", err);
      });
    }, this.debounceMs);
  }

  /**
   * Process queued events sequentially to prevent SQLite WAL contention
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.eventQueue.length === 0) return;
    this.isProcessing = true;

    // Take a snapshot of the current queue
    const batch = [...this.eventQueue];
    this.eventQueue = [];

    const startMs = Date.now();
    let processed = 0;
    
    // Format current time
    const now = new Date().toLocaleTimeString();
    console.log(`\n[${now}] Processing ${batch.length} changed files...`);

    try {
      // Need to cast store to any temporarily since the methods don't exist yet
      const store = this.store as any;

      for (const event of batch) {
        try {
          if (event.type === "unlink") {
            const removed = await store.unlinkSingleFile(event.collectionName, event.relativePath);
            if (removed) {
              console.log(`  ${c.red}[-]${c.reset} Removed: ${event.relativePath}`);
              processed++;
            }
          } else {
            // add or change
            const result = await store.indexSingleFile(event.collectionName, event.relativePath, event.absolutePath);
            if (result === "embedded") {
              console.log(`  ${c.green}[+]${c.reset} Re-indexed: ${event.relativePath}`);
              processed++;
            } else if (result === "unchanged") {
              // hash matched, no change needed
              // console.log(`  [=] Unchanged: ${event.relativePath}`);
            } else if (result === "failed") {
              console.log(`  ${c.red}[x]${c.reset} Failed: ${event.relativePath}`);
            }
          }
        } catch (err) {
          console.error(`  ${c.red}[!]${c.reset} Error processing ${event.relativePath}:`, err);
        }
      }
      
      if (processed > 0) {
        this.lastUpdateTs = Date.now();
        this.eventCount += processed;
        const elapsed = Date.now() - startMs;
        console.log(`[${new Date().toLocaleTimeString()}] Batch complete. ${processed} files updated in ${formatMs(elapsed)}`);
      }
    } finally {
      this.isProcessing = false;
      // If more events arrived while we were processing, trigger again
      if (this.eventQueue.length > 0) {
        setTimeout(() => {
          this.processQueue().catch(err => console.error(err));
        }, 50);
      }
    }
  }
}
