import { createRoot } from "react-dom/client";
import App from "./App";
import { clearSessionParams } from "./features/workbench/model";
import "./styles/tokens.css";
import "./styles/app.css";

// 桌面端每次启动都应落在默认落地页（S-01.01-01：第一屏就是行情表）。
// WKWebView 会恢复上次的 hash，若不清掉，上一次取证停在 #/workbench 时，
// 工作台的 S2 套件会抢在路由重定向之前启动，行情页的 E-01 套件则根本不会挂载。
if (window.location.hash) {
  window.history.replaceState(null, "", window.location.pathname);
}

// S-02.05-02「重启回默认」由代码保证，不依赖 WKWebView 的 sessionStorage 进程存活语义。
// 只在新文档时清：同进程内的页面重载仍属同一会话，参数应保留（sessionStorage 的本义）。
// 只清参数记忆，主题走 localStorage，跨进程保留。
const navigation = performance.getEntriesByType("navigation")[0] as
  | PerformanceNavigationTiming
  | undefined;
if (navigation?.type !== "reload") {
  clearSessionParams();
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("缺少 #root 挂载点");
}

createRoot(root).render(<App />);
