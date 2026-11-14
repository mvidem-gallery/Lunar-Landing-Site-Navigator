import * as THREE from 'three';
import { MOON_CONFIG } from '../config/constants.js';

const EARTH_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vNormalWorld;
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;

  void main() {
    vLocalPos = normalize(position);
    vNormalWorld = normalize(mat3(modelMatrix) * normalize(position));
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunDirection;
  uniform float uTime;

  varying vec3 vNormalWorld;
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;

  float hash31(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(
        mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  float fbm(vec3 p, int octaves) {
    float value = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      value += amp * noise3D(p * freq);
      freq *= 2.04;
      amp *= 0.5;
    }
    return value;
  }

  float ridgedFbm(vec3 p) {
    float value = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
      float n = 1.0 - abs(noise3D(p * freq) * 2.0 - 1.0);
      value += amp * (n * n);
      freq *= 2.15;
      amp *= 0.48;
    }
    return value;
  }

  void main() {
    #include <logdepthbuf_fragment>

    vec3 N = normalize(vNormalWorld);
    vec3 L = normalize(uSunDirection);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 P = normalize(vLocalPos);

    // 1. Викривлення простору (domain warping) для континентів та архіпелагів
    vec3 warp = vec3(
      fbm(P * 2.3 + vec3(1.7, 9.2, 4.1), 4),
      fbm(P * 2.3 + vec3(8.3, 2.8, 6.4), 4),
      fbm(P * 2.3 + vec3(3.1, 5.7, 2.9), 4)
    );
    vec3 warpedP = P * 2.6 + (warp - 0.5) * 1.15;

    float continentHeight = fbm(warpedP, 6);
    float fineDetail = fbm(P * 18.0, 4);
    float mountainRidge = ridgedFbm(warpedP * 2.2);

    float seaLevel = 0.515;
    float elevation = continentHeight + (fineDetail - 0.5) * 0.08;
    float isLand = smoothstep(seaLevel - 0.006, seaLevel + 0.006, elevation);

    // 2. Океан із батиметрією континентального шельфу
    float oceanDepth = clamp((seaLevel - elevation) / 0.24, 0.0, 1.0);
    vec3 shallowWater = vec3(0.08, 0.36, 0.48);
    vec3 midOcean = vec3(0.03, 0.14, 0.29);
    vec3 deepAbyss = vec3(0.012, 0.055, 0.14);
    vec3 oceanColor = mix(shallowWater, midOcean, smoothstep(0.0, 0.22, oceanDepth));
    oceanColor = mix(oceanColor, deepAbyss, smoothstep(0.22, 0.85, oceanDepth));

    // 3. Біоми суходолу за широтою, вологістю та висотою
    float absLat = abs(P.y);
    float moisture = fbm(P * 4.2 + vec3(11.4, 3.2, 7.8), 4);
    float landAlt = clamp((elevation - seaLevel) / 0.32, 0.0, 1.0);

    vec3 tropicalForest = vec3(0.07, 0.21, 0.08);
    vec3 temperateGreen = vec3(0.16, 0.29, 0.12);
    vec3 desertSand = vec3(0.64, 0.52, 0.34);
    vec3 savanna = vec3(0.38, 0.36, 0.17);
    vec3 mountainRock = vec3(0.34, 0.31, 0.28);
    vec3 snowPeak = vec3(0.91, 0.94, 0.97);

    float desertBelt = smoothstep(0.10, 0.26, absLat) * (1.0 - smoothstep(0.34, 0.52, absLat));
    float aridity = desertBelt * (1.0 - smoothstep(0.28, 0.62, moisture));

    vec3 landColor = mix(tropicalForest, temperateGreen, smoothstep(0.18, 0.58, absLat));
    landColor = mix(landColor, savanna, smoothstep(0.35, 0.65, 1.0 - moisture) * 0.65);
    landColor = mix(landColor, desertSand, aridity * 0.92);
    landColor *= (0.82 + 0.36 * fineDetail);

    float mountainMask = smoothstep(0.32, 0.75, landAlt * 0.7 + mountainRidge * 0.45);
    landColor = mix(landColor, mountainRock, mountainMask * 0.72);
    float highSnow = smoothstep(0.68, 0.88, landAlt + mountainRidge * 0.35);
    landColor = mix(landColor, snowPeak, highSnow * 0.85);

    // Полярна крижана шапка з природними рваними краями
    float polarNoise = (fbm(P * 9.5, 4) - 0.5) * 0.14 + (fineDetail - 0.5) * 0.06;
    float polarLatitude = absLat + polarNoise;
    float polarThreshold = P.y < 0.0 ? 0.84 : 0.885;
    float polarIceMask = smoothstep(polarThreshold - 0.025, polarThreshold + 0.025, polarLatitude);

    vec3 surfaceAlbedo = mix(oceanColor, landColor, isLand);
    surfaceAlbedo = mix(surfaceAlbedo, vec3(0.90, 0.94, 0.98), polarIceMask * 0.94);

    // 4. Динамічний шар хмар
    vec3 cloudCoords = vec3(P.x * 2.8 + uTime * 0.0018, P.y * 4.4, P.z * 2.8 - uTime * 0.0018);
    vec3 cloudWarp = vec3(
      fbm(cloudCoords * 1.6, 3),
      fbm(cloudCoords * 1.6 + 4.2, 3),
      fbm(cloudCoords * 1.6 + 8.7, 3)
    );
    float cloudBase = fbm(cloudCoords * 2.1 + (cloudWarp - 0.5) * 0.95, 5);
    float cloudFine = fbm(cloudCoords * 9.0, 3);
    float clouds = smoothstep(0.51, 0.76, cloudBase * 0.82 + cloudFine * 0.26);

    // 5. Освітлення, релеївський термінатор і сонячний відблиск на океані
    float ndotl = dot(N, L);
    float diffuse = max(ndotl, 0.0);

    float terminatorZone = exp(-pow((ndotl - 0.02) * 9.5, 2.0));
    vec3 sunlightTint = mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.46, 0.18), terminatorZone * 0.65);

    vec3 H = normalize(L + V);
    float ndoth = max(dot(N, H), 0.0);
    float waterMask = (1.0 - isLand) * (1.0 - polarIceMask) * (1.0 - clouds * 0.85);
    float specular = pow(ndoth, 56.0) * 0.55 * waterMask * smoothstep(0.0, 0.2, ndotl);

    float cloudShadow = 1.0 - clouds * 0.35 * smoothstep(0.05, 0.4, ndotl);

    vec3 litSurface =
      surfaceAlbedo * cloudShadow * (0.015 + diffuse * 1.18) * sunlightTint +
      vec3(1.0, 0.95, 0.86) * specular * sunlightTint;

    vec3 cloudColor = vec3(0.96, 0.98, 1.0) * (0.02 + diffuse * 1.15) * sunlightTint;
    vec3 finalColor = mix(litSurface, cloudColor, clouds * 0.88);

    // 6. Нічні вогні міст
    float nightMask = 1.0 - smoothstep(-0.14, 0.03, ndotl);
    float habitableBelt = 1.0 - smoothstep(0.45, 0.72, absLat);
    float cityClusters = fbm(warpedP * 9.5, 4) * fbm(P * 32.0, 3);
    float cityLights = smoothstep(0.37, 0.48, cityClusters) * isLand * habitableBelt * (1.0 - polarIceMask);
    finalColor += vec3(1.0, 0.74, 0.32) * cityLights * nightMask * (1.0 - clouds * 0.65) * 0.95;

    // 7. Атмосферний ореол Релея
    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 3.6);
    float sunFacingAtmo = smoothstep(-0.28, 0.35, ndotl);
    vec3 dayAtmoColor = vec3(0.26, 0.62, 1.0);
    vec3 sunsetAtmoColor = vec3(0.95, 0.42, 0.16);
    vec3 atmoColor = mix(sunsetAtmoColor, dayAtmoColor, smoothstep(-0.08, 0.25, ndotl));

    finalColor += atmoColor * fresnel * (0.12 + 0.88 * sunFacingAtmo) * 0.95;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

