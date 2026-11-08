import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// R-EV-02：commit/dirty 必须构建期注入（typings 见 src/vite-env.d.ts）。
// 禁止在 diag.ts 里手写；define 缺失时降级为空串/true，让 verify:evidence 失败而不是自证通过。
const git = (command: string): string => {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const BUILD_COMMIT = git("git rev-parse HEAD");
const BUILD_DIRTY = git("git status --porcelain") !== "";
const BUILD_AT = new Date().toISOString();

// Tauri 2 约定：固定 1420 端口，构建产物给 src-tauri 的 frontendDist 使用。
export default defineConfig({
  plugins: [react()],
  define: {
    __AKA_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __AKA_BUILD_DIRTY__: JSON.stringify(BUILD_DIRTY),
    __AKA_BUILD_AT__: JSON.stringify(BUILD_AT),
    __AKA_BUILD_ENTRY__: JSON.stringify("dist/index.html"),
    __AKA_BUILD_FEATURES__: JSON.stringify(["tauri/custom-protocol"]),
    // runtime.node：前端构建所用 Node 版本；写入 env 供 R-EV-02 五项校验。
    __AKA_BUILD_NODE__: JSON.stringify(process.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/crates/**"],
    },
  },
  build: {
    target: "safari16",
    outDir: "dist",
  },
});
