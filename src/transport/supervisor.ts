/**
 * Drives the transport ladder: picks a tier, watches it, steps down when it
 * misbehaves, and climbs back when the network recovers.
 *
 * The central design constraint is that **socket state is not liveness**.
 * Komari sets no read deadline, no write deadline and no ping/pong handler on
 * its browser sockets, and it never pushes unsolicited data. A half-open
 * connection therefore reports readyState === OPEN forever while delivering
 * nothing. Health is measured only by "when did a snapshot last arrive".
 */

import { createAdapters } from "./adapters";
import type { AdapterEvents, LinkState, LiveAdapter, TierId, TransportConfig } from "./types";
import type { LiveSnapshot } from "@/api/model";

/** A tier must produce data within interval x this before it counts as a miss. */
const MISS_FACTOR = 1.5;
/** Consecutive misses tolerated before stepping down. */
const MAX_MISSES = 2;
/** Reconnect churn within FLAP_WINDOW_MS that also forces a step down. */
const MAX_FLAPS = 3;
const FLAP_WINDOW_MS = 60_000;
/** Clean running time on a lower tier before we try to climb back. */
const PROMOTE_AFTER_MS = 60_000;
/**
 * Each failed climb doubles the wait before the next one, up to ~16 minutes.
 *
 * Without this, a tier that is permanently broken (a proxy that drops
 * WebSocket upgrades, say) gets retried every single minute forever, and each
 * attempt costs a full walk back down the ladder — leaving the dashboard
 * flipping to "degraded" every couple of minutes for no benefit.
 */
const MAX_PROMOTE_BACKOFF = 4;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface LinkStatus {
  state: LinkState;
  tier: TierId | null;
  label: string;
  /** Epoch ms of the last snapshot, or 0 if none has ever arrived. */
  lastGoodAt: number;
  /** True while running on anything below the best available tier. */
  degraded: boolean;
  lastError: string | null;
}

export interface SupervisorHandlers {
  onSnapshot(snapshot: LiveSnapshot): void;
  onStatus(status: LinkStatus): void;
}

export class TransportSupervisor {
  private adapters: LiveAdapter[] = [];
  private index = 0;
  private active: LiveAdapter | null = null;

  /** Tiers proven impossible on this server — never retried. */
  private unsupported = new Set<TierId>();

  private lastGoodAt = 0;
  private misses = 0;
  private flaps: number[] = [];
  private attempt = 0;
  private healthySince = 0;
  /** Consecutive climb attempts that failed to reach a better tier. */
  private promoteFailures = 0;

  private watchTimer: number | null = null;
  private retryTimer: number | null = null;
  private running = false;
  private lastError: string | null = null;

  constructor(
    private config: TransportConfig,
    private handlers: SupervisorHandlers,
  ) {}

  /* ---------------------------------------------------------------- */

  start() {
    if (this.running) return;
    this.running = true;

    this.adapters = createAdapters();

    // A pinned preference is a debugging aid: it collapses the ladder to a
    // single rung so a failure is loud instead of being papered over.
    if (this.config.preference !== "auto") {
      const pinned = this.adapters.find((a) => a.id === this.config.preference);
      this.adapters = pinned ? [pinned] : this.adapters;
    }

    // Drop the SSE tier up front when unconfigured — it is dormant by design,
    // since Komari itself exposes no text/event-stream endpoint.
    if (!this.config.sseEndpoint) this.unsupported.add("sse");

    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.index = 0;
    this.connect();
    this.watchTimer = window.setInterval(this.checkHealth, 1_000);
  }

  stop() {
    this.running = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.watchTimer !== null) window.clearInterval(this.watchTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.watchTimer = this.retryTimer = null;
    this.active?.stop();
    this.active = null;
  }

  /** Re-establish from the top. Required after login/logout: the WS handler
   *  captures the hidden-node visibility set once, at connection time. */
  reconnect() {
    if (!this.running) return;
    this.active?.stop();
    this.active = null;
    this.index = 0;
    this.misses = 0;
    this.attempt = 0;
    this.flaps = [];
    this.connect();
  }

  updateConfig(patch: Partial<TransportConfig>) {
    const intervalChanged =
      patch.intervalMs !== undefined && patch.intervalMs !== this.config.intervalMs;
    this.config = { ...this.config, ...patch };
    if (patch.sseEndpoint) this.unsupported.delete("sse");
    if (intervalChanged && this.running) this.restartActive();
  }

  /* ---------------------------------------------------------------- */

  private connect() {
    if (!this.running) return;

    const adapter = this.nextAdapter();
    if (!adapter) {
      // Every rung is exhausted. Never give up while the tab is visible — a
      // flaky mobile link recovers, and permanently stopping (as several
      // shipped themes do after 5 attempts) strands the page on stale data.
      this.emit("offline");
      this.scheduleRetry(() => {
        this.index = 0;
        this.connect();
      });
      return;
    }

    this.active = adapter;
    this.misses = 0;
    this.emit(this.lastGoodAt === 0 ? "connecting" : "degraded");

    adapter.start(this.config, this.eventsFor(adapter));
  }

