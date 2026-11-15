import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOON_CONFIG, EARTH_CONFIG, LOD_CONFIG, VIEW_MODES } from '../config/constants.js';

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
      2000
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
    this.maxLunarDistance = 10.0;

    this.cislunarDistance = EARTH_CONFIG.CISLUNAR_DISTANCE;
    this.cislunarEarthDir = new THREE.Vector3(1, 0, 0);
    this.cislunarTarget = new THREE.Vector3();
    this._moonCenter = new THREE.Vector3(0, 0, 0);
    this._earthCenter = new THREE.Vector3(this.cislunarDistance, 0, 0);
    this.cislunarCameraOffset = new THREE.Vector3();
    this.cislunarFocus = 'SYSTEM';
    this.minCislunarDistance = Math.max(8.0, this.cislunarDistance * 0.6);
    this.maxCislunarDistance = Math.max(45.0, this.cislunarDistance * 4.5);
    this._updateCislunarFraming();

    this.minRadialDistance = this.minLunarDistance;
    this.maxRadialDistance = this.maxLunarDistance;

    this.targetRadialDistance = this.camera.position.length();
    this._desiredTarget = new THREE.Vector3(0, 0, 0);
    this._savedLunarCamera = null;
    this.onUpdateCallback = null;
    this.onViewModeChangeCallback = null;
    this.onCislunarFocusChangeCallback = null;
    this._flyAnim = null;

    this._tmpOffset = new THREE.Vector3();
    this._tmpDeltaTarget = new THREE.Vector3();
    this._tmpCollisionVec = new THREE.Vector3();

    this.setupSmoothAltitudeZoom();
    this.renderer.domElement.addEventListener(
      'pointerdown',
      (event) => {
        this._flyAnim = null;
        if (event.button === 0) {
          this.controls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
        }
      },
      { capture: true }
    );

    const syncAltPanMode = (altPressed) => {
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

  _updateCislunarFraming() {
    const spanVec = new THREE.Vector3().subVectors(this._earthCenter, this._moonCenter);
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
      this.maxCislunarDistance = Math.max(40.0, this.cislunarDistance * 3.0);
    } else if (this.cislunarFocus === 'MOON') {
      const rM = MOON_CONFIG.RADIUS;
      this.cislunarTarget.copy(this._moonCenter);
      this.cislunarCameraOffset
        .copy(earthAxis)
        .multiplyScalar(rM * 2.1)
        .addScaledVector(camUp, rM * 0.95)
        .addScaledVector(sideAxis, rM * 2.4);
      this.minCislunarDistance = rM + 0.015;
      this.maxCislunarDistance = Math.max(30.0, this.cislunarDistance * 2.2);
    } else {
      // Центруємо огляд між Землею та Місяцем
      this.cislunarTarget.copy(this._moonCenter).add(this._earthCenter).multiplyScalar(0.5);
      this.cislunarCameraOffset
        .copy(earthAxis)
        .multiplyScalar(-D * 0.25)
        .addScaledVector(camUp, D * 0.42)
        .addScaledVector(sideAxis, D * 1.75);
      this.minCislunarDistance = Math.max(8.0, this.cislunarDistance * 0.6);
      this.maxCislunarDistance = Math.max(45.0, this.cislunarDistance * 4.5);
    }
  }

  _normalizeCislunarFocus(focus) {
    if (focus === 'EARTH' || focus === 'MOON') return focus;
    return 'SYSTEM';
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
    return mode === VIEW_MODES.CISLUNAR || mode === 'CISLUNAR_VIEW'
      ? VIEW_MODES.CISLUNAR
      : VIEW_MODES.LUNAR;
  }

  setViewMode(mode, { animate = true, focus = null } = {}) {
    const nextMode = this._normalizeViewMode(mode);
    const prevMode = this.viewMode;

    if (prevMode === VIEW_MODES.LUNAR && nextMode === VIEW_MODES.CISLUNAR) {
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
          durationMs: 900,
        };
      } else {
        this._flyAnim = null;
        this.controls.target.copy(this.cislunarTarget);
        this.camera.position.copy(this.cislunarTarget).add(endOffset);
      }
    } else {
      this.minRadialDistance = this.minLunarDistance;
      this.maxRadialDistance = this.maxLunarDistance;
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
    this.flyToCoordinates(0, 0, 1.0);
  }

  flyToCoordinates(latDeg, lonDeg, targetZoom = 65) {
    if (this.viewMode !== VIEW_MODES.LUNAR) {
      this.viewMode = VIEW_MODES.LUNAR;
      this.minRadialDistance = this.minLunarDistance;
      this.maxRadialDistance = this.maxLunarDistance;
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

  updateNavigationDynamics() {
    if (this._flyAnim) {
      const elapsed = performance.now() - this._flyAnim.startTime;
      const t = THREE.MathUtils.clamp(elapsed / this._flyAnim.durationMs, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);

      const { startTarget, targetPoint, startDir, targetDir, startDist, targetDist } = this._flyAnim;
      this.controls.target.copy(startTarget).lerp(targetPoint, ease);

      const interpDir = this._interpolateDirection(startDir, targetDir, ease);
      const interpDist = THREE.MathUtils.lerp(startDist, targetDist, ease);
      this.camera.position.copy(this.controls.target).addScaledVector(interpDir, interpDist);

      if (t >= 1) {
        this.controls.target.copy(targetPoint);
        this._flyAnim = null;
      }
    } else {
      this._tmpOffset.copy(this.camera.position).sub(this.controls.target);
      const currentDist = this._tmpOffset.length();
      if (currentDist > 0.00001) {
        const smoothedDist = THREE.MathUtils.lerp(currentDist, this.targetRadialDistance, 0.14);
        this._tmpOffset.divideScalar(currentDist).multiplyScalar(smoothedDist);
        this.camera.position.copy(this.controls.target).add(this._tmpOffset);
      }

      // Запобігаємо потраплянню камери всередину Місяця або Землі при вільному панорамуванні (Alt + рух)
      if (this.viewMode === VIEW_MODES.CISLUNAR) {
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
      } else {
        const minCamDist = MOON_CONFIG.RADIUS + this.minSurfaceClearance;
        const d = this.camera.position.length();
        if (d > 1e-6 && d < minCamDist) {
          this.camera.position.multiplyScalar(minCamDist / d);
        }
      }
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
    const altitude = Math.max(this.minSurfaceClearance, currentDist - MOON_CONFIG.RADIUS);

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
      this.controls.update();
      this.updateNavigationDynamics();

      if (this.onUpdateCallback) {
        this.onUpdateCallback(this.camera, this.getCameraTelemetry());
      }
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}
