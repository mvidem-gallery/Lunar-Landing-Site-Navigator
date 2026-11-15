import * as THREE from 'three';
import {
  MOON_CONFIG,
  EARTH_CONFIG,
  CELESTIAL_CONFIG,
  STARMAP_CONFIG,
  VIEW_MODES,
} from '../config/constants.js';
import { EarthBuilder } from './earthBuilder.js';
import { TrajectoryGenerator } from '../astronomy/trajectoryGenerator.js';
import { TrajectoryRenderer } from './trajectoryRenderer.js';

const STARFIELD_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute float aSize;
  attribute float aBrightness;
  attribute vec3 aColor;

  uniform float uPixelRatio;

  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    vColor = aColor;
    vBrightness = aBrightness;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aSize * uPixelRatio, 1.0, 28.0);
    #include <logdepthbuf_vertex>
  }
`;

const STARFIELD_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    #include <logdepthbuf_fragment>

    vec2 p = (gl_PointCoord - vec2(0.5)) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    float core = exp(-r * r * 18.0);
    float halo = exp(-r * 4.5) * 0.26;
    float intensity = (core + halo) * vBrightness;

    vec3 starCol = mix(vColor, vec3(1.0), clamp(core * 0.72, 0.0, 1.0));
    gl_FragColor = vec4(starCol * intensity, clamp(intensity, 0.0, 1.0));
  }
`;

const MILKYWAY_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const MILKYWAY_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform sampler2D uMap;
  uniform float uIntensity;

  varying vec2 vUv;

  void main() {
    #include <logdepthbuf_fragment>

    // Інвертуємо u, щоб галактична карта ESA Gaia (l=0 у центрі, зростає ліворуч) збігалася з 3D-каталогом зсередини сфери
    vec2 skyUv = vec2(1.0 - vUv.x, vUv.y);
    vec3 texel = texture2D(uMap, skyUv).rgb;

    // Зберігаємо справжню кольорову гаму ESA Gaia EDR3, прибираючи фонову засвітку
    vec3 clean = max(texel - vec3(0.009), vec3(0.0));
    vec3 shaped = pow(clean, vec3(1.38)) * uIntensity;
    gl_FragColor = vec4(shaped, 1.0);
    #include <colorspace_fragment>
  }
`;

const SUN_CORONA_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const SUN_CORONA_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  varying vec2 vUv;

  void main() {
    #include <logdepthbuf_fragment>

    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    float core = exp(-r * r * 24.0);
    float corona = exp(-r * 3.6) * 0.85;
    float intensity = core + corona;

    vec3 col = mix(vec3(1.0, 0.78, 0.38), vec3(1.0, 0.99, 0.95), clamp(core * 1.4, 0.0, 1.0));
    gl_FragColor = vec4(col * intensity, clamp(intensity, 0.0, 1.0));
  }
`;

export class CelestialEnvironment {
  constructor(scene) {
    this.scene = scene;

    this.viewMode = VIEW_MODES.LUNAR;
    this.earthDistance = CELESTIAL_CONFIG.EARTH_DISTANCE;
    this._currentEarthDistance = this.earthDistance;
    this.cislunarEarthDistance = EARTH_CONFIG.CISLUNAR_DISTANCE;
    this.earthRadius = EARTH_CONFIG.RADIUS;
    this.sunDistance = CELESTIAL_CONFIG.SUN_DISTANCE;
    this.sunRadius = CELESTIAL_CONFIG.SUN_RADIUS;

    this._lunarSkyEuler = new THREE.Euler(
      THREE.MathUtils.degToRad(-STARMAP_CONFIG.ECLIPTIC_OBLIQUITY_DEG),
      0,
      0
    );
    this.celestialSphereGroup = new THREE.Group();
    this.celestialSphereGroup.name = 'CelestialSphere';
    this.celestialSphereGroup.quaternion.setFromEuler(this._lunarSkyEuler);

    this.moonGroup = null;
    this.earthGroup = null;
    this.sunGroup = new THREE.Group();

    this.earthSurfaceMesh = null;
    this.earthMaterial = null;
    this.earthAtmoMaterial = null;
    this.sunSurfaceMesh = null;
    this.sunBillboard = null;
    this.starPoints = null;
    this.milkywayMesh = null;

    this._sunDir = new THREE.Vector3(1, 0, 0);
    this._earthDir = new THREE.Vector3(1, 0, 0);

    // Модуль рендерингу траєкторії відокремлено від математики генератора траєкторій
    this.trajectoryRenderer = new TrajectoryRenderer(this.scene);
    this._parsedTrajectory = null;
    this._generatedTrajectory = null;
    this._trajectoryUserVisible = true;
    this._trajectoryDirty = false;
    this._onTrajectoryLoadedCallback = null;
    this._externalTelemetryTickCallback = null;
    this._onPhysicalStateChangeCallback = null;

    this.trajectoryRenderer.onTelemetryTick((sample, meta) => {
      if (this._isCislunarPhysicsActive()) {
        this._applyCislunarPhysicalStateAtTime(sample.t_s);
      }
      this._externalTelemetryTickCallback?.(sample, meta);
    });
  }

