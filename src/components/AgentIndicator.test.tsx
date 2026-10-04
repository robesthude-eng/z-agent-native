import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentIndicator } from "./AgentIndicator";

afterEach(() => vi.useRealTimers());
describe("release progress indicator", () => {
  it("is restrained and does not announce the timer on every tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(120000);
    const { container } = render(
      <AgentIndicator
        activity={{
          label: "Обрабатываю запрос",
          detail: "",
          step: 0,
          steps: [],
          startedAt: 60000,
        }}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Обрабатываю запрос");
    expect(screen.getByTitle("Время выполнения").textContent).toBe("1:00");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTitle("Время выполнения").textContent).toBe("1:01");
    expect(status.textContent).not.toContain("1:01");
    expect(container.querySelector(".oc-aura")).toBeNull();
    expect(container.textContent).not.toContain("без внешних действий");
    expect(container.textContent).not.toContain(">_");
  });
  it("renders actual action details without an invented step trail", () => {
    render(
      <AgentIndicator
        activity={{
          label: "Читает файл",
          detail: "src/main.ts",
          step: 1,
          steps: [],
          startedAt: null,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("src/main.ts");
    expect(screen.getByTitle("src/main.ts")).toBeTruthy();
  });
});
