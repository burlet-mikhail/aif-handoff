# GitHub Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Import from GitHub" flow that lists the user's GitHub repos via `gh` CLI, clones a selected repo into a configurable directory, and creates an AIF project pointing at it. Add a per-project "Git Pull" button for on-demand sync.

**Architecture:** New API route group `/github` with three endpoints (list repos, clone, pull). New frontend dialog `GitHubImportDialog` triggered from the project dropdown. Uses `gh` CLI (already authenticated on server) for GitHub API calls and standard `git` for clone/pull. Two new env vars: `GIT_PROJECTS_DIR` (clone target) and `GH_CLI_PATH` (optional, defaults to `gh`).

**Tech Stack:** Hono route, `child_process.execFile`, React dialog, React Query mutations, existing UI primitives (Dialog, Button, Input).

---

## File Structure

### Backend (API)

| Action | Path                                | Responsibility                                                           |
| ------ | ----------------------------------- | ------------------------------------------------------------------------ |
| Create | `packages/api/src/routes/github.ts` | Route handlers: GET /github/repos, POST /github/clone, POST /github/pull |
| Modify | `packages/api/src/index.ts:74`      | Mount `githubRouter`                                                     |
| Modify | `packages/api/src/schemas.ts`       | Add `githubCloneSchema`, `githubPullSchema`                              |
| Modify | `packages/shared/src/env.ts:29-132` | Add `GIT_PROJECTS_DIR`, `GH_CLI_PATH`                                    |

### Frontend (Web)

| Action | Path                                                              | Responsibility                                              |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Create | `packages/web/src/components/project/GitHubImportDialog.tsx`      | Dialog: repo list, search, clone + auto-create project      |
| Create | `packages/web/src/hooks/useGitHub.ts`                             | React Query hooks: useGitHubRepos, useCloneRepo, useGitPull |
| Modify | `packages/web/src/lib/api.ts`                                     | Add `listGitHubRepos()`, `cloneGitHubRepo()`, `gitPull()`   |
| Modify | `packages/web/src/components/project/ProjectSelector.tsx:263-268` | Add "Import from GitHub" button in dropdown                 |
| Modify | `packages/web/src/components/layout/Header.tsx`                   | Pass GitHubImportDialog open state, wire onSelect           |

### Tests

| Action | Path                                        | Responsibility                                  |
| ------ | ------------------------------------------- | ----------------------------------------------- |
| Create | `packages/api/src/__tests__/github.test.ts` | Route handler tests (mocked `gh` / `git` calls) |

---

## Task 1: Add env vars

**Files:**

- Modify: `packages/shared/src/env.ts:29-132`
- Modify: `.env.example`

- [ ] **Step 1: Add GIT_PROJECTS_DIR and GH_CLI_PATH to env schema**

In `packages/shared/src/env.ts`, add two fields to the `envSchema` object (after line 131, before the closing `}`):

```typescript
  GIT_PROJECTS_DIR: z.string().optional(),
  GH_CLI_PATH: z.string().default("gh"),
```

- [ ] **Step 2: Add to .env.example**

Add a new section to `.env.example` after the Telegram section:

```bash
# ----------------------------------------------------------
# GitHub Import
# ----------------------------------------------------------
# Directory where repos are cloned when importing from GitHub
# GIT_PROJECTS_DIR=/home/www/projects
# Path to gh CLI binary (default: gh)
# GH_CLI_PATH=gh
```

- [ ] **Step 3: Verify build**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/env.ts .env.example
git commit -m "feat(shared): add GIT_PROJECTS_DIR and GH_CLI_PATH env vars"
```

---

## Task 2: Add Zod schemas for GitHub endpoints

**Files:**

- Modify: `packages/api/src/schemas.ts`

- [ ] **Step 1: Add clone and pull schemas**

Add at the end of `packages/api/src/schemas.ts` (before the final line):

```typescript
export const githubCloneSchema = z.object({
  repoFullName: z.string().min(1, "Repository full name is required").max(500),
  dirName: z.string().max(200).optional(),
});

