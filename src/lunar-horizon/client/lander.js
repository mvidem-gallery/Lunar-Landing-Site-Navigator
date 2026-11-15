import * as THREE from './three.js?v=terrain-v3';

export function createLander() {
  const lander = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({color: 0xb6c1cb, metalness: 0.3, roughness: 0.61});
  const foil = new THREE.MeshStandardMaterial({color: 0xc18a39, metalness: 0.35, roughness: 0.53});
  const dark = new THREE.MeshStandardMaterial({color: 0x373945, roughness: 0.86});
  const cells = new THREE.MeshStandardMaterial({color: 0x224985, metalness: 0.3, roughness: 0.46});
  function part(geometry, material, x, y, z) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    lander.add(mesh);
    return mesh;
  }
  function rod(a, b, width) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start);
    const mesh = part(new THREE.CylinderGeometry(width, width, direction.length(), 8), metal, 0, 0, 0);
    mesh.position.copy(start.addScaledVector(direction, 0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  }
  part(new THREE.BoxGeometry(1.52, 0.99, 1.4), foil, 0, 1.2, 0);
  part(new THREE.BoxGeometry(1.64, 0.12, 1.52), metal, 0, 1.73, 0);
  part(new THREE.CylinderGeometry(0.23, 0.39, 0.35, 16), dark, 0, 0.56, 0);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      rod([x * 0.68, 1.35, z * 0.59], [x * 1.22, 0.1, z * 1.14], 0.045);
      rod([x * 0.65, 0.76, z * 0.61], [x * 1.22, 0.1, z * 1.14], 0.026);
      part(new THREE.CylinderGeometry(0.19, 0.24, 0.1, 12), metal, x * 1.22, 0.05, z * 1.14);
    }
    rod([x * 0.75, 1.23, 0], [x * 1.46, 1.23, 0], 0.05);
    part(new THREE.BoxGeometry(1.45, 0.065, 0.83), metal, x * 1.62, 1.24, 0);
    for (let col = 0; col < 6; col++) {
      for (let row = 0; row < 3; row++) {
        part(new THREE.BoxGeometry(0.217, 0.015, 0.25), cells,
          x * 1.62 + (col - 2.5) * 0.232, 1.28, (row - 1) * 0.266);
      }
    }
  }
  rod([-0.52, 1.72, -0.34], [-0.52, 2.62, -0.34], 0.018);
  rod([-0.52, 2.62, -0.34], [-0.18, 2.76, -0.34], 0.012);
  const dish = new THREE.LatheGeometry(
    Array.from({length: 12}, (_, i) => new THREE.Vector2(i * 0.041, 0.001 * i * i)), 24);
  const reflector = part(dish, new THREE.MeshStandardMaterial({
    color: 0xe6e4d8, side: THREE.DoubleSide, roughness: 0.7,
  }), 0.35, 2.03, -0.16);
  reflector.rotation.z = -0.62;
  rod([0.35, 1.73, -0.16], [0.35, 2.07, -0.16], 0.036);
  rod([0.35, 2.03, -0.16], [0.52, 2.28, -0.16], 0.018);
  return lander;
}

export function seatLander(lander, surface) {
  const r = 1.5;
  const slopeX = (surface.heightAt(r, 0) - surface.heightAt(-r, 0)) / (2 * r);
  const slopeZ = (surface.heightAt(0, r) - surface.heightAt(0, -r)) / (2 * r);
  const normal = new THREE.Vector3(-slopeX, 1, -slopeZ).normalize();
  lander.position.set(0, 0, 0);
  lander.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  lander.updateMatrixWorld(true);

  let penetration = -Infinity;
  for (const part of lander.children) {
    const {index} = part.geometry;
    const positions = part.geometry.getAttribute('position');
    const vertices = Array.from({length: positions.count}, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(part.matrixWorld).toArray());
    const count = index?.count ?? positions.count;
    for (let i = 0; i < count; i += 3) {
      const triangle = [i, i + 1, i + 2].map(j => vertices[index ? index.getX(j) : j]);
      penetration = Math.max(penetration, surface.penetration(triangle));
    }
  }
  lander.position.y = Number.isFinite(penetration) ? penetration + 0.02 : 0;
}
