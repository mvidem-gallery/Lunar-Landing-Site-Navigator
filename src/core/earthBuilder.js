import * as THREE from 'three';
import { EARTH_CONFIG } from '../config/constants.js';

const EARTH_SURFACE_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vNormalWorld;
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vLocalPos = normalize(position);
    vNormalWorld = normalize(mat3(modelMatrix) * normalize(position));
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_SURFACE_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunDirection;
  uniform float uTime;

  uniform sampler2D uDayMap;
  uniform bool uUseDayMap;

  uniform sampler2D uNightMap;
  uniform bool uUseNightMap;

  uniform sampler2D uNormalMap;
  uniform bool uUseNormalMap;

  uniform sampler2D uSpecularMap;
  uniform bool uUseSpecularMap;

  uniform sampler2D uCloudsMap;
  uniform bool uUseCloudsMap;
  uniform float uCloudDrift;

  varying vec3 vNormalWorld;
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying vec2 vUv;

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

  vec3 perturbNormalFromMap(vec3 N, vec3 worldPos, vec2 uvCoord, vec3 mapNormal) {
    vec3 dPosX = dFdx(worldPos);
    vec3 dPosY = dFdy(worldPos);
    vec2 dUvX = dFdx(uvCoord);
    vec2 dUvY = dFdy(uvCoord);

    vec3 dp2perp = cross(dPosY, N);
    vec3 dp1perp = cross(N, dPosX);
    vec3 T = dp2perp * dUvX.x + dp1perp * dUvY.x;
    vec3 B = dp2perp * dUvX.y + dp1perp * dUvY.y;

    float invMax = inversesqrt(max(dot(T, T), dot(B, B) + 1e-8));
    mat3 TBN = mat3(T * invMax, B * invMax, N);
    return normalize(TBN * mapNormal);
  }

  void main() {
    #include <logdepthbuf_fragment>

    vec3 N = normalize(vNormalWorld);
    vec3 L = normalize(uSunDirection);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 P = normalize(vLocalPos);

    // 1. Альбедо поверхні та маска океану
    vec3 surfaceAlbedo;
    float waterMask = 0.0;
    float polarIceMask = 0.0;

    if (uUseDayMap) {
      surfaceAlbedo = texture2D(uDayMap, vUv).rgb;
      if (uUseSpecularMap) {
        waterMask = smoothstep(0.18, 0.72, texture2D(uSpecularMap, vUv).r);
      } else {
        float blueExcess = surfaceAlbedo.b - max(surfaceAlbedo.r, surfaceAlbedo.g);
        waterMask = smoothstep(0.02, 0.14, blueExcess);
      }
    } else {
      // Процедурний fallback на час завантаження текстур або в офлайні
      float absLat = abs(P.y);
      vec3 warp = vec3(
        fbm(P * 2.3 + vec3(1.7, 9.2, 4.1), 4),
        fbm(P * 2.3 + vec3(8.3, 2.8, 6.4), 4),
        fbm(P * 2.3 + vec3(3.1, 5.7, 2.9), 4)
      );
      vec3 warpedP = P * 2.6 + (warp - 0.5) * 1.15;
      float elevation = fbm(warpedP, 5);
      float isLand = smoothstep(0.505, 0.525, elevation);
      waterMask = 1.0 - isLand;

      vec3 oceanCol = pow(vec3(0.03, 0.16, 0.34), vec3(2.2));
      vec3 landCol = mix(
        pow(vec3(0.11, 0.25, 0.11), vec3(2.2)),
        pow(vec3(0.56, 0.45, 0.29), vec3(2.2)),
        smoothstep(0.12, 0.36, absLat) * (1.0 - smoothstep(0.36, 0.55, absLat))
      );
      polarIceMask = smoothstep(0.84, 0.90, absLat);
      surfaceAlbedo = mix(oceanCol, landCol, isLand);
      surfaceAlbedo = mix(surfaceAlbedo, pow(vec3(0.90, 0.94, 0.98), vec3(2.2)), polarIceMask);
    }

    // 2. Карта нормалей рельєфу материків (Гімалаї, Анди, Кордильєри тощо)
    vec3 Nsurf = N;
    if (uUseNormalMap) {
      vec3 mapN = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
      mapN.xy *= mix(0.85, 0.08, waterMask);
      Nsurf = perturbNormalFromMap(N, vWorldPos, vUv, normalize(mapN));
    }

    // 3. Сонячне освітлення, сутінки термінатора та тіні від хмар
    float ndotlGeom = dot(N, L);
    float ndotlRelief = dot(Nsurf, L);
    float diffuse = max(mix(ndotlRelief, ndotlGeom, 0.25), 0.0);
    float twilight = smoothstep(-0.14, 0.16, ndotlGeom);

    float terminatorBand = exp(-pow((ndotlGeom - 0.01) * 10.5, 2.0));
    vec3 sunlightTint = mix(vec3(1.0, 0.985, 0.96), vec3(1.0, 0.48, 0.18), terminatorBand * 0.62);

    // М'яка тінь хмар на поверхні Землі (RepeatWrapping по X запобігає швам на міп-рівнях)
    float cloudShadowFactor = 1.0;
    if (uUseCloudsMap) {
      vec2 shadowUv = vec2(vUv.x + uCloudDrift + 0.0022, clamp(vUv.y - 0.0012, 0.0, 1.0));
      float cloudAlpha = texture2D(uCloudsMap, shadowUv).a;
      cloudShadowFactor = 1.0 - cloudAlpha * 0.38 * smoothstep(0.02, 0.35, ndotlGeom);
    }

    // Сонячний відблиск на поверхні океанів з урахуванням закону Френеля
    vec3 H = normalize(L + V);
    float ndoth = max(dot(N, H), 0.0);
    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnelOcean = 0.04 + 0.96 * pow(1.0 - ndotv, 4.0);
    float specBroad = pow(ndoth, 28.0) * 0.22;
    float specCore = pow(ndoth, 110.0) * 0.72;
    float oceanSpec = (specBroad + specCore) * waterMask * (0.35 + 0.65 * fresnelOcean) * smoothstep(0.0, 0.22, ndotlGeom);

    vec3 ambientEarth = surfaceAlbedo * vec3(0.009, 0.013, 0.022);
    vec3 litSurface =
      ambientEarth +
      surfaceAlbedo * cloudShadowFactor * diffuse * 1.28 * sunlightTint +
      vec3(1.0, 0.96, 0.88) * oceanSpec * cloudShadowFactor * sunlightTint;

    // 4. Реальні нічні вогні міст (NASA Black Marble)
    if (uUseNightMap) {
      float nightWeight = 1.0 - smoothstep(-0.14, 0.05, ndotlGeom);
      vec3 cityLights = texture2D(uNightMap, vUv).rgb;
      float cloudDim = 1.0;
      if (uUseCloudsMap) {
        vec2 cloudUv = vec2(vUv.x + uCloudDrift, vUv.y);
        cloudDim = 1.0 - texture2D(uCloudsMap, cloudUv).a * 0.68;
      }
      litSurface += cityLights * nightWeight * cloudDim * 1.35;
    } else if (!uUseDayMap) {
      float nightWeight = 1.0 - smoothstep(-0.14, 0.05, ndotlGeom);
      float citySeed = fbm(P * 24.0, 3);
      litSurface += vec3(0.95, 0.62, 0.22) * smoothstep(0.68, 0.78, citySeed) * (1.0 - waterMask) * nightWeight * 0.4;
    }

    // 5. Тонке атмосферне розсіяння Релея на поверхні й біля лімба
    float rim = pow(1.0 - ndotv, 3.6);
    float dayAtmo = smoothstep(-0.22, 0.35, ndotlGeom);
    vec3 rayleighDay = vec3(0.18, 0.46, 0.96);
    vec3 rayleighSunset = vec3(0.95, 0.36, 0.12);
    vec3 limbColor = mix(rayleighSunset, rayleighDay, smoothstep(-0.06, 0.22, ndotlGeom));

    vec3 finalColor = litSurface;
    finalColor = mix(finalColor, rayleighDay * 0.62, pow(1.0 - ndotv, 2.2) * 0.26 * dayAtmo);
    finalColor += limbColor * rim * (0.04 + 0.96 * dayAtmo) * 0.85;
    finalColor += vec3(0.03, 0.05, 0.09) * twilight * 0.05;

    gl_FragColor = vec4(finalColor, 1.0);
    #include <colorspace_fragment>
  }
