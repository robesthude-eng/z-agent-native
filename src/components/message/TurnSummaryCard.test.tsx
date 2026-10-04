import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnSummaryCard } from "./TurnSummaryCard";
vi.mock("../AttachmentChip", () => ({
  WorkspaceFileChip: ({ name }: { name: string }) => <span>{name}</span>,
}));
describe("compact turn metadata", () => {
  it("keeps outcome, counts and files accessible in an initially collapsed disclosure", () => {
    render(
      <TurnSummaryCard
        summary={{
          actionsCount: 3,
          changedFiles: ["src/main.js"],
          durationMs: 1000,
          failed: false,
          stopped: false,
          needsInput: false,
          outcomeStatus: "completed",
        }}
        strategyMutated
      />,
    );
    const card = screen.getByTestId("turn-summary-card");
    expect(card.tagName).toBe("DETAILS");
    expect(card.hasAttribute("open")).toBe(false);
    expect(card.querySelector("summary")?.textContent).toContain("Готово");
    expect(card.querySelector("summary")?.textContent).toContain("3");
    expect(card.querySelector("summary")?.textContent).toContain("1");
    expect(card.textContent).toContain("main.js");
  });
});
