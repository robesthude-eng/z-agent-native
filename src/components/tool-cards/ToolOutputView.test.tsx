import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolOutputView } from "./ToolOutputView";
vi.mock("../../lib/useSmoothText", () => ({
  useSmoothStreamingText: (text: string) => text,
}));

describe("tool output lifecycle", () => {
  it("distinguishes waiting from completed empty output", () => {
    const { rerender } = render(
      <ToolOutputView
        part={{ type: "tool", tool: "bash", state: { status: "running" } }}
      />,
    );
    expect(screen.getByText("Ожидаем вывод команды…")).toBeTruthy();
    expect(screen.queryByText("(нет вывода)")).toBeNull();
    rerender(
      <ToolOutputView
        part={{ type: "tool", tool: "bash", state: { status: "completed" } }}
      />,
    );
    expect(screen.getByText("(нет вывода)")).toBeTruthy();
  });
  it("renders incremental metadata output and replaces it with final output", () => {
    const { container, rerender } = render(
      <ToolOutputView
        part={{
          type: "tool",
          tool: "bash",
          state: { status: "running", metadata: { output: "stdout:\nfirst" } },
        }}
      />,
    );
    expect(container.textContent).toContain("first");
    rerender(
      <ToolOutputView
        part={{
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            output: "exit=0\nstdout:\nfirst\nlast",
            metadata: { output: "stdout:\nfirst" },
          },
        }}
      />,
    );
    expect(container.textContent).toContain("last");
    expect(container.textContent).toContain("exit=0");
  });

  it("follows the end of the output while running, unless the user scrolled up", () => {
    const heights = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(500);
    const make = (output: string, status = "running") => (
      <ToolOutputView
        part={{
          type: "tool",
          tool: "bash",
          state: { status, metadata: { output } },
        }}
      />
    );
    const { container, rerender } = render(make("one"));
    const pre = container.querySelector("pre") as HTMLElement;
    expect(pre.scrollTop).toBe(500);
    pre.scrollTop = 0;
    pre.dispatchEvent(new Event("scroll", { bubbles: true }));
    rerender(make("one\ntwo"));
    expect(pre.scrollTop).toBe(0);
    heights.mockRestore();
  });
  it("shows streamed output at once, without a typing delay", () => {
    const { container } = render(
      <ToolOutputView
        part={{
          type: "tool",
          tool: "write",
          state: {
            status: "running",
            metadata: { output: "x".repeat(3000), streamingArgs: true },
          },
        }}
      />,
    );
    expect(container.textContent).toContain("x".repeat(3000));
  });
});
