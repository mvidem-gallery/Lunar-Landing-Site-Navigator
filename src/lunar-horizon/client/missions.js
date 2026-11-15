export const MISSIONS_STORAGE_KEY = 'lunar_missions_v1';
export const MISSION_SCHEMA_VERSION = 2;

export function formatCoords(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return 'UNSET';
  const nLat = Number(lat);
  const nLon = Number(lon);
  const latDir = nLat >= 0 ? 'N' : 'S';
  const lonDir = nLon >= 0 ? 'E' : 'W';
  return `${Math.abs(nLat).toFixed(3)}°${latDir}, ${Math.abs(nLon).toFixed(3)}°${lonDir}`;
}

export function formatUtcCompact(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return 'UNSET';
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) return 'UNSET';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function formatTransitDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '—';
  const totalMin = Math.round(Number(seconds) / 60);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function computeTransitDurationSec(launchDateIso, landingDateIso) {
  if (!launchDateIso || !landingDateIso) return null;
  const launchMs = Date.parse(launchDateIso);
  const landingMs = Date.parse(landingDateIso);
  if (!Number.isFinite(launchMs) || !Number.isFinite(landingMs)) return null;
  const diffSec = (landingMs - launchMs) / 1000;
  return diffSec >= 0 ? Math.round(diffSec) : null;
}

function normalizeLandingSite(site) {
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

function normalizeFlight(flight) {
  const f = flight && typeof flight === 'object' ? flight : {};
  const launchDateIso =
    typeof f.launchDateIso === 'string' && Number.isFinite(Date.parse(f.launchDateIso))
      ? new Date(Date.parse(f.launchDateIso)).toISOString()
      : null;
  const landingDateIso =
    typeof f.landingDateIso === 'string' && Number.isFinite(Date.parse(f.landingDateIso))
      ? new Date(Date.parse(f.landingDateIso)).toISOString()
      : null;
  const computedTransit = computeTransitDurationSec(launchDateIso, landingDateIso);
  const transitDurationSec =
    Number.isFinite(Number(f.transitDurationSec)) && Number(f.transitDurationSec) >= 0
      ? Math.round(Number(f.transitDurationSec))
      : computedTransit;

  return {
    launchDateIso,
    landingDateIso,
    transitDurationSec,
    dateSource: f.dateSource || (landingDateIso ? 'manual' : 'unset'),
  };
}

function normalizeTrajectoryConfig(traj) {
  const t = traj && typeof traj === 'object' ? traj : {};
  let sourceType = t.sourceType;
  if (sourceType !== 'url' && sourceType !== 'uploaded' && sourceType !== 'none') {
    sourceType = t.url ? 'url' : t.docId ? 'uploaded' : 'none';
  }
  return {
    sourceType,
    url: sourceType === 'url' ? String(t.url || '/trajectory-default.json') : null,
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

  const nowIso = new Date().toISOString();
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id: String(m.id || `mission-${Date.now()}`),
    name: String(m.name || 'Mission').trim() || 'Mission',
    createdAt: m.createdAt || nowIso,
    updatedAt: m.updatedAt || m.createdAt || nowIso,
    landingSite: normalizeLandingSite(m.landingSite),
    flight: normalizeFlight(m.flight),
    trajectory: normalizeTrajectoryConfig(m.trajectory),
    points,
    measurements,
    modules:
      m.modules && typeof m.modules === 'object'
        ? { notes: String(m.modules.notes || ''), ...m.modules }
        : { notes: '' },
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
        transitDurationSec: 256588,
        dateSource: 'trajectory',
      },
      trajectory: {
        sourceType: 'url',
        url: '/trajectory-default.json',
        docId: null,
        fileName: 'trajectory-2026-11-15T121332Z.json',
        visible: true,
        meta: null,
      },
      points: [
        {
          id: 'mp-connecting-ridge',
          name: 'Shackleton Connecting Ridge',
          lat: -89.45,
          lon: 30,
          note: 'High-illumination South Pole ridge viewpoint',
          visible: true,
        },
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
        notes: 'Historical reference mission in Mare Tranquillitatis.',
      },
    },
  ].map(normalizeMission);
}

/**
 * Extracts all navigable surface points belonging to a mission:
 * 1) Primary Landing Target
 * 2) Waypoints (mission.points)
 * 3) Vertices from saved Ruler routes (mission.measurements)
 */
