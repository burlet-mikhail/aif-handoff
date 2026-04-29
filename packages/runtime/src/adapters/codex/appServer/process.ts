import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { RuntimeTransport } from "../../../types.js";
import { buildSafeWindowsShellCommandLine } from "../../../shellSafety.js";

const IS_WINDOWS = process.platform === "win32";
const moduleRequire = createRequire(import.meta.url);
const CODEX_SDK_NPM_NAME = "@openai/codex-sdk";
const CODEX_NPM_NAME = "@openai/codex";

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

const ALLOWED_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_ENV",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const ALLOWED_ENV_PREFIXES = ["OPENAI_", "CODEX_", "AIF_", "HANDOFF_", "LC_", "XDG_"];

const BLOCKED_ENV_KEYS = new Set(["OPENAI_BASE_URL", "NODE_OPTIONS"]);

const DEFAULT_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 500;
const MAX_STDERR_TAIL_LINES = 50;

export interface CodexAppServerLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface CodexAppServerLaunchInput {
  runtimeId: string;
  profileId?: string | null;
  transport?: RuntimeTransport;
  options?: Record<string, unknown>;
  projectRoot?: string;
  cwd?: string;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrl?: string | null;
}

export interface CodexAppServerEnvironmentStats {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
}

export interface CodexAppServerProcessContext {
  process: ChildProcessWithoutNullStreams;
  stderrTail: string[];
  executablePath: string;
  args: string[];
  cwd?: string;
}

export interface CodexAppServerSpawnOptions {
  input: CodexAppServerLaunchInput;
  logger?: CodexAppServerLogger;
}

export function resolveCodexAppServerExecutable(input: CodexAppServerLaunchInput): string {
  const options = asRecord(input.options);
  const configuredCliPath =
    readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH);

  if (configuredCliPath) {
    return configuredCliPath;
  }

  if ((input.transport ?? RuntimeTransport.CLI) === RuntimeTransport.SDK) {
    return findBundledCodexBinary();
  }

  return "codex";
}

export function buildCodexAppServerEnv(input: CodexAppServerLaunchInput): Record<string, string> {
  return buildCodexAppServerEnvWithStats(input).env;
}

