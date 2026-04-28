import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropZone } from "../drop-zone";

async function flushPromises() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("DropZone", () => {
  it("renders default label", () => {
    render(<DropZone onFiles={vi.fn()} />);
    expect(screen.getByText(/drag files/i)).toBeInTheDocument();
  });

  it("renders custom label", () => {
    render(<DropZone onFiles={vi.fn()} label="Drop here" />);
    expect(screen.getByText("Drop here")).toBeInTheDocument();
  });

  it("renders children when provided", () => {
    render(
      <DropZone onFiles={vi.fn()}>
        <span data-testid="custom">Custom content</span>
      </DropZone>,
    );
    expect(screen.getByTestId("custom")).toBeInTheDocument();
  });

  it("calls onFiles with File[] when files are dropped", async () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole("region");
    const file = new File(["data"], "test.txt", { type: "text/plain" });
    const dropEvent = new Event("drop", { bubbles: true }) as unknown as DragEvent & {
      dataTransfer: { files: FileList };
    };
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [file] },
    });
    zone.dispatchEvent(dropEvent);
    await flushPromises();
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("does not call onFiles on empty drop", async () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole("region");
    const dropEvent = new Event("drop", { bubbles: true }) as unknown as DragEvent & {
      dataTransfer: { files: FileList };
    };
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [] },
    });
    zone.dispatchEvent(dropEvent);
    await flushPromises();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("traverses webkitGetAsEntry for folder drop (recursive)", async () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole("region");

    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });

    const fileEntryA = {
      isFile: true,
      isDirectory: false,
      name: "a.txt",
      fullPath: "/folder/a.txt",
      file(cb: (f: File) => void) {
        cb(fileA);
      },
    };
    const fileEntryB = {
      isFile: true,
      isDirectory: false,
      name: "b.txt",
      fullPath: "/folder/nested/b.txt",
      file(cb: (f: File) => void) {
        cb(fileB);
      },
    };
    const nestedDir = {
      isFile: false,
      isDirectory: true,
      name: "nested",
      fullPath: "/folder/nested",
      createReader() {
        let done = false;
        return {
          readEntries(cb: (entries: unknown[]) => void) {
            if (done) return cb([]);
            done = true;
            cb([fileEntryB]);
          },
        };
      },
    };
    const rootDir = {
      isFile: false,
      isDirectory: true,
      name: "folder",
      fullPath: "/folder",
      createReader() {
        let done = false;
        return {
          readEntries(cb: (entries: unknown[]) => void) {
            if (done) return cb([]);
            done = true;
            cb([fileEntryA, nestedDir]);
          },
        };
      },
    };

    const item = {
      kind: "file",
      webkitGetAsEntry: () => rootDir,
    };

    const dropEvent = new Event("drop", { bubbles: true }) as unknown as DragEvent;
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { items: [item], files: [] },
    });
    zone.dispatchEvent(dropEvent);
    await flushPromises();
    await flushPromises();
    expect(onFiles).toHaveBeenCalledTimes(1);
    const passed = onFiles.mock.calls[0][0] as File[];
    expect(passed).toHaveLength(2);
    expect(passed.map((f) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("applies hover class on dragOver and removes on dragLeave", () => {
    render(<DropZone onFiles={vi.fn()} />);
    const zone = screen.getByRole("region");
    fireEvent.dragOver(zone, { preventDefault: vi.fn() });
    expect(zone.className).toContain("border-primary/60");
    fireEvent.dragLeave(zone);
    expect(zone.className).toContain("border-border");
  });

  it("has accessible aria-label", () => {
    render(<DropZone onFiles={vi.fn()} label="Upload area" />);
    expect(screen.getByLabelText("Upload area")).toBeInTheDocument();
  });

  it("merges className", () => {
    render(<DropZone onFiles={vi.fn()} className="custom" />);
    expect(screen.getByRole("region")).toHaveClass("custom");
  });
});
