import * as THREE from 'three';
import { MOON_CONFIG, OVERLAY_CONFIG } from '../config/constants.js';
import { QuadtreeTileManager } from './quadtreeTileManager.js';

export class MoonBuilder {
  static async build() {
    const moonGroup = new THREE.Group();

    const geometry = new THREE.SphereGeometry(
      MOON_CONFIG.RADIUS,
      MOON_CONFIG.SEGMENTS,
      MOON_CONFIG.SEGMENTS
    );

    const customUniforms = {
      uEarthDirection: { value: new THREE.Vector3(1, 0, 0) },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uShowEarthDisk: { value: true },
      uHorizonThreshold: { value: MOON_CONFIG.HORIZON_THRESHOLD },
      uShowIlluminationHeatmap: { value: false },
      uHeatmapOpacity: { value: OVERLAY_CONFIG.HEATMAP_OPACITY },
      uShowCoordGrid: { value: false },
      uGridStepDeg: { value: OVERLAY_CONFIG.GRID_DEFAULT_STEP_DEG },
      uGridSubStepDeg: { value: OVERLAY_CONFIG.GRID_DEFAULT_SUB_STEP_DEG },
      uGridOpacity: { value: OVERLAY_CONFIG.GRID_DEFAULT_OPACITY },
    };

    // Невидимий меш-колайдер: використовується виключно для Raycaster без рендерингу розмитої текстури
    const colliderMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const baseMoonMesh = new THREE.Mesh(geometry, colliderMaterial);
    baseMoonMesh.rotation.y = Math.PI;
    baseMoonMesh.updateMatrixWorld();
    moonGroup.add(baseMoonMesh);

    // Весь візуальний рендеринг поверхні бере на себе менеджер високодеталізованих тайлів
    const lodManager = new QuadtreeTileManager(moonGroup, customUniforms);

    moonGroup.userData = {
      baseMesh: baseMoonMesh,
      uniforms: customUniforms,
      lodManager: lodManager,
    };

    return moonGroup;
  }
}
