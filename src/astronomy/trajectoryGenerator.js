import { EARTH_CONFIG, MOON_CONFIG, TRAJECTORY_CONFIG } from '../config/constants.js';

const EARTH_ROTATION_RAD_PER_SEC = 7.2921159e-5;
const RAD_TO_DEG = 180 / Math.PI;
const EPSILON = 1e-9;
const LUNAR_SPEED_SWITCH_ALT_KM = 35000;

export function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vecSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vecAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vecScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vecNorm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vecNormalize(a, fallback = [1, 0, 0]) {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > EPSILON ? [a[0] / n, a[1] / n, a[2] / n] : [...fallback];
}

export function vecCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalizeQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > EPSILON ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}

export function multiplyQuat(a, b) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function rotateByQuat(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function rotateInvByQuat(q, v) {
  return rotateByQuat([q[0], -q[1], -q[2], -q[3]], v);
}

export function slerpQuat(q1, q2, t) {
  const u = Math.max(0, Math.min(1, t));
  let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];
  let b = q2;
  if (dot < 0) {
    dot = -dot;
    b = [-q2[0], -q2[1], -q2[2], -q2[3]];
  }
  if (dot > 0.9995) {
    return normalizeQuat([
      q1[0] + u * (b[0] - q1[0]),
      q1[1] + u * (b[1] - q1[1]),
      q1[2] + u * (b[2] - q1[2]),
      q1[3] + u * (b[3] - q1[3]),
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const w1 = Math.sin((1 - u) * theta) / sinTheta;
  const w2 = Math.sin(u * theta) / sinTheta;
  return [
    q1[0] * w1 + b[0] * w2,
    q1[1] * w1 + b[1] * w2,
    q1[2] * w1 + b[2] * w2,
    q1[3] * w1 + b[3] * w2,
  ];
}

export function j2000ToSceneAxes(v) {
  return [v[0], v[2], -v[1]];
}

export function sceneAxesToJ2000(v) {
  return [v[0], -v[2], v[1]];
}

/**
 * Converts a body->J2000 quaternion `[w, x, y, z]` into Three.js `[x, y, z, w]`
 * in `(x, z, -y)` scene coordinates.
 */
export function j2000QuatToScene(q) {
  const n = normalizeQuat(q);
  return [n[1], n[3], -n[2], n[0]];
}

export function vectorSceneToLatLonDeg(vScene) {
  const u = vecNormalize(vScene, [1, 0, 0]);
  const latDeg = Math.asin(Math.max(-1, Math.min(1, u[1]))) * RAD_TO_DEG;
  const lonDeg = Math.atan2(-u[2], u[0]) * RAD_TO_DEG;
  return { latDeg, lonDeg };
}

export function parseUtcStringToMs(utcStr) {
  if (!utcStr || typeof utcStr !== 'string') return null;
  const cleaned = utcStr
    .trim()
    .replace(/\s+UTC$/i, 'Z')
    .replace(/(\.\d{3})\d+(Z)$/, '$1$2');
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? ms : null;
}

export function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function hermiteInterpolate(t0, r0, v0, t1, r1, v1, tq) {
  const h = t1 - t0;
  if (h <= 0) return [...r0];
  const s = (tq - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return [
    h00 * r0[0] + h10 * h * v0[0] + h01 * r1[0] + h11 * h * v1[0],
    h00 * r0[1] + h10 * h * v0[1] + h01 * r1[1] + h11 * h * v1[1],
    h00 * r0[2] + h10 * h * v0[2] + h01 * r1[2] + h11 * h * v1[2],
  ];
}

export function hermiteVelocity(t0, r0, v0, t1, r1, v1, tq) {
  const h = t1 - t0;
  if (h <= 0) return [...v0];
  const s = (tq - t0) / h;
  const s2 = s * s;
  const dh00 = (6 * s2 - 6 * s) / h;
  const dh10 = 3 * s2 - 4 * s + 1;
  const dh01 = (-6 * s2 + 6 * s) / h;
  const dh11 = 3 * s2 - 2 * s;
  return [
    dh00 * r0[0] + dh10 * v0[0] + dh01 * r1[0] + dh11 * v1[0],
    dh00 * r0[1] + dh10 * v0[1] + dh01 * r1[1] + dh11 * v1[1],
    dh00 * r0[2] + dh10 * v0[2] + dh01 * r1[2] + dh11 * v1[2],
  ];
}

function interpolateVec3Linear(a, b, f) {
  return [
    a[0] + f * (b[0] - a[0]),
    a[1] + f * (b[1] - a[1]),
    a[2] + f * (b[2] - a[2]),
  ];
}

function slerpUnitVec3(a, b, t) {
  const u = Math.max(0, Math.min(1, t));
  const dot = Math.max(-1, Math.min(1, vecDot(a, b)));
  if (dot > 0.999995) {
    return vecNormalize(interpolateVec3Linear(a, b, u), a);
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  if (sinTheta < EPSILON) return [...a];
  const w1 = Math.sin((1 - u) * theta) / sinTheta;
  const w2 = Math.sin(u * theta) / sinTheta;
  return vecNormalize([
    a[0] * w1 + b[0] * w2,
    a[1] * w1 + b[1] * w2,
    a[2] * w1 + b[2] * w2,
  ], a);
}

function collectQuatKeyframes(samples, events, keyName) {
  const keys = [];
  for (const s of samples) {
    if (Array.isArray(s[keyName]) && s[keyName].length === 4) {
      keys.push({ t_s: s.t_s, q: normalizeQuat(s[keyName]) });
    }
  }
  for (const e of events) {
    if (Array.isArray(e[keyName]) && e[keyName].length === 4) {
      keys.push({ t_s: e.t_s, q: normalizeQuat(e[keyName]) });
    }
  }
  keys.sort((a, b) => a.t_s - b.t_s);
  const deduped = [];
  for (const k of keys) {
    if (deduped.length > 0 && Math.abs(deduped[deduped.length - 1].t_s - k.t_s) < 1e-6) {
      deduped[deduped.length - 1] = k;
    } else {
      deduped.push(k);
    }
  }
  return deduped;
}

function collectUnitVecKeyframes(events, keyName) {
  const keys = [];
  for (const e of events) {
    if (Array.isArray(e[keyName]) && e[keyName].length === 3) {
      keys.push({ t_s: Number(e.t_s), v: vecNormalize(e[keyName]) });
    }
  }
  keys.sort((a, b) => a.t_s - b.t_s);
  const deduped = [];
  for (const k of keys) {
    if (deduped.length > 0 && Math.abs(deduped[deduped.length - 1].t_s - k.t_s) < 1e-6) {
      deduped[deduped.length - 1] = k;
    } else {
      deduped.push(k);
    }
  }
  return deduped;
}

function interpolateUnitVecKeyframes(keys, t_s, fallback = [1, 0, 0]) {
  if (!keys || keys.length === 0) return [...fallback];
  if (t_s <= keys[0].t_s) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t_s >= last.t_s) return last.v;

  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t_s <= t_s) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.t_s - a.t_s;
  if (span <= 0) return a.v;
  return slerpUnitVec3(a.v, b.v, (t_s - a.t_s) / span);
}

function interpolateQuatKeyframes(keys, t_s, extrapolateEarth = false) {
  if (!keys || keys.length === 0) return [1, 0, 0, 0];
  if (t_s <= keys[0].t_s) return keys[0].q;
  const last = keys[keys.length - 1];
  if (t_s >= last.t_s) {
    if (extrapolateEarth && t_s > last.t_s) {
      const halfAngle = 0.5 * EARTH_ROTATION_RAD_PER_SEC * (t_s - last.t_s);
      const rz = [Math.cos(halfAngle), 0, 0, Math.sin(halfAngle)];
      return normalizeQuat(multiplyQuat(last.q, rz));
    }
    return last.q;
  }
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t_s <= t_s) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.t_s - a.t_s;
  if (span <= 0) return a.q;

  // Over multi-hour/multi-day gaps (e.g. TLI -> LOI where Earth spins multiple full turns),
  // shortest-arc SLERP cannot unwrap >180° turns. Propagate sidereal ITRF-Z spin explicitly
  // and SLERP only the small residual precession/nutation offset to hit b.q identically.
  if (extrapolateEarth && span > 1800) {
    const dt = t_s - a.t_s;
    const u = dt / span;
    const halfAngleFull = 0.5 * EARTH_ROTATION_RAD_PER_SEC * span;
    const rzFull = [Math.cos(halfAngleFull), 0, 0, Math.sin(halfAngleFull)];
    const predictedEnd = normalizeQuat(multiplyQuat(a.q, rzFull));
    const predConj = [predictedEnd[0], -predictedEnd[1], -predictedEnd[2], -predictedEnd[3]];
    const residual = normalizeQuat(multiplyQuat(predConj, b.q));
    const residualAtU = slerpQuat([1, 0, 0, 0], residual, u);
    const halfAngle = 0.5 * EARTH_ROTATION_RAD_PER_SEC * dt;
    const rzAtT = [Math.cos(halfAngle), 0, 0, Math.sin(halfAngle)];
    return normalizeQuat(multiplyQuat(multiplyQuat(a.q, rzAtT), residualAtU));
  }

  return slerpQuat(a.q, b.q, (t_s - a.t_s) / span);
}

function findUpperSampleIndex(samples, t_s) {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t_s <= t_s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function resolveSegmentPhaseAtSample(samples, index) {
  return samples[index]?.phase || 'transfer';
}

function resolveIntervalRMoonVelocities(a, b, dt) {
  if (a.v_moon && b.v_moon) {
    return [a.v_moon, b.v_moon];
  }
  const fallbackMoonV = dt > 0 ? vecScale(vecSub(b.moon_r, a.moon_r), 1 / dt) : [0, 0, 0];
  const vRelA = a.v_moon || (a.moon_v ? vecSub(a.v, a.moon_v) : vecSub(a.v, fallbackMoonV));
  const vRelB = b.v_moon || (b.moon_v ? vecSub(b.v, b.moon_v) : vecSub(b.v, fallbackMoonV));
  return [vRelA, vRelB];
}

function isLunarRelativeDisplay(sample, moonRadiusKm) {
  if (sample.hasExactVMoon) return true;
  if (!sample.v_moon) return false;
  return vecNorm(sample.r_moon) - moonRadiusKm < LUNAR_SPEED_SWITCH_ALT_KM;
}

export function formatMissionDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const totalSec = Math.round(seconds);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${String(mins).padStart(2, '0')}m`;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

export class TrajectoryGenerator {
  /**
   * Parses and validates an `lwp-trajectory/1` JSON document into pure math lookup tables.
   * Zero Three.js dependencies.
   */
  static parse(jsonDoc, options = {}) {
    if (!jsonDoc || typeof jsonDoc !== 'object') {
      throw new Error('Trajectory JSON document must be an object.');
    }
    if (jsonDoc.format && jsonDoc.format !== TRAJECTORY_CONFIG.FORMAT) {
      throw new Error(`Unsupported trajectory format: "${jsonDoc.format}".`);
    }
    const list = Array.isArray(jsonDoc.trajectories) ? jsonDoc.trajectories : [];
    if (list.length === 0) {
      throw new Error('Trajectory JSON contains no entries in "trajectories".');
    }

    let chosen = null;
    if (typeof options.trajectoryIndex === 'number' && list[options.trajectoryIndex]) {
      chosen = list[options.trajectoryIndex];
    } else if (options.spaceportId) {
      chosen = list.find((t) => t.spaceport_id === options.spaceportId) || null;
    }
    if (!chosen) {
      chosen = list.find((t) => t.source !== 'none' && Array.isArray(t.samples) && t.samples.length >= 2);
    }
    if (!chosen) {
      const reason = list[0]?.unavailable_reason || 'No numerical trajectory samples available.';
      throw new Error(reason);
    }

    const rawSamples = chosen.samples;
    if (!Array.isArray(rawSamples) || rawSamples.length < 2) {
      throw new Error('Selected trajectory must contain at least 2 samples.');
    }

    let moonDistSum = 0;
    const samples = rawSamples.map((s) => {
      const r = [Number(s.r[0]), Number(s.r[1]), Number(s.r[2])];
      const v = [Number(s.v[0]), Number(s.v[1]), Number(s.v[2])];
      const moonRVec = [Number(s.moon_r[0]), Number(s.moon_r[1]), Number(s.moon_r[2])];
      moonDistSum += vecNorm(moonRVec);

      const moonVVec =
        Array.isArray(s.moon_v) && s.moon_v.length === 3
          ? [Number(s.moon_v[0]), Number(s.moon_v[1]), Number(s.moon_v[2])]
          : null;

      const hasExactRMoon = Array.isArray(s.r_moon) && s.r_moon.length === 3;
      const r_moon = hasExactRMoon
        ? [Number(s.r_moon[0]), Number(s.r_moon[1]), Number(s.r_moon[2])]
        : vecSub(r, moonRVec);

      const hasExactVMoon = Array.isArray(s.v_moon) && s.v_moon.length === 3;
      const v_moon = hasExactVMoon
        ? [Number(s.v_moon[0]), Number(s.v_moon[1]), Number(s.v_moon[2])]
        : moonVVec
          ? vecSub(v, moonVVec)
          : null;

      return {
        t: s.t || '',
        t_s: Number(s.t_s),
        phase: s.phase || 'transfer',
        r,
        v,
        moon_r: moonRVec,
        moon_v: moonVVec,
        r_moon,
        v_moon,
        hasExactRMoon,
        hasExactVMoon,
        earth_q: Array.isArray(s.earth_q) ? normalizeQuat(s.earth_q) : null,
        moon_q: Array.isArray(s.moon_q) ? normalizeQuat(s.moon_q) : null,
      };
    });

    const events = Array.isArray(chosen.events) ? chosen.events.map((e) => ({ ...e })) : [];
    const phases = Array.isArray(chosen.phases) ? chosen.phases.map((p) => [...p]) : [];
    const moonQKeys = collectQuatKeyframes(samples, events, 'moon_q');
    const earthQKeys = collectQuatKeyframes(samples, events, 'earth_q');
    const sunDirKeys = collectUnitVecKeyframes(events, 'sun_dir');

    const earthRadiusKm = Number(jsonDoc.earth?.radius_km) || 6378.1363;
    const moonRadiusKm = Number(jsonDoc.moon?.radius_km) || MOON_CONFIG.RADIUS_KM;
    const meanMoonDistanceKm = Math.max(earthRadiusKm + moonRadiusKm + 1, moonDistSum / samples.length);

    let totalDeltaVKmS = 0;
    for (const ev of events) {
      if (Array.isArray(ev.delta_v) && ev.delta_v.length === 3) {
        totalDeltaVKmS += vecNorm(ev.delta_v);
      }
    }

    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];
    const durationSec = Math.max(0, lastSample.t_s - firstSample.t_s);
    const launchUtc = chosen.start?.t || firstSample.t || '';
    const launchTimestampMs = parseUtcStringToMs(launchUtc);

    const landingSite = jsonDoc.landing_site || chosen.end || {};
    const spaceport = chosen.spaceport || chosen.start || {};

    return {
      format: jsonDoc.format || TRAJECTORY_CONFIG.FORMAT,
      earthRadiusKm,
      moonRadiusKm,
      meanMoonDistanceKm,
      launchTimestampMs,
      landingSite: {
        latDeg: Number(landingSite.lat_deg ?? 0),
        lonDeg: Number(landingSite.lon_deg ?? 0),
        heightKm: Number(landingSite.height_km ?? 0),
        bodyFixedKm: Array.isArray(landingSite.body_fixed_km) ? [...landingSite.body_fixed_km] : null,
      },
      spaceport: {
        id: chosen.spaceport_id || '',
        name: chosen.spaceport_name || chosen.spaceport_id || 'Launch Site',
        latDeg: Number(spaceport.lat_deg ?? 0),
        lonDeg: Number(spaceport.lon_deg ?? 0),
      },
      meta: {
        rocket: chosen.rocket || 'Lunar Vehicle',
        ascentModel: chosen.ascent_model || 'numerical',
        spaceportName: chosen.spaceport_name || chosen.spaceport_id || 'Launch Site',
        launchUtc,
        touchdownUtc: chosen.end?.t || lastSample.t || '',
        launchTimestampMs,
        tStart: firstSample.t_s,
        tEnd: lastSample.t_s,
        durationSec,
        totalDeltaVKmS,
        sampleCount: samples.length,
        eventCount: events.length,
      },
      phases,
      events,
      samples,
      moonQKeys,
      earthQKeys,
      sunDirKeys,
    };
  }

  /**
   * Evaluates interpolated J2000 state at any mission elapsed time `t_s`,
   * handling zero-Δt phase boundary pairs safely without dividing by 0.
   */
  static evaluateStateAtTime(parsed, tQuery) {
    const samples = parsed.samples;
    const tMin = samples[0].t_s;
    const tMax = samples[samples.length - 1].t_s;
    const t_s = Math.max(tMin, Math.min(tMax, tQuery));

    let i = findUpperSampleIndex(samples, t_s);
    if (i >= samples.length - 1) i = samples.length - 2;
    while (i < samples.length - 2 && samples[i + 1].t_s === samples[i].t_s) {
      i++;
    }

    const a = samples[i];
    const b = samples[i + 1];
    const dt = b.t_s - a.t_s;
    const f = dt > 0 ? Math.max(0, Math.min(1, (t_s - a.t_s) / dt)) : 0;

    let r;
    let v;
    let moon_r;
    let moon_v;
    let r_moon;
    let v_moon;
    let hasExactVMoon = false;

    if (dt <= 0) {
      r = [...b.r];
      v = [...b.v];
      moon_r = [...b.moon_r];
      moon_v = b.moon_v ? [...b.moon_v] : null;
      r_moon = [...b.r_moon];
      v_moon = b.v_moon ? [...b.v_moon] : moon_v ? vecSub(v, moon_v) : null;
      hasExactVMoon = Boolean(b.hasExactVMoon);
    } else {
      r = hermiteInterpolate(a.t_s, a.r, a.v, b.t_s, b.r, b.v, t_s);
      v = hermiteVelocity(a.t_s, a.r, a.v, b.t_s, b.r, b.v, t_s);

      if (a.moon_v && b.moon_v) {
        moon_r = hermiteInterpolate(a.t_s, a.moon_r, a.moon_v, b.t_s, b.moon_r, b.moon_v, t_s);
        moon_v = hermiteVelocity(a.t_s, a.moon_r, a.moon_v, b.t_s, b.moon_r, b.moon_v, t_s);
      } else {
        moon_r = interpolateVec3Linear(a.moon_r, b.moon_r, f);
        moon_v = null;
      }

      if (a.hasExactRMoon && b.hasExactRMoon) {
        const [vRelA, vRelB] = resolveIntervalRMoonVelocities(a, b, dt);
        r_moon = hermiteInterpolate(a.t_s, a.r_moon, vRelA, b.t_s, b.r_moon, vRelB, t_s);
        v_moon = hermiteVelocity(a.t_s, a.r_moon, vRelA, b.t_s, b.r_moon, vRelB, t_s);
        hasExactVMoon = Boolean(a.hasExactVMoon && b.hasExactVMoon);
      } else {
        r_moon = vecSub(r, moon_r);
        v_moon = moon_v ? vecSub(v, moon_v) : null;
      }
    }

    const moon_q = interpolateQuatKeyframes(parsed.moonQKeys, t_s, false);
    const earth_q = interpolateQuatKeyframes(parsed.earthQKeys, t_s, true);
    const sun_dir = interpolateUnitVecKeyframes(parsed.sunDirKeys, t_s, [1, 0, 0]);

    const earthDistanceKm = vecNorm(r);
    const moonDistanceKm = vecNorm(r_moon);
    const isLunarRelSpeed =
      hasExactVMoon || (Boolean(v_moon) && moonDistanceKm - parsed.moonRadiusKm < LUNAR_SPEED_SWITCH_ALT_KM);
    const earthSpeedKmS = vecNorm(v);
    const moonSpeedKmS = v_moon ? vecNorm(v_moon) : null;

    return {
      t_s,
      phase: f < 1 ? resolveSegmentPhaseAtSample(samples, i) : b.phase,
      r,
      v,
      moon_r,
      moon_v,
      r_moon,
      v_moon,
      moon_q,
      earth_q,
      sun_dir,
      earthDistanceKm,
      moonDistanceKm,
      earthSpeedKmS,
      moonSpeedKmS,
      isLunarRelSpeed,
      speedKmS: isLunarRelSpeed && moonSpeedKmS !== null ? moonSpeedKmS : earthSpeedKmS,
    };
  }

  /**
   * Computes scaled Moon center position in J2000-aligned Cislunar Scene coordinates
   * (Earth at `[0, 0, 0]`, Moon–Earth distance compressed around `cislunarDistance`
   * while preserving orbital inclination, phase angle, and eccentricity).
   */
  static getCompressedMoonCenterScene(moon_r, parsed, sceneParams = {}) {
    const cislunarDist = sceneParams.cislunarDistance ?? EARTH_CONFIG.CISLUNAR_DISTANCE;
    const refDistKm = parsed.meanMoonDistanceKm || 384400;
    const mrKm = vecNorm(moon_r);
    const mrDirScene = vecNormalize(j2000ToSceneAxes(moon_r), [1, 0, 0]);
    const visDist = cislunarDist * (mrKm / refDistKm);
    return vecScale(mrDirScene, visDist);
  }

  /**
   * Evaluates full instantaneous physical ephemeris and body orientations in Three.js Scene space
   * for any mission elapsed time `t_s`:
   * - Earth centered at `(0, 0, 0)` with exact `earth_q(t_s)` (tilt + precession + sidereal spin)
   * - Moon orbiting along true `moon_r(t_s)` at compressed `cislunarDistance`, spinning via `moon_q(t_s)`
   *   so axial rotation, orbital motion, and lunar libration match reality
   * - Sun positioned along real `sun_dir(t_s)` (Earth–Moon orbital motion relative to Sun)
   * - Sky fixed in exact J2000 ICRF `[0, 0, 0, 1]`
   */
  static evaluatePhysicalSceneAtTime(parsed, tQuery, sceneParams = {}) {
    const state = TrajectoryGenerator.evaluateStateAtTime(parsed, tQuery);
    const cislunarDist = sceneParams.cislunarDistance ?? EARTH_CONFIG.CISLUNAR_DISTANCE;
    const refDistKm = parsed.meanMoonDistanceKm || 384400;

    const moonOrbitRadiusKm = vecNorm(state.moon_r);
    const moonDirScene = vecNormalize(j2000ToSceneAxes(state.moon_r), [1, 0, 0]);
    const moonDistanceVis = cislunarDist * (moonOrbitRadiusKm / refDistKm);
    const moonPositionScene = vecScale(moonDirScene, moonDistanceVis);

    const earthPositionScene = [0, 0, 0];
    const earthQuaternionScene = j2000QuatToScene(state.earth_q);
    const moonQuaternionScene = j2000QuatToScene(state.moon_q);
    const sunDirScene = vecNormalize(j2000ToSceneAxes(state.sun_dir), [1, 0, 0]);
    const earthDirFromMoonWorld = vecScale(moonDirScene, -1);

    // Body-fixed MOON_ME coordinates for subsolar & sub-Earth (libration) telemetry
    const sunBodyMe = j2000ToSceneAxes(rotateInvByQuat(state.moon_q, state.sun_dir));
    const earthBodyMe = j2000ToSceneAxes(rotateInvByQuat(state.moon_q, vecScale(state.moon_r, -1)));
    const subSolar = vectorSceneToLatLonDeg(sunBodyMe);
    const subEarth = vectorSceneToLatLonDeg(earthBodyMe);

    const utcTimestampMs =
      parsed.launchTimestampMs !== null ? parsed.launchTimestampMs + state.t_s * 1000 : null;

    return {
      t_s: state.t_s,
      utcTimestampMs,
      utcIso: utcTimestampMs !== null ? new Date(utcTimestampMs).toISOString() : state.t || '',
      earthPositionScene,
      earthQuaternionScene,
      moonPositionScene,
      moonQuaternionScene,
      moonDirScene,
      moonDistanceVis,
      moonOrbitRadiusKm,
      sunDirScene,
      skyQuaternionScene: [0, 0, 0, 1],
      earthDirFromMoonWorld,
      subSolarLatDeg: subSolar.latDeg,
      subSolarLonDeg: subSolar.lonDeg,
      subEarthLatDeg: subEarth.latDeg,
      subEarthLonDeg: subEarth.lonDeg,
    };
  }

  /**
   * Maps one evaluated J2000 trajectory state into the J2000-aligned Cislunar Scene Space:
   * - Earth center is `(0, 0, 0)`, radius `earthRadius`
   * - Moon center is `getCompressedMoonCenterScene(state.moon_r)`, radius `moonRadius`
   * - Preserves true 3D J2000 orbital geometry while expanding near-Earth and near-Moon
   *   radial envelopes smoothly and monotonically with zero overlap or kinks
   */
  static mapStateToCislunarScene(state, parsed, sceneParams = {}) {
    const earthRadius = sceneParams.earthRadius ?? EARTH_CONFIG.RADIUS;
    const moonRadius = sceneParams.moonRadius ?? MOON_CONFIG.RADIUS;
    const cislunarDist = sceneParams.cislunarDistance ?? EARTH_CONFIG.CISLUNAR_DISTANCE;
    const refDistKm = parsed.meanMoonDistanceKm || 384400;
    const scale = cislunarDist / refDistKm;

    const R_E_km = parsed.earthRadiusKm;
    const R_M_km = parsed.moonRadiusKm;
    const D_km = Math.max(R_E_km + R_M_km + 1, vecNorm(state.moon_r));

    const r_sc = j2000ToSceneAxes(state.r);
    const rm_sc = j2000ToSceneAxes(state.r_moon);
    const moonCenter = TrajectoryGenerator.getCompressedMoonCenterScene(state.moon_r, parsed, {
      cislunarDistance: cislunarDist,
    });

    const dE_km = vecNorm(state.r);
    const dM_km = vecNorm(state.r_moon);

    const chordBase = vecScale(r_sc, scale);

    // Near-Earth radial clearance envelope around (0, 0, 0)
    const rawSurfaceE = R_E_km * scale;
    const rawDistE = dE_km * scale;
    const altE_norm = Math.max(0, (dE_km - R_E_km) / R_E_km);
    const fadeE = 1.0 - smoothstep(R_E_km * 1.15, D_km * 0.7, dE_km);
    // Gentle LEO altitude separation that decays slowly over 0.25..5.0 R_E to guarantee monotonic TLI departure
    const leoLift =
      earthRadius *
      0.042 *
      smoothstep(0, 0.028, altE_norm) *
      (1.0 - smoothstep(0.25, 5.0, altE_norm));
    const targetDistE = rawDistE + (earthRadius + 0.004 - rawSurfaceE + leoLift) * fadeE;
    const dirE = vecNormalize(r_sc, [1, 0, 0]);

    // Near-Moon radial envelope anchored to instantaneous moonCenter(t_s)
    const rawSurfaceM = R_M_km * scale;
    const rawDistM = dM_km * scale;
    const altM_norm = Math.max(0, (dM_km - R_M_km) / R_M_km);
    const fadeM = 1.0 - smoothstep(R_M_km * 1.25, D_km * 0.25, dM_km);
    const lloLift =
      moonRadius *
      0.052 *
      smoothstep(0, 0.052, altM_norm) *
      (1.0 - smoothstep(0.15, 0.8, altM_norm));
    const targetDistM = rawDistM + (moonRadius + 0.0025 - rawSurfaceM + lloLift) * fadeM;
    const dirM = vecNormalize(rm_sc, [1, 0, 0]);

    let pos = chordBase;
    if (fadeE > 1e-6) {
      const pE = vecScale(dirE, targetDistE);
      pos = vecAdd(vecScale(pos, 1 - fadeE), vecScale(pE, fadeE));
    }
    if (fadeM > 1e-6) {
      const pM = vecAdd(moonCenter, vecScale(dirM, targetDistM));
      pos = vecAdd(vecScale(pos, 1 - fadeM), vecScale(pM, fadeM));
    }

    return pos;
  }

  /**
   * Generates phase-tagged & compression-tagged polylines (`isCompressed: true` on the long
   * cislunar bridge across the compressed Earth–Moon gap; `isCompressed: false` on solid
   * near-Earth and near-Moon phases/arcs), Moon's orbital arc, mapped milestone events, and playback lookup.
   */
  static generateCislunarPath(parsed, sceneParams = {}) {
    const earthRadius = sceneParams.earthRadius ?? EARTH_CONFIG.RADIUS;
    const moonRadius = sceneParams.moonRadius ?? MOON_CONFIG.RADIUS;
    const cislunarDistance = sceneParams.cislunarDistance ?? EARTH_CONFIG.CISLUNAR_DISTANCE;

    const nearEarthSolidKm = parsed.earthRadiusKm * TRAJECTORY_CONFIG.NEAR_EARTH_SOLID_RADIUS_MULT;
    const nearMoonSolidKm = parsed.moonRadiusKm * TRAJECTORY_CONFIG.NEAR_MOON_SOLID_RADIUS_MULT;

    const normalizedSceneParams = {
      earthRadius,
      moonRadius,
      cislunarDistance,
    };

    const samples = parsed.samples;
    const denseSamples = [];

    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      denseSamples.push(a);

      const dt = b.t_s - a.t_s;
      if (dt > 0) {
        const minEarthDistKm = Math.min(vecNorm(a.r), vecNorm(b.r));
        const minMoonDistKm = Math.min(vecNorm(a.r_moon), vecNorm(b.r_moon));

        let substeps = 1;
        if (dt > 30 && minEarthDistKm < 65000) {
          substeps = Math.max(substeps, Math.ceil(dt / 25));
        } else if (dt > 20 && minMoonDistKm < 12000) {
          substeps = Math.max(substeps, Math.ceil(dt / 15));
        } else if (dt > 120) {
          substeps = Math.max(substeps, Math.ceil(dt / 180));
        }
        substeps = Math.min(substeps, 16);

        const [vRelA, vRelB] =
          a.hasExactRMoon && b.hasExactRMoon ? resolveIntervalRMoonVelocities(a, b, dt) : [null, null];

        for (let k = 1; k < substeps; k++) {
          const f = k / substeps;
          const tq = a.t_s + dt * f;
          const r = hermiteInterpolate(a.t_s, a.r, a.v, b.t_s, b.r, b.v, tq);
          const v = hermiteVelocity(a.t_s, a.r, a.v, b.t_s, b.r, b.v, tq);
          const moon_r =
            a.moon_v && b.moon_v
              ? hermiteInterpolate(a.t_s, a.moon_r, a.moon_v, b.t_s, b.moon_r, b.moon_v, tq)
              : interpolateVec3Linear(a.moon_r, b.moon_r, f);
          const moon_v =
            a.moon_v && b.moon_v
              ? hermiteVelocity(a.t_s, a.moon_r, a.moon_v, b.t_s, b.moon_r, b.moon_v, tq)
              : null;

          let r_moon;
          let v_moon;
          if (vRelA && vRelB) {
            r_moon = hermiteInterpolate(a.t_s, a.r_moon, vRelA, b.t_s, b.r_moon, vRelB, tq);
            v_moon = hermiteVelocity(a.t_s, a.r_moon, vRelA, b.t_s, b.r_moon, vRelB, tq);
          } else {
            r_moon = vecSub(r, moon_r);
            v_moon = moon_v ? vecSub(v, moon_v) : null;
          }

          denseSamples.push({
            t_s: tq,
            phase: a.phase,
            r,
            v,
            moon_r,
            moon_v,
            r_moon,
            v_moon,
            hasExactRMoon: Boolean(a.hasExactRMoon && b.hasExactRMoon),
            hasExactVMoon: Boolean(a.hasExactVMoon && b.hasExactVMoon),
          });
        }
      }
    }
    denseSamples.push(samples[samples.length - 1]);

    const totalPoints = denseSamples.length;
    const allPoints = new Float32Array(totalPoints * 3);
    const allDirs = new Float32Array(totalPoints * 3);
    const allTimes = new Float64Array(totalPoints);
    const allPhases = new Array(totalPoints);
    const allCompressed = new Uint8Array(totalPoints);
    const allEarthAltKm = new Float32Array(totalPoints);
    const allMoonAltKm = new Float32Array(totalPoints);
    const allSpeedKmS = new Float32Array(totalPoints);
    const allIsLunarRelSpeed = new Uint8Array(totalPoints);

    let terminalStartSec = null;
    for (let i = 0; i < totalPoints; i++) {
      if (denseSamples[i].phase === 'terminal') {
        terminalStartSec = denseSamples[i].t_s;
        break;
      }
    }

    for (let i = 0; i < totalPoints; i++) {
      const ds = denseSamples[i];
      const pos = TrajectoryGenerator.mapStateToCislunarScene(
        {
          r: ds.r,
          moon_r: ds.moon_r,
          r_moon: ds.r_moon,
        },
        parsed,
        normalizedSceneParams
      );
      const dE_km = vecNorm(ds.r);
      const dM_km = vecNorm(ds.r_moon);
      allPoints[i * 3] = pos[0];
      allPoints[i * 3 + 1] = pos[1];
      allPoints[i * 3 + 2] = pos[2];
      allTimes[i] = ds.t_s;
      allPhases[i] = ds.phase;
      allCompressed[i] =
        ds.phase === 'transfer' && dE_km > nearEarthSolidKm && dM_km > nearMoonSolidKm ? 1 : 0;
      allEarthAltKm[i] = dE_km - parsed.earthRadiusKm;
      allMoonAltKm[i] = dM_km - parsed.moonRadiusKm;

      const lunarRel = isLunarRelativeDisplay(ds, parsed.moonRadiusKm);
      allIsLunarRelSpeed[i] = lunarRel ? 1 : 0;
      allSpeedKmS[i] = lunarRel && ds.v_moon ? vecNorm(ds.v_moon) : vecNorm(ds.v);
    }

    // Compute clean spacecraft axis directions along the rendered trajectory;
    // during terminal touchdown & surface dwell, smoothly orient upright away from Moon center.
    let lastFlightDir = [0, 1, 0];
    for (let i = 0; i < totalPoints; i++) {
      const ds = denseSamples[i];
      let dir = null;

      if (i + 1 < totalPoints && allTimes[i + 1] > allTimes[i]) {
        const d = [
          allPoints[(i + 1) * 3] - allPoints[i * 3],
          allPoints[(i + 1) * 3 + 1] - allPoints[i * 3 + 1],
          allPoints[(i + 1) * 3 + 2] - allPoints[i * 3 + 2],
        ];
        if (vecNorm(d) > 1e-6) {
          dir = vecNormalize(d, lastFlightDir);
        }
      } else if (i > 0) {
        const d = [
          allPoints[i * 3] - allPoints[(i - 1) * 3],
          allPoints[i * 3 + 1] - allPoints[(i - 1) * 3 + 1],
          allPoints[i * 3 + 2] - allPoints[(i - 1) * 3 + 2],
        ];
        if (vecNorm(d) > 1e-6) {
          dir = vecNormalize(d, lastFlightDir);
        }
      }

      if (!dir) {
        dir = vecNormalize(j2000ToSceneAxes(ds.v_moon || ds.v), lastFlightDir);
      }

      if (ds.phase !== 'terminal') {
        lastFlightDir = dir;
      } else if (terminalStartSec !== null) {
        const moonUp = vecNormalize(j2000ToSceneAxes(ds.r_moon), [0, 1, 0]);
        const settleBlend = smoothstep(terminalStartSec, terminalStartSec + 7.0, ds.t_s);
        dir = slerpUnitVec3(lastFlightDir, moonUp, settleBlend);
      }

      allDirs[i * 3] = dir[0];
      allDirs[i * 3 + 1] = dir[1];
      allDirs[i * 3 + 2] = dir[2];
    }

    // Build contiguous segments split by both phase and compression state
    const segments = [];
    let segStart = 0;
    for (let i = 1; i <= totalPoints; i++) {
      const boundary =
        i === totalPoints ||
        allPhases[i] !== allPhases[segStart] ||
        allCompressed[i] !== allCompressed[segStart];
      if (boundary) {
        const segEnd = i - 1;
        const includeNext = i < totalPoints && allTimes[i] > allTimes[segEnd];
        const endIdx = includeNext ? i : segEnd;
        const count = endIdx - segStart + 1;
        if (count >= 2) {
          segments.push({
            phase: allPhases[segStart],
            isCompressed: Boolean(allCompressed[segStart]),
            tStart: allTimes[segStart],
            tEnd: allTimes[endIdx],
            pointCount: count,
            points: allPoints.slice(segStart * 3, (endIdx + 1) * 3),
            times: allTimes.slice(segStart, endIdx + 1),
          });
        }
        segStart = i;
      }
    }

    // Sample Moon's actual orbital arc across the mission duration for visualization
    const orbitArcCount = 128;
    const moonOrbitPoints = new Float32Array(orbitArcCount * 3);
    const tMin = parsed.meta.tStart ?? 0;
    const duration = Math.max(0, (parsed.meta.tEnd ?? parsed.meta.durationSec) - tMin);
    for (let i = 0; i < orbitArcCount; i++) {
      const tq = tMin + (duration * i) / (orbitArcCount - 1);
      const st = TrajectoryGenerator.evaluateStateAtTime(parsed, tq);
      const mc = TrajectoryGenerator.getCompressedMoonCenterScene(st.moon_r, parsed, normalizedSceneParams);
      moonOrbitPoints[i * 3] = mc[0];
      moonOrbitPoints[i * 3 + 1] = mc[1];
      moonOrbitPoints[i * 3 + 2] = mc[2];
    }

    // Map milestone events to exact scene coordinates
    const mappedEvents = parsed.events.map((ev) => {
      const state = TrajectoryGenerator.evaluateStateAtTime(parsed, ev.t_s);
      const scenePos = TrajectoryGenerator.mapStateToCislunarScene(
        state,
        parsed,
        normalizedSceneParams
      );
      const moonCenterScene = TrajectoryGenerator.getCompressedMoonCenterScene(
        state.moon_r,
        parsed,
        normalizedSceneParams
      );
      const deltaVKmS = Array.isArray(ev.delta_v) ? vecNorm(ev.delta_v) : null;
      return {
        name: ev.name,
        description: ev.description || ev.name,
        t: ev.t || '',
        t_s: ev.t_s,
        phase: state.phase,
        deltaVKmS,
        scenePos,
        moonCenterScene,
        isMajor: TRAJECTORY_CONFIG.MAJOR_EVENTS.has(ev.name),
      };
    });

    const initialMoonCenter = TrajectoryGenerator.getCompressedMoonCenterScene(
      samples[0].moon_r,
      parsed,
      normalizedSceneParams
    );
    const midOrbitIdx = Math.floor(orbitArcCount / 2) * 3;
    const refMoonCenter =
      moonOrbitPoints.length >= midOrbitIdx + 3
        ? [
            moonOrbitPoints[midOrbitIdx],
            moonOrbitPoints[midOrbitIdx + 1],
            moonOrbitPoints[midOrbitIdx + 2],
          ]
        : initialMoonCenter;

    // Approximate center & bounding radius of the 3D figure formed by Earth, Moon (orbital arc), and trajectory
    let minX = -earthRadius;
    let maxX = earthRadius;
    let minY = -earthRadius;
    let maxY = earthRadius;
    let minZ = -earthRadius;
    let maxZ = earthRadius;

    for (let i = 0; i < allPoints.length; i += 3) {
      const x = allPoints[i];
      const y = allPoints[i + 1];
      const z = allPoints[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    for (let i = 0; i < moonOrbitPoints.length; i += 3) {
      const x = moonOrbitPoints[i];
      const y = moonOrbitPoints[i + 1];
      const z = moonOrbitPoints[i + 2];
      minX = Math.min(minX, x - moonRadius);
      maxX = Math.max(maxX, x + moonRadius);
      minY = Math.min(minY, y - moonRadius);
      maxY = Math.max(maxY, y + moonRadius);
      minZ = Math.min(minZ, z - moonRadius);
      maxZ = Math.max(maxZ, z + moonRadius);
    }
    const figureCenter = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];
    let figureRadius = Math.hypot(figureCenter[0], figureCenter[1], figureCenter[2]) + earthRadius;
    for (let i = 0; i < allPoints.length; i += 3) {
      const d = Math.hypot(
        allPoints[i] - figureCenter[0],
        allPoints[i + 1] - figureCenter[1],
        allPoints[i + 2] - figureCenter[2]
      );
      if (d > figureRadius) figureRadius = d;
    }
    for (let i = 0; i < moonOrbitPoints.length; i += 3) {
      const d =
        Math.hypot(
          moonOrbitPoints[i] - figureCenter[0],
          moonOrbitPoints[i + 1] - figureCenter[1],
          moonOrbitPoints[i + 2] - figureCenter[2]
        ) + moonRadius;
      if (d > figureRadius) figureRadius = d;
    }

    return {
      meta: parsed.meta,
      landingSite: parsed.landingSite,
      spaceport: parsed.spaceport,
      sceneParams: {
        earthRadius,
        moonRadius,
        cislunarDistance,
        earthCenter: [0, 0, 0],
        initialMoonCenter,
        refMoonCenter,
        figureCenter,
        figureRadius,
      },
      segments,
      moonOrbitPoints,
      events: mappedEvents,
      allPoints,
      allDirs,
      allTimes,
      allPhases,
      allEarthAltKm,
      allMoonAltKm,
      allSpeedKmS,
      allIsLunarRelSpeed,
    };
  }

  /**
   * Samples interpolated scene position, forward tangent direction, and mission telemetry
   * from an already-generated cislunar trajectory at elapsed mission time `t_s`.
   */
  static sampleSpacecraftAtTime(generated, tQuery) {
    const times = generated.allTimes;
    const points = generated.allPoints;
    const count = times.length;
    if (count === 0) return null;

    const tMin = times[0];
    const tMax = times[count - 1];
    const t_s = Math.max(tMin, Math.min(tMax, tQuery));
    const progress = tMax > tMin ? (t_s - tMin) / (tMax - tMin) : 0;

    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t_s) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= count - 1) lo = count - 2;
    while (lo < count - 2 && times[lo + 1] === times[lo]) {
      lo++;
    }

    const i0 = lo;
    const i1 = lo + 1;
    const dt = times[i1] - times[i0];
    const f = dt > 0 ? Math.max(0, Math.min(1, (t_s - times[i0]) / dt)) : 0;

    const p0 = [points[i0 * 3], points[i0 * 3 + 1], points[i0 * 3 + 2]];
    const p1 = [points[i1 * 3], points[i1 * 3 + 1], points[i1 * 3 + 2]];
    const pos = [
      p0[0] + (p1[0] - p0[0]) * f,
      p0[1] + (p1[1] - p0[1]) * f,
      p0[2] + (p1[2] - p0[2]) * f,
    ];

    let dir;
    if (generated.allDirs && generated.allDirs.length === points.length) {
      const d0 = [
        generated.allDirs[i0 * 3],
        generated.allDirs[i0 * 3 + 1],
        generated.allDirs[i0 * 3 + 2],
      ];
      const d1 = [
        generated.allDirs[i1 * 3],
        generated.allDirs[i1 * 3 + 1],
        generated.allDirs[i1 * 3 + 2],
      ];
      dir = vecNormalize(interpolateVec3Linear(d0, d1, f), [0, 1, 0]);
    } else {
      dir = vecSub(p1, p0);
      if (vecNorm(dir) < 1e-6 && i1 + 1 < count) {
        const p2 = [points[(i1 + 1) * 3], points[(i1 + 1) * 3 + 1], points[(i1 + 1) * 3 + 2]];
        dir = vecSub(p2, p0);
      }
      dir = vecNormalize(dir, [0, 1, 0]);
    }

    const earthAltKm =
      generated.allEarthAltKm[i0] +
      (generated.allEarthAltKm[i1] - generated.allEarthAltKm[i0]) * f;
    const moonAltKm =
      generated.allMoonAltKm[i0] +
      (generated.allMoonAltKm[i1] - generated.allMoonAltKm[i0]) * f;
    const speedKmS =
      generated.allSpeedKmS[i0] +
      (generated.allSpeedKmS[i1] - generated.allSpeedKmS[i0]) * f;

    const isLunarRelSpeed = generated.allIsLunarRelSpeed
      ? Boolean(f < 0.5 ? generated.allIsLunarRelSpeed[i0] : generated.allIsLunarRelSpeed[i1])
      : moonAltKm < LUNAR_SPEED_SWITCH_ALT_KM;

    return {
      t_s,
      progress,
      phase: f < 1 ? generated.allPhases[i0] : generated.allPhases[i1],
      pos,
      dir,
      earthAltKm,
      moonAltKm,
      speedKmS,
      isLunarRelSpeed,
    };
  }
}