export function getMissionSurfacePoints(mission) {
  if (!mission) return [];
  const list = [];

  if (mission.landingSite) {
    list.push({
      key: `target:${mission.id}`,
      kind: 'target',
      badge: 'TARGET',
      name: mission.landingSite.name,
      lat: mission.landingSite.lat,
      lon: mission.landingSite.lon,
      note: mission.landingSite.note || '',
    });
  }

  for (const pt of mission.points || []) {
    list.push({
      key: `pt:${pt.id}`,
      pointId: pt.id,
      kind: 'point',
      badge: 'PT',
      name: pt.name,
      lat: pt.lat,
      lon: pt.lon,
      note: pt.note || '',
    });
  }

  for (const meas of mission.measurements || []) {
    const pts = Array.isArray(meas.points) ? meas.points : [];
    pts.forEach((p, idx) => {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) return;
      const lat = Number(Number(p.lat).toFixed(5));
      const lon = Number(Number(p.lon).toFixed(5));
      const alreadyListed = list.some(
        (existing) => Math.abs(existing.lat - lat) < 0.0002 && Math.abs(existing.lon - lon) < 0.0002
      );
      if (alreadyListed) return;
      list.push({
        key: `ruler:${meas.id}:${idx}`,
        measId: meas.id,
        kind: 'ruler',
        badge: 'RULER',
        name: `${meas.name || 'Route'} · ${p.label || idx + 1}`,
        lat,
        lon,
        note: 'Ruler route vertex',
      });
    });
  }

  return list;
}

export class MissionWorkspace {
  constructor({
    container,
    quickBarContainer = null,
    onSelectMission = null,
    onSelectPoint = null,
    onRequestParams = null,
    getCurrentCoords = null,
    getCurrentDates = null,
  }) {
    this.container = container;
    this.quickBarContainer = quickBarContainer;
    this.onSelectMission = onSelectMission;
    this.onSelectPoint = onSelectPoint;
    this.onRequestParams = onRequestParams;
    this.getCurrentCoords = getCurrentCoords;
    this.getCurrentDates = getCurrentDates;

    const loaded = this._loadState();
    this.missions = loaded.missions;
    this.activeMissionId = loaded.activeMissionId;
    this.activePointKey = null;

    // 'detail' | 'list'
    this._view = 'detail';
    // 'points' | 'flight'
    this._subTab = 'points';
    this._searchQuery = '';
    this._isNewFormOpen = false;
    this._isAddPointOpen = false;
    this._isRenameOpen = false;
    this._pointError = '';

    this._bindEvents();
    this._syncActivePointFromCoords();
    this.render();
  }

