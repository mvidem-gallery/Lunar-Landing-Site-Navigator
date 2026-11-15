import { TRAJECTORY_CONFIG } from '../config/constants.js';
import { formatMissionDuration, parseUtcStringToMs } from '../astronomy/trajectoryGenerator.js';

export const MISSION_SCHEMA_VERSION = 2;

export function formatCoords(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return 'UNSET';
  const nLat = Number(lat);
  const nLon = Number(lon);
  const latDir = nLat >= 0 ? 'N' : 'S';
  const lonDir = nLon >= 0 ? 'E' : 'W';
  return `${Math.abs(nLat).toFixed(3)}°${latDir}, ${Math.abs(nLon).toFixed(3)}°${lonDir}`;
}

export function formatUtcTimestamp(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return 'UNSET';
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return 'UNSET';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatUtcCompact(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return 'UNSET';
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return 'UNSET';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function toDatetimeLocalUtc(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return '';
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 16);
}

export function parseDatetimeLocalUtc(val) {
  if (!val || typeof val !== 'string') return null;
  const normalized = val.endsWith('Z') ? val : `${val}:00Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function formatTransitDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '—';
  return formatMissionDuration(Number(seconds));
}

export function computeTransitDurationSec(launchDateIso, landingDateIso) {
  if (!launchDateIso || !landingDateIso) return null;
  const launchMs = Date.parse(launchDateIso);
  const landingMs = Date.parse(landingDateIso);
  if (!Number.isFinite(launchMs) || !Number.isFinite(landingMs)) return null;
  const diffSec = (landingMs - launchMs) / 1000;
  return diffSec >= 0 ? Math.round(diffSec) : null;
}

export function extractTrajectoryMeta(info) {
  if (!info || !info.meta) return null;
  const launchMs = parseUtcStringToMs(info.meta.launchUtc) ?? info.meta.launchTimestampMs ?? null;
  const touchdownMs =
    parseUtcStringToMs(info.meta.touchdownUtc) ??
    (launchMs !== null && Number.isFinite(info.meta.durationSec)
      ? launchMs + info.meta.durationSec * 1000
      : null);

  const uniquePhases = [];
  const seen = new Set();
  for (const seg of info.segments || []) {
    if (seg?.phase && !seen.has(seg.phase)) {
      seen.add(seg.phase);
      uniquePhases.push(seg.phase);
    }
  }

  return {
    rocket: String(info.meta.rocket || 'Lunar Vehicle'),
    spaceportName: String(info.meta.spaceportName || info.spaceport?.name || 'Launch Site'),
    launchUtc: launchMs !== null ? new Date(launchMs).toISOString() : String(info.meta.launchUtc || ''),
    touchdownUtc:
      touchdownMs !== null ? new Date(touchdownMs).toISOString() : String(info.meta.touchdownUtc || ''),
    durationSec: Number.isFinite(Number(info.meta.durationSec)) ? Number(info.meta.durationSec) : null,
    totalDeltaVKmS: Number.isFinite(Number(info.meta.totalDeltaVKmS))
      ? Number(info.meta.totalDeltaVKmS)
      : null,
    sampleCount: Number(info.meta.sampleCount || 0),
    eventCount: Number(info.meta.eventCount || 0),
    phases: uniquePhases,
    landingLatDeg: Number.isFinite(Number(info.landingSite?.latDeg))
      ? Number(info.landingSite.latDeg)
      : null,
    landingLonDeg: Number.isFinite(Number(info.landingSite?.lonDeg))
      ? Number(info.landingSite.lonDeg)
      : null,
  };
}

export function normalizeLandingSite(site) {
  if (!site || !Number.isFinite(Number(site.lat)) || !Number.isFinite(Number(site.lon))) {
    return null;
  }
  const lat = Number(Number(site.lat).toFixed(5));
  const lon = Number(Number(site.lon).toFixed(5));
  return {
    name: String(site.name || `Landing Target ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`).trim(),
    lat,
    lon,
    note: String(site.note || '').trim(),
    visible: site.visible !== false,
  };
}

export function normalizeFlight(flight, fallbackLandingIso = null) {
  const f = flight && typeof flight === 'object' ? flight : {};
  const launchDateIso =
    typeof f.launchDateIso === 'string' && Number.isFinite(Date.parse(f.launchDateIso))
      ? new Date(Date.parse(f.launchDateIso)).toISOString()
      : null;
  const rawLanding =
    typeof f.landingDateIso === 'string' && Number.isFinite(Date.parse(f.landingDateIso))
      ? new Date(Date.parse(f.landingDateIso)).toISOString()
      : fallbackLandingIso;
  const computedTransit = computeTransitDurationSec(launchDateIso, rawLanding);
  const transitDurationSec = Number.isFinite(Number(f.transitDurationSec)) && Number(f.transitDurationSec) >= 0
    ? Math.round(Number(f.transitDurationSec))
    : computedTransit;

  return {
    launchDateIso,
    landingDateIso: rawLanding,
    transitDurationSec,
    dateSource: f.dateSource || (rawLanding ? 'manual' : 'unset'),
  };
}

export function normalizeTrajectoryConfig(traj) {
  const t = traj && typeof traj === 'object' ? traj : {};
  let sourceType = t.sourceType;
  if (sourceType !== 'url' && sourceType !== 'uploaded' && sourceType !== 'none') {
    sourceType = t.url ? 'url' : t.docId ? 'uploaded' : 'none';
  }
  return {
    sourceType,
    url: sourceType === 'url' ? String(t.url || TRAJECTORY_CONFIG.DEFAULT_URL) : null,
    docId: sourceType === 'uploaded' && t.docId ? String(t.docId) : null,
    fileName: t.fileName ? String(t.fileName) : sourceType === 'url' ? 'trajectory-default.json' : null,
    visible: t.visible !== false,
    meta: t.meta && typeof t.meta === 'object' ? t.meta : null,
  };
}

export function normalizeMission(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const points = Array.isArray(m.points)
    ? m.points
        .filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
        .map((p) => ({
          id: String(p.id || `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
          name: String(p.name || 'Point').trim() || 'Point',
          lat: Number(Number(p.lat).toFixed(5)),
          lon: Number(Number(p.lon).toFixed(5)),
          note: String(p.note || ''),
          createdAt: typeof p.createdAt === 'string' ? p.createdAt : null,
          visible: p.visible !== false,
        }))
    : [];

  const measurements = Array.isArray(m.measurements)
    ? m.measurements.filter((item) => item && Array.isArray(item.points))
    : [];

  let landingSite = normalizeLandingSite(m.landingSite);
  let filteredPoints = points;

  // Migrate legacy v1 missions that had no explicit landingSite
  if (!landingSite && !m.schemaVersion && points.length > 0) {
    const first = points[0];
    landingSite = normalizeLandingSite({
      name: first.name,
      lat: first.lat,
      lon: first.lon,
      note: first.note,
      visible: first.visible !== false,
    });
    if (first.id === 'mp-malapert' || first.id === 'mp-apollo11') {
      filteredPoints = points.slice(1);
    }
  }

  let defaultTraj = m.trajectory;
  if (!defaultTraj && !m.schemaVersion && m.id === 'mission-artemis-south') {
    defaultTraj = {
      sourceType: 'url',
      url: TRAJECTORY_CONFIG.DEFAULT_URL,
      fileName: 'trajectory-2026-11-15T121332Z.json',
      visible: true,
      meta: null,
    };
  }

  const nowIso = new Date().toISOString();
  const legacyApolloLanding =
    !m.schemaVersion && m.id === 'mission-apollo-11' ? '1969-07-20T20:17:40.000Z' : null;
  const legacyApolloLaunch =
    !m.schemaVersion && m.id === 'mission-apollo-11' ? '1969-07-16T13:32:00.000Z' : null;

  const flight = normalizeFlight(
    m.flight ||
      (legacyApolloLanding
        ? {
            launchDateIso: legacyApolloLaunch,
            landingDateIso: legacyApolloLanding,
            dateSource: 'manual',
          }
        : null),
    null
  );

  const modules =
    m.modules && typeof m.modules === 'object'
      ? {
          notes: String(m.modules.notes || ''),
          ...m.modules,
        }
      : { notes: '' };

  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id: String(m.id || `mission-${Date.now()}`),
    name: String(m.name || 'Mission').trim() || 'Mission',
    createdAt: m.createdAt || nowIso,
    updatedAt: m.updatedAt || m.createdAt || nowIso,
    landingSite,
    flight,
    trajectory: normalizeTrajectoryConfig(defaultTraj),
    points: filteredPoints,
    measurements,
    modules,
  };
}

