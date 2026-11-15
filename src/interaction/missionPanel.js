import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MOON_CONFIG, TRAJECTORY_CONFIG, VIEW_MODES } from '../config/constants.js';
import {
  computeTransitDurationSec,
  createDefaultMissions,
  createMissionRecord,
  extractTrajectoryMeta,
  formatCoords,
  formatTransitDuration,
  formatUtcCompact,
  formatUtcTimestamp,
  normalizeLandingSite,
  normalizeMission,
  parseDatetimeLocalUtc,
  toDatetimeLocalUtc,
} from '../data/missionModel.js';
import { deleteTrajectoryDoc, saveTrajectoryDoc } from '../data/trajectoryStorage.js';
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
   * @param {Function|null} [options.getCurrentTimelineDate]
   * @param {Function|null} [options.onJumpTimelineToDate]
   * @param {Function|null} [options.getViewMode]
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
    getCurrentTimelineDate = null,
    onJumpTimelineToDate = null,
    getViewMode = null,
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
    this.getCurrentTimelineDate = getCurrentTimelineDate;
    this.onJumpTimelineToDate = onJumpTimelineToDate;
    this.getViewMode = getViewMode;

    const loaded = this._loadState();
    this.missions = loaded.missions;
    this.activeMissionId = loaded.activeMissionId;

    // 'list' | 'detail'
    this._panelView = 'detail';
    // 'flight' | 'traj' | 'surface'
    this._detailTab = 'flight';
    this._listSearchQuery = '';
    this._isRenameOpen = false;
    this._isNewMissionFormOpen = false;
    this._isTargetFormOpen = false;
    this._isAddPointFormOpen = false;
    this._targetFormError = '';
    this._pointFormError = '';
    this._trajStatusMsg = '';
    this._trajErrorMsg = '';
    this._canSaveRuler = false;
    this._collapsedSections = new Set();

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

  openMissionList() {
    this._panelView = 'list';
    this._isRenameOpen = false;
    this.render();
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
      if (e.target.matches('[data-field="list-search"]')) {
        this._listSearchQuery = e.target.value || '';
        this._renderMissionCardsOnly();
      }
    });

    this.contentHostEl.addEventListener('change', (e) => {
      const mission = this.getActiveMission();
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
        this.openMissionList();
        break;
      case 'toggle-new-mission':
        this._isNewMissionFormOpen = !this._isNewMissionFormOpen;
        this.render();
        if (this._isNewMissionFormOpen) {
          this.contentHostEl.querySelector('[data-field="new-mission-name"]')?.focus();
        }
        break;
      case 'cancel-new-mission':
        this._isNewMissionFormOpen = false;
        this.render();
        break;
      case 'clear-list-search':
        this._listSearchQuery = '';
        this.render();
        break;
      case 'activate-mission': {
        const id = btn.dataset.missionId;
        if (id) {
          this.setActiveMission(id);
        }
        break;
      }
      case 'open-mission-detail': {
        const id = btn.dataset.missionId;
        this._panelView = 'detail';
        this._detailTab = 'flight';
        if (id && id !== this.activeMissionId) {
          this.setActiveMission(id);
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
        this.render();
        if (this._isAddPointFormOpen) {
          this.contentHostEl.querySelector('[data-field="point-name"]')?.focus();
        }
        break;
      case 'cancel-point-form':
        this._isAddPointFormOpen = false;
        this._pointFormError = '';
        this.render();
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

  _handleCreateMissionSubmit(formEl) {
    const nameInput = formEl.querySelector('[data-field="new-mission-name"]');
    const notesInput = formEl.querySelector('[data-field="new-mission-notes"]');
    const useDefaultTraj = formEl.querySelector('[data-field="new-mission-default-traj"]')?.checked;
    const rawName = (nameInput?.value || '').trim();
    const name = rawName || `Mission #${this.missions.length + 1}`;
    const notes = (notesInput?.value || '').trim();

    const tlDate = this.getCurrentTimelineDate?.();
    const landingDateIso =
      tlDate instanceof Date && !Number.isNaN(tlDate.getTime()) ? tlDate.toISOString() : null;

    const created = this.createMission({
      name,
      landingDateIso,
      useDefaultTrajectory: Boolean(useDefaultTraj),
      notes,
    });
    this._isNewMissionFormOpen = false;
    this._panelView = 'detail';
    this._detailTab = 'flight';
    this.setActiveMission(created.id);
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

  setActiveMission(missionId) {
    if (!this.missions.some((m) => m.id === missionId)) return;
    this.activeMissionId = missionId;
    this._isRenameOpen = false;
    this._isTargetFormOpen = false;
    this._isAddPointFormOpen = false;
    this._trajStatusMsg = '';
    this._trajErrorMsg = '';
    this._persistState();
    this.render();
    this._rebuildGlobeObjects();
    this._notifyMissionChange({ reason: 'switch' });
  }

  deleteMission(missionId) {
    if (this.missions.length <= 1) return;
    const target = this.missions.find((m) => m.id === missionId);
    if (target?.trajectory?.docId) {
      const stillReferenced = this.missions.some(
        (m) => m.id !== missionId && m.trajectory?.docId === target.trajectory.docId
      );
      if (!stillReferenced) {
        deleteTrajectoryDoc(target.trajectory.docId);
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

  setActiveLandingSite({ name, lat, lon, note = '' }) {
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
    return mission.landingSite;
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

  _getFilteredMissions() {
    const q = this._listSearchQuery.trim().toLowerCase();
    if (!q) return this.missions;
    return this.missions.filter((m) => {
      const hay = [
        m.name,
        m.landingSite?.name,
        m.trajectory?.meta?.rocket,
        m.trajectory?.fileName,
        m.modules?.notes,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  _renderMissionCardsHtml() {
    const esc = MissionPanel.escapeHtml;
    const filtered = this._getFilteredMissions();

    if (filtered.length === 0) {
      return `<div class="mission-empty-box">No missions match "${esc(this._listSearchQuery)}".</div>`;
    }

    return filtered
      .map((m) => {
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
        <input
          type="text"
          class="hud-input"
          data-field="new-mission-name"
          placeholder="Mission name (e.g. Artemis IV — Shackleton)"
          maxlength="60"
        />
        <input
          type="text"
          class="hud-input"
          data-field="new-mission-notes"
          placeholder="Mission objective / notes (optional)"
          maxlength="140"
        />
        <label class="mission-check-row">
          <input type="checkbox" data-field="new-mission-default-traj" />
          <span>Attach default cislunar trajectory template</span>
        </label>
        <div class="mission-coord-grid">
          <button type="button" class="mission-mini-btn" data-m-action="cancel-new-mission">CANCEL</button>
          <button type="submit" class="mission-mini-btn accent">CREATE MISSION</button>
        </div>
      </form>

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

        <form class="mission-add-form ${targetFormClass}" data-form="target-form">
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

        ${this._trajStatusMsg ? `<div class="mission-traj-status">${esc(this._trajStatusMsg)}</div>` : ''}
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
              ${this._sectionArrowHtml('traj-telemetry', 'Collapse / Expand Telemetry Profile')}
            </div>
          </div>
          <div class="mission-block-body ${isTrajTelemetryCollapsed ? 'collapsed' : ''}" style="${isTrajTelemetryCollapsed ? '' : 'display:flex;flex-direction:column;gap:7px;'}">
          <div class="mission-traj-compact">
            <div class="data-row"><span>Vehicle:</span> <span class="data-val val-accent">${esc(meta.rocket)}</span></div>
            <div class="data-row"><span>Spaceport:</span> <span class="data-val">${esc(meta.spaceportName)}</span></div>
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
