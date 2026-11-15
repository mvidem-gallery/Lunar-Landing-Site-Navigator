import * as THREE from 'three';
import { MOON_CONFIG, OVERLAY_CONFIG } from '../config/constants.js';

export class VisualOverlayManager {
  constructor(sharedUniforms = {}, lightingSystem = null, parentGroup = null) {
    this.uniforms = sharedUniforms || {};
    this.lightingSystem = lightingSystem;

    if (!this.uniforms.uEarthDirection) {
      this.uniforms.uEarthDirection = { value: new THREE.Vector3(1, 0, 0) };
    }
    if (!this.uniforms.uSunDirection) {
      this.uniforms.uSunDirection = { value: new THREE.Vector3(1, 0, 0) };
    }
    if (!this.uniforms.uShowEarthDisk) {
      this.uniforms.uShowEarthDisk = { value: false };
    }
    if (!this.uniforms.uHorizonThreshold) {
      this.uniforms.uHorizonThreshold = { value: MOON_CONFIG.HORIZON_THRESHOLD };
    }
    if (!this.uniforms.uShowIlluminationHeatmap) {
      this.uniforms.uShowIlluminationHeatmap = { value: false };
    }
    if (!this.uniforms.uHeatmapOpacity) {
      this.uniforms.uHeatmapOpacity = { value: OVERLAY_CONFIG.HEATMAP_OPACITY };
    }
    if (!this.uniforms.uShowCoordGrid) {
      this.uniforms.uShowCoordGrid = { value: false };
    }
    if (!this.uniforms.uGridStepDeg) {
      this.uniforms.uGridStepDeg = { value: OVERLAY_CONFIG.GRID_DEFAULT_STEP_DEG };
    }
    if (!this.uniforms.uGridSubStepDeg) {
      this.uniforms.uGridSubStepDeg = { value: OVERLAY_CONFIG.GRID_DEFAULT_SUB_STEP_DEG };
    }
    if (!this.uniforms.uGridOpacity) {
      this.uniforms.uGridOpacity = { value: OVERLAY_CONFIG.GRID_DEFAULT_OPACITY };
    }

    this.gridLabelsGroup = new THREE.Group();
    this.gridLabelsGroup.visible = Boolean(this.uniforms.uShowCoordGrid.value);

    if (parentGroup && typeof parentGroup.add === 'function') {
      parentGroup.add(this.gridLabelsGroup);
    }

    this.textureCache = new Map();
    this.meshPool = [];
    this.activeMeshCount = 0;

    this._camDir = new THREE.Vector3();
    this._cellNormal = new THREE.Vector3();
    this._frustum = new THREE.Frustum();
    this._projScreenMatrix = new THREE.Matrix4();
    this._boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.05);
  }

  attachToGroup(parentGroup) {
    if (parentGroup && this.gridLabelsGroup.parent !== parentGroup) {
      parentGroup.add(this.gridLabelsGroup);
    }
  }

  setEarthDiskVisible(isVisible) {
    if (this.uniforms.uShowEarthDisk) {
      this.uniforms.uShowEarthDisk.value = Boolean(isVisible);
    }
  }

  setSolarLightingEnabled(isEnabled) {
    if (this.lightingSystem && typeof this.lightingSystem.setSolarLightingEnabled === 'function') {
      this.lightingSystem.setSolarLightingEnabled(Boolean(isEnabled));
    }
  }

  setIlluminationHeatmapVisible(isVisible) {
    if (this.uniforms.uShowIlluminationHeatmap) {
      this.uniforms.uShowIlluminationHeatmap.value = Boolean(isVisible);
    }
  }

  setCoordGridVisible(isVisible) {
    const enabled = Boolean(isVisible);
    this.uniforms.uShowCoordGrid.value = enabled;
    this.gridLabelsGroup.visible = enabled;
    if (!enabled) {
      this.hideUnusedMeshes(0);
    }
  }

  updateAdaptiveGrid(altitudeUnits) {
    if (!this.uniforms.uShowCoordGrid.value) return;

    if (altitudeUnits > 1.2) {
      this.uniforms.uGridStepDeg.value = 30.0;
      this.uniforms.uGridSubStepDeg.value = 10.0;
    } else if (altitudeUnits > 0.35) {
      this.uniforms.uGridStepDeg.value = 15.0;
      this.uniforms.uGridSubStepDeg.value = 5.0;
    } else if (altitudeUnits > 0.08) {
      this.uniforms.uGridStepDeg.value = 5.0;
      this.uniforms.uGridSubStepDeg.value = 1.0;
    } else if (altitudeUnits > 0.015) {
      this.uniforms.uGridStepDeg.value = 1.0;
      this.uniforms.uGridSubStepDeg.value = 0.25;
    } else {
      this.uniforms.uGridStepDeg.value = 0.25;
      this.uniforms.uGridSubStepDeg.value = 0.05;
    }
  }

  formatSingleCoord(deg, isLat, stepDeg) {
    const decimals = stepDeg < 0.5 ? 2 : stepDeg < 1.0 ? 1 : 0;
    const absVal = Math.abs(deg);

    if (absVal < 1e-4) {
      return isLat ? '0°EQ' : '0°PM';
    }

    const formatted = absVal.toFixed(decimals);
    if (isLat) {
      return `${formatted}°${deg > 0 ? 'N' : 'S'}`;
    }
    return `${formatted}°${deg > 0 ? 'E' : 'W'}`;
  }

  formatCellLabel(latDeg, lonDeg, stepDeg) {
    const lonStr = this.formatSingleCoord(lonDeg, false, stepDeg);
    const latStr = this.formatSingleCoord(latDeg, true, stepDeg);
    return `${lonStr} ${latStr}`;
  }

  getLabelTexture(text, isAxis) {
    const cacheKey = `hud_br_${text}_${isAxis ? '1' : '0'}`;
    if (this.textureCache.has(cacheKey)) {
      return this.textureCache.get(cacheKey);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const primaryColor = isAxis ? 'rgba(255, 210, 102, 0.92)' : 'rgba(130, 240, 255, 0.88)';
    const accentColor = isAxis ? 'rgba(255, 210, 102, 0.55)' : 'rgba(110, 243, 230, 0.45)';

    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(canvas.width - 22, canvas.height - 4);
    ctx.lineTo(canvas.width - 4, canvas.height - 4);
    ctx.lineTo(canvas.width - 4, canvas.height - 22);
    ctx.stroke();

    ctx.font = '400 32px "Rajdhani", "Segoe UI", "Roboto", sans-serif';
    if ('letterSpacing' in ctx) {
      ctx.letterSpacing = '3.5px';
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';

    ctx.shadowColor = 'rgba(2, 6, 14, 0.95)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;

    ctx.fillStyle = primaryColor;
    ctx.fillText(text, canvas.width - 14, canvas.height - 8);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;

    if (this.textureCache.size > 500) {
      const oldestKey = this.textureCache.keys().next().value;
      this.textureCache.get(oldestKey).dispose();
      this.textureCache.delete(oldestKey);
    }

    this.textureCache.set(cacheKey, texture);
    return texture;
  }

  getPooledMesh(index) {
    if (index < this.meshPool.length) {
      return this.meshPool[index];
    }

    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      opacity: 0.96,
    });

    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.rotation.y = Math.PI;
    mesh.renderOrder = 5;
    this.gridLabelsGroup.add(mesh);
    this.meshPool.push(mesh);
    return mesh;
  }

  hideUnusedMeshes(startIndex) {
    for (let i = startIndex; i < this.meshPool.length; i++) {
      this.meshPool[i].visible = false;
    }
  }

  getWorldNormalFromLatLon(latDeg, lonDeg, outVec) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    outVec.set(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.sin(latRad),
      -Math.cos(latRad) * Math.sin(lonRad)
    ).normalize();
    return outVec;
  }

  placeCellCornerLabel(text, cellMinLatDeg, cellMinLonDeg, stepDeg, isAxis, camDir, horizonCos) {
    const patchRadius = MOON_CONFIG.RADIUS + 0.00045;
    const marginDeg = stepDeg * 0.025;

    const aspect = 640 / 96;
    const cosMidLat = Math.max(0.15, Math.cos(THREE.MathUtils.degToRad(cellMinLatDeg + stepDeg * 0.5)));
    const maxLonSpanDeg = stepDeg * 0.92;
    const desiredLatSpanDeg = stepDeg * 0.13;

    const patchLatSpanDeg = Math.min(desiredLatSpanDeg, (maxLonSpanDeg * cosMidLat) / aspect);
    const patchLonSpanDeg = (patchLatSpanDeg * aspect) / cosMidLat;

    const startLatDeg = cellMinLatDeg + marginDeg;
    const startLonDeg = cellMinLonDeg + stepDeg - marginDeg - patchLonSpanDeg;

    if (startLatDeg + patchLatSpanDeg > 87.5 || startLatDeg < -87.5) return;

    const midLatDeg = startLatDeg + patchLatSpanDeg * 0.5;
    const midLonDeg = startLonDeg + patchLonSpanDeg * 0.5;
    this.getWorldNormalFromLatLon(midLatDeg, midLonDeg, this._cellNormal);

    // Дозволяємо відображення міток аж до самого лімба планети
    if (this._cellNormal.dot(camDir) <= horizonCos - 0.05) return;

    this._boundingSphere.center.copy(this._cellNormal).multiplyScalar(patchRadius);
    this._boundingSphere.radius = THREE.MathUtils.degToRad(patchLonSpanDeg * cosMidLat) * 0.6;
    if (!this._frustum.intersectsSphere(this._boundingSphere)) return;

    const normalizedLonDeg = ((startLonDeg % 360) + 360) % 360;
    const phiStart = THREE.MathUtils.degToRad(normalizedLonDeg);
    const phiLength = THREE.MathUtils.degToRad(patchLonSpanDeg);
    const thetaStart = THREE.MathUtils.degToRad(90.0 - (startLatDeg + patchLatSpanDeg));
    const thetaLength = THREE.MathUtils.degToRad(patchLatSpanDeg);

    const mesh = this.getPooledMesh(this.activeMeshCount++);
    const key = `${phiStart.toFixed(5)}_${phiLength.toFixed(5)}_${thetaStart.toFixed(5)}_${thetaLength.toFixed(5)}`;

    if (mesh.userData.geomKey !== key) {
      if (mesh.geometry) mesh.geometry.dispose();
      mesh.geometry = new THREE.SphereGeometry(
        patchRadius,
        8,
        3,
        phiStart,
        phiLength,
        thetaStart,
        thetaLength
      );
      mesh.userData.geomKey = key;
    }

    mesh.material.map = this.getLabelTexture(text, isAxis);
    mesh.material.needsUpdate = true;
    mesh.visible = true;
  }

  updateGridLabels(camera) {
    if (!this.uniforms.uShowCoordGrid.value) {
      this.hideUnusedMeshes(0);
      return;
    }

    camera.updateMatrixWorld();
    this._projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    const camDist = camera.position.length();
    this._camDir.copy(camera.position).divideScalar(camDist);

    const stepDeg = this.uniforms.uGridStepDeg.value;
    const horizonCos = MOON_CONFIG.RADIUS / camDist;

    const centerLat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this._camDir.y, -1, 1)));
    const centerLon = THREE.MathUtils.radToDeg(Math.atan2(-this._camDir.z, this._camDir.x));

    const altitude = Math.max(0.001, camDist - MOON_CONFIG.RADIUS);
    const viewHalfAngleDeg = Math.min(85, THREE.MathUtils.radToDeg(Math.acos(horizonCos)) + 8);
    const localSpanDeg = Math.min(85, THREE.MathUtils.radToDeg(Math.atan((altitude * 1.6) / MOON_CONFIG.RADIUS)) * 1.45);
    const searchRadiusDeg = Math.min(viewHalfAngleDeg, Math.max(stepDeg * 2.5, localSpanDeg));

    this.activeMeshCount = 0;

    const minLat = Math.max(-90 + stepDeg, Math.floor((centerLat - searchRadiusDeg) / stepDeg) * stepDeg);
    const maxLat = Math.min(90 - stepDeg * 2, Math.ceil((centerLat + searchRadiusDeg) / stepDeg) * stepDeg);

    for (let lat = minLat; lat <= maxLat + 1e-6; lat += stepDeg) {
      const cleanLat = Math.round(lat * 1000) / 1000;
      const isEquator = Math.abs(cleanLat) < 1e-4;

      const rowCosLat = Math.max(0.18, Math.cos(THREE.MathUtils.degToRad(cleanLat + stepDeg * 0.5)));
      const rowLonSpan = Math.min(180, searchRadiusDeg / rowCosLat);
      const minLon = Math.floor((centerLon - rowLonSpan) / stepDeg) * stepDeg;
      const maxLon = Math.ceil((centerLon + rowLonSpan) / stepDeg) * stepDeg;

      for (let lon = minLon; lon <= maxLon + 1e-6; lon += stepDeg) {
        const cleanLon = Math.round(lon * 1000) / 1000;

        // Координата відповідає правому нижньому куту комірки (cleanLon + stepDeg, cleanLat)
        const rightCornerLon = Math.round((cleanLon + stepDeg) * 1000) / 1000;
        let wrappedLon = ((rightCornerLon + 180) % 360 + 360) % 360 - 180;
        if (Math.abs(wrappedLon + 180) < 1e-4) wrappedLon = 180;

        const isAxisMeridian =
          Math.abs(wrappedLon) < 1e-4 || Math.abs(Math.abs(wrappedLon) - 180) < 1e-4;
        const labelText = this.formatCellLabel(cleanLat, wrappedLon, stepDeg);

        this.placeCellCornerLabel(
          labelText,
          cleanLat,
          cleanLon,
          stepDeg,
          isEquator || isAxisMeridian,
          this._camDir,
          horizonCos
        );
      }
    }

    this.hideUnusedMeshes(this.activeMeshCount);
  }
}
