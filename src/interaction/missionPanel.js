import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MOON_CONFIG } from '../config/constants.js';
import { RulerTool } from './rulerTool.js';
import './missionPanel.css';

const MISSIONS_STORAGE_KEY = 'lunar_missions_v1';

export class MissionPanel {
  static latLonToNormal(latDeg, lonDeg) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    return new THREE.Vector3(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.sin(latRad),
      -Math.cos(latRad) * Math.sin(lonRad)
    ).normalize();
  }

  static normalToLatLon(normal) {
    const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(normal.y, -1, 1)));
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-normal.z, normal.x));
    return { lat, lon };
  }

  static formatCoords(lat, lon) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(3)}°${latDir}, ${Math.abs(lon).toFixed(3)}°${lonDir}`;
  }

  static escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  static createDefaultMissions() {
    return [
      {
        id: 'mission-artemis-south',
        name: 'Artemis III — South Pole',
        createdAt: new Date().toISOString(),
        points: [
          {
            id: 'mp-malapert',
            name: 'Malapert Massif',
            lat: -85.99,
            lon: -0.125,
            note: 'Artemis III candidate region (high solar illumination)',
            visible: true,
          },
          {
            id: 'mp-mons-mouton',
            name: 'Mons Mouton Plateau',
            lat: -84.232,
            lon: 29.926,
            note: 'Flat plateau landing site',
            visible: true,
          },
        ],
        measurements: [],
      },
      {
        id: 'mission-apollo-11',
        name: 'Mare Tranquillitatis — Apollo 11',
        createdAt: new Date().toISOString(),
        points: [
          {
            id: 'mp-apollo11',
            name: 'Apollo 11 (Eagle)',
            lat: 0.67416,
            lon: 23.47314,
            note: 'Tranquility Base',
            visible: true,
          },
        ],
        measurements: [],
      },
    ];
  }

  /**
   * @param {Object} options
   * @param {HTMLElement} options.container
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {Function|null} [options.onFlyTo]
   * @param {Function|null} [options.onOpenRuler]
   * @param {Function|null} [options.onLoadRulerSnapshot]
   * @param {Function|null} [options.getRulerSnapshot]
   * @param {Function|null} [options.onOpenCatalog]
   * @param {Function|null} [options.onActiveMissionChange]
   */
  constructor({
    container,
    scene,
    camera,
    onFlyTo = null,
    onOpenRuler = null,
    onLoadRulerSnapshot = null,
    getRulerSnapshot = null,
    onOpenCatalog = null,
    onActiveMissionChange = null,
  }) {
    this.container = container;
    this.scene = scene;
    this.camera = camera;
    this.onFlyTo = onFlyTo;
    this.onOpenRuler = onOpenRuler;
    this.onLoadRulerSnapshot = onLoadRulerSnapshot;
    this.getRulerSnapshot = getRulerSnapshot;
    this.onOpenCatalog = onOpenCatalog;
    this.onActiveMissionChange = onActiveMissionChange;

    const loaded = this._loadState();
    this.missions = loaded.missions;
    this.activeMissionId = loaded.activeMissionId;
    this._isAddPointFormOpen = false;
    this._isRenameOpen = false;
    this._formError = '';

    this.surfaceRadius = MOON_CONFIG.RADIUS + 0.000026;
    this.rulerArcRadius = MOON_CONFIG.RADIUS + 0.000014;

    this.group = new THREE.Group();
    this.group.renderOrder = 14;
    if (this.scene) {
      this.scene.add(this.group);
    }

    this._markerOuterGeo = new THREE.RingGeometry(0.62, 1.0, 28);
    this._markerInnerGeo = new THREE.CircleGeometry(0.36, 18);
    this._pointOuterMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._pointInnerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._rulerVertexMat = new THREE.MeshBasicMaterial({
      color: 0x6ef3e6,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._savedLineMaterial = new LineMaterial({
      color: 0x6ef3e6,
      linewidth: 2.2,
      transparent: true,
      opacity: 0.88,
      depthTest: true,
      depthWrite: false,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    this._renderedPoints = [];
    this._renderedMeasurements = [];
    this._camDir = new THREE.Vector3();
    this._projVec = new THREE.Vector3();

    this._buildDOM();
    this._bindEvents();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
  }

  _loadState() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(MISSIONS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.missions) && parsed.missions.length > 0) {
            const missions = parsed.missions.map((m) => ({
              id: String(m.id || `mission-${Date.now()}`),
              name: String(m.name || 'Mission').trim() || 'Mission',
              createdAt: m.createdAt || new Date().toISOString(),
              points: Array.isArray(m.points) ? m.points : [],
              measurements: Array.isArray(m.measurements) ? m.measurements : [],
            }));
            const activeExists = missions.some((m) => m.id === parsed.activeMissionId);
            return {
              missions,
              activeMissionId: activeExists ? parsed.activeMissionId : missions[0].id,
            };
          }
        }
      }
    } catch {
      // Ігноруємо помилки читання localStorage
    }

    const defaults = MissionPanel.createDefaultMissions();
    return {
      missions: defaults,
      activeMissionId: defaults[0].id,
    };
  }

  _persistState() {
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
      // Ігноруємо помилки квоти сховища
    }
  }

  getActiveMission() {
    return (
      this.missions.find((m) => m.id === this.activeMissionId) ||
      this.missions[0] ||
      null
    );
  }

  _notifyMissionChange() {
    if (typeof this.onActiveMissionChange === 'function') {
      this.onActiveMissionChange(this.getActiveMission());
    }
  }

  _buildDOM() {
    this.rootEl = document.createElement('div');
    this.rootEl.className = 'mission-panel';
    this.rootEl.innerHTML = `
      <div class="mission-header-row">
        <span class="mission-title-label">Exploration Missions</span>
        <button type="button" class="mission-new-btn" data-action="new-mission">+ New Mission</button>
      </div>

      <div class="mission-selector-box">
        <div class="mission-select-row">
          <select class="hud-select mission-select" data-field="mission-select"></select>
          <button type="button" class="mission-icon-btn" data-action="rename-mission" title="Rename mission">✎</button>
          <button type="button" class="mission-icon-btn danger" data-action="delete-mission" title="Delete mission">🗑</button>
        </div>

        <div class="mission-inline-editor" data-field="rename-box">
          <input type="text" class="hud-input" data-field="rename-input" placeholder="Mission name..." maxlength="60" />
          <button type="button" class="mission-mini-btn accent" data-action="save-rename">OK</button>
        </div>

        <div class="mission-meta-stats">
          <span>Active Mission</span>
          <div class="mission-meta-badges">
            <span class="mission-stat-chip" data-field="points-count">0 points</span>
            <span class="mission-stat-chip ruler" data-field="ruler-count">0 measurements</span>
          </div>
        </div>
      </div>

      <div class="mission-scroll-area">
        <div class="mission-section">
          <div class="mission-section-header">
            <span class="mission-section-title">Mission Points</span>
            <div class="mission-section-actions">
              <button type="button" class="mission-mini-btn" data-action="toggle-point-form" title="Add point manually">+ Point</button>
              <button type="button" class="mission-mini-btn" data-action="add-from-camera" title="Add current camera center">⌖ Center</button>
              <button type="button" class="mission-mini-btn" data-action="browse-sites" title="Select from NASA catalog">📍 Catalog</button>
            </div>
          </div>

          <form class="mission-add-form" data-field="point-form">
            <input type="text" class="hud-input" data-field="point-name" placeholder="Point name (e.g. Crater A)" maxlength="64" />
            <div class="mission-coord-grid">
              <input type="number" step="0.0001" min="-90" max="90" class="hud-input" data-field="point-lat" placeholder="Latitude (-90..90)" />
              <input type="number" step="0.0001" min="-180" max="180" class="hud-input" data-field="point-lon" placeholder="Longitude (-180..180)" />
            </div>
            <input type="text" class="hud-input" data-field="point-note" placeholder="Note (optional)" maxlength="120" />
            <div class="mission-form-error" data-field="point-error"></div>
            <div class="mission-coord-grid">
              <button type="button" class="mission-mini-btn" data-action="cancel-point-form">Cancel</button>
              <button type="submit" class="mission-mini-btn accent">★ Add to Mission</button>
            </div>
          </form>

          <div class="mission-items-list" data-field="points-list"></div>
        </div>

        <div class="mission-section">
          <div class="mission-section-header">
            <span class="mission-section-title">Ruler Measurements</span>
            <div class="mission-section-actions">
              <button type="button" class="mission-mini-btn gold" data-action="open-ruler" title="Open ruler (R)">📏 Ruler</button>
              <button type="button" class="mission-mini-btn accent" data-action="save-ruler" title="Save current ruler measurement to mission">+ Save</button>
            </div>
          </div>

          <div class="mission-items-list" data-field="measurements-list"></div>
        </div>
      </div>
    `;

    this.container.appendChild(this.rootEl);

    this.missionSelectEl = this.rootEl.querySelector('[data-field="mission-select"]');
    this.newMissionBtn = this.rootEl.querySelector('[data-action="new-mission"]');
    this.renameBtn = this.rootEl.querySelector('[data-action="rename-mission"]');
    this.deleteMissionBtn = this.rootEl.querySelector('[data-action="delete-mission"]');
    this.renameBoxEl = this.rootEl.querySelector('[data-field="rename-box"]');
    this.renameInputEl = this.rootEl.querySelector('[data-field="rename-input"]');
    this.saveRenameBtn = this.rootEl.querySelector('[data-action="save-rename"]');

    this.pointsCountEl = this.rootEl.querySelector('[data-field="points-count"]');
    this.rulerCountEl = this.rootEl.querySelector('[data-field="ruler-count"]');

    this.togglePointFormBtn = this.rootEl.querySelector('[data-action="toggle-point-form"]');
    this.addFromCameraBtn = this.rootEl.querySelector('[data-action="add-from-camera"]');
    this.browseSitesBtn = this.rootEl.querySelector('[data-action="browse-sites"]');

    this.pointFormEl = this.rootEl.querySelector('[data-field="point-form"]');
    this.pointNameInput = this.rootEl.querySelector('[data-field="point-name"]');
    this.pointLatInput = this.rootEl.querySelector('[data-field="point-lat"]');
    this.pointLonInput = this.rootEl.querySelector('[data-field="point-lon"]');
    this.pointNoteInput = this.rootEl.querySelector('[data-field="point-note"]');
    this.pointErrorEl = this.rootEl.querySelector('[data-field="point-error"]');
    this.cancelPointFormBtn = this.rootEl.querySelector('[data-action="cancel-point-form"]');

    this.pointsListEl = this.rootEl.querySelector('[data-field="points-list"]');
    this.measurementsListEl = this.rootEl.querySelector('[data-field="measurements-list"]');
    this.openRulerBtn = this.rootEl.querySelector('[data-action="open-ruler"]');
    this.saveRulerBtn = this.rootEl.querySelector('[data-action="save-ruler"]');

    this.labelsLayer = document.createElement('div');
    this.labelsLayer.id = 'mission-labels-layer';
    document.body.appendChild(this.labelsLayer);
  }

  _bindEvents() {
    this.missionSelectEl.addEventListener('change', (e) => {
      this.setActiveMission(e.target.value);
    });

    this.newMissionBtn.addEventListener('click', () => {
      const nextNum = this.missions.length + 1;
      const name = `Mission #${nextNum}`;
      const created = this.createMission(name);
      this.setActiveMission(created.id);
      this._isRenameOpen = true;
      this.render();
      this.renameInputEl.focus();
      this.renameInputEl.select();
    });

    this.renameBtn.addEventListener('click', () => {
      this._isRenameOpen = !this._isRenameOpen;
      this.render();
      if (this._isRenameOpen) {
        this.renameInputEl.focus();
        this.renameInputEl.select();
      }
    });

    this.saveRenameBtn.addEventListener('click', () => this._commitRename());
    this.renameInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._commitRename();
      } else if (e.key === 'Escape') {
        this._isRenameOpen = false;
        this.render();
      }
    });

    this.deleteMissionBtn.addEventListener('click', () => {
      if (this.missions.length <= 1) return;
      this.deleteMission(this.activeMissionId);
    });

    this.togglePointFormBtn.addEventListener('click', () => {
      this._isAddPointFormOpen = !this._isAddPointFormOpen;
      this._formError = '';
      this.render();
      if (this._isAddPointFormOpen) {
        this.pointNameInput.focus();
      }
    });

    this.cancelPointFormBtn.addEventListener('click', () => {
      this._isAddPointFormOpen = false;
      this._formError = '';
      this.render();
    });

    this.addFromCameraBtn.addEventListener('click', () => {
      if (!this.camera) return;
      const camNormal = this.camera.position.clone().normalize();
      const { lat, lon } = MissionPanel.normalToLatLon(camNormal);
      this.addPointToActiveMission({
        name: `Center (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`,
        lat,
        lon,
        note: 'Added from camera center',
      });
    });

    this.browseSitesBtn.addEventListener('click', () => {
      if (typeof this.onOpenCatalog === 'function') {
        this.onOpenCatalog();
      }
    });

    this.pointFormEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleAddPointSubmit();
    });

    this.openRulerBtn.addEventListener('click', () => {
      if (typeof this.onOpenRuler === 'function') {
        this.onOpenRuler();
      }
    });

    this.saveRulerBtn.addEventListener('click', () => {
      if (typeof this.getRulerSnapshot === 'function') {
        const snapshot = this.getRulerSnapshot();
        if (snapshot) {
          this.saveRulerMeasurement(snapshot);
        }
      }
    });

    this.pointsListEl.addEventListener('click', (e) => {
      const card = e.target.closest('[data-point-id]');
      if (!card) return;
      const pointId = card.dataset.pointId;
      const actionBtn = e.target.closest('[data-point-action]');

      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.pointAction;
        if (action === 'toggle-vis') {
          this.togglePointVisibility(pointId);
        } else if (action === 'remove') {
          this.removePointFromActiveMission(pointId);
        }
        return;
      }

      const mission = this.getActiveMission();
      const pt = mission?.points.find((p) => p.id === pointId);
      if (pt && typeof this.onFlyTo === 'function') {
        this.onFlyTo(pt.lat, pt.lon, 65);
      }
    });

    this.measurementsListEl.addEventListener('click', (e) => {
      const card = e.target.closest('[data-meas-id]');
      if (!card) return;
      const measId = card.dataset.measId;
      const actionBtn = e.target.closest('[data-meas-action]');

      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.measAction;
        if (action === 'toggle-vis') {
          this.toggleMeasurementVisibility(measId);
        } else if (action === 'load') {
          const mission = this.getActiveMission();
          const m = mission?.measurements.find((item) => item.id === measId);
          if (m && typeof this.onLoadRulerSnapshot === 'function') {
            this.onLoadRulerSnapshot(m);
          }
        } else if (action === 'remove') {
          this.removeMeasurementFromActiveMission(measId);
        }
        return;
      }

      const mission = this.getActiveMission();
      const meas = mission?.measurements.find((m) => m.id === measId);
      if (meas && meas.points?.length > 0 && typeof this.onFlyTo === 'function') {
        const mid = meas.points[Math.floor(meas.points.length / 2)];
        this.onFlyTo(mid.lat, mid.lon, 28);
      }
    });
  }

  _commitRename() {
    const mission = this.getActiveMission();
    const nextName = this.renameInputEl.value.trim();
    if (mission && nextName) {
      mission.name = nextName;
      this._persistState();
      this._notifyMissionChange();
    }
    this._isRenameOpen = false;
    this.render();
  }

  _handleAddPointSubmit() {
    const name = this.pointNameInput.value.trim();
    const lat = Number.parseFloat(this.pointLatInput.value);
    const lon = Number.parseFloat(this.pointLonInput.value);
    const note = this.pointNoteInput.value.trim();

    if (!name) {
      this._formError = 'Enter a point name.';
      this.render();
      this.pointNameInput.focus();
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      this._formError = 'Latitude must be between -90° and +90°.';
      this.render();
      this.pointLatInput.focus();
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      this._formError = 'Longitude must be between -180° and +180°.';
      this.render();
      this.pointLonInput.focus();
      return;
    }

    const pt = this.addPointToActiveMission({ name, lat, lon, note });
    this.pointNameInput.value = '';
    this.pointLatInput.value = '';
    this.pointLonInput.value = '';
    this.pointNoteInput.value = '';
    this._isAddPointFormOpen = false;
    this._formError = '';
    this.render();

    if (pt && typeof this.onFlyTo === 'function') {
      this.onFlyTo(pt.lat, pt.lon, 65);
    }
  }

  createMission(name) {
    const mission = {
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || 'New Mission').trim(),
      createdAt: new Date().toISOString(),
      points: [],
      measurements: [],
    };
    this.missions.unshift(mission);
    this._persistState();
    return mission;
  }

  setActiveMission(missionId) {
    if (!this.missions.some((m) => m.id === missionId)) return;
    this.activeMissionId = missionId;
    this._isRenameOpen = false;
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
  }

  deleteMission(missionId) {
    if (this.missions.length <= 1) return;
    this.missions = this.missions.filter((m) => m.id !== missionId);
    if (this.activeMissionId === missionId) {
      this.activeMissionId = this.missions[0].id;
    }
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
  }

  addPointToActiveMission({ name, lat, lon, note = '' }) {
    const mission = this.getActiveMission();
    if (!mission || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;

    const cleanLat = Number(Number(lat).toFixed(5));
    const cleanLon = Number(Number(lon).toFixed(5));
    const cleanName = String(name || `Point ${cleanLat.toFixed(2)}°, ${cleanLon.toFixed(2)}°`).trim();

    const point = {
      id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      lat: cleanLat,
      lon: cleanLon,
      note: String(note || ''),
      visible: true,
    };

    mission.points.unshift(point);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
    return point;
  }

  togglePointVisibility(pointId) {
    const mission = this.getActiveMission();
    const pt = mission?.points.find((p) => p.id === pointId);
    if (!pt) return;
    pt.visible = pt.visible === false;
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
  }

  removePointFromActiveMission(pointId) {
    const mission = this.getActiveMission();
    if (!mission) return;
    mission.points = mission.points.filter((p) => p.id !== pointId);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
  }

  saveRulerMeasurement(snapshot, customName = null) {
    const mission = this.getActiveMission();
    if (!mission || !snapshot || !Array.isArray(snapshot.points) || snapshot.points.length < 2) {
      return null;
    }

    const index = mission.measurements.length + 1;
    const first = snapshot.points[0];
    const last = snapshot.points[snapshot.points.length - 1];
    const defaultName = `Route #${index} (${first.label || 'A'} → ${last.label || 'B'})`;

    const meas = {
      id: `meas-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: customName || defaultName,
      createdAt: new Date().toISOString(),
      totalArcMeters: Number(snapshot.totalArcMeters || 0),
      directChordMeters: Number(snapshot.directChordMeters || 0),
      points: snapshot.points.map((p, idx) => ({
        label: p.label || RulerTool.pointLabel(idx),
        lat: Number(Number(p.lat).toFixed(5)),
        lon: Number(Number(p.lon).toFixed(5)),
      })),
      visible: true,
    };

    mission.measurements.unshift(meas);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
    return meas;
  }

  toggleMeasurementVisibility(measId) {
    const mission = this.getActiveMission();
    const meas = mission?.measurements.find((m) => m.id === measId);
    if (!meas) return;
    meas.visible = meas.visible === false;
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
  }

  removeMeasurementFromActiveMission(measId) {
    const mission = this.getActiveMission();
    if (!mission) return;
    mission.measurements = mission.measurements.filter((m) => m.id !== measId);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange();
  }

  setSaveRulerEnabled(canSave) {
    if (this.saveRulerBtn) {
      this.saveRulerBtn.disabled = !canSave;
    }
  }

  render() {
    const mission = this.getActiveMission();

    this.missionSelectEl.innerHTML = this.missions
      .map(
        (m) =>
          `<option value="${MissionPanel.escapeHtml(m.id)}" ${
            m.id === this.activeMissionId ? 'selected' : ''
          }>${MissionPanel.escapeHtml(m.name)} (${m.points.length}p / ${m.measurements.length}m)</option>`
      )
      .join('');

    this.deleteMissionBtn.disabled = this.missions.length <= 1;
    this.renameBoxEl.classList.toggle('visible', this._isRenameOpen);
    if (this._isRenameOpen && mission) {
      this.renameInputEl.value = mission.name;
    }

    this.pointFormEl.classList.toggle('visible', this._isAddPointFormOpen);
    if (this._formError) {
      this.pointErrorEl.textContent = this._formError;
      this.pointErrorEl.style.display = 'block';
    } else {
      this.pointErrorEl.textContent = '';
      this.pointErrorEl.style.display = 'none';
    }

    const ptsCount = mission ? mission.points.length : 0;
    const measCount = mission ? mission.measurements.length : 0;
    this.pointsCountEl.textContent = `${ptsCount} ${ptsCount === 1 ? 'point' : 'points'}`;
    this.rulerCountEl.textContent = `${measCount} ${measCount === 1 ? 'measurement' : 'measurements'}`;

    if (!mission || ptsCount === 0) {
      this.pointsListEl.innerHTML = `
        <div class="mission-empty-box">
          No points in this mission yet. Click "+ Point", "⌖ Center", pick from the catalog, or right-click on the Moon.
        </div>
      `;
    } else {
      this.pointsListEl.innerHTML = mission.points
        .map((pt) => {
          const isVisible = pt.visible !== false;
          return `
            <div class="mission-item-card point" data-point-id="${MissionPanel.escapeHtml(pt.id)}">
              <div class="mission-item-top">
                <span class="mission-item-name">${MissionPanel.escapeHtml(pt.name)}</span>
                <div class="mission-item-actions">
                  <button type="button" class="mission-vis-btn ${isVisible ? '' : 'hidden-item'}" data-point-action="toggle-vis" title="Show / hide on globe">👁</button>
                  <button type="button" class="mission-mini-btn danger" data-point-action="remove" title="Remove point">✕</button>
                </div>
              </div>
              <div class="mission-item-sub">
                <span>${MissionPanel.escapeHtml(MissionPanel.formatCoords(pt.lat, pt.lon))}</span>
              </div>
              ${pt.note ? `<div class="mission-item-note">${MissionPanel.escapeHtml(pt.note)}</div>` : ''}
            </div>
          `;
        })
        .join('');
    }

    if (!mission || measCount === 0) {
      this.measurementsListEl.innerHTML = `
        <div class="mission-empty-box">
          No saved measurements yet. Activate the ruler (R), measure a distance, and click "+ Save".
        </div>
      `;
    } else {
      this.measurementsListEl.innerHTML = mission.measurements
        .map((m) => {
          const isVisible = m.visible !== false;
          const distStr = RulerTool.formatDistance(m.totalArcMeters);
          const chordStr = RulerTool.formatDistance(m.directChordMeters);
          const segsCount = Math.max(0, (m.points?.length || 1) - 1);
          return `
            <div class="mission-item-card measurement" data-meas-id="${MissionPanel.escapeHtml(m.id)}">
              <div class="mission-item-top">
                <span class="mission-item-name">${MissionPanel.escapeHtml(m.name)}</span>
                <div class="mission-item-actions">
                  <button type="button" class="mission-vis-btn ${isVisible ? '' : 'hidden-item'}" data-meas-action="toggle-vis" title="Show / hide on globe">👁</button>
                  <button type="button" class="mission-mini-btn" data-meas-action="load" title="Load into ruler">↗</button>
                  <button type="button" class="mission-mini-btn danger" data-meas-action="remove" title="Delete measurement">✕</button>
                </div>
              </div>
              <div class="mission-item-sub">
                <span style="color:#6ef3e6;font-weight:700">${distStr}</span>
                <span>chord: ${chordStr} · ${segsCount} seg</span>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  _clearGlobeObjects() {
    for (const item of this._renderedPoints) {
      this.group.remove(item.mesh);
      item.labelEl.remove();
    }
    this._renderedPoints = [];

    for (const meas of this._renderedMeasurements) {
      for (const line of meas.lines) {
        this.group.remove(line);
        line.geometry.dispose();
      }
      for (const dot of meas.dots) {
        this.group.remove(dot);
      }
      meas.labelEl.remove();
    }
    this._renderedMeasurements = [];
  }

  _rebuildGlobeObjects() {
    this._clearGlobeObjects();
    const mission = this.getActiveMission();
    if (!mission) return;

    for (const pt of mission.points) {
      if (pt.visible === false) continue;
      const normal = MissionPanel.latLonToNormal(pt.lat, pt.lon);
      const marker = new THREE.Group();
      const outer = new THREE.Mesh(this._markerOuterGeo, this._pointOuterMat);
      const inner = new THREE.Mesh(this._markerInnerGeo, this._pointInnerMat);
      inner.position.z = 0.001;
      marker.add(outer, inner);

      marker.position.copy(normal).multiplyScalar(this.surfaceRadius);
      marker.lookAt(normal.x * 2, normal.y * 2, normal.z * 2);
      marker.renderOrder = 15;
      this.group.add(marker);

      const labelEl = document.createElement('div');
      labelEl.className = 'mission-point-label';
      labelEl.textContent = pt.name;
      labelEl.style.display = 'none';
      this.labelsLayer.appendChild(labelEl);

      this._renderedPoints.push({ normal, mesh: marker, labelEl });
    }

    for (const m of mission.measurements) {
      if (m.visible === false || !Array.isArray(m.points) || m.points.length < 2) continue;

      const lines = [];
      const dots = [];
      const normals = m.points.map((p) => MissionPanel.latLonToNormal(p.lat, p.lon));

      for (let i = 0; i < normals.length; i++) {
        const n = normals[i];
        const dot = new THREE.Mesh(this._markerInnerGeo, this._rulerVertexMat);
        dot.position.copy(n).multiplyScalar(this.rulerArcRadius);
        dot.lookAt(n.x * 2, n.y * 2, n.z * 2);
        dot.renderOrder = 14;
        this.group.add(dot);
        dots.push(dot);

        if (i < normals.length - 1) {
          const positions = RulerTool.slerpArcPositions(n, normals[i + 1], this.rulerArcRadius);
          const geom = new LineGeometry();
          geom.setPositions(positions);
          const lineMesh = new Line2(geom, this._savedLineMaterial);
          lineMesh.renderOrder = 14;
          this.group.add(lineMesh);
          lines.push(lineMesh);
        }
      }

      const midIdx = Math.floor((normals.length - 1) / 2);
      const labelNormal = RulerTool.computeMidNormal(normals[midIdx], normals[midIdx + 1]);
      const labelEl = document.createElement('div');
      labelEl.className = 'mission-ruler-label';
      labelEl.textContent = `${m.name}: ${RulerTool.formatDistance(m.totalArcMeters)}`;
      labelEl.style.display = 'none';
      this.labelsLayer.appendChild(labelEl);

      this._renderedMeasurements.push({
        lines,
        dots,
        labelNormal,
        labelEl,
      });
    }
  }

  update(camera) {
    if (!camera) return;

    this._savedLineMaterial.resolution.set(window.innerWidth || 1, window.innerHeight || 1);

    if (this._renderedPoints.length === 0 && this._renderedMeasurements.length === 0) return;

    camera.updateMatrixWorld();
    const camPos = camera.position;
    const camDist = camPos.length();
    if (camDist <= 0.0001) return;

    this._camDir.copy(camPos).divideScalar(camDist);
    const horizonCos = MOON_CONFIG.RADIUS / camDist;
    const fovRad = THREE.MathUtils.degToRad(camera.fov || 45);
    const tanHalfFov = Math.tan(fovRad * 0.5);
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;

    const projectToLabel = (normal, radius, el) => {
      if (normal.dot(this._camDir) < horizonCos - 0.002) {
        el.style.display = 'none';
        return;
      }
      this._projVec.copy(normal).multiplyScalar(radius).project(camera);
      if (
        this._projVec.z > 1.0 ||
        this._projVec.x < -1.05 ||
        this._projVec.x > 1.05 ||
        this._projVec.y < -1.05 ||
        this._projVec.y > 1.05
      ) {
        el.style.display = 'none';
        return;
      }
      const x = (this._projVec.x * 0.5 + 0.5) * width;
      const y = (-this._projVec.y * 0.5 + 0.5) * height;
      el.style.left = `${x.toFixed(1)}px`;
      el.style.top = `${y.toFixed(1)}px`;
      el.style.display = 'block';
    };

    for (const pt of this._renderedPoints) {
      const dist = camPos.distanceTo(pt.mesh.position);
      const worldHeight = 2 * dist * tanHalfFov;
      const worldRadius = (6.5 / height) * worldHeight;
      pt.mesh.scale.set(worldRadius, worldRadius, 1);
      projectToLabel(pt.normal, this.surfaceRadius, pt.labelEl);
    }

    for (const meas of this._renderedMeasurements) {
      for (const dot of meas.dots) {
        const dist = camPos.distanceTo(dot.position);
        const worldHeight = 2 * dist * tanHalfFov;
        const worldRadius = (4.5 / height) * worldHeight;
        dot.scale.set(worldRadius, worldRadius, 1);
      }
      projectToLabel(meas.labelNormal, this.rulerArcRadius, meas.labelEl);
    }
  }

  dispose() {
    this._clearGlobeObjects();
    this._markerOuterGeo.dispose();
    this._markerInnerGeo.dispose();
    this._pointOuterMat.dispose();
    this._pointInnerMat.dispose();
    this._rulerVertexMat.dispose();
    this._savedLineMaterial.dispose();
    if (this.scene) {
      this.scene.remove(this.group);
    }
    this.rootEl?.remove();
    this.labelsLayer?.remove();
  }
}
