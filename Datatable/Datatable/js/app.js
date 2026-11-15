(() => {
'use strict';

const { store, attachGlobalApi } = window.LWP;
const {
  escapeHtml,
  formatNum,
  formatUtc,
  sortRows,
  renderTable,
  exportRowsToCsv,
  exportJsonFile,
} = window.LWP.datatable;

const ui = {
  activeTab: 'missions',
  activeSubtab: 'timeline',
  presetFilter: 'all', // all | ok | fail
  missionsSearch: '',
  filters: { status: '', mode: '', spaceport: '', rocket: '' },
  missionsSort: { key: 'dv_total_m_s', dir: 'asc' },
  variantsSearch: '',
  variantsSort: { key: null, dir: 'asc' },
  logSearch: '',
  logEventFilter: '',
  logPage: 1,
  logPageSize: 100,
  logSort: { key: 'seq', dir: 'asc' },
  expandedLogSeqs: new Set(),
};

const els = {
  fileInput: document.getElementById('file-input'),
  dropOverlay: document.getElementById('global-drop-overlay'),
  statusBanner: document.getElementById('status-banner'),
  kpiStrip: document.getElementById('kpi-strip'),
  tabs: document.querySelectorAll('.tab'),
  railBtns: document.querySelectorAll('.rail-btn[data-tab]'),
  presetBtns: document.querySelectorAll('[data-filter-preset]'),
  tabPanels: {
    missions: document.getElementById('panel-missions'),
    variants: document.getElementById('panel-variants'),
    log: document.getElementById('panel-log'),
  },
  subtabs: document.querySelectorAll('.subtab'),
  missionSwitcher: document.getElementById('mission-switcher'),
  activeMissionNum: document.getElementById('active-mission-num'),
  activeMissionBadge: document.getElementById('active-mission-badge'),
  vhMissionLabel: document.getElementById('vh-mission-label'),
  sidebarMissionsCount: document.getElementById('sidebar-missions-count'),
  countAll: document.getElementById('count-all'),
  countOk: document.getElementById('count-ok'),
  countFail: document.getElementById('count-fail'),
  badges: {
    missions: document.getElementById('badge-missions'),
    variants: document.getElementById('badge-variants'),
    logDebug: document.getElementById('badge-log-debug'),
  },
  // Inspector fields
  detailOrbitPass: document.getElementById('detail-orbit-pass'),
  detailCoords: document.getElementById('detail-coords'),
  detailSpaceport: document.getElementById('detail-spaceport'),
  detailSunEarth: document.getElementById('detail-sun-earth'),
  detailTouchdownBox: document.getElementById('detail-touchdown-box'),
  detailLaunchBox: document.getElementById('detail-launch-box'),
  detailTofStr: document.getElementById('detail-tof-str'),
  detailTofHours: document.getElementById('detail-tof-hours'),
  detailDvSplit: document.getElementById('detail-dv-split'),
  detailDvTotal: document.getElementById('detail-dv-total'),
  // Help & Filters
  helpModal: document.getElementById('help-modal'),
  btnHelp: document.getElementById('btn-help'),
  btnCloseHelp: document.getElementById('btn-close-help'),
  btnResetFilters: document.getElementById('btn-reset-filters'),
  // Tables & Filters
  missionsSearch: document.getElementById('missions-search'),
  filterStatus: document.getElementById('filter-status'),
  filterMode: document.getElementById('filter-mode'),
  filterSpaceport: document.getElementById('filter-spaceport'),
  filterRocket: document.getElementById('filter-rocket'),
  missionsTable: document.getElementById('missions-table'),
  missionsEmpty: document.getElementById('missions-empty'),
  missionSummaryCards: document.getElementById('mission-summary-cards'),
  variantsSearch: document.getElementById('variants-search'),
  variantsTable: document.getElementById('variants-table'),
  variantsEmpty: document.getElementById('variants-empty'),
  logSearch: document.getElementById('log-search'),
  logEventFilter: document.getElementById('log-event-filter'),
  logPageSize: document.getElementById('log-page-size'),
  logTable: document.getElementById('log-table'),
  logPagination: document.getElementById('log-pagination'),
  logEmpty: document.getElementById('log-empty'),
  btnOpenDebugLog: document.getElementById('btn-open-debug-log'),
  btnBackFromLog: document.getElementById('btn-back-from-log'),
  // Actions
  btnExportTop: document.getElementById('btn-export-top'),
  btnExportJson: document.getElementById('btn-export-json'),
  btnClearAll: document.getElementById('btn-clear-all'),
  btnJumpTimeline: document.getElementById('btn-jump-timeline'),
  btnJumpEconomy: document.getElementById('btn-jump-economy'),
  btnJumpSpaceports: document.getElementById('btn-jump-spaceports'),
};

let statusTimer = null;
function showStatus(text, isError = false) {
  els.statusBanner.textContent = text;
  els.statusBanner.classList.toggle('error', isError);
  els.statusBanner.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.statusBanner.hidden = true;
  }, 6000);
}

