import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { codexAuthRouter } = await import("../routes/codexAuth.js");

function createApp() {
  const app = new Hono();
  app.route("/codex-auth", codexAuthRouter);
  return app;
}

describe("codexAuthRouter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies login status requests to the broker", async () => {
    const app = createApp();
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: vi.fn().mockResolvedValue({
        active: true,
        sessionId: "s1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-12345",
        startedAt: "2026-04-27T00:00:00.000Z",
      }),
    } as unknown as Response);

    const res = await app.request("/codex-auth/login/status");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { verificationUrl: string; userCode: string };
    expect(body.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(body.userCode).toBe("ABCD-12345");
    expect(fetchMock).toHaveBeenCalledWith("http://agent:3010/codex/login/status", {
      method: "GET",
    });
  });

  it("returns broker_unreachable when login start proxy call fails", async () => {
    const app = createApp();
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.request("/codex-auth/login/start", { method: "POST" });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: "broker_unreachable" }),
    );
  });

  it("forwards login start to broker and returns device-auth payload", async () => {
    const app = createApp();
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: vi.fn().mockResolvedValue({
        sessionId: "s2",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "WXYZ-78901",
        startedAt: "2026-04-27T00:00:00.000Z",
      }),
    } as unknown as Response);

    const res = await app.request("/codex-auth/login/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { verificationUrl: string; userCode: string };
    expect(body.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(body.userCode).toBe("WXYZ-78901");
    expect(fetchMock).toHaveBeenCalledWith("http://agent:3010/codex/login/start", {
      method: "POST",
    });
  });

  it("returns 404 for the removed callback route", async () => {
    const app = createApp();

    const res = await app.request("/codex-auth/login/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://localhost/" }),
    });

    expect(res.status).toBe(404);
  });

  it("reports login-proxy capabilities from environment defaults", async () => {
    const app = createApp();

    const res = await app.request("/codex-auth/capabilities");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ loginProxyEnabled: false });
  });
});
