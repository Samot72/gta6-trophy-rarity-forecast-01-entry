// gta6-trophy-rarity-forecast-01 — my entry: forecast every GTA VI PS5 trophy's Exophase earn rate
// at the case's target, as five quantiles, scored by pinball loss on the logit scale.
//
// The idea, in one paragraph: a rate is earners divided by tracked players, and the two parts move
// differently. Earners for a trophy never shrink — nobody un-earns a trophy — and their growth is
// concave: the keenest players earn early, the pool of active players who have not earned it yet
// drains, so log(earners) grows roughly linearly in sqrt(time). Tracked players also grow and
// saturate the same way, and their growth dilutes the rates of whatever the early crowd already
// holds. So the program anchors on the last read, measures each trophy's recent growth slope of
// log(earners) against sqrt(days since the first read) over the recent half of the record,
// damps that slope over the extrapolation distance, grows earners and tracked players to the
// target, and divides. The median is that ratio on the logit scale; the spread widens with the
// square root of the horizon and with how badly the trophy's own history fits its curve.
//
// Why sqrt(time): the lifetime curves of the two closest Rockstar trophy sets bend exactly this
// way. On Exophase today, GTA V's (PS4, 784,495 players tracked) first trophy sits at 97.09% and
// its Chapter-1-equivalent story trophies decay along the campaign to a final-mission rate under
// a third, with 100% completion at 3.19% and the platinum at 2.17%; Red Dead Redemption 2 shows
// the same shape (Chapter 1 at 84.3% of tracked players, 100% completion 5.5%, platinum 2.71%).
// Fast early rise, long flat tail — a straight line in time would overshoot a week-one target,
// a flat persistence forecast undershoots the trophies players are still reaching.
//
// Sources (read 2026-11-19/20, cited in README.md):
//   https://www.exophase.com/game/grand-theft-auto-v-ps4/trophies/
//   https://www.exophase.com/game/red-dead-redemption-2-psn/trophies/
//
// The case format (kit's starter and input/NOTICE.txt): each /input/<id>.in is one JSON object
// {schema, id, at, horizon_minutes, target, levels, game, trophies, history, notes}; history is
// every house read before `at`, oldest first, each {slot, at, players_tracked, trophies_earned,
// rates} with rates in the order of trophies (null where a read lacked the trophy). The answer
// file /output/<id>.out is {"trophies":[{"id":1,"q":[q05,q25,q50,q75,q95]}, ...]} — one row per
// trophy, five finite numbers 0..100, non-decreasing. Node 22, standard library only, offline,
// deterministic: the same case always writes the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Rates are clamped to this band before the logit, matching how the scorer clamps. */
const RATE_LO = 0.01;
const RATE_HI = 99.99;
/** Spread of a forecast, in logit units per square-root day of horizon, before per-trophy widening. */
const SIGMA_PER_ROOT_DAY = 0.35;
/** A fitted log-earner slope (per sqrt-day) is never trusted past this. */
const SLOPE_CAP = 2.2;

