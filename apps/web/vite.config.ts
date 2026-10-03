import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// maplibre-gl loads its tile worker from a URL built at runtime, so Rollup never bundles it. A
// `?url` import (see RegionMap.tsx) emits maplibre-gl-worker.mjs, but that file imports
// ./maplibre-gl-shared.mjs, which has to be copied next to it unmodified or the map renders no tiles.
function copyMaplibreWorkerSharedChunk(): Plugin {
  return {
    name: "copy-maplibre-worker-shared-chunk",
    apply: "build",
    writeBundle(options) {
      const outDir = path.resolve(options.dir ?? "dist");
      const assetsDir = path.join(outDir, "assets");
      const src = path.resolve("../../node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs");
      if (!existsSync(src)) throw new Error(`maplibre-gl-shared.mjs not found at ${src}: is maplibre-gl installed?`);
      mkdirSync(assetsDir, { recursive: true });
      cpSync(src, path.join(assetsDir, "maplibre-gl-shared.mjs"));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyMaplibreWorkerSharedChunk()],
  // The dev pre-bundler mishandles the same runtime worker URL; Vite's own warning suggests excluding it.
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
      // Offline basemap tiles (see RegionMap.tsx), served by the API like in production.
      "/maps": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