export function createMissionRecord({
  name = 'New Mission',
  landingSite = null,
  landingDateIso = null,
  launchDateIso = null,
  transitDurationSec = null,
  useDefaultTrajectory = false,
  notes = '',
} = {}) {
  const nowIso = new Date().toISOString();
  const computedTransit =
    Number.isFinite(Number(transitDurationSec))
      ? Number(transitDurationSec)
      : computeTransitDurationSec(launchDateIso, landingDateIso);

  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || 'New Mission').trim() || 'New Mission',
    createdAt: nowIso,
    updatedAt: nowIso,
    landingSite: normalizeLandingSite(landingSite),
    flight: {
      launchDateIso,
      landingDateIso,
      transitDurationSec: computedTransit,
      dateSource: landingDateIso ? 'manual' : 'unset',
    },
    trajectory: useDefaultTrajectory
      ? {
          sourceType: 'url',
          url: TRAJECTORY_CONFIG.DEFAULT_URL,
          docId: null,
          fileName: 'trajectory-2026-11-15T121332Z.json',
          visible: true,
          meta: null,
        }
      : {
          sourceType: 'none',
          url: null,
          docId: null,
          fileName: null,
          visible: true,
          meta: null,
        },
    points: [],
    measurements: [],
    modules: {
      notes: String(notes || ''),
    },
  };
}

