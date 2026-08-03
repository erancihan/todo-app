import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// One bundle, two hosts: the Tauri shell loads it from `dist/`, the PWA serves it
// over HTTP. Nothing here is Tauri-specific — the runtime difference lives behind
// the engine port in `src/core/engine-port.ts`.
export default defineConfig({
  plugins: [tailwindcss()],
  // Tauri expects a fixed port and must not silently fall back to another one.
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
  },
  build: {
    // The WebView floor across the matrix: WKWebView (iOS/macOS), WebView2,
    // Android System WebView, evergreen browsers.
    target: ["es2022", "safari16", "chrome110"],
    sourcemap: true,
  },
  // sqlite-wasm needs COOP/COEP for OPFS SyncAccessHandle in a worker.
  // Documented here because the PWA deploy has to set the same headers.
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
