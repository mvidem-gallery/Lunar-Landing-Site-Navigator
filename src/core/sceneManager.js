import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOON_CONFIG, LOD_CONFIG } from '../config/constants.js';

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
    this.controls.enablePan = false;

    this.minSurfaceClearance = 0.00003;
    this.minRadialDistance = MOON_CONFIG.RADIUS + this.minSurfaceClearance;
    this.maxRadialDistance = 10.0;

    this.targetRadialDistance = this.camera.position.length();
    this.onUpdateCallback = null;
    this._flyAnim = null;

    this.setupSmoothAltitudeZoom();
    this.renderer.domElement.addEventListener('pointerdown', () => {
      this._flyAnim = null;
    });
    window.addEventListener('resize', this.onResize.bind(this));
  }

  setupSmoothAltitudeZoom() {
    this.renderer.domElement.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this._flyAnim = null;

        const currentAltitude = Math.max(
          this.minSurfaceClearance,
          this.targetRadialDistance - MOON_CONFIG.RADIUS
        );

        const delta = THREE.MathUtils.clamp(event.deltaY, -100, 100);
        const zoomSensitivity = 0.0014;
        const altitudeDelta = currentAltitude * delta * zoomSensitivity;

        this.targetRadialDistance = THREE.MathUtils.clamp(
          this.targetRadialDistance + altitudeDelta,
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

  flyToCoordinates(latDeg, lonDeg, targetZoom = 65) {
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
      this.maxRadialDistance - MOON_CONFIG.RADIUS
    );

    const startDir = this.camera.position.clone().normalize();
    this.targetRadialDistance = MOON_CONFIG.RADIUS + targetAltitude;
    this._flyAnim = {
      startDir,
      targetDir,
      startTime: performance.now(),
      durationMs: 750,
    };
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  updateNavigationDynamics() {
    const currentDist = this.camera.position.length();

    const smoothedDist = THREE.MathUtils.lerp(currentDist, this.targetRadialDistance, 0.14);
    if (currentDist > 0.0001) {
      if (this._flyAnim) {
        const elapsed = performance.now() - this._flyAnim.startTime;
        const t = THREE.MathUtils.clamp(elapsed / this._flyAnim.durationMs, 0, 1);
        const ease = 1 - Math.pow(1 - t, 3);

        const { startDir, targetDir } = this._flyAnim;
        const dot = THREE.MathUtils.clamp(startDir.dot(targetDir), -1, 1);
        let interpDir;
        if (dot < -0.999) {
          const ref = Math.abs(startDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
          const axis = new THREE.Vector3().crossVectors(startDir, ref).normalize();
          interpDir = startDir.clone().applyAxisAngle(axis, Math.PI * ease);
        } else {
          interpDir = startDir.clone().lerp(targetDir, ease).normalize();
        }
        this.camera.position.copy(interpDir);
        if (t >= 1) this._flyAnim = null;
      }
      this.camera.position.setLength(smoothedDist);
    }

    this.controls.target.set(0, 0, 0);

    const altitude = Math.max(0.00003, smoothedDist - MOON_CONFIG.RADIUS);
    const angularScale = THREE.MathUtils.clamp(altitude * 0.38, 0.00012, 0.4);

    this.controls.rotateSpeed = angularScale;
  }

  getCameraTelemetry() {
    const currentDist = this.camera.position.length();
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
