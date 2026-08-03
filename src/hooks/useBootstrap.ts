/**
 * Boots the application: loads site config, node metadata and the user, then
 * starts the transport supervisor.
 *
 * Order matters. /api/public and /api/me stay reachable even when the site is
 * private, so they come first and tell us whether to render a login gate
 * instead of hammering endpoints that will 401.
 */

import { useEffect, useRef } from "react";
import { ApiError, getMe, getNodes, getPublicSettings, getVersion } from "@/api/client";
import { resolveSettings } from "@/config/settings";
import { liveBus } from "@/store/live";
import { useAppStore } from "@/store/app";
import { TransportSupervisor } from "@/transport/supervisor";

export function useBootstrap() {
  const supervisorRef = useRef<TransportSupervisor | null>(null);
  const loggedInRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const store = useAppStore.getState();

    async function boot() {
      try {
        const [publicSettings, me] = await Promise.all([getPublicSettings(), getMe()]);
        if (cancelled) return;

        const settings = resolveSettings(publicSettings.theme_settings);

        // `private_site` already accounts for a valid temp_key cookie — the
        // server reports false when a share link is active, so trust the
        // response rather than re-deriving access.
        if (publicSettings.private_site && !me.logged_in) {
          store.setBootstrap({
            publicSettings,
            settings,
            me,
            nodes: [],
            serverVersion: "",
          });
          store.setNeedsLogin(true);
          return;
        }

        const [nodes, version] = await Promise.all([
          getNodes(),
          getVersion().catch(() => ({ version: "", hash: "" })),
        ]);
        if (cancelled) return;

        store.setBootstrap({
          publicSettings,
          settings,
          me,
          nodes,
          serverVersion: version.version,
        });
        store.setNeedsLogin(false);
        loggedInRef.current = me.logged_in;

        const supervisor = new TransportSupervisor(
          {
            intervalMs: settings.update_interval * 1000,
            sseEndpoint: settings.sse_endpoint,
            preference: settings.transport_preference,
            // Read live from the store so the fan-out tier follows node
            // additions without needing a restart.
            getNodeIds: () => useAppStore.getState().nodes.map((n) => n.uuid),
          },
          {
            onSnapshot: (snapshot) => liveBus.publish(snapshot),
            onStatus: (status) => useAppStore.getState().setLink(status),
          },
        );
        supervisor.start();
        supervisorRef.current = supervisor;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.isAuthRequired) {
          store.setNeedsLogin(true);
          store.setBootError("");
          return;
        }
        store.setBootError(err instanceof Error ? err.message : "Failed to load");
      }
    }

    void boot();

    return () => {
      cancelled = true;
      supervisorRef.current?.stop();
      supervisorRef.current = null;
      liveBus.reset();
    };
  }, []);

  // Follow the OS colour scheme while the user is on "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => useAppStore.getState().syncResolvedDark();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Reflect the resolved scheme onto <html> for the CSS token sets.
  useEffect(
    () =>
      useAppStore.subscribe((state) => {
        document.documentElement.dataset.appearance = state.resolvedDark ? "dark" : "light";
      }),
    [],
  );

  /**
   * Re-handshake when the session changes.
   *
   * web/api/ws.go reads the session cookie and computes the hidden-node filter
   * ONCE, before entering its read loop. A socket opened while logged out keeps
   * serving the guest-visible set forever, so logging in must force a fresh
   * connection.
   */
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const me = await getMe();
        if (disposed) return;
        if (loggedInRef.current !== null && me.logged_in !== loggedInRef.current) {
          loggedInRef.current = me.logged_in;
          useAppStore.getState().setNodes(await getNodes());
          supervisorRef.current?.reconnect();
        }
      } catch {
        /* transient — the supervisor handles connection health separately */
      }
    };
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
