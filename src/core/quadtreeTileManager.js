import * as THREE from 'three';
import { MOON_CONFIG, MAP_LAYERS, LOD_CONFIG } from '../config/constants.js';

class TileCache {
  constructor(maxSize = LOD_CONFIG.CACHE_SIZE) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.pending = new Map();
    this.failed = new Set();
    this.queue = [];
    this.activeRequests = 0;
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
  }

  clear() {
    this.queue = [];
    this.pending.clear();
    this.failed.clear();
    for (const tex of this.cache.values()) {
      tex.dispose();
    }
    this.cache.clear();
  }

  get(key) {
    if (this.cache.has(key)) {
      const tex = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, tex);
      return tex;
    }
    return null;
  }

  set(key, texture) {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldTex = this.cache.get(oldestKey);
      if (oldTex) oldTex.dispose();
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, texture);
  }

  requestTile(sourceSpec, z, x, y, priority, onLoad, onError) {
    const key = `${sourceSpec.sourceId}_${z}_${y}_${x}`;

    if (!sourceSpec || !sourceSpec.url || this.failed.has(key)) {
      if (onError) onError();
      return;
    }

    const cached = this.get(key);
    if (cached) {
      onLoad(cached);
      return;
    }

    if (this.pending.has(key)) {
      const entry = this.pending.get(key);
      entry.callbacks.push({ onLoad, onError });
      entry.priority = Math.min(entry.priority, priority);
      return;
    }

    const entry = {
      key,
      sourceSpec,
      z,
      x,
      y,
      priority,
      callbacks: [{ onLoad, onError }],
    };

    this.pending.set(key, entry);
    this.queue.push(entry);
    this.processQueue();
  }

  buildUrl(urlTemplate, z, x, y, isWebMercatorQuad) {
    let targetY = y;
    if (isWebMercatorQuad) {
      const maxRow = Math.pow(2, z) - 1;
      targetY = maxRow - y;
    }
    return urlTemplate
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', targetY);
  }

  processQueue() {
    if (this.activeRequests >= LOD_CONFIG.MAX_CONCURRENT_REQUESTS || this.queue.length === 0) {
      return;
    }

    this.queue.sort((a, b) => a.priority - b.priority);
    const entry = this.queue.shift();
    this.activeRequests++;

    const primaryUrl = this.buildUrl(
      entry.sourceSpec.url,
      entry.z,
      entry.x,
      entry.y,
      entry.sourceSpec.isWebMercatorQuad
    );

    const handleSuccess = (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 8;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;

      this.set(entry.key, texture);
      this.pending.delete(entry.key);
      this.activeRequests--;

      for (const cb of entry.callbacks) {
        cb.onLoad(texture);
      }
      this.processQueue();
    };

    const handleFinalFailure = () => {
      this.failed.add(entry.key);
      this.pending.delete(entry.key);
      this.activeRequests--;

      for (const cb of entry.callbacks) {
        if (cb.onError) cb.onError();
      }
      this.processQueue();
    };

    this.loader.load(
      primaryUrl,
      handleSuccess,
      undefined,
() => {
        if (entry.sourceSpec.fallbackUrl && entry.z <= 8) {
          const fbUrl = this.buildUrl(
            entry.sourceSpec.fallbackUrl,
            entry.z,
            entry.x,
            entry.y,
            entry.sourceSpec.isWebMercatorQuad
          );
          this.loader.load(fbUrl, handleSuccess, undefined, handleFinalFailure);
        } else {
          handleFinalFailure();
        }
      }
    );
  }
}

class QuadNode {
  constructor(manager, z, x, y, parent = null) {
    this.manager = manager;
    this.z = z;
    this.x = x;
    this.y = y;
    this.parent = parent;
    this.children = null;
    this.mesh = null;
    this.isReady = false;
    this.isLoading = false;
    this.hasFailed = false;

    const cols = manager.getColsCount(z);
    const rows = manager.getRowsCount(z);

    this.lonStart = -180 + (x / cols) * 360;
    this.lonEnd = -180 + ((x + 1) / cols) * 360;
    this.latStart = 90 - ((y + 1) / rows) * 180;
    this.latEnd = 90 - (y / rows) * 180;

    this.sourceSpec = manager.resolveTileSource(
      this.z,
      this.lonStart,
      this.lonEnd,
      this.latStart,
      this.latEnd
    );

    if (!this.sourceSpec) {
      this.hasFailed = true;
    }

    const midLon = THREE.MathUtils.degToRad((this.lonStart + this.lonEnd) * 0.5);
    const midLat = THREE.MathUtils.degToRad((this.latStart + this.latEnd) * 0.5);

    this.centerNormal = new THREE.Vector3(
      Math.cos(midLat) * Math.cos(midLon),
      Math.sin(midLat),
      -Math.cos(midLat) * Math.sin(midLon)
    ).normalize();

    this.centerWorld = this.centerNormal.clone().multiplyScalar(MOON_CONFIG.RADIUS);
    const latSpanRad = THREE.MathUtils.degToRad(this.latEnd - this.latStart);
    this.boundingRadius = MOON_CONFIG.RADIUS * latSpanRad * 0.85;
  }

