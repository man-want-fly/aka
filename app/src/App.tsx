import { useEffect, useRef, useState } from "react";
import { MarketPage } from "./pages/market/MarketPage";
import { IndexPage } from "./pages/indices/IndexPage";
import { CatalogPage } from "./pages/catalog/CatalogPage";
import { WorkbenchPage } from "./pages/workbench/WorkbenchPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { DatasourcePage } from "./pages/datasource/DatasourcePage";
import { InstallPage } from "./pages/install/InstallPage";
import { DatasetErrorPage } from "./pages/dataset/DatasetErrorPage";
import { ipc, isTauriRuntime } from "./lib/ipc";
import type { DatasetIntegrityDto } from "./lib/types";
import { loadDisplaySettings } from "./lib/settings";
import {
  applyTheme,
  loadColorMode,
  loadThemeMode,
  systemPrefersDark,
  type ColorMode,
  type ThemeMode,
} from "./lib/theme";

type Route =
  | "workbench"
  | "market"
  | "indices"
  | "catalog"
  | "settings"
  | "datasource"
  | "install";

interface Location {
  route: Route;
  /** `#/workbench/<code>` 携带的标的；其余路由为 null */
  code: string | null;
}

/** 默认落地页 = 行情列表（S-01.01-01：打开应用第一屏就是样本全量行情表）。 */
const routeFromHash = (): Location => {
  const hash = window.location.hash;
  if (hash.startsWith("#/indices")) return { route: "indices", code: null };
  if (hash.startsWith("#/catalog")) return { route: "catalog", code: null };
  if (hash.startsWith("#/settings")) return { route: "settings", code: null };
  if (hash.startsWith("#/datasource")) return { route: "datasource", code: null };
  if (hash.startsWith("#/install")) return { route: "install", code: null };
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

  // S-08.02-03：启动校验 → 失败即全屏错误卡；「只读浏览」为进程内状态，不跨启动记忆。
  const [integrity, setIntegrity] = useState<DatasetIntegrityDto | null>(null);
  const [integrityReady, setIntegrityReady] = useState(!isTauriRuntime());
  const [readOnly, setReadOnly] = useState(false);
  const [readOnlyHint, setReadOnlyHint] = useState<string | null>(null);

  /** 重跑校验；恢复 ok 时退出只读并落到行情页（AC-08.02-03（补4））。 */
  const recheckIntegrity = async (): Promise<DatasetIntegrityDto> => {
    const next = await ipc.datasetIntegrity();
    setIntegrity(next);
    if (next.state === "ok") {
      setReadOnly(false);
      void ipc.datasetSetReadonly(false).catch(() => undefined);
      window.location.hash = "#/market";
      setLocation({ route: "market", code: null });
    }
    return next;
  };

  const enterReadOnly = async () => {
    await ipc.datasetSetReadonly(true);
    setReadOnly(true);
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let alive = true;
    void (async () => {
      try {
        const dto = await ipc.datasetIntegrity();
        if (alive) setIntegrity(dto);
      } catch {
        // 校验命令不可用时不阻塞主界面（浏览器预览 / 旧构建）。
      } finally {
        if (alive) setIntegrityReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 只读红条占位：页面主体整体下移 30px，避免遮挡页头。
  useEffect(() => {
    if (readOnly) document.documentElement.dataset.readonly = "1";
    else delete document.documentElement.dataset.readonly;
    return () => {
      delete document.documentElement.dataset.readonly;
    };
  }, [readOnly]);

  const readonlyHintTimer = useRef<number | null>(null);
  const refuseWrite = () => {
    setReadOnlyHint("数据集不可写：本次修改未生效");
    if (readonlyHintTimer.current !== null) window.clearTimeout(readonlyHintTimer.current);
    readonlyHintTimer.current = window.setTimeout(() => setReadOnlyHint(null), 4000);
  };
  useEffect(
    () => () => {
      if (readonlyHintTimer.current !== null) window.clearTimeout(readonlyHintTimer.current);
    },
    [],
  );

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

  // S-06.02-01：启动即恢复密度（默认紧凑）；读取失败不影响首屏。
  useEffect(() => {
    void loadDisplaySettings().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onHash = () => setLocation(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 取证落地页：release 性能线（P 线）必须直接进工作台，
  // 否则行情页会把 S2 套件锁掉（sessionStorage `aka.s2.diag.once`）。
  // `market` 是反向：上一次取证把 hash 停在 #/workbench 时，行情页的 E-01 套件不会启动。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    (async () => {
      try {
        const target = await ipc.diagTarget();
        // 存储语义探针：验证 WKWebView 下 sessionStorage 是否跨进程存活（两进程各跑一次）
        if (target.startsWith("ssprobe")) {
          const key = "aka.ss.probe.v1";
          const boot = Number(window.localStorage.getItem("aka.ss.probe.boot") ?? "0");
          await ipc.diagWriteNamed(
            "ss-probe.json",
            JSON.stringify(
              {
                session: window.sessionStorage.getItem(key),
                local: window.localStorage.getItem(key),
                boot,
                url: window.location.href,
                at: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
          window.sessionStorage.setItem(key, "A");
          window.localStorage.setItem(key, "L");
          window.localStorage.setItem("aka.ss.probe.boot", String(boot + 1));
          return;
        }
        // S-02.04-01 抽屉取证：直接进工作台；先占住 S2 的 once 位，避免 S2 套件抢跑。
        if (target === "drawer") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.removeItem("aka.drawer.diag.done");
          if (window.location.hash.startsWith("#/workbench")) return;
          window.location.hash = "#/workbench";
          setLocation({ route: "workbench", code: null });
          return;
        }
        // S-03.01-04 / S-03.02-01 / S-03.03-02 目录侧取证：直接进目录页。
        if (target === "s030104" || target === "s030201" || target === "s030302-catalog") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          if (target === "s030104") {
            window.localStorage.removeItem("aka.last.code");
          } else {
            window.localStorage.setItem("aka.last.code", "600519.SH");
          }
          if (window.location.hash.startsWith("#/catalog")) return;
          window.location.hash = "#/catalog";
          setLocation({ route: "catalog", code: null });
          return;
        }
        // S-03.03-02 工作台侧取证：图例「?」与抽屉来源。
        if (target === "s030302") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          if (window.location.hash.startsWith("#/workbench")) return;
          window.location.hash = "#/workbench";
          setLocation({ route: "workbench", code: null });
          return;
        }
        // S-06.03-01 关于页取证：直接进设置页。
        if (target === "s060301" || target === "s060302") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          sessionStorage.setItem("aka.s0602.diag.done", "1");
          if (window.location.hash.startsWith("#/settings")) return;
          window.location.hash = "#/settings";
          setLocation({ route: "settings", code: null });
          return;
        }
        // S-08.02-02 计算错误态取证：直接进工作台。
        if (target === "s080202") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          sessionStorage.setItem("aka.s0602.diag.done", "1");
          if (window.location.hash.startsWith("#/workbench")) return;
          window.location.hash = "#/workbench";
          setLocation({ route: "workbench", code: null });
          return;
        }
        // S-07.01-02 数据源健康检查取证：直接进数据源页。
        if (target === "s070102") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          sessionStorage.setItem("aka.s0602.diag.done", "1");
          if (window.location.hash.startsWith("#/datasource")) return;
          window.location.hash = "#/datasource";
          setLocation({ route: "datasource", code: null });
          return;
        }
        // S-03.01-01 指标目录取证：直接进目录页，并占住 S2/抽屉的 once 位。
        if (target === "catalog") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          if (window.location.hash.startsWith("#/catalog")) return;
          window.location.hash = "#/catalog";
          setLocation({ route: "catalog", code: null });
          return;
        }
        // S-02.05-01 参数面板取证 / S-02.05-02 恢复默认取证 / S-01.02 自选取证 / S-02.07 图表取证 / S-02.03 副图取证 / S-02.02-02 复权切换 / S-02.01-01 报价头：进工作台，占住其它套件的 once 位。
        if (
          target === "s20501" ||
          target === "s20801" ||
          target === "s205" ||
          target === "restart" ||
          target === "s207" ||
          target === "s203" ||
          target === "s20202" ||
          target === "s20101" ||
          target === "s010301" ||
          target.startsWith("watchlist")
        ) {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          if (window.location.hash.startsWith("#/workbench")) return;
          window.location.hash = "#/workbench";
          setLocation({ route: "workbench", code: null });
          return;
        }
        // AC-02.04-01 跨页核对：先到工作台打开抽屉，再去指标目录比对计数。
        if (target === "xpage") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          if (window.location.hash.startsWith("#/workbench")) return;
          window.location.hash = "#/workbench";
          setLocation({ route: "workbench", code: null });
          return;
        }
        // S-01.02-01 星标取证 / S-08.02-04 无定义值取证：先进行情页，再由页面内套件切工作台。
        if (target === "s010201" || target === "s080204") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          sessionStorage.setItem("aka.s0602.diag.done", "1");
          if (window.location.hash.startsWith("#/market")) return;
          window.location.hash = "#/market";
          setLocation({ route: "market", code: null });
          return;
        }
        // S-06.02-01 密度与格式取证：直接进设置页，占住其它套件的 once 位。
        if (target === "s0602") {
          sessionStorage.setItem("aka.s2.diag.once", "1");
          sessionStorage.setItem("aka.drawer.diag.done", "1");
          sessionStorage.setItem("aka.catalog.diag.done", "1");
          if (window.location.hash.startsWith("#/settings")) return;
          window.location.hash = "#/settings";
          setLocation({ route: "settings", code: null });
          return;
        }
        if (target === "market") {
          sessionStorage.removeItem("aka.s2.diag.once");
          if (window.location.hash.startsWith("#/market")) return;
          window.location.hash = "#/market";
          setLocation({ route: "market", code: null });
          return;
        }
        // W-89：s070503 也必须在工作台挂载才可能落 dump；缺这条会 240s 超时且一个文件都没有。
        if (target !== "s2" && target !== "s070503") return;
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
      try {
        window.localStorage.setItem("aka.last.code", code);
      } catch {
        // 最近标的只用于目录页引导，不影响路由
      }
      window.location.hash = `#/workbench/${encodeURIComponent(code)}`;
      setLocation({ route: "workbench", code });
    }, 50);
  };

  // 首屏校验完成前不渲染主界面，避免错误卡闪一下再出现。
  if (isTauriRuntime() && !integrityReady) {
    return (
      <div className="dataset-boot" data-dataset-boot>
        正在校验数据集…
      </div>
    );
  }

  if (!readOnly && integrity?.state === "blocked") {
    return (
      <DatasetErrorPage
        integrity={integrity}
        onRecheck={recheckIntegrity}
        onEnterReadonly={enterReadOnly}
      />
    );
  }

  const renderPage = () => {
    if (location.route === "catalog") {
      return <CatalogPage onNavigate={navigate} onOpenWorkbench={openSecurity} />;
    }

    if (location.route === "settings") {
      return <SettingsPage onNavigate={navigate} />;
    }

    if (location.route === "datasource") {
      return <DatasourcePage onNavigate={navigate} />;
    }

    if (location.route === "install") {
      return <InstallPage onNavigate={navigate} />;
    }

    if (location.route === "indices") {
      return <IndexPage onNavigate={navigate} />;
    }

    if (location.route === "market") {
      return (
        <MarketPage onNavigate={navigate} onOpenSecurity={openSecurity} readOnly={readOnly} />
      );
    }

    return (
      <WorkbenchPage
        initialCode={location.code}
        themeMode={themeMode}
        onThemeMode={(mode) => (readOnly ? refuseWrite() : setThemeMode(mode))}
        colorMode={colorMode}
        onColorMode={(mode) => (readOnly ? refuseWrite() : setColorMode(mode))}
        onNavigate={navigate}
        readOnly={readOnly}
      />
    );
  };

  return (
    <>
      {readOnly && (
        <div className="readonly-banner" data-readonly-banner role="status">
          <span>仅只读浏览 · 数据集不可写</span>
          {readOnlyHint && <span data-readonly-hint>{readOnlyHint}</span>}
        </div>
      )}
      {renderPage()}
    </>
  );
}
