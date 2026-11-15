import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Worker} from 'node:worker_threads';
import {horizonAt,direction,dot,interpolate,integrate} from '../src/math.js';
const meta=n=>JSON.parse(fs.readFileSync('data/'+n+'.json')),arr=n=>{const b=fs.readFileSync('data/'+n+'.bin');return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const bytes = gunzipSync(fs.readFileSync('data/global-dem.bin'));
const global = new Int16Array(2880 * 1440);
for (let i=0;i<global.length;i++) global[i]=bytes.readInt16LE(i*2)+(i%2880?global[i-1]:0);
const run = (data, onGround) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker-adapter.js', import.meta.url));
  worker.on('message', result => {
    if (result.phase === 'ground') {
      onGround(result.ground);
      return;
    }
    worker.terminate();
    resolve(result);
  });
  worker.on('error', reject);
  worker.postMessage({global, ...data, reportGround: Boolean(onGround)});
});

test('overview uses the bundled terrain to cover the full view without running mission analysis', async () => {
  const result = await run({lat: -69.3, lon: -172, height: 1.7, preview: true});
  assert.ok(!result.error, result.error);
  assert.equal(result.indices.length / 3, 12800);
  assert.ok(result.drawRanges.length > 1);
  assert.equal(result.drawRanges.at(-1), result.indices.length);
  assert.ok(result.drawRanges.every((count, index) => count % 3 === 0 &&
    (index === 0 || count > result.drawRanges[index - 1])));
  for (const index of result.indices.subarray(0, result.drawRanges[0])) {
    assert.ok(Math.hypot(result.positions[index * 3], result.positions[index * 3 + 2]) <= 1000);
  }
  assert.ok(result.positions.every(Number.isFinite));
  assert.ok(result.positions.some((value, i) => i % 3 === 0 && value > 450000));
  assert.ok(!('horizon' in result));
});
test('real DEM produces finite horizon, upward slope normal and observer origin',async()=>{let earlyGround;const r=await run({lat:-89.45,lon:30,height:1.7,near:arr('terrain'),far:arr('far'),nm:meta('terrain'),fm:meta('far')}, ground => { earlyGround = ground; });assert.ok(!r.error,r.error);assert.equal(earlyGround,r.ground);assert.equal(r.horizon.length,720);assert.ok([...r.horizon].every(Number.isFinite));assert.ok(r.normal[1]>0);assert.ok(Math.abs(Math.hypot(...r.normal)-1)<1e-10);assert.ok(Number.isFinite(r.ground) && Math.abs(r.ground) < 12000);const center=r.centerIndex*3;assert.ok(Math.hypot(...r.positions.slice(center,center+3))<1e-7);console.log('Horizon range degrees:',Math.min(...r.horizon),Math.max(...r.horizon),'normal:',r.normal);
const e=JSON.parse(fs.readFileSync('tests/fixtures/horizons-default.json'));assert.equal(e.sun.length,4321);assert.equal(e.sun[0][0],Date.parse('2026-11-14T00:00Z'));assert.equal(e.sun.at(-1)[0],Date.parse('2026-12-14T00:00Z'));const rows=e.sun.map(s=>{const earth=interpolate(e.earth,s[0]);return {t:s[0],sm:Math.min(s[2]-horizonAt(r.horizon,s[1]),Math.asin(dot(direction(s[1],s[2]),r.normal))*180/Math.PI),em:earth[2]-horizonAt(r.horizon,earth[1])};});console.log('Default hours:',integrate(rows,'sm')/36e5,integrate(rows,'em')/36e5);assert.ok(integrate(rows,'em')>0);assert.ok(e.earth.every(x=>x[4]>350000&&x[4]<420000));});

test('global DEM covers both poles and wraps across the date line', async () => {
  const {gunzipSync} = await import('node:zlib');
  const {sampleGlobal} = await import('../src/dem.js');
  const bytes = gunzipSync(fs.readFileSync('data/global-dem.bin'));
  const global = new Int16Array(2880 * 1440);
  for (let i = 0; i < global.length; i++) {
    global[i] = bytes.readInt16LE(i * 2) + (i % 2880 ? global[i - 1] : 0);
  }
  assert.equal(sampleGlobal(global, 15, 180), sampleGlobal(global, 15, -180));
  for (const [lat, lon] of [[0, 0], [90, 180], [-90, -180], [45, 179.9], [-63, -120]]) {
    const result = await run({lat, lon, height: 1.7, global});
    assert.ok(!result.error, result.error);
    assert.ok(Number.isFinite(result.ground) && Math.abs(result.ground) < 12000);
    assert.ok(result.horizon.every(Number.isFinite));
    assert.ok(result.positions.every(Number.isFinite));
    assert.ok(result.normal[1] > 0);
  }
});

// The mesh must continue below the true horizon at the maximum camera lift.
test('curved terrain boundary is hidden beyond a 10 km observer horizon', async () => {
 const flat = new Int16Array(2880 * 1440);
 const r = await run({lat:0,lon:0,height:1.7,global:flat});
 assert.ok(!r.error,r.error);
 let edge=0;
 for(let i=0;i<r.positions.length;i+=3) if(Math.abs(r.positions[i+2])<1 && Math.abs(r.positions[i])>Math.abs(r.positions[edge])) edge=i;
 const x=r.positions[edge], y=r.positions[edge+1], z=r.positions[edge+2];
 const dip=-Math.acos(1737400/(1737400+10000));
 const angle=Math.atan2(y-10000,Math.hypot(x,z));
 assert.ok(angle<dip-0.01, 'mesh boundary must lie below the visible horizon');
 assert.ok(y < -40000, 'spherical curvature must lower distant ground');
 assert.ok(r.positions.every(Number.isFinite));
});