  createMesh(texture) {
    if (this.mesh) {
      this.mesh.material.map = texture;
      this.mesh.material.bumpMap = texture;
      this.mesh.material.needsUpdate = true;
      return;
    }

    const phiStart = THREE.MathUtils.degToRad(this.lonStart);
    const phiLength = THREE.MathUtils.degToRad(this.lonEnd - this.lonStart);
    const thetaStart = THREE.MathUtils.degToRad(90 - this.latEnd);
    const thetaLength = THREE.MathUtils.degToRad(this.latEnd - this.latStart);

    const segs = this.z <= 4 ? 16 : this.z <= 8 ? 8 : 4;
    const isOverlay = Boolean(this.sourceSpec && this.sourceSpec.isOverlay);
    const radiusOffset = MOON_CONFIG.RADIUS + this.z * 0.000012;

    const geometry = new THREE.SphereGeometry(
      radiusOffset,
      segs,
      segs,
      phiStart,
      phiLength,
      thetaStart,
      thetaLength
    );

    const material = this.manager.createTileMaterial(texture, isOverlay, this.z);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.rotation.y = Math.PI;
    this.mesh.renderOrder = isOverlay ? 2 : 1;
    this.mesh.visible = false;
    this.manager.group.add(this.mesh);
  }

  requestTexture(priority) {
    if (this.isReady || this.isLoading || this.hasFailed || !this.sourceSpec) return;
    this.isLoading = true;

    this.manager.cache.requestTile(
      this.sourceSpec,
      this.z,
      this.x,
      this.y,
      priority,
      (texture) => {
        this.isLoading = false;
        this.createMesh(texture);
        this.isReady = true;
      },
      () => {
        this.isLoading = false;
        this.hasFailed = true;
      }
    );
  }

  split() {
    if (this.children || this.hasFailed) return;
    const nextZ = this.z + 1;
    const nextX = this.x * 2;
    const nextY = this.y * 2;

    this.children = [
      new QuadNode(this.manager, nextZ, nextX, nextY, this),
      new QuadNode(this.manager, nextZ, nextX + 1, nextY, this),
      new QuadNode(this.manager, nextZ, nextX, nextY + 1, this),
      new QuadNode(this.manager, nextZ, nextX + 1, nextY + 1, this),
    ];
  }

  merge() {
    if (!this.children) return;
    for (const child of this.children) {
      child.dispose();
    }
    this.children = null;
  }

  dispose() {
    this.merge();
    if (this.mesh) {
      this.manager.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.isReady = false;
    this.isLoading = false;
  }
}

export class QuadtreeTileManager {
  constructor(parentGroup, sharedUniforms) {
    this.group = new THREE.Group();
    parentGroup.add(this.group);

    this.sharedUniforms = sharedUniforms;
    this.currentLayerId = LOD_CONFIG.DEFAULT_LAYER;
    this.cache = new TileCache(LOD_CONFIG.CACHE_SIZE);
    this.roots = [];

    this._frustum = new THREE.Frustum();
    this._projScreenMatrix = new THREE.Matrix4();
    this._boundingSphere = new THREE.Sphere();
    this._camDir = new THREE.Vector3();

    this.initRoots();
  }

  getColsCount(z) {
    const layer = MAP_LAYERS[this.currentLayerId];
    return layer && layer.isWebMercatorQuad ? Math.pow(2, z) : Math.pow(2, z + 1);
  }

  getRowsCount(z) {
    return Math.pow(2, z);
  }

