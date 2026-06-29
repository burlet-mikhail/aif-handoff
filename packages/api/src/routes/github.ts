import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { getEnv, logger } from "@aif/shared";
import { listProjects } from "@aif/data";
import { jsonValidator } from "../middleware/zodValidator.js";
import {
  githubCloneSchema,
  githubPullSchema,
  githubCommitSchema,
  githubCheckoutSchema,
  githubLogSchema,
} from "../schemas.js";

const execFileAsync = promisify(execFile);
const log = logger("github-route");

const EXEC_TIMEOUT_MS = 120_000;

interface GhHostEntry {
  oauth_token?: string;
  user?: string;
  users?: Record<string, { oauth_token?: string }>;
}

/**
 * Reads per-user oauth tokens from gh's hosts.yml. Returns {login → token} map.
 *
 * gh CLI stores tokens in two formats depending on version:
 *
 *   Multi-account (gh >= 2.40):
 *     github.com:
 *       users:
 *         alice: { oauth_token: gho_xxx }
 *         bob:   { oauth_token: gho_yyy }
 *       user: alice
 *
 *   Single-account (older gh / PAT auth):
 *     github.com:
 *       oauth_token: gho_xxx
 *       user: alice
 *
 * Both formats are read so private repos are visible regardless of gh version.
 * If hosts.yml has no tokens at all (keyring-only storage — rare in Docker),
 * falls back to `gh auth token` to retrieve the active session token.
 */
function readGhUserTokens(): Map<string, string> {
  const ghConfigDir = process.env.GH_CONFIG_DIR ?? join(homedir(), ".config", "gh");
  const hostsPath = join(ghConfigDir, "hosts.yml");
  if (!existsSync(hostsPath)) return new Map();

  try {
    const doc = parseYaml(readFileSync(hostsPath, "utf8")) as
      | { "github.com"?: GhHostEntry }
      | undefined;
    const gh = doc?.["github.com"];
    if (!gh) return new Map();

    const map = new Map<string, string>();

    // Multi-account format: iterate all users
    if (gh.users) {
      for (const [login, info] of Object.entries(gh.users)) {
        if (info?.oauth_token) map.set(login, info.oauth_token);
      }
    }

    // Single-account format: top-level oauth_token + user
    if (gh.oauth_token && gh.user && !map.has(gh.user)) {
      map.set(gh.user, gh.oauth_token);
    }

    return map;
  } catch (err) {
    log.warn({ err }, "Failed to parse gh hosts.yml");
    return new Map();
  }
}

/**
 * Get the active gh auth token via `gh auth token`. Used as fallback when
 * hosts.yml has no inline tokens (keyring storage or empty config).
 */
async function getActiveGhToken(): Promise<string | null> {
  try {
    const ghCli = getEnv().GH_CLI_PATH;
    const { stdout } = await execFileAsync(ghCli, ["auth", "token"], { timeout: 5_000 });
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

export const githubRouter = new Hono();

/** Best-effort pull after checkout — returns output string or null on failure. */
async function autoPull(rootPath: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["pull", "--ff-only"], {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT_MS,
    });
    const output = stdout.trim();
    log.debug({ rootPath, branch, output }, "Auto-pull after checkout succeeded");
    return output || "Already up to date";
  } catch (err) {
    log.debug(
      { rootPath, branch, err },
      "Auto-pull after checkout skipped (no upstream or conflict)",
    );
    return null;
  }
}

interface GhRepo {
  nameWithOwner: string;
  description: string;
  url: string;
  isPrivate: boolean;
  updatedAt: string;
  defaultBranchRef: { name: string } | null;
}

