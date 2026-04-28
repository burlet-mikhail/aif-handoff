import { Hono } from "hono";
import { getEnv, logger } from "@aif/shared";

const log = logger("api:codex-auth");

export const codexAuthRouter = new Hono();

function brokerBaseUrl(): string {
  const env = getEnv();
  return env.AGENT_INTERNAL_URL.replace(/\/$/, "");
}

async function proxy(
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: unknown }> {
  const target = `${brokerBaseUrl()}${path}`;
  log.debug({ method, target }, "[CodexAuth.proxy] forwarding");
  try {
    const res = await fetch(target, { method });
    const data: unknown = await res.json().catch(() => ({}));
    log.debug({ status: res.status, target }, "[CodexAuth.proxy] response");
    return { status: res.status, body: data };
  } catch (err) {
    log.error({ err, target }, "[CodexAuth.proxy] broker unreachable");
    return {
      status: 502,
      body: { error: "broker_unreachable", message: String(err) },
    };
  }
}

codexAuthRouter.get("/login/status", async (c) => {
  log.debug("[CodexAuth.status] enter");
  const { status, body } = await proxy("GET", "/codex/login/status");
  return c.json(body as object, status as 200 | 502);
});

codexAuthRouter.post("/login/start", async (c) => {
  log.debug("[CodexAuth.start] enter");
  const { status, body } = await proxy("POST", "/codex/login/start");
  return c.json(body as object, status as 200 | 409 | 500 | 502);
});

codexAuthRouter.post("/login/cancel", async (c) => {
  log.debug("[CodexAuth.cancel] enter");
  const { status, body } = await proxy("POST", "/codex/login/cancel");
  return c.json(body as object, status as 200 | 502);
});

codexAuthRouter.get("/capabilities", (c) => {
  const env = getEnv();
  return c.json({ loginProxyEnabled: env.AIF_ENABLE_CODEX_LOGIN_PROXY });
});
