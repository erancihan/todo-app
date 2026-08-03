import { defineConfig } from "vite";
import { resolve } from "node:path";

// Throwaway Phase 0 harness. Two pages, each reporting visible pass/fail:
//   /cm6-keymap/     — Enter vs Ctrl/Cmd+Enter, and list <-> editor focus handoff
//   /wasm-opfs/      — daybook-core on wasm32 over sqlite-wasm + OPFS
export default defineConfig({
  root: __dirname,
  server: {
    port: 5174,
    strictPort: true,
    host: "0.0.0.0",
    headers: {
      // sqlite-wasm's OPFS VFS needs a SharedArrayBuffer-capable context, which
      // means cross-origin isolation. The PWA deploy must set these too.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    target: ["es2022", "safari16", "chrome110"],
    rollupOptions: {
      input: {
        cm6: resolve(__dirname, "cm6-keymap/index.html"),
        wasm: resolve(__dirname, "wasm-opfs/index.html"),
      },
    },
  },
});