  /** First adapter at or after `index` that is not known-unsupported. */
  private nextAdapter(): LiveAdapter | null {
    while (this.index < this.adapters.length) {
      const candidate = this.adapters[this.index]!;
      if (!this.unsupported.has(candidate.id)) return candidate;
      this.index++;
    }
    return null;
  }

  private eventsFor(adapter: LiveAdapter): AdapterEvents {
    return {
      onSnapshot: (snapshot) => {
        if (!this.running || this.active !== adapter) return;

        const wasCold = this.lastGoodAt === 0;
        this.lastGoodAt = Date.now();
        this.misses = 0;
        this.attempt = 0;
        this.lastError = null;
        if (wasCold || this.healthySince === 0) this.healthySince = this.lastGoodAt;
        // Data on the best tier means the outage is genuinely over — allow the
        // next climb to happen promptly again.
        if (this.index === 0) this.promoteFailures = 0;

        this.handlers.onSnapshot(snapshot);
        this.emit(this.index === 0 ? "live" : "degraded");
      },

      onError: (error) => {
        if (!this.running || this.active !== adapter) return;
        this.lastError = error.message;
        this.noteFlap();

        // Reconnect churn on one tier is itself a demotion signal.
        if (this.flaps.length >= MAX_FLAPS) {
          this.stepDown();
        } else {
          this.restartActive();
        }
      },

      onUnsupported: (reason) => {
        if (!this.running || this.active !== adapter) return;
        this.unsupported.add(adapter.id);
        this.lastError = `${adapter.label}: ${reason}`;
        this.stepDown();
      },
    };
  }

  /* ---------------------------------------------------------------- */

  private checkHealth = () => {
    if (!this.running || !this.active) return;
    // A hidden tab gets throttled timers, so its silence proves nothing.
    if (document.hidden) return;

    const now = Date.now();
    const deadline = this.config.intervalMs * MISS_FACTOR;

    if (this.lastGoodAt > 0 && now - this.lastGoodAt > deadline * (this.misses + 1)) {
      this.misses++;
      if (this.misses >= MAX_MISSES) {
        this.lastError = `${this.active.label}: no data for ${Math.round(
          (now - this.lastGoodAt) / 1000,
        )}s`;
        this.emit("stale");
        this.stepDown();
        return;
      }
      this.emit("stale");
    }

    // Climb back once a lower tier has been quiet and clean for a while — the
    // outage that forced us down may well be over.
    const promoteAfter =
      PROMOTE_AFTER_MS * 2 ** Math.min(this.promoteFailures, MAX_PROMOTE_BACKOFF);
    if (
      this.index > 0 &&
      this.healthySince > 0 &&
      now - this.healthySince > promoteAfter &&
      this.hasBetterTier()
    ) {
      this.promote();
    }
  };

  private hasBetterTier(): boolean {
    for (let i = 0; i < this.index; i++) {
      if (!this.unsupported.has(this.adapters[i]!.id)) return true;
    }
    return false;
  }

  private promote() {
    this.active?.stop();
    this.active = null;
    this.index = 0;
    this.healthySince = 0;
    this.misses = 0;
    // Counted as failed up front; a successful snapshot on tier 0 clears it.
    this.promoteFailures++;
    this.connect();
  }

  private stepDown() {
    this.active?.stop();
    this.active = null;
    this.index++;
    this.healthySince = 0;
    this.flaps = [];
    this.scheduleRetry(() => this.connect());
  }

  private restartActive() {
    const adapter = this.active;
    if (!adapter) return;
    adapter.stop();
    this.emit("degraded");
    this.scheduleRetry(() => {
      if (this.active !== adapter || !this.running) return;
      adapter.start(this.config, this.eventsFor(adapter));
    });
  }

  /** Capped exponential backoff with full jitter, so a fleet of browsers
   *  reconnecting after an outage does not stampede the server in lockstep. */
  private scheduleRetry(run: () => void) {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = Math.random() * ceiling;
    this.attempt = Math.min(this.attempt + 1, 8);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.running) run();
    }, delay);
  }

  private noteFlap() {
    const now = Date.now();
    this.flaps.push(now);
    this.flaps = this.flaps.filter((t) => now - t < FLAP_WINDOW_MS);
  }

  private onVisibilityChange = () => {
    if (document.hidden || !this.running) return;
    // Timers were throttled while backgrounded, so the watermark is stale by
    // definition. Resetting it prevents a spurious "disconnected" flash, then
    // we force an immediate refresh to get real data on screen.
    this.lastGoodAt = Date.now();
    this.misses = 0;
    this.restartActive();
  };

  /* ---------------------------------------------------------------- */

  private emit(state: LinkState) {
    this.handlers.onStatus({
      state,
      tier: this.active?.id ?? null,
      label: this.active?.label ?? "—",
      lastGoodAt: this.lastGoodAt,
      degraded: this.index > 0,
      lastError: this.lastError,
    });
  }
}
