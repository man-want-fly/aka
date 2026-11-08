import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appVersion = process.env.npm_package_version ?? "0.0.0";
const buildNo = process.env.AKA_BUILD_NO ?? "dev";

// Tauri 2 约定：固定 1420 端口，构建产物给 src-tauri 的 frontendDist 使用。
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_NO__: JSON.stringify(buildNo),
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
