import { useEffect, useState } from "react";
import { MarketPage } from "./pages/market/MarketPage";
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

type Route = "workbench" | "market" | "catalog";

interface Location {
  route: Route;
  /** `#/workbench/<code>` 携带的标的；其余路由为 null */
  code: string | null;
}

/** 默认落地页 = 行情列表（S-01.01-01：打开应用第一屏就是样本全量行情表）。 */
const routeFromHash = (): Location => {
  const hash = window.location.hash;
  if (hash.startsWith("#/catalog")) return { route: "catalog", code: null };
  const match = hash.match(/^#\/workbench(?:\/([^/?#]+))?/);
  if (match) {
    return {
      route: "workbench",
      code: match[1] ? decodeURIComponent(match[1]) : null,
    };
  }
  return { route: "market", code: null };
};

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [colorMode, setColorMode] = useState<ColorMode>(loadColorMode);
  const [location, setLocation] = useState<Location>(routeFromHash);

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
    const onHash = () => setLocation(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (key: Route) => {
    window.location.hash = `#/${key}`;
    setLocation({ route: key, code: null });
  };

  /** S-01.01-03：行情行点击 → 工作台，单窗口，代码进路由。 */
  const openSecurity = (code: string) => {
    window.location.hash = `#/workbench/${encodeURIComponent(code)}`;
    setLocation({ route: "workbench", code });
  };

  if (location.route === "catalog") {
    return <CatalogPage onNavigate={navigate} />;
  }

  if (location.route === "market") {
    return (
      <MarketPage onNavigate={navigate} onOpenSecurity={openSecurity} />
    );
  }

  return (
    <WorkbenchPage
      initialCode={location.code}
      themeMode={themeMode}
      onThemeMode={setThemeMode}
      colorMode={colorMode}
      onColorMode={setColorMode}
      onNavigate={navigate}
    />
  );
}