  /**
   * Перевіряє перетин географічного прямокутника тайлу з межами оверлею.
   */
  _intersectsBounds(lonStart, lonEnd, latStart, latEnd, bounds) {
    if (!bounds) return true;
    return (
      lonEnd > bounds.minLon &&
      lonStart < bounds.maxLon &&
      latEnd > bounds.minLat &&
      latStart < bounds.maxLat
    );
  }

  /**
   * Визначає джерело тайлу: глобальний шар для Z <= baseMaxZoom або регіональний оверлей для Z > baseMaxZoom.
   */
  resolveTileSource(z, lonStart, lonEnd, latStart, latEnd) {
    const layer = MAP_LAYERS[this.currentLayerId];
    if (!layer) return null;

    const baseMax = layer.baseMaxZoom ?? layer.maxZoom ?? 8;

    if (z <= baseMax) {
      return {
        sourceId: layer.id,
        url: layer.url,
        fallbackUrl: layer.fallbackUrl,
        isWebMercatorQuad: Boolean(layer.isWebMercatorQuad),
        isOverlay: false,
      };
    }

    if (Array.isArray(layer.overlays)) {
      for (const overlay of layer.overlays) {
        const minZ = overlay.minZoom ?? baseMax + 1;
        const maxZ = overlay.maxZoom ?? layer.maxZoom;
        if (z >= minZ && z <= maxZ && this._intersectsBounds(lonStart, lonEnd, latStart, latEnd, overlay.bounds)) {
          return {
            sourceId: overlay.id,
            url: overlay.url,
            fallbackUrl: null,
            isWebMercatorQuad: Boolean(overlay.isWebMercatorQuad),
            isOverlay: true,
          };
        }
      }
    }

    return null;
  }

  /**
   * Перевіряє, чи має вузол потенціал подальшого поділу на рівні Z + 1.
   */
  canNodeSplit(node) {
    const layer = MAP_LAYERS[this.currentLayerId];
    if (!layer) return false;

    const maxLayerZoom = layer.maxZoom ?? LOD_CONFIG.MAX_ZOOM;
    if (node.z >= maxLayerZoom) return false;

    const nextZ = node.z + 1;
    const baseMax = layer.baseMaxZoom ?? maxLayerZoom;
    if (nextZ <= baseMax) return true;

    if (!Array.isArray(layer.overlays) || layer.overlays.length === 0) {
      return false;
    }

    return layer.overlays.some((ov) => {
      const ovMax = ov.maxZoom ?? maxLayerZoom;
      return nextZ <= ovMax && this._intersectsBounds(node.lonStart, node.lonEnd, node.latStart, node.latEnd, ov.bounds);
    });
  }