export const githubPullSchema = z.object({
  rootPath: z.string().min(1, "Root path is required"),
});
```

- [ ] **Step 2: Verify build**

Run: `cd packages/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/schemas.ts
git commit -m "feat(api): add Zod schemas for GitHub clone and pull endpoints"
```

---

## Task 3: Create GitHub route handler

**Files:**

- Create: `packages/api/src/routes/github.ts`

- [ ] **Step 1: Create the route file**

Create `packages/api/src/routes/github.ts`:

```typescript
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { getEnv, logger } from "@aif/shared";
import { jsonValidator } from "../middleware/zodValidator.js";
import { githubCloneSchema, githubPullSchema } from "../schemas.js";

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
```

- [ ] **Step 2: Verify build**

Run: `cd packages/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/github.ts
git commit -m "feat(api): add GitHub route (list repos, clone, pull)"
```

---

## Task 4: Mount GitHub router

**Files:**

- Modify: `packages/api/src/index.ts:5-10` (imports), line 74 (route mounting)

- [ ] **Step 1: Add import and route mount**

Add import after line 10 in `packages/api/src/index.ts`:

```typescript
import { githubRouter } from "./routes/github.js";
```

Add route mount after line 78 (`app.route("/runtime-profiles", runtimeProfilesRouter);`):

```typescript
app.route("/github", githubRouter);
```

- [ ] **Step 2: Verify build**

Run: `cd packages/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): mount /github route"
```

---

## Task 5: Add frontend API methods

**Files:**

- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add GitHub API methods**

Add the following methods inside the `api` object in `packages/web/src/lib/api.ts`, after the `cancelCodexLogin` method (before the closing `};`):

```typescript
  // GitHub import
  listGitHubRepos(): Promise<
    Array<{
      nameWithOwner: string;
      description: string;
      url: string;
      isPrivate: boolean;
      updatedAt: string;
      defaultBranchRef: { name: string } | null;
    }>
  > {
    console.debug("[api] GET /github/repos");
    return request("/github/repos");
  },

  cloneGitHubRepo(input: {
    repoFullName: string;
    dirName?: string;
  }): Promise<{ path: string; alreadyExists: boolean }> {
    console.debug("[api] POST /github/clone", input);
    return request(
      "/github/clone",
      { method: "POST", body: JSON.stringify(input) },
      120_000,
    );
  },

  gitPull(rootPath: string): Promise<{ output: string }> {
    console.debug("[api] POST /github/pull", { rootPath });
    return request("/github/pull", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    });
  },
```

- [ ] **Step 2: Verify build**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(web): add GitHub API client methods"
```

---

## Task 6: Create React Query hooks for GitHub

**Files:**

- Create: `packages/web/src/hooks/useGitHub.ts`

- [ ] **Step 1: Create the hooks file**

Create `packages/web/src/hooks/useGitHub.ts`:

```typescript
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export function useGitHubRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["github-repos"],
    queryFn: api.listGitHubRepos,
    enabled,
    staleTime: 60_000,
  });
}

export function useCloneRepo() {
  return useMutation({
    mutationFn: (input: { repoFullName: string; dirName?: string }) => api.cloneGitHubRepo(input),
  });
}

export function useGitPull() {
  return useMutation({
    mutationFn: (rootPath: string) => api.gitPull(rootPath),
  });
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/useGitHub.ts
git commit -m "feat(web): add React Query hooks for GitHub import"
```

---

## Task 7: Create GitHubImportDialog component

**Files:**

- Create: `packages/web/src/components/project/GitHubImportDialog.tsx`

- [ ] **Step 1: Create the dialog component**

Create `packages/web/src/components/project/GitHubImportDialog.tsx`:

