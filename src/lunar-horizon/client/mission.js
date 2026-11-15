import {D, direction, dot, horizonAt} from './math.js?v=terrain-v3';

export const DAY = 86400000;
export const MINUTE = 60000;
export const MAX_SAMPLES = 15000;

// Bound the number of Horizons samples without rejecting a long mission.
export function effectiveStep(duration, requested) {
  return Math.max(requested, Math.ceil(duration / ((MAX_SAMPLES - 1) * MINUTE)));
}

export function solarMargin(row, terrain) {
  const incidence = Math.acos(Math.max(-1, Math.min(1, dot(direction(row[1], row[2]), terrain.normal)))) / D;
  return {incidence, margin: Math.min(row[2] - horizonAt(terrain.horizon, row[1]), 90 - incidence)};
}

// Interpolate the same zero crossings as the illumination timeline.
export function darknessIntervals(samples, margin = 'sm') {
  const intervals = [];
  for (let i = 1; i < samples.length; i++) {
    const {t: a, [margin]: x} = samples[i - 1];
    const {t: b, [margin]: y} = samples[i];
    if (x > 0 && y > 0) continue;
    const crossing = x === y ? a : a + (b - a) * x / (x - y);
    const start = x > 0 ? crossing : a;
    const end = y > 0 ? crossing : b;
    if (end <= start) continue;
    const last = intervals.at(-1);
    if (last && last.end === start) last.end = end;
    else intervals.push({start, end});
  }
  return intervals;
}

export function longestDarkness(intervals, start, end) {
  let longest = {start, end: start};
  for (const interval of intervals) {
    const from = Math.max(interval.start, start);
    const to = Math.min(interval.end, end);
    if (to - from > longest.end - longest.start) longest = {start: from, end: to};
  }
  return longest;
}

export function earliestWindow(intervals, first, last, duration, limit) {
  let start = Math.ceil(first / MINUTE) * MINUTE;
  if (duration <= limit) return start <= last ? start : null;
  for (const dark of intervals) {
    if (dark.end - dark.start <= limit) continue;
    // Overlap exceeds limit only within this open interval of start times.
    const forbiddenFrom = dark.start + limit - duration;
    const forbiddenTo = dark.end - limit;
    if (start <= forbiddenFrom) break;
    if (start < forbiddenTo) start = Math.ceil(forbiddenTo / MINUTE) * MINUTE;
    if (start > last) return null;
  }
  return start <= last ? start : null;
}
