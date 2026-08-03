import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import "./styles/theme.css";
import "./styles/components.css";
import "./i18n";

/**
 * One-shot recovery from the stale-chunk trap.
 *
 * Komari's SPA fallback returns index.html (as text/html) for any file it
 * cannot find — the guard that would 404 assets with an extension is commented
 * out in web/public/public.go. After an in-place theme upgrade, a cached page
 * requesting an old hashed chunk therefore gets HTML back and the dynamic
 * import blows up. A single reload picks up the new index.html and its new
 * hashes; the sessionStorage flag stops a reload loop if something else is
 * genuinely broken.
 */
const RELOAD_FLAG = "observer:chunk-reload";

function isStaleChunkError(message: string): boolean {
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("Importing a module script failed")
  );
}

function recoverFromStaleChunk(message: string) {
  if (!isStaleChunkError(message)) return;
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    return;
  }
  window.location.reload();
}

window.addEventListener("error", (event) => recoverFromStaleChunk(String(event.message ?? "")));
window.addEventListener("unhandledrejection", (event) =>
  recoverFromStaleChunk(String((event.reason as Error)?.message ?? event.reason ?? "")),
);
try {
  sessionStorage.removeItem(RELOAD_FLAG);
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
