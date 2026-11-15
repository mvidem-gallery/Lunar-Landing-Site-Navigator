import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOON_CONFIG, EARTH_CONFIG, LOD_CONFIG, VIEW_MODES } from '../config/constants.js';

function shortestAngleDeltaDeg(fromDeg, toDeg) {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();

    this.initialDistance = 3.5;
    this.referenceAltitude = this.initialDistance - MOON_CONFIG.RADIUS;
    this.moonRadiusKm = MOON_CONFIG.RADIUS_KM;

    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.000005,
      6000
    );
    this.camera.position.set(this.initialDistance, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enableZoom = false;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.panSpeed = 1.0;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: -1,
    };

    this.viewMode = VIEW_MODES.LUNAR;
    this.minSurfaceClearance = 0.00003;
    this.minLunarDistance = MOON_CONFIG.RADIUS + this.minSurfaceClearance;
    this.maxLunarDistance = 7.0;
    this.maxLunarPanRadius = MOON_CONFIG.RADIUS * 1.4;

    this.minPointAltitude = 0.000018;
    this.defaultPointAltitude = 0.000045;
    this.maxPointAltitude = 0.003;
    this.pointViewState = {
      active: false,
      latDeg: 0,
      lonDeg: 0,
      label: null,
      azimuthDeg: 0,
      elevationDeg: 5,
      targetAzimuthDeg: 0,
      targetElevationDeg: 5,
      altitudeUnits: this.defaultPointAltitude,
      targetAltitudeUnits: this.defaultPointAltitude,
    };
    this._pointUp = new THREE.Vector3(1, 0, 0);
    this._pointEast = new THREE.Vector3(0, 0, -1);
    this._pointNorth = new THREE.Vector3(0, 1, 0);
    this._pointEyePos = new THREE.Vector3();
    this._pointHorizDir = new THREE.Vector3();
    this._pointLookDir = new THREE.Vector3();
    this._pointLookTarget = new THREE.Vector3();
    this._pointDrag = {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      moved: false,
    };

    this.cislunarDistance = EARTH_CONFIG.CISLUNAR_DISTANCE;
    this.cislunarEarthDir = new THREE.Vector3(1, 0, 0);
    this.cislunarTarget = new THREE.Vector3();
    this._moonCenter = new THREE.Vector3(0, 0, 0);
    this._earthCenter = new THREE.Vector3(this.cislunarDistance, 0, 0);
    this._cislunarFigure = null;
    this.cislunarCameraOffset = new THREE.Vector3();
    this.cislunarFocus = 'SYSTEM';
    this.minCislunarDistance = Math.max(7.5, this.cislunarDistance * 0.5);
    this.maxCislunarDistance = Math.max(38.0, this.cislunarDistance * 2.6);
    this._updateCislunarFraming();

    this.minRadialDistance = this.minLunarDistance;
    this.maxRadialDistance = this.maxLunarDistance;
    this.controls.minDistance = this.minRadialDistance;
    this.controls.maxDistance = this.maxRadialDistance;

    this.targetRadialDistance = this.camera.position.length();
    this._desiredTarget = new THREE.Vector3(0, 0, 0);
    this._savedLunarCamera = null;
    this.onUpdateCallback = null;
    this.onViewModeChangeCallback = null;
    this.onCislunarFocusChangeCallback = null;
    this.onPointViewChangeCallback = null;
    this._flyAnim = null;

    this._tmpOffset = new THREE.Vector3();
    this._tmpDeltaTarget = new THREE.Vector3();
    this._tmpCollisionVec = new THREE.Vector3();
    this._tmpSystemCenter = new THREE.Vector3();

    this.setupSmoothAltitudeZoom();
    this._bindPointViewEvents();
    this.renderer.domElement.addEventListener(
      'pointerdown',
      (event) => {
        this._flyAnim = null;
        if (event.button === 0 && this.viewMode !== VIEW_MODES.POINT) {
          this.controls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
        }
      },
      { capture: true }
    );

    const syncAltPanMode = (altPressed) => {
      if (this.viewMode === VIEW_MODES.POINT) {
        this.renderer.domElement.style.cursor = this._pointDrag.active ? 'grabbing' : 'grab';
        return;
      }
      this.controls.mouseButtons.LEFT = altPressed ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      this.renderer.domElement.style.cursor = altPressed ? 'move' : '';
    };
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Alt') {
        event.preventDefault();
        syncAltPanMode(true);
      }
    });
    window.addEventListener('keyup', (event) => {
      if (event.key === 'Alt') {
        syncAltPanMode(false);
      }
    });
    window.addEventListener('blur', () => syncAltPanMode(false));
    window.addEventListener('resize', this.onResize.bind(this));
  }

  static computePointBasis(
    latDeg,
    lonDeg,
    outUp = new THREE.Vector3(),
    outEast = new THREE.Vector3(),
    outNorth = new THREE.Vector3()
  ) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    outUp
      .set(
        Math.cos(latRad) * Math.cos(lonRad),
        Math.sin(latRad),
        -Math.cos(latRad) * Math.sin(lonRad)
      )
      .normalize();
    outEast.set(-Math.sin(lonRad), 0, -Math.cos(lonRad)).normalize();
    outNorth.crossVectors(outUp, outEast).normalize();
    return { up: outUp, east: outEast, north: outNorth };
  }

  _bindPointViewEvents() {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointerdown', (event) => {
      if (this.viewMode !== VIEW_MODES.POINT) return;
      if (event.button !== 0 && event.button !== 2) return;
      this._pointDrag.active = true;
      this._pointDrag.pointerId = event.pointerId;
      this._pointDrag.lastX = event.clientX;
      this._pointDrag.lastY = event.clientY;
      this._pointDrag.moved = false;
      dom.style.cursor = 'grabbing';
    });

    window.addEventListener('pointermove', (event) => {
      if (this.viewMode !== VIEW_MODES.POINT || !this._pointDrag.active) return;
      if (this._pointDrag.pointerId !== null && event.pointerId !== this._pointDrag.pointerId) return;
      const dx = event.clientX - this._pointDrag.lastX;
      const dy = event.clientY - this._pointDrag.lastY;
      this._pointDrag.lastX = event.clientX;
      this._pointDrag.lastY = event.clientY;
      if (Math.hypot(dx, dy) > 0) {
        this._pointDrag.moved = true;
      }

      const lookSensitivity = 0.22;
      this.pointViewState.targetAzimuthDeg -= dx * lookSensitivity;
      this.pointViewState.targetElevationDeg = THREE.MathUtils.clamp(
        this.pointViewState.targetElevationDeg + dy * lookSensitivity,
        -70,
        85
      );
    });

    const endDrag = (event) => {
      if (!this._pointDrag.active) return;
      if (this._pointDrag.pointerId !== null && event.pointerId !== this._pointDrag.pointerId) return;
      this._pointDrag.active = false;
      this._pointDrag.pointerId = null;
      if (this.viewMode === VIEW_MODES.POINT) {
        dom.style.cursor = 'grab';
      }
    };

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  _updateCislunarFraming() {
    const refMoon = (this.cislunarFocus === 'SYSTEM' && this._cislunarFigure?.refMoonCenter) || this._moonCenter;
    const spanVec = new THREE.Vector3().subVectors(this._earthCenter, refMoon);
    const D = Math.max(1.0, spanVec.length() || this.cislunarDistance);
    const earthAxis =
      spanVec.lengthSq() > 1e-8
        ? spanVec.normalize()
        : this.cislunarEarthDir.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const sideAxis = new THREE.Vector3().crossVectors(earthAxis, worldUp);
    if (sideAxis.lengthSq() < 1e-6) {
      sideAxis.set(0, 0, 1);
    } else {
      sideAxis.normalize();
    }
    const camUp = new THREE.Vector3().crossVectors(sideAxis, earthAxis).normalize();

    if (this.cislunarFocus === 'EARTH') {
      const rE = EARTH_CONFIG.RADIUS;
      this.cislunarTarget.copy(this._earthCenter);
      this.cislunarCameraOffset
        .copy(sideAxis)
        .multiplyScalar(rE * 2.15)
        .addScaledVector(camUp, rE * 0.95)
        .addScaledVector(earthAxis, -rE * 1.55);
      this.minCislunarDistance = rE + 0.14;
      this.maxCislunarDistance = Math.max(24.0, this.cislunarDistance * 1.8);
    } else if (this.cislunarFocus === 'MOON') {
      const rM = MOON_CONFIG.RADIUS;
      this.cislunarTarget.copy(this._moonCenter);
      this.cislunarCameraOffset
        .copy(earthAxis)
        .multiplyScalar(rM * 2.1)
        .addScaledVector(camUp, rM * 0.95)
        .addScaledVector(sideAxis, rM * 2.4);
      this.minCislunarDistance = rM + 0.015;
      this.maxCislunarDistance = Math.max(16.0, this.cislunarDistance * 1.2);
    } else {
      // Центруємо огляд у геометричному центрі фігури (Земля + Місяць + траєкторія)
      let frameD = D;
      if (this._cislunarFigure) {
        this.cislunarTarget.copy(this._cislunarFigure.center);
        frameD = Math.max(D, this._cislunarFigure.radius * 1.45);
        this.minCislunarDistance = Math.max(6.5, this._cislunarFigure.radius * 0.12);
        this.maxCislunarDistance = Math.max(38.0, this._cislunarFigure.radius * 3.8);
      } else {
        const rE = EARTH_CONFIG.RADIUS;
        const rM = MOON_CONFIG.RADIUS;
        const minX = Math.min(this._earthCenter.x - rE, this._moonCenter.x - rM);
        const maxX = Math.max(this._earthCenter.x + rE, this._moonCenter.x + rM);
        const minY = Math.min(this._earthCenter.y - rE, this._moonCenter.y - rM);
        const maxY = Math.max(this._earthCenter.y + rE, this._moonCenter.y + rM);
        const minZ = Math.min(this._earthCenter.z - rE, this._moonCenter.z - rM);
        const maxZ = Math.max(this._earthCenter.z + rE, this._moonCenter.z + rM);
        this.cislunarTarget.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        this.minCislunarDistance = Math.max(7.5, this.cislunarDistance * 0.5);
        this.maxCislunarDistance = Math.max(38.0, this.cislunarDistance * 2.6);
      }
      this.cislunarCameraOffset
        .copy(earthAxis)
        .multiplyScalar(-frameD * 0.25)
        .addScaledVector(camUp, frameD * 0.42)
        .addScaledVector(sideAxis, frameD * 1.75);
    }
  }

  setCislunarFigure(figure, { animate = false } = {}) {
    if (figure && Array.isArray(figure.center)) {
      this._cislunarFigure = {
        center: new THREE.Vector3(figure.center[0], figure.center[1], figure.center[2]),
        radius: Number.isFinite(figure.radius) ? figure.radius : this.cislunarDistance * 0.75,
        refMoonCenter: Array.isArray(figure.refMoonCenter)
          ? new THREE.Vector3(figure.refMoonCenter[0], figure.refMoonCenter[1], figure.refMoonCenter[2])
          : null,
      };
    } else {
      this._cislunarFigure = null;
    }

    this._updateCislunarFraming();
    if (this.viewMode === VIEW_MODES.CISLUNAR && this.cislunarFocus === 'SYSTEM') {
      if (animate) {
        this.setCislunarFocus('SYSTEM', { animate: true });
      } else {
        this.minRadialDistance = this.minCislunarDistance;
        this.maxRadialDistance = this.maxCislunarDistance;
        this.controls.minDistance = this.minRadialDistance;
        this.controls.maxDistance = this.maxRadialDistance;
        this._desiredTarget.copy(this.cislunarTarget);
      }
    }
  }

  _normalizeCislunarFocus(focus) {
    if (focus === 'EARTH' || focus === 'MOON') return focus;
    return 'SYSTEM';
  }

  setCislunarDistance(distance) {
    if (!Number.isFinite(distance) || distance <= 1) return;
    this.cislunarDistance = distance;
    if (!this._cislunarFigure) {
      this._earthCenter.copy(this.cislunarEarthDir).multiplyScalar(this.cislunarDistance);
    }
    this._updateCislunarFraming();
    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      this.minRadialDistance = this.minCislunarDistance;
      this.maxRadialDistance = this.maxCislunarDistance;
      this.controls.minDistance = this.minRadialDistance;
      this.controls.maxDistance = this.maxRadialDistance;
      this._desiredTarget.copy(this.cislunarTarget);
    }
  }

  setEarthDirection(vec3) {
    if (!vec3 || vec3.lengthSq() < 1e-8) return;
    this.cislunarEarthDir.copy(vec3).normalize();
    this._moonCenter.set(0, 0, 0);
    this._earthCenter.copy(this.cislunarEarthDir).multiplyScalar(this.cislunarDistance);
    this._updateCislunarFraming();
    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      this._desiredTarget.copy(this.cislunarTarget);
    }
  }

  setCislunarBodyPositions(earthPos, moonPos) {
    const prevTargetX = this._desiredTarget.x;
    const prevTargetY = this._desiredTarget.y;
    const prevTargetZ = this._desiredTarget.z;
    if (earthPos) this._earthCenter.copy(earthPos);
    if (moonPos) this._moonCenter.copy(moonPos);
    const toEarth = new THREE.Vector3().subVectors(this._earthCenter, this._moonCenter);
    if (toEarth.lengthSq() > 1e-8) {
      this.cislunarEarthDir.copy(toEarth).normalize();
    }
    this._updateCislunarFraming();
    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      this.minRadialDistance = this.minCislunarDistance;
      this.maxRadialDistance = this.maxCislunarDistance;
      this.controls.minDistance = this.minRadialDistance;
      this.controls.maxDistance = this.maxRadialDistance;
      this._desiredTarget.copy(this.cislunarTarget);
      this._tmpDeltaTarget.set(
        this._desiredTarget.x - prevTargetX,
        this._desiredTarget.y - prevTargetY,
        this._desiredTarget.z - prevTargetZ
      );
      if (this._flyAnim) {
        this._flyAnim.targetPoint.copy(this._desiredTarget);
      } else if (this._tmpDeltaTarget.lengthSq() > 1e-12) {
        // Рухаємо ціль і камеру синхронно з орбітою тіла без дрейфу OrbitControls
        this.controls.target.add(this._tmpDeltaTarget);
        this.camera.position.add(this._tmpDeltaTarget);
      }
    }
  }

  onViewModeChange(callback) {
    this.onViewModeChangeCallback = callback;
  }

  onCislunarFocusChange(callback) {
    this.onCislunarFocusChangeCallback = callback;
  }

  onPointViewChange(callback) {
    this.onPointViewChangeCallback = callback;
  }

  getPointViewState() {
    if (this.viewMode !== VIEW_MODES.POINT) return null;
    const wrappedAz = ((this.pointViewState.azimuthDeg % 360) + 360) % 360;
    return {
      active: true,
      latDeg: this.pointViewState.latDeg,
      lonDeg: this.pointViewState.lonDeg,
      label: this.pointViewState.label,
      azimuthDeg: wrappedAz,
      elevationDeg: this.pointViewState.elevationDeg,
      altitudeUnits: this.pointViewState.altitudeUnits,
      altitudeMeters: this.pointViewState.altitudeUnits * MOON_CONFIG.RADIUS_METERS,
      up: this._pointUp,
      east: this._pointEast,
      north: this._pointNorth,
    };
  }

  getCislunarFocus() {
    return this.cislunarFocus;
  }

  setCislunarFocus(focus, { animate = true } = {}) {
    const nextFocus = this._normalizeCislunarFocus(focus);
    this.cislunarFocus = nextFocus;
    this.onCislunarFocusChangeCallback?.(nextFocus);

    if (this.viewMode !== VIEW_MODES.CISLUNAR) {
      return nextFocus;
    }

    const currentTarget = this.controls.target.clone();
    const currentOffset = this.camera.position.clone().sub(currentTarget);
    const currentDist = Math.max(0.0001, currentOffset.length());
    const currentDir = currentOffset.divideScalar(currentDist);

    this._updateCislunarFraming();
    this.minRadialDistance = this.minCislunarDistance;
    this.maxRadialDistance = this.maxCislunarDistance;
    this.controls.minDistance = this.minRadialDistance;
    this.controls.maxDistance = this.maxRadialDistance;
    this._desiredTarget.copy(this.cislunarTarget);

    const endOffset = this.cislunarCameraOffset.clone();
    const endDist = endOffset.length();
    const endDir = endOffset.clone().divideScalar(Math.max(1e-6, endDist));
    this.targetRadialDistance = THREE.MathUtils.clamp(endDist, this.minRadialDistance, this.maxRadialDistance);

    if (animate) {
      this._flyAnim = {
        startTarget: currentTarget,
        targetPoint: this.cislunarTarget.clone(),
        startDir: currentDir,
        targetDir: endDir,
        startDist: currentDist,
        targetDist: this.targetRadialDistance,
        startTime: performance.now(),
        durationMs: 750,
      };
    } else {
      this._flyAnim = null;
      this.controls.target.copy(this.cislunarTarget);
      this.camera.position.copy(this.cislunarTarget).addScaledVector(endDir, this.targetRadialDistance);
    }

    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    return nextFocus;
  }

  _normalizeViewMode(mode) {
    if (mode === VIEW_MODES.CISLUNAR || mode === 'CISLUNAR_VIEW') {
      return VIEW_MODES.CISLUNAR;
    }
    if (mode === VIEW_MODES.POINT || mode === 'POINT_VIEW') {
      return VIEW_MODES.POINT;
    }
    return VIEW_MODES.LUNAR;
  }

  _saveCurrentLunarCamera() {
    const distFromOrigin = this.camera.position.length();
    const dir =
      distFromOrigin > 0.0001
        ? this.camera.position.clone().divideScalar(distFromOrigin)
        : new THREE.Vector3(1, 0, 0);
    this._savedLunarCamera = {
      direction: dir,
      distance: THREE.MathUtils.clamp(
        this.targetRadialDistance,
        this.minLunarDistance,
        this.maxLunarDistance
      ),
    };
  }

  _applyPointViewCamera(damping = 0.22) {
    const s = this.pointViewState;
    const azDelta = shortestAngleDeltaDeg(s.azimuthDeg, s.targetAzimuthDeg);
    s.azimuthDeg += azDelta * damping;
    s.elevationDeg = THREE.MathUtils.lerp(s.elevationDeg, s.targetElevationDeg, damping);
    s.altitudeUnits = THREE.MathUtils.lerp(s.altitudeUnits, s.targetAltitudeUnits, damping);

    this._pointEyePos
      .copy(this._pointUp)
      .multiplyScalar(MOON_CONFIG.RADIUS + s.altitudeUnits);

    const azRad = THREE.MathUtils.degToRad(s.azimuthDeg);
    const elRad = THREE.MathUtils.degToRad(s.elevationDeg);

    this._pointHorizDir
      .copy(this._pointNorth)
      .multiplyScalar(Math.cos(azRad))
      .addScaledVector(this._pointEast, Math.sin(azRad))
      .normalize();

    this._pointLookDir
      .copy(this._pointHorizDir)
      .multiplyScalar(Math.cos(elRad))
      .addScaledVector(this._pointUp, Math.sin(elRad))
      .normalize();

    this.camera.up.copy(this._pointUp);
    this.camera.position.copy(this._pointEyePos);
    this._pointLookTarget.copy(this._pointEyePos).add(this._pointLookDir);
    this.camera.lookAt(this._pointLookTarget);
  }

  enterPointView({
    latDeg = 0,
    lonDeg = 0,
    label = null,
    initialLookDir = null,
    altitudeUnits = null,
  } = {}) {
    if (this.viewMode === VIEW_MODES.LUNAR) {
      this._saveCurrentLunarCamera();
    }

    this.viewMode = VIEW_MODES.POINT;
    this._flyAnim = null;
    this.controls.enabled = false;
    this._pointDrag.active = false;
    this.renderer.domElement.style.cursor = 'grab';

    const clampedLat = THREE.MathUtils.clamp(Number(latDeg) || 0, -89.99, 89.99);
    const clampedLon = Number.isFinite(Number(lonDeg)) ? Number(lonDeg) : 0;
    SceneManager.computePointBasis(
      clampedLat,
      clampedLon,
      this._pointUp,
      this._pointEast,
      this._pointNorth
    );

    let initAz = 0;
    let initEl = 6;
    if (initialLookDir && initialLookDir.lengthSq() > 1e-8) {
      const dir = initialLookDir.clone().normalize();
      const upComp = THREE.MathUtils.clamp(dir.dot(this._pointUp), -1, 1);
      const rawEl = THREE.MathUtils.radToDeg(Math.asin(upComp));
      if (rawEl > -12) {
        initAz = THREE.MathUtils.radToDeg(
          Math.atan2(dir.dot(this._pointEast), dir.dot(this._pointNorth))
        );
        initEl = THREE.MathUtils.clamp(rawEl, -8, 78);
      }
    }

    const startAlt = THREE.MathUtils.clamp(
      Number.isFinite(altitudeUnits) ? altitudeUnits : this.defaultPointAltitude,
      this.minPointAltitude,
      this.maxPointAltitude
    );

    this.pointViewState = {
      active: true,
      latDeg: clampedLat,
      lonDeg: clampedLon,
      label: label || null,
      azimuthDeg: initAz,
      elevationDeg: initEl,
      targetAzimuthDeg: initAz,
      targetElevationDeg: initEl,
      altitudeUnits: startAlt,
      targetAltitudeUnits: startAlt,
    };

    this._applyPointViewCamera(1.0);
    this.onPointViewChangeCallback?.(this.getPointViewState());
    return this.pointViewState;
  }

  lookInPointView(targetDirOrNorth, { elevationDeg = null, animate = true } = {}) {
    if (this.viewMode !== VIEW_MODES.POINT) return;
    let nextAz = 0;
    let nextEl = elevationDeg ?? 6;
    if (targetDirOrNorth && targetDirOrNorth !== 'NORTH' && targetDirOrNorth.lengthSq?.() > 1e-8) {
      const dir = targetDirOrNorth.clone().normalize();
      nextAz = THREE.MathUtils.radToDeg(
        Math.atan2(dir.dot(this._pointEast), dir.dot(this._pointNorth))
      );
      const rawEl = THREE.MathUtils.radToDeg(
        Math.asin(THREE.MathUtils.clamp(dir.dot(this._pointUp), -1, 1))
      );
      nextEl = THREE.MathUtils.clamp(elevationDeg ?? rawEl, -70, 85);
    }

    const delta = shortestAngleDeltaDeg(this.pointViewState.azimuthDeg, nextAz);
    this.pointViewState.targetAzimuthDeg = this.pointViewState.azimuthDeg + delta;
    this.pointViewState.targetElevationDeg = THREE.MathUtils.clamp(nextEl, -70, 85);
    if (!animate) {
      this._applyPointViewCamera(1.0);
    }
    this.onPointViewChangeCallback?.(this.getPointViewState());
  }

  setViewMode(mode, { animate = true, focus = null, point = null } = {}) {
    const nextMode = this._normalizeViewMode(mode);
    const prevMode = this.viewMode;

    if (prevMode === VIEW_MODES.LUNAR && nextMode !== VIEW_MODES.LUNAR) {
      this._saveCurrentLunarCamera();
    }

    if (nextMode === VIEW_MODES.POINT) {
      this.enterPointView(point || {
        latDeg: this.pointViewState.latDeg,
        lonDeg: this.pointViewState.lonDeg,
        label: this.pointViewState.label,
      });
      return this.viewMode;
    }

    if (prevMode === VIEW_MODES.POINT) {
      this.pointViewState.active = false;
      this._pointDrag.active = false;
      this.controls.enabled = true;
      this.camera.up.set(0, 1, 0);
      this.renderer.domElement.style.cursor = '';
      this.controls.target.set(0, 0, 0);
      this.onPointViewChangeCallback?.(null);
    }

    this.viewMode = nextMode;

    const currentTarget = this.controls.target.clone();
    const currentOffset = this.camera.position.clone().sub(currentTarget);
    const currentDist = Math.max(0.0001, currentOffset.length());
    const currentDir = currentOffset.divideScalar(currentDist);

    if (nextMode === VIEW_MODES.CISLUNAR) {
      if (focus !== null || prevMode !== VIEW_MODES.CISLUNAR) {
        this.cislunarFocus = this._normalizeCislunarFocus(focus || 'SYSTEM');
        this.onCislunarFocusChangeCallback?.(this.cislunarFocus);
      }
      this._updateCislunarFraming();
      this.minRadialDistance = this.minCislunarDistance;
      this.maxRadialDistance = this.maxCislunarDistance;
      this.controls.minDistance = this.minRadialDistance;
      this.controls.maxDistance = this.maxRadialDistance;
      this._desiredTarget.copy(this.cislunarTarget);

      const endOffset = this.cislunarCameraOffset.clone();
      const endDist = endOffset.length();
      const endDir = endOffset.clone().divideScalar(endDist);
      this.targetRadialDistance = endDist;

      if (animate) {
        this._flyAnim = {
          startTarget: currentTarget,
          targetPoint: this.cislunarTarget.clone(),
          startDir: currentDir,
          targetDir: endDir,
          startDist: currentDist,
          targetDist: endDist,
          startTime: performance.now(),
          durationMs: 1000,
        };
      } else {
        this._flyAnim = null;
        this.controls.target.copy(this.cislunarTarget);
        this.camera.position.copy(this.cislunarTarget).add(endOffset);
      }
    } else {
      this.minRadialDistance = this.minLunarDistance;
      this.maxRadialDistance = this.maxLunarDistance;
      this.controls.minDistance = this.minRadialDistance;
      this.controls.maxDistance = this.maxRadialDistance;
      this._desiredTarget.set(0, 0, 0);

      const lunarDir = this._savedLunarCamera?.direction?.clone() || new THREE.Vector3(1, 0, 0);
      const lunarDist = THREE.MathUtils.clamp(
        this._savedLunarCamera?.distance ?? this.initialDistance,
        this.minLunarDistance,
        this.maxLunarDistance
      );
      this.targetRadialDistance = lunarDist;

      if (animate) {
        this._flyAnim = {
          startTarget: currentTarget,
          targetPoint: new THREE.Vector3(0, 0, 0),
          startDir: currentDir,
          targetDir: lunarDir,
          startDist: currentDist,
          targetDist: lunarDist,
          startTime: performance.now(),
          durationMs: 900,
        };
      } else {
        this._flyAnim = null;
        this.controls.target.set(0, 0, 0);
        this.camera.position.copy(lunarDir).multiplyScalar(lunarDist);
      }
    }

    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    return this.viewMode;
  }

  setupSmoothAltitudeZoom() {
    this.renderer.domElement.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this._flyAnim = null;

        const delta = THREE.MathUtils.clamp(event.deltaY, -100, 100);
        const zoomSensitivity = 0.0014;

        if (this.viewMode === VIEW_MODES.POINT) {
          const factor = 1 + delta * 0.0018;
          this.pointViewState.targetAltitudeUnits = THREE.MathUtils.clamp(
            this.pointViewState.targetAltitudeUnits * factor,
            this.minPointAltitude,
            this.maxPointAltitude
          );
          return;
        }

        let distanceDelta;
        if (this.viewMode === VIEW_MODES.CISLUNAR) {
          if (this.cislunarFocus === 'EARTH') {
            const earthAlt = Math.max(0.05, this.targetRadialDistance - EARTH_CONFIG.RADIUS);
            distanceDelta = earthAlt * delta * zoomSensitivity * 1.15;
          } else if (this.cislunarFocus === 'MOON') {
            const moonAlt = Math.max(0.01, this.targetRadialDistance - MOON_CONFIG.RADIUS);
            distanceDelta = moonAlt * delta * zoomSensitivity * 1.15;
          } else {
            distanceDelta = this.targetRadialDistance * delta * zoomSensitivity;
          }
        } else {
          const currentAltitude = Math.max(
            this.minSurfaceClearance,
            this.targetRadialDistance - MOON_CONFIG.RADIUS
          );
          distanceDelta = currentAltitude * delta * zoomSensitivity;
        }

        this.targetRadialDistance = THREE.MathUtils.clamp(
          this.targetRadialDistance + distanceDelta,
          this.minRadialDistance,
          this.maxRadialDistance
        );
      },
      { passive: false }
    );
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  resetView() {
    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      this.setCislunarFocus(this.cislunarFocus, { animate: true });
      return;
    }
    if (this.viewMode === VIEW_MODES.POINT) {
      this.pointViewState.targetAzimuthDeg = 0;
      this.pointViewState.targetElevationDeg = 6;
      this.pointViewState.targetAltitudeUnits = this.defaultPointAltitude;
      return;
    }
    this.flyToCoordinates(0, 0, 1.0);
  }

  flyToCoordinates(latDeg, lonDeg, targetZoom = 65) {
    if (this.viewMode !== VIEW_MODES.LUNAR) {
      if (this.viewMode === VIEW_MODES.POINT) {
        this.pointViewState.active = false;
        this._pointDrag.active = false;
        this.controls.enabled = true;
        this.camera.up.set(0, 1, 0);
        this.renderer.domElement.style.cursor = '';
        this.controls.target.set(0, 0, 0);
        this.onPointViewChangeCallback?.(null);
      }
      this.viewMode = VIEW_MODES.LUNAR;
      this.minRadialDistance = this.minLunarDistance;
      this.maxRadialDistance = this.maxLunarDistance;
      this.controls.minDistance = this.minRadialDistance;
      this.controls.maxDistance = this.maxRadialDistance;
      this._desiredTarget.set(0, 0, 0);
      if (this.onViewModeChangeCallback) {
        this.onViewModeChangeCallback(VIEW_MODES.LUNAR);
      }
    }

    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);

    const targetDir = new THREE.Vector3(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.sin(latRad),
      -Math.cos(latRad) * Math.sin(lonRad)
    ).normalize();

    const targetAltitude = THREE.MathUtils.clamp(
      this.referenceAltitude / targetZoom,
      this.minSurfaceClearance,
      this.maxLunarDistance - MOON_CONFIG.RADIUS
    );

    const currentTarget = this.controls.target.clone();
    const currentOffset = this.camera.position.clone().sub(currentTarget);
    const currentDist = Math.max(0.0001, currentOffset.length());
    const startDir = currentOffset.divideScalar(currentDist);

    const targetDist = MOON_CONFIG.RADIUS + targetAltitude;
    this.targetRadialDistance = targetDist;

    this._flyAnim = {
      startTarget: currentTarget,
      targetPoint: new THREE.Vector3(0, 0, 0),
      startDir,
      targetDir,
      startDist: currentDist,
      targetDist,
      startTime: performance.now(),
      durationMs: 750,
    };
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  _interpolateDirection(startDir, targetDir, ease) {
    const dot = THREE.MathUtils.clamp(startDir.dot(targetDir), -1, 1);
    if (dot < -0.999) {
      const ref = Math.abs(startDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const axis = new THREE.Vector3().crossVectors(startDir, ref).normalize();
      return startDir.clone().applyAxisAngle(axis, Math.PI * ease);
    }
    return startDir.clone().lerp(targetDir, ease).normalize();
  }

  _clampCameraSpaceBoundaries() {
    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      // Обмежуємо панорамування цілі межами земно-місячної системи, щоб не полетіти у відкритий космос
      let halfSpan = 0.5 * this._earthCenter.distanceTo(this._moonCenter);
      if (this._cislunarFigure) {
        this._tmpSystemCenter.copy(this._cislunarFigure.center);
        halfSpan = Math.max(halfSpan, this._cislunarFigure.radius);
      } else {
        this._tmpSystemCenter.copy(this._moonCenter).add(this._earthCenter).multiplyScalar(0.5);
      }
      const maxPanRadius = halfSpan + EARTH_CONFIG.RADIUS + 7.5;

      this._tmpCollisionVec.subVectors(this.controls.target, this._tmpSystemCenter);
      const targetDist = this._tmpCollisionVec.length();
      if (targetDist > maxPanRadius && targetDist > 1e-6) {
        this._tmpCollisionVec.multiplyScalar(maxPanRadius / targetDist);
        this.controls.target.copy(this._tmpSystemCenter).add(this._tmpCollisionVec);
      }

      // Обмежуємо максимальне віддалення камери від центру системи Земля–Місяць
      const maxWorldCamRadius = maxPanRadius + this.maxCislunarDistance;
      this._tmpCollisionVec.subVectors(this.camera.position, this._tmpSystemCenter);
      const worldCamDist = this._tmpCollisionVec.length();
      if (worldCamDist > maxWorldCamRadius && worldCamDist > 1e-6) {
        this.camera.position
          .copy(this._tmpSystemCenter)
          .addScaledVector(this._tmpCollisionVec, maxWorldCamRadius / worldCamDist);
      }

      // Запобігаємо потраплянню камери всередину Місяця або Землі
      const minEarthCamDist = EARTH_CONFIG.RADIUS + 0.08;
      this._tmpCollisionVec.subVectors(this.camera.position, this._earthCenter);
      const dE = this._tmpCollisionVec.length();
      if (dE > 1e-6 && dE < minEarthCamDist) {
        this.camera.position.copy(this._earthCenter).addScaledVector(this._tmpCollisionVec, minEarthCamDist / dE);
      }
      const minMoonCamDist = MOON_CONFIG.RADIUS + 0.01;
      this._tmpCollisionVec.subVectors(this.camera.position, this._moonCenter);
      const dM = this._tmpCollisionVec.length();
      if (dM > 1e-6 && dM < minMoonCamDist) {
        this.camera.position.copy(this._moonCenter).addScaledVector(this._tmpCollisionVec, minMoonCamDist / dM);
      }
    } else if (this.viewMode === VIEW_MODES.LUNAR) {
      // Режим LUNAR: обмежуємо панорамування та орбітальне віддалення навколо Місяця
      const targetLen = this.controls.target.length();
      if (targetLen > this.maxLunarPanRadius && targetLen > 1e-6) {
        this.controls.target.multiplyScalar(this.maxLunarPanRadius / targetLen);
      }

      const minCamDist = MOON_CONFIG.RADIUS + this.minSurfaceClearance;
      const d = this.camera.position.length();
      if (d > 1e-6 && d < minCamDist) {
        this.camera.position.multiplyScalar(minCamDist / d);
      } else if (d > this.maxLunarDistance + this.maxLunarPanRadius) {
        this.camera.position.multiplyScalar((this.maxLunarDistance + this.maxLunarPanRadius) / d);
      }
    }
  }

  updateNavigationDynamics() {
    if (this.viewMode === VIEW_MODES.POINT) {
      this._applyPointViewCamera(0.22);
      this.onPointViewChangeCallback?.(this.getPointViewState());
      return;
    }

    if (this._flyAnim) {
      const elapsed = performance.now() - this._flyAnim.startTime;
      const t = THREE.MathUtils.clamp(elapsed / this._flyAnim.durationMs, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);

      const { startTarget, targetPoint, startDir, targetDir, startDist, targetDist } = this._flyAnim;
      this.controls.target.copy(startTarget).lerp(targetPoint, ease);

      const interpDir = this._interpolateDirection(startDir, targetDir, ease);
      const interpDist = THREE.MathUtils.lerp(startDist, targetDist, ease);
      this.camera.position.copy(this.controls.target).addScaledVector(interpDir, interpDist);
      this.camera.lookAt(this.controls.target);

      if (t >= 1) {
        this.controls.target.copy(targetPoint);
        this.camera.lookAt(this.controls.target);
        this._flyAnim = null;
      }
    } else {
      this.targetRadialDistance = THREE.MathUtils.clamp(
        this.targetRadialDistance,
        this.minRadialDistance,
        this.maxRadialDistance
      );
      this._tmpOffset.copy(this.camera.position).sub(this.controls.target);
      const currentDist = this._tmpOffset.length();
      if (currentDist > 0.00001) {
        const smoothedDist = THREE.MathUtils.lerp(currentDist, this.targetRadialDistance, 0.14);
        this._tmpOffset.divideScalar(currentDist).multiplyScalar(smoothedDist);
        this.camera.position.copy(this.controls.target).add(this._tmpOffset);
      }

      this._clampCameraSpaceBoundaries();
    }

    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      if (this.cislunarFocus === 'MOON') {
        const alt = Math.max(0.015, this.camera.position.distanceTo(this._moonCenter) - MOON_CONFIG.RADIUS);
        this.controls.rotateSpeed = THREE.MathUtils.clamp(alt * 0.32, 0.04, 0.55);
      } else if (this.cislunarFocus === 'EARTH') {
        const alt = Math.max(0.14, this.camera.position.distanceTo(this._earthCenter) - EARTH_CONFIG.RADIUS);
        this.controls.rotateSpeed = THREE.MathUtils.clamp(alt * 0.14, 0.08, 0.55);
      } else {
        this.controls.rotateSpeed = 0.55;
      }
    } else {
      const lunarDist = this.camera.position.length();
      const altitude = Math.max(0.00003, lunarDist - MOON_CONFIG.RADIUS);
      this.controls.rotateSpeed = THREE.MathUtils.clamp(altitude * 0.38, 0.00012, 0.4);
    }
  }

  getCameraTelemetry() {
    const currentDist = this.camera.position.distanceTo(this._moonCenter);
    const minAlt = this.viewMode === VIEW_MODES.POINT ? this.minPointAltitude : this.minSurfaceClearance;
    const altitude = Math.max(minAlt, currentDist - MOON_CONFIG.RADIUS);

    const zoomFactor = this.referenceAltitude / altitude;
    const altitudeKm = altitude * this.moonRadiusKm;

    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const visibleHeightUnits = 2 * altitude * Math.tan(vFovRad / 2);
    const unitsPerPixel = visibleHeightUnits / window.innerHeight;
    const kmPerPixel = unitsPerPixel * this.moonRadiusKm;

    const estimatedLod = THREE.MathUtils.clamp(
      Math.round(Math.log2(this.referenceAltitude / altitude) + 1.3),
      LOD_CONFIG.MIN_ZOOM,
      LOD_CONFIG.MAX_ZOOM
    );

    return {
      zoomFactor,
      altitudeKm,
      kmPerPixel,
      estimatedLod,
    };
  }

  startRenderLoop(onUpdate) {
    this.onUpdateCallback = onUpdate;
    const animate = () => {
      requestAnimationFrame(animate);
      if (this.viewMode !== VIEW_MODES.POINT) {
        this.controls.update();
      }
      this.updateNavigationDynamics();

      if (this.onUpdateCallback) {
        this.onUpdateCallback(this.camera, this.getCameraTelemetry());
      }
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}