```tsx
import { useState, useMemo } from "react";
import { GitBranch, Lock, Globe, Search, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useGitHubRepos, useCloneRepo } from "@/hooks/useGitHub";
import { useCreateProject } from "@/hooks/useProjects";
import type { Project } from "@aif/shared/browser";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectCreated: (project: Project) => void;
}

export function GitHubImportDialog({ open, onOpenChange, onProjectCreated }: Props) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: repos, isLoading, error } = useGitHubRepos(open);
  const cloneRepo = useCloneRepo();
  const createProject = useCreateProject();
  const [cloningRepo, setCloningRepo] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!repos) return [];
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.nameWithOwner.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  }, [repos, search]);

  const handleImport = (repoFullName: string) => {
    setCloningRepo(repoFullName);
    const repoName = repoFullName.split("/").pop() ?? repoFullName;

    cloneRepo.mutate(
      { repoFullName },
      {
        onSuccess: (result) => {
          if (result.alreadyExists) {
            toast(`"${repoName}" already cloned, creating project...`, "info");
          }

          createProject.mutate(
            { name: repoName, rootPath: result.path },
            {
              onSuccess: (project) => {
                toast(`Project "${repoName}" created`, "success");
                onProjectCreated(project);
                onOpenChange(false);
                setCloningRepo(null);
                setSearch("");
              },
              onError: (err) => {
                toast(
                  err instanceof Error ? err.message : "Failed to create project",
                  "error",
                  8000,
                );
                setCloningRepo(null);
              },
            },
          );
        },
        onError: (err) => {
          toast(err instanceof Error ? err.message : "Clone failed", "error", 8000);
          setCloningRepo(null);
        },
      },
    );
  };

  const isPending = cloneRepo.isPending || createProject.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Import from GitHub
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>

        <div className="max-h-80 overflow-y-auto border border-border">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading repositories...
            </div>
          )}

          {error && (
            <div className="px-3 py-4 text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load repos"}
            </div>
          )}

          {!isLoading && !error && filtered.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {search ? "No matching repositories" : "No repositories found"}
            </div>
          )}

          {filtered.map((repo) => (
            <button
              key={repo.nameWithOwner}
              type="button"
              disabled={isPending}
              onClick={() => handleImport(repo.nameWithOwner)}
              className="flex w-full items-start gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent disabled:opacity-50"
            >
              <div className="mt-0.5">
                {repo.isPrivate ? (
                  <Lock className="h-3.5 w-3.5 text-amber-500" />
                ) : (
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{repo.nameWithOwner}</span>
                  {cloningRepo === repo.nameWithOwner && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                </div>
                {repo.description && (
                  <div className="truncate text-xs text-muted-foreground">{repo.description}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/project/GitHubImportDialog.tsx
git commit -m "feat(web): add GitHubImportDialog component"
```

---

## Task 8: Wire GitHubImportDialog into ProjectSelector dropdown

**Files:**

- Modify: `packages/web/src/components/project/ProjectSelector.tsx:1-10` (imports), lines 263-268 (dropdown buttons)

- [ ] **Step 1: Add import and state**

Add import at the top of `ProjectSelector.tsx`:

```typescript
import { GitBranch } from "lucide-react";
import { GitHubImportDialog } from "./GitHubImportDialog";
```

Add state inside the `ProjectSelector` component, after line 55 (`const selectorRef = ...`):

```typescript
const [githubImportOpen, setGithubImportOpen] = useState(false);
```

- [ ] **Step 2: Add "Import from GitHub" button to dropdown**

In `ProjectSelector.tsx`, replace the block at lines 263-268:

```tsx
<div className="mt-1 border-t border-border pt-1">
  <ListButton onClick={openCreate} className="gap-2 px-3 py-2">
    <Plus className="h-3 w-3" />
    New project
  </ListButton>
</div>
```

with:

```tsx
<div className="mt-1 border-t border-border pt-1">
  <ListButton
    onClick={() => {
      setGithubImportOpen(true);
      setDropdownOpen(false);
    }}
    className="gap-2 px-3 py-2"
  >
    <GitBranch className="h-3 w-3" />
    Import from GitHub
  </ListButton>
  <ListButton onClick={openCreate} className="gap-2 px-3 py-2">
    <Plus className="h-3 w-3" />
    New project
  </ListButton>
</div>
```

- [ ] **Step 3: Add GitHubImportDialog render**

In `ProjectSelector.tsx`, add the dialog render right before the closing `</>` (before line 426):

```tsx
<GitHubImportDialog
  open={githubImportOpen}
  onOpenChange={setGithubImportOpen}
  onProjectCreated={onSelect}
/>
```

