import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { logger } from "@aif/shared";

const log = logger("codex-login-broker");

const DEFAULT_PORT = 3010;
const DEFAULT_HOST = "0.0.0.0";

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const VERIFICATION_URL = "https://auth.openai.com/codex/device";
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;
const USER_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/;
const USER_CODE_PATTERN_GLOBAL = /\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/g;
const REDACTED_CODE = "***-*****";
const LOG_CHUNK_LIMIT = 200;

export type TerminalReason =
  | "success"
  | "exit_nonzero"
  | "signal"
  | "timeout"
  | "parse_timeout"
  | "cancel"
  | "spawn_failed";

/**
 * Reject reason carried out of the parse-output promise so the start handler
 * can record a precise terminal result. Plain `Error.message` matching would
 * collapse the failure modes (async spawn error vs early exit vs no-output
 * timeout) into one bucket.
 */
class DeviceAuthParseError extends Error {
  constructor(
    public readonly reason: Extract<
      TerminalReason,
      "exit_nonzero" | "spawn_failed" | "parse_timeout"
    >,
    message: string,
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "DeviceAuthParseError";
  }
}

export interface TerminalResult {
  ok: boolean;
  sessionId: string;
  finishedAt: number;
  reason: TerminalReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface DeviceAuthInfo {
  verificationUrl: string;
  userCode: string;
}

export interface LoginSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  verificationUrl: string;
  userCode: string;
  startedAt: number;
  timeoutHandle: NodeJS.Timeout;
}

export interface BrokerRuntime {
  app: Hono;
  /** Internal accessor for tests */
  getCurrentSession(): LoginSession | null;
  /** Internal accessor for tests */
  getLastResult(): TerminalResult | null;
}