`;

const EARTH_CLOUDS_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vNormalWorld;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vNormalWorld = normalize(mat3(modelMatrix) * normalize(position));
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_CLOUDS_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform sampler2D uCloudsMap;
  uniform bool uUseCloudsMap;
  uniform vec3 uSunDirection;
  uniform float uCloudDrift;

  varying vec3 vNormalWorld;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    #include <logdepthbuf_fragment>

    if (!uUseCloudsMap) discard;

    vec2 cloudUv = vec2(vUv.x + uCloudDrift, vUv.y);
    float cloudDensity = texture2D(uCloudsMap, cloudUv).a;
    if (cloudDensity < 0.015) discard;

    vec3 N = normalize(vNormalWorld);
    vec3 L = normalize(uSunDirection);
    vec3 V = normalize(cameraPosition - vWorldPos);

    float ndotl = dot(N, L);
    float diffuse = smoothstep(-0.08, 0.85, ndotl);
    float terminatorBand = exp(-pow((ndotl - 0.01) * 10.0, 2.0));
    vec3 cloudTint = mix(vec3(0.95, 0.97, 1.0), vec3(1.0, 0.56, 0.30), terminatorBand * 0.52);

    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float limbBlue = pow(1.0 - ndotv, 3.0) * smoothstep(-0.15, 0.35, ndotl);

    vec3 dayCloud = vec3(0.96, 0.98, 1.0) * (0.018 + diffuse * 1.12) * cloudTint;
    dayCloud += vec3(0.22, 0.52, 0.95) * limbBlue * 0.25;

    float alpha = clamp(cloudDensity * 0.92 * (0.14 + 0.86 * smoothstep(-0.28, 0.15, ndotl)), 0.0, 0.95);
    gl_FragColor = vec4(dayCloud, alpha);
    #include <colorspace_fragment>
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
    float glow = pow(rim, 4.4) * (1.0 - smoothstep(0.72, 1.0, rim));

    float sunDot = dot(-N, L);
    float sunSide = smoothstep(-0.32, 0.35, sunDot);
    vec3 haloColor = mix(vec3(0.95, 0.42, 0.18), vec3(0.26, 0.62, 1.0), smoothstep(-0.08, 0.28, sunDot));

    float alpha = glow * (0.06 + 0.78 * sunSide);
    gl_FragColor = vec4(haloColor, alpha);
    #include <colorspace_fragment>
  }
`;

