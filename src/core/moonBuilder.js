import * as THREE from 'three';
import { MOON_CONFIG } from '../config/constants.js';
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
      uShowEarthDisk: { value: true },
      uHorizonThreshold: { value: 0.0045 },
      uShowCoordGrid: { value: false },
      uGridStepDeg: { value: 15.0 },
      uGridSubStepDeg: { value: 5.0 },
      uGridOpacity: { value: 0.65 },
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