// Predictive insights: forecasts ("disk full in 3 days") and anomaly detection ("CPU is unusual for this hour").
// The maths is plain JavaScript on data from Prometheus, so it works without extra services.
//
// Forecast: robust straight-line trend (Theil-Sen: median of slopes, not fooled by spikes), fitted only on
//           data after the last clean-up (a big jump against the trend, e.g. log rotation freeing space).
// Anomaly : "normal" for each point = median of the same time on previous weeks (or days, when there is
//           less history), spread = median absolute deviation. Outside median ± k·spread for several points
//           in a row = anomaly. Robust statistics, so one past incident does not widen the normal band.

const DAY = 86400;
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (a) => { const m = median(a); return median(a.map((x) => Math.abs(x - m))); };
const clean = (pts) => pts.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));

export function downsample(pts, max = 300) {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

// ------------------------------------------------------------------ trend
export function theilSen(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const slopes = [];
  const stride = n > 400 ? Math.ceil(n / 400) : 1; // keep it O(400²)
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const dt = pts[j][0] - pts[i][0];
      if (dt > 0) slopes.push((pts[j][1] - pts[i][1]) / dt);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const intercept = median(pts.map(([t, v]) => v - slope * t));
  return { slope, intercept };
}

// index of the first point after the last big jump against the trend (disk clean-up, restart freeing memory)
export function lastResetIndex(pts, trendSign) {
  if (pts.length < 6 || !trendSign) return 0;
  const diffs = [];
  for (let i = 1; i < pts.length; i++) diffs.push(pts[i][1] - pts[i - 1][1]);
  const spread = mad(diffs) * 1.4826;
  const level = Math.abs(median(pts.map((p) => p[1]))) || 1;
  const values = pts.map((p) => p[1]);
  const range = Math.max(...values) - Math.min(...values);
  const big = Math.max(spread * 8, level * 0.02, range * 0.15);
  const m = 5;
  for (let i = diffs.length - 1; i >= 0; i--) {
    if (Math.sign(diffs[i]) !== -trendSign || Math.abs(diffs[i]) <= big) continue;
    // a real clean-up is a lasting level change, not a one-point spike: compare the levels around it
    const before = values.slice(Math.max(0, i - m + 1), i + 1);
    const after = values.slice(i + 1, i + 1 + m);
    if (before.length < 2 || after.length < 2) continue;
    const shift = median(after) - median(before);
    if (Math.sign(shift) === -trendSign && Math.abs(shift) > big * 0.7) return i + 1;
  }
  return 0;
}

/**
 * Forecast when a series crosses a threshold.
 * @param pts        [[unixSeconds, value], ...] oldest first
 * @param threshold  value that means "full" / "too high"
 * @param direction  'up' (rising towards threshold) or 'down' (falling towards it)
 * @param now        unix seconds
 */
export function forecast(pts, { threshold, direction = 'up', now = Date.now() / 1000, horizonDays = 30 } = {}) {
  let data = clean(pts);
  if (data.length < 6) return { status: 'not-enough-data', points: data.length };
  const first = theilSen(downsample(data, 400));
  const sign = direction === 'up' ? 1 : -1;
  const cut = lastResetIndex(data, first ? Math.sign(first.slope) : 0);
  const reset = cut > 0 ? data[cut][0] : null;
  if (cut > 0 && data.length - cut >= 6 && data[data.length - 1][0] - data[cut][0] >= 2 * 3600) data = data.slice(cut);
  const fit = theilSen(downsample(data, 400));
  if (!fit) return { status: 'not-enough-data', points: data.length };
  const { slope, intercept } = fit;
  const fitted = (t) => intercept + slope * t;
  const resid = data.map(([t, v]) => v - fitted(t));
  const sigma = 1.4826 * mad(resid);
  const values = data.map((p) => p[1]);
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const ssTot = values.reduce((s, x) => s + (x - mean) ** 2, 0);
  const ssRes = resid.reduce((s, x) => s + x * x, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const span = data[data.length - 1][0] - data[0][0];
  const current = values[values.length - 1];
  const perDay = slope * DAY;

  const result = {
    current, threshold, direction, slopePerDay: perDay, r2, sigma, fittedFrom: data[0][0], resetAt: reset,
    spanHours: span / 3600, points: data.length,
    confidence: r2 >= 0.8 && span >= 24 * 3600 && data.length >= 30 ? 'high' : r2 >= 0.5 && span >= 4 * 3600 ? 'medium' : 'low',
  };
  const crossed = sign > 0 ? current >= threshold : current <= threshold;
  if (crossed) return { ...result, status: 'crossed', daysLeft: 0, eta: now };
  // ignore drift that is tiny compared with the noise (flat series)
  const moving = sign * slope > 0 && Math.abs(perDay) * 7 > Math.max(sigma, Math.abs(threshold - current) * 0.01);
  if (!moving) return { ...result, status: 'stable', daysLeft: null, eta: null };
  const tCross = (threshold - intercept) / slope;
  const daysLeft = Math.max(0, (tCross - now) / DAY);
  // a range from the noise around the trend line (±2 sigma)
  const tEarly = (threshold - (intercept + sign * 2 * sigma)) / slope;
  const tLate = (threshold - (intercept - sign * 2 * sigma)) / slope;
  return {
    ...result,
    status: daysLeft <= horizonDays ? 'will-cross' : 'far',
    daysLeft,
    eta: tCross,
    range: [Math.max(0, (Math.min(tEarly, tLate) - now) / DAY), Math.max(0, (Math.max(tEarly, tLate) - now) / DAY)],
    projection: [[now, fitted(now)], [Math.min(tCross, now + horizonDays * DAY), fitted(Math.min(tCross, now + horizonDays * DAY))]],
  };
}

// ------------------------------------------------------------------ anomalies
export const SENSITIVITY = { low: 4.5, medium: 3.5, high: 2.5 };

/**
 * Seasonal anomaly detection for one series.
 * @param pts      [[t, v], ...] covering history + window, regular step
 * @param window   seconds at the end to judge and to return for charts
 * @param step     seconds between points
 * @param minDelta smallest difference that counts (e.g. 5 % CPU) - avoids alerts on tiny absolute changes
 */
export function detectAnomalies(pts, { window = 6 * 3600, step = 600, sensitivity = 'medium', minDelta = 0, confirm = 3, now = Date.now() / 1000 } = {}) {
  const data = clean(pts);
  if (data.length < 12) return { status: 'not-enough-data' };
  const byTime = new Map(data.map(([t, v]) => [Math.round(t / step), v]));
  const oldest = data[0][0];
  const age = now - oldest;
  let season, periods;
  if (age >= 15 * DAY) { season = 'weekly'; periods = [7, 14, 21].map((d) => d * DAY).filter((p) => p <= age); }
  else if (age >= 2.5 * DAY) { season = 'daily'; periods = [1, 2, 3, 4, 5, 6].map((d) => d * DAY).filter((p) => p <= age - step); }
  else { season = 'recent'; periods = null; }

  const k = SENSITIVITY[sensitivity] || SENSITIVITY.medium;
  const expectedAt = (t, idx) => {
    if (periods) {
      const prev = [];
      for (const p of periods) {
        // same time in earlier periods; take a small neighbourhood so a missing point does not break it
        for (const off of [0, -1, 1]) {
          const v = byTime.get(Math.round((t - p) / step) + off);
          if (v !== undefined) { prev.push(v); break; }
        }
      }
      return prev.length ? median(prev) : null;
    }
    // no seasonal history yet: the previous 2 hours (rolling median)
    const from = Math.max(0, idx - Math.round(7200 / step));
    const prev = data.slice(from, idx).map((p) => p[1]);
    return prev.length >= 6 ? median(prev) : null;
  };

  const rows = data.map(([t, v], i) => ({ t, v, e: expectedAt(t, i) })).filter((r) => r.e !== null);
  if (rows.length < 12) return { status: 'not-enough-data', season };
  const winStart = now - window;
  const history = rows.filter((r) => r.t < winStart);
  const resid = (history.length >= 12 ? history : rows).map((r) => r.v - r.e);
  const level = Math.abs(median(rows.map((r) => r.v))) || 1;
  const spread = Math.max(1.4826 * mad(resid), level * 0.01, minDelta / k, 1e-9);

  const win = rows.filter((r) => r.t >= winStart).map((r) => {
    const d = r.v - r.e;
    const outside = Math.abs(d) > k * spread && Math.abs(d) >= minDelta;
    return { ...r, lo: r.e - k * spread, hi: r.e + k * spread, score: d / spread, outside };
  });
  if (!win.length) return { status: 'not-enough-data', season };
  const last = win[win.length - 1];
  // anomaly = the last `confirm` points are all outside the band on the same side
  const tail = win.slice(-confirm);
  const dir = Math.sign(last.v - last.e);
  const anomalous = tail.length === confirm && tail.every((r) => r.outside && Math.sign(r.v - r.e) === dir);
  let since = null;
  if (anomalous) {
    for (let i = win.length - 1; i >= 0 && win[i].outside && Math.sign(win[i].v - win[i].e) === dir; i--) since = win[i].t;
  }
  return {
    status: anomalous ? 'anomaly' : 'normal',
    season, sensitivity, spread,
    current: last.v, expected: last.e, lower: last.lo, upper: last.hi, score: last.score,
    direction: dir > 0 ? 'above' : 'below', since,
    outsideRecently: win.filter((r) => r.outside).length,
    series: downsample(win.map((r) => [r.t, r.v, r.e, r.lo, r.hi]), 240),
  };
}

// ------------------------------------------------------------------ PromQL for alert rules
// (Prometheus evaluates these on its own, so alerts fire even when nobody has ObservaOne open.)
const wrapExpr = (e) => String(e).trim();

export function forecastRuleExpr({ query, threshold, direction = 'up', horizonHours = 24, lookbackHours = 6 }) {
  const op = direction === 'up' ? '>' : '<';
  const look = Math.max(1, Math.min(7 * 24, Number(lookbackHours) || 6));
  const ahead = Math.max(1, Math.min(90 * 24, Number(horizonHours) || 24)) * 3600;
  const step = look <= 6 ? '1m' : look <= 48 ? '5m' : '15m';
  const t = Number(threshold);
  if (!Number.isFinite(t)) throw new Error('Threshold must be a number.');
  // only while not already past the threshold (that is a normal threshold alert)
  const cur = `(${wrapExpr(query)})`;
  return `predict_linear(${cur}[${look}h:${step}], ${ahead}) ${op} ${t}\nand ${cur} ${direction === 'up' ? '<' : '>'} ${t}`;
}

export function anomalyRuleExpr({ query, direction = 'both', sensitivity = 'medium', seasonality = 'daily', minDelta = 0 }) {
  const k = SENSITIVITY[sensitivity] || SENSITIVITY.medium;
  const e = `(${wrapExpr(query)})`;
  const offsets = seasonality === 'weekly' ? ['1w', '2w', '3w'] : ['1d', '2d', '7d'];
  const cur = `avg_over_time(${e}[15m:1m])`;
  const base = `((${offsets.map((o) => `avg_over_time(${e}[30m:5m] offset ${o})`).join(' + ')}) / ${offsets.length})`;
  const spread = `clamp_min(stddev_over_time(${e}[${seasonality === 'weekly' ? '7d:30m' : '1d:10m'}]), ${Math.max(Number(minDelta) / k || 0, 0.000001)})`;
  const diff = `(${cur} - ${base})`;
  const md = Number(minDelta) || 0;
  if (direction === 'up') return `${diff} > ${k} * ${spread}${md ? `\nand ${diff} > ${md}` : ''}`;
  if (direction === 'down') return `${diff} < -${k} * ${spread}${md ? `\nand ${diff} < -${md}` : ''}`;
  return `abs(${diff}) > ${k} * ${spread}${md ? `\nand abs(${diff}) > ${md}` : ''}`;
}