- [ ] **Step 4: Verify build**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/project/ProjectSelector.tsx
git commit -m "feat(web): wire GitHub import button into project dropdown"
```

---

## Task 9: Add Git Pull button to project actions

**Files:**

- Modify: `packages/web/src/components/project/ProjectSelector.tsx`

- [ ] **Step 1: Add git pull imports and hook**

Add import at the top of `ProjectSelector.tsx`:

```typescript
import { GitPullRequestArrow } from "lucide-react";
import { useGitPull } from "@/hooks/useGitHub";
```

Add hook inside the component, after the other hooks:

```typescript
const gitPull = useGitPull();
```

- [ ] **Step 2: Add pull handler**

Add handler inside the component:

```typescript
const handleGitPull = (p: Project, e: React.MouseEvent) => {
  e.stopPropagation();
  gitPull.mutate(p.rootPath, {
    onSuccess: (result) => {
      toast(result.output || "Already up to date", "success", 5000);
    },
    onError: (err) => {
      toast(err instanceof Error ? err.message : "Git pull failed", "error", 8000);
    },
  });
};
```

- [ ] **Step 3: Add pull button to project list items**

In the project list item row (inside the `projects?.map((p) => (` block), add a new Button between the Edit and Delete buttons:

```tsx
<Button
  variant="ghost"
  size="icon"
  className="h-6 w-6 border-0 opacity-0 group-hover:opacity-70 hover:!opacity-100"
  onClick={(e) => handleGitPull(p, e)}
  disabled={gitPull.isPending}
  title="Git Pull"
>
  <GitPullRequestArrow className="h-3 w-3" />
</Button>
```

- [ ] **Step 4: Verify build**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/project/ProjectSelector.tsx
git commit -m "feat(web): add Git Pull button to project list"
```

---

## Task 10: Write API tests

**Files:**

- Create: `packages/api/src/__tests__/github.test.ts`

- [ ] **Step 1: Create test file**

Create `packages/api/src/__tests__/github.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock getEnv before importing the router
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      GH_CLI_PATH: "gh",
      GIT_PROJECTS_DIR: "/tmp/test-projects",
    }),
  };
});

import { Hono } from "hono";
import { githubRouter } from "../routes/github.js";

const app = new Hono();
app.route("/github", githubRouter);

const mockExecFile = vi.mocked(execFile);

function mockExecFileSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof _opts === "function") {
      _opts(null, { stdout, stderr: "" } as never);
    } else if (callback) {
      (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout,
        stderr: "",
      });
    }
    return {} as ReturnType<typeof execFile>;
  });
}

describe("GET /github/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns repos from gh CLI", async () => {
    const repos = [
      {
        nameWithOwner: "user/repo1",
        description: "Test repo",
        url: "https://github.com/user/repo1",
        isPrivate: false,
        updatedAt: "2026-01-01T00:00:00Z",
        defaultBranchRef: { name: "main" },
      },
    ];
    mockExecFileSuccess(JSON.stringify(repos));

    const res = await app.request("/github/repos");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].nameWithOwner).toBe("user/repo1");
  });
});

describe("POST /github/pull", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-git directory", async () => {
    const res = await app.request("/github/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: "/tmp/nonexistent-dir" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd packages/api && npx vitest run src/__tests__/github.test.ts`
Expected: tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/__tests__/github.test.ts
git commit -m "test(api): add GitHub route tests"
```

---

## Task 11: Manual integration test

- [ ] **Step 1: Set env vars**

Add to your `.env`:

```bash
GIT_PROJECTS_DIR=/path/to/your/projects/dir
```

- [ ] **Step 2: Verify gh is authenticated**

Run: `gh auth status`
Expected: shows authenticated user

- [ ] **Step 3: Start dev servers**

Run: `npm run dev`

- [ ] **Step 4: Test the flow**

1. Open the app in browser
2. Click the project selector dropdown
3. Click "Import from GitHub"
4. Verify repo list loads
5. Search for a repo
6. Click a repo to import it
7. Verify it clones and creates the project
8. Hover over the project in the dropdown and click the Git Pull button
9. Verify pull succeeds

- [ ] **Step 5: Commit any fixes**

If any adjustments were needed, commit them.
