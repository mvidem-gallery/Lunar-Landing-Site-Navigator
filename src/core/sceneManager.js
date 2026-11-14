import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOON_CONFIG, LOD_CONFIG } from '../config/constants.js';

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();

    this.initialDistance = 3.5;
    this.referenceAltitude = this.initialDistance - MOON_CONFIG.RADIUS;
    this.moonRadiusKm = 1737.4;

    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.0001,
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

    this.minSurfaceClearance = 0.001;
    this.minRadialDistance = MOON_CONFIG.RADIUS + this.minSurfaceClearance;
    this.maxRadialDistance = 10.0;

    this.targetRadialDistance = this.camera.position.length();
    this.onUpdateCallback = null;

    this.setupSmoothAltitudeZoom();
    window.addEventListener('resize', this.onResize.bind(this));
  }

  setupSmoothAltitudeZoom() {
    this.renderer.domElement.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();

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

  flyToCoordinates(latDeg, lonDeg, targetZoom = 1500) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);

    // ІНВЕРСІЯ X та Z для точного збігу з поворотом місячної сфери на Math.PI!
    const dir = new THREE.Vector3(
      -Math.cos(latRad) * Math.cos(lonRad), // Було +, стало -
      Math.sin(latRad),
      Math.cos(latRad) * Math.sin(lonRad)   // Було -, стало +
    ).normalize();

    const targetAltitude = THREE.MathUtils.clamp(
      this.referenceAltitude / targetZoom,
      this.minSurfaceClearance,
      this.maxRadialDistance - MOON_CONFIG.RADIUS
    );

    this.targetRadialDistance = MOON_CONFIG.RADIUS + targetAltitude;
    this.camera.position.copy(dir.multiplyScalar(this.targetRadialDistance));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  updateNavigationDynamics() {
    const currentDist = this.camera.position.length();

    const smoothedDist = THREE.MathUtils.lerp(currentDist, this.targetRadialDistance, 0.14);
    if (currentDist > 0.0001) {
      this.camera.position.setLength(smoothedDist);
    }

    this.controls.target.set(0, 0, 0);

    const altitude = Math.max(0.0005, smoothedDist - MOON_CONFIG.RADIUS);
    const angularScale = THREE.MathUtils.clamp(altitude * 0.38, 0.0015, 0.4);

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