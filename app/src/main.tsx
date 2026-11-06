import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

// 桌面端每次启动都应落在默认落地页（S-01.01-01：第一屏就是行情表）。
// WKWebView 会恢复上次的 hash，若不清掉，上一次取证停在 #/workbench 时，
// 工作台的 S2 套件会抢在路由重定向之前启动，行情页的 E-01 套件则根本不会挂载。
if (window.location.hash) {
  window.history.replaceState(null, "", window.location.pathname);
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("缺少 #root 挂载点");
}

createRoot(root).render(<App />);