function loadTextureWithFallback(loader, localUrl, remoteUrl, { srgb = false } = {}, onLoad) {
  const configure = (texture) => {
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    onLoad(texture);
  };

  loader.load(localUrl, configure, undefined, () => {
    if (remoteUrl) {
      loader.load(remoteUrl, configure);
    }
  });
}

export class EarthBuilder {
  static build(options = {}) {
    const radius = options.radius ?? EARTH_CONFIG.RADIUS;
    const segments = options.segments ?? EARTH_CONFIG.SEGMENTS;
    const axialTiltDeg = options.axialTiltDeg ?? EARTH_CONFIG.AXIAL_TILT_DEG;
    const atmoScale = options.atmoScale ?? EARTH_CONFIG.ATMO_SCALE;
    const cloudScale = options.cloudScale ?? EARTH_CONFIG.CLOUD_SCALE;
    const initialTexture = options.texture ?? null;

    const earthGroup = new THREE.Group();
    earthGroup.name = 'EarthGroup';
    earthGroup.rotation.z = THREE.MathUtils.degToRad(axialTiltDeg);

    const earthUniforms = {
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0.0 },
      uDayMap: { value: initialTexture },
      uUseDayMap: { value: Boolean(initialTexture) },
      uNightMap: { value: null },
      uUseNightMap: { value: false },
      uNormalMap: { value: null },
      uUseNormalMap: { value: false },
      uSpecularMap: { value: null },
      uUseSpecularMap: { value: false },
      uCloudsMap: { value: null },
      uUseCloudsMap: { value: false },
      uCloudDrift: { value: 0.0 },
    };