function switchTab(tabName) {
  ui.activeTab = tabName;
  els.tabs.forEach((t) => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('active', active);
    if (t.hasAttribute('aria-selected')) {
      t.setAttribute('aria-selected', String(active));
    }
  });
  els.railBtns.forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  Object.entries(els.tabPanels).forEach(([name, panel]) => {
    const active = name === tabName;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

function switchSubtab(subtabName) {
  ui.activeSubtab = subtabName;
  ui.variantsSort = { key: null, dir: 'asc' };
  els.subtabs.forEach((s) =>
    s.classList.toggle('active', s.dataset.subtab === subtabName)
  );
  renderAll();
}

// ---------- Загрузка файлов ----------
async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (f) => f.name.toLowerCase().endsWith('.json') || f.type === 'application/json'
  );
  if (files.length === 0) {
    showStatus('SELECT .JSON MISSION LOG FILES', true);
    return;
  }

  let loaded = 0;
  let totalLogs = 0;
  for (const file of files) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const parsed = store.ingest(json, {
        filename: file.name,
        source: 'file',
        isSample: false,
      });
      totalLogs += parsed.logEntries.length;
      loaded++;
    } catch (err) {
      showStatus(`ERR ${file.name}: ${err.message}`, true);
    }
  }

  if (loaded > 0) {
    ui.logPage = 1;
    ui.expandedLogSeqs.clear();
    showStatus(`LOADED FILES: ${loaded} · LOG ENTRIES: ${totalLogs}`);
  }
}

// ---------- Фильтры и вычисления ----------
function getMissionComparisonBounds(rows) {
  const dvs = rows.map((r) => r.dv_total_m_s).filter((v) => v !== null);
  const tofs = rows.map((r) => r.tof_h).filter((v) => v !== null);
  return {
    minDv: dvs.length ? Math.min(...dvs) : null,
    minTof: tofs.length ? Math.min(...tofs) : null,
  };
}

