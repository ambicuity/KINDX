import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithTimeout, FetchTimeoutError } from "../engine/utils/fetch-with-timeout.js";

let server: Server;
let baseUrl: string;
const sockets = new Set<import("node:net").Socket>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const delayMs = Number(url.searchParams.get("delay") ?? "0");
    if (delayMs <= 0) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    // Hold the response open — simulates a hung upstream.
    setTimeout(() => {
      try {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      } catch { /* response may have been cancelled */ }
    }, delayMs);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchWithTimeout", () => {
  test("returns response when server replies before timeout", async () => {
    const res = await fetchWithTimeout(`${baseUrl}/`, { timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("throws FetchTimeoutError when server never replies", async () => {
    // 5s server delay, 100ms timeout -> must time out.
    await expect(
      fetchWithTimeout(`${baseUrl}/?delay=5000`, { timeoutMs: 100 })
    ).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  test("FetchTimeoutError carries url and timeoutMs", async () => {
    try {
      await fetchWithTimeout(`${baseUrl}/?delay=5000`, { timeoutMs: 50 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FetchTimeoutError);
      const tErr = err as FetchTimeoutError;
      expect(tErr.timeoutMs).toBe(50);
      expect(tErr.url).toContain(baseUrl);
    }
  });

  test("propagates caller AbortSignal abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("user-cancelled")), 50);
    await expect(
      fetchWithTimeout(`${baseUrl}/?delay=5000`, { timeoutMs: 10000, signal: ac.signal })
    ).rejects.toThrow(/user-cancelled/);
  });

  test("rejects immediately when caller signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("preempted"));
    await expect(
      fetchWithTimeout(`${baseUrl}/`, { signal: ac.signal })
    ).rejects.toThrow(/preempted/);
  });
});
