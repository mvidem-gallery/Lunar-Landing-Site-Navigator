import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MOON_CONFIG, TRAJECTORY_CONFIG, VIEW_MODES } from '../config/constants.js';
import {
  buildTrajectoryRecalcPayload,
  computeTransitDurationSec,
  createDefaultMissions,
  createMissionRecord,
  extractTrajectoryMeta,
  formatCoords,
  formatTransitDuration,
  formatUtcCompact,
  formatUtcTimestamp,
  MISSION_CATEGORIES,
  normalizeLandingSite,
  normalizeMission,
  parseCatalogSiteDateIso,
  parseDatetimeLocalUtc,
  resolveMissionFlightMode,
  toDatetimeLocalUtc,
} from '../data/missionModel.js';
import { parseUtcStringToMs } from '../astronomy/trajectoryGenerator.js';
import { NASA_MOON_EXPLORATION_SITES } from '../data/lunarLandingSites.js';
import { deleteTrajectoryDoc, saveTrajectoryDoc } from '../data/trajectoryStorage.js';
import {
  extractScheduleFromGeneratedResult,
  fetchTrajectoryCatalog,
  generateMissionTrajectory,
} from '../data/trajectoryServiceClient.js';
import { RulerTool } from './rulerTool.js';
import './missionPanel.css';

