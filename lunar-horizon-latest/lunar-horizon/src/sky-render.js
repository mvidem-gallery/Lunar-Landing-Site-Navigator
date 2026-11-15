import * as THREE from '/three.js?v=terrain-v3';
import {earthTextureBasis, equatorialVector, lunarSkyBasis} from '/sky.js?v=sky-v1';
import {direction, dot} from '/math.js?v=orbit-v1';

export function createSkyVisuals(scene, enabled) {
  const vertex = `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 radial;
    void main() {
      radial = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
    }
  `;
  const plainEarth = new THREE.DataTexture(new Uint8Array([75, 120, 167, 255]), 1, 1);
  plainEarth.colorSpace = THREE.SRGBColorSpace;
  plainEarth.needsUpdate = true;
  const earthUniforms = {
    groundMap: {value: plainEarth},
    worldToEarth: {value: new THREE.Matrix3()},
    solarDirection: {value: new THREE.Vector3(1, 0, 0)},
    viewDirection: {value: new THREE.Vector3(0, 0, 1)},
  };
  const earthMaterial = new THREE.ShaderMaterial({
    vertexShader: vertex, uniforms: earthUniforms, toneMapped: false,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D groundMap;
      uniform mat3 worldToEarth;
      uniform vec3 solarDirection, viewDirection;
      varying vec3 radial;
      void main() {
        vec3 world = normalize(radial);
        vec3 surface = normalize(worldToEarth * world);
        vec2 uv = vec2(
          atan(surface.y, surface.x) / 6.28318530718 + 0.5,
          asin(clamp(surface.z, -1.0, 1.0)) / 3.14159265359 + 0.5
        );
        // Compute the texture footprint from the continuous sphere normal.
        // Derivatives of atan(y,x) itself jump at the antimeridian.
        vec3 dx = dFdx(surface), dy = dFdy(surface);
        float horizontal = max(dot(surface.xy, surface.xy), 1e-7);
        vec3 longitudeGradient = vec3(-surface.y, surface.x, 0.0) / (6.28318530718 * horizontal);
        float latitudeGradient = 1.0 / (3.14159265359 * sqrt(horizontal));
        vec3 color = textureGrad(groundMap, uv,
          vec2(dot(longitudeGradient, dx), dx.z * latitudeGradient),
          vec2(dot(longitudeGradient, dy), dy.z * latitudeGradient)).rgb;
        float sunlight = dot(surface, solarDirection);
        float day = pow(max(sunlight, 0.0), 0.62);
        float limb = pow(1.0 - max(dot(world, viewDirection), 0.0), 3.0);
        vec3 atmosphere = vec3(0.13, 0.31, 0.62) * limb * smoothstep(-0.10, 0.55, sunlight) * 0.38;
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(color * (0.005 + 0.95 * day) + atmosphere, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), earthMaterial);
  earth.visible = false;
  scene.add(earth);
  let earthTexture = plainEarth;
  let hasEarthOrientation = false;
  if (enabled) new THREE.TextureLoader().load('/earth-blue-marble.webp', texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    earthTexture = texture;
    if (hasEarthOrientation) earthUniforms.groundMap.value = texture;
  }, undefined, () => {});

  const sunMaterial = new THREE.ShaderMaterial({
    toneMapped: false,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 normalInView;
      void main() {
        normalInView = normalMatrix * normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      varying vec3 normalInView;
      void main() {
        float mu = clamp(normalize(normalInView).z, 0.0, 1.0);
        float luminance = 0.49 + 0.51 * mu;
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(vec3(1.0, 0.91, 0.72) * luminance, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), sunMaterial);
  sun.visible = false;
  scene.add(sun);

  const starFrame = new THREE.Group();
  starFrame.matrixAutoUpdate = false;
  starFrame.visible = false;
  scene.add(starFrame);
  if (enabled) void loadStars(starFrame);

  function update({time, lat, lon, earthRow, sunRow}) {
    const basis = lunarSkyBasis(time, lat, lon);
    starFrame.matrix.set(...basis.flatMap(row => [...row, 0]), 0, 0, 0, 1);
    starFrame.matrixWorldNeedsUpdate = true;
    starFrame.visible = true;
    const viewer = direction(earthRow[1], earthRow[2]).map(x => -x);
    earthUniforms.viewDirection.value.fromArray(viewer);
    hasEarthOrientation = earthRow.length === 11 && earthRow.slice(5).every(Number.isFinite);
    earthUniforms.groundMap.value = hasEarthOrientation ? earthTexture : plainEarth;
    if (hasEarthOrientation) {
      const [observerLon, observerLat, solarLon, solarLat, poleRA, poleDec] = earthRow.slice(5);
      const pole = equatorialVector(poleRA, poleDec);
      const north = basis.map(axis => dot(axis, pole));
      earthUniforms.worldToEarth.value.set(...earthTextureBasis(viewer, north, observerLon, observerLat).flat());
      earthUniforms.solarDirection.value.fromArray(equatorialVector(solarLon, solarLat));
    } else {
      // Preserve the geometric phase even when the orientation fields are absent.
      earthUniforms.worldToEarth.value.identity();
      const toSun = new THREE.Vector3(...direction(sunRow[1], sunRow[2])).multiplyScalar(sunRow[4]);
      const fromEarth = toSun.addScaledVector(earthUniforms.viewDirection.value, earthRow[4]).normalize();
      earthUniforms.solarDirection.value.copy(fromEarth);
    }
  }

  return {earth, sun, update, followCamera(position) {
    starFrame.matrix.setPosition(position);
    starFrame.matrixWorldNeedsUpdate = true;
  }};
}

async function loadStars(frame) {
  try {
    const response = await fetch('/stars-hyg.bin?v=mag73');
    if (!response.ok) return;
    const table = new DataView(await response.arrayBuffer());
    if (table.byteLength % 5) return;
    const count = table.byteLength / 5;
    const positions = new Float32Array(count * 3);
    const brightness = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const offset = i * 5;
      const ra = table.getUint16(offset, true) / 65536 * 360;
      const dec = table.getUint16(offset + 2, true) / 65535 * 180 - 90;
      const magnitude = table.getUint8(offset + 4) / 22 - 2;
      positions.set(equatorialVector(ra, dec).map(v => v * 1500000), i * 3);
      brightness[i] = Math.min(0.96, 0.9 * 10 ** (-0.077 * (magnitude + 0.6)));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('brightness', new THREE.BufferAttribute(brightness, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: {pixels: {value: Math.min(devicePixelRatio, 2)}},
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float brightness;
        uniform float pixels;
        varying float intensity;
        void main() {
          intensity = brightness;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
          gl_PointSize = (1.55 + 1.35 * brightness) * pixels;
        }
      `,
      fragmentShader: `
        #include <logdepthbuf_pars_fragment>
        varying float intensity;
        void main() {
          float fade = 1.0 - smoothstep(0.12, 0.50, length(gl_PointCoord - vec2(0.5)));
          #include <logdepthbuf_fragment>
        gl_FragColor = vec4(vec3(0.82, 0.87, 0.96), fade * intensity);
        }
      `,
    });
    const stars = new THREE.Points(geometry, material);
    stars.frustumCulled = false;
    frame.add(stars);
  } catch {
    // The scene remains usable if the optional catalogue is unavailable.
  }
}
