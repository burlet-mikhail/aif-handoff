import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { Textarea } from "../textarea";

function ControlledTextarea({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="Type here" />
  );
}

describe("Textarea", () => {
  it("renders an expand button by default", () => {
    render(<ControlledTextarea />);
    expect(screen.getByRole("button", { name: /expand to fullscreen/i })).toBeInTheDocument();
  });

  it("hides expand button when expandable=false", () => {
    render(<Textarea expandable={false} placeholder="x" />);
    expect(screen.queryByRole("button", { name: /expand to fullscreen/i })).toBeNull();
  });

  it("hides expand button when disabled", () => {
    render(<Textarea disabled placeholder="x" />);
    expect(screen.queryByRole("button", { name: /expand to fullscreen/i })).toBeNull();
  });

  it("opens fullscreen overlay on expand click and preserves value", () => {
    render(<ControlledTextarea initial="hello" />);
    const inline = screen.getByPlaceholderText("Type here") as HTMLTextAreaElement;
    expect(inline.value).toBe("hello");

    fireEvent.click(screen.getByRole("button", { name: /expand to fullscreen/i }));

    const textareas = screen.getAllByPlaceholderText("Type here") as HTMLTextAreaElement[];
    expect(textareas.length).toBe(2);
    expect(textareas.every((t) => t.value === "hello")).toBe(true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("collapses fullscreen on Escape key", () => {
    render(<ControlledTextarea initial="text" />);
    fireEvent.click(screen.getByRole("button", { name: /expand to fullscreen/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape does not reach sibling document listeners while fullscreen open", () => {
    const siblingHandler = vi.fn();
    const onDoc = (e: KeyboardEvent) => {
      if (e.key === "Escape") siblingHandler();
    };
    document.addEventListener("keydown", onDoc);
    try {
      render(<ControlledTextarea />);
      fireEvent.click(screen.getByRole("button", { name: /expand to fullscreen/i }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(siblingHandler).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
  });

  it("collapses fullscreen on collapse button click", () => {
    render(<ControlledTextarea />);
    fireEvent.click(screen.getByRole("button", { name: /expand to fullscreen/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /collapse fullscreen/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toggles fullscreen via Shift+F11 keyboard shortcut", () => {
    render(<ControlledTextarea />);
    const inline = screen.getByPlaceholderText("Type here");

    fireEvent.keyDown(inline, { key: "F11", shiftKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const overlayTextareas = screen.getAllByPlaceholderText("Type here");
    fireEvent.keyDown(overlayTextareas[1], { key: "F11", shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores bare F11 (reserved by macOS)", () => {
    render(<ControlledTextarea />);
    const inline = screen.getByPlaceholderText("Type here");
    fireEvent.keyDown(inline, { key: "F11" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("propagates value changes from fullscreen back to caller", () => {
    render(<ControlledTextarea initial="a" />);
    fireEvent.click(screen.getByRole("button", { name: /expand to fullscreen/i }));
    const overlay = screen.getAllByPlaceholderText("Type here")[1] as HTMLTextAreaElement;

    fireEvent.change(overlay, { target: { value: "ab" } });

    const textareas = screen.getAllByPlaceholderText("Type here") as HTMLTextAreaElement[];
    expect(textareas.every((t) => t.value === "ab")).toBe(true);
  });

  it("invokes caller onKeyDown handler before F11 logic", () => {
    const onKeyDown = vi.fn();
    render(<Textarea onKeyDown={onKeyDown} placeholder="x" />);
    fireEvent.keyDown(screen.getByPlaceholderText("x"), { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("merges containerClassName onto the wrapper", () => {
    const { container } = render(
      <Textarea containerClassName="flex-1 custom-wrap" placeholder="x" />,
    );
    expect(container.firstChild).toHaveClass("flex-1", "custom-wrap", "relative");
  });
});