export interface BrokerServer {
  runtime: BrokerRuntime;
  server: ServerType;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface BrokerOptions {
  port?: number;
  host?: string;
  codexCliPath?: string;
  /** Override spawn for tests */
  spawnFn?: typeof spawn;
}

interface BrokerContext {
  currentSession: LoginSession | null;
  lastResult: TerminalResult | null;
  options: Required<Omit<BrokerOptions, "spawnFn">> & {
    spawnFn: typeof spawn;
  };
}

/**
 * Extract verification URL and one-time code from `codex login --device-auth`
 * stdout. The CLI prints a fixed verification URL and a code like
 * `XXXX-YYYYY`. ANSI escape codes are stripped before matching. Both fields
 * must be present for a successful parse — partial output returns null.
 */
export function extractDeviceAuth(buffered: string): DeviceAuthInfo | null {
  const cleaned = buffered.replace(ANSI_PATTERN, "");
  if (!cleaned.includes(VERIFICATION_URL)) return null;
  const codeMatch = USER_CODE_PATTERN.exec(cleaned);
  if (!codeMatch) return null;
  return { verificationUrl: VERIFICATION_URL, userCode: codeMatch[0] };
}

/** Mask all but the last 2 characters of the one-time code for logging. */
export function maskUserCode(code: string): string {
  if (code.length <= 2) return "***";
  return `${"*".repeat(code.length - 2)}${code.slice(-2)}`;
}

/**
 * Redact every device-code-shaped token from a raw stdout/stderr chunk before
 * it is written to the logger. Without this, DEBUG-level chunk logs would
 * leak the exact one-time code printed by the codex CLI.
 */
export function redactChunkForLog(text: string): string {
  return text.replace(USER_CODE_PATTERN_GLOBAL, REDACTED_CODE).slice(0, LOG_CHUNK_LIMIT);
}

function recordTerminalResult(ctx: BrokerContext, result: TerminalResult): void {
  ctx.lastResult = result;
  log.info(
    {
      sessionId: result.sessionId,
      ok: result.ok,
      reason: result.reason,
      exitCode: result.exitCode,
      signal: result.signal,
    },
    "[Broker.terminalResult] session ended",
  );
}

function terminateSession(
  ctx: BrokerContext,
  reason: Extract<TerminalReason, "timeout" | "cancel">,
): void {
  const session = ctx.currentSession;
  if (!session) return;
  log.info({ sessionId: session.id, reason }, "[Broker.terminateSession] ending session");
  clearTimeout(session.timeoutHandle);
  if (!session.child.killed) {
    try {
      session.child.kill("SIGTERM");
    } catch (err) {
      log.warn({ err }, "[Broker.terminateSession] failed to kill child");
    }
  }
  recordTerminalResult(ctx, {
    ok: false,
    sessionId: session.id,
    finishedAt: Date.now(),
    reason,
    exitCode: null,
    signal: null,
  });
  ctx.currentSession = null;
}

function classifyExit(code: number | null, signal: NodeJS.Signals | null): TerminalReason {
  if (signal !== null) return "signal";
  if (code === 0) return "success";
  return "exit_nonzero";
}

function createBrokerApp(ctx: BrokerContext): Hono {
  const app = new Hono();

  app.get("/codex/login/status", (c) => {
    log.debug("[Broker.status] enter");
    const session = ctx.currentSession;
    if (session) {
      return c.json({
        active: true,
        sessionId: session.id,
        verificationUrl: session.verificationUrl,
        userCode: session.userCode,
        startedAt: new Date(session.startedAt).toISOString(),
      });
    }
    if (ctx.lastResult) {
      return c.json({
        active: false,
        lastResult: {
          ok: ctx.lastResult.ok,
          sessionId: ctx.lastResult.sessionId,
          reason: ctx.lastResult.reason,
          exitCode: ctx.lastResult.exitCode,
          signal: ctx.lastResult.signal,
          finishedAt: new Date(ctx.lastResult.finishedAt).toISOString(),
        },
      });
    }
    return c.json({ active: false });
  });

  app.post("/codex/login/start", async (c) => {
    log.debug("[Broker.start] enter");

    if (ctx.currentSession) {
      log.warn(
        { sessionId: ctx.currentSession.id },
        "[Broker.start] rejected — session already active",
      );
      return c.json(
        {
          error: "session_already_active",
          sessionId: ctx.currentSession.id,
          verificationUrl: ctx.currentSession.verificationUrl,
          userCode: ctx.currentSession.userCode,
        },
        409,
      );
    }

    // Each new start clears the previous terminal result so /status during
    // the new run reflects only the current session.
    ctx.lastResult = null;

    const cliPath = ctx.options.codexCliPath;
    log.debug({ cliPath }, "[Broker.start] spawning codex login --device-auth");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = ctx.options.spawnFn(cliPath, ["login", "--device-auth"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      log.error({ err }, "[Broker.start] spawn failed");
      recordTerminalResult(ctx, {
        ok: false,
        sessionId: randomUUID(),
        finishedAt: Date.now(),
        reason: "spawn_failed",
        exitCode: null,
        signal: null,
      });
      return c.json({ error: "spawn_failed", message: String(err) }, 500);
    }

    const sessionId = randomUUID();
    const startedAt = Date.now();

    const parsePromise = new Promise<DeviceAuthInfo>((resolve, reject) => {
      let settled = false;
      let buffered = "";

      const tryParse = () => {
        const info = extractDeviceAuth(buffered);
        if (info && !settled) {
          settled = true;
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          resolve(info);
        }
      };
      const onData = (data: Buffer) => {
        const text = data.toString("utf8");
        buffered += text;
        log.debug({ chunk: redactChunkForLog(text) }, "[Broker.start] codex stdout");
        tryParse();
      };
      const onStderr = (data: Buffer) => {
        const text = data.toString("utf8");
        log.debug({ chunk: redactChunkForLog(text) }, "[Broker.start] codex stderr");
        buffered += text;
        tryParse();
      };
      const onExit = (code: number | null) => {
        if (!settled) {
          settled = true;
          reject(
            new DeviceAuthParseError(
              "exit_nonzero",
              `codex exited before printing device auth (code=${code})`,
              code,
            ),
          );
        }
      };
      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          // `error` events on a spawned child usually mean the binary could
          // not be launched (ENOENT, EACCES, etc.) — surface that as
          // spawn_failed rather than collapsing it into exit_nonzero.
          reject(new DeviceAuthParseError("spawn_failed", err.message));
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onStderr);
      child.once("exit", onExit);
      child.once("error", onError);

      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          reject(
            new DeviceAuthParseError(
              "parse_timeout",
              "timed out waiting for codex device auth output",
            ),
          );
        }
      }, 15_000).unref();
    });