function getFilteredMissions() {
  const q = ui.missionsSearch.trim().toLowerCase();
  const rows = store.missions.map((m) => m.mission);

  return rows.filter((r) => {
    if (ui.presetFilter === 'ok' && !r.ok) return false;
    if (ui.presetFilter === 'fail' && r.ok) return false;
    if (ui.filters.status && r.status !== ui.filters.status) return false;
    if (ui.filters.mode && r.mode !== ui.filters.mode) return false;
    if (ui.filters.spaceport && r.spaceport !== ui.filters.spaceport) return false;
    if (ui.filters.rocket && r.rocket !== ui.filters.rocket) return false;

    if (!q) return true;
    const haystack = [
      r.filename,
      r.status,
      r.mode,
      r.trajectory,
      r.spaceport,
      r.rocket,
      r.landing_site,
      r.launch_utc,
      r.touchdown_utc,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function getMissionColumns(bounds) {
  return [
    {
      key: 'num',
      label: 'Mission',
      render: (v, row) =>
        `<span class="mono blue-text" title="${escapeHtml(
          row.filename
        )}">Mission ${escapeHtml(v)}</span>`,
    },
    {
      key: 'status',
      label: 'Status',
      render: (v, row) => {
        const cls = row.ok ? 'badge-ok' : 'badge-err';
        return `<span class="badge ${cls}">${escapeHtml(v)}</span>`;
      },
    },
    { key: 'mode', label: 'Mode' },
    { key: 'spaceport', label: 'Spaceport', wrap: true },
    { key: 'rocket', label: 'Rocket' },
    { key: 'landing_site', label: 'Landing Site', mono: true },
    {
      key: 'launch_utc',
      label: 'Launch (UTC)',
      mono: true,
      render: (v) => escapeHtml(formatUtc(v)),
    },
    {
      key: 'touchdown_utc',
      label: 'Touchdown (UTC)',
      mono: true,
      render: (v) => escapeHtml(formatUtc(v)),
    },
    {
      key: 'tof_h',
      label: 'Transit, hrs',
      align: 'right',
      render: (v) => {
        const isBest =
          bounds.minTof !== null && v !== null && Math.abs(v - bounds.minTof) < 1e-6;
        const text = formatNum(v, 2);
        return isBest
          ? `<span class="best-metric">${text}</span><span class="best-tag">MIN</span>`
          : text;
      },
    },
    {
      key: 'dv_total_m_s',
      label: 'Mission Δv, m/s',
      align: 'right',
      render: (v) => {
        const isBest =
          bounds.minDv !== null && v !== null && Math.abs(v - bounds.minDv) < 1e-6;
        const text = formatNum(v, 1);
        return isBest
          ? `<span class="best-metric">${text}</span><span class="best-tag">MIN</span>`
          : text;
      },
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      noExport: true,
      render: (_, row) =>
        `<button class="btn-icon btn-remove-mission" data-id="${escapeHtml(
          row.id
        )}" title="Remove mission">✕</button>`,
    },
  ];
}

function getVariantsConfig(activeMission) {
  if (!activeMission) return { columns: [], rows: [] };

  if (ui.activeSubtab === 'timeline') {
    return {
      columns: [
        { key: 'step', label: '#', align: 'right' },
        {
          key: 'event',
          label: 'EVENT',
          render: (v) => `<span class="badge badge-info">${escapeHtml(v)}</span>`,
        },
        { key: 'what', label: 'DESCRIPTION', wrap: true },
        {
          key: 'time_utc',
          label: 'TIME (UTC)',
          mono: true,
          render: (v) => escapeHtml(formatUtc(v)),
        },
        { key: 't_plus', label: 'T+', mono: true },
      ],
      rows: activeMission.timeline,
    };
  }

  if (ui.activeSubtab === 'economy') {
    const validDvs = activeMission.economyDays
      .map((d) => d.mission_delta_v_m_s)
      .filter((v) => v !== null);
    const minDv = validDvs.length ? Math.min(...validDvs) : null;

    return {
      columns: [
        {
          key: 'shift_days',
          label: 'SHIFT',
          align: 'right',
          render: (v, row) => {
            const chosen = row.is_chosen
              ? ' <span class="best-tag">CHOSEN</span>'
              : '';
            return `${v > 0 ? `+${v}` : v} d${chosen}`;
          },
        },
        {
          key: 'day_start_utc',
          label: 'ARRIVAL DAY (UTC)',
          mono: true,
          render: (v) => escapeHtml(formatUtc(v)),
        },
        {
          key: 'feasible',
          label: 'FEASIBLE',
          render: (v) =>
            v
              ? '<span class="badge badge-ok">YES</span>'
              : '<span class="badge badge-err">NO</span>',
        },
        {
          key: 'launch_utc',
          label: 'LAUNCH (UTC)',
          mono: true,
          render: (v) => escapeHtml(formatUtc(v)),
        },
        {
          key: 'time_of_flight_h',
          label: 'TOF (HRS)',
          align: 'right',
          render: (v) => formatNum(v, 2),
        },
        {
          key: 'mission_delta_v_m_s',
          label: 'ΔV (M/S)',
          align: 'right',
          render: (v) => {
            const isBest = minDv !== null && v !== null && Math.abs(v - minDv) < 1e-6;
            const text = formatNum(v, 2);
            return isBest ? `<span class="best-metric">${text}</span>` : text;
          },
        },
        { key: 'reason', label: 'REASON', wrap: true },
      ],
      rows: activeMission.economyDays,
    };
  }

  const validSpDvs = activeMission.spaceportsCompared
    .map((s) => s.delta_v_mission_km_s)
    .filter((v) => v !== null);
  const minSpDv = validSpDvs.length ? Math.min(...validSpDvs) : null;

  return {
    columns: [
      { key: 'spaceport', label: 'SPACEPORT', mono: true },
      {
        key: 'feasible',
        label: 'FEASIBLE',
        render: (v) =>
          v
            ? '<span class="badge badge-ok">YES</span>'
            : '<span class="badge badge-err">NO</span>',
      },
      {
        key: 'launch_utc',
        label: 'LAUNCH (UTC)',
        mono: true,
        render: (v) => escapeHtml(formatUtc(v)),
      },
      {
        key: 'landing_utc',
        label: 'LANDING (UTC)',
        mono: true,
        render: (v) => escapeHtml(formatUtc(v)),
      },
      {
        key: 'delta_v_total_km_s',
        label: 'ΔV TLI+LOI (KM/S)',
        align: 'right',
        render: (v) => formatNum(v, 6),
      },
      {
        key: 'delta_v_mission_km_s',
        label: 'ΔV MISSION (KM/S)',
        align: 'right',
        render: (v) => {
          const isBest =
            minSpDv !== null && v !== null && Math.abs(v - minSpDv) < 1e-6;
          const text = formatNum(v, 6);
          return isBest
            ? `<span class="best-metric">${text}</span><span class="best-tag">MIN</span>`
            : text;
        },
      },
      {
        key: 'refined',
        label: 'REFINED',
        render: (v) =>
          v
            ? '<span class="badge badge-ok">YES</span>'
            : '<span class="muted">NO</span>',
      },
    ],
    rows: activeMission.spaceportsCompared,
  };
}

function getFilteredLogEntries(activeMission) {
  if (!activeMission) return [];
  const q = ui.logSearch.trim().toLowerCase();
  return activeMission.logEntries.filter((entry) => {
    if (ui.logEventFilter && entry.event !== ui.logEventFilter) return false;
    if (!q) return true;
    return (
      String(entry.seq).includes(q) ||
      entry.event.toLowerCase().includes(q) ||
      entry.preview.toLowerCase().includes(q)
    );
  });
}

function populateSelect(selectEl, values, placeholder) {
  const current = selectEl.value;
  const unique = [...new Set(values.filter((v) => v && v !== '—'))].sort();
  selectEl.innerHTML =
    `<option value="">${escapeHtml(placeholder)}</option>` +
    unique
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join('');
  if (unique.includes(current)) {
    selectEl.value = current;
  }
}

function renderInspector(activeMission) {
  if (!activeMission) {
    els.vhMissionLabel.textContent = '■ NO MISSION';
    if (els.activeMissionNum) els.activeMissionNum.textContent = '#—';
    els.activeMissionBadge.textContent = 'EMPTY';
    els.activeMissionBadge.classList.add('err');
    els.detailOrbitPass.textContent = 'PASS —';
    els.detailCoords.textContent = '—';
    els.detailSpaceport.textContent = '—';
    els.detailSunEarth.textContent = 'Sun: — · Earth: —';
    els.detailTouchdownBox.textContent = '—';
    els.detailLaunchBox.textContent = '—';
    els.detailTofStr.textContent = '—';
    els.detailTofHours.textContent = '—';
    els.detailDvSplit.textContent = '—';
    els.detailDvTotal.textContent = '—';
    return;
  }

  const m = activeMission.mission;
  els.vhMissionLabel.textContent = `■ Mission ${m.num} · Δv ${formatNum(
    m.dv_total_m_s,
    0
  )} m/s`;
  if (els.activeMissionNum) els.activeMissionNum.textContent = `#${m.num}`;
  els.activeMissionBadge.textContent = m.ok ? 'OK' : 'FAIL';
  els.activeMissionBadge.classList.toggle('err', !m.ok);

  els.detailOrbitPass.textContent = `PASS ${m.orbit_pass ?? '—'}`;
  els.detailCoords.textContent = m.landing_site;
  els.detailSpaceport.textContent = `${m.spaceport} · ${m.rocket}`;
  els.detailSunEarth.textContent = `Sun: ${formatNum(
    m.sun_elevation_deg,
    1
  )}° · Earth: ${formatNum(m.earth_elevation_deg, 1)}°`;

  els.detailTouchdownBox.textContent = formatUtc(m.touchdown_utc);
  els.detailLaunchBox.textContent = formatUtc(m.launch_utc);
  els.detailTofStr.textContent = m.tof_earth_to_moon || '—';
  els.detailTofHours.textContent = formatNum(m.tof_h, 2);
  els.detailDvSplit.textContent = `TLI ${formatNum(
    m.dv_tli_m_s,
    0
  )} / LOI ${formatNum(m.dv_loi_m_s, 0)}`;
  els.detailDvTotal.textContent = formatNum(m.dv_total_m_s, 2);
}

function renderMissionSummaryCards(activeMission) {
  if (!els.missionSummaryCards) return;
  if (!activeMission) {
    els.missionSummaryCards.innerHTML = '';
    return;
  }

  const m = activeMission.mission;
  const landing = activeMission.rawMeta.landing_site?.landing ?? {};
  const lunarOrbit = landing.lunar_orbit ?? {};
  const descent = landing.descent ?? {};
  const sun = activeMission.rawMeta.landing_site?.conditions_at_touchdown?.sun ?? {};
  const earth = activeMission.rawMeta.landing_site?.conditions_at_touchdown?.earth ?? {};

  els.missionSummaryCards.innerHTML = `
    <div class="summary-card">
      <div class="summary-card-header">
        <span>ΔV BREAKDOWN (M/S)</span>
        <span class="tag-box">${escapeHtml(m.mode)}</span>
      </div>
      <div class="summary-card-body">
        <div class="kv-row"><span>Trans-Lunar Injection (TLI)</span><span>${formatNum(m.dv_tli_m_s, 2)}</span></div>
        <div class="kv-row"><span>Lunar Orbit Insertion (LOI)</span><span>${formatNum(m.dv_loi_m_s, 2)}</span></div>
        <div class="kv-row"><span>TLI + LOI</span><span>${formatNum(m.dv_tli_plus_loi_m_s, 2)}</span></div>
        <div class="kv-row"><span>Descent &amp; Landing</span><span>${formatNum(m.dv_descent_m_s, 2)}</span></div>
        <div class="kv-row"><span>Total Mission Δv</span><span class="green-text">${formatNum(m.dv_total_m_s, 2)}</span></div>
      </div>
    </div>

    <div class="summary-card">
      <div class="summary-card-header">
        <span>DURATIONS &amp; SCHEDULE</span>
        <span class="tag-box">${escapeHtml(m.trajectory)}</span>
      </div>
      <div class="summary-card-body">
        <div class="kv-row"><span>Earth → Moon Transit</span><span class="blue-text">${escapeHtml(m.tof_earth_to_moon)} (${formatNum(m.tof_h, 2)} hrs)</span></div>
        <div class="kv-row"><span>Launch to Touchdown</span><span>${escapeHtml(m.launch_to_touchdown)}</span></div>
        <div class="kv-row"><span>Lunar Orbit Wait</span><span>${escapeHtml(m.wait_in_lunar_orbit)}</span></div>
        <div class="kv-row"><span>Date Shift (economy)</span><span>${m.chosen_shift_days !== null ? `${m.chosen_shift_days} d` : '—'}</span></div>
        <div class="kv-row"><span>Compute Time</span><span>${m.elapsed_s !== null ? `${formatNum(m.elapsed_s, 2)} s` : '—'}</span></div>
      </div>
    </div>

    <div class="summary-card">
      <div class="summary-card-header">
        <span>LUNAR ORBIT &amp; LANDING</span>
        <span class="tag-box">PASS ${m.orbit_pass ?? '—'}</span>
      </div>
      <div class="summary-card-body">
        <div class="kv-row"><span>Orbit Altitude</span><span>${lunarOrbit.altitude_km ?? '—'} km</span></div>
        <div class="kv-row"><span>Lunar Equator Inclination</span><span>${formatNum(lunarOrbit.inclination_to_lunar_equator_deg, 2)}°</span></div>
        <div class="kv-row"><span>Orbital Period</span><span>${formatNum(lunarOrbit.period_min, 1)} min</span></div>
        <div class="kv-row"><span>Braking (time / range)</span><span>${descent.braking_duration_s ?? '—'} s / ${formatNum(descent.braking_range_km, 1)} km</span></div>
        <div class="kv-row"><span>Moon Distance</span><span>${formatNum(m.moon_distance_km, 0)} km</span></div>
      </div>
    </div>

    <div class="summary-card">
      <div class="summary-card-header">
        <span>SURFACE CONDITIONS</span>
        <span class="tag-box">${sun.visible && earth.visible ? 'VISIBILITY OK' : 'CHECK'}</span>
      </div>
      <div class="summary-card-body">
        <div class="kv-row"><span>Launch Spaceport</span><span>${escapeHtml(m.spaceport)}</span></div>
        <div class="kv-row"><span>Sun (elev. / azim.)</span><span>${formatNum(sun.elevation_deg, 2)}° / ${formatNum(sun.azimuth_deg, 1)}° (${escapeHtml(sun.direction || '—')})</span></div>
        <div class="kv-row"><span>Lunar Day Phase</span><span>${escapeHtml(sun.time_of_lunar_day || '—')}</span></div>
        <div class="kv-row"><span>Earth (elev. / azim.)</span><span>${formatNum(earth.elevation_deg, 2)}° / ${formatNum(earth.azimuth_deg, 1)}° (${escapeHtml(earth.direction || '—')})</span></div>
        <div class="kv-row"><span>Solver Method</span><span>${escapeHtml(m.values_from)}</span></div>
      </div>
    </div>
  `;
}

function renderTelemetryBar(activeMission) {
  const all = store.missions.map((m) => m.mission);
  const bounds = getMissionComparisonBounds(all);
  const m = activeMission?.mission;

  els.kpiStrip.innerHTML = `
    <div class="tele-cell">
      <div class="tele-label">MISSIONS</div>
      <div class="tele-value">${all.length} LOADED</div>
    </div>
    <div class="tele-cell">
      <div class="tele-label">LANDING SITE</div>
      <div class="tele-value green-text">${escapeHtml(m?.landing_site || '—')}</div>
    </div>
    <div class="tele-cell">
      <div class="tele-label">BEST ΔV</div>
      <div class="tele-value">${bounds.minDv !== null ? `${formatNum(bounds.minDv, 1)} m/s` : '—'}</div>
    </div>
    <div class="tele-cell">
      <div class="tele-label">FASTEST TRANSIT</div>
      <div class="tele-value">${bounds.minTof !== null ? `${formatNum(bounds.minTof, 2)} hrs` : '—'}</div>
    </div>
    <div class="tele-cell">
      <div class="tele-label">MOON DISTANCE</div>
      <div class="tele-value">${m?.moon_distance_km ? `${formatNum(m.moon_distance_km, 0)} km` : '—'}</div>
    </div>
    <div class="tele-cell">
      <div class="tele-label">TRAJECTORY</div>
      <div class="tele-value">${escapeHtml(m?.trajectory || '—')}</div>
    </div>
  `;
}

function renderAll() {
  const allMissions = store.missions.map((m) => m.mission);
  const activeMission = store.getActiveMission();

  const okCount = allMissions.filter((m) => m.ok).length;
  const failCount = allMissions.length - okCount;
  els.sidebarMissionsCount.textContent = `MISSIONS: ${allMissions.length}`;
  els.countAll.textContent = String(allMissions.length);
  els.countOk.textContent = String(okCount);
  els.countFail.textContent = String(failCount);

  const bounds = getMissionComparisonBounds(allMissions);

  if (els.missionSwitcher) {
    if (!store.missions.length) {
      els.missionSwitcher.innerHTML =
        '<div class="muted" style="padding:6px 8px;">No missions loaded</div>';
    } else {
      const hasMultiple = store.missions.length > 1;
      els.missionSwitcher.innerHTML = store.missions
        .map((item) => {
          const m = item.mission;
          const isActive = item.id === activeMission?.id;
          const isBestDv =
            bounds.minDv !== null &&
            m.dv_total_m_s !== null &&
            Math.abs(m.dv_total_m_s - bounds.minDv) < 1e-6;
          const dvDiff =
            hasMultiple && bounds.minDv !== null && m.dv_total_m_s !== null
              ? m.dv_total_m_s - bounds.minDv
              : null;
          const diffHtml =
            dvDiff === null
              ? ''
              : isBestDv
              ? '<span class="ms-diff best">★ BEST ΔV</span>'
              : `<span class="ms-diff">+${formatNum(dvDiff, 1)} m/s</span>`;

          const startShort = m.launch_utc ? formatUtc(m.launch_utc).slice(0, 10) : '—';
          const portShort = m.spaceport_id !== '—' ? m.spaceport_id : m.spaceport;

          return `
            <button type="button" class="mission-switch-item ${
              isActive ? 'active' : ''
            }" data-mission-id="${escapeHtml(item.id)}" title="${escapeHtml(
              m.filename
            )}">
              <div class="ms-top">
                <span class="ms-title"><span class="ms-num">■</span>Mission ${escapeHtml(
                  m.num
                )}</span>
                <span class="badge ${m.ok ? 'badge-ok' : 'badge-err'}">${
                  m.ok ? 'OK' : 'FAIL'
                }</span>
              </div>
              <div class="ms-meta">
                <span>${escapeHtml(portShort)} · ${escapeHtml(startShort)}</span>
                <span>${formatNum(m.dv_total_m_s, 0)} m/s · ${formatNum(
                  m.tof_h,
                  1
                )} hrs</span>
              </div>
              ${diffHtml ? `<div class="ms-meta">${diffHtml}<span>${escapeHtml(m.landing_site)}</span></div>` : ''}
            </button>
          `;
        })
        .join('');

      els.missionSwitcher
        .querySelectorAll('.mission-switch-item')
        .forEach((btn) => {
          btn.addEventListener('click', () => {
            ui.logPage = 1;
            ui.expandedLogSeqs.clear();
            store.setActiveMission(btn.dataset.missionId);
          });
        });
    }
  }

  populateSelect(els.filterStatus, allMissions.map((m) => m.status), 'All statuses');
  populateSelect(els.filterMode, allMissions.map((m) => m.mode), 'All modes');
  populateSelect(els.filterSpaceport, allMissions.map((m) => m.spaceport), 'All spaceports');
  populateSelect(els.filterRocket, allMissions.map((m) => m.rocket), 'All rockets');

  // Вкладка 1
  const filteredMissions = getFilteredMissions();
  const sortedMissions = sortRows(
    filteredMissions,
    ui.missionsSort.key,
    ui.missionsSort.dir
  );

  els.badges.missions.textContent = String(allMissions.length);
  renderTable({
    tableEl: els.missionsTable,
    columns: getMissionColumns(bounds),
    rows: sortedMissions,
    sortState: ui.missionsSort,
    selectedId: activeMission?.id ?? null,
    onSort: (key) => {
      ui.missionsSort =
        ui.missionsSort.key === key
          ? { key, dir: ui.missionsSort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'asc' };
      renderAll();
    },
    onRowClick: (row) => store.setActiveMission(row.id),
  });
  els.missionsEmpty.hidden = sortedMissions.length > 0;

  els.missionsTable.querySelectorAll('.btn-remove-mission').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.removeMission(btn.dataset.id);
    });
  });

  renderMissionSummaryCards(activeMission);

  // Вкладка 2
  const { columns: varCols, rows: varRows } = getVariantsConfig(activeMission);
  const vq = ui.variantsSearch.trim().toLowerCase();
  const filteredVariants = vq
    ? varRows.filter((r) => JSON.stringify(r).toLowerCase().includes(vq))
    : varRows;
  const sortedVariants = sortRows(
    filteredVariants,
    ui.variantsSort.key,
    ui.variantsSort.dir
  );

  els.badges.variants.textContent = String(
    activeMission
      ? activeMission.timeline.length +
          activeMission.economyDays.length +
          activeMission.spaceportsCompared.length
      : 0
  );

  renderTable({
    tableEl: els.variantsTable,
    columns: varCols,
    rows: sortedVariants,
    sortState: ui.variantsSort,
    getRowId: (r) =>
      String(r.step ?? r.shift_days ?? r.spaceport ?? Math.random()),
    onSort: (key) => {
      ui.variantsSort =
        ui.variantsSort.key === key
          ? { key, dir: ui.variantsSort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'asc' };
      renderAll();
    },
  });
  els.variantsEmpty.hidden = sortedVariants.length > 0;

  // Скрытая панель отладочного лога
  if (activeMission && els.logEventFilter) {
    populateSelect(
      els.logEventFilter,
      activeMission.logEntries.map((e) => e.event),
      'All events'
    );
    els.logEventFilter.value = ui.logEventFilter;
  }

  const filteredLog = getFilteredLogEntries(activeMission);
  const sortedLog = sortRows(filteredLog, ui.logSort.key, ui.logSort.dir);
  const totalPages = Math.max(1, Math.ceil(sortedLog.length / ui.logPageSize));
  if (ui.logPage > totalPages) ui.logPage = totalPages;

  const start = (ui.logPage - 1) * ui.logPageSize;
  const pagedLog = sortedLog.slice(start, start + ui.logPageSize);

  if (els.badges.logDebug) {
    els.badges.logDebug.textContent = String(activeMission?.logEntries.length ?? 0);
  }

  if (els.logTable) {
    renderTable({
      tableEl: els.logTable,
      columns: [
        { key: 'seq', label: 'SEQ', align: 'right', mono: true },
        {
          key: 'wall_time_utc',
          label: 'Wall Time (UTC)',
          mono: true,
          render: (v) => escapeHtml(formatUtc(v)),
        },
        {
          key: 'event',
          label: 'Event',
          render: (v) => `<span class="badge badge-info">${escapeHtml(v)}</span>`,
        },
        {
          key: 'preview',
          label: 'Data (click row to expand JSON)',
          wrap: true,
          mono: true,
          render: (v, row) => {
            const icon = ui.expandedLogSeqs.has(String(row.seq)) ? '▼ ' : '▶ ';
            return `<span class="muted">${icon}</span>${escapeHtml(v)}`;
          },
        },
      ],
      rows: pagedLog,
      sortState: ui.logSort,
      getRowId: (r) => String(r.seq),
      expandedIds: ui.expandedLogSeqs,
      renderExpandedRow: (r) =>
        `<pre class="log-json-pre">${escapeHtml(JSON.stringify(r.data, null, 2))}</pre>`,
      onSort: (key) => {
        ui.logSort =
          ui.logSort.key === key
            ? { key, dir: ui.logSort.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: 'asc' };
        renderAll();
      },
      onRowClick: (row) => {
        const id = String(row.seq);
        if (ui.expandedLogSeqs.has(id)) {
          ui.expandedLogSeqs.delete(id);
        } else {
          ui.expandedLogSeqs.add(id);
        }
        renderAll();
      },
    });
  }

  if (els.logEmpty) els.logEmpty.hidden = sortedLog.length > 0;
  if (els.logPagination) {
    els.logPagination.innerHTML = sortedLog.length
      ? `<span>Showing ${start + 1}–${Math.min(
          start + ui.logPageSize,
          sortedLog.length
        )} of ${formatNum(sortedLog.length, 0)}</span>
        <div class="pagination-controls">
          <button class="cmd-btn" id="log-prev" ${ui.logPage <= 1 ? 'disabled' : ''}>← Prev</button>
          <span>Page ${ui.logPage} / ${totalPages}</span>
          <button class="cmd-btn" id="log-next" ${ui.logPage >= totalPages ? 'disabled' : ''}>Next →</button>
        </div>`
      : '';

    document.getElementById('log-prev')?.addEventListener('click', () => {
      if (ui.logPage > 1) {
        ui.logPage--;
        renderAll();
      }
    });
    document.getElementById('log-next')?.addEventListener('click', () => {
      if (ui.logPage < totalPages) {
        ui.logPage++;
        renderAll();
      }
    });
  }

  renderInspector(activeMission);
  renderTelemetryBar(activeMission);
}