// GET /github/repos?owner=<login> — list repos via gh CLI.
// Без owner — репо активного аккаунта. С owner — репо указанного user/org.
//
// Особенность gh CLI: `gh repo list <owner>` ходит в API как «внешний» запрос →
// возвращает только public-репо даже когда owner === одному из залогиненных
// аккаунтов. Чтобы видеть свои private-репо, нужен запрос ПОД ТОКЕНОМ этого
// аккаунта (БЕЗ owner-аргумента). Поддержка нескольких логинов одновременно
// сделана через GH_TOKEN на каждый subprocess (без `gh auth switch` — без гонок).
githubRouter.get("/repos", async (c) => {
  const env = getEnv();
  const gh = env.GH_CLI_PATH;
  const owner = c.req.query("owner")?.trim();

  const userTokens = readGhUserTokens();
  let ownerToken = owner ? userTokens.get(owner) : undefined;

  // Fallback: if hosts.yml had no inline tokens (keyring storage, empty config,
  // or format we didn't parse), try `gh auth token` for the active session.
  // This covers single-account Docker setups where hosts.yml is minimal.
  if (owner && !ownerToken && userTokens.size === 0) {
    const activeToken = await getActiveGhToken();
    if (activeToken) {
      ownerToken = activeToken;
      log.debug({ owner }, "Using active gh auth token as fallback for owner lookup");
    }
  }

  // Если owner совпадает с одним из залогиненных аккаунтов — берём его токен
  // и запрашиваем без owner-аргумента (видим все private+public+forks).
  // Иначе (org или произвольный user) — обычный `gh repo list <owner>` под
  // активным аккаунтом; видны репо доступные активному пользователю.
  const args = [
    "repo",
    "list",
    ...(ownerToken || !owner ? [] : [owner]),
    "--json",
    "nameWithOwner,description,url,isPrivate,updatedAt,defaultBranchRef",
    "--limit",
    "200",
  ];

  try {
    const { stdout } = await execFileAsync(gh, args, {
      timeout: EXEC_TIMEOUT_MS,
      env: ownerToken ? { ...process.env, GH_TOKEN: ownerToken } : process.env,
    });
    const repos: GhRepo[] = JSON.parse(stdout);
    log.debug(
      { owner, asUser: ownerToken ? owner : null, count: repos.length },
      "Listed GitHub repos",
    );
    return c.json(repos);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ owner, err }, "Failed to list GitHub repos");

    if (message.includes("not logged in") || message.includes("auth login")) {
      return c.json({ error: "GitHub CLI not authenticated. Run: gh auth login" }, 401);
    }

    return c.json({ error: `Failed to list repos: ${message}` }, 500);
  }
});

// GET /github/accounts — список namespace'ов, которые видит UI как источники репо.
// Собирает: логины всех залогиненных `gh` аккаунтов + org'и, в которых они состоят.
// Дедуплицирует. Если ни один аккаунт не залогинен — возвращает [].
githubRouter.get("/accounts", async (c) => {
  const env = getEnv();
  const gh = env.GH_CLI_PATH;

  try {
    // `gh auth status` пишет в stderr (см. https://github.com/cli/cli/issues/3692).
    // Игнорируем код возврата: если нет логинов — просто пустой stderr.
    const { stderr, stdout } = await execFileAsync(gh, ["auth", "status"], {
      timeout: 10_000,
    }).catch((err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    }));

    const text = `${stdout}\n${stderr}`;
    // Pattern: "Logged in to github.com account <login> (...)" — новый формат gh ≥ 2.40
    // или "Logged in to github.com as <login>" — старый формат.
    const logins = new Set<string>();
    const re = /Logged in to \S+\s+(?:account|as)\s+([\w.-]+)/g;
    for (const m of text.matchAll(re)) {
      logins.add(m[1]);
    }

    // Для каждого залогиненного аккаунта добираем org'и, в которых он состоит.
    const accounts = new Set<string>(logins);
    for (const login of logins) {
      try {
        const { stdout: orgsOut } = await execFileAsync(
          gh,
          ["api", "user/orgs", "--jq", ".[].login", "--hostname", "github.com"],
          { timeout: 10_000 },
        );
        for (const org of orgsOut
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)) {
          accounts.add(org);
        }
      } catch (err) {
        log.debug({ login, err }, "Failed to fetch orgs for account, skipping");
      }
    }

    return c.json(Array.from(accounts).sort());
  } catch (err) {
    log.error({ err }, "Failed to list GitHub accounts");
    return c.json({ error: "Failed to list accounts" }, 500);
  }
});

// POST /github/clone — clone a repo into GIT_PROJECTS_DIR
githubRouter.post("/clone", jsonValidator(githubCloneSchema), async (c) => {
  const env = getEnv();
  const gh = env.GH_CLI_PATH;
  const projectsDir = env.GIT_PROJECTS_DIR;

  if (!projectsDir) {
    return c.json({ error: "GIT_PROJECTS_DIR is not configured" }, 400);
  }

  const { repoFullName, dirName } = c.req.valid("json");
  const targetName = dirName?.trim() || basename(repoFullName);
  const targetPath = join(projectsDir, targetName);

  if (existsSync(targetPath)) {
    log.info({ repoFullName, targetPath }, "Repo already cloned, returning existing path");
    return c.json({ path: targetPath, alreadyExists: true });
  }

  try {
    await execFileAsync(gh, ["repo", "clone", repoFullName, targetPath], {
      timeout: EXEC_TIMEOUT_MS,
    });

    log.info({ repoFullName, targetPath }, "Repo cloned successfully");
    return c.json({ path: targetPath, alreadyExists: false }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ repoFullName, targetPath, err }, "Failed to clone repo");
    return c.json({ error: `Clone failed: ${message}` }, 500);
  }
});

