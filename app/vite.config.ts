import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2 约定：固定 1420 端口，构建产物给 src-tauri 的 frontendDist 使用。
export default defineConfig({
  plugins: [react()],
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
