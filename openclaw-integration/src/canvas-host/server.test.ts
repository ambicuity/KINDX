import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH, injectCanvasLiveReload } from "./a2ui.js";
import { handleA2uiHttpRequest } from "./a2ui.js";
import { createCanvasHostHandler } from "./server.js";

const chokidarMockState = vi.hoisted(() => ({
  watchers: [] as Array<{
    on: (event: string, cb: (...args: unknown[]) => void) => unknown;
    close: () => Promise<void>;
    __emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

vi.mock("chokidar", () => {
  const createWatcher = () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const api = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
        return api;
      },
      close: async () => {},
      __emit: (event: string, ...args: unknown[]) => {
        for (const cb of handlers.get(event) ?? []) {
          cb(...args);
        }
      },
    };
    chokidarMockState.watchers.push(api);
    return api;
  };

  const watch = () => createWatcher();
  return {
    default: { watch },
    watch,
  };
});

type MockReq = { url: string; method?: string; headers?: Record<string, string> };
type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (key: string, value: string) => void;
  end: (body?: string | Buffer) => void;
};

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body ? String(body) : "";
    },
  };
}

async function invokeCanvas(
  handler: Awaited<ReturnType<typeof createCanvasHostHandler>>,
  url: string,
) {
  const req: MockReq = { url, method: "GET", headers: {} };
  const res = createMockRes();
  const handled = await handler.handleHttpRequest(req as never, res as never);
  return { handled, res };
}

describe("canvas host", () => {
  const quietRuntime = {
    log: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
  };
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async () => {
    const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("injects live reload script", () => {
    const out = injectCanvasLiveReload("<html><body>Hello</body></html>");
    expect(out).toContain(CANVAS_WS_PATH);
    expect(out).toContain("location.reload");
    expect(out).toContain("openclawCanvasA2UIAction");
    expect(out).toContain("openclawSendUserAction");
  });

  it("creates a default index.html when missing", async () => {
    const dir = await createCaseDir();
    const handler = await createCanvasHostHandler({
      runtime: quietRuntime as never,
      rootDir: dir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
    });

    try {
      const { handled, res } = await invokeCanvas(handler, `${CANVAS_HOST_PATH}/`);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Interactive test page");
      expect(res.body).toContain("openclawSendUserAction");
      expect(res.body).toContain(CANVAS_WS_PATH);
    } finally {
      await handler.close();
    }
  });

  it("skips live reload injection when disabled", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>no-reload</body></html>", "utf8");

    const handler = await createCanvasHostHandler({
      runtime: quietRuntime as never,
      rootDir: dir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
      liveReload: false,
    });

    try {
      const { res } = await invokeCanvas(handler, `${CANVAS_HOST_PATH}/`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("no-reload");
      expect(res.body).not.toContain(CANVAS_WS_PATH);
    } finally {
      await handler.close();
    }
  });

  it("serves canvas content from mounted base path and rejects root path", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>v1</body></html>", "utf8");

    const handler = await createCanvasHostHandler({
      runtime: quietRuntime as never,
      rootDir: dir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
    });

    try {
      const hit = await invokeCanvas(handler, `${CANVAS_HOST_PATH}/`);
      expect(hit.handled).toBe(true);
      expect(hit.res.statusCode).toBe(200);
      expect(hit.res.body).toContain("v1");
      const miss = await invokeCanvas(handler, "/");
      expect(miss.handled).toBe(false);
    } finally {
      await handler.close();
    }
  });

  it("serves A2UI scaffold and blocks traversal/symlink escapes", async () => {
    const a2uiRoot = path.resolve(process.cwd(), "src/canvas-host/a2ui");
    const bundlePath = path.join(a2uiRoot, "a2ui.bundle.js");
    const linkName = `test-link-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    const linkPath = path.join(a2uiRoot, linkName);
    let createdBundle = false;
    let createdLink = false;

    try {
      try {
        await fs.stat(bundlePath);
      } catch {
        await fs.writeFile(bundlePath, "window.openclawA2UI = {};", "utf8");
        createdBundle = true;
      }

      await fs.symlink(path.join(process.cwd(), "package.json"), linkPath);
      createdLink = true;

      const rootRes = createMockRes();
      const rootHandled = await handleA2uiHttpRequest(
        { url: "/__openclaw__/a2ui/", method: "GET" } as never,
        rootRes as never,
      );
      expect(rootHandled).toBe(true);
      expect(rootRes.statusCode).toBe(200);
      expect(rootRes.body).toContain("openclaw-a2ui-host");

      const traversalRes = createMockRes();
      await handleA2uiHttpRequest(
        { url: `${A2UI_PATH}/%2e%2e%2fpackage.json`, method: "GET" } as never,
        traversalRes as never,
      );
      expect(traversalRes.statusCode).toBe(404);
      expect(traversalRes.body).toBe("not found");

      const symlinkRes = createMockRes();
      await handleA2uiHttpRequest(
        { url: `${A2UI_PATH}/${linkName}`, method: "GET" } as never,
        symlinkRes as never,
      );
      expect(symlinkRes.statusCode).toBe(404);
      expect(symlinkRes.body).toBe("not found");
    } finally {
      if (createdLink) {
        await fs.rm(linkPath, { force: true });
      }
      if (createdBundle) {
        await fs.rm(bundlePath, { force: true });
      }
    }
  });
});
