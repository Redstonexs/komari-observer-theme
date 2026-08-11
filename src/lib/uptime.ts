/**
 * Availability inference.
 *
 * Komari records no uptime history — `uptime` is commented out of
 * models.Record — so downtime has to be inferred from the load records that do
 * exist. The obvious inference, "a display block containing no record is
 * downtime", is quietly wrong: it requires the block to be wider than the
 * server's sampling interval, and that interval is neither constant nor
 * knowable in advance. The server returns roughly three-minute records for a
 * day and hourly ones for a week, so a 30-minute block laid over hourly data
 * marks every second block down and reports 50% for a node that never missed a
 * beat.
 *
 * The cadence is therefore MEASURED, and downtime is read off the gaps between
 * consecutive records rather than off block occupancy. Display resolution then
 * has nothing to do with sampling resolution, and blocks are free to be as fine
 * as the layout wants them.
 *
 * What this cannot do is see inside the sampling interval: against hourly data
 * a four-minute outage leaves no trace. `cadenceMs` and `thresholdMs` are
 * returned so the UI can state that limit rather than imply a precision the
 * data does not have.
 */

export type SlotState = "online" | "down" | "unknown";

export interface UptimeSlot {
  /** Inclusive left edge, epoch ms. */
  from: number;
  /** Exclusive right edge, epoch ms. */
  to: number;
  state: SlotState;
  /** Confirmed downtime inside this block. */
  downMs: number;
  /** How much of this block the records say anything at all about. */
  knownMs: number;
}

export interface Uptime {
  slots: UptimeSlot[];
  /**
   * The range the blocks actually tile. `slotMs` rarely divides the requested
   * span evenly, and the axis has to label what was drawn, not what was asked
   * for.
   */
  from: number;
  to: number;
  /** Time-weighted, over the known part of the window. -1 when nothing is known. */
  availability: number;
  /** Measured sampling interval; 0 when there was too little data to measure. */
  cadenceMs: number;
  /** Gap beyond which the node counts as down; 0 when unmeasurable. */
  thresholdMs: number;
  downMs: number;
  knownMs: number;
}

/** A node must miss several reports running before it counts as down — one late
 *  record is scheduler jitter, not an outage. */
const OUTAGE_FACTOR = 2.5;
/** ...and never less than a minute past the cadence, so a fast-reporting node
 *  cannot be declared down over a few seconds of drift. */
const OUTAGE_SLACK_MS = 60_000;
/** Bounds on the measured cadence. Below the floor a pair of near-duplicate
 *  timestamps would make every ordinary gap look like an outage; above it the
 *  data is too coarse for the threshold to mean anything. */
const MIN_CADENCE_MS = 30_000;
const MAX_CADENCE_MS = 2 * 3_600_000;
/** A block the records barely reach into is reported as unknown rather than
 *  guessed at from the sliver that is covered. */
const KNOWN_FRACTION = 0.5;
/**
 * Downtime below both of these is a boundary artifact, not an event.
 *
 * An outage edge landing a fraction of a second inside the neighbouring block
 * — which happens whenever an outage very nearly aligns to a block boundary —
 * would otherwise label a block that renders solid green as down. A block
 * counts as down once its downtime is either a visible fraction of it or a
 * minute in absolute terms. Nothing is lost from the percentage, which is
 * totalled from the intervals rather than from the blocks.
 */
const DOWN_FRACTION = 0.01;
const DOWN_FLOOR_MS = 60_000;

const overlap = (aFrom: number, aTo: number, bFrom: number, bTo: number) =>
  Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));

export function buildUptime(input: {
  /** Record timestamps in epoch ms. Order does not matter. */
  times: number[];
  /** Right edge of the window — the moment the records were fetched. */
  endsAt: number;
  /** How far back the window reaches from `endsAt`. */
  spanMs: number;
  /** Width of one display block. */
  slotMs: number;
}): Uptime {
  const { times, endsAt, spanMs, slotMs } = input;

  // Floor, not round: the drawn window has to stay inside the window that was
  // requested, or the head picks up a sliver of time the server was never asked
  // about and reports it as missing data.
  const count = Math.max(1, Math.floor(spanMs / slotMs));
  const from = endsAt - count * slotMs;

  const slots: UptimeSlot[] = Array.from({ length: count }, (_, i) => ({
    from: from + i * slotMs,
    to: from + (i + 1) * slotMs,
    state: "unknown",
    downMs: 0,
    knownMs: 0,
  }));

  const samples = times.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);

  // A single sample fixes no interval, so there is no cadence for a gap to be
  // measured against and nothing can honestly be called downtime.
  if (samples.length < 2) {
    return {
      slots,
      from,
      to: endsAt,
      availability: -1,
      cadenceMs: 0,
      thresholdMs: 0,
      downMs: 0,
      knownMs: 0,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i]! - samples[i - 1]!);
  gaps.sort((a, b) => a - b);
  // Median rather than mean: a real outage inside the sample set would drag a
  // mean upward and so raise the very threshold meant to catch it.
  const median = gaps[gaps.length >> 1]!;
  const cadenceMs = Math.min(MAX_CADENCE_MS, Math.max(MIN_CADENCE_MS, median));
  const thresholdMs = Math.max(cadenceMs * OUTAGE_FACTOR, cadenceMs + OUTAGE_SLACK_MS);

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;

  // A record proves the node was alive AT that instant and says nothing about
  // the stretch after it, so an outage is dated from one cadence past the last
  // report. Dating it from the report itself would paint a sliver of downtime
  // in front of every single sample.
  const outages: Array<[number, number]> = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b - a > thresholdMs) outages.push([a + cadenceMs, b]);
  }
  // Still nothing at the right-hand edge means down right now, which is the one
  // outage a reader most needs to see.
  if (endsAt - last > thresholdMs) outages.push([last + cadenceMs, endsAt]);

  // Before the first record the node was not down, it was unmonitored — a node
  // added yesterday must not read as a week of outage, and neither must a
  // window longer than the server's record retention.
  const knownFrom = Math.max(from, first);

  for (const slot of slots) {
    const knownMs = overlap(slot.from, slot.to, knownFrom, endsAt);
    let downMs = 0;
    for (const [start, end] of outages) downMs += overlap(slot.from, slot.to, start, end);

    slot.knownMs = knownMs;
    // Downtime can never exceed what is known about the block; clamping keeps
    // `downMs / knownMs` a usable ratio for the fill colour.
    slot.downMs = Math.min(downMs, knownMs);

    const isDown = slot.downMs >= DOWN_FLOOR_MS || slot.downMs >= slotMs * DOWN_FRACTION;
    slot.state = knownMs < slotMs * KNOWN_FRACTION ? "unknown" : isDown ? "down" : "online";
  }

  // Totalled from the intervals rather than by summing the blocks, so that
  // resizing the window — which changes the block count — cannot change the
  // percentage the page is reporting.
  const knownMs = Math.max(0, endsAt - knownFrom);
  const downMs = outages.reduce((sum, [start, end]) => sum + overlap(start, end, knownFrom, endsAt), 0);

  return {
    slots,
    from,
    to: endsAt,
    availability: knownMs > 0 ? ((knownMs - downMs) / knownMs) * 100 : -1,
    cadenceMs,
    thresholdMs,
    downMs,
    knownMs,
  };
}