// POST /github/pull — git pull in a project directory
githubRouter.post("/pull", jsonValidator(githubPullSchema), async (c) => {
  const { rootPath } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const { stdout } = await execFileAsync("git", ["pull", "--ff-only"], {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT_MS,
    });

    log.info({ rootPath, output: stdout.trim() }, "Git pull completed");
    return c.json({ output: stdout.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git pull failed");
    return c.json({ error: `Pull failed: ${message}` }, 500);
  }
});

// POST /github/status — branch, changed files, ahead/behind
githubRouter.post("/status", jsonValidator(githubPullSchema), async (c) => {
  const { rootPath } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const [branchRes, statusRes, aheadBehindRes] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: rootPath,
        timeout: 10_000,
      }),
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: rootPath,
        timeout: 10_000,
      }),
      execFileAsync("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
        cwd: rootPath,
        timeout: 10_000,
      }).catch(() => ({ stdout: "0\t0" })),
    ]);

    const branch = branchRes.stdout.trim();
    const lines = statusRes.stdout.trim().split("\n").filter(Boolean);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const idx = line[0] ?? " ";
      const wt = line[1] ?? " ";
      const file = line.slice(3);
      if (idx === "?") {
        untracked.push(file);
      } else if (idx !== " ") {
        staged.push(file);
      }
      if (wt !== " " && wt !== "?") {
        modified.push(file);
      }
    }

    const [ahead, behind] = aheadBehindRes.stdout.trim().split("\t").map(Number);

    return c.json({ branch, staged, modified, untracked, ahead, behind });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git status failed");
    return c.json({ error: `Status failed: ${message}` }, 500);
  }
});

// POST /github/log — recent commits
githubRouter.post("/log", jsonValidator(githubLogSchema), async (c) => {
  const { rootPath, limit } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `--max-count=${limit}`, "--format=%H%n%h%n%an%n%ar%n%s%n---END---"],
      { cwd: rootPath, timeout: 10_000 },
    );

    const commits = stdout
      .trim()
      .split("---END---")
      .filter(Boolean)
      .map((block) => {
        const [hash, shortHash, author, relativeDate, ...msgParts] = block.trim().split("\n");
        return {
          hash,
          shortHash,
          author,
          relativeDate,
          message: msgParts.join("\n"),
        };
      });

    return c.json(commits);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git log failed");
    return c.json({ error: `Log failed: ${message}` }, 500);
  }
});

// POST /github/fetch — git fetch --all --prune
githubRouter.post("/fetch", jsonValidator(githubPullSchema), async (c) => {
  const { rootPath } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const { stdout, stderr } = await execFileAsync("git", ["fetch", "--all", "--prune"], {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT_MS,
    });

    const output = (stdout + stderr).trim() || "Fetched";
    log.info({ rootPath, output }, "Git fetch completed");
    return c.json({ output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git fetch failed");
    return c.json({ error: `Fetch failed: ${message}` }, 500);
  }
});

// POST /github/branches — list local + remote branches + current
githubRouter.post("/branches", jsonValidator(githubPullSchema), async (c) => {
  const { rootPath } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["branch", "-a", "--format=%(refname:short)%09%(HEAD)"],
      { cwd: rootPath, timeout: 10_000 },
    );

    let current = "";
    const local: string[] = [];
    const remote: string[] = [];

    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [name, marker] = line.split("\t");
      if (marker === "*") current = name;

      if (name.startsWith("origin/")) {
        // Skip HEAD pointer and branches that already exist locally
        if (name === "origin/HEAD") continue;
        const shortName = name.slice("origin/".length);
        if (!local.includes(shortName)) {
          remote.push(shortName);
        }
      } else {
        local.push(name);
      }
    }

    // Also add local branches that weren't added yet (in case of current branch detection)
    if (current && !local.includes(current)) {
      local.push(current);
    }

    return c.json({ current, branches: local, remote });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git branches failed");
    return c.json({ error: `Branches failed: ${message}` }, 500);
  }
});

