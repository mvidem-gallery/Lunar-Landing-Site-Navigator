import * as THREE from 'three';
import { MOON_CONFIG } from '../config/constants.js';
import { SolarMath } from '../astronomy/solarMath.js';

export class RaycastController {
  constructor(scene, camera, moonMesh, lightingSystem, onHoverCallback, domElement = null) {
    this.camera = camera;
    this.moonMesh = moonMesh;
    this.lightingSystem = lightingSystem;
    this.onHoverCallback = onHoverCallback;
    this.domElement = domElement || document.getElementById('canvas-container');

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.earthDirection = new THREE.Vector3(1, 0, 0);

    this.celestialTargets = [];
    this.onCelestialHover = null;

    this._lastClientX = null;
    this._lastClientY = null;
    this._isPointerInside = false;
    this._lastCameraMatrix = new THREE.Matrix4();

    this._targetWorldPos = new THREE.Vector3();
    this._targetSphere = new THREE.Sphere();
    this._hitPoint = new THREE.Vector3();

    const markerGeo = new THREE.RingGeometry(0.68, 1.0, 40);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.marker = new THREE.Mesh(markerGeo, markerMat);
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    scene.add(this.marker);

    this._onPointerMove = this.onPointerMove.bind(this);
    this._onWheel = () => {
      if (this._isPointerInside) {
        this.update();
        requestAnimationFrame(() => this.update());
      }
    };
    this._onPointerLeave = () => {
      this._isPointerInside = false;
      this.marker.visible = false;
      this.onHoverCallback(null);
      if (this.onCelestialHover) this.onCelestialHover(null);
    };

    window.addEventListener('pointermove', this._onPointerMove, { capture: true, passive: true });
    window.addEventListener('wheel', this._onWheel, { capture: true, passive: true });
    window.addEventListener('blur', this._onPointerLeave);

    this._startCameraWatcher();
  }

  _startCameraWatcher() {
    const watch = () => {
      if (this._isPointerInside && this.camera) {
        this.camera.updateMatrixWorld();
        if (!this.camera.matrixWorld.equals(this._lastCameraMatrix)) {
          this._lastCameraMatrix.copy(this.camera.matrixWorld);
          this.update();
        }
      }
      this._rafId = requestAnimationFrame(watch);
    };
    this._rafId = requestAnimationFrame(watch);
  }

  setEarthDirection(vec3) {
    this.earthDirection.copy(vec3).normalize();
  }

  setCelestialTargets(targets = [], onCelestialHover = null) {
    this.celestialTargets = Array.isArray(targets) ? targets : [];
    this.onCelestialHover = onCelestialHover;
  }

  _getViewportRect() {
    if (!this.domElement) {
      this.domElement = document.getElementById('canvas-container');
    }
    if (this.domElement) {
      const target = this.domElement.querySelector('canvas') || this.domElement;
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  _isObjectVisible(object) {
    for (let current = object; current; current = current.parent) {
      if (!current.visible) return false;
    }
    return true;
  }

  _checkCelestialHit() {
    if (!this.celestialTargets.length) return null;

    const visibleTargets = [];
    for (const target of this.celestialTargets) {
      if (!this._isObjectVisible(target)) continue;
      target.updateMatrixWorld(true);
      visibleTargets.push(target);
    }
    if (!visibleTargets.length) return null;

    const bodyHits = this.raycaster.intersectObjects(visibleTargets, false);
    if (bodyHits.length > 0) {
      return bodyHits[0].object.name;
    }

    for (const target of visibleTargets) {
      target.getWorldPosition(this._targetWorldPos);
      if (!target.geometry.boundingSphere) {
        target.geometry.computeBoundingSphere();
      }
      const radius = target.geometry.boundingSphere
        ? target.geometry.boundingSphere.radius * target.scale.x
        : 1.5;

      this._targetSphere.set(this._targetWorldPos, radius);
      if (this.raycaster.ray.intersectSphere(this._targetSphere, this._hitPoint)) {
        return target.name;
      }
    }

    return null;
  }

  onPointerMove(event) {
    this._lastClientX = event.clientX;
    this._lastClientY = event.clientY;
    this._isPointerInside = true;
    this.update();
  }

  update() {
    if (!this._isPointerInside || this._lastClientX === null || this._lastClientY === null) {
      return;
    }

    const rect = this._getViewportRect();

    if (
      this._lastClientX < rect.left ||
      this._lastClientX > rect.left + rect.width ||
      this._lastClientY < rect.top ||
      this._lastClientY > rect.top + rect.height
    ) {
      this.marker.visible = false;
      this.onHoverCallback(null);
      if (this.onCelestialHover) this.onCelestialHover(null);
      return;
    }

    this.mouse.x = ((this._lastClientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((this._lastClientY - rect.top) / rect.height) * 2 + 1;

    this.camera.updateMatrixWorld();
    this._lastCameraMatrix.copy(this.camera.matrixWorld);
    this.raycaster.camera = this.camera;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.moonMesh);

    if (intersects.length > 0) {
      if (this.onCelestialHover) {
        this.onCelestialHover(null);
      }

      const hit = intersects[0];
      const worldPoint = hit.point;
      const worldNormal = worldPoint.clone().normalize();

      this.marker.visible = true;
      const surfaceOffset = Math.min(0.0005, hit.distance * 0.015);
      this.marker.position.copy(worldPoint).addScaledVector(worldNormal, surfaceOffset);
      this.marker.lookAt(this.marker.position.clone().add(worldNormal));

      const fovRad = THREE.MathUtils.degToRad(this.camera.fov || 45);
      const worldHeightAtHit = 2 * hit.distance * Math.tan(fovRad * 0.5);
      const desiredRadiusPx = 12;
      const worldRadius = (desiredRadiusPx / rect.height) * worldHeightAtHit;

      this.marker.scale.set(worldRadius, worldRadius, 1);

      const lat = THREE.MathUtils.radToDeg(
        Math.asin(THREE.MathUtils.clamp(worldPoint.y / MOON_CONFIG.RADIUS, -1, 1))
      );
      const lon = THREE.MathUtils.radToDeg(
        Math.atan2(-worldPoint.z, worldPoint.x)
      );

      const sunDir = this.lightingSystem.getNormalizedSunDirection();
      const illumination = SolarMath.calculatePointIllumination(worldNormal, sunDir);
      const isVisibleFromEarth = worldNormal.dot(this.earthDirection) >= MOON_CONFIG.HORIZON_THRESHOLD;

      this.onHoverCallback({
        lat,
        lon,
        isVisibleFromEarth,
        ...illumination,
      });
      return;
    }

    this.marker.visible = false;
    this.onHoverCallback(null);

    const hitBodyType = this._checkCelestialHit();
    if (hitBodyType && this.onCelestialHover) {
      this.onCelestialHover({
        type: hitBodyType,
        clientX: this._lastClientX,
        clientY: this._lastClientY,
      });
    } else if (this.onCelestialHover) {
      this.onCelestialHover(null);
    }
  }

  dispose() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener('pointermove', this._onPointerMove, { capture: true });
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    window.removeEventListener('blur', this._onPointerLeave);
  }
}
