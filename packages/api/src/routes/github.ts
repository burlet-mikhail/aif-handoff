import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { getEnv, logger } from "@aif/shared";
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

export const githubRouter = new Hono();

interface GhRepo {
  nameWithOwner: string;
  description: string;
  url: string;
  isPrivate: boolean;
  updatedAt: string;
  defaultBranchRef: { name: string } | null;
}

// GET /github/repos — list user repos via gh CLI
githubRouter.get("/repos", async (c) => {
  const env = getEnv();
  const gh = env.GH_CLI_PATH;

  try {
    const { stdout } = await execFileAsync(
      gh,
      [
        "repo",
        "list",
        "--json",
        "nameWithOwner,description,url,isPrivate,updatedAt,defaultBranchRef",
        "--limit",
        "200",
      ],
      { timeout: EXEC_TIMEOUT_MS },
    );

    const repos: GhRepo[] = JSON.parse(stdout);
    log.debug({ count: repos.length }, "Listed GitHub repos");
    return c.json(repos);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to list GitHub repos");

    if (message.includes("not logged in") || message.includes("auth login")) {
      return c.json({ error: "GitHub CLI not authenticated. Run: gh auth login" }, 401);
    }

    return c.json({ error: `Failed to list repos: ${message}` }, 500);
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
    return c.json({ branch });
  } catch {
    // If regular checkout fails, try creating a tracking branch from remote
    try {
      await execFileAsync("git", ["checkout", "-b", branch, `origin/${branch}`], {
        cwd: rootPath,
        timeout: 30_000,
      });

      log.info({ rootPath, branch }, "Created local tracking branch from remote");
      return c.json({ branch });
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