// ---------- Глобальный Drag & Drop на всё окно ----------
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) {
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  els.dropOverlay.hidden = true;
  handleFiles(e.dataTransfer?.files);
});

// ---------- События UI ----------
els.fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

els.tabs.forEach((t) =>
  t.addEventListener('click', () => switchTab(t.dataset.tab))
);
els.railBtns.forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);

els.presetBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    ui.presetFilter = btn.dataset.filterPreset;
    els.presetBtns.forEach((b) =>
      b.classList.toggle('active', b.dataset.filterPreset === ui.presetFilter)
    );
    renderAll();
  });
});

els.subtabs.forEach((sub) =>
  sub.addEventListener('click', () => switchSubtab(sub.dataset.subtab))
);

els.btnJumpTimeline.addEventListener('click', () => {
  switchTab('variants');
  switchSubtab('timeline');
});
els.btnJumpEconomy.addEventListener('click', () => {
  switchTab('variants');
  switchSubtab('economy');
});
els.btnJumpSpaceports.addEventListener('click', () => {
  switchTab('variants');
  switchSubtab('spaceports');
});

els.missionsSearch.addEventListener('input', (e) => {
  ui.missionsSearch = e.target.value;
  renderAll();
});

[
  ['filterStatus', 'status'],
  ['filterMode', 'mode'],
  ['filterSpaceport', 'spaceport'],
  ['filterRocket', 'rocket'],
].forEach(([elKey, filterKey]) => {
  els[elKey].addEventListener('change', (e) => {
    ui.filters[filterKey] = e.target.value;
    renderAll();
  });
});