// POST /github/checkout — switch branch
githubRouter.post("/checkout", jsonValidator(githubCheckoutSchema), async (c) => {
  const { rootPath, branch } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    // Try regular checkout first (works for local branches)
    await execFileAsync("git", ["checkout", branch], {
      cwd: rootPath,
      timeout: 30_000,
    });

    log.info({ rootPath, branch }, "Branch switched");
    // Auto-pull after checkout
    const pulled = await autoPull(rootPath, branch);
    return c.json({ branch, pulled });
  } catch {
    // If regular checkout fails, try creating a tracking branch from remote
    try {
      await execFileAsync("git", ["checkout", "-b", branch, `origin/${branch}`], {
        cwd: rootPath,
        timeout: 30_000,
      });

      log.info({ rootPath, branch }, "Created local tracking branch from remote");
      return c.json({ branch, pulled: null });
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2);
      log.error({ rootPath, branch, err: err2 }, "Git checkout failed");
      return c.json({ error: `Checkout failed: ${message}` }, 500);
    }
  }
});

// POST /github/commit — stage files and commit
githubRouter.post("/commit", jsonValidator(githubCommitSchema), async (c) => {
  const { rootPath, message, files } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    // Stage specified files or all changes
    if (files && files.length > 0) {
      await execFileAsync("git", ["add", ...files], {
        cwd: rootPath,
        timeout: 30_000,
      });
    } else {
      await execFileAsync("git", ["add", "-A"], {
        cwd: rootPath,
        timeout: 30_000,
      });
    }

    // Check if there's anything staged
    const { stdout: diffStaged } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
      cwd: rootPath,
      timeout: 10_000,
    });

    if (!diffStaged.trim()) {
      return c.json({ error: "Nothing to commit" }, 400);
    }

    const { stdout } = await execFileAsync("git", ["commit", "-m", message], {
      cwd: rootPath,
      timeout: 30_000,
    });

    // Get the commit hash
    const { stdout: hashOut } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootPath,
      timeout: 10_000,
    });

    log.info({ rootPath, hash: hashOut.trim() }, "Committed");
    return c.json({ hash: hashOut.trim(), output: stdout.trim() }, 201);
  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git commit failed");
    return c.json({ error: `Commit failed: ${message_}` }, 500);
  }
});

// POST /github/push — git push (with -u for new branches)
githubRouter.post("/push", jsonValidator(githubPullSchema), async (c) => {
  const { rootPath } = c.req.valid("json");

  if (!existsSync(join(rootPath, ".git"))) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    // Get current branch name
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: rootPath, timeout: 10_000 },
    );
    const branch = branchOut.trim();

    // Check if upstream is set
    const hasUpstream = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`],
      { cwd: rootPath, timeout: 10_000 },
    ).then(
      () => true,
      () => false,
    );

    const pushArgs = hasUpstream ? ["push"] : ["push", "-u", "origin", branch];

    const { stdout, stderr } = await execFileAsync("git", pushArgs, {
      cwd: rootPath,
      timeout: EXEC_TIMEOUT_MS,
    });

    const output = (stdout + stderr).trim() || "Pushed";
    log.info({ rootPath, branch, output }, "Git push completed");
    return c.json({ output, branch });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ rootPath, err }, "Git push failed");
    return c.json({ error: `Push failed: ${message}` }, 500);
  }
});

// ── Background auto-pull for all projects ───────────────────

const AUTO_PULL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let autoPullTimer: ReturnType<typeof setInterval> | null = null;

async function autoPullAllProjects(): Promise<void> {
  const allProjects = listProjects();
  for (const project of allProjects) {
    const rootPath = project.rootPath;
    if (!rootPath || !existsSync(join(rootPath, ".git"))) continue;

    try {
      // Fetch first so we know about new remote branches
      await execFileAsync("git", ["fetch", "--all", "--prune"], {
        cwd: rootPath,
        timeout: 60_000,
      });

      // Then pull current branch (ff-only to avoid conflicts)
      await execFileAsync("git", ["pull", "--ff-only"], {
        cwd: rootPath,
        timeout: 60_000,
      });

      log.debug({ rootPath, project: project.name }, "Auto-pull succeeded");
    } catch (err) {
      // Expected for repos with no upstream or uncommitted changes — just skip
      log.debug({ rootPath, project: project.name, err }, "Auto-pull skipped");
    }
  }
}

export function startGitAutoPull(): void {
  if (autoPullTimer) return;
  log.info({ intervalMs: AUTO_PULL_INTERVAL_MS }, "Starting git auto-pull background job");

  // Run immediately on startup, then repeat
  void autoPullAllProjects();
  autoPullTimer = setInterval(() => {
    void autoPullAllProjects();
  }, AUTO_PULL_INTERVAL_MS);
}

export function stopGitAutoPull(): void {
  if (autoPullTimer) {
    clearInterval(autoPullTimer);
    autoPullTimer = null;
  }
}
