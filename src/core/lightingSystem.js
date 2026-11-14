import * as THREE from 'three';
import { SolarMath } from '../astronomy/solarMath.js';

export class LightingSystem {
  constructor(scene) {
    this.scene = scene;
    this.sunVector = new THREE.Vector3(1, 0, 0);
    this.isSolarLightingEnabled = true;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
    this.scene.add(this.sunLight);

    this.earthshine = new THREE.AmbientLight(0x161d2e, 0.25);
    this.scene.add(this.earthshine);
  }

  updateSunPosition(subSolarLon, subSolarLat) {
    const pos = SolarMath.subSolarToVector3(subSolarLon, subSolarLat, 50);
    this.sunLight.position.copy(pos);
    this.sunVector.copy(pos).normalize();
  }

  setSolarLightingEnabled(enabled) {
    this.isSolarLightingEnabled = enabled;

    if (enabled) {
      this.sunLight.intensity = 3.0;
      this.earthshine.color.setHex(0x161d2e);
      this.earthshine.intensity = 0.25;
    } else {
      this.sunLight.intensity = 0.0;
      this.earthshine.color.setHex(0xffffff);
      this.earthshine.intensity = 2.6;
    }
  }

  getNormalizedSunDirection() {
    return this.sunVector;
  }
}