els.variantsSearch.addEventListener('input', (e) => {
  ui.variantsSearch = e.target.value;
  renderAll();
});

els.logSearch?.addEventListener('input', (e) => {
  ui.logSearch = e.target.value;
  ui.logPage = 1;
  renderAll();
});

els.logEventFilter?.addEventListener('change', (e) => {
  ui.logEventFilter = e.target.value;
  ui.logPage = 1;
  renderAll();
});

els.logPageSize?.addEventListener('change', (e) => {
  ui.logPageSize = Number(e.target.value) || 100;
  ui.logPage = 1;
  renderAll();
});

els.btnOpenDebugLog?.addEventListener('click', () => {
  closeHelp();
  switchTab('log');
});

els.btnBackFromLog?.addEventListener('click', () => {
  switchTab('missions');
});

els.btnClearAll.addEventListener('click', () => {
  ui.expandedLogSeqs.clear();
  store.clear();
});

function openHelp() {
  els.helpModal.hidden = false;
}
function closeHelp() {
  els.helpModal.hidden = true;
}

els.btnHelp?.addEventListener('click', openHelp);
els.btnCloseHelp?.addEventListener('click', closeHelp);
els.helpModal?.addEventListener('click', (e) => {
  if (e.target === els.helpModal) closeHelp();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.helpModal && !els.helpModal.hidden) {
    closeHelp();
  }
});

