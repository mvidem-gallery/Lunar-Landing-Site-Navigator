import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MOON_CONFIG } from '../config/constants.js';
import './rulerTool.css';

const COMPASS_SECTORS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export class RulerTool {
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

  static computeSegmentMetrics(n1, n2) {
    const chordUnit = n1.distanceTo(n2);
    const halfSin = Math.min(1.0, chordUnit * 0.5);
    const angularRad = 2.0 * Math.asin(halfSin);
    const angularDeg = THREE.MathUtils.radToDeg(angularRad);
    const arcMeters = angularRad * MOON_CONFIG.RADIUS_METERS;
    const chordMeters = chordUnit * MOON_CONFIG.RADIUS_METERS;

    let bearingDeg = null;
    if (chordUnit > 1e-9) {
      const p1 = RulerTool.normalToLatLon(n1);
      const p2 = RulerTool.normalToLatLon(n2);
      const lat1 = THREE.MathUtils.degToRad(p1.lat);
      const lat2 = THREE.MathUtils.degToRad(p2.lat);
      const dLon = THREE.MathUtils.degToRad(p2.lon - p1.lon);

      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      bearingDeg = (THREE.MathUtils.radToDeg(Math.atan2(y, x)) + 360) % 360;
    }

    return {
      angularRad,
      angularDeg,
      arcMeters,
      chordMeters,
      bearingDeg,
    };
  }

  static formatDistance(meters) {
    if (!Number.isFinite(meters) || meters < 0) return '0.0 m';
    if (meters < 100) {
      return `${meters.toFixed(2)} m`;
    }
    if (meters < 1000) {
      return `${meters.toFixed(1)} m`;
    }
    const km = meters / 1000;
    if (km < 10) {
      return `${km.toFixed(3)} km`;
    }
    if (km < 100) {
      return `${km.toFixed(2)} km`;
    }
    const parts = km.toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${parts[0]}.${parts[1]} km`;
  }

  static formatCoords(lat, lon) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
  }

  static formatBearing(deg) {
    if (deg === null || !Number.isFinite(deg)) return '—';
    const idx = Math.round(deg / 22.5) % 16;
    return `${deg.toFixed(1).padStart(5, '0')}° (${COMPASS_SECTORS[idx]})`;
  }

  static pointLabel(index) {
    return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
  }

  static slerpArcPositions(n1, n2, radius) {
    const chordUnit = n1.distanceTo(n2);
    const omega = 2.0 * Math.asin(Math.min(1.0, chordUnit * 0.5));
    const positions = [];

    if (omega < 1e-6) {
      positions.push(n1.x * radius, n1.y * radius, n1.z * radius);
      positions.push(n2.x * radius, n2.y * radius, n2.z * radius);
      return positions;
    }

    const steps = Math.max(16, Math.min(192, Math.ceil(THREE.MathUtils.radToDeg(omega) * 2.5)));
    const temp = new THREE.Vector3();

    if (Math.abs(Math.PI - omega) < 1e-4) {
      const ref = Math.abs(n1.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const axis = new THREE.Vector3().crossVectors(n1, ref).normalize();
      for (let i = 0; i <= steps; i++) {
        temp.copy(n1).applyAxisAngle(axis, (i / steps) * Math.PI).multiplyScalar(radius);
        positions.push(temp.x, temp.y, temp.z);
      }
      return positions;
    }

    const sinOmega = Math.sin(omega);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const w1 = Math.sin((1 - t) * omega) / sinOmega;
      const w2 = Math.sin(t * omega) / sinOmega;
      temp
        .set(n1.x * w1 + n2.x * w2, n1.y * w1 + n2.y * w2, n1.z * w1 + n2.z * w2)
        .normalize()
        .multiplyScalar(radius);
      positions.push(temp.x, temp.y, temp.z);
    }

    return positions;
  }

  static computeMidNormal(n1, n2) {
    const mid = new THREE.Vector3().addVectors(n1, n2);
    if (mid.lengthSq() < 1e-8) {
      const ref = Math.abs(n1.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const axis = new THREE.Vector3().crossVectors(n1, ref).normalize();
      return n1.clone().applyAxisAngle(axis, Math.PI * 0.5).normalize();
    }
    return mid.normalize();
  }

  constructor({
    scene,
    camera,
    domElement = null,
    toggleButton = null,
    onSaveToMission = null,
    onStateChange = null,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement || document.getElementById('canvas-container');
    this.toggleButton = toggleButton || document.getElementById('ruler-toggle-btn');
    this.onSaveToMission = onSaveToMission;
    this.onStateChange = onStateChange;

    this.isActive = false;
    this.points = [];
    this.segments = [];
    this.hoverNormal = null;
    this._hoverClientX = 0;
    this._hoverClientY = 0;
    this._downPos = null;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._moonSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), MOON_CONFIG.RADIUS);
    this._hitPoint = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._projVec = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._lastHoverNormal = new THREE.Vector3();
    this._hasLastPreview = false;

    this.surfaceRadius = MOON_CONFIG.RADIUS + 0.000018;

    this.group = new THREE.Group();
    this.group.renderOrder = 15;
    this.scene.add(this.group);

    this.lockedMaterial = new LineMaterial({
      color: 0xffd166,
      linewidth: 2.6,
      transparent: true,
      opacity: 0.96,
      depthTest: true,
      depthWrite: false,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    this.previewMaterial = new LineMaterial({
      color: 0x4fc3f7,
      linewidth: 2.0,
      transparent: true,
      opacity: 0.84,
      depthTest: true,
      depthWrite: false,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    this.lockedLineMeshes = [];
    this.previewLineMesh = null;
    this.markerMeshes = [];
    this._markerOuterGeo = new THREE.RingGeometry(0.62, 1.0, 32);
    this._markerInnerGeo = new THREE.CircleGeometry(0.36, 20);
    this._markerMatOuter = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._markerMatInner = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });

    this._pointBadgeEls = [];
    this._segmentPillEls = [];

    this._buildDOM();
    this._bindEvents();
    this._renderPanel();
  }

  _buildDOM() {
    this.panelEl = document.createElement('div');
    this.panelEl.id = 'ruler-panel';
    this.panelEl.className = 'hud-panel';
    this.panelEl.innerHTML = `
      <div class="panel-header ruler-panel-header">
        <span>DISTANCE RULER</span>
        <span class="ruler-status-badge active" data-field="status">ACTIVE</span>
      </div>
      <div class="ruler-hint" data-field="hint">
        Left-click on the lunar surface to place the first point (drag to rotate camera).
      </div>
      <div class="ruler-summary" data-field="summary" style="display: none;"></div>
      <div class="ruler-segments-list" data-field="segments" style="display: none;"></div>
      <button type="button" class="hud-btn ruler-save-mission-btn" data-action="save-mission" disabled>
        ★ Save Measurement to Mission
      </button>
      <div class="ruler-actions">
        <button type="button" class="hud-btn ruler-action-btn" data-action="undo" title="Remove last point (Backspace)">↩ Undo</button>
        <button type="button" class="hud-btn ruler-action-btn" data-action="finish" title="Lock measurement (Enter)">✓ Done</button>
        <button type="button" class="hud-btn ruler-action-btn danger" data-action="clear" title="Clear measurement (Delete)">✕ Clear</button>
      </div>
    `;

    this.statusBadgeEl = this.panelEl.querySelector('[data-field="status"]');
    this.hintEl = this.panelEl.querySelector('[data-field="hint"]');
    this.summaryEl = this.panelEl.querySelector('[data-field="summary"]');
    this.segmentsListEl = this.panelEl.querySelector('[data-field="segments"]');
    this.saveMissionBtn = this.panelEl.querySelector('[data-action="save-mission"]');
    this.undoBtn = this.panelEl.querySelector('[data-action="undo"]');
    this.finishBtn = this.panelEl.querySelector('[data-action="finish"]');
    this.clearBtn = this.panelEl.querySelector('[data-action="clear"]');
    document.body.appendChild(this.panelEl);

    this.labelsLayer = document.createElement('div');
    this.labelsLayer.id = 'ruler-labels-layer';
    document.body.appendChild(this.labelsLayer);

    this.cursorPillEl = document.createElement('div');
    this.cursorPillEl.className = 'ruler-cursor-pill';
    document.body.appendChild(this.cursorPillEl);
  }

  _bindEvents() {
    if (this.toggleButton) {
      this.toggleButton.addEventListener('click', () => this.toggle());
    }

    this.saveMissionBtn.addEventListener('click', () => {
      const snap = this.getSnapshot();
      if (snap && typeof this.onSaveToMission === 'function') {
        this.onSaveToMission(snap);
      }
    });

    this.undoBtn.addEventListener('click', () => this.undoLastPoint());
    this.finishBtn.addEventListener('click', () => this.finish());
    this.clearBtn.addEventListener('click', () => this.clear());

    this._onPointerDown = (e) => {
      if (!this.isActive || e.button !== 0) return;
      if (!this.domElement || !this.domElement.contains(e.target)) return;
      this._downPos = { x: e.clientX, y: e.clientY };
    };

    this._onPointerUp = (e) => {
      if (!this.isActive || e.button !== 0 || !this._downPos) return;
      const moveDist = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      this._downPos = null;
      if (moveDist > 5) return;
      if (!this.domElement || !this.domElement.contains(e.target)) return;

      const normal = this._raycastMoonNormal(e.clientX, e.clientY);
      if (normal) {
        this.addPointFromNormal(normal);
      }
    };

    this._onPointerMove = (e) => {
      if (!this.isActive) return;
      this._hoverClientX = e.clientX;
      this._hoverClientY = e.clientY;
      if (!this.domElement || !this.domElement.contains(e.target)) {
        this._clearHoverPreview();
        return;
      }
      this.hoverNormal = this._raycastMoonNormal(e.clientX, e.clientY);
      this._updatePreviewVisuals();
    };

    this._onPointerLeave = () => {
      this._clearHoverPreview();
    };

    this._onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.toggle();
        return;
      }

      if (!this.isActive) return;

      if (e.key === 'Escape') {
        this.finish();
      } else if (e.key === 'Enter' && this.points.length >= 2) {
        this.finish();
      } else if ((e.key === 'Backspace' || (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey))) && this.points.length > 0) {
        e.preventDefault();
        this.undoLastPoint();
      } else if (e.key === 'Delete' && this.points.length > 0) {
        e.preventDefault();
        this.clear();
      }
    };

    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointerup', this._onPointerUp, { capture: true });
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    this._onWheel = () => {
      if (!this.isActive) return;
      requestAnimationFrame(() => {
        if (!this.isActive) return;
        this.hoverNormal = this._raycastMoonNormal(this._hoverClientX, this._hoverClientY);
        this._updatePreviewVisuals();
      });
    };
    window.addEventListener('wheel', this._onWheel, { capture: true, passive: true });
    window.addEventListener('blur', this._onPointerLeave);
    window.addEventListener('keydown', this._onKeyDown);
  }

  _notifyState() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange({
        isActive: this.isActive,
        pointsCount: this.points.length,
        canSave: this.points.length >= 2,
      });
    }
  }

  _getCanvasRect() {
    const target = this.domElement?.querySelector('canvas') || this.domElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  _raycastMoonNormal(clientX, clientY) {
    const rect = this._getCanvasRect();
    if (
      clientX < rect.left ||
      clientX > rect.left + rect.width ||
      clientY < rect.top ||
      clientY > rect.top + rect.height
    ) {
      return null;
    }

    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.camera.updateMatrixWorld();
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this._raycaster.ray.intersectSphere(this._moonSphere, this._hitPoint);
    if (!hit) return null;

    return hit.clone().normalize();
  }

  setActive(active) {
    this.isActive = Boolean(active);

    if (this.toggleButton) {
      this.toggleButton.classList.toggle('active', this.isActive);
    }
    if (this.domElement) {
      this.domElement.style.cursor = this.isActive ? 'crosshair' : '';
    }

    if (!this.isActive) {
      this._clearHoverPreview();
    } else if (this._hoverClientX || this._hoverClientY) {
      this.hoverNormal = this._raycastMoonNormal(this._hoverClientX, this._hoverClientY);
      this._updatePreviewVisuals();
    }

    this._renderPanel();
    this._notifyState();
  }

  toggle() {
    this.setActive(!this.isActive);
  }

  finish() {
    this.setActive(false);
  }

  getSnapshot() {
    if (this.points.length < 2) return null;
    const totalArcMeters = this.segments.reduce((acc, s) => acc + s.arcMeters, 0);
    const directMetrics = RulerTool.computeSegmentMetrics(
      this.points[0].normal,
      this.points[this.points.length - 1].normal
    );
    return {
      points: this.points.map((p) => ({
        label: p.label,
        lat: p.lat,
        lon: p.lon,
      })),
      totalArcMeters,
      directChordMeters: directMetrics.chordMeters,
    };
  }

  loadSnapshot(measurement) {
    if (!measurement || !Array.isArray(measurement.points) || measurement.points.length === 0) return;
    this.points = measurement.points.map((p, index) => ({
      index,
      label: p.label || RulerTool.pointLabel(index),
      normal: RulerTool.latLonToNormal(p.lat, p.lon),
      lat: Number(p.lat),
      lon: Number(p.lon),
    }));
    this._rebuildSegmentsAndVisuals();
    this._updatePreviewVisuals();
    this._renderPanel();
    this._notifyState();
  }

  addPointFromNormal(normal) {
    if (!normal) return;

    if (this.points.length > 0) {
      const prev = this.points[this.points.length - 1].normal;
      if (prev.distanceTo(normal) < 1e-8) {
        return;
      }
    }

    const { lat, lon } = RulerTool.normalToLatLon(normal);
    const point = {
      index: this.points.length,
      label: RulerTool.pointLabel(this.points.length),
      normal: normal.clone().normalize(),
      lat,
      lon,
    };

    this.points.push(point);
    this._rebuildSegmentsAndVisuals();
    this._updatePreviewVisuals();
    this._renderPanel();
    this._notifyState();
  }

  undoLastPoint() {
    if (this.points.length === 0) return;
    this.points.pop();
    this._rebuildSegmentsAndVisuals();
    this._updatePreviewVisuals();
    this._renderPanel();
    this._notifyState();
  }

  clear() {
    this.points = [];
    this.segments = [];
    this._clearHoverPreview();
    this._rebuildSegmentsAndVisuals();
    this._renderPanel();
    this._notifyState();
  }

  _clearHoverPreview() {
    this.hoverNormal = null;
    this._hasLastPreview = false;
    if (this.previewLineMesh) {
      this.previewLineMesh.visible = false;
    }
    if (this.cursorPillEl) {
      this.cursorPillEl.style.display = 'none';
    }
  }

  _createMarkerMesh(normal) {
    const holder = new THREE.Group();
    const outer = new THREE.Mesh(this._markerOuterGeo, this._markerMatOuter);
    const inner = new THREE.Mesh(this._markerInnerGeo, this._markerMatInner);
    inner.position.z = 0.01;
    holder.add(outer);
    holder.add(inner);

    holder.position.copy(normal).multiplyScalar(this.surfaceRadius);
    this._lookTarget.copy(holder.position).add(normal);
    holder.lookAt(this._lookTarget);
    holder.renderOrder = 16;
    holder.userData.normal = normal.clone();
    this.group.add(holder);
    return holder;
  }

  _rebuildSegmentsAndVisuals() {
    for (const mesh of this.lockedLineMeshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.lockedLineMeshes = [];

    for (const marker of this.markerMeshes) {
      this.group.remove(marker);
    }
    this.markerMeshes = [];

    for (const badge of this._pointBadgeEls) {
      badge.remove();
    }
    this._pointBadgeEls = [];

    for (const pill of this._segmentPillEls) {
      pill.remove();
    }
    this._segmentPillEls = [];

    this.segments = [];

    for (let i = 0; i < this.points.length; i++) {
      const pt = this.points[i];
      this.markerMeshes.push(this._createMarkerMesh(pt.normal));

      const badge = document.createElement('div');
      badge.className = 'ruler-point-badge';
      badge.textContent = pt.label;
      this.labelsLayer.appendChild(badge);
      this._pointBadgeEls.push(badge);
    }

    for (let i = 0; i < this.points.length - 1; i++) {
      const p1 = this.points[i];
      const p2 = this.points[i + 1];
      const metrics = RulerTool.computeSegmentMetrics(p1.normal, p2.normal);
      const midNormal = RulerTool.computeMidNormal(p1.normal, p2.normal);

      this.segments.push({
        from: p1,
        to: p2,
        midNormal,
        ...metrics,
      });

      const positions = RulerTool.slerpArcPositions(p1.normal, p2.normal, this.surfaceRadius);
      const geom = new LineGeometry();
      geom.setPositions(positions);

      const lineMesh = new Line2(geom, this.lockedMaterial);
      lineMesh.renderOrder = 15;
      this.group.add(lineMesh);
      this.lockedLineMeshes.push(lineMesh);

      const pill = document.createElement('div');
      pill.className = 'ruler-segment-pill';
      pill.textContent = RulerTool.formatDistance(metrics.arcMeters);
      this.labelsLayer.appendChild(pill);
      this._segmentPillEls.push(pill);
    }
  }

  _updatePreviewVisuals() {
    if (!this.isActive || !this.hoverNormal) {
      if (this.previewLineMesh) this.previewLineMesh.visible = false;
      this.cursorPillEl.style.display = 'none';
      return;
    }

    if (this.points.length === 0) {
      if (this.previewLineMesh) this.previewLineMesh.visible = false;
      const { lat, lon } = RulerTool.normalToLatLon(this.hoverNormal);
      this.cursorPillEl.textContent = `+ A (${RulerTool.formatCoords(lat, lon)})`;
      this.cursorPillEl.style.left = `${Math.min(window.innerWidth - 170, this._hoverClientX + 16)}px`;
      this.cursorPillEl.style.top = `${Math.max(8, this._hoverClientY - 12)}px`;
      this.cursorPillEl.style.display = 'block';
      return;
    }

    const lastPt = this.points[this.points.length - 1];
    const metrics = RulerTool.computeSegmentMetrics(lastPt.normal, this.hoverNormal);

    if (!this._hasLastPreview || this._lastHoverNormal.distanceToSquared(this.hoverNormal) > 1e-14) {
      this._lastHoverNormal.copy(this.hoverNormal);
      this._hasLastPreview = true;

      const positions = RulerTool.slerpArcPositions(
        lastPt.normal,
        this.hoverNormal,
        this.surfaceRadius
      );
      const geom = new LineGeometry();
      geom.setPositions(positions);

      if (this.previewLineMesh) {
        this.previewLineMesh.geometry.dispose();
        this.previewLineMesh.geometry = geom;
      } else {
        this.previewLineMesh = new Line2(geom, this.previewMaterial);
        this.previewLineMesh.renderOrder = 15;
        this.group.add(this.previewLineMesh);
      }
    }

    if (this.previewLineMesh) {
      this.previewLineMesh.visible = true;
    }

    const existingTotal = this.segments.reduce((acc, seg) => acc + seg.arcMeters, 0);
    const liveDistText = RulerTool.formatDistance(metrics.arcMeters);
    const bearingText = metrics.bearingDeg !== null ? ` · ${metrics.bearingDeg.toFixed(1)}°` : '';

    if (this.segments.length > 0) {
      const totalWithPreview = RulerTool.formatDistance(existingTotal + metrics.arcMeters);
      this.cursorPillEl.textContent = `+${liveDistText}${bearingText} | Σ ${totalWithPreview}`;
    } else {
      this.cursorPillEl.textContent = `${liveDistText}${bearingText}`;
    }

    this.cursorPillEl.style.left = `${Math.min(window.innerWidth - 210, this._hoverClientX + 16)}px`;
    this.cursorPillEl.style.top = `${Math.max(8, this._hoverClientY - 12)}px`;
    this.cursorPillEl.style.display = 'block';
  }

  _renderPanel() {
    const shouldShow = this.isActive || this.points.length > 0;
    this.panelEl.classList.toggle('visible', shouldShow);
    if (!shouldShow) return;

    this.statusBadgeEl.textContent = this.isActive ? 'ACTIVE' : 'LOCKED';
    this.statusBadgeEl.className = `ruler-status-badge ${this.isActive ? 'active' : 'locked'}`;

    this.saveMissionBtn.disabled = this.points.length < 2;
    this.undoBtn.disabled = this.points.length === 0;
    this.finishBtn.disabled = !this.isActive;
    this.clearBtn.disabled = this.points.length === 0;

    if (this.points.length === 0) {
      this.hintEl.textContent =
        'Left-click on the lunar surface to place point A (drag to rotate camera).';
      this.hintEl.style.display = 'block';
      this.summaryEl.style.display = 'none';
      this.segmentsListEl.style.display = 'none';
      return;
    }

    if (this.points.length === 1) {
      const p0 = this.points[0];
      this.hintEl.textContent = `Point A (${RulerTool.formatCoords(p0.lat, p0.lon)}) placed. Click a second point to measure.`;
      this.hintEl.style.display = 'block';
      this.summaryEl.style.display = 'none';
      this.segmentsListEl.style.display = 'none';
      return;
    }

    this.hintEl.style.display = 'none';
    this.summaryEl.style.display = 'flex';
    this.segmentsListEl.style.display = 'flex';

    const totalArcMeters = this.segments.reduce((acc, s) => acc + s.arcMeters, 0);
    const totalDeg = this.segments.reduce((acc, s) => acc + s.angularDeg, 0);
    const firstPt = this.points[0];
    const lastPt = this.points[this.points.length - 1];
    const directMetrics = RulerTool.computeSegmentMetrics(firstPt.normal, lastPt.normal);

    if (this.segments.length === 1) {
      const seg = this.segments[0];
      this.summaryEl.innerHTML = `
        <div class="data-row">
          <span>Surface (Arc):</span>
          <span class="data-val ruler-total-val">${RulerTool.formatDistance(seg.arcMeters)}</span>
        </div>
        <div class="data-row">
          <span>Direct (Chord):</span>
          <span class="data-val ruler-chord-val">${RulerTool.formatDistance(seg.chordMeters)}</span>
        </div>
        <div class="data-row">
          <span>Bearing (${firstPt.label} → ${lastPt.label}):</span>
          <span class="data-val">${RulerTool.formatBearing(seg.bearingDeg)}</span>
        </div>
        <div class="data-row">
          <span>Angular Arc:</span>
          <span class="data-val">${seg.angularDeg.toFixed(4)}°</span>
        </div>
      `;
    } else {
      this.summaryEl.innerHTML = `
        <div class="data-row">
          <span>Route (${this.segments.length} seg):</span>
          <span class="data-val ruler-total-val">${RulerTool.formatDistance(totalArcMeters)}</span>
        </div>
        <div class="data-row">
          <span>Arc ${firstPt.label} → ${lastPt.label}:</span>
          <span class="data-val">${RulerTool.formatDistance(directMetrics.arcMeters)}</span>
        </div>
        <div class="data-row">
          <span>Chord ${firstPt.label} → ${lastPt.label}:</span>
          <span class="data-val ruler-chord-val">${RulerTool.formatDistance(directMetrics.chordMeters)}</span>
        </div>
        <div class="data-row">
          <span>Total Angle:</span>
          <span class="data-val">${totalDeg.toFixed(3)}°</span>
        </div>
      `;
    }

    this.segmentsListEl.innerHTML = this.segments
      .map((seg) => {
        const fromCoords = RulerTool.formatCoords(seg.from.lat, seg.from.lon);
        const toCoords = RulerTool.formatCoords(seg.to.lat, seg.to.lon);
        return `
          <div class="ruler-segment-item">
            <div class="ruler-segment-top">
              <span class="ruler-segment-name">${seg.from.label} → ${seg.to.label}</span>
              <span class="ruler-segment-dist">${RulerTool.formatDistance(seg.arcMeters)}</span>
            </div>
            <div class="ruler-segment-sub">
              <span>Brg: ${RulerTool.formatBearing(seg.bearingDeg)}</span>
              <span>Chord: ${RulerTool.formatDistance(seg.chordMeters)}</span>
            </div>
            <div class="ruler-segment-sub">
              <span>${fromCoords}</span>
              <span>${toCoords}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  _projectLabel(el, normal, camPos, camDist, horizonCos, rect, fovRad) {
    if (normal.dot(this._camDir) < horizonCos - 0.002) {
      el.style.display = 'none';
      return;
    }

    this._projVec.copy(normal).multiplyScalar(this.surfaceRadius).project(this.camera);
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

    const screenX = rect.left + (this._projVec.x * 0.5 + 0.5) * rect.width;
    const screenY = rect.top + (-this._projVec.y * 0.5 + 0.5) * rect.height;
    el.style.left = `${screenX.toFixed(1)}px`;
    el.style.top = `${screenY.toFixed(1)}px`;
    el.style.display = 'block';

    void camPos;
    void camDist;
    void fovRad;
  }

  update(camera) {
    if (!camera) return;

    const rect = this._getCanvasRect();
    this.lockedMaterial.resolution.set(rect.width, rect.height);
    this.previewMaterial.resolution.set(rect.width, rect.height);

    if (this.points.length === 0) return;

    camera.updateMatrixWorld();
    const camPos = camera.position;
    const camDist = camPos.length();
    this._camDir.copy(camPos).divideScalar(camDist);

    const horizonCos = MOON_CONFIG.RADIUS / camDist;
    const fovRad = THREE.MathUtils.degToRad(camera.fov || 45);
    const tanHalfFov = Math.tan(fovRad * 0.5);

    for (let i = 0; i < this.markerMeshes.length; i++) {
      const marker = this.markerMeshes[i];
      const distToMarker = camPos.distanceTo(marker.position);
      const worldHeight = 2 * distToMarker * tanHalfFov;
      const worldRadius = (7.5 / rect.height) * worldHeight;
      marker.scale.set(worldRadius, worldRadius, 1);

      const badge = this._pointBadgeEls[i];
      if (badge) {
        this._projectLabel(badge, this.points[i].normal, camPos, camDist, horizonCos, rect, fovRad);
      }
    }

    for (let i = 0; i < this.segments.length; i++) {
      const pill = this._segmentPillEls[i];
      if (pill) {
        this._projectLabel(pill, this.segments[i].midNormal, camPos, camDist, horizonCos, rect, fovRad);
      }
    }
  }

  dispose() {
    window.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    window.removeEventListener('blur', this._onPointerLeave);
    window.removeEventListener('keydown', this._onKeyDown);

    this.clear();
    if (this.previewLineMesh) {
      this.group.remove(this.previewLineMesh);
      this.previewLineMesh.geometry.dispose();
    }
    this.lockedMaterial.dispose();
    this.previewMaterial.dispose();
    this._markerOuterGeo.dispose();
    this._markerInnerGeo.dispose();
    this._markerMatOuter.dispose();
    this._markerMatInner.dispose();
    this.scene.remove(this.group);

    this.panelEl?.remove();
    this.labelsLayer?.remove();
    this.cursorPillEl?.remove();
  }
}
