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
});