    const earthGeometry = new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.67));
    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: earthUniforms,
      vertexShader: EARTH_SURFACE_VERTEX_SHADER,
      fragmentShader: EARTH_SURFACE_FRAGMENT_SHADER,
    });

    const surfaceMesh = new THREE.Mesh(earthGeometry, earthMaterial);
    surfaceMesh.name = 'EARTH';
    earthGroup.add(surfaceMesh);

    const cloudUniforms = {
      uCloudsMap: earthUniforms.uCloudsMap,
      uUseCloudsMap: earthUniforms.uUseCloudsMap,
      uSunDirection: earthUniforms.uSunDirection,
      uCloudDrift: earthUniforms.uCloudDrift,
    };

    const cloudGeometry = new THREE.SphereGeometry(
      radius * cloudScale,
      segments,
      Math.round(segments * 0.67)
    );
    const cloudMaterial = new THREE.ShaderMaterial({
      uniforms: cloudUniforms,
      vertexShader: EARTH_CLOUDS_VERTEX_SHADER,
      fragmentShader: EARTH_CLOUDS_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });

    const cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
    cloudMesh.name = 'EARTH_CLOUDS';
    cloudMesh.renderOrder = 2;
    surfaceMesh.add(cloudMesh);

    const atmoUniforms = {
      uSunDirection: earthUniforms.uSunDirection,
    };

    const atmoGeometry = new THREE.SphereGeometry(radius * atmoScale, 64, 48);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: atmoUniforms,
      vertexShader: EARTH_ATMO_HALO_VERTEX_SHADER,
      fragmentShader: EARTH_ATMO_HALO_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });

    const atmosphereMesh = new THREE.Mesh(atmoGeometry, atmosphereMaterial);
    atmosphereMesh.name = 'EARTH_ATMOSPHERE';
    atmosphereMesh.renderOrder = 3;
    earthGroup.add(atmosphereMesh);

    if (!initialTexture && options.loadRealTextures !== false && typeof document !== 'undefined') {
      const texLoader = new THREE.TextureLoader();
      texLoader.setCrossOrigin('anonymous');

      loadTextureWithFallback(
        texLoader,
        EARTH_CONFIG.DAY_LOCAL_URL,
        EARTH_CONFIG.DAY_REMOTE_URL,
        { srgb: true },
        (tex) => {
          earthUniforms.uDayMap.value = tex;
          earthUniforms.uUseDayMap.value = true;
        }
      );

      loadTextureWithFallback(
        texLoader,
        EARTH_CONFIG.NIGHT_LOCAL_URL,
        EARTH_CONFIG.NIGHT_REMOTE_URL,
        { srgb: true },
        (tex) => {
          earthUniforms.uNightMap.value = tex;
          earthUniforms.uUseNightMap.value = true;
        }
      );

      loadTextureWithFallback(
        texLoader,
        EARTH_CONFIG.NORMAL_LOCAL_URL,
        EARTH_CONFIG.NORMAL_REMOTE_URL,
        { srgb: false },
        (tex) => {
          earthUniforms.uNormalMap.value = tex;
          earthUniforms.uUseNormalMap.value = true;
        }
      );

      loadTextureWithFallback(
        texLoader,
        EARTH_CONFIG.SPECULAR_LOCAL_URL,
        EARTH_CONFIG.SPECULAR_REMOTE_URL,
        { srgb: false },
        (tex) => {
          earthUniforms.uSpecularMap.value = tex;
          earthUniforms.uUseSpecularMap.value = true;
        }
      );

      loadTextureWithFallback(
        texLoader,
        EARTH_CONFIG.CLOUDS_LOCAL_URL,
        EARTH_CONFIG.CLOUDS_REMOTE_URL,
        { srgb: true },
        (tex) => {
          earthUniforms.uCloudsMap.value = tex;
          earthUniforms.uUseCloudsMap.value = true;
        }
      );
    }

    earthGroup.userData = {
      surfaceMesh,
      cloudMesh,
      atmosphereMesh,
      earthMaterial,
      cloudMaterial,
      atmosphereMaterial,
      uniforms: earthUniforms,
      setTexture(nextTexture) {
        earthUniforms.uDayMap.value = nextTexture || null;
        earthUniforms.uUseDayMap.value = Boolean(nextTexture);
      },
      update(sunDir, elapsedSeconds, date) {
        if (sunDir) {
          earthUniforms.uSunDirection.value.copy(sunDir);
        }
        if (typeof elapsedSeconds === 'number') {
          earthUniforms.uTime.value = elapsedSeconds;
          earthUniforms.uCloudDrift.value = (elapsedSeconds * 0.00045) % 1.0;
        }
        if (date instanceof Date) {
          const utcHours =
            date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
          surfaceMesh.rotation.y = (utcHours / 24) * Math.PI * 2;
        }
      },
    };

    return earthGroup;
  }
}