const EARTH_ATMO_HALO_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vNormalWorld;
  varying vec3 vWorldPos;

  void main() {
    vNormalWorld = normalize(mat3(modelMatrix) * normalize(position));
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_ATMO_HALO_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunDirection;

  varying vec3 vNormalWorld;
  varying vec3 vWorldPos;

  void main() {
    #include <logdepthbuf_fragment>

    vec3 N = normalize(vNormalWorld);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uSunDirection);

    float rim = clamp(1.0 + dot(N, V), 0.0, 1.0);
    float glow = pow(rim, 4.2) * (1.0 - smoothstep(0.75, 1.0, rim));

    float sunSide = smoothstep(-0.35, 0.35, dot(-N, L));
    vec3 haloColor = mix(vec3(0.95, 0.45, 0.20), vec3(0.32, 0.68, 1.0), smoothstep(-0.1, 0.3, dot(-N, L)));

    float alpha = glow * (0.08 + 0.72 * sunSide);
    gl_FragColor = vec4(haloColor, alpha);
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

    // Дистанції узгоджені з площиною відсікання камери, щоб Земля, Сонце та зорі не обрізалися
    this.earthDistance = 221.2;
    this.earthRadius = 3.667;
    this.sunDistance = 420.0;
    this.sunRadius = 4.2;

    this.earthGroup = new THREE.Group();
    this.sunGroup = new THREE.Group();

    this.earthSurfaceMesh = null;
    this.sunSurfaceMesh = null;
    this.sunBillboard = null;

    this._sunDir = new THREE.Vector3(1, 0, 0);
    this._earthDir = new THREE.Vector3(1, 0, 0);
  }

  async init() {
    this._createStarfield();
    this._createEarthModel();
    this._createSunModel();

    this.scene.add(this.earthGroup);
    this.scene.add(this.sunGroup);
  }

  _createStarfield() {
    const starCount = 3200;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const radius = 850;

    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

      const brightness = 0.45 + Math.random() * 0.55;
      const tint = Math.random();
      colors[i * 3] = brightness * (tint > 0.8 ? 1.0 : 0.88);
      colors[i * 3 + 1] = brightness * 0.92;
      colors[i * 3 + 2] = brightness * (tint < 0.25 ? 1.0 : 0.86);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 1.8,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    const stars = new THREE.Points(geom, mat);
    stars.name = 'Starfield';
    this.scene.add(stars);
  }

  _createEarthModel() {
    this.earthGroup.rotation.z = THREE.MathUtils.degToRad(23.44);

    const earthGeom = new THREE.SphereGeometry(this.earthRadius, 96, 64);
    this.earthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: this._sunDir.clone() },
        uTime: { value: 0.0 },
      },
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER,
    });

    const earthMesh = new THREE.Mesh(earthGeom, this.earthMaterial);
    earthMesh.name = 'EARTH';
    this.earthGroup.add(earthMesh);
    this.earthSurfaceMesh = earthMesh;

    const atmoGeom = new THREE.SphereGeometry(this.earthRadius * 1.032, 64, 48);
    this.earthAtmoMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: this._sunDir.clone() },
      },
      vertexShader: EARTH_ATMO_HALO_VERTEX_SHADER,
      fragmentShader: EARTH_ATMO_HALO_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });

    const atmoMesh = new THREE.Mesh(atmoGeom, this.earthAtmoMaterial);
    this.earthGroup.add(atmoMesh);
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
    if (!ephemData) return;

    this._latLonToDirection(
      ephemData.subSunLon ?? ephemData.subSolarLon,
      ephemData.subSunLat ?? ephemData.subSolarLat,
      this._sunDir
    );
    this._latLonToDirection(ephemData.subEarthLon, ephemData.subEarthLat, this._earthDir);

    const earthDistScale = ephemData.earthDistanceKm
      ? ephemData.earthDistanceKm / (MOON_CONFIG.RADIUS * 1737.4)
      : this.earthDistance;

    this.earthGroup.position.copy(this._earthDir).multiplyScalar(earthDistScale);
    this.sunGroup.position.copy(this._sunDir).multiplyScalar(this.sunDistance);

    const utcHours =
      date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    if (this.earthSurfaceMesh) {
      this.earthSurfaceMesh.rotation.y = (utcHours / 24) * Math.PI * 2;
    }

    if (this.earthMaterial) {
      this.earthMaterial.uniforms.uSunDirection.value.copy(this._sunDir);
    }
    if (this.earthAtmoMaterial) {
      this.earthAtmoMaterial.uniforms.uSunDirection.value.copy(this._sunDir);
    }
  }

  update(camera, elapsedSeconds = 0) {
    if (this.earthMaterial) {
      this.earthMaterial.uniforms.uTime.value = elapsedSeconds;
    }
    if (this.sunBillboard && camera) {
      this.sunBillboard.quaternion.copy(camera.quaternion);
    }
  }

  getInteractiveTargets() {
    const targets = [];
    if (this.earthSurfaceMesh) targets.push(this.earthSurfaceMesh);
    if (this.sunSurfaceMesh) targets.push(this.sunSurfaceMesh);
    return targets;
  }
}