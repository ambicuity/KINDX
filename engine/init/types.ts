export interface DetectResult {
  configPath: string;
  exists: boolean;
  alreadyWired: boolean;
}

export interface WriteResult {
  configPath: string;
  backupPath?: string;
  outcome: "created" | "updated" | "skipped";
  reason?: string;
}

export interface Adapter {
  name: string;
  label: string;
  detect(): DetectResult;
  write(opts: { force: boolean; dryRun: boolean; command: string; args: string[] }): WriteResult;
}

export interface InitOptions {
  clients: string[];
  projectPath?: string;
  globalOnly: boolean;
  dryRun: boolean;
  force: boolean;
}
