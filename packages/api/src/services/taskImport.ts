import { promises as fs } from "node:fs";
import path from "node:path";
import { createTask } from "@aif/data";
import { logger } from "@aif/shared";

const log = logger("task-import");

const IMPORTED_DIR_NAME = ".imported";
const MAX_FILE_BYTES = 1_000_000;
const MAX_TITLE_LENGTH = 500;
const TITLE_TRUNCATE_TO = 497;

export interface ImportStatus {
  available: boolean;
  candidateCount: number;
  subfolders: string[];
}

export type ImportErrorReason = "empty" | "too_large" | "read_failed" | "move_failed";

export interface ImportError {
  file: string;
  reason: ImportErrorReason;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: ImportError[];
  taskIds: string[];
}

interface CandidateFile {
  // Absolute path on disk (post-realpath).
  absolutePath: string;
  // Path relative to the realpath-resolved tasks root, e.g. "auth/sub/foo.md".
  relativePath: string;
  // First path segment of relativePath, used as a tag, e.g. "auth".
  firstLevelSubfolder: string;
}

async function resolveTasksDir(projectRootPath: string): Promise<string | null> {
  const candidate = path.resolve(projectRootPath, "tasks");
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return null;
    return real;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    log.warn({ projectRootPath, error: (error as Error).message }, "Failed to resolve tasks dir");
    return null;
  }
}

function hasHiddenSegment(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  return segments.some((segment) => segment.startsWith("."));
}

async function readDirentsRecursive(
  tasksDir: string,
): Promise<Array<{ name: string; parentPath: string; isFile: boolean; isSymbolicLink: boolean }>> {
  const out: Array<{
    name: string;
    parentPath: string;
    isFile: boolean;
    isSymbolicLink: boolean;
  }> = [];
  const stack: string[] = [tasksDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      const isSymbolicLink = dirent.isSymbolicLink();
      const isFile = dirent.isFile();
      out.push({ name: dirent.name, parentPath: dir, isFile, isSymbolicLink });

      if (dirent.isDirectory() && !isSymbolicLink) {
        // Skip hidden directories up-front; nothing under a hidden segment is importable.
        if (dirent.name.startsWith(".")) continue;
        stack.push(full);
      }
    }
  }

  return out;
}

async function collectCandidates(tasksDir: string): Promise<CandidateFile[]> {
  let entries: Awaited<ReturnType<typeof readDirentsRecursive>>;
  try {
    entries = await readDirentsRecursive(tasksDir);
  } catch (error) {
    log.warn({ tasksDir, error: (error as Error).message }, "Failed to read tasks dir");
    return [];
  }

  const candidates: CandidateFile[] = [];
  const tasksDirWithSep = tasksDir + path.sep;

  for (const dirent of entries) {
    if (!dirent.isFile) continue;
    if (dirent.isSymbolicLink) continue;
    if (!dirent.name.endsWith(".md")) continue;

    const directAbsolute = path.join(dirent.parentPath, dirent.name);

    let realAbsolute: string;
    try {
      realAbsolute = await fs.realpath(directAbsolute);
    } catch (error) {
      log.warn(
        { file: directAbsolute, error: (error as Error).message },
        "Failed to realpath candidate",
      );
      continue;
    }

    if (!realAbsolute.startsWith(tasksDirWithSep)) {
      log.warn({ file: directAbsolute, realAbsolute }, "Path traversal candidate rejected");
      continue;
    }

    const relativePath = path.relative(tasksDir, realAbsolute);
    if (hasHiddenSegment(relativePath)) continue;

    const segments = relativePath.split(path.sep);
    if (segments.length < 2) continue;

    const firstLevelSubfolder = segments[0];
    if (firstLevelSubfolder === IMPORTED_DIR_NAME) continue;

    candidates.push({
      absolutePath: realAbsolute,
      relativePath,
      firstLevelSubfolder,
    });
  }

  return candidates;
}

export async function getTasksImportStatus(projectRootPath: string): Promise<ImportStatus> {
  log.debug({ projectRootPath }, "Resolving tasks import status");
  const tasksDir = await resolveTasksDir(projectRootPath);
  if (!tasksDir) {
    return { available: false, candidateCount: 0, subfolders: [] };
  }

  const candidates = await collectCandidates(tasksDir);
  const subfolders = Array.from(new Set(candidates.map((c) => c.firstLevelSubfolder))).sort();

  return {
    available: candidates.length > 0,
    candidateCount: candidates.length,
    subfolders,
  };
}

