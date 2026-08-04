/** Chart data reduction. */

export interface Point {
  x: number;
  y: number | null;
}

/**
 * Reduces a series to at most `target` points by averaging fixed buckets.
 *
 * Load history arrives already downsampled to ~500 points, but PING history does
 * not: `internal/metricstore/ping_records.go` caps a query at **4000** points per
 * task. A node covered by three probes over 72 hours is therefore ~12k points
 * competing for roughly 600 CSS pixels — the line renders as a solid block and
 * the SVG path carries tens of thousands of commands for no gain.
 *
 * Buckets are AVERAGED rather than sampled, so a spike between two kept points
 * still moves the line instead of vanishing. A bucket whose samples were all
 * lost stays null, so a genuine outage still reads as a gap rather than being
 * bridged by its neighbours.
 */
export function downsample(points: Point[], target = 400): Point[] {
  // Below ~1.5x there is nothing to gain and the bucketing itself would start
  // visibly distorting a series the chart could have drawn honestly.
  if (points.length <= Math.round(target * 1.5)) return points;

  const size = points.length / target;
  const out: Point[] = [];

  for (let bucket = 0; bucket < target; bucket++) {
    const from = Math.floor(bucket * size);
    const to = Math.min(points.length, Math.floor((bucket + 1) * size));
    if (to <= from) continue;

    let sum = 0;
    let count = 0;
    for (let i = from; i < to; i++) {
      const y = points[i]!.y;
      if (y !== null && Number.isFinite(y)) {
        sum += y;
        count++;
      }
    }
    // Midpoint keeps the x-axis honest; using `from` would shift the whole
    // series half a bucket to the left.
    out.push({
      x: (points[from]!.x + points[to - 1]!.x) / 2,
      y: count ? sum / count : null,
    });
  }

  return out;
}