interface TrophyMeta {
  id: number;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface CaseFile {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: TrophyMeta[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const logitOf = (pct: number): number => {
  const p = clamp(pct, RATE_LO, RATE_HI);
  return Math.log(p / (100 - p));
};
const pctOf = (logit: number): number => 100 / (1 + Math.exp(-logit));
/** x rounded to 4 decimals, so two runs write identical bytes. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** The standard normal's quantile at p (Acklam's rational approximation, |error| < 1.2e-9). */
function invNormCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

interface Fit {
  /** value at x = 0 */ a: number;
  /** slope per unit x */ b: number;
  /** root-mean-square residual, in y units */ resid: number;
  /** points used */ n: number;
}

/**
 * Weighted least squares of y on x, with a mild recency tilt (later reads weigh up to 1.5x the
 * first). A single point, or no spread in x, fits a flat line through the weighted mean.
 */
function fitLine(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0, resid: 0, n: 0 };
  const xMax = Math.max(...xs, 1e-9);
  const ws = xs.map((x) => 1 + 0.5 * (x / xMax));
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += ws[i] * (xs[i] - mx) * (xs[i] - mx);
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    sr += r * r;
  }
  return { a, b, resid: Math.sqrt(sr / n), n };
}

const epochSec = (iso: string): number => Date.parse(iso) / 1000;

/** Forecast one case and return the output file's text. */
function forecast(c: CaseFile): string {
  // Reads in time order, one per timestamp (a later duplicate wins).
  const byTime = new Map<number, Read>();
  for (const r of c.history) byTime.set(epochSec(r.at), r);
  const reads = [...byTime.entries()].sort((p, q) => p[0] - q[0]).map(([, r]) => r);
  if (reads.length === 0) throw new Error('case has no history');
  const times = reads.map((r) => epochSec(r.at));
  const t0 = times[0];
  const daysSince = (t: number): number => Math.max(0, (t - t0) / 86_400);
  const xs = times.map((t) => Math.sqrt(daysSince(t)));
  const targetDay = daysSince(epochSec(c.target));
  const xTarget = Math.sqrt(targetDay);
  const horizonDays = Math.max(c.horizon_minutes / 1440, 1 / 1440);

  // Growth is extrapolated from the anchor of the last read, never from a global fit's level:
  // the slope comes from the recent half of the record (in sqrt-time), shrunk toward persistence
  // when reads are few, and damped over the extrapolation distance — a slope measured over the
  // observed span is trusted less the further past that span it is carried.
  const xLast = xs[xs.length - 1];
  const dx = Math.max(0, xTarget - xLast);
  const damp = xLast / (xLast + dx);
  const recentSlope = (fx: number[], fy: number[]): Fit => {
    const cut = fx.length > 0 ? fx[fx.length - 1] / 2 : 0;
    const rx: number[] = [];
    const ry: number[] = [];
    fx.forEach((x, j) => {
      if (x >= cut) {
        rx.push(x);
        ry.push(fy[j]);
      }
    });
    const fit = fitLine(rx.length >= 2 ? rx : fx, rx.length >= 2 ? ry : fy);
    return { ...fit, b: clamp(fit.b * (fit.n / (fit.n + 3)), 0, SLOPE_CAP) };
  };

  // Tracked players: anchored at the last read, grown by their recent slope.
  const pSlope = recentSlope(xs, reads.map((r) => Math.log(Math.max(1, r.players_tracked))));
  const playersLast = reads[reads.length - 1].players_tracked;
  const playersTarget = playersLast * Math.exp(pSlope.b * dx * damp);

  const zAt = c.levels.map((level) => invNormCdf(level));
  const rows = c.trophies.map((trophy, i) => {
    // This trophy's earner counts, from the reads that list a rate for it.
    const ex: number[] = [];
    const ey: number[] = [];
    let earnersLast = 0;
    reads.forEach((r, j) => {
      const rate = r.rates[i];
      if (rate === null || rate === undefined) return;
      const earners = (rate / 100) * r.players_tracked;
      ex.push(xs[j]);
      ey.push(Math.log(earners + 0.5));
      earnersLast = earners;
    });
    if (ex.length === 0) {
      // Never seen in any read: say almost nobody, and admit a wide spread.
      const wide = clamp(1.1 * Math.sqrt(horizonDays), 0.3, 2.4);
      return { id: trophy.id, q: zAt.map((z) => round4(pctOf(logitOf(RATE_LO) + z * wide))) };
    }
    const fit = recentSlope(ex, ey);
    const earnersTarget = earnersLast * Math.exp(fit.b * dx * damp);
    const median = clamp((100 * Math.min(earnersTarget, playersTarget)) / playersTarget, RATE_LO, RATE_HI);
    // Spread: grows with sqrt(horizon); wider when the trophy's own history fits its curve badly,
    // and wider again while its earner count is small — a handful of players earning (or one read
    // rounding by a whole person) moves a small count by a visible step.
    const smallCount = earnersLast < 30 ? 1.5 : 1;
    const sigma = clamp(SIGMA_PER_ROOT_DAY * Math.sqrt(horizonDays) * (1 + Math.min(1.2, fit.resid)) * smallCount, 0.08, 2.4);
    const centre = logitOf(median);
    return { id: trophy.id, q: zAt.map((z) => round4(pctOf(centre + z * sigma))) };
  });
  return `${JSON.stringify({ trophies: rows })}\n`;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), forecast(parsed));
}
