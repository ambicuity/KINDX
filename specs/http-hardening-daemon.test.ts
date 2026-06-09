import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setupDaemon, type DaemonHandle } from "./helpers/http-daemon.js";

describe("daemon helper smoke", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon(); });
  afterAll(async () => { await h.stop(); });

  test("GET /health returns 200 with ok status", async () => {
    const res = await h.fetch("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});
