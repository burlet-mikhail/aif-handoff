import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeTransport } from "../../../../types.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const spawnCodexAppServerProcessMock = vi.fn();
const terminateCodexAppServerProcessMock = vi.fn();

vi.mock("../process.js", () => ({
  spawnCodexAppServerProcess: (...args: unknown[]) => spawnCodexAppServerProcessMock(...args),
  terminateCodexAppServerProcess: (...args: unknown[]) =>
    terminateCodexAppServerProcessMock(...args),
}));

const { getCodexAppServerSession, listCodexAppServerSessionEvents, listCodexAppServerSessions } =
  await import("../sessions.js");

function spawnFixtureProcess(scenario = "session-discovery"): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    stdio: "pipe",
    env: {
      ...process.env,
      FAKE_CODEX_SCENARIO: scenario,
    },
  });
  activeChildren.add(child);
  return child;
}

async function terminateFixtureProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  activeChildren.delete(child);
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }
  child.kill();
  await once(child, "exit").catch(() => undefined);
}

beforeEach(() => {
  spawnCodexAppServerProcessMock.mockReset();
  terminateCodexAppServerProcessMock.mockReset();
  spawnCodexAppServerProcessMock.mockImplementation(
    (input: {
      input: {
        options?: Record<string, unknown>;
      };
    }) => {
      const scenario =
        typeof input.input.options?.testScenario === "string"
          ? input.input.options.testScenario
          : "session-discovery";
      const child = spawnFixtureProcess(scenario);
      return {
        process: child,
        stderrTail: [],
        executablePath: process.execPath,
        args: [FIXTURE_PATH],
        cwd: undefined,
      };
    },
  );
  terminateCodexAppServerProcessMock.mockImplementation(
    async (context: { process: ChildProcessWithoutNullStreams }) => {
      await terminateFixtureProcess(context.process);
    },
  );
});

afterEach(async () => {
  await Promise.all([...activeChildren].map((child) => terminateFixtureProcess(child)));
});

describe("codex app-server session discovery", () => {
  it("lists threads via app-server thread/list", async () => {
    const sessions = await listCodexAppServerSessions({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "/tmp/fake",
      transport: RuntimeTransport.APP_SERVER,
      limit: 10,
      options: {},
    });

    expect(sessions).toEqual([
      expect.objectContaining({
        id: "thread-1",
        runtimeId: "codex",
        providerId: "openai",
        profileId: "profile-1",
        title: "Stored Codex Thread",
      }),
    ]);
  });

  it("reads a thread and maps stored user/assistant messages", async () => {
    const session = await getCodexAppServerSession({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "/tmp/fake",
      transport: RuntimeTransport.APP_SERVER,
      sessionId: "thread-read",
      options: {},
    });
    const events = await listCodexAppServerSessionEvents({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "/tmp/fake",
      transport: RuntimeTransport.APP_SERVER,
      sessionId: "thread-read",
      options: {},
    });

    expect(session?.id).toBe("thread-read");
    expect(events).toEqual([
      expect.objectContaining({
        type: "session-message",
        message: "Stored user prompt",
        data: expect.objectContaining({ role: "user" }),
      }),
      expect.objectContaining({
        type: "session-message",
        message: "Stored assistant answer",
        data: expect.objectContaining({ role: "assistant" }),
      }),
    ]);
  });

  it("reuses a fresh list result instead of spawning repeatedly for identical discovery input", async () => {
    const input = {
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "/tmp/fake-repeated-session-discovery",
      transport: RuntimeTransport.APP_SERVER,
      limit: 10,
      options: {},
    };

    const first = await listCodexAppServerSessions(input);
    const second = await listCodexAppServerSessions(input);

    expect(second).toEqual(first);
    expect(spawnCodexAppServerProcessMock).toHaveBeenCalledTimes(1);
  });

  it("applies request timeouts to session discovery and terminates the process", async () => {
    await expect(
      listCodexAppServerSessions({
        runtimeId: "codex",
        providerId: "openai",
        profileId: "profile-1",
        projectRoot: "/tmp/fake-hanging-session-discovery",
        transport: RuntimeTransport.APP_SERVER,
        limit: 10,
        options: {
          testScenario: "session-discovery-hang",
          appServerRequestTimeoutMs: 2_000,
        },
      }),
    ).rejects.toThrow("Timed out waiting for JSONL RPC response");

    expect(terminateCodexAppServerProcessMock).toHaveBeenCalledTimes(1);
  });
});
