import { useEffect, useState } from "react";
import { CatalogPage } from "./pages/catalog/CatalogPage";
import { WorkbenchPage } from "./pages/workbench/WorkbenchPage";
import {
  applyTheme,
  loadColorMode,
  loadThemeMode,
  systemPrefersDark,
  type ColorMode,
  type ThemeMode,
} from "./lib/theme";

type Route = "workbench" | "catalog";

const routeFromHash = (): Route =>
  window.location.hash === "#/catalog" ? "catalog" : "workbench";

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [colorMode, setColorMode] = useState<ColorMode>(loadColorMode);
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    applyTheme(themeMode, colorMode);
    if (themeMode !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.dataset.theme = systemPrefersDark() ? "dark" : "light";
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [themeMode, colorMode]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (key: Route) => {
    window.location.hash = `#/${key}`;
    setRoute(key);
  };

  return route === "catalog" ? (
    <CatalogPage onNavigate={navigate} />
  ) : (
    <WorkbenchPage
      themeMode={themeMode}
      onThemeMode={setThemeMode}
      colorMode={colorMode}
      onColorMode={setColorMode}
      onNavigate={navigate}
    />
  );
}
