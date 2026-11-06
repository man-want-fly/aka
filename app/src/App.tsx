import { useEffect, useRef, useState } from "react";
import { MarketPage } from "./pages/market/MarketPage";
import { CatalogPage } from "./pages/catalog/CatalogPage";
import { WorkbenchPage } from "./pages/workbench/WorkbenchPage";
import { ipc, isTauriRuntime } from "./lib/ipc";
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

  // 取证落地页：release 性能线（P 线）必须直接进工作台，
  // 否则行情页会把 S2 套件锁掉（sessionStorage `aka.s2.diag.once`）。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    (async () => {
      try {
        if ((await ipc.diagTarget()) !== "s2") return;
        if (window.location.hash.startsWith("#/workbench")) return;
        window.location.hash = "#/workbench";
        setLocation({ route: "workbench", code: null });
      } catch {
        // 非取证运行：命令异常不影响正常路由
      }
    })();
  }, []);

  const navigate = (key: Route) => {
    window.location.hash = `#/${key}`;
    setLocation({ route: key, code: null });
  };

  const openTimer = useRef<number | null>(null);

  /** S-01.01-03：行情行点击 → 工作台，单窗口，代码进路由。
   * 50ms 合并窗口：连续快速点击多行时只打开最后一只（AC-01.01-04（补1）），
   * 避免工作台报价头闪烁或出现双份。 */
  const openSecurity = (code: string) => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      window.location.hash = `#/workbench/${encodeURIComponent(code)}`;
      setLocation({ route: "workbench", code });
    }, 50);
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