export function buildCodexAppServerEnvWithStats(
  input: CodexAppServerLaunchInput,
): CodexAppServerEnvironmentStats {
  const env: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  let blockedCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();

  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (BLOCKED_ENV_KEYS.has(key)) {
      blockedCount += 1;
      continue;
    }
    if (isAllowedEnvironmentKey(key)) {
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    filteredCount += 1;
    if (key.startsWith("npm_")) {
      droppedDisallowedPrefixKeys.add(key);
    }
  }

  const options = asRecord(input.options);
  const apiKeyEnvVar =
    readString(input.apiKeyEnvVar) ?? readString(options.apiKeyEnvVar) ?? "OPENAI_API_KEY";
  const apiKey =
    readString(input.apiKey) ??
    readString(options.apiKey) ??
    readString(process.env[apiKeyEnvVar]) ??
    readString(process.env.OPENAI_API_KEY);
  if (apiKey) {
    env[apiKeyEnvVar] = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  const baseUrl =
    readString(input.baseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    env.CODEX_BASE_URL = baseUrl;
  }

  // Windows env vars are case-insensitive; mirror proxy key casing to avoid
  // losing one variant when a parent process forwarded only uppercase/lowercase.
  mirrorEnvPair(env, "HTTP_PROXY", "http_proxy");
  mirrorEnvPair(env, "HTTPS_PROXY", "https_proxy");
  mirrorEnvPair(env, "NO_PROXY", "no_proxy");

  return {
    env,
    forwardedCount,
    filteredCount,
    blockedCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

export function spawnCodexAppServerProcess(
  options: CodexAppServerSpawnOptions,
): CodexAppServerProcessContext {
  const transport = options.input.transport ?? RuntimeTransport.CLI;
  const executablePath = resolveCodexAppServerExecutable(options.input);
  const envStats = buildCodexAppServerEnvWithStats(options.input);
  const cwd = options.input.cwd ?? options.input.projectRoot;
  const args = ["app-server"];

  options.logger?.debug?.(
    {
      runtimeId: options.input.runtimeId,
      profileId: options.input.profileId ?? null,
      transport,
      executablePath,
      cwd: cwd ?? null,
      forwardedEnvCount: envStats.forwardedCount,
      filteredEnvCount: envStats.filteredCount,
      blockedEnvCount: envStats.blockedCount,
      droppedDisallowedPrefixCount: envStats.droppedDisallowedPrefixKeys.length,
      optionKeys: Object.keys(asRecord(options.input.options)),
    },
    "DEBUG [runtime:codex] Starting Codex app-server process over stdio",
  );

  if (envStats.droppedDisallowedPrefixKeys.length > 0) {
    options.logger?.warn?.(
      {
        runtimeId: options.input.runtimeId,
        profileId: options.input.profileId ?? null,
        transport,
        droppedDisallowedPrefixKeys: envStats.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building Codex app-server environment",
    );
  }

  const childProcess =
    IS_WINDOWS && !executablePath.toLowerCase().endsWith(".exe")
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", buildWindowsAppServerCommandLine(executablePath, args)],
          {
            cwd,
            env: envStats.env,
            stdio: "pipe",
            windowsVerbatimArguments: true,
          },
        )
      : spawn(executablePath, args, {
          cwd,
          env: envStats.env,
          stdio: "pipe",
        });

  const stderrTail: string[] = [];
  childProcess.stderr.on("data", (chunk: Buffer | string) => {
    stderrTail.push(String(chunk));
    while (stderrTail.length > MAX_STDERR_TAIL_LINES) {
      stderrTail.shift();
    }
  });

  return {
    process: childProcess,
    stderrTail,
    executablePath,
    args,
    cwd,
  };
}

export async function terminateCodexAppServerProcess(
  context: CodexAppServerProcessContext,
  logger?: CodexAppServerLogger,
  terminateTimeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
  forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
): Promise<void> {
  if (hasProcessExited(context.process)) {
    return;
  }

  logger?.debug?.(
    {
      executablePath: context.executablePath,
      cwd: context.cwd ?? null,
      terminateTimeoutMs,
    },
    "DEBUG [runtime:codex] Terminating Codex app-server process",
  );

  try {
    context.process.kill("SIGTERM");
  } catch {
    try {
      context.process.kill();
    } catch {
      // ignored
    }
  }

  const exited = await waitForExit(context.process, terminateTimeoutMs);
  if (exited) {
    return;
  }

  logger?.warn?.(
    {
      executablePath: context.executablePath,
      cwd: context.cwd ?? null,
      forceKillTimeoutMs,
    },
    "WARN [runtime:codex] Graceful Codex app-server shutdown timed out, forcing kill",
  );

  try {
    context.process.kill("SIGKILL");
  } catch {
    try {
      context.process.kill();
    } catch {
      // ignored
    }
  }

  const forceExited = await waitForExit(context.process, forceKillTimeoutMs);
  if (!forceExited) {
    logger?.warn?.(
      {
        executablePath: context.executablePath,
        cwd: context.cwd ?? null,
      },
      "WARN [runtime:codex] Codex app-server process did not exit after force kill",
    );
  }
}

function mirrorEnvPair(
  env: Record<string, string>,
  uppercaseKey: string,
  lowercaseKey: string,
): void {
  const value = env[uppercaseKey] ?? env[lowercaseKey];
  if (!value) {
    return;
  }
  env[uppercaseKey] = value;
  env[lowercaseKey] = value;
}

function isAllowedEnvironmentKey(key: string): boolean {
  return ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function hasProcessExited(process: ChildProcess): boolean {
  return process.exitCode != null || process.signalCode != null;
}

function findBundledCodexBinary(): string {
  const { platform, arch } = process;
  let targetTriple: string | null = null;

  switch (platform) {
    case "linux":
    case "android":
      targetTriple =
        arch === "x64"
          ? "x86_64-unknown-linux-musl"
          : arch === "arm64"
            ? "aarch64-unknown-linux-musl"
            : null;
      break;
    case "darwin":
      targetTriple =
        arch === "x64" ? "x86_64-apple-darwin" : arch === "arm64" ? "aarch64-apple-darwin" : null;
      break;
    case "win32":
      targetTriple =
        arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : arch === "arm64"
            ? "aarch64-pc-windows-msvc"
            : null;
      break;
    default:
      targetTriple = null;
  }

  if (!targetTriple) {
    throw new Error(`Unsupported platform for bundled Codex binary: ${platform} (${arch})`);
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    throw new Error(`Unsupported Codex target triple: ${targetTriple}`);
  }

  const codexSdkPackageJsonPath = moduleRequire.resolve(`${CODEX_SDK_NPM_NAME}/package.json`);
  const codexSdkRequire = createRequire(codexSdkPackageJsonPath);
  const codexPackageJsonPath = codexSdkRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
  const codexRequire = createRequire(codexPackageJsonPath);
  const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
  const vendorRoot = path.join(path.dirname(platformPackageJsonPath), "vendor");
  const binaryName = IS_WINDOWS ? "codex.exe" : "codex";
  return path.join(vendorRoot, targetTriple, "codex", binaryName);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function waitForExit(
  childProcess: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (hasProcessExited(childProcess)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      childProcess.off("exit", onExit);
      childProcess.off("close", onClose);
    };
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onExit = () => settle(true);
    const onClose = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    childProcess.once("exit", onExit);
    childProcess.once("close", onClose);
  });
}

export function buildWindowsAppServerCommandLine(executablePath: string, args: string[]): string {
  return buildSafeWindowsShellCommandLine(executablePath, args, "Codex app-server");
}
