declare const process: { env: Record<string, string | undefined> };
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API (server/) listens on :8787. The UI talks to it through /api so there is no CORS or mixed-origin setup to do.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // file events do not fire on WSL's /mnt/c (drvfs): without polling Vite serves stale modules
    watch: { usePolling: true, interval: 300 },
    proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8787", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
