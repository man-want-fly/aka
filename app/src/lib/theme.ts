export type ThemeMode = "dark" | "light" | "system";
export type ColorMode = "redUp" | "greenUp";

const THEME_KEY = "aka.theme";
const COLOR_KEY = "aka.colorMode";

export function loadThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "dark" || saved === "light" || saved === "system"
    ? saved
    : "dark";
}

export function loadColorMode(): ColorMode {
  return localStorage.getItem(COLOR_KEY) === "greenUp" ? "greenUp" : "redUp";
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(mode: ThemeMode, colorMode: ColorMode): void {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.colormode = colorMode;
  localStorage.setItem(THEME_KEY, mode);
  localStorage.setItem(COLOR_KEY, colorMode);
}