export function createDefaultMissions() {
  const nowIso = new Date().toISOString();
  return [
    {
      schemaVersion: MISSION_SCHEMA_VERSION,
      id: 'mission-artemis-south',
      name: 'Artemis III — South Pole',
      createdAt: nowIso,
      updatedAt: nowIso,
      landingSite: {
        name: 'Malapert Massif',
        lat: -85.99,
        lon: -0.125,
        note: 'Artemis III candidate region (high solar illumination)',
        visible: true,
      },
      flight: {
        launchDateIso: '2026-11-15T12:13:32.000Z',
        landingDateIso: '2026-11-18T11:30:00.000Z',
        transitDurationSec: null,
        dateSource: 'trajectory',
      },
      trajectory: {
        sourceType: 'url',
        url: TRAJECTORY_CONFIG.DEFAULT_URL,
        docId: null,
        fileName: 'trajectory-2026-11-15T121332Z.json',
        visible: true,
        meta: null,
      },
      points: [
        {
          id: 'mp-mons-mouton',
          name: 'Mons Mouton Plateau',
          lat: -84.232,
          lon: 29.926,
          note: 'Alternate flat plateau landing site',
          visible: true,
        },
      ],
      measurements: [],
      modules: {
        notes: 'South Pole surface exploration baseline with direct cislunar transfer trajectory.',
      },
    },
    {
      schemaVersion: MISSION_SCHEMA_VERSION,
      id: 'mission-apollo-11',
      name: 'Apollo 11 — Tranquility Base',
      createdAt: nowIso,
      updatedAt: nowIso,
      landingSite: {
        name: 'Apollo 11 (Eagle)',
        lat: 0.67416,
        lon: 23.47314,
        note: 'Mare Tranquillitatis — Historic Touchdown',
        visible: true,
      },
      flight: {
        launchDateIso: '1969-07-16T13:32:00.000Z',
        landingDateIso: '1969-07-20T20:17:40.000Z',
        transitDurationSec: 369940,
        dateSource: 'manual',
      },
      trajectory: {
        sourceType: 'none',
        url: null,
        docId: null,
        fileName: null,
        visible: true,
        meta: null,
      },
      points: [
        {
          id: 'mp-apollo11-crater',
          name: 'West Crater (Traverse)',
          lat: 0.676,
          lon: 23.489,
          note: 'EVA traverse landmark near LM Eagle',
          visible: true,
        },
      ],
      measurements: [],
      modules: {
        notes: 'Historical reference mission. Load a custom lwp-trajectory/1 JSON in TRAJ tab to visualize transfer arc.',
      },
    },
  ].map(normalizeMission);
}
