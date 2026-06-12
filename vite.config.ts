import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// UI lives in web/, builds to web/dist (served by the Hono server in prod).
// In dev, Vite serves the UI and proxies /api to the Node server on :8787.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: { "/api": "http://localhost:8787" },
  },
});