  async init() {
    this.scene.add(this.celestialSphereGroup);
    await this._createStarfield();
    this._createEarthModel();
    this._createSunModel();

    this.scene.add(this.earthGroup);
    this.scene.add(this.sunGroup);
    this._syncEarthState();
  }

  setMoonGroup(moonGroup) {
    this.moonGroup = moonGroup || null;
    this._syncEarthState();
  }

  onPhysicalStateChange(callback) {
    this._onPhysicalStateChangeCallback = callback;
  }

  _isCislunarPhysicsActive() {
    return this.viewMode === VIEW_MODES.CISLUNAR && Boolean(this._parsedTrajectory);
  }

  _applyCislunarPhysicalStateAtTime(t_s) {
    if (!this._parsedTrajectory) return null;

    const phys = TrajectoryGenerator.evaluatePhysicalSceneAtTime(this._parsedTrajectory, t_s, {
      cislunarDistance: this.cislunarEarthDistance,
    });

    this._sunDir.set(phys.sunDirScene[0], phys.sunDirScene[1], phys.sunDirScene[2]).normalize();
    this.sunGroup.position.copy(this._sunDir).multiplyScalar(this.sunDistance);

    this._earthDir
      .set(phys.earthDirFromMoonWorld[0], phys.earthDirFromMoonWorld[1], phys.earthDirFromMoonWorld[2])
      .normalize();

    if (this.earthGroup) {
      this.earthGroup.visible = true;
      this.earthGroup.position.set(0, 0, 0);
      if (this.earthGroup.userData?.update) {
        this.earthGroup.userData.update(this._sunDir, undefined, phys.earthQuaternionScene);
      }
    }

    if (this.moonGroup) {
      this.moonGroup.position.set(
        phys.moonPositionScene[0],
        phys.moonPositionScene[1],
        phys.moonPositionScene[2]
      );
      this.moonGroup.quaternion.set(
        phys.moonQuaternionScene[0],
        phys.moonQuaternionScene[1],
        phys.moonQuaternionScene[2],
        phys.moonQuaternionScene[3]
      );
    }

    this.celestialSphereGroup.quaternion.set(
      phys.skyQuaternionScene[0],
      phys.skyQuaternionScene[1],
      phys.skyQuaternionScene[2],
      phys.skyQuaternionScene[3]
    );

    this._onPhysicalStateChangeCallback?.(phys);
    return phys;
  }

  _bvToRgb(bvRaw) {
    const bv = THREE.MathUtils.clamp(Number.isFinite(bvRaw) ? bvRaw : 0.65, -0.4, 2.0);
    // Формула Баллестероса: перетворення індексу кольору B-V у температуру зірки (К)
    const temp = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

    let r;
    let g;
    let b;
    const t = temp / 100;

    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(Math.max(1, t)) - 161.1195681661;
      b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      b = 255;
    }