  initRoots() {
    this.clearRoots();
    const minZ = LOD_CONFIG.MIN_ZOOM;
    const cols = this.getColsCount(minZ);
    const rows = this.getRowsCount(minZ);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const root = new QuadNode(this, minZ, x, y);
        root.requestTexture(0);
        this.roots.push(root);
      }
    }
  }

  clearRoots() {
    for (const root of this.roots) {
      root.dispose();
    }
    this.roots = [];
  }

  switchMapLayer(layerId) {
    if (!MAP_LAYERS[layerId] || this.currentLayerId === layerId) return;
    this.currentLayerId = layerId;
    this.cache.clear();
    this.initRoots();
  }

  createTileMaterial(texture, isOverlay = false, zoomLevel = 2) {
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      bumpMap: texture,
      bumpScale: MOON_CONFIG.BUMP_SCALE * (isOverlay ? 0.25 : 0.4),
      roughness: 0.95,
      metalness: 0.0,
      transparent: isOverlay,
      depthWrite: !isOverlay,
      polygonOffset: isOverlay,
      polygonOffsetFactor: isOverlay ? -1 : 0,
      polygonOffsetUnits: isOverlay ? -zoomLevel : 0,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uEarthDirection = this.sharedUniforms.uEarthDirection;
      shader.uniforms.uShowEarthDisk = this.sharedUniforms.uShowEarthDisk;
      shader.uniforms.uHorizonThreshold = this.sharedUniforms.uHorizonThreshold;
      shader.uniforms.uShowCoordGrid = this.sharedUniforms.uShowCoordGrid;
      shader.uniforms.uGridStepDeg = this.sharedUniforms.uGridStepDeg;
      shader.uniforms.uGridSubStepDeg = this.sharedUniforms.uGridSubStepDeg;
      shader.uniforms.uGridOpacity = this.sharedUniforms.uGridOpacity;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWorldSphereNormal;
           varying vec3 vLocalSpherePos;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vLocalSpherePos = position;
           vWorldSphereNormal = normalize((modelMatrix * vec4(position, 1.0)).xyz);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWorldSphereNormal;
           varying vec3 vLocalSpherePos;
           uniform vec3 uEarthDirection;
           uniform bool uShowEarthDisk;
           uniform float uHorizonThreshold;

           uniform bool uShowCoordGrid;
           uniform float uGridStepDeg;
           uniform float uGridSubStepDeg;
           uniform float uGridOpacity;

           float gridLineMask(float angleDeg, float stepDeg, float thicknessPx) {
             float halfStep = stepDeg * 0.5;
             float dist = abs(mod(angleDeg + halfStep, stepDeg) - halfStep);
             float deriv = max(fwidth(angleDeg), 1e-5);
             return 1.0 - smoothstep(0.0, deriv * thicknessPx, dist);
           }

           float hash31(vec3 p) {
             p = fract(p * 0.1031);
             p += dot(p, p.yzx + 33.33);
             return fract((p.x + p.y) * p.z);
           }

           float noise3D(vec3 x) {
             vec3 i = floor(x);
             vec3 f = fract(x);
             f = f * f * (3.0 - 2.0 * f);
             return mix(
               mix(mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
                   mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
                   mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y),
               f.z
             );
           }

           float lunarMicroDetail(vec3 pos) {
             float n1 = noise3D(pos * 1800.0);
             float n2 = noise3D(pos * 5400.0);
             float n3 = noise3D(pos * 16000.0);
             float craters = smoothstep(0.62, 0.85, n1) * 0.5 + smoothstep(0.68, 0.9, n2) * 0.35;
             float grit = (n3 - 0.5) * 0.35;
             return (craters - 0.35) * 0.6 + grit;
           }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float camAlt = max(0.001, length(cameraPosition) - 1.0);
           float detailWeight = 1.0 - smoothstep(0.002, 0.04, camAlt);
           if (detailWeight > 0.01) {
             float micro = lunarMicroDetail(normalize(vLocalSpherePos));
             diffuseColor.rgb *= (1.0 + micro * 0.28 * detailWeight);
           }`
        )
        .replace(
          '#include <dithering_fragment>',
          `if (uShowEarthDisk) {
             float cosAngle = dot(normalize(vWorldSphereNormal), normalize(uEarthDirection));
             if (cosAngle >= uHorizonThreshold) {
               vec3 diskTint = vec3(0.12, 0.56, 1.0);
               gl_FragColor.rgb = mix(gl_FragColor.rgb, diskTint, 0.14);
               float borderMask = 1.0 - smoothstep(uHorizonThreshold, uHorizonThreshold + 0.018, cosAngle);
               gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.35, 0.78, 1.0), borderMask * 0.75);
             }
           }

           if (uShowCoordGrid) {
             vec3 nLocal = normalize(vLocalSpherePos);
             float latDeg = degrees(asin(clamp(nLocal.y, -1.0, 1.0)));
             float lonDeg = degrees(atan(nLocal.z, -nLocal.x));

             float equatorMask = 1.0 - smoothstep(0.0, max(fwidth(latDeg), 1e-5) * 2.2, abs(latDeg));
             float pmDistDeg = degrees(asin(clamp(abs(nLocal.z) / max(length(nLocal.xz), 1e-5), 0.0, 1.0)));
             float pmDeriv = max(fwidth(nLocal.z) * 57.29578 / max(length(nLocal.xz), 0.15), 1e-5);
             float primeMeridianMask = 1.0 - smoothstep(0.0, pmDeriv * 2.2, pmDistDeg);
             float axisMask = max(equatorMask, primeMeridianMask);

             float subLat = gridLineMask(latDeg, uGridSubStepDeg, 1.1) * (1.0 - equatorMask);
             float subLon = gridLineMask(lonDeg, uGridSubStepDeg, 1.1) * (1.0 - primeMeridianMask);
             float subMask = max(subLat, subLon);

             float majorLat = gridLineMask(latDeg, uGridStepDeg, 1.6) * (1.0 - equatorMask);
             float majorLon = gridLineMask(lonDeg, uGridStepDeg, 1.6) * (1.0 - primeMeridianMask);
             float majorMask = max(majorLat, majorLon);

             vec3 subColor = vec3(0.35, 0.82, 0.95);
             vec3 majorColor = vec3(0.25, 0.92, 0.85);
             vec3 axisColor = vec3(1.0, 0.78, 0.25);

             gl_FragColor.rgb = mix(gl_FragColor.rgb, subColor, subMask * uGridOpacity * 0.35);
             gl_FragColor.rgb = mix(gl_FragColor.rgb, majorColor, majorMask * uGridOpacity * 0.75);
             gl_FragColor.rgb = mix(gl_FragColor.rgb, axisColor, axisMask * min(1.0, uGridOpacity * 1.25));
           }
           #include <dithering_fragment>`
        );
    };

    return material;
  }

  update(camera) {
    camera.updateMatrixWorld();
    this._projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    const camPos = camera.position;
    const camDist = camPos.length();
    this._camDir.copy(camPos).divideScalar(camDist);

    const horizonCos = MOON_CONFIG.RADIUS / camDist;
    const layer = MAP_LAYERS[this.currentLayerId];
    const baseMaxZoom = layer ? (layer.baseMaxZoom ?? layer.maxZoom ?? 8) : 8;

    let highestVisibleZoom = LOD_CONFIG.MIN_ZOOM;

    const traverse = (node) => {
      const dot = node.centerNormal.dot(this._camDir);
      const angularMargin = Math.sin(node.boundingRadius / MOON_CONFIG.RADIUS) * 1.5;

      if (dot < horizonCos - angularMargin) {
        if (node.mesh) node.mesh.visible = false;
        if (node.children) node.merge();
        return;
      }

      this._boundingSphere.center.copy(node.centerWorld);
      this._boundingSphere.radius = node.boundingRadius;
      if (!this._frustum.intersectsSphere(this._boundingSphere)) {
        if (node.mesh) node.mesh.visible = false;
        if (node.children) node.merge();
        return;
      }

      const distToCamera = Math.max(0.0005, camPos.distanceTo(node.centerWorld) - node.boundingRadius * 0.5);
      const tileArcLength = (Math.PI * MOON_CONFIG.RADIUS) / Math.pow(2, node.z);
      const screenRatio = tileArcLength / distToCamera;

      const wantSplit = screenRatio > (1.0 / LOD_CONFIG.SPLIT_THRESHOLD) && this.canNodeSplit(node);

      if (wantSplit && !node.hasFailed) {
        if (!node.children) {
          node.split();
        }

        const isTransitionToOverlay = node.z === baseMaxZoom;

        if (isTransitionToOverlay) {
          // Базовий тайл Z8 завжди залишається видимою підкладкою,
          // а дочірні оверлеї Z9+ підвантажуються і накладаються зверху лише в межах своїх bounds
          if (node.isReady && node.mesh) {
            node.mesh.visible = true;
            highestVisibleZoom = Math.max(highestVisibleZoom, node.z);
          }

          for (const child of node.children) {
            if (!child.sourceSpec || child.hasFailed) {
              if (child.mesh) child.mesh.visible = false;
              continue;
            }
            if (!child.isReady) {
              child.requestTexture(distToCamera);
              if (child.mesh) child.mesh.visible = false;
            } else {
              traverse(child);
            }
          }
        } else {
          let allChildrenReady = true;
          let anyChildFailed = false;

          for (const child of node.children) {
            if (child.hasFailed) {
              anyChildFailed = true;
              break;
            }
            if (!child.isReady) {
              allChildrenReady = false;
              child.requestTexture(distToCamera);
            }
          }

          if (anyChildFailed) {
            node.merge();
            if (node.isReady && node.mesh) {
              node.mesh.visible = true;
              highestVisibleZoom = Math.max(highestVisibleZoom, node.z);
            }
          } else if (allChildrenReady) {
            if (node.mesh) node.mesh.visible = false;
            for (const child of node.children) {
              traverse(child);
            }
          } else {
            if (node.isReady && node.mesh) {
              node.mesh.visible = true;
              highestVisibleZoom = Math.max(highestVisibleZoom, node.z);
            }
            for (const child of node.children) {
              if (child.mesh) child.mesh.visible = false;
            }
          }
        }
      } else {
        if (node.children) {
          node.merge();
        }
        if (!node.isReady) {
          node.requestTexture(distToCamera);
        }
        if (node.isReady && node.mesh) {
          node.mesh.visible = true;
          highestVisibleZoom = Math.max(highestVisibleZoom, node.z);
        }
      }
    };

    for (const root of this.roots) {
      traverse(root);
    }

    return highestVisibleZoom;
  }
}