els.btnResetFilters?.addEventListener('click', () => {
  ui.missionsSearch = '';
  ui.presetFilter = 'all';
  ui.filters = { status: '', mode: '', spaceport: '', rocket: '' };
  els.missionsSearch.value = '';
  els.filterStatus.value = '';
  els.filterMode.value = '';
  els.filterSpaceport.value = '';
  els.filterRocket.value = '';
  els.presetBtns.forEach((b) =>
    b.classList.toggle('active', b.dataset.filterPreset === 'all')
  );
  renderAll();
});

function getSummaryExportColumns() {
  return [
    { key: 'num', label: 'Mission #', decimals: 0 },
    { key: 'filename', label: 'Mission File' },
    { key: 'status', label: 'Status' },
    { key: 'ok', label: 'Success' },
    { key: 'mode', label: 'Mode' },
    { key: 'trajectory', label: 'Trajectory' },
    { key: 'spaceport', label: 'Spaceport' },
    { key: 'rocket', label: 'Rocket' },
    { key: 'landing_site', label: 'Landing Site' },
    { key: 'launch_utc', label: 'Launch (UTC)', exportValue: (r) => formatUtc(r.launch_utc) },
    {
      key: 'lunar_orbit_insertion_utc',
      label: 'Lunar Orbit Insertion (UTC)',
      exportValue: (r) => formatUtc(r.lunar_orbit_insertion_utc),
    },
    { key: 'touchdown_utc', label: 'Touchdown (UTC)', exportValue: (r) => formatUtc(r.touchdown_utc) },
    { key: 'tof_h', label: 'Earth-Moon Transit (hrs)', decimals: 2 },
    { key: 'tof_earth_to_moon', label: 'Transit Duration' },
    { key: 'launch_to_touchdown', label: 'Launch to Touchdown' },
    { key: 'dv_tli_m_s', label: 'Δv TLI (m/s)', decimals: 2 },
    { key: 'dv_loi_m_s', label: 'Δv LOI (m/s)', decimals: 2 },
    { key: 'dv_tli_plus_loi_m_s', label: 'Δv TLI+LOI (m/s)', decimals: 2 },
    { key: 'dv_descent_m_s', label: 'Δv Descent (m/s)', decimals: 2 },
    { key: 'dv_total_m_s', label: 'Δv Mission Total (m/s)', decimals: 2 },
    { key: 'wait_in_lunar_orbit', label: 'Lunar Orbit Wait' },
    { key: 'orbit_pass', label: 'Landing Orbit Pass', decimals: 0 },
    { key: 'moon_distance_km', label: 'Moon Distance (km)', decimals: 1 },
    { key: 'sun_elevation_deg', label: 'Sun Elevation (deg)', decimals: 2 },
    { key: 'earth_elevation_deg', label: 'Earth Elevation (deg)', decimals: 2 },
    { key: 'elapsed_s', label: 'Compute Time (s)', decimals: 2 },
    { key: 'log_count', label: 'Log Entries', decimals: 0 },
  ];
}

