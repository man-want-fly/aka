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
/**
 * dirty 只认 evidence-run.sh 在任何输出落盘之前取的 PRE 快照（AKA_EVIDENCE_DIRTY=0/1）。
 * 构建期自己 git status 会把「上一次取证的归档产物」算进来，干净树上也会得到 true
 * （BA 实测 meta.dirty=false 而 env.dirty=true）。独立构建时才回退到现场 git status。
 */
const ENV_DIRTY = process.env.AKA_EVIDENCE_DIRTY;
const BUILD_DIRTY =
  ENV_DIRTY === undefined ? git("git status --porcelain") !== "" : ENV_DIRTY === "1";
// commit 同口径：走取证入口时继承 PRE 快照，独立构建才现场取 HEAD。
const ENV_COMMIT = process.env.AKA_EVIDENCE_COMMIT;
const BUILD_COMMIT = ENV_COMMIT && ENV_COMMIT.trim() !== "" ? ENV_COMMIT.trim() : git("git rev-parse HEAD");
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
