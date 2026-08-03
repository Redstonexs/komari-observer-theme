import path from "node:path";
import fs from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Serves the repo's komari-theme.json at /themes/<short>/komari-theme.json during dev.
 * The Komari admin panel fetches the live manifest from that path to build the settings
 * form, so without this the settings UI is empty while developing.
 */
function serveLocalManifest(short: string): Plugin {
  return {
    name: "observer:local-manifest",
    apply: "serve",
    configureServer(server) {
      const target = `/themes/${short}/komari-theme.json`;
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split("?")[0] !== target) return next();
        const file = path.resolve(__dirname, "komari-theme.json");
        if (!fs.existsSync(file)) return next();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(fs.readFileSync(file));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_TARGET || "http://127.0.0.1:25774";

  return {
    // MUST be "/" — Komari's SPA fallback maps request path P to <themeRoot>/dist/P.
    // A relative base breaks on nested client routes like /node/<uuid>.
    base: "/",

    plugins: [react(), tailwindcss(), serveLocalManifest("observer")],

    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },

    esbuild: {
      // GSAP's license (§III) forbids removing proprietary notices, and every GSAP
      // dist file carries a /*! @license */ banner. Keep legal comments in the bundle.
      legalComments: "inline",
    },

    build: {
      outDir: "dist",
      assetsDir: "assets",
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // Names must not start with "_": Go's embed directive silently ignores those,
          // which would break the theme when vendored into the server's defaultTheme.
          chunkFileNames: "assets/chunk-[name]-[hash].js",
          entryFileNames: "assets/entry-[name]-[hash].js",
          assetFileNames: "assets/asset-[name]-[hash][extname]",
          // Deliberately coarse. Komari's SPA fallback returns index.html (as text/html)
          // for a missing hashed chunk instead of a 404 — the guard is commented out in
          // web/public/public.go — so after an in-place theme upgrade a stale dynamic
          // import fails with "Failed to fetch dynamically imported module". Fewer, eagerly
          // loaded chunks means fewer ways to hit that.
          manualChunks: {
            "react-vendor": ["react", "react-dom", "react-router"],
            gsap: ["gsap", "@gsap/react"],
          },
        },
      },
    },

    server: {
      host: "0.0.0.0",
      port: 5273,
      proxy: {
        // ws:true is required — /api/clients and /api/rpc2 are WebSocket upgrades.
        "/api": { target, changeOrigin: true, ws: true, secure: false },
        // The admin panel resolves theme assets and the manifest through /themes.
        "/themes": { target, changeOrigin: true, secure: false },
      },
    },

    // Same proxy for `vite preview`, so the real production bundle can be
    // exercised against a backend rather than only the dev-server pipeline.
    preview: {
      host: "0.0.0.0",
      port: 5274,
      proxy: {
        "/api": { target, changeOrigin: true, ws: true, secure: false },
        "/themes": { target, changeOrigin: true, secure: false },
      },
    },
  };
});