  _loadState() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(MISSIONS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.missions) && parsed.missions.length > 0) {
            const missions = parsed.missions.map((m) => normalizeMission(m));
            const activeExists = missions.some((m) => m.id === parsed.activeMissionId);
            return {
              missions,
              activeMissionId: activeExists ? parsed.activeMissionId : missions[0].id,
            };
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
    const defaults = createDefaultMissions();
    return {
      missions: defaults,
      activeMissionId: defaults[0].id,
    };
  }

  _persist() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        MISSIONS_STORAGE_KEY,
        JSON.stringify({
          activeMissionId: this.activeMissionId,
          missions: this.missions,
        })
      );
    } catch {
      // Ignore quota errors
    }
  }

  getActiveMission() {
    return (
      this.missions.find((m) => m.id === this.activeMissionId) ||
      this.missions[0] ||
      null
    );
  }

  getActivePoint() {
    const mission = this.getActiveMission();
    const pts = getMissionSurfacePoints(mission);
    return pts.find((p) => p.key === this.activePointKey) || pts[0] || null;
  }

  syncWithExternalParams({ missionId = null, lat = null, lon = null } = {}) {
    if (missionId && this.missions.some((m) => m.id === missionId)) {
      this.activeMissionId = missionId;
      this._persist();
    } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
      // If active mission has no matching point, check if another mission matches closely
      const activePts = getMissionSurfacePoints(this.getActiveMission());
      const matchesActive = activePts.some(
        (p) => Math.abs(p.lat - lat) < 0.01 && Math.abs(p.lon - lon) < 0.01
      );
      if (!matchesActive) {
        const matchMission = this.missions.find((m) =>
          getMissionSurfacePoints(m).some(
            (p) => Math.abs(p.lat - lat) < 0.01 && Math.abs(p.lon - lon) < 0.01
          )
        );
        if (matchMission) {
          this.activeMissionId = matchMission.id;
        }
      }
    }
    this._syncActivePointFromCoords(lat, lon);
    this.render();
  }

  _syncActivePointFromCoords(latArg = null, lonArg = null) {
    const coords =
      Number.isFinite(latArg) && Number.isFinite(lonArg)
        ? { lat: latArg, lon: lonArg }
        : this.getCurrentCoords?.();
    const mission = this.getActiveMission();
    const pts = getMissionSurfacePoints(mission);
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
      const matched = pts.find(
        (p) => Math.abs(p.lat - coords.lat) < 0.005 && Math.abs(p.lon - coords.lon) < 0.005
      );
      this.activePointKey = matched ? matched.key : null;
    } else {
      this.activePointKey = pts[0]?.key || null;
    }
  }

  openList() {
    this._view = 'list';
    this._isRenameOpen = false;
    this.render();
  }

  openDetail(subTab = null) {
    this._view = 'detail';
    if (subTab && ['points', 'flight'].includes(subTab)) {
      this._subTab = subTab;
    }
    this.render();
  }

  setActiveMission(missionId, { applyToScene = true } = {}) {
    const mission = this.missions.find((m) => m.id === missionId);
    if (!mission) return;
    this.activeMissionId = mission.id;
    this._isRenameOpen = false;
    this._isAddPointOpen = false;
    const pts = getMissionSurfacePoints(mission);
    this.activePointKey = pts[0]?.key || null;
    this._persist();
    this.render();
    if (applyToScene) {
      this.onSelectMission?.(mission, pts[0] || null);
    }
  }

  selectPoint(pointKey) {
    const mission = this.getActiveMission();
    const pts = getMissionSurfacePoints(mission);
    const point = pts.find((p) => p.key === pointKey);
    if (!point) return;
    this.activePointKey = point.key;
    this.render();
    this.onSelectPoint?.(point, mission);
  }

  addPointToActiveMission({ name, lat, lon, note = '' }) {
    const mission = this.getActiveMission();
    if (!mission || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const cleanLat = Number(lat.toFixed(5));
    const cleanLon = Number(lon.toFixed(5));
    const pt = {
      id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || `Point ${cleanLat.toFixed(2)}°, ${cleanLon.toFixed(2)}°`).trim(),
      lat: cleanLat,
      lon: cleanLon,
      note: String(note || '').trim(),
      createdAt: new Date().toISOString(),
      visible: true,
    };
    if (!mission.landingSite) {
      mission.landingSite = {
        name: pt.name,
        lat: pt.lat,
        lon: pt.lon,
        note: pt.note,
        visible: true,
      };
      this.activePointKey = `target:${mission.id}`;
    } else {
      mission.points.unshift(pt);
      this.activePointKey = `pt:${pt.id}`;
    }
    mission.updatedAt = new Date().toISOString();
    this._persist();
    this.render();
    const selected = this.getActivePoint();
    if (selected) this.onSelectPoint?.(selected, mission);
    return selected;
  }

  promotePointToTarget(pointId) {
    const mission = this.getActiveMission();
    const idx = mission?.points.findIndex((p) => p.id === pointId);
    if (!mission || idx === undefined || idx < 0) return;
    const pt = mission.points[idx];
    const oldTarget = mission.landingSite;
    mission.landingSite = {
      name: pt.name,
      lat: pt.lat,
      lon: pt.lon,
      note: pt.note || '',
      visible: true,
    };
    mission.points.splice(idx, 1);
    if (oldTarget) {
      mission.points.unshift({
        id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: oldTarget.name,
        lat: oldTarget.lat,
        lon: oldTarget.lon,
        note: oldTarget.note || '',
        createdAt: new Date().toISOString(),
        visible: true,
      });
    }
    this.activePointKey = `target:${mission.id}`;
    mission.updatedAt = new Date().toISOString();
    this._persist();
    this.render();
  }

  removePoint(pointId) {
    const mission = this.getActiveMission();
    if (!mission) return;
    mission.points = mission.points.filter((p) => p.id !== pointId);
    if (this.activePointKey === `pt:${pointId}`) {
      this._syncActivePointFromCoords();
    }
    mission.updatedAt = new Date().toISOString();
    this._persist();
    this.render();
  }

  _bindEvents() {
    window.addEventListener('storage', (e) => {
      if (e.key !== MISSIONS_STORAGE_KEY) return;
      const reloaded = this._loadState();
      this.missions = reloaded.missions;
      if (!this.missions.some((m) => m.id === this.activeMissionId)) {
        this.activeMissionId = reloaded.activeMissionId;
      }
      this._syncActivePointFromCoords();
      this.render();
    });

    this.container?.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-lh-action]');
      if (actionBtn) {
        e.stopPropagation();
        this._handleAction(actionBtn);
        return;
      }

      const missionCard = e.target.closest('[data-lh-mission-id]');
      if (missionCard) {
        const id = missionCard.dataset.lhMissionId;
        this._view = 'detail';
        this._subTab = 'points';
        if (id !== this.activeMissionId) {
          this.setActiveMission(id, { applyToScene: true });
        } else {
          this.render();
        }
        return;
      }

      const pointCard = e.target.closest('[data-lh-point-key]');
      if (pointCard) {
        this.selectPoint(pointCard.dataset.lhPointKey);
      }
    });

    this.container?.addEventListener('input', (e) => {
      if (e.target.matches('[data-lh-field="search"]')) {
        this._searchQuery = e.target.value || '';
        const listEl = this.container.querySelector('[data-lh-field="missions-list"]');
        if (listEl) listEl.innerHTML = this._renderCardsHtml();
      }
    });

    this.container?.addEventListener('change', (e) => {
      if (e.target.matches('[data-lh-field="notes"]')) {
        const mission = this.getActiveMission();
        if (!mission) return;
        mission.modules.notes = e.target.value || '';
        mission.updatedAt = new Date().toISOString();
        this._persist();
      }
    });

    this.container?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target.matches('[data-lh-form="new-mission"]')) {
        this._submitNewMission(e.target);
      } else if (e.target.matches('[data-lh-form="add-point"]')) {
        this._submitAddPoint(e.target);
      }
    });

    this.container?.addEventListener('keydown', (e) => {
      if (e.target.matches('[data-lh-field="rename-input"]')) {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._commitRename(e.target.value);
        } else if (e.key === 'Escape') {
          this._isRenameOpen = false;
          this.render();
        }
      }
    });

    this.quickBarContainer?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-lh-point-key]');
      if (chip) {
        this.selectPoint(chip.dataset.lhPointKey);
      }
    });
  }

  _handleAction(btn) {
    const action = btn.dataset.lhAction;
    const mission = this.getActiveMission();

    switch (action) {
      case 'back-to-list':
        this.openList();
        break;
      case 'toggle-new-form':
        this._isNewFormOpen = !this._isNewFormOpen;
        this.render();
        if (this._isNewFormOpen) {
          this.container.querySelector('[data-lh-field="new-name"]')?.focus();
        }
        break;
      case 'cancel-new-form':
        this._isNewFormOpen = false;
        this.render();
        break;
      case 'clear-search':
        this._searchQuery = '';
        this.render();
        break;
      case 'activate-mission': {
        const id = btn.dataset.missionId;
        if (id) this.setActiveMission(id, { applyToScene: true });
        break;
      }
      case 'open-detail': {
        const id = btn.dataset.missionId;
        this._view = 'detail';
        this._subTab = 'points';
        if (id && id !== this.activeMissionId) {
          this.setActiveMission(id, { applyToScene: true });
        } else {
          this.render();
        }
        break;
      }
      case 'clone-mission': {
        const id = btn.dataset.missionId || this.activeMissionId;
        const src = this.missions.find((m) => m.id === id);
        if (!src) break;
        const clone = normalizeMission({
          ...JSON.parse(JSON.stringify(src)),
          id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: `${src.name} (Copy)`,
          createdAt: new Date().toISOString(),
        });
        this.missions.unshift(clone);
        this._view = 'detail';
        this.setActiveMission(clone.id, { applyToScene: false });
        break;
      }
      case 'delete-mission': {
        const id = btn.dataset.missionId || this.activeMissionId;
        if (this.missions.length <= 1 || !id) break;
        this.missions = this.missions.filter((m) => m.id !== id);
        const switched = this.activeMissionId === id;
        if (switched) this.activeMissionId = this.missions[0].id;
        this._persist();
        this._syncActivePointFromCoords();
        this.render();
        if (switched) this.setActiveMission(this.activeMissionId, { applyToScene: true });
        break;
      }
      case 'toggle-rename':
        this._isRenameOpen = !this._isRenameOpen;
        this.render();
        if (this._isRenameOpen) {
          const inp = this.container.querySelector('[data-lh-field="rename-input"]');
          inp?.focus();
          inp?.select();
        }
        break;
      case 'save-rename': {
        const inp = this.container.querySelector('[data-lh-field="rename-input"]');
        this._commitRename(inp?.value || '');
        break;
      }
      case 'subtab': {
        const tab = btn.dataset.subtab;
        if (tab && ['points', 'flight'].includes(tab)) {
          this._subTab = tab;
          this.render();
        }
        break;
      }
      case 'toggle-add-point':
        this._isAddPointOpen = !this._isAddPointOpen;
        this._pointError = '';
        this.render();
        if (this._isAddPointOpen) {
          this.container.querySelector('[data-lh-field="pt-name"]')?.focus();
        }
        break;
      case 'cancel-add-point':
        this._isAddPointOpen = false;
        this._pointError = '';
        this.render();
        break;
      case 'save-current-point': {
        const coords = this.getCurrentCoords?.();
        if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
          this.addPointToActiveMission({
            name: `Site (${coords.lat.toFixed(2)}°, ${coords.lon.toFixed(2)}°)`,
            lat: coords.lat,
            lon: coords.lon,
            note: 'Saved from surface view',
          });
        }
        break;
      }
      case 'promote-point':
        if (btn.dataset.pointId) this.promotePointToTarget(btn.dataset.pointId);
        break;
      case 'remove-point':
        if (btn.dataset.pointId) this.removePoint(btn.dataset.pointId);
        break;
      case 'apply-mission-dates':
        if (mission) {
          const pts = getMissionSurfacePoints(mission);
          const pt = pts.find((p) => p.key === this.activePointKey) || pts[0] || null;
          this.onSelectMission?.(mission, pt);
        }
        break;
      case 'open-params':
        this.onRequestParams?.();
        break;
      default:
        break;
    }
  }

  _commitRename(raw) {
    const mission = this.getActiveMission();
    const name = String(raw || '').trim();
    if (mission && name) {
      mission.name = name;
      mission.updatedAt = new Date().toISOString();
      this._persist();
    }
    this._isRenameOpen = false;
    this.render();
  }

  _submitNewMission(formEl) {
    const name = (formEl.querySelector('[data-lh-field="new-name"]')?.value || '').trim();
    const notes = (formEl.querySelector('[data-lh-field="new-notes"]')?.value || '').trim();
    const coords = this.getCurrentCoords?.();
    const dates = this.getCurrentDates?.();

    const created = normalizeMission({
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name || `Mission #${this.missions.length + 1}`,
      landingSite:
        coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
          ? {
              name: `Primary Site (${coords.lat.toFixed(2)}°, ${coords.lon.toFixed(2)}°)`,
              lat: coords.lat,
              lon: coords.lon,
              note: 'Created from surface simulator',
            }
          : null,
      flight: {
        landingDateIso: dates?.startIso || null,
        dateSource: dates?.startIso ? 'manual' : 'unset',
      },
      modules: { notes },
    });

    this.missions.unshift(created);
    this._isNewFormOpen = false;
    this._view = 'detail';
    this._subTab = 'points';
    this.setActiveMission(created.id, { applyToScene: false });
  }

  _submitAddPoint(formEl) {
    const name = (formEl.querySelector('[data-lh-field="pt-name"]')?.value || '').trim();
    const lat = Number.parseFloat(
      String(formEl.querySelector('[data-lh-field="pt-lat"]')?.value || '').replace(',', '.')
    );
    const lon = Number.parseFloat(
      String(formEl.querySelector('[data-lh-field="pt-lon"]')?.value || '').replace(',', '.')
    );
    const note = (formEl.querySelector('[data-lh-field="pt-note"]')?.value || '').trim();

    if (!name) {
      this._pointError = 'Enter a point name.';
      this.render();
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      this._pointError = 'Latitude must be from -90° to 90°.';
      this.render();
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      this._pointError = 'Longitude must be from -180° to 180°.';
      this.render();
      return;
    }

    this._pointError = '';
    this._isAddPointOpen = false;
    this.addPointToActiveMission({ name, lat, lon, note });
  }

  _renderCardsHtml() {
    const q = this._searchQuery.trim().toLowerCase();
    const filtered = q
      ? this.missions.filter((m) =>
          [m.name, m.landingSite?.name, m.trajectory?.meta?.rocket, m.trajectory?.fileName, m.modules?.notes]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(q)
        )
      : this.missions;

    if (!filtered.length) {
      return `<div class="mission-empty-box">No missions match "${escapeHtml(this._searchQuery)}".</div>`;
    }

    return filtered
      .map((m) => {
        const isActive = m.id === this.activeMissionId;
        const pts = getMissionSurfacePoints(m);
        const targetLabel = m.landingSite
          ? `${m.landingSite.name} (${formatCoords(m.landingSite.lat, m.landingSite.lon)})`
          : 'UNSET';
        const landingStr = formatUtcCompact(m.flight?.landingDateIso);
        const transitSec = m.flight?.transitDurationSec ?? m.trajectory?.meta?.durationSec ?? null;
        const hasTraj = m.trajectory?.sourceType && m.trajectory.sourceType !== 'none';
        const trajLabel = hasTraj ? m.trajectory?.meta?.rocket || m.trajectory?.fileName || 'JSON' : 'NO TRAJ';

        return `
          <div class="mission-list-card ${isActive ? 'active' : ''}" data-lh-mission-id="${escapeHtml(m.id)}">
            <div class="mission-card-top">
              <div class="mission-card-title-wrap">
                <span class="mission-status-dot ${isActive ? 'active' : ''}" aria-hidden="true"></span>
                <span class="mission-card-name">${escapeHtml(m.name)}</span>
              </div>
              <div class="mission-card-actions">
                ${
                  isActive
                    ? `<span class="mission-active-pill">ACTIVE</span>`
                    : `<button type="button" class="mission-mini-btn accent" data-lh-action="activate-mission" data-mission-id="${escapeHtml(m.id)}">SET</button>`
                }
                <button type="button" class="mission-mini-btn" data-lh-action="open-detail" data-mission-id="${escapeHtml(m.id)}">OPEN</button>
                <button type="button" class="mission-mini-btn danger" data-lh-action="delete-mission" data-mission-id="${escapeHtml(m.id)}" ${this.missions.length <= 1 ? 'disabled' : ''}>×</button>
              </div>
            </div>
            <div class="mission-card-grid">
              <div class="mission-kv">
                <span class="mission-kv-k">TARGET</span>
                <span class="mission-kv-v ${m.landingSite ? 'val-nominal' : 'val-muted'}">${escapeHtml(targetLabel)}</span>
              </div>
              <div class="mission-kv">
                <span class="mission-kv-k">LANDING UTC</span>
                <span class="mission-kv-v">${escapeHtml(landingStr)}</span>
              </div>
              <div class="mission-kv">
                <span class="mission-kv-k">TRANSIT</span>
                <span class="mission-kv-v">${escapeHtml(formatTransitDuration(transitSec))}</span>
              </div>
              <div class="mission-kv">
                <span class="mission-kv-k">TRAJECTORY</span>
                <span class="mission-kv-v ${hasTraj ? 'val-accent' : 'val-muted'}">${escapeHtml(trajLabel)}</span>
              </div>
            </div>
            <div class="mission-card-foot">
              <span class="mission-foot-chip">POINTS ${pts.length} (${m.points.length} PT · ${m.measurements.length} RTE)</span>
              <button type="button" class="mission-foot-link" data-lh-action="clone-mission" data-mission-id="${escapeHtml(m.id)}">CLONE</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  _renderListView() {
    return `
      <div class="mission-header-row">
        <span class="mission-title-label">MISSIONS (${this.missions.length})</span>
        <button type="button" class="mission-new-btn" data-lh-action="toggle-new-form">+ NEW MISSION</button>
      </div>
      <form class="mission-add-form ${this._isNewFormOpen ? 'visible' : ''}" data-lh-form="new-mission">
        <div class="mission-form-title">CREATE MISSION</div>
        <input type="text" class="hud-input" data-lh-field="new-name" placeholder="Mission name (e.g. Artemis IV — Shackleton)" maxlength="60">
        <input type="text" class="hud-input" data-lh-field="new-notes" placeholder="Objective / notes (optional)" maxlength="140">
        <div class="mission-coord-grid">
          <button type="button" class="mission-mini-btn" data-lh-action="cancel-new-form">CANCEL</button>
          <button type="submit" class="mission-mini-btn accent">CREATE</button>
        </div>
      </form>
      <div class="mission-search-row">
        <input type="text" class="hud-input mission-search-input" data-lh-field="search" value="${escapeHtml(this._searchQuery)}" placeholder="Filter missions, target, vehicle..." autocomplete="off">
        ${this._searchQuery ? `<button type="button" class="mission-mini-btn" data-lh-action="clear-search">×</button>` : ''}
      </div>
      <div class="mission-scroll-area" data-lh-field="missions-list">
        ${this._renderCardsHtml()}
      </div>
    `;
  }

  _renderPointsSubtab(mission) {
    const pts = getMissionSurfacePoints(mission);
    const coords = this.getCurrentCoords?.() || { lat: -89.45, lon: 30 };
    const matchedCurrent =
      Number.isFinite(coords.lat) &&
      Number.isFinite(coords.lon) &&
      pts.some((p) => Math.abs(p.lat - coords.lat) < 0.005 && Math.abs(p.lon - coords.lon) < 0.005);

    const pointsHtml = pts.length
      ? pts
          .map((pt) => {
            const isCurrent = pt.key === this.activePointKey;
            const kindClass =
              pt.kind === 'target' ? 'target' : pt.kind === 'ruler' ? 'measurement' : 'point';
            const badgeClass =
              pt.kind === 'target' ? 'target' : pt.kind === 'ruler' ? 'ruler' : 'pt';
            return `
              <div class="mission-item-card ${kindClass} ${isCurrent ? 'is-selected' : ''}" data-lh-point-key="${escapeHtml(pt.key)}" title="Click to load surface view at this point">
                <div class="mission-item-top">
                  <div class="mission-item-title-wrap">
                    <span class="mission-type-badge ${badgeClass}">${escapeHtml(pt.badge)}</span>
                    <span class="mission-item-name">${escapeHtml(pt.name)}</span>
                  </div>
                  <div class="mission-item-actions">
                    ${isCurrent ? `<span class="mission-active-pill">VIEW</span>` : `<span class="mission-go-tag">GO ↗</span>`}
                    ${
                      pt.kind === 'point'
                        ? `<button type="button" class="mission-mini-btn nominal" data-lh-action="promote-point" data-point-id="${escapeHtml(pt.pointId)}" title="Set as Landing Target">TARGET</button>
                           <button type="button" class="mission-mini-btn danger" data-lh-action="remove-point" data-point-id="${escapeHtml(pt.pointId)}" title="Remove point">×</button>`
                        : ''
                    }
                  </div>
                </div>
                <div class="mission-item-sub">
                  <span>${escapeHtml(formatCoords(pt.lat, pt.lon))}</span>
                </div>
                ${pt.note ? `<div class="mission-item-note">${escapeHtml(pt.note)}</div>` : ''}
              </div>
            `;
          })
          .join('')
      : `<div class="mission-empty-box">No points in this mission yet. Add a waypoint or save the current coordinates.</div>`;

    return `
      <div class="mission-card-block">
        <div class="mission-block-header">
          <span class="mission-block-title">MISSION POINTS (${pts.length})</span>
          <div class="mission-block-actions">
            <button type="button" class="mission-mini-btn accent" data-lh-action="toggle-add-point">+ POINT</button>
            <button type="button" class="mission-mini-btn" data-lh-action="save-current-point" title="Save current surface coordinates as mission point">+ CURRENT</button>
          </div>
        </div>
        ${
          !matchedCurrent && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
            ? `<div class="mission-custom-banner">
                 <span>Custom view: <strong>${escapeHtml(formatCoords(coords.lat, coords.lon))}</strong></span>
                 <button type="button" class="mission-mini-btn accent" data-lh-action="save-current-point">SAVE</button>
               </div>`
            : ''
        }
        <form class="mission-add-form ${this._isAddPointOpen ? 'visible' : ''}" data-lh-form="add-point">
          <input type="text" class="hud-input" data-lh-field="pt-name" placeholder="Point name (e.g. Rim Lookout)" maxlength="64">
          <div class="mission-coord-grid">
            <input type="text" inputmode="decimal" class="hud-input" data-lh-field="pt-lat" placeholder="Lat (-90..90)" value="${Number.isFinite(coords.lat) ? coords.lat.toFixed(4) : ''}">
            <input type="text" inputmode="decimal" class="hud-input" data-lh-field="pt-lon" placeholder="Lon (-180..180)" value="${Number.isFinite(coords.lon) ? coords.lon.toFixed(4) : ''}">
          </div>
          <input type="text" class="hud-input" data-lh-field="pt-note" placeholder="Note (optional)" maxlength="120">
          ${this._pointError ? `<div class="mission-form-error visible">${escapeHtml(this._pointError)}</div>` : ''}
          <div class="mission-btn-strip">
            <button type="button" class="mission-mini-btn" data-lh-action="cancel-add-point">CANCEL</button>
            <button type="submit" class="mission-mini-btn accent">ADD POINT</button>
          </div>
        </form>
        <div class="mission-items-list">${pointsHtml}</div>
      </div>
      <div class="mission-btn-strip">
        <button type="button" class="mission-mini-btn accent" style="flex:1;justify-content:center;" data-lh-action="open-params">EDIT WINDOW &amp; RECALCULATE ↗</button>
      </div>
    `;
  }

  _renderFlightSubtab(mission) {
    const landingStr = formatUtcCompact(mission.flight?.landingDateIso);
    const launchStr = formatUtcCompact(mission.flight?.launchDateIso);
    const transitSec = mission.flight?.transitDurationSec ?? mission.trajectory?.meta?.durationSec ?? null;
    const hasTraj = mission.trajectory?.sourceType && mission.trajectory.sourceType !== 'none';

    return `
      <div class="mission-card-block target-block">
        <div class="mission-block-header">
          <span class="mission-block-title">FLIGHT SCHEDULE</span>
          <span class="mission-source-chip">${escapeHtml((mission.flight?.dateSource || 'unset').toUpperCase())}</span>
        </div>
        <div class="data-row"><span>Launch UTC</span><span class="data-val">${escapeHtml(launchStr)}</span></div>
        <div class="data-row"><span>Landing UTC</span><span class="data-val val-nominal">${escapeHtml(landingStr)}</span></div>
        <div class="data-row"><span>Transit Interval</span><span class="data-val val-accent">${escapeHtml(formatTransitDuration(transitSec))}</span></div>
        <div class="mission-btn-strip">
          <button type="button" class="mission-mini-btn nominal" data-lh-action="apply-mission-dates">SYNC SIMULATOR TO MISSION</button>
          <button type="button" class="mission-mini-btn" data-lh-action="open-params">SIM PARAMS</button>
        </div>
      </div>

      <div class="mission-card-block">
        <div class="mission-block-header">
          <span class="mission-block-title">TRAJECTORY JSON</span>
          <span class="mission-source-chip ${hasTraj ? 'accent' : ''}">${hasTraj ? escapeHtml(mission.trajectory.sourceType.toUpperCase()) : 'NONE'}</span>
        </div>
        ${
          hasTraj
            ? `
          <div class="data-row"><span>File</span><span class="data-val">${escapeHtml(mission.trajectory.fileName || 'trajectory.json')}</span></div>
          <div class="data-row"><span>Vehicle</span><span class="data-val val-accent">${escapeHtml(mission.trajectory.meta?.rocket || 'Cislunar Transfer')}</span></div>
          ${mission.trajectory.meta?.totalDeltaVKmS ? `<div class="data-row"><span>Total ΔV</span><span class="data-val val-warn">${mission.trajectory.meta.totalDeltaVKmS.toFixed(2)} km/s</span></div>` : ''}
        `
            : `<div class="mission-empty-inline">No flight trajectory attached to this mission.</div>`
        }
      </div>

      <div class="mission-card-block">
        <div class="mission-block-header">
          <span class="mission-block-title">MISSION BRIEF</span>
          <span class="mission-source-chip">V2 SCHEMA</span>
        </div>
        <textarea class="hud-input mission-notes-area" data-lh-field="notes" rows="3" placeholder="Mission notes, constraints, surface objectives...">${escapeHtml(mission.modules?.notes || '')}</textarea>
      </div>
    `;
  }

  _renderDetailView(mission) {
    const pts = getMissionSurfacePoints(mission);
    return `
      <div class="mission-workspace-bar">
        <button type="button" class="mission-back-btn" data-lh-action="back-to-list" title="Switch mission">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3L5 8l5 5"/></svg>
          <span>MISSIONS (${this.missions.length})</span>
        </button>
        <div class="mission-workspace-actions">
          <button type="button" class="mission-icon-btn" data-lh-action="toggle-rename" title="Rename mission">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z"/></svg>
          </button>
          <button type="button" class="mission-icon-btn" data-lh-action="clone-mission" title="Clone mission">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3h8"/></svg>
          </button>
          <button type="button" class="mission-icon-btn danger" data-lh-action="delete-mission" title="Delete mission" ${this.missions.length <= 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8.5h5l.5-8.5"/></svg>
          </button>
        </div>
      </div>

      <div class="mission-hero-box">
        <div class="mission-hero-top">
          <span class="mission-status-dot active" aria-hidden="true"></span>
          <span class="mission-hero-name">${escapeHtml(mission.name)}</span>
          <span class="mission-active-pill">ACTIVE</span>
        </div>
        <div class="mission-inline-editor ${this._isRenameOpen ? 'visible' : ''}">
          <input type="text" class="hud-input" data-lh-field="rename-input" value="${escapeHtml(mission.name)}" maxlength="60">
          <button type="button" class="mission-mini-btn accent" data-lh-action="save-rename">OK</button>
        </div>
      </div>

      <div class="mission-subtabs" role="tablist">
        <button type="button" class="mission-subtab-btn ${this._subTab === 'points' ? 'active' : ''}" data-lh-action="subtab" data-subtab="points">POINTS (${pts.length})</button>
        <button type="button" class="mission-subtab-btn ${this._subTab === 'flight' ? 'active' : ''}" data-lh-action="subtab" data-subtab="flight">FLIGHT &amp; TRAJ</button>
      </div>

      <div class="mission-scroll-area">
        ${this._subTab === 'flight' ? this._renderFlightSubtab(mission) : this._renderPointsSubtab(mission)}
      </div>
    `;
  }

  _renderQuickBar() {
    if (!this.quickBarContainer) return;
    const mission = this.getActiveMission();
    const pts = getMissionSurfacePoints(mission);
    if (!pts.length) {
      this.quickBarContainer.innerHTML = '';
      return;
    }
    this.quickBarContainer.innerHTML = pts
      .map((pt) => {
        const isCurrent = pt.key === this.activePointKey;
        return `
          <button
            type="button"
            class="quick-point-chip ${pt.kind} ${isCurrent ? 'active' : ''}"
            data-lh-point-key="${escapeHtml(pt.key)}"
            title="${escapeHtml(pt.name)} · ${escapeHtml(formatCoords(pt.lat, pt.lon))}"
          >
            <span class="qp-badge">${escapeHtml(pt.badge)}</span>
            <span class="qp-name">${escapeHtml(pt.name)}</span>
          </button>
        `;
      })
      .join('');
  }

  render() {
    const mission = this.getActiveMission();
    if (this.container) {
      this.container.innerHTML =
        !mission || this._view === 'list' ? this._renderListView() : this._renderDetailView(mission);
    }
    this._renderQuickBar();
    const pillName = document.getElementById('top-mission-name');
    if (pillName) pillName.textContent = mission ? mission.name : '—';
  }
}
