import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolPart } from "../api/types";
import ToolCard from "./ToolCard";

const part = (
  status: string,
  metadata?: Record<string, unknown>,
): ToolPart => ({
  type: "tool",
  tool: "bash",
  state: { status, input: { command: "ls" }, metadata },
});

const isOpen = (container: HTMLElement) =>
  container.firstElementChild?.className.includes("bg-card/60") ?? false;

describe("tool card auto-expansion", () => {
  it("stays collapsed while queued", () => {
    expect(isOpen(render(<ToolCard part={part("pending")} />).container)).toBe(
      false,
    );
  });
  it("opens a running command at once, but not an instant tool with nothing to show", () => {
    expect(isOpen(render(<ToolCard part={part("running")} />).container)).toBe(
      true,
    );
    const read = { ...part("running"), tool: "read" };
    expect(isOpen(render(<ToolCard part={read} />).container)).toBe(false);
  });
  it("opens an instant tool as soon as output or a streamed file body arrives", () => {
    const read = (metadata?: Record<string, unknown>) => ({
      ...part("running", metadata),
      tool: "write",
    });
    const { container, rerender } = render(<ToolCard part={read()} />);
    expect(isOpen(container)).toBe(false);
    rerender(<ToolCard part={read({ output: "hello" })} />);
    expect(isOpen(container)).toBe(true);
  });
  it("opens on error", () => {
    expect(isOpen(render(<ToolCard part={part("error")} />).container)).toBe(
      true,
    );
  });
});
