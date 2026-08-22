import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // maplibre-gl ships its own worker bundle (maplibre-gl-worker.mjs) for parsing vector
  // tiles off the main thread — Vite's esbuild-based dep pre-bundler doesn't handle that
  // pattern and silently produces a broken reference to it ("The file does not exist at
  // .../maplibre-gl-worker.mjs" in the dev server log). Without a working worker, MapLibre
  // can still paint its style's plain background color but never parses or renders any
  // actual tile data — exactly a "just a blue screen" symptom. Excluding it from
  // pre-bundling is the fix Vite's own warning suggests.
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  server: {
    proxy: {
      // Same-origin from the browser's point of view in dev too, so cookies just work
      // and there's no CORS configuration needed anywhere.
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
      // Offline basemap tiles (see RegionMap.tsx) — served by the same API server, needs
      // the same dev-mode proxy so relative /maps/... URLs work identically to production's
      // single-origin setup.
      "/maps": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
