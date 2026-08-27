import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// maplibre-gl parses vector tiles off the main thread via a worker script it loads at RUNTIME
// (a URL it builds itself), not a static import Rollup can see and bundle — left alone, the
// production build never emits that file at all, the browser refuses to run the resulting
// 404-turned-index.html as a JS module, and the map silently never renders any tile data (only
// its flat style background) even though the network/data layer underneath is completely fine.
// A `?url` import (see RegionMap.tsx) gets Vite to emit maplibre-gl-worker.mjs itself, but that
// file has its OWN internal `import ... from "./maplibre-gl-shared.mjs"` which Vite's `?url`
// raw-copy doesn't trace or rewrite either — so its sibling has to be copied to the exact same
// output directory by hand, unmodified, for that relative import to resolve at all.
function copyMaplibreWorkerSharedChunk(): Plugin {
  return {
    name: "copy-maplibre-worker-shared-chunk",
    apply: "build",
    writeBundle(options) {
      const outDir = path.resolve(options.dir ?? "dist");
      const assetsDir = path.join(outDir, "assets");
      const src = path.resolve("../../node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs");
      if (!existsSync(src)) throw new Error(`maplibre-gl-shared.mjs not found at ${src} — is maplibre-gl installed?`);
      mkdirSync(assetsDir, { recursive: true });
      cpSync(src, path.join(assetsDir, "maplibre-gl-shared.mjs"));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyMaplibreWorkerSharedChunk()],
  // Same underlying maplibre-gl worker issue as above, but for the dev server specifically:
  // Vite's esbuild-based dep pre-bundler mishandles the runtime-constructed worker URL
  // differently again ("The file does not exist at .../maplibre-gl-worker.mjs" in the dev
  // server log) — excluding it from pre-bundling is the fix Vite's own warning suggests.
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