function parseTitleAndBody(raw: string): { title: string; body: string } {
  // Strip leading blank lines.
  let cursor = 0;
  while (cursor < raw.length) {
    const nextNewline = raw.indexOf("\n", cursor);
    const segment = nextNewline === -1 ? raw.slice(cursor) : raw.slice(cursor, nextNewline);
    if (segment.trim() !== "") break;
    if (nextNewline === -1) {
      cursor = raw.length;
      break;
    }
    cursor = nextNewline + 1;
  }

  if (cursor >= raw.length) return { title: "", body: "" };

  const newlineIdx = raw.indexOf("\n", cursor);
  const titleRaw = newlineIdx === -1 ? raw.slice(cursor) : raw.slice(cursor, newlineIdx);
  const title =
    titleRaw.length > MAX_TITLE_LENGTH
      ? `${titleRaw.slice(0, TITLE_TRUNCATE_TO)}...`
      : titleRaw.trim();

  const body = newlineIdx === -1 ? "" : raw.slice(newlineIdx + 1).trim();

  return { title, body };
}

async function targetExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function moveToImported(args: {
  tasksDir: string;
  absolutePath: string;
  relativePath: string;
}): Promise<void> {
  const { tasksDir, absolutePath, relativePath } = args;
  const targetDir = path.join(tasksDir, IMPORTED_DIR_NAME, path.dirname(relativePath));
  await fs.mkdir(targetDir, { recursive: true });

  const targetPath = path.join(tasksDir, IMPORTED_DIR_NAME, relativePath);

  // POSIX fs.rename silently overwrites an existing target file. Pre-check so
  // an existing import is preserved and the new file gets a unique suffix.
  if (!(await targetExists(targetPath))) {
    try {
      await fs.rename(absolutePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
        throw error;
      }
    }
  }

  // Collision: append unix timestamp before .md extension.
  const ext = path.extname(targetPath);
  const stem = targetPath.slice(0, targetPath.length - ext.length);
  const fallbackPath = `${stem}-${Date.now()}${ext}`;
  await fs.rename(absolutePath, fallbackPath);
}

export async function importTasksFromFolder(args: {
  projectId: string;
  projectRootPath: string;
}): Promise<ImportResult> {
  const { projectId, projectRootPath } = args;
  const result: ImportResult = { created: 0, skipped: 0, errors: [], taskIds: [] };

  const tasksDir = await resolveTasksDir(projectRootPath);
  if (!tasksDir) {
    log.warn({ projectId, projectRootPath }, "Task import called with no tasks/ dir");
    return result;
  }

  const candidates = await collectCandidates(tasksDir);
  log.info({ projectId, candidateCount: candidates.length }, "Task import started");

  for (const candidate of candidates) {
    const reportPath = path.join("tasks", candidate.relativePath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(candidate.absolutePath);
    } catch (error) {
      log.warn(
        { file: reportPath, error: (error as Error).message },
        "Skipping file (stat failed)",
      );
      result.skipped++;
      result.errors.push({ file: reportPath, reason: "read_failed" });
      continue;
    }

    if (stat.size > MAX_FILE_BYTES) {
      log.warn({ file: reportPath, size: stat.size }, "Skipping file (too large)");
      result.skipped++;
      result.errors.push({ file: reportPath, reason: "too_large" });
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(candidate.absolutePath, "utf-8");
    } catch (error) {
      log.warn(
        { file: reportPath, error: (error as Error).message },
        "Skipping file (read failed)",
      );
      result.skipped++;
      result.errors.push({ file: reportPath, reason: "read_failed" });
      continue;
    }

    const { title, body } = parseTitleAndBody(raw);
    if (!title) {
      log.warn({ file: reportPath, reason: "empty" }, "Skipping file");
      result.skipped++;
      result.errors.push({ file: reportPath, reason: "empty" });
      continue;
    }

    log.debug({ file: reportPath, title: title.slice(0, 80) }, "Importing file");

    const provenancePrefix = `> Imported from ${reportPath}\n\n`;
    const description = body ? `${provenancePrefix}${body}` : provenancePrefix.trimEnd();

    const created = createTask({
      projectId,
      title,
      description,
      useSubagents: true,
      skipReview: false,
      planTests: false,
      maxReviewIterations: 3,
      tags: [candidate.firstLevelSubfolder],
      attachments: [],
      priority: 0,
      autoMode: true,
      isFix: false,
      plannerMode: "fast",
      paused: false,
    });

    if (!created) {
      log.error({ file: reportPath }, "createTask returned undefined");
      result.skipped++;
      result.errors.push({ file: reportPath, reason: "read_failed" });
      continue;
    }

    try {
      await moveToImported({
        tasksDir,
        absolutePath: candidate.absolutePath,
        relativePath: candidate.relativePath,
      });
    } catch (error) {
      log.error({ file: reportPath, error: (error as Error).message }, "Move to .imported failed");
      result.errors.push({ file: reportPath, reason: "move_failed" });
      // Task was created — count it, even though move failed. User can re-run.
    }

    result.created++;
    result.taskIds.push(created.id);
  }

  log.info(
    {
      projectId,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length,
    },
    "Task import completed",
  );

  return result;
}