    let info: DeviceAuthInfo;
    try {
      info = await parsePromise;
    } catch (err) {
      log.error({ err }, "[Broker.start] failed to parse device auth output");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      const parseErr = err instanceof DeviceAuthParseError ? err : null;
      recordTerminalResult(ctx, {
        ok: false,
        sessionId,
        finishedAt: Date.now(),
        reason: parseErr?.reason ?? "exit_nonzero",
        exitCode: parseErr?.exitCode ?? child.exitCode,
        signal: null,
      });
      return c.json({ error: "device_auth_parse_failed", message: String(err) }, 500);
    }

    log.debug({ userCodeMasked: maskUserCode(info.userCode) }, "[Broker.start] device auth parsed");

    const timeoutHandle = setTimeout(() => {
      log.warn({ sessionId }, "[Broker.start] session timed out");
      terminateSession(ctx, "timeout");
    }, SESSION_TIMEOUT_MS);
    timeoutHandle.unref();

    const session: LoginSession = {
      id: sessionId,
      child,
      verificationUrl: info.verificationUrl,
      userCode: info.userCode,
      startedAt,
      timeoutHandle,
    };

    child.once("exit", (code, signal) => {
      log.info({ sessionId, code, signal }, "[Broker.childExit] codex exited");
      // If the session was already cleared by terminateSession (cancel/timeout)
      // we keep that terminal result — terminateSession recorded the reason
      // before signalling the child.
      if (ctx.currentSession?.id !== sessionId) return;
      clearTimeout(session.timeoutHandle);
      const reason = classifyExit(code, signal);
      recordTerminalResult(ctx, {
        ok: reason === "success",
        sessionId,
        finishedAt: Date.now(),
        reason,
        exitCode: code,
        signal,
      });
      ctx.currentSession = null;
    });

    ctx.currentSession = session;
    log.info(
      { sessionId, userCodeMasked: maskUserCode(info.userCode) },
      "[Broker.start] session started",
    );
    return c.json({
      sessionId,
      verificationUrl: info.verificationUrl,
      userCode: info.userCode,
      startedAt: new Date(startedAt).toISOString(),
    });
  });

  app.post("/codex/login/cancel", (c) => {
    log.debug("[Broker.cancel] enter");
    const session = ctx.currentSession;
    if (!session) return c.json({ ok: true, cancelled: false });
    terminateSession(ctx, "cancel");
    return c.json({ ok: true, cancelled: true, sessionId: session.id });
  });

  return app;
}

export function createBrokerRuntime(options: BrokerOptions = {}): BrokerRuntime {
  const ctx: BrokerContext = {
    currentSession: null,
    lastResult: null,
    options: {
      port: options.port ?? DEFAULT_PORT,
      host: options.host ?? DEFAULT_HOST,
      codexCliPath: options.codexCliPath ?? "codex",
      spawnFn: options.spawnFn ?? spawn,
    },
  };

  const app = createBrokerApp(ctx);
  return {
    app,
    getCurrentSession: () => ctx.currentSession,
    getLastResult: () => ctx.lastResult,
  };
}

export async function startLoginBroker(options: BrokerOptions = {}): Promise<BrokerServer> {
  const runtime = createBrokerRuntime(options);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  const server = serve({ fetch: runtime.app.fetch, port, hostname: host });
  log.info({ host, port }, "[CodexLoginBroker] listening");

  return {
    runtime,
    server,
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
