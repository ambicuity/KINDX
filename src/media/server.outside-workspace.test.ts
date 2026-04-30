import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";
import { createMediaGetHandler } from "./server.js";

let mediaDir = "";

type MockRes = {
  statusCode: number;
  body?: string;
  setHeader: (_key: string, _value: string) => void;
  status: (code: number) => MockRes;
  send: (body: string) => void;
  on: (_event: string, _cb: () => void) => void;
};

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    setHeader: () => {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
    on: () => {},
  };
}

describe("media server outside-workspace mapping", () => {
  beforeAll(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-outside-workspace-"));
  });

  afterAll(async () => {
    await fs.rm(mediaDir, { recursive: true, force: true });
    mediaDir = "";
    vi.restoreAllMocks();
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    vi.spyOn(fsSafe, "readFileWithinRoot").mockRejectedValueOnce(
      new fsSafe.SafeOpenError("outside-workspace", "file is outside workspace root"),
    );

    const handler = createMediaGetHandler({ mediaDir, ttlMs: 1_000 });
    const req = { params: { id: "ok-id" } };
    const res = createMockRes();
    await handler(req, res as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("file is outside workspace root");
  });
});