function buildSummaryJsonPayload(missions) {
  return {
    generated_at_utc: new Date().toISOString(),
    total_missions: missions.length,
    missions: missions.map((item) => {
      const m = item.mission;
      return {
        filename: m.filename,
        source: m.source,
        format: m.format,
        status: m.status,
        ok: m.ok,
        mode: m.mode,
        trajectory: m.trajectory,
        spaceport: m.spaceport,
        rocket: m.rocket,
        landing_site: m.landing_site,
        dates_utc: {
          launch: m.launch_utc,
          lunar_orbit_insertion: m.lunar_orbit_insertion_utc,
          touchdown: m.touchdown_utc,
        },
        durations: {
          earth_to_moon_h: m.tof_h,
          earth_to_moon: m.tof_earth_to_moon,
          launch_to_touchdown: m.launch_to_touchdown,
          wait_in_lunar_orbit: m.wait_in_lunar_orbit,
        },
        delta_v_m_s: {
          tli: m.dv_tli_m_s,
          loi: m.dv_loi_m_s,
          tli_plus_loi: m.dv_tli_plus_loi_m_s,
          descent: m.dv_descent_m_s,
          total: m.dv_total_m_s,
        },
        landing_conditions: {
          orbit_pass: m.orbit_pass,
          moon_distance_km: m.moon_distance_km,
          sun_elevation_deg: m.sun_elevation_deg,
          earth_elevation_deg: m.earth_elevation_deg,
        },
        timeline: item.timeline,
        economy_days: item.economyDays,
        spaceports_compared: item.spaceportsCompared,
      };
    }),
  };
}

