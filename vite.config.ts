import { defineConfig } from "vite";

// Tauri expects a fixed dev port; fail rather than silently switching.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: ["es2022", "safari16"],
    minify: "esbuild",
    sourcemap: false,
  },
});
