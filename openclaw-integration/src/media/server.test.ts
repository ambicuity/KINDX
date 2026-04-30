import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let MEDIA_DIR = "";
const cleanOldMedia = vi.fn().mockResolvedValue(undefined);

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    getMediaDir: () => MEDIA_DIR,
    cleanOldMedia,
  };
});

const { createMediaGetHandler } = await import("./server.js");
const { MEDIA_MAX_BYTES } = await import("./store.js");

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body?: Buffer | string;
  setHeader: (key: string, value: string) => void;
  type: (value: string) => MockRes;
  status: (code: number) => MockRes;
  send: (body: Buffer | string) => void;
  on: (event: string, cb: () => void) => void;
};

function createMockRes(): MockRes {
  const headers: Record<string, string> = {};
  const finishHandlers: Array<() => void> = [];
  let finished = false;
  return {
    statusCode: 200,
    headers,
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
    },
    type(value) {
      headers["content-type"] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      finished = true;
      for (const cb of finishHandlers) {
        cb();
      }
    },
    on(event, cb) {
      if (event === "finish") {
        if (finished) {
          cb();
          return;
        }
        finishHandlers.push(cb);
      }
    },
  };
}

async function waitForFileRemoval(filePath: string, maxTicks = 1000) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    try {
      await fs.stat(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${filePath} removal`);
}

describe("media server", () => {
  const handler = () => createMediaGetHandler({ mediaDir: MEDIA_DIR, ttlMs: 1_000 });

  async function writeMediaFile(id: string, contents: string) {
    const filePath = path.join(MEDIA_DIR, id);
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  async function invoke(id: string) {
    const req = { params: { id } } as const;
    const res = createMockRes();
    await handler()(req, res as never);
    return res;
  }

  beforeAll(async () => {
    MEDIA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-test-"));
  });

  afterAll(async () => {
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
    MEDIA_DIR = "";
  });

  it("serves media and cleans up after send", async () => {
    const file = await writeMediaFile("file1", "hello");
    const res = await invoke("file1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.body)).toBe("hello");
    await waitForFileRemoval(file);
  });

  it("expires old media", async () => {
    const file = await writeMediaFile("old", "stale");
    const past = Date.now() - 10_000;
    await fs.utimes(file, past / 1000, past / 1000);
    const res = await invoke("old");
    expect(res.statusCode).toBe(410);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it.each([
    {
      testName: "blocks path traversal attempts",
      mediaPath: "%2e%2e%2fpackage.json",
    },
    {
      testName: "rejects invalid media ids",
      mediaPath: "invalid%20id",
      setup: async () => {
        await writeMediaFile("file2", "hello");
      },
    },
    {
      testName: "blocks symlink escaping outside media dir",
      mediaPath: "link-out",
      setup: async () => {
        const target = path.join(process.cwd(), "package.json");
        const link = path.join(MEDIA_DIR, "link-out");
        await fs.symlink(target, link);
      },
    },
  ] as const)("$testName", async (testCase) => {
    await testCase.setup?.();
    const res = await invoke(testCase.mediaPath);
    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toBe("invalid path");
  });

  it("rejects oversized media files", async () => {
    const file = await writeMediaFile("big", "");
    await fs.truncate(file, MEDIA_MAX_BYTES + 1);
    const res = await invoke("big");
    expect(res.statusCode).toBe(413);
    expect(String(res.body)).toBe("too large");
  });

  it("returns not found for missing media IDs", async () => {
    const res = await invoke("missing-file");
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.body)).toBe("not found");
  });

  it("returns 404 when route param is missing (dot path)", async () => {
    const res = await invoke(".");
    expect(res.statusCode).toBe(400);
  });

  it("rejects overlong media id", async () => {
    const res = await invoke(`${"a".repeat(201)}.txt`);
    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toBe("invalid path");
  });
});
