import { describe, it, expect } from "vitest";
import {
  formatAttachmentSize,
  readDroppedFiles,
  summarizeAttachments,
  traverseDataTransferItems,
} from "@/lib/attachmentTransfer";

describe("formatAttachmentSize", () => {
  it("returns 0 B for zero or invalid", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(NaN)).toBe("0 B");
  });
  it("formats bytes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
  });
  it("formats KB and MB with reasonable precision", () => {
    expect(formatAttachmentSize(2048)).toBe("2.00 KB");
    expect(formatAttachmentSize(1_500_000)).toMatch(/MB$/);
  });
});

describe("summarizeAttachments", () => {
  it("singular vs plural", () => {
    expect(summarizeAttachments([{ size: 1024 }])).toMatch(/^1 file ·/);
    expect(summarizeAttachments([{ size: 1 }, { size: 2 }])).toMatch(/^2 files ·/);
  });
  it("zero files yields 0 B", () => {
    expect(summarizeAttachments([])).toBe("0 files · 0 B");
  });
});

describe("readDroppedFiles", () => {
  it("returns files when items list is absent", async () => {
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const out = await readDroppedFiles({ files: [file] });
    expect(out).toEqual([file]);
  });

  it("returns empty when neither items nor files present", async () => {
    const out = await readDroppedFiles({});
    expect(out).toEqual([]);
  });

  it("falls back to files when items have no webkitGetAsEntry", async () => {
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const out = await readDroppedFiles({
      items: [{ kind: "file" }],
      files: [file],
    });
    expect(out).toEqual([file]);
  });
});

describe("traverseDataTransferItems", () => {
  it("recursively walks directory entries", async () => {
    const fileA = new File(["a"], "a.txt");
    const fileB = new File(["b"], "b.txt");

    const fileEntryA = {
      kind: "file" as const,
      isFile: true,
      isDirectory: false,
      name: "a.txt",
      fullPath: "/r/a.txt",
      file(cb: (f: File) => void) {
        cb(fileA);
      },
    };
    const fileEntryB = {
      kind: "file" as const,
      isFile: true,
      isDirectory: false,
      name: "b.txt",
      fullPath: "/r/n/b.txt",
      file(cb: (f: File) => void) {
        cb(fileB);
      },
    };
    const nested = {
      isFile: false,
      isDirectory: true,
      name: "n",
      fullPath: "/r/n",
      createReader() {
        let done = false;
        return {
          readEntries(cb: (e: unknown[]) => void) {
            if (done) return cb([]);
            done = true;
            cb([fileEntryB]);
          },
        };
      },
    };
    const root = {
      isFile: false,
      isDirectory: true,
      name: "r",
      fullPath: "/r",
      createReader() {
        let done = false;
        return {
          readEntries(cb: (e: unknown[]) => void) {
            if (done) return cb([]);
            done = true;
            cb([fileEntryA, nested]);
          },
        };
      },
    };

    const out = await traverseDataTransferItems([{ kind: "file", webkitGetAsEntry: () => root }]);
    expect(out.map((f) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("skips non-file items", async () => {
    const out = await traverseDataTransferItems([{ kind: "string" }]);
    expect(out).toEqual([]);
  });
});
