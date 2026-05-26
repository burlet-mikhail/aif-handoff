import { describe, it, expect, beforeEach, vi } from "vitest";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const { getTasksImportStatus, importTasksFromFolder } = await import("../services/taskImport.js");

function createProject(): { projectId: string; rootPath: string } {
  const rootPath = mkdtempSync(join(tmpdir(), "task-import-"));
  const db = testDb.current;
  const projectId = crypto.randomUUID();
  db.insert(projects)
    .values({
      id: projectId,
      name: "Test Project",
      rootPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return { projectId, rootPath };
}

function writeTaskFile(rootPath: string, relPath: string, content: string): string {
  const fullPath = join(rootPath, "tasks", relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

describe("taskImport", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
  });

  describe("getTasksImportStatus", () => {
    it("returns available=false when tasks/ does not exist", async () => {
      const { rootPath } = createProject();
      const status = await getTasksImportStatus(rootPath);
      expect(status).toEqual({ available: false, candidateCount: 0, subfolders: [] });
    });

    it("returns available=false when tasks/ is empty", async () => {
      const { rootPath } = createProject();
      mkdirSync(join(rootPath, "tasks"), { recursive: true });
      const status = await getTasksImportStatus(rootPath);
      expect(status.available).toBe(false);
      expect(status.candidateCount).toBe(0);
    });

    it("returns available=false when tasks/ contains only loose files", async () => {
      const { rootPath } = createProject();
      writeTaskFile(rootPath, "loose.md", "# Title\nbody");
      const status = await getTasksImportStatus(rootPath);
      expect(status.available).toBe(false);
      expect(status.candidateCount).toBe(0);
    });

    it("counts md files in subfolders", async () => {
      const { rootPath } = createProject();
      writeTaskFile(rootPath, "auth/login.md", "Login title");
      writeTaskFile(rootPath, "auth/signup.md", "Signup title");
      writeTaskFile(rootPath, "billing/refund.md", "Refund title");
      const status = await getTasksImportStatus(rootPath);
      expect(status.available).toBe(true);
      expect(status.candidateCount).toBe(3);
      expect(status.subfolders).toEqual(["auth", "billing"]);
    });

    it("ignores hidden segments anywhere in the path", async () => {
      const { rootPath } = createProject();
      writeTaskFile(rootPath, "auth/.draft/secret.md", "Secret title");
      writeTaskFile(rootPath, "auth/login.md", "Login title");
      const status = await getTasksImportStatus(rootPath);
      expect(status.candidateCount).toBe(1);
      expect(status.subfolders).toEqual(["auth"]);
    });

    it("ignores .imported/ subtree", async () => {
      const { rootPath } = createProject();
      writeTaskFile(rootPath, ".imported/auth/old.md", "Already imported");
      writeTaskFile(rootPath, "auth/new.md", "New title");
      const status = await getTasksImportStatus(rootPath);
      expect(status.candidateCount).toBe(1);
      expect(status.subfolders).toEqual(["auth"]);
    });

    it("ignores non-md files", async () => {
      const { rootPath } = createProject();
      writeTaskFile(rootPath, "auth/notes.txt", "not markdown");
      writeTaskFile(rootPath, "auth/login.md", "Login title");
      const status = await getTasksImportStatus(rootPath);
      expect(status.candidateCount).toBe(1);
    });

    it("ignores symlinks pointing outside tasksDir", async () => {
      const { rootPath } = createProject();
      mkdirSync(join(rootPath, "tasks", "evil"), { recursive: true });
      const outsideDir = mkdtempSync(join(tmpdir(), "task-import-outside-"));
      const outsideFile = join(outsideDir, "etc-passwd.md");
      writeFileSync(outsideFile, "root:x:0:0");
      try {
        symlinkSync(outsideFile, join(rootPath, "tasks", "evil", "link.md"));
      } catch {
        return;
      }
      const status = await getTasksImportStatus(rootPath);
      expect(status.candidateCount).toBe(0);
    });

    it("works when tasks/ itself is a symlink", async () => {
      const { rootPath } = createProject();
      const realTasksDir = join(rootPath, "real-tasks");
      mkdirSync(join(realTasksDir, "auth"), { recursive: true });
      writeFileSync(join(realTasksDir, "auth", "login.md"), "Login title");
      try {
        symlinkSync(realTasksDir, join(rootPath, "tasks"));
      } catch {
        return;
      }
      const status = await getTasksImportStatus(rootPath);
      expect(status.available).toBe(true);
      expect(status.candidateCount).toBe(1);
    });
  });

  describe("importTasksFromFolder", () => {
    it("returns empty result when tasks/ missing", async () => {
      const { projectId, rootPath } = createProject();
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result).toEqual({ created: 0, skipped: 0, errors: [], taskIds: [] });
    });

    it("creates tasks from importable files and moves them to .imported/", async () => {
      const { projectId, rootPath } = createProject();
      const filePath = writeTaskFile(rootPath, "auth/login.md", "Login title\n\nLogin body text");
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });

      expect(result.created).toBe(1);
      expect(result.taskIds.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(existsSync(filePath)).toBe(false);
      expect(existsSync(join(rootPath, "tasks", ".imported", "auth", "login.md"))).toBe(true);

      const row = testDb.current
        .select()
        .from(tasks)
        .all()
        .find((t) => t.id === result.taskIds[0]);
      expect(row?.title).toBe("Login title");
      expect(row?.tags).toContain("auth");
      expect(row?.useSubagents).toBeTruthy();
      expect(row?.skipReview).toBeFalsy();
      expect(row?.planTests).toBeFalsy();
      expect(row?.maxReviewIterations).toBe(3);
      expect(row?.autoMode).toBeTruthy();
      expect(row?.isFix).toBeFalsy();
      expect(row?.plannerMode).toBe("fast");
      expect(row?.paused).toBeFalsy();
    });

    it("uses first-level subfolder as tag (ignores deeper segments)", async () => {
      const { projectId, rootPath } = createProject();
      writeTaskFile(rootPath, "billing/refunds/case-1.md", "Case 1");
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });

      expect(result.created).toBe(1);
      const row = testDb.current
        .select()
        .from(tasks)
        .all()
        .find((t) => t.id === result.taskIds[0]);
      expect(row?.tags).toBe(JSON.stringify(["billing"]));
    });

    it("skips empty files with reason=empty", async () => {
      const { projectId, rootPath } = createProject();
      writeTaskFile(rootPath, "auth/empty.md", "\n\n");
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]).toMatchObject({ reason: "empty" });
    });

    it("skips files over 1MB with reason=too_large", async () => {
      const { projectId, rootPath } = createProject();
      const big = "x".repeat(1_000_001);
      writeTaskFile(rootPath, "auth/big.md", `Big title\n${big}`);
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]).toMatchObject({ reason: "too_large" });
    });

    it("truncates titles longer than 500 chars", async () => {
      const { projectId, rootPath } = createProject();
      const longTitle = "T".repeat(600);
      writeTaskFile(rootPath, "auth/long.md", `${longTitle}\nbody`);
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result.created).toBe(1);
      const row = testDb.current
        .select()
        .from(tasks)
        .all()
        .find((t) => t.id === result.taskIds[0]);
      expect(row?.title?.length).toBe(500);
      expect(row?.title?.endsWith("...")).toBe(true);
    });

    it("handles EEXIST in .imported/ by appending timestamp", async () => {
      const { projectId, rootPath } = createProject();
      writeTaskFile(rootPath, "auth/login.md", "Login title\nbody");
      // Pre-create the target file so the rename will hit EEXIST.
      const importedDir = join(rootPath, "tasks", ".imported", "auth");
      mkdirSync(importedDir, { recursive: true });
      writeFileSync(join(importedDir, "login.md"), "previous import");

      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result.created).toBe(1);
      expect(result.errors.length).toBe(0);

      const entries = await fs.readdir(importedDir);
      const collisionMatch = entries.filter(
        (name) => name.startsWith("login-") && name.endsWith(".md"),
      );
      expect(collisionMatch.length).toBe(1);
    });

    it("continues importing remaining files when one fails", async () => {
      const { projectId, rootPath } = createProject();
      writeTaskFile(rootPath, "auth/ok-1.md", "Good 1\nbody");
      writeTaskFile(rootPath, "auth/empty.md", "");
      writeTaskFile(rootPath, "auth/ok-2.md", "Good 2\nbody");

      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors.length).toBe(1);
    });

    it("does not import files at the top level of tasks/", async () => {
      const { projectId, rootPath } = createProject();
      writeTaskFile(rootPath, "loose.md", "Loose title");
      writeTaskFile(rootPath, "auth/nested.md", "Nested title");
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      expect(result.created).toBe(1);
      const row = testDb.current
        .select()
        .from(tasks)
        .all()
        .find((t) => t.id === result.taskIds[0]);
      expect(row?.title).toBe("Nested title");
    });

    it("prepends provenance line to imported task description", async () => {
      const { projectId, rootPath } = createProject();
      writeTaskFile(rootPath, "auth/login.md", "Login title\nReal body");
      const result = await importTasksFromFolder({ projectId, projectRootPath: rootPath });
      const row = testDb.current
        .select()
        .from(tasks)
        .all()
        .find((t) => t.id === result.taskIds[0]);
      expect(row?.description).toContain("> Imported from tasks/auth/login.md");
      expect(row?.description).toContain("Real body");
    });
  });
});
