import * as THREE from 'three';
import { MOON_CONFIG, MAP_LAYERS, LOD_CONFIG } from '../config/constants.js';
import { TileCache } from './tileCache.js';

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

    if (
      !this.sourceSpec &&
      !manager.hasPotentialOverlay(this.z, this.lonStart, this.lonEnd, this.latStart, this.latEnd)
    ) {
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

    const layer = MAP_LAYERS[this.manager.currentLayerId];
    const baseMax = layer ? (layer.baseMaxZoom ?? 8) : 8;
    const radiusOffset =
      MOON_CONFIG.RADIUS + (isOverlay ? 0.000001 * Math.max(1, this.z - baseMax) : 0);

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
    this.mesh.renderOrder = isOverlay ? 2 + (this.z - baseMax) : 1;
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

  _intersectsBounds(lonStart, lonEnd, latStart, latEnd, bounds) {
    if (!bounds) return true;
    return (
      lonEnd > bounds.minLon &&
      lonStart < bounds.maxLon &&
      latEnd > bounds.minLat &&
      latStart < bounds.maxLat
    );
  }

  hasPotentialOverlay(z, lonStart, lonEnd, latStart, latEnd) {
    const layer = MAP_LAYERS[this.currentLayerId];
    if (!layer || !Array.isArray(layer.overlays)) return false;

    return layer.overlays.some((ov) => {
      const ovMax = ov.maxZoom ?? layer.maxZoom ?? LOD_CONFIG.MAX_ZOOM;
      return z <= ovMax && this._intersectsBounds(lonStart, lonEnd, latStart, latEnd, ov.bounds);
    });
  }

  resolveTileSource(z, lonStart, lonEnd, latStart, latEnd) {
    const layer = MAP_LAYERS[this.currentLayerId];
    if (!layer) return null;

    const baseMax = layer.baseMaxZoom ?? layer.maxZoom ?? 8;

    if (z <= baseMax) {
      return {
        sourceId: layer.id,
        url: layer.url,
        fallbackUrl: layer.fallbackUrl ?? null,
        isWebMercatorQuad: Boolean(layer.isWebMercatorQuad),
        isTms: Boolean(layer.isTms),
        isOverlay: false,
        isLocal: layer.url.startsWith('/') || layer.url.startsWith('./'),
      };
    }

    if (Array.isArray(layer.overlays)) {
      for (const overlay of layer.overlays) {
        const minZ = overlay.minZoom ?? baseMax + 1;
        const maxZ = overlay.maxZoom ?? layer.maxZoom;
        if (
          z >= minZ &&
          z <= maxZ &&
          this._intersectsBounds(lonStart, lonEnd, latStart, latEnd, overlay.bounds)
        ) {
          return {
            sourceId: overlay.id,
            url: overlay.url,
            fallbackUrl: overlay.fallbackUrl ?? null,
            trekDiscoveryQuery: overlay.trekDiscoveryQuery ?? null,
            isWebMercatorQuad: Boolean(overlay.isWebMercatorQuad),
            isTms: Boolean(overlay.isTms),
            isOverlay: true,
            isLocal: false,
          };
        }
      }
    }

    return null;
  }

  canNodeSplit(node) {
    const layer = MAP_LAYERS[this.currentLayerId];
    if (!layer) return false;

    const maxLayerZoom = layer.maxZoom ?? LOD_CONFIG.MAX_ZOOM;
    if (node.z >= maxLayerZoom) return false;

    const nextZ = node.z + 1;
    const baseMax = layer.baseMaxZoom ?? maxLayerZoom;
    if (nextZ <= baseMax) return true;

    return this.hasPotentialOverlay(nextZ, node.lonStart, node.lonEnd, node.latStart, node.latEnd);
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
    if (!layerId || !MAP_LAYERS[layerId] || this.currentLayerId === layerId) return;
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
      shader.uniforms.uSunDirection = this.sharedUniforms.uSunDirection;
      shader.uniforms.uShowEarthDisk = this.sharedUniforms.uShowEarthDisk;
      shader.uniforms.uHorizonThreshold = this.sharedUniforms.uHorizonThreshold;
      shader.uniforms.uShowIlluminationHeatmap = this.sharedUniforms.uShowIlluminationHeatmap;
      shader.uniforms.uHeatmapOpacity = this.sharedUniforms.uHeatmapOpacity;
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
           uniform vec3 uSunDirection;
           uniform bool uShowEarthDisk;
           uniform float uHorizonThreshold;

           uniform bool uShowIlluminationHeatmap;
           uniform float uHeatmapOpacity;

           uniform bool uShowCoordGrid;
           uniform float uGridStepDeg;
           uniform float uGridSubStepDeg;
           uniform float uGridOpacity;

           vec3 sampleIlluminationHeatmap(float t) {
             float x = clamp(t, 0.0, 1.0);
             vec3 c0 = vec3(0.820, 0.102, 0.059);
             vec3 c1 = vec3(0.961, 0.341, 0.078);
             vec3 c2 = vec3(0.988, 0.722, 0.161);
             vec3 c3 = vec3(0.961, 0.961, 0.420);
             vec3 c4 = vec3(0.451, 0.922, 0.851);
             vec3 c5 = vec3(0.161, 0.349, 0.961);
             vec3 c6 = vec3(0.678, 0.180, 0.922);

             if (x < 0.25) return mix(c0, c1, x / 0.25);
             if (x < 0.52) return mix(c1, c2, (x - 0.25) / 0.27);
             if (x < 0.74) return mix(c2, c3, (x - 0.52) / 0.22);
             if (x < 0.86) return mix(c3, c4, (x - 0.74) / 0.12);
             if (x < 0.95) return mix(c4, c5, (x - 0.86) / 0.09);
             return mix(c5, c6, (x - 0.95) / 0.05);
           }

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
          `if (uShowIlluminationHeatmap) {
             float sunCos = clamp(dot(normalize(vWorldSphereNormal), normalize(uSunDirection)), 0.0, 1.0);
             vec3 heatColor = sampleIlluminationHeatmap(sunCos);
             gl_FragColor.rgb = mix(gl_FragColor.rgb, heatColor, uHeatmapOpacity);
           }

           if (uShowEarthDisk) {
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

      const distToCamera = Math.max(0.00005, camPos.distanceTo(node.centerWorld) - node.boundingRadius * 0.5);
      const tileArcLength = (Math.PI * MOON_CONFIG.RADIUS) / Math.pow(2, node.z);
      const screenRatio = tileArcLength / distToCamera;

      const wantSplit = screenRatio > (1.0 / LOD_CONFIG.SPLIT_THRESHOLD) && this.canNodeSplit(node);

      if (wantSplit && !node.hasFailed) {
        if (!node.children) {
          node.split();
        }

        const isOverlayZone = node.z >= baseMaxZoom;

        if (isOverlayZone) {
          if (node.isReady && node.mesh) {
            node.mesh.visible = true;
            highestVisibleZoom = Math.max(highestVisibleZoom, node.z);
          }

          for (const child of node.children) {
            if (child.hasFailed) {
              if (child.mesh) child.mesh.visible = false;
              continue;
            }
            if (child.sourceSpec && !child.isReady) {
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
        if (!node.isReady && node.sourceSpec) {
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
