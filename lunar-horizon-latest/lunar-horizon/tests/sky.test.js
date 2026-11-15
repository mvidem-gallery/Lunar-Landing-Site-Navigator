import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dot, frame, interpolate} from '../src/math.js';
import {earthTextureBasis, equatorialVector, lunarSkyBasis} from '../src/sky.js';

function near(a, b) {
  assert.ok(Math.abs(a - b) < 1e-10, `${a} versus ${b}`);
}

test('J2000 converts to a right-handed local lunar sky and rotates with time', () => {
  const first = lunarSkyBasis(Date.UTC(2026, 10, 15), -89.45, 30);
  const later = lunarSkyBasis(Date.UTC(2026, 10, 16), -89.45, 30);
  for (const basis of [first, later]) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      near(dot(basis[i], basis[j]), Number(i === j));
    }
    const [a, b, c] = basis;
    near(dot([a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]], c), 1);
  }
  assert.ok(dot(first[0], later[0]) < 0.99);
});

test('globe faces the Horizons geographic point and keeps east and north oriented', () => {
  const viewer = [0, 0, 1];
  const matrix = earthTextureBasis(viewer, [0, 1, 0], 232.03, -26.47);
  const geo = frame(-26.47, 232.03);
  for (const [axis, answer] of [[viewer, geo.up], [[1,0,0], geo.east], [[0,1,0], geo.north]]) {
    matrix.forEach((row, i) => near(dot(row, axis), answer[i]));
  }
  const subsolar = equatorialVector(15, -10);
  near(Math.hypot(...subsolar), 1);
});

test('Earth orientation interpolates across the prime meridian without a spin', () => {
  const [, az, , , , subObserver, , subSolar] = interpolate([
    [0, 359, 0, 2, 384000, 359, 20, 1, 20],
    [10, 1, 0, 2, 384000, 1, 20, 359, 20],
  ], 5, [5, 7, 9]);
  near(az, 0);
  near(subObserver, 0);
  near(subSolar, 0);
});

test('bundled star catalogue covers both sky hemispheres with faint stars', () => {
  const data = readFileSync(new URL('../assets/stars-hyg.bin', import.meta.url));
  assert.equal(data.length % 5, 0);
  assert.ok(data.length / 5 > 15000);
  let north = 0, south = 0;
  for (let i = 0; i < data.length; i += 5) {
    if (data.readUInt16LE(i+2) > 32767) north++;
    else south++;
    assert.ok(data[i+4] <= 205);
  }
  assert.ok(north > 2500 && south > 2500);
});