    // Пом'якшуємо насиченість, щоб зорі виглядали природно для людського ока
    const rawR = THREE.MathUtils.clamp(r / 255, 0, 1);
    const rawG = THREE.MathUtils.clamp(g / 255, 0, 1);
    const rawB = THREE.MathUtils.clamp(b / 255, 0, 1);
    return [
      THREE.MathUtils.lerp(1.0, rawR, 0.55),
      THREE.MathUtils.lerp(1.0, rawG, 0.55),
      THREE.MathUtils.lerp(1.0, rawB, 0.55),
    ];
  }

  _buildStarGeometryFromCatalog(features) {
    const filtered = [];
    for (const f of features) {
      const mag = f?.properties?.mag;
      const coords = f?.geometry?.coordinates;
      if (typeof mag === 'number' && Array.isArray(coords) && mag <= STARMAP_CONFIG.MAX_MAGNITUDE) {
        filtered.push(f);
      }
    }

    const count = filtered.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const brightnesses = new Float32Array(count);
    const radius = CELESTIAL_CONFIG.STARFIELD_RADIUS;

    for (let i = 0; i < count; i++) {
      const f = filtered[i];
      const [raDeg, decDeg] = f.geometry.coordinates;
      const mag = f.properties.mag;
      const bv = parseFloat(f.properties.bv);

      const raRad = THREE.MathUtils.degToRad(raDeg);
      const decRad = THREE.MathUtils.degToRad(decDeg);

      positions[i * 3] = radius * Math.cos(decRad) * Math.cos(raRad);
      positions[i * 3 + 1] = radius * Math.sin(decRad);
      positions[i * 3 + 2] = -radius * Math.cos(decRad) * Math.sin(raRad);

      const [r, g, b] = this._bvToRgb(bv);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;

      // Яскраві зорі (mag < 1) більші з м'яким ореолом, слабкі (mag 6..8) — точні цятки
      const magRange = STARMAP_CONFIG.MAX_MAGNITUDE + 1.7;
      const magNorm = THREE.MathUtils.clamp(
        (STARMAP_CONFIG.MAX_MAGNITUDE + 0.2 - mag) / magRange,
        0.0,
        1.0
      );
      sizes[i] = 1.1 + Math.pow(magNorm, 2.4) * 5.8;
      brightnesses[i] = THREE.MathUtils.clamp(0.14 + Math.pow(magNorm, 1.9) * 0.86, 0.12, 1.0);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aBrightness', new THREE.BufferAttribute(brightnesses, 1));
    return geom;
  }

  _buildProceduralFallbackStars() {
    const starCount = CELESTIAL_CONFIG.STAR_COUNT;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const brightnesses = new Float32Array(starCount);
    const radius = CELESTIAL_CONFIG.STARFIELD_RADIUS;

    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

      const bv = -0.25 + Math.random() * 1.75;
      const [r, g, b] = this._bvToRgb(bv);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;

      const weight = Math.pow(Math.random(), 3.2);
      sizes[i] = 1.6 + weight * 8.0;
      brightnesses[i] = 0.22 + weight * 1.05;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aBrightness', new THREE.BufferAttribute(brightnesses, 1));
    return geom;
  }

  _loadMilkyWayBackdrop() {
    const skyGeom = new THREE.SphereGeometry(CELESTIAL_CONFIG.STARFIELD_RADIUS * 1.04, 64, 48);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uIntensity: { value: STARMAP_CONFIG.MILKYWAY_INTENSITY },
      },
      vertexShader: MILKYWAY_VERTEX_SHADER,
      fragmentShader: MILKYWAY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
    });

    const skyMesh = new THREE.Mesh(skyGeom, skyMat);
    // Поворот IAU J2000 із галактичних координат (ESO eso0932a) в екваторіальні ICRF/J2000 нашої 3D-сцени
    const galCenter = new THREE.Vector3(-0.05487556, -0.48383502, 0.87343709).normalize();
    const galL90 = new THREE.Vector3(0.49410943, 0.74698224, 0.44482963).normalize();
    const galNorthPole = new THREE.Vector3(-0.86766615, 0.45598378, 0.19807637).normalize();
    const galToEquatorial = new THREE.Matrix4().makeBasis(galCenter, galNorthPole, galL90.negate());
    skyMesh.quaternion.setFromRotationMatrix(galToEquatorial);
    skyMesh.renderOrder = -2;
    skyMesh.visible = false;
    skyMesh.name = 'MilkyWayBackdrop';
    this.celestialSphereGroup.add(skyMesh);
    this.milkywayMesh = skyMesh;

    const texLoader = new THREE.TextureLoader();
    texLoader.setCrossOrigin('anonymous');

    const applyTexture = (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 4;
      skyMat.uniforms.uMap.value = texture;
      skyMesh.visible = true;
    };

    texLoader.load(
      STARMAP_CONFIG.MILKYWAY_LOCAL_URL,
      applyTexture,
      undefined,
      () => {
        texLoader.load(STARMAP_CONFIG.MILKYWAY_REMOTE_URL, applyTexture);
      }
    );
  }

  async _fetchCatalogFeatures(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json') && !url.endsWith('.json')) {
      throw new Error('Unexpected content type');
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.features)) {
      throw new Error('Invalid star catalog format');
    }
    return json.features;
  }

  async _createStarfield() {
    this._loadMilkyWayBackdrop();

    const starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: STARFIELD_VERTEX_SHADER,
      fragmentShader: STARFIELD_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    let geometry = null;
    try {
      const features = await this._fetchCatalogFeatures(STARMAP_CONFIG.CATALOG_LOCAL_URL);
      geometry = this._buildStarGeometryFromCatalog(features);
    } catch {
      geometry = this._buildProceduralFallbackStars();
      this._fetchCatalogFeatures(STARMAP_CONFIG.CATALOG_REMOTE_URL)
        .then((features) => {
          if (!this.starPoints) return;
          const catalogGeom = this._buildStarGeometryFromCatalog(features);
          this.starPoints.geometry.dispose();
          this.starPoints.geometry = catalogGeom;
        })
        .catch(() => {
          // Залишаємо процедурний резерв, якщо офлайн і локальний каталог не завантажено
        });
    }

    const stars = new THREE.Points(geometry, starMaterial);
    stars.name = 'Starfield';
    stars.renderOrder = -1;
    this.celestialSphereGroup.add(stars);
    this.starPoints = stars;
  }

  _createEarthModel() {
    this.earthGroup = EarthBuilder.build({
      radius: this.earthRadius,
      segments: EARTH_CONFIG.SEGMENTS,
      axialTiltDeg: EARTH_CONFIG.AXIAL_TILT_DEG,
      atmoScale: EARTH_CONFIG.ATMO_SCALE,
    });

    const { surfaceMesh, earthMaterial, atmosphereMaterial } = this.earthGroup.userData;
    this.earthSurfaceMesh = surfaceMesh;
    this.earthMaterial = earthMaterial;
    this.earthAtmoMaterial = atmosphereMaterial;
  }

  _rebuildTrajectoryIfNeeded() {
    if (!this._parsedTrajectory) return;
    const needsRebuild = this._trajectoryDirty || !this._generatedTrajectory;
    if (!needsRebuild) return;

    const generated = TrajectoryGenerator.generateCislunarPath(this._parsedTrajectory, {
      earthRadius: this.earthRadius,
      moonRadius: MOON_CONFIG.RADIUS,
      cislunarDistance: this.cislunarEarthDistance,
    });
    const preserveTime = !this._trajectoryDirty && Boolean(this._generatedTrajectory);
    this._generatedTrajectory = generated;
    this._trajectoryDirty = false;
    this.trajectoryRenderer.setGeneratedTrajectory(generated, { preserveTime });
  }

  _syncTrajectoryState() {
    const shouldShow =
      this.viewMode === VIEW_MODES.CISLUNAR &&
      this._trajectoryUserVisible &&
      Boolean(this._parsedTrajectory);

    if (shouldShow) {
      this._rebuildTrajectoryIfNeeded();
    }
    this.trajectoryRenderer.setVisible(shouldShow);
  }

  _syncEarthState() {
    if (this._isCislunarPhysicsActive()) {
      this._syncTrajectoryState();
      this._applyCislunarPhysicalStateAtTime(this.trajectoryRenderer.getTimeSeconds());
      return;
    }

    if (this.moonGroup) {
      this.moonGroup.position.set(0, 0, 0);
      this.moonGroup.quaternion.identity();
    }
    this.celestialSphereGroup.quaternion.setFromEuler(this._lunarSkyEuler);

    if (this.earthGroup) {
      this.earthGroup.visible = true;
      const distance =
        this.viewMode === VIEW_MODES.CISLUNAR
          ? this.cislunarEarthDistance
          : this._currentEarthDistance;
      // У режимі LUNAR Земля завжди розташована вздовж реального вектора Місяць -> Земля (_earthDir)
      this.earthGroup.position.copy(this._earthDir).multiplyScalar(distance);
    }
    this._syncTrajectoryState();
  }

  setViewMode(mode) {
    const normalized =
      mode === VIEW_MODES.CISLUNAR || mode === 'CISLUNAR_VIEW'
        ? VIEW_MODES.CISLUNAR
        : VIEW_MODES.LUNAR;
    this.viewMode = normalized;
    this._syncEarthState();
    return this.viewMode;
  }

  setTrajectoryDocument(jsonDoc, options = {}) {
    const parsed = TrajectoryGenerator.parse(jsonDoc, options);
    this._parsedTrajectory = parsed;
    this._trajectoryDirty = true;

    this._rebuildTrajectoryIfNeeded();
    this._syncEarthState();
    this._onTrajectoryLoadedCallback?.(this.getTrajectoryInfo());
    return this.getTrajectoryInfo();
  }

  async loadTrajectory(url, options = {}) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch trajectory (${res.status}): ${url}`);
    }
    const jsonDoc = await res.json();
    return this.setTrajectoryDocument(jsonDoc, options);
  }

  setTrajectoryVisible(visible) {
    this._trajectoryUserVisible = Boolean(visible);
    this._syncTrajectoryState();
  }

  isTrajectoryVisible() {
    return this._trajectoryUserVisible;
  }

  setTrajectoryPlaying(playing) {
    this.trajectoryRenderer.setPlaying(playing);
  }

  setTrajectoryTime(t_s) {
    return this.trajectoryRenderer.setTimeSeconds(t_s);
  }

  onTrajectoryTelemetryTick(callback) {
    this._externalTelemetryTickCallback = callback;
  }

  onTrajectoryLoaded(callback) {
    this._onTrajectoryLoadedCallback = callback;
  }

  getTrajectoryInfo() {
    if (!this._parsedTrajectory) return null;
    return {
      meta: this._parsedTrajectory.meta,
      landingSite: this._parsedTrajectory.landingSite,
      spaceport: this._parsedTrajectory.spaceport,
      phases: this._parsedTrajectory.phases,
      events: this._generatedTrajectory?.events || this._parsedTrajectory.events,
      segments: this._generatedTrajectory?.segments || [],
      isPlaying: this.trajectoryRenderer.isPlaying(),
      currentTimeSec: this.trajectoryRenderer.getTimeSeconds(),
      userVisible: this._trajectoryUserVisible,
    };
  }

  _createSunModel() {
    const coronaGeom = new THREE.PlaneGeometry(this.sunRadius * 7.5, this.sunRadius * 7.5);
    const coronaMat = new THREE.ShaderMaterial({
      vertexShader: SUN_CORONA_VERTEX_SHADER,
      fragmentShader: SUN_CORONA_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.sunBillboard = new THREE.Mesh(coronaGeom, coronaMat);
    this.sunGroup.add(this.sunBillboard);

    const sunHitGeom = new THREE.SphereGeometry(this.sunRadius * 2.5, 16, 16);
    const sunHitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      colorWrite: false,
    });
    const sunHitMesh = new THREE.Mesh(sunHitGeom, sunHitMat);
    sunHitMesh.name = 'SUN';
    this.sunGroup.add(sunHitMesh);
    this.sunSurfaceMesh = sunHitMesh;
  }

  _latLonToDirection(lonDeg, latDeg, outVec) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    return outVec
      .set(
        Math.cos(latRad) * Math.cos(lonRad),
        Math.sin(latRad),
        -Math.cos(latRad) * Math.sin(lonRad)
      )
      .normalize();
  }

  updatePositions(ephemData, date = new Date()) {
    if (!ephemData || this._isCislunarPhysicsActive()) return;

    this._latLonToDirection(
      ephemData.subSunLon ?? ephemData.subSolarLon,
      ephemData.subSunLat ?? ephemData.subSolarLat,
      this._sunDir
    );
    this._latLonToDirection(ephemData.subEarthLon, ephemData.subEarthLat, this._earthDir);

    this._currentEarthDistance = ephemData.earthDistanceKm
      ? ephemData.earthDistanceKm / (MOON_CONFIG.RADIUS * MOON_CONFIG.RADIUS_KM)
      : this.earthDistance;

    this.sunGroup.position.copy(this._sunDir).multiplyScalar(this.sunDistance);
    this._syncEarthState();

    if (this.earthGroup?.userData?.update) {
      this.earthGroup.userData.update(this._sunDir, undefined, date);
    }
  }

  update(camera, elapsedSeconds = 0) {
    if (this.earthGroup?.userData?.update) {
      this.earthGroup.userData.update(null, elapsedSeconds);
    }
    if (this.sunBillboard && camera) {
      this.sunBillboard.quaternion.copy(camera.quaternion);
    }
    if (this.viewMode === VIEW_MODES.CISLUNAR) {
      this.trajectoryRenderer.update(camera, elapsedSeconds);
    }
  }

  getInteractiveTargets() {
    const targets = [];
    if (this.earthSurfaceMesh) targets.push(this.earthSurfaceMesh);
    if (this.sunSurfaceMesh) targets.push(this.sunSurfaceMesh);
    return targets;
  }
}
