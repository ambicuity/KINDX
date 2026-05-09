import { describe, expect, test } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { atomicWriteFile, type AtomicWriteOps } from "../engine/utils/atomic-write.js";

describe("atomicWriteFile", () => {
  test("writes content to destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "file.txt");
      atomicWriteFile(path, "hello world");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("hello world");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("respects mode parameter for secret files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "secret.txt");
      atomicWriteFile(path, "secret", { mode: 0o600 });
      const s = await stat(path);
      // Mode bits: lower 9 bits are perms; we only care about owner-only.
      const perms = s.mode & 0o777;
      expect(perms).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates parent directory by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "nested", "subdir", "file.txt");
      atomicWriteFile(path, "x");
      expect(existsSync(path)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("performs syscalls in order: open -> write -> fsync(file) -> close -> rename -> open(dir) -> fsync(dir) -> close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "ordered.txt");
      const calls: string[] = [];
      const ops: Partial<AtomicWriteOps> = {
        openSync: ((p: string, flags: string, mode?: number) => {
          calls.push(`open:${flags}${mode !== undefined ? `:${mode.toString(8)}` : ""}`);
          return p === dir ? 99 : 7;
        }) as any,
        writeSync: ((fd: number) => {
          calls.push(`write:${fd}`);
          return 0;
        }) as any,
        fsyncSync: ((fd: number) => { calls.push(`fsync:${fd}`); }) as any,
        closeSync: ((fd: number) => { calls.push(`close:${fd}`); }) as any,
        renameSync: ((from: string, to: string) => {
          calls.push(`rename:${from === path ? "(dest)" : "(tmp)"}->${to === path ? "(dest)" : "(other)"}`);
        }) as any,
      };
      atomicWriteFile(path, "data", { mode: 0o644, ops });
      expect(calls).toEqual([
        "open:w:644",
        "write:7",
        "fsync:7",
        "close:7",
        "rename:(tmp)->(dest)",
        "open:r",
        "fsync:99",
        "close:99",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans up temp file when rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "willfail.txt");
      let unlinkedTmp: string | null = null;
      const ops: Partial<AtomicWriteOps> = {
        renameSync: () => { throw new Error("boom"); },
        unlinkSync: ((p: string) => { unlinkedTmp = p; }) as any,
      };
      expect(() => atomicWriteFile(path, "data", { ops })).toThrow(/boom/);
      expect(unlinkedTmp).toMatch(/\.tmp\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("temp filename varies between concurrent writers (no collision)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "shared.txt");
      const seen: string[] = [];
      // Capture the temp path as it is opened, before rename hides it.
      const ops: Partial<AtomicWriteOps> = {
        openSync: ((p: string, flags: string, mode?: number) => {
          if (flags === "w") seen.push(p);
          return require("node:fs").openSync(p, flags, mode);
        }) as any,
      };
      atomicWriteFile(path, "a", { ops });
      atomicWriteFile(path, "b", { ops });
      atomicWriteFile(path, "c", { ops });
      expect(new Set(seen).size).toBe(3);
      // All three temps should have been removed by rename.
      const remaining = readdirSync(dir).filter(n => n.includes(".tmp."));
      expect(remaining).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("survives directory fsync failure (degrades silently)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-atomic-"));
    try {
      const path = join(dir, "nodirsync.txt");
      // Intercept only the dir-fsync call.
      const realFs = await import("node:fs");
      const ops: Partial<AtomicWriteOps> = {
        fsyncSync: ((fd: number) => {
          // Distinguish dir fd by trying the real fsync first; if it's the file
          // we let it through, if it throws on the directory we swallow.
          try { realFs.fsyncSync(fd); } catch (e) {
            if (typeof fd === "number" && fd > 0) throw new Error("dir-fsync-failed");
          }
        }) as any,
      };
      // Even if dir fsync throws, the file content must still be on disk.
      expect(() => atomicWriteFile(path, "ok", { ops })).not.toThrow();
      const content = await readFile(path, "utf-8");
      expect(content).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
