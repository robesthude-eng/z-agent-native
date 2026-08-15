import { fireEvent, render, screen, within } from "@testing-library/react";
import { assert, beforeEach, describe, expect, test, vi } from "vitest";
import SettingsPanel from "../components/SettingsPanel";
import { useStore } from "../store/useStore";

vi.mock("../store/useStore");
const mockSetSettingsOpen = vi.fn();
const mockLoadAuth = vi.fn();
let mockState: Record<string, unknown>;

function setState(overrides: Record<string, unknown> = {}) {
  mockState = {
    settingsOpen: true,
    setSettingsOpen: mockSetSettingsOpen,
    authed: {},
    loadAuth: mockLoadAuth,
    currentUser: { role: "admin", email: "admin@example.com" },
    ...overrides,
  };
}
function desktopNav() {
  for (const a of document.querySelectorAll("aside")) if (a.textContent?.includes("Модели")) return a as HTMLElement;
  return document.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  setState();
  (useStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector?: (s: typeof mockState) => unknown) => selector ? selector(mockState) : mockState);
});

describe("SettingsPanel", () => {
  test("renders only native product sections", () => {
    render(<SettingsPanel />);
    expect(screen.getAllByText("Модели").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Внешний вид").length).toBeGreaterThan(0);
    expect(screen.getAllByText("О системе").length).toBeGreaterThan(0);
    expect(screen.queryByText("Саморазвитие")).not.toBeInTheDocument();
  });

  test("does not render when closed", () => {
    setState({ settingsOpen: false });
    render(<SettingsPanel />);
    expect(screen.queryByText("Настройки")).not.toBeInTheDocument();
  });

  test("closes on close button and overlay", () => {
    const { unmount } = render(<SettingsPanel />);
    fireEvent.click(screen.getAllByTitle("Закрыть")[0]);
    expect(mockSetSettingsOpen).toHaveBeenCalledWith(false);
    unmount();
    mockSetSettingsOpen.mockClear();
    render(<SettingsPanel />);
    const overlay = screen.getAllByText("Настройки")[0]?.closest(".overlay");
    assert(overlay);
    fireEvent.click(overlay);
    expect(mockSetSettingsOpen).toHaveBeenCalledWith(false);
  });

  test("shows native architecture in About", () => {
    render(<SettingsPanel />);
    fireEvent.click(within(desktopNav()).getByText("О системе"));
    expect(screen.getByText("Z Agent Native")).toBeInTheDocument();
    expect(screen.getByText(/с собственным runtime/i)).toBeInTheDocument();
  });

  test("filters nav and loads account state when opened", () => {
    render(<SettingsPanel />);
    const nav = desktopNav();
    fireEvent.change(within(nav).getByLabelText("Поиск по настройкам"), { target: { value: "ключ" } });
    expect(within(nav).getByText("Модели")).toBeInTheDocument();
    expect(within(nav).queryByText("О системе")).not.toBeInTheDocument();
    expect(mockLoadAuth).toHaveBeenCalled();
  });
});
