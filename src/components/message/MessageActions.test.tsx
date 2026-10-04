import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "./MessageActions";
import { copyText } from "@/lib/clipboard";
vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(true),
}));

describe("icon-only message controls", () => {
  it("offers only copy and edit for a user message, with accessible names", async () => {
    const edit = vi.fn();
    const { container } = render(
      <MessageActions
        messageRole="user"
        visibleText="Привет"
        isLatestTurn={false}
        isStreaming={false}
        onRetry={vi.fn()}
        onEditAndResend={edit}
        showEditButton
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(container.textContent).toBe("");
    const editButton = screen.getByRole("button", {
      name: "Изменить сообщение",
    });
    expect(editButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(editButton);
    expect(edit).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    });
    expect(copyText).toHaveBeenCalledWith("Привет");
    expect(screen.getByRole("button", { name: "Скопировано" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ответв/i })).toBeNull();
  });
  it("retains retry for the latest assistant response as an icon, not a caption", () => {
    const retry = vi.fn();
    const { container } = render(
      <MessageActions
        messageRole="assistant"
        visibleText="Готово"
        isLatestTurn
        isStreaming={false}
        onRetry={retry}
        showEditButton={false}
      />,
    );
    expect(container.textContent).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "Перегенерировать ответ" }),
    );
    expect(retry).toHaveBeenCalledOnce();
  });
});
