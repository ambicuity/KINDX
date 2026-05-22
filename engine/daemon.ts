import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DaemonConfig {
  socketPath: string;
  pidPath: string;
  preload: boolean;
}

export class DaemonManager {
  private config: DaemonConfig;
  private running = false;

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    writeFileSync(this.config.pidPath, String(process.pid), "utf-8");
    this.running = true;

    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (existsSync(this.config.pidPath)) {
      unlinkSync(this.config.pidPath);
    }
  }

  isRunning(): boolean {
    if (!this.running) return false;

    if (!existsSync(this.config.pidPath)) {
      this.running = false;
      return false;
    }

    try {
      const pid = parseInt(readFileSync(this.config.pidPath, "utf-8").trim());
      process.kill(pid, 0);
      return true;
    } catch {
      this.running = false;
      return false;
    }
  }
}

export function getDefaultDaemonConfig(): DaemonConfig {
  const cacheDir = join(homedir(), ".cache", "kindx");
  return {
    socketPath: join(cacheDir, "daemon.sock"),
    pidPath: join(cacheDir, "daemon.pid"),
    preload: false,
  };
}