const MISSIONS_STORAGE_KEY = 'lunar_missions_v1';
const CUSTOM_SITES_STORAGE_KEY = 'lunar_custom_landing_sites_v1';

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
    return formatCoords(lat, lon);
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
    return createDefaultMissions();
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
   * @param {Function|null} [options.onLoadMissionTrajectory]
   * @param {Function|null} [options.onSetTrajectoryVisible]
   * @param {Function|null} [options.onOpenCislunarView]
   * @param {Function|null} [options.onLandToMissionTarget]
   * @param {Function|null} [options.onOpenDashboard]
   * @param {Function|null} [options.onFlightLogGenerated]
   * @param {Function|null} [options.getCurrentTimelineDate]
   * @param {Function|null} [options.onJumpTimelineToDate]
   * @param {Function|null} [options.getViewMode]
   * @param {Function|null} [options.onPickOnMoon]
   * @param {Function|null} [options.onCancelPickOnMoon]
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
    onLoadMissionTrajectory = null,
    onSetTrajectoryVisible = null,
    onOpenCislunarView = null,
    onLandToMissionTarget = null,
    onOpenDashboard = null,
    onFlightLogGenerated = null,
    getCurrentTimelineDate = null,
    onJumpTimelineToDate = null,
    getViewMode = null,
    onPickOnMoon = null,
    onCancelPickOnMoon = null,
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
    this.onLoadMissionTrajectory = onLoadMissionTrajectory;
    this.onSetTrajectoryVisible = onSetTrajectoryVisible;
    this.onOpenCislunarView = onOpenCislunarView;
    this.onLandToMissionTarget = onLandToMissionTarget;
    this.onOpenDashboard = onOpenDashboard;
    this.onFlightLogGenerated = onFlightLogGenerated;
    this.getCurrentTimelineDate = getCurrentTimelineDate;
    this.onJumpTimelineToDate = onJumpTimelineToDate;
    this.getViewMode = getViewMode;
    this.onPickOnMoon = onPickOnMoon;
    this.onCancelPickOnMoon = onCancelPickOnMoon;

    const loaded = this._loadState();
    this.missions = loaded.missions;
    this.activeMissionId = loaded.activeMissionId;

    // 'list' | 'detail'
    this._panelView = 'detail';
    // 'flight' | 'traj' | 'surface'
    this._detailTab = 'flight';
    // 'historical' | 'custom' | 'future'
    this._listTab = this._categoryForMission(this.getActiveMission());
    this._presetSiteTab = this._listTab || 'historical';
    this._selectedPresetSiteId = '';
    this._lastAutoPresetName = '';
    this._listSearchQuery = '';
    this._isRenameOpen = false;
    this._isNewMissionFormOpen = false;
    this._isNewMissionAdvancedOpen = false;
    this._newMissionFormError = '';
    this._newMissionErrorKind = null;
    this._isCreatingMission = false;
    this._createMissionStatus = '';
    this._createMissionAbort = null;
    this._trajCatalog = null;
    this._isCatalogLoading = false;
    this._newMissionDraft = this._createEmptyNewMissionDraft();
    this._isTargetFormOpen = false;
    this._isAddPointFormOpen = false;
    this._targetFormError = '';
    this._pointFormError = '';
    this._trajStatusMsg = '';
    this._trajErrorMsg = '';
    this._isRecalculatingTraj = false;
    this._recalcTrajMissionId = null;
    this._recalcTrajStatus = '';
    this._recalcTrajError = '';
    this._recalcTrajAbort = null;
    this._recalcTrajSeq = 0;
    this._canSaveRuler = false;
    this._activePickTarget = null;
    this._collapsedSections = new Set();
    this._solverUiMissionId = null;
    this._solverUiMode = 'fast';
    this._solverUiMarginMs = '50';
    this._solverUiRefine = true;
    this._solverUiShowAllDays = false;

    this.surfaceRadius = MOON_CONFIG.RADIUS + 0.000026;
    this.targetRadius = MOON_CONFIG.RADIUS + 0.000032;
    this.rulerArcRadius = MOON_CONFIG.RADIUS + 0.000014;

    this.group = new THREE.Group();
    this.group.renderOrder = 14;
    if (this.scene) {
      this.scene.add(this.group);
    }

    this._markerOuterGeo = new THREE.RingGeometry(0.62, 1.0, 28);
    this._markerInnerGeo = new THREE.CircleGeometry(0.36, 18);
    this._targetRingGeo = new THREE.RingGeometry(0.72, 1.15, 32);

    this._pointOuterMat = new THREE.MeshBasicMaterial({
      color: 0x0095ff,
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
    this._targetOuterMat = new THREE.MeshBasicMaterial({
      color: 0x22c55e,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._rulerVertexMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._savedLineMaterial = new LineMaterial({
      color: 0xf59e0b,
      linewidth: 2.2,
      transparent: true,
      opacity: 0.88,
      depthTest: true,
      depthWrite: false,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    this._renderedTarget = null;
    this._renderedPoints = [];
    this._renderedMeasurements = [];
    this._camDir = new THREE.Vector3();
    this._projVec = new THREE.Vector3();
    this._localCamPos = new THREE.Vector3();
    this._invWorldMatrix = new THREE.Matrix4();
    this._zAxis = new THREE.Vector3(0, 0, 1);

    this._buildDOM();
    this._bindEvents();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'init' });
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
      // Ignore localStorage parse errors
    }

    const defaults = createDefaultMissions();
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
      // Ignore storage quota errors
    }
  }

  getActiveMission() {
    return (
      this.missions.find((m) => m.id === this.activeMissionId) ||
      this.missions[0] ||
      null
    );
  }

  getAllMissions() {
    return this.missions;
  }

  _touchMission(mission) {
    if (mission) {
      mission.updatedAt = new Date().toISOString();
    }
  }

  _notifyMissionChange(meta = {}) {
    if (typeof this.onActiveMissionChange === 'function') {
      this.onActiveMissionChange(this.getActiveMission(), meta);
    }
  }

  _categoryForMission(mission) {
    if (mission && MISSION_CATEGORIES.includes(mission.category)) {
      return mission.category;
    }
    if (mission?.id === 'mission-apollo-11') return 'historical';
    if (mission?.id === 'mission-artemis-south') return 'future';
    return 'custom';
  }

  _loadCustomCatalogSites() {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(CUSTOM_SITES_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (item) =>
            item &&
            typeof item.name === 'string' &&
            Number.isFinite(Number(item.lat)) &&
            Number.isFinite(Number(item.lon))
        )
        .map((item) => ({
          id: String(item.id || `custom-${item.name}`),
          name: item.name.trim(),
          program: 'Custom',
          agency: 'User',
          status: 'custom',
          date: typeof item.date === 'string' ? item.date : '',
          region: typeof item.region === 'string' ? item.region : 'Custom landing site',
          lat: Number(item.lat),
          lon: Number(item.lon),
          description: typeof item.description === 'string' ? item.description : '',
          origin: 'custom',
        }));
    } catch {
      return [];
    }
  }

  _getPresetSitesForCategory(category) {
    if (category === 'historical') {
      return NASA_MOON_EXPLORATION_SITES.filter((s) => s.status === 'landed');
    }
    if (category === 'future') {
      return NASA_MOON_EXPLORATION_SITES.filter((s) => s.status === 'planned');
    }
    return this._loadCustomCatalogSites();
  }

  _findCatalogSiteById(siteId) {
    if (!siteId) return null;
    return (
      NASA_MOON_EXPLORATION_SITES.find((s) => s.id === siteId) ||
      this._loadCustomCatalogSites().find((s) => s.id === siteId) ||
      null
    );
  }

  openMissionList(tab = null) {
    if (tab && MISSION_CATEGORIES.includes(tab)) {
      this._listTab = tab;
    } else if (!MISSION_CATEGORIES.includes(this._listTab)) {
      this._listTab = this._categoryForMission(this.getActiveMission());
    }
    this._cancelActivePick();
    this._panelView = 'list';
    this._isRenameOpen = false;
    this.render();
  }

  _createEmptyNewMissionDraft() {
    return {
      name: '',
      landingDateLocal: '',
      lat: '',
      lon: '',
      trajectoryType: 'direct',
      dateMode: 'arrival',
      spaceport: '',
      rocket: '',
      spacecraft: '',
      heightM: '',
      landingWindowMode: 'flexible',
      requireSunVisible: false,
      sunElevationMinDeg: '0',
      sunElevationMaxDeg: '90',
      requireEarthVisible: false,
      maxWaitInOrbitH: '48',
      noTerrain: false,
      noCache: false,
      flightMode: 'fast',
      launchWindowMarginMs: '50',
      launchWindowRefine: true,
      notes: '',
    };
  }

  async _ensureTrajectoryCatalogLoaded() {
    if (this._trajCatalog || this._isCatalogLoading) return;
    this._isCatalogLoading = true;
    try {
      const catalog = await fetchTrajectoryCatalog();
      this._trajCatalog = catalog;
    } catch {
      // Keep graceful empty catalog if endpoint temporarily unreachable
    } finally {
      this._isCatalogLoading = false;
      if (this._isNewMissionFormOpen && !this._isCreatingMission) {
        this._syncNewMissionDraftFromDom();
        this.render();
      }
    }
  }

  openNewMissionForm({ lat = null, lon = null, landingDateIso = null, name = '' } = {}) {
    if (this._isCreatingMission) {
      this._createMissionAbort?.abort();
      this._isCreatingMission = false;
      this._createMissionStatus = '';
      this._createMissionAbort = null;
    }
    this._panelView = 'list';
    this._collapsedSections.delete('missions-list');
    this._isRenameOpen = false;
    this._isNewMissionFormOpen = true;
    this._isNewMissionAdvancedOpen = false;
    this._newMissionFormError = '';
    this._newMissionErrorKind = null;

    const fallbackDate = this.getCurrentTimelineDate?.();
    const resolvedIso =
      landingDateIso && Number.isFinite(Date.parse(landingDateIso))
        ? new Date(Date.parse(landingDateIso)).toISOString()
        : fallbackDate instanceof Date && !Number.isNaN(fallbackDate.getTime())
          ? fallbackDate.toISOString()
          : null;

    const hasLatLon = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
    this._newMissionDraft = {
      ...this._createEmptyNewMissionDraft(),
      name: String(name || ''),
      landingDateLocal: toDatetimeLocalUtc(resolvedIso),
      lat: hasLatLon ? Number(lat).toFixed(5) : '',
      lon: hasLatLon ? Number(lon).toFixed(5) : '',
    };
    this._selectedPresetSiteId = '';
    this._lastAutoPresetName = '';
    this._presetSiteTab = this._listTab === 'future' || this._listTab === 'historical' ? this._listTab : 'future';

    this._ensureTrajectoryCatalogLoaded();
    this.render();
    const nameEl = this.contentHostEl?.querySelector('[data-field="new-mission-name"]');
    nameEl?.focus();
    nameEl?.select();
  }

  openActiveMissionDetail(subTab = null) {
    this._panelView = 'detail';
    const normalizedTab = subTab === 'points' || subTab === 'ruler' ? 'surface' : subTab;
    if (normalizedTab && ['flight', 'traj', 'surface'].includes(normalizedTab)) {
      this._detailTab = normalizedTab;
    }
    this.render();
  }

  refreshViewState() {
    this.render();
  }

  _buildDOM() {
    this.rootEl = document.createElement('div');
    this.rootEl.className = 'mission-panel';

    // Hidden file input for per-mission trajectory JSON import
    this.trajFileInputEl = document.createElement('input');
    this.trajFileInputEl.type = 'file';
    this.trajFileInputEl.accept = '.json,application/json';
    this.trajFileInputEl.style.display = 'none';
    this.rootEl.appendChild(this.trajFileInputEl);

    this.contentHostEl = document.createElement('div');
    this.contentHostEl.className = 'mission-panel-host';
    this.rootEl.appendChild(this.contentHostEl);

    this.container.appendChild(this.rootEl);

    this.labelsLayer = document.createElement('div');
    this.labelsLayer.id = 'mission-labels-layer';
    document.body.appendChild(this.labelsLayer);
  }

  _bindEvents() {
    this.trajFileInputEl.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      this.trajFileInputEl.value = '';
      if (!file) return;
      await this._handleTrajectoryFileSelected(file);
    });

    this.contentHostEl.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-m-action]');
      if (actionEl) {
        e.stopPropagation();
        this._handleActionClick(actionEl, e);
        return;
      }

      // Click on a mission card in List mode
      const missionCard = e.target.closest('[data-mission-card-id]');
      if (missionCard) {
        const missionId = missionCard.dataset.missionCardId;
        const wasDifferent = missionId !== this.activeMissionId;
        this._panelView = 'detail';
        this._detailTab = 'flight';
        if (wasDifferent) {
          this.setActiveMission(missionId);
        } else {
          this.render();
        }
        const selected = this.missions.find((m) => m.id === missionId);
        if (selected?.landingSite && typeof this.onFlyTo === 'function') {
          this.onFlyTo(
            selected.landingSite.lat,
            selected.landingSite.lon,
            this._categoryForMission(selected) === 'future' ? 45 : 65
          );
        }
        return;
      }

      // Click on a catalog mission card in List mode -> activate + pull landing site
      const catalogCard = e.target.closest('[data-catalog-site-id]');
      if (catalogCard) {
        this.activateCatalogMission(catalogCard.dataset.catalogSiteId, {
          category: catalogCard.dataset.siteCategory || null,
          openDetail: true,
        });
        return;
      }

      // Click on a waypoint card -> fly to point
      const pointCard = e.target.closest('[data-point-id]');
      if (pointCard) {
        const mission = this.getActiveMission();
        const pt = mission?.points.find((p) => p.id === pointCard.dataset.pointId);
        if (pt && typeof this.onFlyTo === 'function') {
          this.onFlyTo(pt.lat, pt.lon, 65);
        }
        return;
      }

      // Click on a measurement card -> fly to midpoint
      const measCard = e.target.closest('[data-meas-id]');
      if (measCard) {
        const mission = this.getActiveMission();
        const meas = mission?.measurements.find((m) => m.id === measCard.dataset.measId);
        if (meas && meas.points?.length > 0 && typeof this.onFlyTo === 'function') {
          const mid = meas.points[Math.floor(meas.points.length / 2)];
          this.onFlyTo(mid.lat, mid.lon, 28);
        }
      }
    });

    this.contentHostEl.addEventListener('input', (e) => {
      if (e.target.closest('[data-form="new-mission"]')) {
        this._syncNewMissionDraftFromDom();
        return;
      }
      if (e.target.matches('[data-field="solver-window-margin"]')) {
        this._solverUiMarginMs = e.target.value ?? '';
        return;
      }
      if (e.target.matches('[data-field="list-search"]')) {
        this._listSearchQuery = e.target.value || '';
        this._renderMissionCardsOnly();
      }
    });

    this.contentHostEl.addEventListener('change', (e) => {
      if (e.target.closest('[data-form="new-mission"]')) {
        this._syncNewMissionDraftFromDom();
        if (e.target.matches('[data-field="new-mission-site-preset"]')) {
          const siteId = e.target.value;
          this._selectedPresetSiteId = siteId;
          const site = this._findCatalogSiteById(siteId);
          if (site) {
            this._newMissionDraft.lat = Number(site.lat).toFixed(5);
            this._newMissionDraft.lon = Number(site.lon).toFixed(5);
            if (!this._newMissionDraft.name.trim() || this._newMissionDraft.name === this._lastAutoPresetName) {
              this._newMissionDraft.name = site.name;
              this._lastAutoPresetName = site.name;
            }
            if (!this._newMissionDraft.notes.trim()) {
              this._newMissionDraft.notes = site.description || site.region || '';
            }
            const parsedIso = parseCatalogSiteDateIso(site.date);
            if (parsedIso) {
              this._newMissionDraft.landingDateLocal = toDatetimeLocalUtc(parsedIso);
            }
            this.render();
          }
          return;
        }
        if (e.target.matches('[data-field="new-mission-landing-mode"]')) {
          const mode = this._newMissionDraft.landingWindowMode;
          if (mode === 'flexible') {
            this._newMissionDraft.requireSunVisible = false;
            this._newMissionDraft.sunElevationMinDeg = '0';
            this._newMissionDraft.sunElevationMaxDeg = '90';
            this._newMissionDraft.requireEarthVisible = false;
          } else if (mode === 'daylight') {
            this._newMissionDraft.requireSunVisible = true;
            this._newMissionDraft.sunElevationMinDeg = '0';
            this._newMissionDraft.sunElevationMaxDeg = '90';
            this._newMissionDraft.requireEarthVisible = false;
          } else if (mode === 'daylight_earth') {
            this._newMissionDraft.requireSunVisible = true;
            this._newMissionDraft.sunElevationMinDeg = '0';
            this._newMissionDraft.sunElevationMaxDeg = '90';
            this._newMissionDraft.requireEarthVisible = true;
          } else if (mode === 'artemis') {
            this._newMissionDraft.requireSunVisible = true;
            this._newMissionDraft.sunElevationMinDeg = '0';
            this._newMissionDraft.sunElevationMaxDeg = '20';
            this._newMissionDraft.requireEarthVisible = true;
          }
          this.render();
        } else if (e.target.matches('[data-field="new-mission-req-sun"]')) {
          this.render();
        } else if (e.target.matches('[data-field="new-mission-date-mode"]')) {
          this.render();
        }
        return;
      }
      if (e.target.matches('[data-field="solver-window-refine"]')) {
        this._solverUiRefine = Boolean(e.target.checked);
        return;
      }
      const mission = this.getActiveMission();
      if (e.target.matches('[data-field="target-site-preset"]')) {
        const formEl = e.target.closest('[data-form="target-form"]');
        const site = this._findCatalogSiteById(e.target.value);
        if (formEl && site) {
          const nameInput = formEl.querySelector('[data-field="target-name"]');
          const latInput = formEl.querySelector('[data-field="target-lat"]');
          const lonInput = formEl.querySelector('[data-field="target-lon"]');
          const noteInput = formEl.querySelector('[data-field="target-note"]');
          if (nameInput) nameInput.value = site.name;
          if (latInput) latInput.value = String(Number(site.lat).toFixed(5));
          if (lonInput) lonInput.value = String(Number(site.lon).toFixed(5));
          if (noteInput) noteInput.value = [site.region, site.agency, site.date].filter(Boolean).join(' · ');
        }
        return;
      }
      if (!mission) return;

      if (e.target.matches('[data-field="landing-date-input"]')) {
        const iso = parseDatetimeLocalUtc(e.target.value);
        this.updateActiveFlightDates({
          landingDateIso: iso,
          dateSource: iso ? 'manual' : 'unset',
        });
      } else if (e.target.matches('[data-field="launch-date-input"]')) {
        const iso = parseDatetimeLocalUtc(e.target.value);
        this.updateActiveFlightDates({
          launchDateIso: iso,
          dateSource: iso ? 'manual' : undefined,
        });
      } else if (e.target.matches('[data-field="transit-hours-input"]')) {
        const hrs = Number.parseFloat(e.target.value);
        if (Number.isFinite(hrs) && hrs >= 0) {
          this.updateActiveTransitDuration(Math.round(hrs * 3600));
        }
      } else if (e.target.matches('[data-field="mission-notes"]')) {
        mission.modules.notes = e.target.value || '';
        this._touchMission(mission);
        this._persistState();
      }
    });

    this.contentHostEl.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target.matches('[data-form="new-mission"]')) {
        this._handleCreateMissionSubmit(e.target);
      } else if (e.target.matches('[data-form="target-form"]')) {
        this._handleTargetFormSubmit(e.target);
      } else if (e.target.matches('[data-form="point-form"]')) {
        this._handleAddPointSubmit(e.target);
      }
    });

    this.contentHostEl.addEventListener('keydown', (e) => {
      if (e.target.matches('[data-field="rename-input"]')) {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._commitRename(e.target.value);
        } else if (e.key === 'Escape') {
          this._isRenameOpen = false;
          this.render();
        }
      }
    });
  }

  _handleActionClick(btn) {
    const action = btn.dataset.mAction;
    const mission = this.getActiveMission();

    switch (action) {
      case 'back-to-list':
        this._cancelActivePick();
        this.openMissionList();
        break;
      case 'toggle-new-mission':
        if (this._isNewMissionFormOpen) {
          if (this._isCreatingMission) break;
          this._isNewMissionFormOpen = false;
          this._newMissionFormError = '';
          this._newMissionErrorKind = null;
          this._cancelActivePick('new-mission');
          this.render();
        } else {
          this.openNewMissionForm();
        }
        break;
      case 'toggle-new-mission-advanced':
        this._syncNewMissionDraftFromDom();
        this._isNewMissionAdvancedOpen = !this._isNewMissionAdvancedOpen;
        this.render();
        break;
      case 'set-draft-flight-mode': {
        if (this._isCreatingMission) break;
        this._syncNewMissionDraftFromDom();
        const mode = btn.dataset.flightMode;
        if (mode === 'fast' || mode === 'economy' || mode === 'launch_window') {
          this._newMissionDraft.flightMode = mode;
          if (mode === 'launch_window') {
            this._newMissionDraft.dateMode = 'arrival';
          }
          this._newMissionFormError = '';
          this._newMissionErrorKind = null;
          this.render();
        }
        break;
      }
      case 'cancel-new-mission':
        if (this._isCreatingMission) {
          this._createMissionAbort?.abort();
          this._isCreatingMission = false;
          this._createMissionStatus = '';
          this._newMissionFormError = 'Trajectory generation cancelled.';
          this._newMissionErrorKind = null;
          this.render();
          break;
        }
        this._isNewMissionFormOpen = false;
        this._isNewMissionAdvancedOpen = false;
        this._newMissionFormError = '';
        this._newMissionErrorKind = null;
        this._cancelActivePick('new-mission');
        this.render();
        break;
      case 'retry-new-mission-flexible': {
        if (this._isCreatingMission) break;
        this._syncNewMissionDraftFromDom();
        this._newMissionDraft.landingWindowMode = 'flexible';
        this._newMissionDraft.requireSunVisible = false;
        this._newMissionDraft.sunElevationMinDeg = '0';
        this._newMissionDraft.sunElevationMaxDeg = '90';
        this._newMissionDraft.requireEarthVisible = false;
        this._newMissionFormError = '';
        this._newMissionErrorKind = null;
        this.render();
        const formEl = this.contentHostEl?.querySelector('[data-form="new-mission"]');
        if (formEl) this._handleCreateMissionSubmit(formEl);
        break;
      }
      case 'retry-new-mission-no-terrain': {
        if (this._isCreatingMission) break;
        this._syncNewMissionDraftFromDom();
        this._newMissionDraft.noTerrain = true;
        this._newMissionFormError = '';
        this._newMissionErrorKind = null;
        this.render();
        const formEl = this.contentHostEl?.querySelector('[data-form="new-mission"]');
        if (formEl) this._handleCreateMissionSubmit(formEl);
        break;
      }
      case 'clear-list-search':
        this._listSearchQuery = '';
        this.render();
        break;
      case 'switch-list-tab': {
        const tab = btn.dataset.listTab;
        if (tab && MISSION_CATEGORIES.includes(tab)) {
          this._listTab = tab;
          this.render();
        }
        break;
      }
      case 'open-category-list': {
        const tab = btn.dataset.listTab;
        this.openMissionList(tab);
        break;
      }
      case 'switch-preset-tab': {
        const tab = btn.dataset.presetTab;
        if (tab && MISSION_CATEGORIES.includes(tab)) {
          if (this._isNewMissionFormOpen) {
            this._syncNewMissionDraftFromDom();
          }
          this._presetSiteTab = tab;
          this._selectedPresetSiteId = '';
          this.render();
        }
        break;
      }
      case 'activate-catalog-mission':
        this.activateCatalogMission(btn.dataset.siteId, {
          category: btn.dataset.siteCategory || null,
          openDetail: false,
        });
        break;
      case 'open-catalog-mission':
        this.activateCatalogMission(btn.dataset.siteId, {
          category: btn.dataset.siteCategory || null,
          openDetail: true,
        });
        break;
      case 'activate-mission': {
        const id = btn.dataset.missionId;
        if (id) {
          this.setActiveMission(id);
          const targetMission = this.missions.find((m) => m.id === id);
          if (targetMission?.landingSite && typeof this.onFlyTo === 'function') {
            this.onFlyTo(
              targetMission.landingSite.lat,
              targetMission.landingSite.lon,
              this._categoryForMission(targetMission) === 'future' ? 45 : 65
            );
          }
        }
        break;
      }
      case 'open-mission-detail': {
        const id = btn.dataset.missionId;
        this._panelView = 'detail';
        this._detailTab = 'flight';
        if (id && id !== this.activeMissionId) {
          this.setActiveMission(id);
          const targetMission = this.missions.find((m) => m.id === id);
          if (targetMission?.landingSite && typeof this.onFlyTo === 'function') {
            this.onFlyTo(
              targetMission.landingSite.lat,
              targetMission.landingSite.lon,
              this._categoryForMission(targetMission) === 'future' ? 45 : 65
            );
          }
        } else {
          this.render();
        }
        break;
      }
      case 'duplicate-mission': {
        const id = btn.dataset.missionId || this.activeMissionId;
        this.duplicateMission(id);
        break;
      }
      case 'delete-mission': {
        const id = btn.dataset.missionId || this.activeMissionId;
        if (this.missions.length > 1 && id) {
          this.deleteMission(id);
        }
        break;
      }
      case 'toggle-rename':
        this._isRenameOpen = !this._isRenameOpen;
        this.render();
        if (this._isRenameOpen) {
          const inp = this.contentHostEl.querySelector('[data-field="rename-input"]');
          inp?.focus();
          inp?.select();
        }
        break;
      case 'save-rename': {
        const inp = this.contentHostEl.querySelector('[data-field="rename-input"]');
        this._commitRename(inp?.value || '');
        break;
      }
      case 'switch-subtab': {
        const rawTab = btn.dataset.subtab;
        const tab = rawTab === 'points' || rawTab === 'ruler' ? 'surface' : rawTab;
        if (tab && ['flight', 'traj', 'surface'].includes(tab)) {
          this._detailTab = tab;
          this.render();
        }
        break;
      }
      case 'fly-to-target':
        if (mission?.landingSite && typeof this.onFlyTo === 'function') {
          this.onFlyTo(mission.landingSite.lat, mission.landingSite.lon, 55);
        }
        break;
      case 'toggle-target-vis':
        if (mission?.landingSite) {
          mission.landingSite.visible = mission.landingSite.visible === false;
          this._touchMission(mission);
          this._persistState();
          this.render();
          this._rebuildGlobeObjects();
        }
        break;
      case 'toggle-target-form':
        this._collapsedSections.delete('flight-target');
        this._isTargetFormOpen = !this._isTargetFormOpen;
        this._targetFormError = '';
        if (!this._isTargetFormOpen) this._cancelActivePick('target-form');
        this.render();
        if (this._isTargetFormOpen) {
          this.contentHostEl.querySelector('[data-field="target-name"]')?.focus();
        }
        break;
      case 'toggle-section': {
        const secId = btn.dataset.sectionId;
        if (secId) {
          if (this._collapsedSections.has(secId)) this._collapsedSections.delete(secId);
          else this._collapsedSections.add(secId);
          this.render();
        }
        break;
      }
      case 'cancel-target-form':
        this._isTargetFormOpen = false;
        this._targetFormError = '';
        this._cancelActivePick('target-form');
        this.render();
        break;
      case 'target-from-camera':
        if (this.camera) {
          const camNormal = this.camera.position.clone().normalize();
          const { lat, lon } = MissionPanel.normalToLatLon(camNormal);
          this.setActiveLandingSite({
            name: `Landing Zone (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`,
            lat,
            lon,
            note: 'Captured from camera center',
          });
        }
        break;
      case 'clear-target':
        if (mission) {
          mission.landingSite = null;
          this._isTargetFormOpen = false;
          this._touchMission(mission);
          this._persistState();
          this.render();
          this._rebuildGlobeObjects();
          this._notifyMissionChange({ reason: 'target-cleared' });
        }
        break;
      case 'cancel-recalc-traj':
        this.cancelTrajectoryRecalculation();
        break;
      case 'set-active-solver-mode': {
        const mode = btn.dataset.flightMode;
        if (mission && (mode === 'fast' || mode === 'economy' || mode === 'launch_window')) {
          this._syncSolverUiToMission(mission);
          this._solverUiMode = mode;
          this.render();
        }
        break;
      }
      case 'recalc-mission-mode': {
        if (!mission || !mission.landingSite || this._isRecalculatingTraj) break;
        this._syncSolverUiToMission(mission);
        const marginEl = this.contentHostEl?.querySelector('[data-field="solver-window-margin"]');
        if (marginEl) this._solverUiMarginMs = marginEl.value ?? '';
        const refineEl = this.contentHostEl?.querySelector('[data-field="solver-window-refine"]');
        if (refineEl) this._solverUiRefine = Boolean(refineEl.checked);

        const mode = this._solverUiMode;
        let marginMs = null;
        if (mode === 'launch_window') {
          const raw = String(this._solverUiMarginMs ?? '').trim();
          if (raw !== '') {
            const parsed = Number.parseFloat(raw);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5000) {
              this._recalcTrajMissionId = mission.id;
              this._recalcTrajError = 'Launch window Δv margin must be between 0 and 5000 m/s.';
              this._trajErrorMsg = this._recalcTrajError;
              this.render();
              break;
            }
            marginMs = parsed;
          }
        }
        this._recalculateTrajectoryForMission(mission, {
          flightMode: mode,
          launchWindowMarginMs: marginMs,
          launchWindowRefine: Boolean(this._solverUiRefine),
        });
        break;
      }
      case 'toggle-economy-days':
        this._solverUiShowAllDays = !this._solverUiShowAllDays;
        this.render();
        break;
      case 'sync-window-optimum': {
        const opt = mission?.modules?.generation?.launchWindow?.optimum;
        if (mission && opt) {
          const launchIso = this._solverUtcToIso(opt.launch_utc);
          const landingIso = this._solverUtcToIso(opt.touchdown_utc || opt.lunar_orbit_insertion_utc);
          if (launchIso || landingIso) {
            this.updateActiveFlightDates({
              ...(launchIso ? { launchDateIso: launchIso } : {}),
              ...(landingIso ? { landingDateIso: landingIso } : {}),
              dateSource: 'trajectory',
            });
            if (landingIso) {
              const d = new Date(landingIso);
              if (!Number.isNaN(d.getTime())) this.onJumpTimelineToDate?.(d);
            }
          }
        }
        break;
      }
      case 'land-to-target':
        if (mission?.landingSite && typeof this.onLandToMissionTarget === 'function') {
          this.onLandToMissionTarget(mission);
        }
        break;
      case 'browse-sites':
        this.onOpenCatalog?.();
        break;
      case 'use-timeline-date': {
        const tlDate = this.getCurrentTimelineDate?.();
        if (tlDate instanceof Date && !Number.isNaN(tlDate.getTime())) {
          this.updateActiveFlightDates({
            landingDateIso: tlDate.toISOString(),
            dateSource: 'timeline',
          });
        }
        break;
      }
      case 'sync-timeline-date': {
        if (mission?.flight?.landingDateIso) {
          const d = new Date(mission.flight.landingDateIso);
          if (!Number.isNaN(d.getTime())) {
            this.onJumpTimelineToDate?.(d);
          }
        }
        break;
      }
      case 'set-landing-now':
        this.updateActiveFlightDates({
          landingDateIso: new Date().toISOString(),
          dateSource: 'manual',
        });
        break;
      case 'clear-flight-dates':
        if (mission) {
          mission.flight = {
            launchDateIso: null,
            landingDateIso: null,
            transitDurationSec: null,
            dateSource: 'unset',
          };
          this._touchMission(mission);
          this._persistState();
          this.render();
          this._notifyMissionChange({ reason: 'dates-cleared' });
        }
        break;
      case 'upload-traj-json':
        this._trajErrorMsg = '';
        this.trajFileInputEl.click();
        break;
      case 'load-default-traj':
        if (mission) {
          this._trajErrorMsg = '';
          this._trajStatusMsg = 'Loading default trajectory...';
          mission.trajectory = {
            sourceType: 'url',
            url: TRAJECTORY_CONFIG.DEFAULT_URL,
            docId: null,
            fileName: 'trajectory-2026-11-15T121332Z.json',
            visible: true,
            meta: null,
          };
          this._touchMission(mission);
          this._persistState();
          this.render();
          this.onLoadMissionTrajectory?.(mission, { syncFromMeta: true });
        }
        break;
      case 'toggle-traj-visible':
        if (mission) {
          mission.trajectory.visible = mission.trajectory.visible === false;
          this._touchMission(mission);
          this._persistState();
          this.onSetTrajectoryVisible?.(mission.trajectory.visible);
          this.render();
        }
        break;
      case 'open-cislunar':
        this.onOpenCislunarView?.();
        break;
      case 'open-dashboard':
        this.onOpenDashboard?.(mission);
        break;
      case 'sync-from-traj':
        if (mission?.trajectory?.meta) {
          this.applyTrajectoryMetaToMission(mission, mission.trajectory.meta, { overwriteSite: true });
          this._trajStatusMsg = 'Landing target & flight schedule synced from JSON.';
          this.render();
        }
        break;
      case 'clear-traj':
        if (mission) {
          const oldDocId = mission.trajectory?.docId;
          if (oldDocId) deleteTrajectoryDoc(oldDocId);
          mission.trajectory = {
            sourceType: 'none',
            url: null,
            docId: null,
            fileName: null,
            visible: true,
            meta: null,
          };
          this._trajStatusMsg = '';
          this._trajErrorMsg = '';
          this._touchMission(mission);
          this._persistState();
          this.render();
          this.onLoadMissionTrajectory?.(mission);
          this._notifyMissionChange({ reason: 'traj-cleared' });
        }
        break;
      case 'toggle-point-form':
        this._collapsedSections.delete('surface-data');
        this._isAddPointFormOpen = !this._isAddPointFormOpen;
        this._pointFormError = '';
        if (!this._isAddPointFormOpen) this._cancelActivePick('point-form');
        this.render();
        if (this._isAddPointFormOpen) {
          this.contentHostEl.querySelector('[data-field="point-name"]')?.focus();
        }
        break;
      case 'cancel-point-form':
        this._isAddPointFormOpen = false;
        this._pointFormError = '';
        this._cancelActivePick('point-form');
        this.render();
        break;
      case 'pick-on-moon':
        this._startPickOnMoon(btn.dataset.pickTarget);
        break;
      case 'add-point-from-camera':
        if (this.camera) {
          const camNormal = this.camera.position.clone().normalize();
          const { lat, lon } = MissionPanel.normalToLatLon(camNormal);
          this.addPointToActiveMission({
            name: `Waypoint (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`,
            lat,
            lon,
            note: 'Added from camera center',
          });
        }
        break;
      case 'point-set-target': {
        const pt = mission?.points.find((p) => p.id === btn.dataset.pointId);
        if (pt) {
          this.setActiveLandingSite({
            name: pt.name,
            lat: pt.lat,
            lon: pt.lon,
            note: pt.note || 'Promoted from mission waypoint',
          });
          this._detailTab = 'flight';
          this.render();
        }
        break;
      }
      case 'point-toggle-vis':
        this.togglePointVisibility(btn.dataset.pointId);
        break;
      case 'point-remove':
        this.removePointFromActiveMission(btn.dataset.pointId);
        break;
      case 'open-ruler':
        this.onOpenRuler?.();
        break;
      case 'save-ruler':
        if (typeof this.getRulerSnapshot === 'function') {
          const snapshot = this.getRulerSnapshot();
          if (snapshot) {
            this.saveRulerMeasurement(snapshot);
          }
        }
        break;
      case 'meas-toggle-vis':
        this.toggleMeasurementVisibility(btn.dataset.measId);
        break;
      case 'meas-load': {
        const m = mission?.measurements.find((item) => item.id === btn.dataset.measId);
        if (m) {
          this.onLoadRulerSnapshot?.(m);
        }
        break;
      }
      case 'meas-remove':
        this.removeMeasurementFromActiveMission(btn.dataset.measId);
        break;
      default:
        break;
    }
  }

  async _handleTrajectoryFileSelected(file) {
    const mission = this.getActiveMission();
    if (!mission) return;
    try {
      const text = await file.text();
      const jsonDoc = JSON.parse(text);
      if (!jsonDoc || typeof jsonDoc !== 'object' || !Array.isArray(jsonDoc.trajectories)) {
        throw new Error('Invalid lwp-trajectory/1 JSON document.');
      }

      const oldDocId = mission.trajectory?.docId;
      const docId = `traj-${mission.id}-${Date.now()}`;
      await saveTrajectoryDoc(docId, jsonDoc);
      if (oldDocId && oldDocId !== docId) {
        deleteTrajectoryDoc(oldDocId);
      }

      mission.trajectory = {
        sourceType: 'uploaded',
        url: null,
        docId,
        fileName: file.name,
        visible: true,
        meta: mission.trajectory?.meta || null,
      };
      this._trajErrorMsg = '';
      this._trajStatusMsg = `Loaded ${file.name}`;
      this._touchMission(mission);
      this._persistState();
      this.render();

      if (typeof this.onLoadMissionTrajectory === 'function') {
        await this.onLoadMissionTrajectory(mission, {
          jsonDoc,
          syncFromMeta: true,
          overwriteSiteIfUnset: true,
        });
      }
    } catch (err) {
      this._trajErrorMsg = err?.message || 'Failed to parse trajectory JSON';
      this._trajStatusMsg = '';
      this.render();
    }
  }

  _syncNewMissionDraftFromDom() {
    const formEl = this.contentHostEl?.querySelector('[data-form="new-mission"]');
    if (!formEl) return;
    const prev = this._newMissionDraft || this._createEmptyNewMissionDraft();
    this._newMissionDraft = {
      name: formEl.querySelector('[data-field="new-mission-name"]')?.value ?? prev.name ?? '',
      landingDateLocal:
        formEl.querySelector('[data-field="new-mission-landing-date"]')?.value ??
        prev.landingDateLocal ??
        '',
      lat: formEl.querySelector('[data-field="new-mission-lat"]')?.value ?? prev.lat ?? '',
      lon: formEl.querySelector('[data-field="new-mission-lon"]')?.value ?? prev.lon ?? '',
      trajectoryType:
        formEl.querySelector('[data-field="new-mission-traj-type"]')?.value ??
        prev.trajectoryType ??
        'direct',
      dateMode:
        formEl.querySelector('[data-field="new-mission-date-mode"]')?.value ??
        prev.dateMode ??
        'arrival',
      spaceport:
        formEl.querySelector('[data-field="new-mission-spaceport"]')?.value ??
        prev.spaceport ??
        '',
      rocket:
        formEl.querySelector('[data-field="new-mission-rocket"]')?.value ?? prev.rocket ?? '',
      spacecraft:
        formEl.querySelector('[data-field="new-mission-spacecraft"]')?.value ??
        prev.spacecraft ??
        '',
      heightM:
        formEl.querySelector('[data-field="new-mission-height-m"]')?.value ?? prev.heightM ?? '',
      landingWindowMode:
        formEl.querySelector('[data-field="new-mission-landing-mode"]')?.value ??
        prev.landingWindowMode ??
        'flexible',
      requireSunVisible:
        formEl.querySelector('[data-field="new-mission-req-sun"]')?.checked ??
        Boolean(prev.requireSunVisible),
      sunElevationMinDeg:
        formEl.querySelector('[data-field="new-mission-sun-min"]')?.value ??
        prev.sunElevationMinDeg ??
        '0',
      sunElevationMaxDeg:
        formEl.querySelector('[data-field="new-mission-sun-max"]')?.value ??
        prev.sunElevationMaxDeg ??
        '90',
      requireEarthVisible:
        formEl.querySelector('[data-field="new-mission-req-earth"]')?.checked ??
        Boolean(prev.requireEarthVisible),
      maxWaitInOrbitH:
        formEl.querySelector('[data-field="new-mission-max-wait-h"]')?.value ??
        prev.maxWaitInOrbitH ??
        '48',
      noTerrain:
        formEl.querySelector('[data-field="new-mission-no-terrain"]')?.checked ??
        Boolean(prev.noTerrain),
      noCache:
        formEl.querySelector('[data-field="new-mission-no-cache"]')?.checked ??
        Boolean(prev.noCache),
      flightMode:
        formEl.querySelector('[data-field="new-mission-flight-mode"]')?.value ??
        prev.flightMode ??
        'fast',
      launchWindowMarginMs:
        formEl.querySelector('[data-field="new-mission-window-margin"]')?.value ??
        prev.launchWindowMarginMs ??
        '50',
      launchWindowRefine:
        formEl.querySelector('[data-field="new-mission-window-refine"]')?.checked ??
        (prev.launchWindowRefine !== false),
      notes: formEl.querySelector('[data-field="new-mission-notes"]')?.value ?? prev.notes ?? '',
    };
  }

  _resolveDraftLandingWindow(draft) {
    const mode = draft.landingWindowMode || 'flexible';
    if (mode !== 'custom') {
      return { mode };
    }
    const sunMin = Number.parseFloat(String(draft.sunElevationMinDeg ?? '0').trim());
    const sunMax = Number.parseFloat(String(draft.sunElevationMaxDeg ?? '90').trim());
    const maxWait = Number.parseFloat(String(draft.maxWaitInOrbitH ?? '48').trim());
    if (
      !Number.isFinite(sunMin) ||
      !Number.isFinite(sunMax) ||
      sunMin < -10 ||
      sunMax > 90 ||
      sunMin >= sunMax
    ) {
      throw new Error(
        'Sun elevation limits must satisfy -10° <= min < max <= 90°.'
      );
    }
    if (!Number.isFinite(maxWait) || maxWait < 0 || maxWait > 720) {
      throw new Error('Max orbit wait must be between 0 and 720 hours.');
    }
    return {
      mode: 'custom',
      requireSunVisible: Boolean(draft.requireSunVisible),
      sunElevationMinDeg: sunMin,
      sunElevationMaxDeg: sunMax,
      requireEarthVisible: Boolean(draft.requireEarthVisible),
      maxWaitInOrbitH: maxWait,
    };
  }

  async _handleCreateMissionSubmit(formEl) {
    if (this._isCreatingMission) return;
    this._syncNewMissionDraftFromDom();
    const draft = this._newMissionDraft;
    const rawName = (draft.name || '').trim();
    const name = rawName || `Mission #${this.missions.length + 1}`;
    const notes = (draft.notes || '').trim();

    const rawDate = (draft.landingDateLocal || '').trim();
    let inputDateIso = null;
    if (rawDate) {
      inputDateIso = parseDatetimeLocalUtc(rawDate);
      if (!inputDateIso) {
        this._newMissionFormError = 'Invalid landing date format.';
        this._newMissionErrorKind = null;
        this.render();
        return;
      }
    } else {
      const tlDate = this.getCurrentTimelineDate?.();
      inputDateIso =
        tlDate instanceof Date && !Number.isNaN(tlDate.getTime()) ? tlDate.toISOString() : null;
    }

    const rawLat = String(draft.lat ?? '').trim();
    const rawLon = String(draft.lon ?? '').trim();
    let landingSite = null;

    if (rawLat !== '' || rawLon !== '') {
      const lat = Number.parseFloat(rawLat);
      const lon = Number.parseFloat(rawLon);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        this._newMissionFormError = 'Latitude must be between -90° and +90°.';
        this._newMissionErrorKind = null;
        this.render();
        return;
      }
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        this._newMissionFormError = 'Longitude must be between -180° and +180°.';
        this._newMissionErrorKind = null;
        this.render();
        return;
      }
      landingSite = {
        name: `${name} Target`,
        lat,
        lon,
        note: notes,
      };
    }

    if (!inputDateIso && !landingSite) {
      this._newMissionFormError = 'Provide a landing date or landing site coordinates.';
      this._newMissionErrorKind = null;
      this.render();
      return;
    }

    const rawHeight = String(draft.heightM ?? '').trim();
    let heightM = null;
    if (rawHeight !== '') {
      heightM = Number.parseFloat(rawHeight);
      if (!Number.isFinite(heightM)) {
        this._newMissionFormError = 'Surface height override must be a valid number (meters).';
        this._newMissionErrorKind = null;
        this.render();
        return;
      }
    }

    let landingWindow = null;
    try {
      landingWindow = this._resolveDraftLandingWindow(draft);
    } catch (lwErr) {
      this._newMissionFormError = lwErr.message;
      this._newMissionErrorKind = null;
      this.render();
      return;
    }

    const flightMode =
      draft.flightMode === 'economy' || draft.flightMode === 'launch_window'
        ? draft.flightMode
        : 'fast';
    const dateMode =
      flightMode === 'launch_window'
        ? 'arrival'
        : draft.dateMode === 'launch'
          ? 'launch'
          : 'arrival';

    if (flightMode === 'launch_window' && !inputDateIso) {
      this._newMissionFormError = 'Launch window search requires a Landing Date (UTC).';
      this._newMissionErrorKind = null;
      this.render();
      return;
    }

    let launchWindowMarginMs = null;
    if (flightMode === 'launch_window') {
      const rawMargin = String(draft.launchWindowMarginMs ?? '').trim();
      if (rawMargin !== '') {
        const parsed = Number.parseFloat(rawMargin);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5000) {
          this._newMissionFormError = 'Launch window Δv margin must be between 0 and 5000 m/s.';
          this._newMissionErrorKind = null;
          this.render();
          return;
        }
        launchWindowMarginMs = parsed;
      }
    }

    const launchWindowRefine =
      flightMode === 'launch_window' ? draft.launchWindowRefine !== false : false;

    const genPayload = {
      dateMode,
      ...(inputDateIso
        ? dateMode === 'launch'
          ? { launchDateIso: inputDateIso }
          : { landingDateIso: inputDateIso }
        : {}),
      ...(landingSite ? { landingSite: { lat: landingSite.lat, lon: landingSite.lon } } : {}),
      advanced: {
        trajectory: draft.trajectoryType === 'hohmann' ? 'hohmann' : 'direct',
        flightMode,
        ...(flightMode === 'launch_window' && launchWindowMarginMs !== null
          ? { launchWindowMarginMs }
          : {}),
        ...(flightMode === 'launch_window' ? { launchWindowRefine } : {}),
        spaceport: draft.spaceport || null,
        rocket: draft.rocket || null,
        spacecraft: draft.spacecraft || null,
        heightM,
        landingWindow,
        noTerrain: Boolean(draft.noTerrain),
        noCache: Boolean(draft.noCache),
      },
    };

    const abortCtrl = new AbortController();
    this._newMissionFormError = '';
    this._newMissionErrorKind = null;
    this._isCreatingMission = true;
    this._createMissionAbort = abortCtrl;
    this._createMissionStatus =
      flightMode === 'economy'
        ? 'Submitting economy search (±3 days) to trajectory solver...'
        : flightMode === 'launch_window'
          ? 'Submitting launch window search to trajectory solver...'
          : 'Submitting mission to trajectory solver...';
    this.render();

    try {
      const result = await generateMissionTrajectory(genPayload, {
        signal: abortCtrl.signal,
        onProgress: (ev) => {
          if (ev?.message) {
            this._createMissionStatus = ev.message;
            const statusEl = this.contentHostEl?.querySelector('[data-field="create-mission-status"]');
            if (statusEl) statusEl.textContent = ev.message;
          }
        },
      });

      this._createMissionStatus = 'Saving generated trajectory...';
      const statusEl = this.contentHostEl?.querySelector('[data-field="create-mission-status"]');
      if (statusEl) statusEl.textContent = this._createMissionStatus;

      const missionId = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let docId = null;
      if (result.trajectory) {
        docId = `traj-${missionId}-${Date.now()}`;
        await saveTrajectoryDoc(docId, result.trajectory);
      }

      let flightLogDocId = null;
      if (result.log && typeof result.log === 'object') {
        flightLogDocId = `flog-${missionId}-${Date.now()}`;
        await saveTrajectoryDoc(flightLogDocId, result.log);
      }

      const schedule = extractScheduleFromGeneratedResult(result);
      const summarySection = result.summary?.summary || null;
      const resolvedLandingSite =
        landingSite ||
        (Number.isFinite(schedule.landingLatDeg) && Number.isFinite(schedule.landingLonDeg)
          ? {
              name: `${name} Target`,
              lat: schedule.landingLatDeg,
              lon: schedule.landingLonDeg,
              note: notes,
            }
          : null);

      const created = this.createMission({
        id: missionId,
        name,
        landingSite: resolvedLandingSite,
        launchDateIso: schedule.launchDateIso,
        landingDateIso: schedule.landingDateIso || (dateMode === 'arrival' ? inputDateIso : null),
        transitDurationSec: schedule.transitDurationSec,
        dateSource: 'trajectory',
        trajectory: docId
          ? {
              sourceType: 'uploaded',
              docId,
              fileName: `trajectory-${result.job.job_id}.json`,
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
        notes,
        generation: {
          jobId: result.job.job_id,
          flightLogDocId,
          outcome: result.job.outcome || 'done',
          elapsedS: result.job.elapsed_s ?? null,
          flightMode,
          launchWindowMarginMs: flightMode === 'launch_window' ? launchWindowMarginMs : null,
          launchWindowRefine: flightMode === 'launch_window' ? launchWindowRefine : null,
          deltaV: summarySection?.delta_v || null,
          economy: summarySection?.economy || null,
          launchWindow: summarySection?.launch_window || null,
          request: result.request,
          payload: genPayload,
          summaryStatus: summarySection?.status || null,
          generatedAt: new Date().toISOString(),
        },
      });

      this._isCreatingMission = false;
      this._createMissionStatus = '';
      this._createMissionAbort = null;
      this._isNewMissionFormOpen = false;
      this._isNewMissionAdvancedOpen = false;
      this._panelView = 'detail';
      this._detailTab = 'flight';
      this.setActiveMission(created.id, {
        reason: 'create',
        ...(result.trajectory ? { generatedDoc: result.trajectory } : {}),
        openTrajectoryView: Boolean(result.trajectory),
      });
      if (result.log && typeof result.log === 'object') {
        this.onFlightLogGenerated?.({
          mission: created,
          flightLog: result.log,
          filename: result.log.files?.flight_log || `flight-${result.job.job_id}.json`,
        });
      }
    } catch (err) {
      this._isCreatingMission = false;
      this._createMissionStatus = '';
      this._createMissionAbort = null;
      if (err?.name === 'AbortError') {
        this._newMissionFormError = 'Trajectory generation cancelled.';
        this._newMissionErrorKind = null;
      } else {
        const msg = err?.message || 'Failed to generate trajectory for mission.';
        this._newMissionFormError = msg;
        if (/no landing opportunity within max_wait_in_orbit_h|neither lighting nor earth|the sun is hidden|the earth is hidden/i.test(msg)) {
          this._newMissionErrorKind = 'landing_window';
        } else if (/landing site unsuitable/i.test(msg)) {
          this._newMissionErrorKind = 'terrain';
        } else {
          this._newMissionErrorKind = null;
        }
      }
      this.render();
    }
  }

  _handleTargetFormSubmit(formEl) {
    const nameEl = formEl.querySelector('[data-field="target-name"]');
    const latEl = formEl.querySelector('[data-field="target-lat"]');
    const lonEl = formEl.querySelector('[data-field="target-lon"]');
    const noteEl = formEl.querySelector('[data-field="target-note"]');

    const name = (nameEl?.value || '').trim();
    const lat = Number.parseFloat(latEl?.value);
    const lon = Number.parseFloat(lonEl?.value);
    const note = (noteEl?.value || '').trim();

    if (!name) {
      this._targetFormError = 'Enter landing target name.';
      this.render();
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      this._targetFormError = 'Latitude must be between -90° and +90°.';
      this.render();
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      this._targetFormError = 'Longitude must be between -180° and +180°.';
      this.render();
      return;
    }

    this._targetFormError = '';
    this._isTargetFormOpen = false;
    this.setActiveLandingSite({ name, lat, lon, note });
    if (typeof this.onFlyTo === 'function') {
      this.onFlyTo(lat, lon, 55);
    }
  }

  _handleAddPointSubmit(formEl) {
    const nameEl = formEl.querySelector('[data-field="point-name"]');
    const latEl = formEl.querySelector('[data-field="point-lat"]');
    const lonEl = formEl.querySelector('[data-field="point-lon"]');
    const noteEl = formEl.querySelector('[data-field="point-note"]');

    const name = (nameEl?.value || '').trim();
    const lat = Number.parseFloat(latEl?.value);
    const lon = Number.parseFloat(lonEl?.value);
    const note = (noteEl?.value || '').trim();

    if (!name) {
      this._pointFormError = 'Enter a point name.';
      this.render();
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      this._pointFormError = 'Latitude must be between -90° and +90°.';
      this.render();
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      this._pointFormError = 'Longitude must be between -180° and +180°.';
      this.render();
      return;
    }

    this._pointFormError = '';
    this._isAddPointFormOpen = false;
    const pt = this.addPointToActiveMission({ name, lat, lon, note });
    if (pt && typeof this.onFlyTo === 'function') {
      this.onFlyTo(pt.lat, pt.lon, 65);
    }
  }

  _commitRename(rawValue) {
    const mission = this.getActiveMission();
    const nextName = String(rawValue || '').trim();
    if (mission && nextName) {
      mission.name = nextName;
      this._touchMission(mission);
      this._persistState();
      this._notifyMissionChange({ reason: 'rename' });
    }
    this._isRenameOpen = false;
    this.render();
  }

  createMission(optionsOrName) {
    const opts = typeof optionsOrName === 'string' ? { name: optionsOrName } : optionsOrName || {};
    const mission = createMissionRecord(opts);
    this.missions.unshift(mission);
    this._persistState();
    return mission;
  }

  duplicateMission(missionId) {
    const source = this.missions.find((m) => m.id === missionId);
    if (!source) return null;
    const clone = normalizeMission({
      ...JSON.parse(JSON.stringify(source)),
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${source.name} (Copy)`,
      createdAt: new Date().toISOString(),
    });
    // Avoid sharing mutable uploaded docId ownership cleanly (if uploaded, keep read ref or copy)
    this.missions.unshift(clone);
    this._persistState();
    this._panelView = 'detail';
    this.setActiveMission(clone.id);
    return clone;
  }

  setActiveMission(missionId, notifyMeta = {}) {
    if (!this.missions.some((m) => m.id === missionId)) return;
    this.activeMissionId = missionId;
    this._presetSiteTab = this._categoryForMission(this.getActiveMission());
    this._selectedPresetSiteId = '';
    this._isRenameOpen = false;
    this._cancelActivePick();
    this._isTargetFormOpen = false;
    this._isAddPointFormOpen = false;
    this._trajStatusMsg = '';
    this._trajErrorMsg = '';
    if (!this._isRecalculatingTraj || this._recalcTrajMissionId !== missionId) {
      this._recalcTrajStatus = '';
      this._recalcTrajError = '';
    }
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'switch', ...notifyMeta });
  }

  _cancelActivePick(onlyTarget = null) {
    if (!this._activePickTarget) return;
    if (onlyTarget && this._activePickTarget !== onlyTarget) return;
    const prevTarget = this._activePickTarget;
    this._activePickTarget = null;
    this.onCancelPickOnMoon?.(prevTarget);
    this._updatePickButtonsDom();
  }

  _updatePickButtonsDom() {
    if (!this.contentHostEl) return;
    const buttons = this.contentHostEl.querySelectorAll('[data-m-action="pick-on-moon"]');
    for (const btn of buttons) {
      const isPicking = this._activePickTarget === btn.dataset.pickTarget;
      btn.classList.toggle('picking', isPicking);
      btn.classList.toggle('accent', !isPicking);
      const labelEl = btn.querySelector('[data-pick-label]');
      if (labelEl) {
        labelEl.textContent = isPicking ? 'CLICK ON MOON... (ESC)' : 'PICK ON MOON';
      }
    }
  }

  _startPickOnMoon(target) {
    if (!target || typeof this.onPickOnMoon !== 'function') return;
    if (this._activePickTarget === target) {
      this._cancelActivePick(target);
      return;
    }
    if (target === 'new-mission') {
      this._syncNewMissionDraftFromDom();
    }
    const labels = {
      'new-mission': 'Click on the Moon to set landing site coordinates',
      'target-form': 'Click on the Moon to set landing target coordinates',
      'point-form': 'Click on the Moon to set waypoint coordinates',
    };
    this._activePickTarget = target;
    this._updatePickButtonsDom();

    this.onPickOnMoon({
      targetKey: `mission-${target}`,
      label: labels[target] || 'Click on the Moon to pick coordinates',
      onPick: ({ lat, lon }) => {
        this._activePickTarget = null;
        if (target === 'new-mission') {
          this._newMissionDraft.lat = lat.toFixed(4);
          this._newMissionDraft.lon = lon.toFixed(4);
          this._selectedPresetSiteId = '';
          this._newMissionFormError = '';
          this.render();
        } else if (target === 'target-form') {
          const latEl = this.contentHostEl?.querySelector('[data-field="target-lat"]');
          const lonEl = this.contentHostEl?.querySelector('[data-field="target-lon"]');
          const nameEl = this.contentHostEl?.querySelector('[data-field="target-name"]');
          if (latEl) latEl.value = lat.toFixed(4);
          if (lonEl) lonEl.value = lon.toFixed(4);
          if (nameEl && !nameEl.value.trim()) {
            nameEl.value = `Landing Zone (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`;
          }
          this._targetFormError = '';
          this._updatePickButtonsDom();
        } else if (target === 'point-form') {
          const latEl = this.contentHostEl?.querySelector('[data-field="point-lat"]');
          const lonEl = this.contentHostEl?.querySelector('[data-field="point-lon"]');
          const nameEl = this.contentHostEl?.querySelector('[data-field="point-name"]');
          if (latEl) latEl.value = lat.toFixed(4);
          if (lonEl) lonEl.value = lon.toFixed(4);
          if (nameEl && !nameEl.value.trim()) {
            nameEl.value = `Point (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`;
          }
          this._pointFormError = '';
          this._updatePickButtonsDom();
        }
      },
      onCancel: () => {
        if (this._activePickTarget === target) {
          this._activePickTarget = null;
          this._updatePickButtonsDom();
        }
      },
    });
  }

  _renderPickMoonButtonHtml(targetKey, disabledAttr = '') {
    const isPicking = this._activePickTarget === targetKey;
    return `
      <button
        type="button"
        class="mission-mini-btn mission-pick-moon-btn ${isPicking ? 'picking' : 'accent'}"
        data-m-action="pick-on-moon"
        data-pick-target="${targetKey}"
        title="Select coordinates directly on the 3D Moon surface"
        ${disabledAttr}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="8" cy="8" r="5" />
          <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
        </svg>
        <span data-pick-label>${isPicking ? 'CLICK ON MOON... (ESC)' : 'PICK ON MOON'}</span>
      </button>
    `;
  }

  _findMissionForCatalogSite(site) {
    if (!site) return null;
    return (
      this.missions.find((m) => {
        if (m.modules?.siteId && m.modules.siteId === site.id) return true;
        if (
          m.landingSite &&
          Math.abs(m.landingSite.lat - site.lat) < 0.0005 &&
          Math.abs(m.landingSite.lon - site.lon) < 0.0005 &&
          m.name.toLowerCase().includes(site.name.toLowerCase().split('(')[0].trim())
        ) {
          return true;
        }
        return false;
      }) || null
    );
  }

  activateCatalogMission(siteId, { category = null, openDetail = false } = {}) {
    const site = this._findCatalogSiteById(siteId);
    if (!site) return null;

    const existing = this._findMissionForCatalogSite(site);
    const zoom = site.status === 'planned' ? 45 : 70;

    if (existing) {
      if (!existing.landingSite) {
        existing.landingSite = normalizeLandingSite({
          name: site.name,
          lat: site.lat,
          lon: site.lon,
          note: [site.region, site.agency, site.date].filter(Boolean).join(' · '),
          visible: true,
        });
      }
      if (openDetail) {
        this._panelView = 'detail';
        this._detailTab = 'flight';
      }
      this.setActiveMission(existing.id);
      this.onFlyTo?.(site.lat, site.lon, zoom);
      return existing;
    }

    const resolvedCategory =
      category && MISSION_CATEGORIES.includes(category)
        ? category
        : site.status === 'planned'
          ? 'future'
          : site.status === 'custom'
            ? 'custom'
            : 'historical';
    const landingDateIso = parseCatalogSiteDateIso(site.date);

    const created = this.createMission({
      name: site.name,
      category: resolvedCategory,
      landingSite: {
        name: site.name,
        lat: site.lat,
        lon: site.lon,
        note: [site.region, site.agency, site.date].filter(Boolean).join(' · '),
        visible: true,
      },
      landingDateIso,
      dateSource: landingDateIso ? 'manual' : 'unset',
      notes: site.description || '',
      siteMeta: {
        siteId: site.id,
        siteStatus: site.status || (resolvedCategory === 'future' ? 'planned' : resolvedCategory === 'historical' ? 'landed' : 'custom'),
        program: site.program || '',
        agency: site.agency || '',
        region: site.region || '',
      },
    });

    if (openDetail) {
      this._panelView = 'detail';
      this._detailTab = 'flight';
    }
    this.setActiveMission(created.id, { reason: 'create' });
    this.onFlyTo?.(site.lat, site.lon, zoom);
    return created;
  }

  deleteMission(missionId) {
    if (this.missions.length <= 1) return;
    if (this._recalcTrajMissionId === missionId && this._isRecalculatingTraj) {
      this.cancelTrajectoryRecalculation();
    }
    const target = this.missions.find((m) => m.id === missionId);
    if (target?.trajectory?.docId) {
      const stillReferenced = this.missions.some(
        (m) => m.id !== missionId && m.trajectory?.docId === target.trajectory.docId
      );
      if (!stillReferenced) {
        deleteTrajectoryDoc(target.trajectory.docId);
      }
    }
    const targetLogDocId = target?.modules?.generation?.flightLogDocId;
    if (targetLogDocId) {
      const stillReferencedLog = this.missions.some(
        (m) => m.id !== missionId && m.modules?.generation?.flightLogDocId === targetLogDocId
      );
      if (!stillReferencedLog) {
        deleteTrajectoryDoc(targetLogDocId);
      }
    }
    this.missions = this.missions.filter((m) => m.id !== missionId);
    const switchedActive = this.activeMissionId === missionId;
    if (switchedActive) {
      this.activeMissionId = this.missions[0].id;
    }
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: switchedActive ? 'switch' : 'delete' });
  }

  setActiveLandingSite({ name, lat, lon, note = '' }, { recalculate = true } = {}) {
    const mission = this.getActiveMission();
    if (!mission) return null;
    const normalized = normalizeLandingSite({ name, lat, lon, note, visible: true });
    if (!normalized) return null;
    mission.landingSite = normalized;
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'target-updated' });
    if (recalculate !== false) {
      this._recalculateTrajectoryForMission(mission);
    }
    return mission.landingSite;
  }

  cancelTrajectoryRecalculation() {
    if (!this._isRecalculatingTraj) return;
    this._recalcTrajAbort?.abort();
    this._recalcTrajAbort = null;
    this._isRecalculatingTraj = false;
    this._recalcTrajStatus = '';
    this._recalcTrajError = 'Trajectory recalculation cancelled.';
    this._trajStatusMsg = '';
    this._trajErrorMsg = 'Trajectory recalculation cancelled.';
    this.render();
  }

  async _recalculateTrajectoryForMission(
    mission,
    { flightMode = null, launchWindowMarginMs = undefined, launchWindowRefine = undefined } = {}
  ) {
    if (!mission?.landingSite) return;

    if (this._recalcTrajAbort) {
      this._recalcTrajAbort.abort();
      this._recalcTrajAbort = null;
    }

    const seq = ++this._recalcTrajSeq;
    const tlDate = this.getCurrentTimelineDate?.();
    const fallbackDateIso =
      tlDate instanceof Date && !Number.isNaN(tlDate.getTime())
        ? tlDate.toISOString()
        : new Date().toISOString();

    const genPayload = buildTrajectoryRecalcPayload(mission, {
      fallbackDateIso,
      flightMode,
      launchWindowMarginMs,
      launchWindowRefine,
    });
    if (!genPayload) return;

    const activeMode = genPayload.advanced?.flightMode || 'fast';
    const abortCtrl = new AbortController();
    this._recalcTrajAbort = abortCtrl;
    this._isRecalculatingTraj = true;
    this._recalcTrajMissionId = mission.id;
    this._recalcTrajStatus =
      activeMode === 'economy'
        ? 'Searching economy trajectory (±3 days)...'
        : activeMode === 'launch_window'
          ? 'Searching launch window on landing day...'
          : 'Recalculating trajectory for target...';
    this._recalcTrajError = '';
    this._trajStatusMsg = this._recalcTrajStatus;
    this._trajErrorMsg = '';
    this.render();

    try {
      const result = await generateMissionTrajectory(genPayload, {
        signal: abortCtrl.signal,
        onProgress: (ev) => {
          if (seq !== this._recalcTrajSeq || abortCtrl.signal.aborted) return;
          if (ev?.message) {
            this._recalcTrajStatus = ev.message;
            this._trajStatusMsg = ev.message;
            const statusEl = this.contentHostEl?.querySelector('[data-field="recalc-traj-status"]');
            if (statusEl) statusEl.textContent = ev.message;
            const trajStatusEl = this.contentHostEl?.querySelector('[data-field="traj-status-msg"]');
            if (trajStatusEl) trajStatusEl.textContent = ev.message;
          }
        },
      });

      if (seq !== this._recalcTrajSeq || abortCtrl.signal.aborted) return;

      const targetMission = this.missions.find((m) => m.id === mission.id);
      if (!targetMission) return;

      let docId = null;
      if (result.trajectory) {
        docId = `traj-${targetMission.id}-${Date.now()}`;
        await saveTrajectoryDoc(docId, result.trajectory);
        if (seq !== this._recalcTrajSeq || abortCtrl.signal.aborted) {
          deleteTrajectoryDoc(docId);
          return;
        }
      }

      let flightLogDocId = null;
      if (result.log && typeof result.log === 'object') {
        flightLogDocId = `flog-${targetMission.id}-${Date.now()}`;
        await saveTrajectoryDoc(flightLogDocId, result.log);
        if (seq !== this._recalcTrajSeq || abortCtrl.signal.aborted) {
          if (docId) deleteTrajectoryDoc(docId);
          deleteTrajectoryDoc(flightLogDocId);
          return;
        }
      }

      const oldDocId = targetMission.trajectory?.docId;
      if (oldDocId && oldDocId !== docId) {
        const stillReferenced = this.missions.some(
          (m) => m.id !== targetMission.id && m.trajectory?.docId === oldDocId
        );
        if (!stillReferenced) {
          deleteTrajectoryDoc(oldDocId);
        }
      }
      const oldFlightLogDocId = targetMission.modules?.generation?.flightLogDocId;
      if (oldFlightLogDocId && oldFlightLogDocId !== flightLogDocId) {
        const stillReferencedLog = this.missions.some(
          (m) => m.id !== targetMission.id && m.modules?.generation?.flightLogDocId === oldFlightLogDocId
        );
        if (!stillReferencedLog) {
          deleteTrajectoryDoc(oldFlightLogDocId);
        }
      }

      const schedule = extractScheduleFromGeneratedResult(result);
      const summarySection = result.summary?.summary || null;
      targetMission.trajectory = docId
        ? {
            sourceType: 'uploaded',
            url: null,
            docId,
            fileName: `trajectory-${result.job.job_id}.json`,
            visible: targetMission.trajectory?.visible !== false,
            meta: null,
          }
        : {
            sourceType: 'none',
            url: null,
            docId: null,
            fileName: null,
            visible: true,
            meta: null,
          };
      targetMission.flight = {
        launchDateIso: schedule.launchDateIso || targetMission.flight?.launchDateIso || null,
        landingDateIso: schedule.landingDateIso || targetMission.flight?.landingDateIso || null,
        transitDurationSec:
          schedule.transitDurationSec ?? targetMission.flight?.transitDurationSec ?? null,
        dateSource: 'trajectory',
      };
      if (!targetMission.modules || typeof targetMission.modules !== 'object') {
        targetMission.modules = { notes: '' };
      }
      targetMission.modules.generation = {
        jobId: result.job.job_id,
        flightLogDocId,
        outcome: result.job.outcome || 'done',
        elapsedS: result.job.elapsed_s ?? null,
        flightMode: activeMode,
        launchWindowMarginMs:
          activeMode === 'launch_window'
            ? genPayload.advanced?.launchWindowMarginMs ?? null
            : null,
        launchWindowRefine:
          activeMode === 'launch_window'
            ? Boolean(genPayload.advanced?.launchWindowRefine)
            : null,
        deltaV: summarySection?.delta_v || null,
        economy: summarySection?.economy || null,
        launchWindow: summarySection?.launch_window || null,
        request: result.request,
        payload: genPayload,
        summaryStatus: summarySection?.status || null,
        generatedAt: new Date().toISOString(),
      };
      this._solverUiMissionId = targetMission.id;
      this._solverUiMode = activeMode;

      this._isRecalculatingTraj = false;
      this._recalcTrajAbort = null;
      this._recalcTrajStatus = '';
      this._recalcTrajError = '';
      this._trajStatusMsg =
        activeMode === 'launch_window'
          ? `Launch window ready (${result.job.job_id}).`
          : activeMode === 'economy'
            ? `Economy search ready (${result.job.job_id}).`
            : `Trajectory recalculated (${result.job.job_id}).`;
      this._trajErrorMsg = '';
      this._touchMission(targetMission);
      this._persistState();
      this.render();

      if (
        targetMission.id === this.activeMissionId &&
        typeof this.onLoadMissionTrajectory === 'function'
      ) {
        if (result.trajectory) {
          await this.onLoadMissionTrajectory(targetMission, {
            jsonDoc: result.trajectory,
            syncFromMeta: true,
            overwriteSiteIfUnset: false,
            forceReload: true,
          });
        } else {
          await this.onLoadMissionTrajectory(targetMission);
        }
      }
      if (result.log && typeof result.log === 'object') {
        this.onFlightLogGenerated?.({
          mission: targetMission,
          flightLog: result.log,
          filename: result.log.files?.flight_log || `flight-${result.job.job_id}.json`,
        });
      }
    } catch (err) {
      if (seq !== this._recalcTrajSeq) return;
      this._isRecalculatingTraj = false;
      this._recalcTrajAbort = null;
      this._recalcTrajStatus = '';
      if (err?.name === 'AbortError') {
        return;
      }
      const msg = err?.message || 'Failed to recalculate trajectory for new target.';
      this._recalcTrajError = msg;
      this._trajStatusMsg = '';
      this._trajErrorMsg = msg;
      this.render();
    }
  }

  updateActiveFlightDates({ launchDateIso = undefined, landingDateIso = undefined, dateSource = undefined }) {
    const mission = this.getActiveMission();
    if (!mission) return;
    if (launchDateIso !== undefined) {
      mission.flight.launchDateIso = launchDateIso;
    }
    if (landingDateIso !== undefined) {
      mission.flight.landingDateIso = landingDateIso;
    }
    if (dateSource !== undefined) {
      mission.flight.dateSource = dateSource;
    }
    const computed = computeTransitDurationSec(
      mission.flight.launchDateIso,
      mission.flight.landingDateIso
    );
    if (computed !== null) {
      mission.flight.transitDurationSec = computed;
    }
    const savedPayload = mission.modules?.generation?.payload;
    if (savedPayload && typeof savedPayload === 'object') {
      if (launchDateIso !== undefined) savedPayload.launchDateIso = mission.flight.launchDateIso;
      if (landingDateIso !== undefined) savedPayload.landingDateIso = mission.flight.landingDateIso;
    }
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._notifyMissionChange({ reason: 'dates-updated' });
  }

  updateActiveTransitDuration(durationSec) {
    const mission = this.getActiveMission();
    if (!mission || !Number.isFinite(durationSec) || durationSec < 0) return;
    const cleanSec = Math.round(durationSec);
    mission.flight.transitDurationSec = cleanSec;
    if (mission.flight.landingDateIso) {
      const landingMs = Date.parse(mission.flight.landingDateIso);
      if (Number.isFinite(landingMs)) {
        mission.flight.launchDateIso = new Date(landingMs - cleanSec * 1000).toISOString();
      }
    } else if (mission.flight.launchDateIso) {
      const launchMs = Date.parse(mission.flight.launchDateIso);
      if (Number.isFinite(launchMs)) {
        mission.flight.landingDateIso = new Date(launchMs + cleanSec * 1000).toISOString();
      }
    }
    const savedPayload = mission.modules?.generation?.payload;
    if (savedPayload && typeof savedPayload === 'object') {
      savedPayload.launchDateIso = mission.flight.launchDateIso;
      savedPayload.landingDateIso = mission.flight.landingDateIso;
    }
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._notifyMissionChange({ reason: 'transit-updated' });
  }

  hydrateMissionTrajectoryInfo(missionId, trajInfo, { syncDates = false, overwriteSiteIfUnset = false } = {}) {
    const mission = this.missions.find((m) => m.id === missionId);
    if (!mission) return;
    if (!trajInfo) {
      if (mission.trajectory) {
        mission.trajectory.meta = null;
      }
      this._persistState();
      if (mission.id === this.activeMissionId) {
        this.render();
        this._notifyMissionChange({ reason: 'traj-hydrated' });
      }
      return;
    }

    const meta = extractTrajectoryMeta(trajInfo);
    mission.trajectory.meta = meta;

    if (syncDates && meta) {
      this.applyTrajectoryMetaToMission(mission, meta, {
        overwriteSite: overwriteSiteIfUnset && !mission.landingSite,
        silent: true,
      });
    } else {
      this._persistState();
    }

    if (mission.id === this.activeMissionId) {
      this.render();
      this._rebuildGlobeObjects();
      this._notifyMissionChange({ reason: 'traj-hydrated' });
    }
  }

  applyTrajectoryMetaToMission(mission, meta, { overwriteSite = false, silent = false } = {}) {
    if (!mission || !meta) return;
    if (meta.launchUtc && Number.isFinite(Date.parse(meta.launchUtc))) {
      mission.flight.launchDateIso = new Date(Date.parse(meta.launchUtc)).toISOString();
    }
    if (meta.touchdownUtc && Number.isFinite(Date.parse(meta.touchdownUtc))) {
      mission.flight.landingDateIso = new Date(Date.parse(meta.touchdownUtc)).toISOString();
    }
    if (Number.isFinite(meta.durationSec)) {
      mission.flight.transitDurationSec = Math.round(meta.durationSec);
    }
    mission.flight.dateSource = 'trajectory';

    if (
      overwriteSite &&
      Number.isFinite(meta.landingLatDeg) &&
      Number.isFinite(meta.landingLonDeg)
    ) {
      mission.landingSite = normalizeLandingSite({
        name: mission.landingSite?.name || 'Trajectory Touchdown Site',
        lat: meta.landingLatDeg,
        lon: meta.landingLonDeg,
        note: `${meta.rocket || 'Vehicle'} · ${meta.spaceportName || ''}`.trim(),
        visible: true,
      });
    }

    this._touchMission(mission);
    this._persistState();
    if (!silent) {
      this.render();
      this._rebuildGlobeObjects();
      this._notifyMissionChange({ reason: 'traj-synced' });
    }
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
      createdAt: new Date().toISOString(),
      visible: true,
    };

    mission.points.unshift(point);
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'point-added' });
    return point;
  }

  togglePointVisibility(pointId) {
    const mission = this.getActiveMission();
    const pt = mission?.points.find((p) => p.id === pointId);
    if (!pt) return;
    pt.visible = pt.visible === false;
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
  }

  removePointFromActiveMission(pointId) {
    const mission = this.getActiveMission();
    if (!mission) return;
    mission.points = mission.points.filter((p) => p.id !== pointId);
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'point-removed' });
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
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'ruler-saved' });
    return meas;
  }

  toggleMeasurementVisibility(measId) {
    const mission = this.getActiveMission();
    const meas = mission?.measurements.find((m) => m.id === measId);
    if (!meas) return;
    meas.visible = meas.visible === false;
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
  }

  removeMeasurementFromActiveMission(measId) {
    const mission = this.getActiveMission();
    if (!mission) return;
    mission.measurements = mission.measurements.filter((m) => m.id !== measId);
    this._touchMission(mission);
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'ruler-removed' });
  }

  setSaveRulerEnabled(canSave) {
    this._canSaveRuler = Boolean(canSave);
    const btn = this.contentHostEl?.querySelector('[data-m-action="save-ruler"]');
    if (btn) {
      btn.disabled = !this._canSaveRuler;
    }
  }

  _getMissionCatalogEntries(category) {
    const cat = MISSION_CATEGORIES.includes(category) ? category : 'custom';
    const userMissions = this.missions.filter((m) => this._categoryForMission(m) === cat);
    const entries = userMissions.map((m) => ({
      kind: 'mission',
      category: cat,
      mission: m,
    }));

    const catalogSites = this._getPresetSitesForCategory(cat);
    for (const site of catalogSites) {
      if (!this._findMissionForCatalogSite(site)) {
        entries.push({
          kind: 'catalog',
          category: cat,
          site,
        });
      }
    }
    return entries;
  }

  _getFilteredMissions(category = this._listTab) {
    const entries = this._getMissionCatalogEntries(category);
    const q = this._listSearchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => {
      const hay =
        entry.kind === 'mission'
          ? [
              entry.mission.name,
              entry.mission.landingSite?.name,
              entry.mission.modules?.region,
              entry.mission.modules?.program,
              entry.mission.trajectory?.meta?.rocket,
              entry.mission.trajectory?.fileName,
              entry.mission.modules?.notes,
            ]
          : [
              entry.site.name,
              entry.site.region,
              entry.site.program,
              entry.site.agency,
              entry.site.date,
              entry.site.description,
            ];
      return hay.filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }

  _renderCategoryTabsHtml({ actionName, activeTab, includeCounts = true }) {
    const esc = MissionPanel.escapeHtml;
    const tabs = [
      { id: 'historical', label: 'HISTORICAL' },
      { id: 'custom', label: 'CUSTOM' },
      { id: 'future', label: 'FUTURE' },
    ];
    return `
      <div class="mission-subtabs mission-cat-tabs" role="tablist">
        ${tabs
          .map((t) => {
            const count = includeCounts ? ` (${this._getMissionCatalogEntries(t.id).length})` : '';
            const isActive = activeTab === t.id;
            return `
              <button
                type="button"
                class="mission-subtab-btn ${isActive ? 'active' : ''}"
                data-m-action="${esc(actionName)}"
                data-list-tab="${t.id}"
                role="tab"
                aria-selected="${isActive ? 'true' : 'false'}"
              >${esc(t.label + count)}</button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  _renderPresetPickerHtml({ selectField, selectedSiteId = '' }) {
    const esc = MissionPanel.escapeHtml;
    const activeTab = MISSION_CATEGORIES.includes(this._presetSiteTab) ? this._presetSiteTab : 'historical';
    const sites = this._getPresetSitesForCategory(activeTab);
    const tabs = [
      { id: 'historical', label: 'HISTORICAL' },
      { id: 'custom', label: 'CUSTOM' },
      { id: 'future', label: 'FUTURE' },
    ];
    return `
      <div class="mission-preset-box">
        <div class="mission-preset-head">
          <span class="mission-field-label">PULL LANDING SITE</span>
          <div class="mission-preset-pills">
            ${tabs
              .map(
                (t) => `
              <button
                type="button"
                class="mission-preset-pill ${activeTab === t.id ? 'active' : ''}"
                data-m-action="switch-preset-tab"
                data-preset-tab="${t.id}"
              >${esc(t.label)}</button>
            `
              )
              .join('')}
          </div>
        </div>
        <select class="hud-input mission-select" data-field="${esc(selectField)}">
          <option value="">${sites.length > 0 ? `Select ${activeTab} landing site (${sites.length})...` : `No ${activeTab} sites saved yet`}</option>
          ${sites
            .map((s) => {
              const sel = selectedSiteId === s.id ? 'selected' : '';
              return `<option value="${esc(s.id)}" ${sel}>${esc(s.name)} — ${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}°</option>`;
            })
            .join('')}
        </select>
      </div>
    `;
  }

  _renderMissionCardsHtml() {
    const esc = MissionPanel.escapeHtml;
    const activeCat = MISSION_CATEGORIES.includes(this._listTab) ? this._listTab : 'custom';
    const filtered = this._getFilteredMissions(activeCat);

    if (filtered.length === 0) {
      if (activeCat === 'custom' && !this._listSearchQuery.trim()) {
        return `
          <div class="mission-empty-box">
            No custom missions yet. Click <strong>+ NEW MISSION</strong> above or save a custom landing site to pull its coordinates here.
          </div>
        `;
      }
      return `<div class="mission-empty-box">No ${esc(activeCat)} missions match "${esc(this._listSearchQuery)}".</div>`;
    }

    return filtered
      .map((entry) => {
        if (entry.kind === 'catalog') {
          const s = entry.site;
          const coordLabel = `${s.name} (${formatCoords(s.lat, s.lon)})`;
          const tagLabel = [s.program, s.agency].filter(Boolean).join(' · ') || activeCat.toUpperCase();
          return `
            <div class="mission-list-card catalog-card" data-catalog-site-id="${esc(s.id)}" data-site-category="${esc(activeCat)}">
              <div class="mission-card-top">
                <div class="mission-card-title-wrap">
                  <span class="mission-status-dot catalog-${esc(activeCat)}" aria-hidden="true"></span>
                  <span class="mission-card-name">${esc(s.name)}</span>
                </div>
                <div class="mission-card-actions">
                  <button type="button" class="mission-mini-btn accent" data-m-action="activate-catalog-mission" data-site-id="${esc(s.id)}" data-site-category="${esc(activeCat)}" title="Activate mission &amp; pull landing site">SET</button>
                  <button type="button" class="mission-mini-btn" data-m-action="open-catalog-mission" data-site-id="${esc(s.id)}" data-site-category="${esc(activeCat)}" title="Activate mission &amp; open workspace">OPEN</button>
                </div>
              </div>

              <div class="mission-card-grid">
                <div class="mission-kv">
                  <span class="mission-kv-k">LANDING SITE</span>
                  <span class="mission-kv-v val-nominal">${esc(coordLabel)}</span>
                </div>
                <div class="mission-kv">
                  <span class="mission-kv-k">DATE / WINDOW</span>
                  <span class="mission-kv-v">${esc(s.date || 'Custom')}</span>
                </div>
                <div class="mission-kv">
                  <span class="mission-kv-k">REGION</span>
                  <span class="mission-kv-v">${esc(s.region || 'Lunar Surface')}</span>
                </div>
                <div class="mission-kv">
                  <span class="mission-kv-k">PROGRAM</span>
                  <span class="mission-kv-v val-accent">${esc(tagLabel)}</span>
                </div>
              </div>
            </div>
          `;
        }

        const m = entry.mission;
        const isActive = m.id === this.activeMissionId;
        const targetLabel = m.landingSite
          ? `${m.landingSite.name} (${formatCoords(m.landingSite.lat, m.landingSite.lon)})`
          : 'UNSET';
        const landingStr = formatUtcCompact(m.flight?.landingDateIso);
        const transitSec = m.flight?.transitDurationSec ?? m.trajectory?.meta?.durationSec ?? null;
        const transitStr = formatTransitDuration(transitSec);
        const hasTraj = m.trajectory?.sourceType && m.trajectory.sourceType !== 'none';
        const trajLabel = hasTraj
          ? m.trajectory?.meta?.rocket || m.trajectory?.fileName || 'JSON'
          : 'NO TRAJ';

        return `
          <div class="mission-list-card ${isActive ? 'active' : ''}" data-mission-card-id="${esc(m.id)}">
            <div class="mission-card-top">
              <div class="mission-card-title-wrap">
                <span class="mission-status-dot ${isActive ? 'active' : ''}" aria-hidden="true"></span>
                <span class="mission-card-name">${esc(m.name)}</span>
              </div>
              <div class="mission-card-actions">
                ${
                  isActive
                    ? `<span class="mission-active-pill">ACTIVE</span>`
                    : `<button type="button" class="mission-mini-btn accent" data-m-action="activate-mission" data-mission-id="${esc(m.id)}" title="Set active mission">SET</button>`
                }
                <button type="button" class="mission-mini-btn" data-m-action="open-mission-detail" data-mission-id="${esc(m.id)}" title="Open mission workspace">OPEN</button>
                <button type="button" class="mission-mini-btn danger" data-m-action="delete-mission" data-mission-id="${esc(m.id)}" title="Delete mission" ${this.missions.length <= 1 ? 'disabled' : ''}>×</button>
              </div>
            </div>

            <div class="mission-card-grid">
              <div class="mission-kv">
                <span class="mission-kv-k">TARGET</span>
                <span class="mission-kv-v ${m.landingSite ? 'val-nominal' : 'val-muted'}">${esc(targetLabel)}</span>
              </div>
              <div class="mission-kv">
                <span class="mission-kv-k">LANDING UTC</span>
                <span class="mission-kv-v">${esc(landingStr)}</span>
              </div>
              <div class="mission-kv">
                <span class="mission-kv-k">TRANSIT</span>
                <span class="mission-kv-v">${esc(transitStr)}</span>
              </div>
              <div class="mission-kv">
                <span class="mission-kv-k">TRAJECTORY</span>
                <span class="mission-kv-v ${hasTraj ? 'val-accent' : 'val-muted'}">${esc(trajLabel)}</span>
              </div>
            </div>

            <div class="mission-card-foot">
              <span class="mission-foot-chip">SURFACE ${m.points.length + m.measurements.length} (${m.points.length} PT · ${m.measurements.length} RTE)</span>
              ${
                resolveMissionFlightMode(m) === 'economy'
                  ? `<span class="mission-foot-chip eco">ECO</span>`
                  : resolveMissionFlightMode(m) === 'launch_window'
                    ? `<span class="mission-foot-chip win">WIN</span>`
                    : ''
              }
              <button type="button" class="mission-foot-link" data-m-action="duplicate-mission" data-mission-id="${esc(m.id)}">CLONE</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  _renderMissionCardsOnly() {
    const listEl = this.contentHostEl.querySelector('[data-field="missions-list"]');
    if (listEl) {
      listEl.innerHTML = this._renderMissionCardsHtml();
    }
  }

  _sectionArrowHtml(sectionId, label = 'Collapse / Expand section') {
    const isCollapsed = this._collapsedSections.has(sectionId);
    const esc = MissionPanel.escapeHtml;
    return `<button type="button" class="section-arrow-btn ${isCollapsed ? 'collapsed' : ''}" data-m-action="toggle-section" data-section-id="${esc(sectionId)}" title="${esc(label)}" aria-expanded="${isCollapsed ? 'false' : 'true'}"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6l4 4 4-4" /></svg></button>`;
  }

  _renderListView() {
    const esc = MissionPanel.escapeHtml;
    const newFormClass = this._isNewMissionFormOpen ? 'visible' : '';
    const isListCollapsed = this._collapsedSections.has('missions-list');
    const draft = this._newMissionDraft || this._createEmptyNewMissionDraft();
    const busyAttr = this._isCreatingMission ? 'disabled' : '';

    const catalog = this._trajCatalog;
    const spaceports = catalog?.spaceports || [];
    const rockets = catalog?.rockets || [];
    const spacecraft = catalog?.spacecraft || [];

    const spaceportOptionsHtml = spaceports
      .map((sp) => {
        const selected = draft.spaceport === sp.id ? 'selected' : '';
        return `<option value="${esc(sp.id)}" ${selected}>${esc(sp.name || sp.id)} (${esc(sp.id)})</option>`;
      })
      .join('');

    const rocketOptionsHtml = rockets
      .map((rk) => {
        const label = rk.resolved?.config?.name || rk.id;
        const selected = draft.rocket === rk.id ? 'selected' : '';
        return `<option value="${esc(rk.id)}" ${selected}>${esc(label)}</option>`;
      })
      .join('');

    const spacecraftOptionsHtml = spacecraft
      .map((sc) => {
        const label = sc.resolved?.config?.name || sc.id;
        const selected = draft.spacecraft === sc.id ? 'selected' : '';
        return `<option value="${esc(sc.id)}" ${selected}>${esc(label)}</option>`;
      })
      .join('');

    let solverStateBadge = 'CHECKING...';
    let solverBadgeClass = '';
    if (catalog) {
      if (catalog.available) {
        solverStateBadge = 'LWP-API/1 READY';
        solverBadgeClass = 'nominal';
      } else {
        solverStateBadge = 'CATALOG ONLY (BUILD RUST BIN)';
        solverBadgeClass = 'warn';
      }
    } else if (!this._isCatalogLoading) {
      solverStateBadge = 'API OFFLINE';
      solverBadgeClass = 'warn';
    }

    return `
      <div class="mission-header-row">
        <span class="mission-title-label">MISSIONS (${this.missions.length})</span>
        <div class="mission-block-actions">
          <button type="button" class="mission-new-btn" data-m-action="toggle-new-mission">+ NEW MISSION</button>
          ${this._sectionArrowHtml('missions-list', 'Collapse / Expand Missions List')}
        </div>
      </div>

      <div class="mission-section-body ${isListCollapsed ? 'collapsed' : ''}" style="${isListCollapsed ? '' : 'display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;'}">
      <form class="mission-add-form ${newFormClass}" data-form="new-mission">
        <div class="mission-form-title">CREATE MISSION</div>

        <div class="mission-field-group">
          <span class="mission-field-label">MISSION NAME</span>
          <input
            type="text"
            class="hud-input"
            data-field="new-mission-name"
            placeholder="Mission name (e.g. Artemis IV — Shackleton)"
            value="${esc(draft.name)}"
            maxlength="60"
            ${busyAttr}
          />
        </div>

        <div class="mission-field-group">
          <span class="mission-field-label">${
            draft.flightMode === 'launch_window' || draft.dateMode !== 'launch'
              ? 'LANDING DATE (UTC)'
              : 'LAUNCH DATE (UTC)'
          }</span>
          <input
            type="datetime-local"
            class="hud-input mission-datetime-input"
            data-field="new-mission-landing-date"
            value="${esc(draft.landingDateLocal)}"
            ${busyAttr}
          />
        </div>

        <div class="mission-field-group">
          ${this._renderPresetPickerHtml({ selectField: 'new-mission-site-preset', selectedSiteId: this._selectedPresetSiteId || '' })}
        </div>

        <div class="mission-field-group">
          <span class="mission-field-label">LANDING SITE COORDINATES</span>
          <div class="mission-coord-grid">
            <input
              type="number"
              step="0.00001"
              min="-90"
              max="90"
              class="hud-input"
              data-field="new-mission-lat"
              placeholder="Lat (-90..90)"
              value="${esc(draft.lat)}"
              ${busyAttr}
            />
            <input
              type="number"
              step="0.00001"
              min="-180"
              max="180"
              class="hud-input"
              data-field="new-mission-lon"
              placeholder="Lon (-180..180)"
              value="${esc(draft.lon)}"
              ${busyAttr}
            />
          </div>
          ${this._renderPickMoonButtonHtml('new-mission', busyAttr)}
        </div>

        <div class="mission-field-group">
          <span class="mission-field-label">FLIGHT MODE</span>
          <input type="hidden" data-field="new-mission-flight-mode" value="${esc(draft.flightMode || 'fast')}" />
          <div class="mission-mode-pills">
            <button type="button" class="mission-mode-pill ${(draft.flightMode || 'fast') === 'fast' ? 'active' : ''}" data-m-action="set-draft-flight-mode" data-flight-mode="fast" ${busyAttr}>FAST</button>
            <button type="button" class="mission-mode-pill ${draft.flightMode === 'economy' ? 'active eco' : ''}" data-m-action="set-draft-flight-mode" data-flight-mode="economy" ${busyAttr}>ECONOMY</button>
            <button type="button" class="mission-mode-pill ${draft.flightMode === 'launch_window' ? 'active win' : ''}" data-m-action="set-draft-flight-mode" data-flight-mode="launch_window" ${busyAttr}>WINDOW</button>
          </div>
          <div class="mission-mode-hint">${
            draft.flightMode === 'economy'
              ? 'Economy: searches ±3 days for lowest total mission Δv (TLI + LOI + descent).'
              : draft.flightMode === 'launch_window'
                ? 'Launch Window: finds all launch times landing on the target UTC day within Δv margin.'
                : 'Fast: best transfer within the requested UTC day.'
          }</div>
        </div>

        ${
          draft.flightMode === 'launch_window'
            ? `
          <div class="mission-window-opts">
            <div class="mission-field-group">
              <span class="mission-field-label">WINDOW ΔV MARGIN (M/S)</span>
              <input
                type="number"
                step="1"
                min="0"
                max="5000"
                class="hud-input"
                data-field="new-mission-window-margin"
                placeholder="50"
                value="${esc(draft.launchWindowMarginMs ?? '50')}"
                ${busyAttr}
              />
            </div>
            <label class="mission-check-row">
              <input type="checkbox" data-field="new-mission-window-refine" ${draft.launchWindowRefine !== false ? 'checked' : ''} ${busyAttr} />
              <span>Refine optimum launch for 3D orbit path</span>
            </label>
          </div>
        `
            : ''
        }

        <div class="mission-advanced-box">
          <button
            type="button"
            class="mission-advanced-toggle ${this._isNewMissionAdvancedOpen ? 'open' : ''}"
            data-m-action="toggle-new-mission-advanced"
            aria-expanded="${this._isNewMissionAdvancedOpen ? 'true' : 'false'}"
          >
            <span>ADVANCED</span>
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <div class="mission-advanced-body ${this._isNewMissionAdvancedOpen ? 'open' : ''}">
            <div class="mission-solver-row">
              <span class="mission-field-label">TRAJECTORY SOLVER</span>
              <span class="mission-source-chip ${solverBadgeClass}">${esc(solverStateBadge)}</span>
            </div>

            <div class="mission-coord-grid">
              <div class="mission-field-group">
                <span class="mission-field-label">TRANSFER TYPE</span>
                <select class="hud-input mission-select" data-field="new-mission-traj-type" ${busyAttr}>
                  <option value="direct" ${draft.trajectoryType !== 'hohmann' ? 'selected' : ''}>Direct (Lambert)</option>
                  <option value="hohmann" ${draft.trajectoryType === 'hohmann' ? 'selected' : ''}>Hohmann</option>
                </select>
              </div>
              <div class="mission-field-group">
                <span class="mission-field-label">DATE MODE</span>
                <select class="hud-input mission-select" data-field="new-mission-date-mode" ${draft.flightMode === 'launch_window' ? 'disabled title="Launch Window search requires Landing Day (UTC)"' : ''} ${busyAttr}>
                  <option value="arrival" ${draft.flightMode === 'launch_window' || draft.dateMode !== 'launch' ? 'selected' : ''}>Landing Day (UTC)</option>
                  <option value="launch" ${draft.flightMode !== 'launch_window' && draft.dateMode === 'launch' ? 'selected' : ''}>Launch Day (UTC)</option>
                </select>
              </div>
            </div>

            <div class="mission-field-group">
              <span class="mission-field-label">SPACEPORT</span>
              <select class="hud-input mission-select" data-field="new-mission-spaceport" ${busyAttr}>
                <option value="">Auto (compare all suitable)</option>
                ${spaceportOptionsHtml}
              </select>
            </div>

            <div class="mission-field-group">
              <span class="mission-field-label">LANDING CONSTRAINTS</span>
              <select class="hud-input mission-select" data-field="new-mission-landing-mode" ${busyAttr}>
                <option value="flexible" ${(draft.landingWindowMode || 'flexible') === 'flexible' ? 'selected' : ''}>Flexible (Any Sun / Far Side &amp; Relay OK)</option>
                <option value="daylight" ${draft.landingWindowMode === 'daylight' ? 'selected' : ''}>Daylight Only (Sun 0°–90°, Any Side)</option>
                <option value="daylight_earth" ${draft.landingWindowMode === 'daylight_earth' ? 'selected' : ''}>Near-Side Daylight (Sun 0°–90° + Earth LOS)</option>
                <option value="artemis" ${draft.landingWindowMode === 'artemis' ? 'selected' : ''}>Strict Artemis (Sun 0°–20° + Earth LOS)</option>
                <option value="custom" ${draft.landingWindowMode === 'custom' ? 'selected' : ''}>Custom Window Rules...</option>
              </select>
            </div>

            ${
              draft.landingWindowMode === 'custom'
                ? `
              <div class="mission-custom-lw-box">
                <label class="mission-check-row">
                  <input type="checkbox" data-field="new-mission-req-sun" ${draft.requireSunVisible ? 'checked' : ''} ${busyAttr} />
                  <span>Require Sun visible above terrain</span>
                </label>
                <div class="mission-coord-grid">
                  <div class="mission-field-group">
                    <span class="mission-field-label">SUN MIN (°)</span>
                    <input
                      type="number"
                      step="1"
                      min="-10"
                      max="89"
                      class="hud-input"
                      data-field="new-mission-sun-min"
                      value="${esc(draft.sunElevationMinDeg ?? '0')}"
                      ${draft.requireSunVisible ? '' : 'disabled'}
                      ${busyAttr}
                    />
                  </div>
                  <div class="mission-field-group">
                    <span class="mission-field-label">SUN MAX (°)</span>
                    <input
                      type="number"
                      step="1"
                      min="-9"
                      max="90"
                      class="hud-input"
                      data-field="new-mission-sun-max"
                      value="${esc(draft.sunElevationMaxDeg ?? '90')}"
                      ${draft.requireSunVisible ? '' : 'disabled'}
                      ${busyAttr}
                    />
                  </div>
                </div>
                <label class="mission-check-row">
                  <input type="checkbox" data-field="new-mission-req-earth" ${draft.requireEarthVisible ? 'checked' : ''} ${busyAttr} />
                  <span>Require direct Earth line-of-sight</span>
                </label>
                <div class="mission-field-group">
                  <span class="mission-field-label">MAX ORBIT WAIT (H)</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max="720"
                    class="hud-input"
                    data-field="new-mission-max-wait-h"
                    value="${esc(draft.maxWaitInOrbitH ?? '48')}"
                    ${busyAttr}
                  />
                </div>
              </div>
            `
                : ''
            }

            <div class="mission-coord-grid">
              <div class="mission-field-group">
                <span class="mission-field-label">LAUNCH VEHICLE</span>
                <select class="hud-input mission-select" data-field="new-mission-rocket" ${busyAttr}>
                  <option value="">Default</option>
                  ${rocketOptionsHtml}
                </select>
              </div>
              <div class="mission-field-group">
                <span class="mission-field-label">SPACECRAFT</span>
                <select class="hud-input mission-select" data-field="new-mission-spacecraft" ${busyAttr}>
                  <option value="">Default</option>
                  ${spacecraftOptionsHtml}
                </select>
              </div>
            </div>

            <div class="mission-field-group">
              <span class="mission-field-label">SURFACE HEIGHT OVERRIDE (M)</span>
              <input
                type="number"
                step="1"
                class="hud-input"
                data-field="new-mission-height-m"
                placeholder="Optional (used when terrain disabled)"
                value="${esc(draft.heightM)}"
                ${busyAttr}
              />
            </div>

            <label class="mission-check-row">
              <input type="checkbox" data-field="new-mission-no-terrain" ${draft.noTerrain ? 'checked' : ''} ${busyAttr} />
              <span>Skip terrain DEM slope check (terrain_dir="")</span>
            </label>

            <label class="mission-check-row">
              <input type="checkbox" data-field="new-mission-no-cache" ${draft.noCache ? 'checked' : ''} ${busyAttr} />
              <span>Bypass ascent cache (no_cache)</span>
            </label>

            <input
              type="text"
              class="hud-input"
              data-field="new-mission-notes"
              placeholder="Mission objective / notes (optional)"
              value="${esc(draft.notes)}"
              maxlength="140"
              ${busyAttr}
            />
          </div>
        </div>

        ${
          this._isCreatingMission
            ? `<div class="mission-gen-status" data-field="create-mission-status">${esc(this._createMissionStatus || 'Computing trajectory...')}</div>`
            : ''
        }
        ${
          this._newMissionFormError
            ? `
          <div class="mission-form-error visible">
            <div>${esc(this._newMissionFormError)}</div>
            ${
              this._newMissionErrorKind === 'landing_window' && draft.landingWindowMode !== 'flexible'
                ? `<div class="mission-form-error-actions">
                    <button type="button" class="mission-mini-btn accent" data-m-action="retry-new-mission-flexible">USE FLEXIBLE WINDOW &amp; RETRY</button>
                  </div>`
                : ''
            }
            ${
              this._newMissionErrorKind === 'terrain' && !draft.noTerrain
                ? `<div class="mission-form-error-actions">
                    <button type="button" class="mission-mini-btn gold" data-m-action="retry-new-mission-no-terrain">SKIP TERRAIN CHECK &amp; RETRY</button>
                  </div>`
                : ''
            }
          </div>
        `
            : ''
        }

        <div class="mission-coord-grid">
          <button type="button" class="mission-mini-btn" data-m-action="cancel-new-mission">CANCEL</button>
          <button type="submit" class="mission-mini-btn accent" ${busyAttr}>${this._isCreatingMission ? 'GENERATING...' : 'CREATE MISSION'}</button>
        </div>
      </form>

      ${this._renderCategoryTabsHtml({
        actionName: 'switch-list-tab',
        activeTab: MISSION_CATEGORIES.includes(this._listTab) ? this._listTab : 'custom',
      })}

      <div class="mission-search-row">
        <input
          type="text"
          class="hud-input mission-search-input"
          data-field="list-search"
          value="${esc(this._listSearchQuery)}"
          placeholder="Filter missions by name, target, vehicle..."
          autocomplete="off"
        />
        ${
          this._listSearchQuery
            ? `<button type="button" class="mission-mini-btn" data-m-action="clear-list-search" title="Clear">×</button>`
            : ''
        }
      </div>

      <div class="mission-scroll-area" data-field="missions-list">
        ${this._renderMissionCardsHtml()}
      </div>
      </div>
    `;
  }

  _solverUtcToIso(rawUtc) {
    if (!rawUtc || typeof rawUtc !== 'string') return null;
    const ms = parseUtcStringToMs(rawUtc);
    return ms !== null ? new Date(ms).toISOString() : null;
  }

  _formatSolverUtc(rawUtc) {
    const iso = this._solverUtcToIso(rawUtc);
    return iso ? formatUtcCompact(iso) : String(rawUtc || '—');
  }

  _syncSolverUiToMission(mission) {
    if (!mission || this._solverUiMissionId === mission.id) return;
    this._solverUiMissionId = mission.id;
    this._solverUiMode = resolveMissionFlightMode(mission);
    const gen = mission.modules?.generation;
    const margin =
      gen?.launchWindowMarginMs ??
      gen?.payload?.advanced?.launchWindowMarginMs ??
      gen?.request?.launch_window_margin_m_s ??
      50;
    this._solverUiMarginMs = Number.isFinite(Number(margin)) ? String(margin) : '50';
    this._solverUiRefine =
      gen?.launchWindowRefine ?? gen?.payload?.advanced?.launchWindowRefine ?? true;
    this._solverUiShowAllDays = false;
  }

  _renderSolverModeBlockHtml(mission, sectionKey = 'flight-solver') {
    const esc = MissionPanel.escapeHtml;
    this._syncSolverUiToMission(mission);

    const gen = mission.modules?.generation || null;
    const savedMode = resolveMissionFlightMode(mission);
    const uiMode = this._solverUiMode || savedMode;
    const isCollapsed = this._collapsedSections.has(sectionKey);
    const isRecalcForThis = this._isRecalculatingTraj && this._recalcTrajMissionId === mission.id;
    const recalcErrForThis =
      !isRecalcForThis && this._recalcTrajMissionId === mission.id ? this._recalcTrajError : '';
    const hasTarget = Boolean(mission.landingSite);

    const chipClass =
      savedMode === 'economy' ? 'nominal' : savedMode === 'launch_window' ? 'warn' : 'accent';
    const chipLabel =
      savedMode === 'economy'
        ? 'ECONOMY'
        : savedMode === 'launch_window'
          ? 'LAUNCH WINDOW'
          : 'FAST';

    const runBtnLabel =
      uiMode === 'launch_window'
        ? 'SEARCH LAUNCH WINDOW'
        : uiMode === 'economy'
          ? 'RUN ECONOMY (±3D)'
          : 'RECALCULATE (FAST)';

    const dv = gen?.deltaV || null;
    const eco = gen?.economy || null;
    const lw = gen?.launchWindow || null;

    let ecoHtml = '';
    if (eco) {
      const shift = Number(eco.chosen_shift_days || 0);
      const shiftText = shift === 0 ? '0 d (requested)' : `${shift > 0 ? '+' : ''}${shift} d`;
      const savingVal = Number(eco.saving_vs_requested_m_s);
      const savingText = Number.isFinite(savingVal)
        ? savingVal > 0.05
          ? `−${savingVal.toFixed(1)} m/s`
          : '0.0 m/s (optimal)'
        : '—';
      const days = Array.isArray(eco.days) ? eco.days : [];
      const rowsHtml = days
        .map((d) => {
          const s = Number(d.shift_days || 0);
          const isChosen = d.shift_days === eco.chosen_shift_days;
          const isFeasible = d.launch_utc && Number.isFinite(Number(d.mission_delta_v_m_s));
          const dayStr = d.day?.day_start_utc ? String(d.day.day_start_utc).slice(5, 10) : '—';
          const tofStr = Number.isFinite(Number(d.time_of_flight_h))
            ? `${Number(d.time_of_flight_h).toFixed(1)}h`
            : '—';
          const dvOrReason = isFeasible
            ? `${Math.round(Number(d.mission_delta_v_m_s))} m/s`
            : esc(d.reason || 'no flight');
          return `
            <tr class="${isChosen ? 'is-chosen' : !isFeasible ? 'is-infeasible' : ''}">
              <td>${s > 0 ? `+${s}d` : `${s}d`}</td>
              <td>${esc(dayStr)}</td>
              <td>${esc(tofStr)}</td>
              <td>${dvOrReason}</td>
            </tr>
          `;
        })
        .join('');

      ecoHtml = `
        <div class="mission-solver-summary">
          <div class="mission-solver-kpis">
            <div class="mission-kv">
              <span class="mission-kv-k">CHOSEN SHIFT</span>
              <span class="mission-kv-v val-nominal">${esc(shiftText)}</span>
            </div>
            <div class="mission-kv">
              <span class="mission-kv-k">ΔV SAVED</span>
              <span class="mission-kv-v val-nominal">${esc(savingText)}</span>
            </div>
            <div class="mission-kv">
              <span class="mission-kv-k">CHOSEN MISSION ΔV</span>
              <span class="mission-kv-v">${Number.isFinite(Number(eco.chosen_mission_delta_v_m_s)) ? `${Math.round(Number(eco.chosen_mission_delta_v_m_s))} m/s` : '—'}</span>
            </div>
            <div class="mission-kv">
              <span class="mission-kv-k">REQUESTED DAY ΔV</span>
              <span class="mission-kv-v">${Number.isFinite(Number(eco.requested_mission_delta_v_m_s)) ? `${Math.round(Number(eco.requested_mission_delta_v_m_s))} m/s` : 'N/A'}</span>
            </div>
          </div>
          ${
            days.length > 0
              ? `
            <div class="mission-btn-strip">
              <button type="button" class="mission-mini-btn" data-m-action="toggle-economy-days">${this._solverUiShowAllDays ? 'HIDE ±3D TABLE' : `SHOW ±${eco.date_shift_days ?? 3}D TABLE (${days.length})`}</button>
            </div>
            ${
              this._solverUiShowAllDays
                ? `<div class="mission-eco-table-wrap">
                    <table class="mission-eco-table">
                      <thead><tr><th>SHIFT</th><th>DAY</th><th>TOF</th><th>MISSION ΔV</th></tr></thead>
                      <tbody>${rowsHtml}</tbody>
                    </table>
                  </div>`
                : ''
            }
          `
              : ''
          }
        </div>
      `;
    }

    let lwHtml = '';
    if (lw) {
      const segments = Array.isArray(lw.segments) ? lw.segments : [];
      const segsHtml = segments
        .map(
          (seg, idx) => `
          <div class="mission-lw-seg">
            <div class="mission-lw-seg-top">
              <span>#${idx + 1} · ${esc(this._formatSolverUtc(seg.opens_utc))} → ${esc(String(this._formatSolverUtc(seg.closes_utc)).slice(11))}</span>
              <span class="val-warn">${Number.isFinite(Number(seg.duration_min)) ? `${Number(seg.duration_min).toFixed(1)} min` : '—'}</span>
            </div>
            <div class="mission-lw-seg-sub">
              Best: ${esc(this._formatSolverUtc(seg.best?.launch_utc))} · ${Number.isFinite(Number(seg.best?.mission_delta_v_m_s)) ? `${Math.round(Number(seg.best.mission_delta_v_m_s))} m/s` : '—'} (max ${Number.isFinite(Number(seg.max_mission_delta_v_m_s)) ? `${Math.round(Number(seg.max_mission_delta_v_m_s))}` : '—'})
            </div>
          </div>
        `
        )
        .join('');

      lwHtml = `
        <div class="mission-solver-summary">
          <div class="mission-solver-kpis">
            <div class="mission-kv">
              <span class="mission-kv-k">WINDOW OPENS (UTC)</span>
              <span class="mission-kv-v val-warn">${esc(this._formatSolverUtc(lw.opens_utc))}</span>
            </div>
            <div class="mission-kv">
              <span class="mission-kv-k">WINDOW CLOSES (UTC)</span>
              <span class="mission-kv-v val-warn">${esc(this._formatSolverUtc(lw.closes_utc))}</span>
            </div>
            <div class="mission-kv">
              <span class="mission-kv-k">SPAN / OPEN TOTAL</span>
              <span class="mission-kv-v">${Number.isFinite(Number(lw.span_h)) ? `${Number(lw.span_h).toFixed(1)} h` : '—'} · ${Number.isFinite(Number(lw.open_total_min)) ? `${Number(lw.open_total_min).toFixed(1)} min` : '—'}</span>
            </div>
            <div class="mission-kv">
              <span class="mission-kv-k">MIN ΔV (+${Number.isFinite(Number(lw.margin_m_s)) ? Math.round(Number(lw.margin_m_s)) : 50} M/S)</span>
              <span class="mission-kv-v val-nominal">${Number.isFinite(Number(lw.min_mission_delta_v_m_s)) ? `${Math.round(Number(lw.min_mission_delta_v_m_s))} m/s` : '—'}</span>
            </div>
          </div>
          ${
            lw.optimum
              ? `
            <div class="mission-traj-compact">
              <div class="data-row"><span>Optimum Launch:</span> <span class="data-val val-accent">${esc(this._formatSolverUtc(lw.optimum.launch_utc))}</span></div>
              <div class="data-row"><span>Optimum Touchdown:</span> <span class="data-val val-nominal">${esc(this._formatSolverUtc(lw.optimum.touchdown_utc || lw.optimum.lunar_orbit_insertion_utc))}</span></div>
            </div>
            <div class="mission-btn-strip">
              <button type="button" class="mission-mini-btn nominal" data-m-action="sync-window-optimum">SYNC OPTIMUM DATES</button>
            </div>
          `
              : ''
          }
          ${
            segments.length > 0
              ? `<div class="mission-field-label">WINDOW INTERVALS (${segments.length})</div><div class="mission-lw-segments">${segsHtml}</div>`
              : ''
          }
        </div>
      `;
    }

    return `
      <div class="mission-card-block ${isCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-block-header">
          <span class="mission-block-title">SOLVER MODE &amp; LAUNCH WINDOW</span>
          <div class="mission-block-actions">
            <span class="mission-source-chip ${chipClass}">${chipLabel}</span>
            ${this._sectionArrowHtml(sectionKey, 'Collapse / Expand Solver Mode')}
          </div>
        </div>
        <div class="mission-block-body ${isCollapsed ? 'collapsed' : ''}" style="${isCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">
          <div class="mission-mode-pills">
            <button type="button" class="mission-mode-pill ${uiMode === 'fast' ? 'active' : ''}" data-m-action="set-active-solver-mode" data-flight-mode="fast" ${isRecalcForThis ? 'disabled' : ''}>FAST</button>
            <button type="button" class="mission-mode-pill ${uiMode === 'economy' ? 'active eco' : ''}" data-m-action="set-active-solver-mode" data-flight-mode="economy" ${isRecalcForThis ? 'disabled' : ''}>ECONOMY</button>
            <button type="button" class="mission-mode-pill ${uiMode === 'launch_window' ? 'active win' : ''}" data-m-action="set-active-solver-mode" data-flight-mode="launch_window" ${isRecalcForThis ? 'disabled' : ''}>WINDOW</button>
          </div>
          <div class="mission-mode-hint">${
            uiMode === 'economy'
              ? 'Searches ±3 days around target date for minimum mission Δv (TLI + LOI + descent).'
              : uiMode === 'launch_window'
                ? 'Scans every valid launch slot for the current Landing Day (UTC) within Δv margin.'
                : 'Fast search on the requested UTC day.'
          }</div>
          ${
            uiMode === 'launch_window'
              ? `
            <div class="mission-window-opts">
              <div class="mission-field-group">
                <span class="mission-field-label">WINDOW ΔV MARGIN (M/S)</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="5000"
                  class="hud-input"
                  data-field="solver-window-margin"
                  placeholder="50"
                  value="${esc(this._solverUiMarginMs ?? '50')}"
                  ${isRecalcForThis ? 'disabled' : ''}
                />
              </div>
              <label class="mission-check-row">
                <input type="checkbox" data-field="solver-window-refine" ${this._solverUiRefine ? 'checked' : ''} ${isRecalcForThis ? 'disabled' : ''} />
                <span>Refine optimum launch for 3D orbit path</span>
              </label>
            </div>
          `
              : ''
          }
          <div class="mission-btn-strip">
            <button type="button" class="mission-mini-btn accent" data-m-action="recalc-mission-mode" ${!hasTarget || isRecalcForThis ? 'disabled' : ''} title="${hasTarget ? 'Run trajectory solver in selected mode' : 'Set landing target coordinates first'}">${runBtnLabel}</button>
            ${isRecalcForThis ? `<button type="button" class="mission-mini-btn danger" data-m-action="cancel-recalc-traj">CANCEL</button>` : ''}
          </div>
          ${isRecalcForThis ? `<div class="mission-gen-status" data-field="recalc-traj-status">${esc(this._recalcTrajStatus || 'Running solver...')}</div>` : ''}
          ${recalcErrForThis ? `<div class="mission-form-error visible">${esc(recalcErrForThis)}</div>` : ''}
          ${
            dv && Number.isFinite(Number(dv.mission_total_m_s))
              ? `
            <div class="mission-traj-compact">
              <div class="data-row"><span>Mission Total ΔV:</span> <span class="data-val val-warn">${Math.round(Number(dv.mission_total_m_s))} m/s</span></div>
              <div class="data-row"><span>TLI / LOI / Descent:</span> <span class="data-val">${Math.round(Number(dv.tli_m_s || 0))} / ${Math.round(Number(dv.lunar_orbit_insertion_m_s || 0))} / ${dv.descent_m_s != null ? Math.round(Number(dv.descent_m_s)) : '—'} m/s</span></div>
            </div>
          `
              : ''
          }
          ${ecoHtml}
          ${lwHtml}
        </div>
      </div>
    `;
  }

  _renderFlightTab(mission) {
    const esc = MissionPanel.escapeHtml;
    const site = mission.landingSite;
    const isCislunar = this.getViewMode?.() === VIEW_MODES.CISLUNAR;
    const targetFormClass = this._isTargetFormOpen ? 'visible' : '';

    const landingIso = mission.flight?.landingDateIso || null;
    const launchIso = mission.flight?.launchDateIso || null;
    const transitSec = mission.flight?.transitDurationSec ?? mission.trajectory?.meta?.durationSec ?? null;
    const transitHoursVal =
      Number.isFinite(Number(transitSec)) && Number(transitSec) >= 0
        ? (Number(transitSec) / 3600).toFixed(2)
        : '';

    const hasTraj = mission.trajectory?.sourceType && mission.trajectory.sourceType !== 'none';
    const isTargetCollapsed = this._collapsedSections.has('flight-target');
    const isScheduleCollapsed = this._collapsedSections.has('flight-schedule');
    const isTrajCardCollapsed = this._collapsedSections.has('flight-traj');
    const isNotesCollapsed = this._collapsedSections.has('flight-notes');
    const isRecalcForThis = this._isRecalculatingTraj && this._recalcTrajMissionId === mission.id;
    const recalcErrForThis =
      !isRecalcForThis && this._recalcTrajMissionId === mission.id ? this._recalcTrajError : '';

    return `
      <!-- 1. LANDING TARGET -->
      <div class="mission-card-block target-block ${isTargetCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-block-header">
          <span class="mission-block-title">LANDING TARGET</span>
          <div class="mission-block-actions">
            ${
              site
                ? `<button type="button" class="mission-vis-btn ${site.visible !== false ? '' : 'hidden-item'}" data-m-action="toggle-target-vis" title="Show/hide target marker">${site.visible !== false ? 'VIS' : 'OFF'}</button>`
                : ''
            }
            <button type="button" class="mission-mini-btn" data-m-action="toggle-target-form">${site ? 'EDIT' : '+ SET'}</button>
            ${this._sectionArrowHtml('flight-target', 'Collapse / Expand Landing Target')}
          </div>
        </div>
        <div class="mission-block-body ${isTargetCollapsed ? 'collapsed' : ''}" style="${isTargetCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">

        ${
          site
            ? `
          <div class="mission-target-summary">
            <div class="mission-target-name">${esc(site.name)}</div>
            <div class="mission-target-coords">${esc(formatCoords(site.lat, site.lon))}</div>
            ${site.note ? `<div class="mission-item-note">${esc(site.note)}</div>` : ''}
          </div>
          <div class="mission-btn-strip">
            <button type="button" class="mission-mini-btn" data-m-action="fly-to-target">FLY TO</button>
            <button type="button" class="mission-mini-btn" data-m-action="target-from-camera" title="Capture camera center">FROM CAM</button>
            <button type="button" class="mission-mini-btn" data-m-action="browse-sites">CATALOG</button>
            <button type="button" class="mission-mini-btn nominal" data-m-action="land-to-target" ${isCislunar ? 'disabled title="Switch to Lunar View to open surface view"' : 'title="Open surface simulator at landing target & date"'}>LAND TO</button>
          </div>
        `
            : `
          <div class="mission-empty-inline">No primary landing target selected yet.</div>
          <div class="mission-btn-strip">
            <button type="button" class="mission-mini-btn accent" data-m-action="toggle-target-form">+ ENTER COORDS</button>
            <button type="button" class="mission-mini-btn" data-m-action="target-from-camera">FROM CAM</button>
            <button type="button" class="mission-mini-btn" data-m-action="browse-sites">CATALOG</button>
          </div>
        `
        }

        ${
          isRecalcForThis
            ? `<div class="mission-recalc-row">
                 <div class="mission-gen-status" data-field="recalc-traj-status">${esc(this._recalcTrajStatus || 'Recalculating trajectory...')}</div>
                 <button type="button" class="mission-mini-btn danger" data-m-action="cancel-recalc-traj">CANCEL</button>
               </div>`
            : ''
        }
        ${
          recalcErrForThis
            ? `<div class="mission-form-error visible">${esc(recalcErrForThis)}</div>`
            : ''
        }

        <form class="mission-add-form ${targetFormClass}" data-form="target-form">
          ${this._renderPresetPickerHtml({ selectField: 'target-site-preset' })}
          <input
            type="text"
            class="hud-input"
            data-field="target-name"
            placeholder="Target name (e.g. Malapert Massif)"
            value="${esc(site?.name || '')}"
            maxlength="64"
          />
          <div class="mission-coord-grid">
            <input
              type="number"
              step="0.00001"
              min="-90"
              max="90"
              class="hud-input"
              data-field="target-lat"
              placeholder="Lat (-90..90)"
              value="${site ? esc(site.lat) : ''}"
            />
            <input
              type="number"
              step="0.00001"
              min="-180"
              max="180"
              class="hud-input"
              data-field="target-lon"
              placeholder="Lon (-180..180)"
              value="${site ? esc(site.lon) : ''}"
            />
          </div>
          ${this._renderPickMoonButtonHtml('target-form')}
          <input
            type="text"
            class="hud-input"
            data-field="target-note"
            placeholder="Site note (optional)"
            value="${esc(site?.note || '')}"
            maxlength="120"
          />
          ${this._targetFormError ? `<div class="mission-form-error visible">${esc(this._targetFormError)}</div>` : ''}
          <div class="mission-btn-strip">
            <button type="button" class="mission-mini-btn" data-m-action="cancel-target-form">CANCEL</button>
            ${site ? `<button type="button" class="mission-mini-btn danger" data-m-action="clear-target">CLEAR</button>` : ''}
            <button type="submit" class="mission-mini-btn accent">SAVE TARGET</button>
          </div>
        </form>
        </div>
      </div>

      <!-- 2. FLIGHT SCHEDULE & TRANSIT -->
      <div class="mission-card-block ${isScheduleCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-block-header">
          <span class="mission-block-title">FLIGHT SCHEDULE & TRANSIT</span>
          <div class="mission-block-actions">
            <span class="mission-source-chip">${esc((mission.flight?.dateSource || 'unset').toUpperCase())}</span>
            ${this._sectionArrowHtml('flight-schedule', 'Collapse / Expand Flight Schedule')}
          </div>
        </div>
        <div class="mission-block-body ${isScheduleCollapsed ? 'collapsed' : ''}" style="${isScheduleCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">

        <div class="mission-field-group">
          <div class="mission-field-label-row">
            <span class="mission-field-label">LANDING DATE (UTC)</span>
            <span class="mission-field-readout">${esc(formatUtcTimestamp(landingIso))}</span>
          </div>
          <input
            type="datetime-local"
            class="hud-input mission-datetime-input"
            data-field="landing-date-input"
            value="${esc(toDatetimeLocalUtc(landingIso))}"
          />
          <div class="mission-btn-strip">
            <button type="button" class="mission-mini-btn" data-m-action="use-timeline-date" title="Copy current timeline date into mission landing date">USE TIMELINE</button>
            <button type="button" class="mission-mini-btn accent" data-m-action="sync-timeline-date" ${landingIso ? '' : 'disabled'} title="Jump timeline & solar lighting to landing date">SYNC TIMELINE</button>
            <button type="button" class="mission-mini-btn" data-m-action="set-landing-now">NOW</button>
          </div>
        </div>

        <div class="mission-field-group mission-field-divider">
          <div class="mission-field-label-row">
            <span class="mission-field-label">LAUNCH DATE (UTC)</span>
            <span class="mission-field-readout">${esc(formatUtcTimestamp(launchIso))}</span>
          </div>
          <input
            type="datetime-local"
            class="hud-input mission-datetime-input"
            data-field="launch-date-input"
            value="${esc(toDatetimeLocalUtc(launchIso))}"
          />
        </div>

        <div class="mission-field-group mission-field-divider">
          <div class="mission-field-label-row">
            <span class="mission-field-label">TRANSIT INTERVAL</span>
            <span class="mission-field-readout val-accent">${esc(formatTransitDuration(transitSec))}</span>
          </div>
          <div class="mission-transit-row">
            <input
              type="number"
              step="0.25"
              min="0"
              class="hud-input"
              data-field="transit-hours-input"
              placeholder="Transit duration in hours"
              value="${esc(transitHoursVal)}"
            />
            <span class="mission-unit-tag">HRS</span>
          </div>
        </div>

        ${
          landingIso || launchIso
            ? `<div class="mission-btn-strip"><button type="button" class="mission-mini-btn danger" data-m-action="clear-flight-dates">RESET DATES</button></div>`
            : ''
        }
        </div>
      </div>

      ${this._renderSolverModeBlockHtml(mission, 'flight-solver')}

      <!-- 3. TRAJECTORY SUMMARY LINK -->
      <div class="mission-card-block ${isTrajCardCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-block-header">
          <span class="mission-block-title">TRAJECTORY JSON</span>
          <div class="mission-block-actions">
            <span class="mission-source-chip ${hasTraj ? 'accent' : ''}">${hasTraj ? esc(mission.trajectory.sourceType.toUpperCase()) : 'NONE'}</span>
            ${this._sectionArrowHtml('flight-traj', 'Collapse / Expand Trajectory Summary')}
          </div>
        </div>
        <div class="mission-block-body ${isTrajCardCollapsed ? 'collapsed' : ''}" style="${isTrajCardCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">
        ${
          hasTraj
            ? `
          <div class="mission-traj-compact">
            <div class="data-row"><span>File:</span> <span class="data-val">${esc(mission.trajectory.fileName || 'trajectory.json')}</span></div>
            <div class="data-row"><span>Vehicle:</span> <span class="data-val val-accent">${esc(mission.trajectory.meta?.rocket || 'Pending parse')}</span></div>
            <div class="data-row"><span>Transit:</span> <span class="data-val">${esc(formatTransitDuration(mission.trajectory.meta?.durationSec))}</span></div>
          </div>
        `
            : `<div class="mission-empty-inline">No flight trajectory attached to this mission.</div>`
        }
        <div class="mission-btn-strip">
          <button type="button" class="mission-mini-btn" data-m-action="upload-traj-json">LOAD JSON</button>
          <button type="button" class="mission-mini-btn accent" data-m-action="switch-subtab" data-subtab="traj">MANAGE TRAJ</button>
          ${hasTraj ? `<button type="button" class="mission-mini-btn" data-m-action="open-cislunar">CISLUNAR</button>` : ''}
          <button type="button" class="mission-mini-btn" data-m-action="open-dashboard" title="Open LWP Mission Analytics Datatable">DASHBOARD</button>
        </div>
        </div>
      </div>

      <!-- 4. EXTENSIBLE MISSION NOTES & PARAMETERS -->
      <div class="mission-card-block ${isNotesCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-block-header">
          <span class="mission-block-title">MISSION BRIEF & MODULES</span>
          <div class="mission-block-actions">
            <span class="mission-source-chip">V2 SCHEMA</span>
            ${this._sectionArrowHtml('flight-notes', 'Collapse / Expand Mission Brief')}
          </div>
        </div>
        <div class="mission-block-body ${isNotesCollapsed ? 'collapsed' : ''}" style="${isNotesCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">
        <textarea
          class="hud-input mission-notes-area"
          data-field="mission-notes"
          rows="2"
          placeholder="Mission brief, constraints, surface objectives..."
        >${esc(mission.modules?.notes || '')}</textarea>
        <div class="mission-ext-footer">
          <span>SURFACE: ${mission.points.length + mission.measurements.length} (${mission.points.length} PT · ${mission.measurements.length} RTE)</span>
          <span>ID: ${esc(mission.id.slice(0, 14))}</span>
        </div>
        </div>
      </div>
    `;
  }

  _renderTrajTab(mission) {
    const esc = MissionPanel.escapeHtml;
    const traj = mission.trajectory || {};
    const meta = traj.meta;
    const hasTraj = traj.sourceType && traj.sourceType !== 'none';

    const phaseHtml = (meta?.phases || [])
      .map((phase) => {
        const cfg = TRAJECTORY_CONFIG.PHASES[phase];
        if (!cfg) return '';
        return `
          <span class="mission-phase-pill">
            <span class="mission-phase-swatch" style="background: ${cfg.css};"></span>
            <span>${esc(cfg.label)}</span>
          </span>
        `;
      })
      .join('');

    const isTrajSourceCollapsed = this._collapsedSections.has('traj-source');
    const isTrajTelemetryCollapsed = this._collapsedSections.has('traj-telemetry');

    return `
      <div class="mission-card-block ${isTrajSourceCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-block-header">
          <span class="mission-block-title">TRAJECTORY SOURCE (JSON)</span>
          <div class="mission-block-actions">
            <span class="mission-source-chip ${hasTraj ? 'accent' : ''}">${hasTraj ? esc(traj.sourceType.toUpperCase()) : 'UNATTACHED'}</span>
            ${this._sectionArrowHtml('traj-source', 'Collapse / Expand Trajectory Source')}
          </div>
        </div>
        <div class="mission-block-body ${isTrajSourceCollapsed ? 'collapsed' : ''}" style="${isTrajSourceCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">

        <div class="mission-traj-file-row">
          <span class="mission-traj-filename">${esc(traj.fileName || 'No trajectory file loaded')}</span>
        </div>

        <div class="mission-btn-strip">
          <button type="button" class="mission-mini-btn accent" data-m-action="upload-traj-json">LOAD JSON</button>
          <button type="button" class="mission-mini-btn" data-m-action="load-default-traj">DEFAULT</button>
          ${
            hasTraj
              ? `<button type="button" class="mission-mini-btn" data-m-action="toggle-traj-visible">${traj.visible !== false ? 'PATH: ON' : 'PATH: OFF'}</button>`
              : ''
          }
          ${hasTraj ? `<button type="button" class="mission-mini-btn danger" data-m-action="clear-traj">CLEAR</button>` : ''}
        </div>

        ${this._trajStatusMsg ? `<div class="mission-traj-status" data-field="traj-status-msg">${esc(this._trajStatusMsg)}</div>` : ''}
        ${this._trajErrorMsg ? `<div class="mission-form-error visible">${esc(this._trajErrorMsg)}</div>` : ''}
        </div>
      </div>

      ${
        hasTraj && meta
          ? `
        <div class="mission-card-block ${isTrajTelemetryCollapsed ? 'is-collapsed' : ''}">
          <div class="mission-block-header">
            <span class="mission-block-title">FLIGHT PROFILE TELEMETRY</span>
            <div class="mission-block-actions">
              <button type="button" class="mission-mini-btn" data-m-action="open-cislunar">CISLUNAR VIEW</button>
              <button type="button" class="mission-mini-btn accent" data-m-action="open-dashboard" title="Open LWP Mission Analytics Datatable">DATATABLE</button>
              ${this._sectionArrowHtml('traj-telemetry', 'Collapse / Expand Telemetry Profile')}
            </div>
          </div>
          <div class="mission-block-body ${isTrajTelemetryCollapsed ? 'collapsed' : ''}" style="${isTrajTelemetryCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">
          <div class="mission-traj-compact">
            <div class="data-row"><span>Vehicle:</span> <span class="data-val val-accent">${esc(meta.rocket)}</span></div>
            <div class="data-row"><span>Spaceport:</span> <span class="data-val">${esc(meta.spaceportName)}</span></div>
            ${
              mission.modules?.generation?.jobId
                ? `<div class="data-row"><span>Solver Job:</span> <span class="data-val">${esc(mission.modules.generation.jobId)}</span></div>`
                : ''
            }
            <div class="data-row"><span>Launch UTC:</span> <span class="data-val">${esc(formatUtcCompact(meta.launchUtc))}</span></div>
            <div class="data-row"><span>Touchdown UTC:</span> <span class="data-val val-nominal">${esc(formatUtcCompact(meta.touchdownUtc))}</span></div>
            <div class="data-row"><span>Transit Interval:</span> <span class="data-val">${esc(formatTransitDuration(meta.durationSec))}</span></div>
            <div class="data-row"><span>Total ΔV:</span> <span class="data-val val-warn">${Number.isFinite(meta.totalDeltaVKmS) ? `${meta.totalDeltaVKmS.toFixed(2)} km/s` : '—'}</span></div>
            <div class="data-row"><span>JSON Touchdown:</span> <span class="data-val">${Number.isFinite(meta.landingLatDeg) ? esc(formatCoords(meta.landingLatDeg, meta.landingLonDeg)) : '—'}</span></div>
            <div class="data-row"><span>Samples / Events:</span> <span class="data-val">${meta.sampleCount} / ${meta.eventCount}</span></div>
          </div>

          <div class="mission-btn-strip" style="margin-top: 6px;">
            <button type="button" class="mission-mini-btn nominal" data-m-action="sync-from-traj" title="Overwrite mission target & landing/launch dates from trajectory JSON">SYNC TARGET & DATES FROM JSON</button>
          </div>

          ${
            phaseHtml
              ? `
            <div class="mission-phase-wrap">
              <div class="mission-field-label" style="margin-bottom: 4px;">TRAJECTORY PHASES</div>
              <div class="mission-phase-grid">${phaseHtml}</div>
            </div>
          `
              : ''
          }
          </div>
        </div>
      `
          : `
        <div class="mission-empty-box">
          Attach an <code>lwp-trajectory/1</code> JSON file or load the default Artemis cislunar trajectory to bind launch/touchdown dates, transit duration, and 3D orbital path directly to this mission.
        </div>
      `
      }

      ${this._renderSolverModeBlockHtml(mission, 'traj-solver')}
    `;
  }

  _renderSurfaceTab(mission) {
    const esc = MissionPanel.escapeHtml;
    const ptsCount = mission.points.length;
    const measCount = mission.measurements.length;
    const totalCount = ptsCount + measCount;
    const formClass = this._isAddPointFormOpen ? 'visible' : '';

    const entries = [
      ...mission.points.map((pt, idx) => ({
        kind: 'point',
        sortMs: pt.createdAt ? Date.parse(pt.createdAt) || 0 : 0,
        origIdx: idx,
        data: pt,
      })),
      ...mission.measurements.map((m, idx) => ({
        kind: 'measurement',
        sortMs: m.createdAt ? Date.parse(m.createdAt) || 0 : 0,
        origIdx: idx,
        data: m,
      })),
    ].sort((a, b) => {
      if (a.sortMs !== b.sortMs) return b.sortMs - a.sortMs;
      if (a.kind !== b.kind) return a.kind === 'point' ? -1 : 1;
      return a.origIdx - b.origIdx;
    });

    const listHtml =
      totalCount === 0
        ? `<div class="mission-empty-box">No surface waypoints or ruler routes in this mission yet. Add a point (+ POINT, CENTER, CATALOG, right-click on Moon) or measure a path with RULER (R) and click "+ SAVE".</div>`
        : entries
            .map((entry) => {
              if (entry.kind === 'point') {
                const pt = entry.data;
                const isVisible = pt.visible !== false;
                return `
                  <div class="mission-item-card point" data-point-id="${esc(pt.id)}">
                    <div class="mission-item-top">
                      <div class="mission-item-title-wrap">
                        <span class="mission-type-badge pt">PT</span>
                        <span class="mission-item-name">${esc(pt.name)}</span>
                      </div>
                      <div class="mission-item-actions">
                        <button type="button" class="mission-mini-btn nominal" data-m-action="point-set-target" data-point-id="${esc(pt.id)}" title="Set as mission landing target">TARGET</button>
                        <button type="button" class="mission-vis-btn ${isVisible ? '' : 'hidden-item'}" data-m-action="point-toggle-vis" data-point-id="${esc(pt.id)}" title="Show / hide on globe">${isVisible ? 'VIS' : 'OFF'}</button>
                        <button type="button" class="mission-mini-btn danger" data-m-action="point-remove" data-point-id="${esc(pt.id)}" title="Remove point">×</button>
                      </div>
                    </div>
                    <div class="mission-item-sub">
                      <span>${esc(formatCoords(pt.lat, pt.lon))}</span>
                    </div>
                    ${pt.note ? `<div class="mission-item-note">${esc(pt.note)}</div>` : ''}
                  </div>
                `;
              }

              const m = entry.data;
              const isVisible = m.visible !== false;
              const distStr = RulerTool.formatDistance(m.totalArcMeters);
              const chordStr = RulerTool.formatDistance(m.directChordMeters);
              const segsCount = Math.max(0, (m.points?.length || 1) - 1);
              return `
                <div class="mission-item-card measurement" data-meas-id="${esc(m.id)}">
                  <div class="mission-item-top">
                    <div class="mission-item-title-wrap">
                      <span class="mission-type-badge ruler">RULER</span>
                      <span class="mission-item-name">${esc(m.name)}</span>
                    </div>
                    <div class="mission-item-actions">
                      <button type="button" class="mission-vis-btn ${isVisible ? '' : 'hidden-item'}" data-m-action="meas-toggle-vis" data-meas-id="${esc(m.id)}" title="Show / hide on globe">${isVisible ? 'VIS' : 'OFF'}</button>
                      <button type="button" class="mission-mini-btn" data-m-action="meas-load" data-meas-id="${esc(m.id)}" title="Load into ruler">LOAD</button>
                      <button type="button" class="mission-mini-btn danger" data-m-action="meas-remove" data-meas-id="${esc(m.id)}" title="Delete measurement">×</button>
                    </div>
                  </div>
                  <div class="mission-item-sub">
                    <span class="mission-meas-dist">${distStr}</span>
                    <span>chord: ${chordStr} · ${segsCount} seg</span>
                  </div>
                </div>
              `;
            })
            .join('');

    const isSurfaceCollapsed = this._collapsedSections.has('surface-data');

    return `
      <div class="mission-section ${isSurfaceCollapsed ? 'is-collapsed' : ''}">
        <div class="mission-section-header">
          <span class="mission-section-title">SURFACE DATA (${totalCount})</span>
          <div class="mission-block-actions">
            <span class="mission-surface-counts">${ptsCount} PT · ${measCount} RTE</span>
            ${this._sectionArrowHtml('surface-data', 'Collapse / Expand Surface Data')}
          </div>
        </div>
        <div class="mission-section-body ${isSurfaceCollapsed ? 'collapsed' : ''}" style="${isSurfaceCollapsed ? '' : 'display:flex;flex-direction:column;gap:6px;'}">

        <div class="mission-surface-toolbar">
          <button type="button" class="mission-mini-btn" data-m-action="toggle-point-form">+ POINT</button>
          <button type="button" class="mission-mini-btn" data-m-action="add-point-from-camera">CENTER</button>
          <button type="button" class="mission-mini-btn" data-m-action="browse-sites">CATALOG</button>
          <button type="button" class="mission-mini-btn gold" data-m-action="open-ruler" title="Open ruler (R)">RULER</button>
          <button type="button" class="mission-mini-btn accent" data-m-action="save-ruler" ${this._canSaveRuler ? '' : 'disabled'} title="Save current ruler measurement">+ SAVE</button>
        </div>

        <form class="mission-add-form ${formClass}" data-form="point-form">
          <input type="text" class="hud-input" data-field="point-name" placeholder="Point name (e.g. Crater A)" maxlength="64" />
          <div class="mission-coord-grid">
            <input type="number" step="0.0001" min="-90" max="90" class="hud-input" data-field="point-lat" placeholder="Latitude (-90..90)" />
            <input type="number" step="0.0001" min="-180" max="180" class="hud-input" data-field="point-lon" placeholder="Longitude (-180..180)" />
          </div>
          ${this._renderPickMoonButtonHtml('point-form')}
          <input type="text" class="hud-input" data-field="point-note" placeholder="Note (optional)" maxlength="120" />
          ${this._pointFormError ? `<div class="mission-form-error visible">${esc(this._pointFormError)}</div>` : ''}
          <div class="mission-coord-grid">
            <button type="button" class="mission-mini-btn" data-m-action="cancel-point-form">CANCEL</button>
            <button type="submit" class="mission-mini-btn accent">+ ADD WAYPOINT</button>
          </div>
        </form>

        <div class="mission-items-list">${listHtml}</div>
        </div>
      </div>
    `;
  }

  _renderDetailView(mission) {
    const esc = MissionPanel.escapeHtml;
    const surfaceCount = mission.points.length + mission.measurements.length;
    const subTabs = [
      { id: 'flight', label: 'FLIGHT' },
      { id: 'traj', label: 'TRAJ' },
      { id: 'surface', label: `SURFACE (${surfaceCount})` },
    ];

    let bodyHtml = '';
    if (this._detailTab === 'traj') {
      bodyHtml = this._renderTrajTab(mission);
    } else if (this._detailTab === 'surface') {
      bodyHtml = this._renderSurfaceTab(mission);
    } else {
      bodyHtml = this._renderFlightTab(mission);
    }

    return `
      <div class="mission-workspace-bar">
        <button type="button" class="mission-back-btn" data-m-action="back-to-list" title="Back to all missions list">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M10 3L5 8l5 5" />
          </svg>
          <span>MISSIONS (${this.missions.length})</span>
        </button>

        <div class="mission-workspace-actions">
          <button type="button" class="mission-icon-btn" data-m-action="toggle-rename" title="Rename mission">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
            </svg>
          </button>
          <button type="button" class="mission-icon-btn" data-m-action="duplicate-mission" title="Clone mission">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="5" y="5" width="8" height="8" rx="1" />
              <path d="M3 11V3h8" />
            </svg>
          </button>
          <button type="button" class="mission-icon-btn danger" data-m-action="delete-mission" title="Delete mission" ${this.missions.length <= 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8.5h5l.5-8.5" />
            </svg>
          </button>
        </div>
      </div>

      ${this._renderCategoryTabsHtml({
        actionName: 'open-category-list',
        activeTab: this._categoryForMission(mission),
      })}

      <div class="mission-hero-box">
        <div class="mission-hero-top">
          <span class="mission-status-dot active" aria-hidden="true"></span>
          <span class="mission-hero-name">${esc(mission.name)}</span>
          <span class="mission-active-pill">ACTIVE</span>
        </div>

        <div class="mission-inline-editor ${this._isRenameOpen ? 'visible' : ''}">
          <input type="text" class="hud-input" data-field="rename-input" value="${esc(mission.name)}" placeholder="Mission name..." maxlength="60" />
          <button type="button" class="mission-mini-btn accent" data-m-action="save-rename">OK</button>
        </div>
      </div>

      <div class="mission-subtabs" role="tablist">
        ${subTabs
          .map(
            (t) => `
          <button
            type="button"
            class="mission-subtab-btn ${this._detailTab === t.id ? 'active' : ''}"
            data-m-action="switch-subtab"
            data-subtab="${t.id}"
            role="tab"
            aria-selected="${this._detailTab === t.id ? 'true' : 'false'}"
          >${esc(t.label)}</button>
        `
          )
          .join('')}
      </div>

      <div class="mission-scroll-area">
        ${bodyHtml}
      </div>
    `;
  }

  render() {
    if (!this.contentHostEl) return;
    const mission = this.getActiveMission();
    if (!mission || this._panelView === 'list') {
      this.contentHostEl.innerHTML = this._renderListView();
    } else {
      this.contentHostEl.innerHTML = this._renderDetailView(mission);
    }
  }

  _clearGlobeObjects() {
    if (this._renderedTarget) {
      this.group.remove(this._renderedTarget.mesh);
      this._renderedTarget.labelEl.remove();
      this._renderedTarget = null;
    }

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

    // 1. Primary Landing Target reticle
    const site = mission.landingSite;
    if (site && site.visible !== false) {
      const normal = MissionPanel.latLonToNormal(site.lat, site.lon);
      const marker = new THREE.Group();
      const outer = new THREE.Mesh(this._targetRingGeo, this._targetOuterMat);
      const inner = new THREE.Mesh(this._markerInnerGeo, this._pointInnerMat);
      inner.position.z = 0.001;
      marker.add(outer, inner);

      marker.position.copy(normal).multiplyScalar(this.targetRadius);
      marker.quaternion.setFromUnitVectors(this._zAxis, normal);
      marker.renderOrder = 16;
      this.group.add(marker);

      const labelEl = document.createElement('div');
      labelEl.className = 'mission-target-label';
      labelEl.textContent = `TARGET · ${site.name}`;
      labelEl.style.display = 'none';
      this.labelsLayer.appendChild(labelEl);

      this._renderedTarget = { normal, mesh: marker, labelEl };
    }

    // 2. Waypoints
    for (const pt of mission.points) {
      if (pt.visible === false) continue;
      if (
        site &&
        site.visible !== false &&
        Math.abs(pt.lat - site.lat) < 0.0005 &&
        Math.abs(pt.lon - site.lon) < 0.0005
      ) {
        continue;
      }

      const normal = MissionPanel.latLonToNormal(pt.lat, pt.lon);
      const marker = new THREE.Group();
      const outer = new THREE.Mesh(this._markerOuterGeo, this._pointOuterMat);
      const inner = new THREE.Mesh(this._markerInnerGeo, this._pointInnerMat);
      inner.position.z = 0.001;
      marker.add(outer, inner);

      marker.position.copy(normal).multiplyScalar(this.surfaceRadius);
      marker.quaternion.setFromUnitVectors(this._zAxis, normal);
      marker.renderOrder = 15;
      this.group.add(marker);

      const labelEl = document.createElement('div');
      labelEl.className = 'mission-point-label';
      labelEl.textContent = pt.name;
      labelEl.style.display = 'none';
      this.labelsLayer.appendChild(labelEl);

      this._renderedPoints.push({ normal, mesh: marker, labelEl });
    }

    // 3. Saved Ruler Measurements
    for (const m of mission.measurements) {
      if (m.visible === false || !Array.isArray(m.points) || m.points.length < 2) continue;

      const lines = [];
      const dots = [];
      const normals = m.points.map((p) => MissionPanel.latLonToNormal(p.lat, p.lon));

      for (let i = 0; i < normals.length; i++) {
        const n = normals[i];
        const dot = new THREE.Mesh(this._markerInnerGeo, this._rulerVertexMat);
        dot.position.copy(n).multiplyScalar(this.rulerArcRadius);
        dot.quaternion.setFromUnitVectors(this._zAxis, n);
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

    if (
      !this._renderedTarget &&
      this._renderedPoints.length === 0 &&
      this._renderedMeasurements.length === 0
    ) {
      return;
    }

    camera.updateMatrixWorld();
    this.group.updateWorldMatrix(true, false);
    this._invWorldMatrix.copy(this.group.matrixWorld).invert();
    const camPos = this._localCamPos.copy(camera.position).applyMatrix4(this._invWorldMatrix);
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
      this._projVec
        .copy(normal)
        .multiplyScalar(radius)
        .applyMatrix4(this.group.matrixWorld)
        .project(camera);
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

    if (this._renderedTarget) {
      const dist = camPos.distanceTo(this._renderedTarget.mesh.position);
      const worldHeight = 2 * dist * tanHalfFov;
      const worldRadius = (8.0 / height) * worldHeight;
      this._renderedTarget.mesh.scale.set(worldRadius, worldRadius, 1);
      projectToLabel(this._renderedTarget.normal, this.targetRadius, this._renderedTarget.labelEl);
    }

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
    this._createMissionAbort?.abort();
    this._recalcTrajAbort?.abort();
    this._clearGlobeObjects();
    this._markerOuterGeo.dispose();
    this._markerInnerGeo.dispose();
    this._targetRingGeo.dispose();
    this._pointOuterMat.dispose();
    this._pointInnerMat.dispose();
    this._targetOuterMat.dispose();
    this._rulerVertexMat.dispose();
    this._savedLineMaterial.dispose();
    if (this.scene) {
      this.scene.remove(this.group);
    }
    this.rootEl?.remove();
    this.labelsLayer?.remove();
  }
}