function handleExportCsv() {
  const activeMission = store.getActiveMission();
  if (ui.activeTab === 'missions') {
    const rows = sortRows(
      getFilteredMissions(),
      ui.missionsSort.key,
      ui.missionsSort.dir
    );
    if (!rows.length) {
      showStatus('NO DATA TO EXPORT', true);
      return;
    }
    exportRowsToCsv('missions-summary.csv', getSummaryExportColumns(), rows, {
      delimiter: ';',
    });
    showStatus(`SAVED: missions-summary.csv (${rows.length} missions)`);
  } else if (ui.activeTab === 'variants') {
    const { columns, rows } = getVariantsConfig(activeMission);
    if (!rows.length) {
      showStatus('NO DATA TO EXPORT', true);
      return;
    }
    exportRowsToCsv(`mission-${ui.activeSubtab}.csv`, columns, rows, {
      delimiter: ';',
    });
    showStatus(`SAVED: mission-${ui.activeSubtab}.csv`);
  } else {
    const rows = getFilteredLogEntries(activeMission);
    if (!rows.length) {
      showStatus('NO LOG ENTRIES TO EXPORT', true);
      return;
    }
    exportRowsToCsv(
      'mission-log.csv',
      [
        { key: 'seq', label: 'Step (seq)', decimals: 0 },
        {
          key: 'wall_time_utc',
          label: 'Wall Time (UTC)',
          exportValue: (r) => formatUtc(r.wall_time_utc),
        },
        { key: 'event', label: 'Event' },
        {
          key: 'data',
          label: 'Data (JSON)',
          exportValue: (r) => (r.data ? JSON.stringify(r.data) : ''),
        },
      ],
      rows,
      { delimiter: ';' }
    );
    showStatus(`SAVED: mission-log.csv (${rows.length} entries)`);
  }
}

function handleExportSummaryJson() {
  const filteredIds = new Set(getFilteredMissions().map((m) => m.id));
  const selected = store.missions.filter((m) => filteredIds.has(m.id));
  if (!selected.length) {
    showStatus('NO DATA FOR SUMMARY JSON', true);
    return;
  }
  const payload = buildSummaryJsonPayload(selected);
  exportJsonFile('missions-summary.json', payload);
  showStatus(`SAVED: missions-summary.json (${selected.length} missions)`);
}

els.btnExportTop.addEventListener('click', handleExportCsv);
els.btnExportJson?.addEventListener('click', handleExportSummaryJson);

// ---------- Initialization ----------
store.subscribe(renderAll);
attachGlobalApi(showStatus);

(async () => {
  const restored = await store.restore();
  if (restored) {
    showStatus(`RESTORED FROM STORAGE: ${store.missions.length} MISSION(S)`);
  } else {
    renderAll();
  }
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'LWP_DATATABLE_READY' }, '*');
    } catch {
      // Ignore cross-origin postMessage errors
    }
  }
})();
})();
