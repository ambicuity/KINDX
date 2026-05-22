import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DaemonManager, type DaemonConfig } from "../engine/daemon.js";
import { existsSync, unlinkSync } from "node:fs";

describe("DaemonManager", () => {
  const testSocketPath = "/tmp/kindx-test-daemon.sock";
  const testPidPath = "/tmp/kindx-test-daemon.pid";

  afterEach(() => {
    if (existsSync(testSocketPath)) unlinkSync(testSocketPath);
    if (existsSync(testPidPath)) unlinkSync(testPidPath);
  });

  it("should create PID file on start", async () => {
    const manager = new DaemonManager({
      socketPath: testSocketPath,
      pidPath: testPidPath,
      preload: false,
    });

    await manager.start();
    expect(existsSync(testPidPath)).toBe(true);
    await manager.stop();
  });

  it("should check if daemon is running", async () => {
    const manager = new DaemonManager({
      socketPath: testSocketPath,
      pidPath: testPidPath,
      preload: false,
    });

    expect(manager.isRunning()).toBe(false);
    await manager.start();
    expect(manager.isRunning()).toBe(true);
    await manager.stop();
  });
});
