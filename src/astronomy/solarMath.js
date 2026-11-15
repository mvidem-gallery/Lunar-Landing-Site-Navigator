import * as THREE from 'three';
import { CELESTIAL_CONFIG } from '../config/constants.js';

export class SolarMath {
  static subSolarToVector3(lonDeg, latDeg, distance = 50) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);

    const x = distance * Math.cos(latRad) * Math.cos(lonRad);
    const y = distance * Math.sin(latRad);
    const z = -distance * Math.cos(latRad) * Math.sin(lonRad);

    return new THREE.Vector3(x, y, z);
  }

  static calculatePointIllumination(surfaceNormal, sunDirection, distanceAU = 1.0) {
    const adjustedConstant = CELESTIAL_CONFIG.SOLAR_CONSTANT_WM2 / (distanceAU * distanceAU);

    const cosTheta = surfaceNormal.dot(sunDirection);
    const elevationRad = Math.asin(THREE.MathUtils.clamp(cosTheta, -1, 1));
    const solarElevationDeg = THREE.MathUtils.radToDeg(elevationRad);

    if (cosTheta <= 0) {
      return {
        illuminationPercent: 0.0,
        irradianceWm2: 0.0,
        solarElevationDeg,
        isDaylight: false,
      };
    }

    return {
      illuminationPercent: cosTheta * 100,
      irradianceWm2: adjustedConstant * cosTheta,
      solarElevationDeg,
      isDaylight: true,
    };
  }
}
