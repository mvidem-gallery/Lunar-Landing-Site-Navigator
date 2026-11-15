/**
 * Парсер и нормализатор JSON-логов миссий формата lwp-flight/2.
 */

(() => {
'use strict';

function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function makePreview(data) {
  if (data === null || data === undefined) return '—';
  if (typeof data !== 'object') return String(data);
  try {
    const json = JSON.stringify(data);
    return json.length > 140 ? `${json.slice(0, 140)}…` : json;
  } catch {
    return '[Object]';
  }
}

/**
 * Преобразует сырой JSON миссии в нормализованную модель для таблиц.
 * @param {object} raw
 * @param {{ filename?: string, source?: string, receivedAt?: string }} meta
 */
window.LWP = window.LWP || {};
window.LWP.parseFlightJson = function parseFlightJson(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Expected a mission JSON object.');
  }

  const run = raw.run ?? {};
  const summary = raw.summary ?? {};
  const durations = summary.durations ?? {};
  const deltaV = summary.delta_v ?? {};
  const economy = summary.economy ?? {};
  const launchSite = raw.launch_site ?? {};
  const landingSite = raw.landing_site ?? {};
  const landing = landingSite.landing ?? {};
  const conditions = landingSite.conditions_at_touchdown ?? {};
  const files = raw.files ?? {};

  const filename =
    meta.filename ||
    files.flight_log ||
    `mission-${run.started_utc || Date.now()}.json`;

  const id = `${filename}::${run.started_utc || Math.random().toString(36).slice(2, 8)}`;

  const chosenShift = economy.chosen_shift_days ?? null;

  const economyDays = Array.isArray(economy.days)
    ? economy.days.map((d, idx) => ({
        index: idx,
        shift_days: d.shift_days ?? null,
        is_chosen: chosenShift !== null && d.shift_days === chosenShift,
        day_kind: d.day?.kind ?? '—',
        day_start_utc: d.day?.day_start_utc ?? null,
        launch_utc: d.launch_utc ?? null,
        time_of_flight_h: toNumberOrNull(d.time_of_flight_h),
        mission_delta_v_m_s: toNumberOrNull(d.mission_delta_v_m_s),
        feasible: d.launch_utc !== null && d.mission_delta_v_m_s !== null,
        reason: d.reason ?? null,
      }))
    : [];

  const timeline = Array.isArray(summary.timeline)
    ? summary.timeline.map((step, idx) => ({
        step: idx + 1,
        event: step.event ?? '—',
        what: step.what ?? '—',
        time_utc: step.time_utc ?? null,
        t_plus: step.t_plus ?? '—',
      }))
    : [];

  const spaceportsCompared = Array.isArray(summary.spaceports_compared)
    ? summary.spaceports_compared.map((sp) => ({
        spaceport: sp.spaceport ?? '—',
        feasible: Boolean(sp.feasible),
        launch_utc: sp.launch_utc ?? null,
        landing_utc: sp.landing_utc ?? null,
        delta_v_total_km_s: toNumberOrNull(sp.delta_v_total_km_s),
        delta_v_mission_km_s: toNumberOrNull(sp.delta_v_mission_km_s),
        day_start_utc: sp.day?.day_start_utc ?? null,
        refined: Boolean(sp.refined),
      }))
    : [];

  const rawLog = Array.isArray(raw.log) ? raw.log : [];
  const logEntries = rawLog.map((entry, idx) => ({
    seq: entry.seq ?? idx,
    wall_time_utc: entry.wall_time_utc ?? '—',
    event: entry.event ?? 'unknown',
    data: entry.data ?? null,
    preview: makePreview(entry.data),
  }));

  const missionRow = {
    id,
    filename,
    source: meta.source || 'file',
    receivedAt: meta.receivedAt || new Date().toISOString(),
    format: raw.format || 'unknown',
    program: run.program || '—',
    version: run.version || '—',
    ok: Boolean(run.ok),
    outcome: run.outcome || '—',
    elapsed_s: toNumberOrNull(run.elapsed_s),
    started_utc: run.started_utc || null,
    status: summary.status || '—',
    trajectory: summary.trajectory || '—',
    mode: summary.mode || '—',
    values_from: summary.values_from || '—',
    spaceport: summary.spaceport || launchSite.name || '—',
    spaceport_id: launchSite.id || '—',
    rocket: summary.rocket || '—',
    spacecraft: summary.spacecraft || '—',
    landing_site: summary.landing_site || '—',
    launch_utc: summary.launch_utc || null,
    lunar_orbit_insertion_utc: summary.lunar_orbit_insertion_utc || null,
    touchdown_utc: summary.touchdown_utc || null,
    tof_h: toNumberOrNull(durations.earth_to_moon_h),
    tof_earth_to_moon: durations.earth_to_moon || '—',
    launch_to_touchdown: durations.launch_to_touchdown || '—',
    dv_tli_m_s: toNumberOrNull(deltaV.tli_m_s),
    dv_loi_m_s: toNumberOrNull(deltaV.lunar_orbit_insertion_m_s),
    dv_descent_m_s: toNumberOrNull(deltaV.descent_m_s),
    dv_tli_plus_loi_m_s: toNumberOrNull(deltaV.tli_plus_loi_m_s),
    dv_total_m_s: toNumberOrNull(deltaV.mission_total_m_s),
    moon_distance_km: toNumberOrNull(summary.moon_distance_at_arrival_km),
    chosen_shift_days: chosenShift,
    orbit_pass: landing.orbit_pass ?? null,
    wait_in_lunar_orbit: landing.wait_in_lunar_orbit || '—',
    sun_elevation_deg: toNumberOrNull(conditions.sun?.elevation_deg),
    earth_elevation_deg: toNumberOrNull(conditions.earth?.elevation_deg),
    log_count: logEntries.length,
    is_sample: Boolean(meta.isSample),
  };

  return {
    id,
    mission: missionRow,
    timeline,
    economyDays,
    spaceportsCompared,
    logEntries,
    rawMeta: {
      args: Array.isArray(run.args) ? run.args : [],
      launch_site: launchSite,
      landing_site: landingSite,
      files,
    },
  };
};
})();
