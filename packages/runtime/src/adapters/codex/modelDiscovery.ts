import { RuntimeTransport, type RuntimeModel, type RuntimeModelListInput } from "../../types.js";
import {
  enrichCodexDiscoveredModels,
  getDefaultCodexModels,
  parseCodexRuntimeModel,
} from "./modelDiscovery/modelCatalog.js";
import {
  buildCodexAppServerDiscoveryEnv,
  buildCodexAppServerDiscoveryEnvWithStats,
  reservePort,
  resolveDiscoveryExecutable,
  spawnCodexAppServer,
  terminateProcess,
} from "./modelDiscovery/process.js";
import { connectJsonRpcClient, sleep } from "./modelDiscovery/rpc.js";
import type {
  CodexModelDiscoveryLogger,
  CodexModelDiscoveryStartupDeps,
  JsonRpcClient,
} from "./modelDiscovery/types.js";

const DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_APP_SERVER_STARTUP_ATTEMPTS = 3;
const DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS = 150;

export { buildCodexAppServerDiscoveryEnv, enrichCodexDiscoveredModels, getDefaultCodexModels };
export type { CodexModelDiscoveryLogger };

export async function startCodexAppServerWithRetry(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
  deps: CodexModelDiscoveryStartupDeps = {
    reservePort,
    spawnCodexAppServer,
    connectJsonRpcClient,
    terminateProcess,
    sleep,
  },
): Promise<{
  attempt: number;
  listenPort: number;
  listenUrl: string;
  launch: Awaited<ReturnType<typeof spawnCodexAppServer>>;
  client: JsonRpcClient;
  executablePath: string;
}> {
  const executablePath = resolveDiscoveryExecutable(input);
  const envResult = buildCodexAppServerDiscoveryEnvWithStats(input);
  const env = envResult.env;
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: input.transport ?? RuntimeTransport.CLI,
      forwardedEnvCount: envResult.forwardedCount,
      filteredEnvCount: envResult.filteredCount,
      blockedEnvCount: envResult.blockedCount,
      droppedDisallowedPrefixCount: envResult.droppedDisallowedPrefixKeys.length,
    },
    "[runtime:codex] Built app-server discovery environment from curated allowlist",
  );
  if (envResult.droppedDisallowedPrefixKeys.length > 0) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        droppedDisallowedPrefixKeys: envResult.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building app-server discovery environment",
    );
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_APP_SERVER_STARTUP_ATTEMPTS; attempt += 1) {
    const listenPort = await deps.reservePort();
    const listenUrl = `ws://127.0.0.1:${listenPort}`;
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        reservedPort: listenPort,
        attempt,
        maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
      },
      "[runtime:codex] Reserved Codex app-server startup port",
    );

    const launch = deps.spawnCodexAppServer(executablePath, listenUrl, input.projectRoot, env);
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        hasConfiguredCliPath:
          typeof asRecord(input.options).codexCliPath === "string" ||
          typeof process.env.CODEX_CLI_PATH === "string",
        projectRoot: input.projectRoot ?? null,
        listenPort,
        attempt,
        maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
      },
      "[runtime:codex] Starting Codex app-server model discovery",
    );

    try {
      const client = await deps.connectJsonRpcClient(
        listenUrl,
        launch,
        DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
      );
      return {
        attempt,
        listenPort,
        listenUrl,
        launch,
        client,
        executablePath,
      };
    } catch (error) {
      const details = launch.stderr.join("").trim();
      const message = error instanceof Error ? error.message : String(error);
      const startupError = new Error(details ? `${message} (${details})` : message);
      lastError = startupError;
      deps.terminateProcess(launch.process);

      if (attempt < DEFAULT_APP_SERVER_STARTUP_ATTEMPTS) {
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport: input.transport ?? RuntimeTransport.CLI,
            executablePath,
            attempt,
            maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
            reservedPort: listenPort,
            error: startupError.message,
            retryDelayMs: DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS,
            nextAttempt: attempt + 1,
          },
          "WARN [runtime:codex] Codex app-server port handoff failed, retrying startup",
        );
        await deps.sleep(DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS);
        continue;
      }

      logger?.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.CLI,
          executablePath,
          attempt,
          maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
          reservedPort: listenPort,
          error: startupError.message,
        },
        "ERROR [runtime:codex] Codex app-server startup retries exhausted",
      );
    }
  }

  throw (
    lastError ??
    new Error("Codex app-server startup failed before websocket initialization could complete")
  );
}

export async function listCodexAppServerModels(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
): Promise<RuntimeModel[]> {
  const startup = await startCodexAppServerWithRetry(input, logger);
  const { client, launch, executablePath } = startup;

  try {
    await client.request(
      "initialize",
      {
        clientInfo: {
          name: "aif-runtime-codex-model-discovery",
          version: "1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      5_000,
    );

    const discovered: RuntimeModel[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result = asRecord(
        await client.request(
          "model/list",
          {
            cursor,
            includeHidden: false,
            limit: 100,
          },
          5_000,
        ),
      );
      const models = Array.isArray(result.data) ? result.data : [];
      for (const model of models) {
        const parsed = parseCodexRuntimeModel(model);
        if (parsed) {
          discovered.push(parsed);
        }
      }

      cursor = readString(result.nextCursor);
      if (!cursor) {
        break;
      }
    }

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        modelCount: discovered.length,
      },
      "[runtime:codex] Fetched model list from Codex app-server",
    );

    return enrichCodexDiscoveredModels(discovered);
  } catch (error) {
    const details = launch.stderr.join("").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(details ? `${message} (${details})` : message);
  } finally {
    try {
      await client.close();
    } finally {
      terminateProcess(launch.process);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
