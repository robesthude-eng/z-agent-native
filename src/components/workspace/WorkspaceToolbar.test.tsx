import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceToolbar } from "./WorkspaceToolbar";

function mount() {
  const refresh = vi.fn();
  const close = vi.fn();
  const start = vi.fn();
  const outside = vi.fn();
  function Harness() {
    const [filter, setFilter] = useState("");
    return (
      <>
        <WorkspaceToolbar
          treeCount={7}
          filter={filter}
          loading={false}
          onFilterChange={setFilter}
          onSearchStart={start}
          onRefresh={refresh}
          onClose={close}
        />
        <output data-testid="filter">{filter}</output>
        <button type="button" onClick={() => outside(filter)}>
          Outside
        </button>
      </>
    );
  }
  render(<Harness />);
  return { refresh, close, start, outside };
}

describe("compact workspace search", () => {
  it("starts with exactly search, refresh and close; no search row", () => {
    const { refresh, close } = mount();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("banner").querySelectorAll("button")).toHaveLength(
      3,
    );
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Закрыть файлы проекта" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it("opens and focuses the search, switches to files, and accepts typing", () => {
    const { start } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Поиск файлов" }));
    const input = screen.getByRole("searchbox", { name: "Поиск файлов" });
    expect(input).toHaveFocus();
    expect(start).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: "index" } });
    fireEvent.pointerDown(input);
    expect(screen.getByTestId("filter")).toHaveTextContent("index");
    expect(input).toBeInTheDocument();
  });
  it("closes with X, clears the filter and restores keyboard focus", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Поиск файлов" }));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "missing" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Закрыть поиск файлов" }),
    );
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Поиск файлов" })).toHaveFocus();
  });
  it("closes on an outside tap without taking focus away from its target", async () => {
    const { outside } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Поиск файлов" }));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "index" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(outside).toHaveBeenCalledWith("index");
    await waitFor(() =>
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("filter")).toBeEmptyDOMElement();
  });
  it("closes with Escape and restores the search trigger", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Поиск файлов" }));
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Поиск файлов" })).toHaveFocus();
  });
});
