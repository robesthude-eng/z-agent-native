import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../api/eventGuards";
import PartView from "./PartView";

describe("ordinary assistant text is not a provider error", () => {
  it("preserves Markdown research answers with OpenCode links", () => {
    const { container } = render(
      <PartView
        part={{
          type: "text",
          text: "## Документация\n\nОткройте [OpenCode](https://opencode.ai/docs/zen/).",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Документация" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "OpenCode" }).getAttribute("href"),
    ).toBe("https://opencode.ai/docs/zen/");
    expect(container.textContent).not.toContain("недоступна у провайдера");
  });

  it.each([
    '`{"model":"example-model"}`',
    "Model is unavailable — пример текста ошибки.",
    "Free promotion has ended — цитата из документации OpenCode Go.",
  ])("preserves examples and quoted errors: %s", (text) => {
    const { container } = render(<PartView part={{ type: "text", text }} />);
    expect(container.textContent).toBe(text.replaceAll("`", ""));
    expect(container.textContent).not.toContain("недоступна у провайдера");
  });

  it("still maps actual structured provider failures to a public error", () => {
    expect(
      errorMessage({
        data: { message: "Upstream request failed: Model is unavailable." },
      }),
    ).toMatch(/недоступна у провайдера/);
  });
});
