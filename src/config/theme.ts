export type Theme = "light" | "mid" | "dark";

const KEY = "z-agent:theme";

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const saved = localStorage.getItem(KEY) as Theme | null;
  if (saved === "light" || saved === "mid" || saved === "dark") return saved;
  // Respect OS preference on first visit.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

const THEME_COLORS: Record<Theme, string> = {
  dark: "#111214",
  mid: "#26282c",
  light: "#f7f7f5",
};

/** Порядок переключения: тёмная → средняя → светлая → тёмная */
export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "mid" : theme === "mid" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEY, theme);
  // Keep the browser chrome (address bar) color in sync.
  const color = THEME_COLORS[theme];
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    m.setAttribute("content", color);
  });
}
