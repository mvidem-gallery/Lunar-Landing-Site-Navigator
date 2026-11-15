import test from 'node:test';import assert from 'node:assert/strict';import {project,unproject,frame,dot,direction,interpolate,integrate,horizonAt,sample} from '../src/math.js';
test('polar projection roundtrip at supported latitudes',()=>{for(const lat of [-89.95,-89.45,-89.05])for(const lon of [-179,-90,0,30,179]){const p=unproject(...project(lat,lon));assert.ok(Math.abs(p[0]-lat)<1e-10);assert.ok(Math.abs(p[1]-lon)<1e-10);}});
test('observer orthonormal axes',()=>{const f=frame(-89.45,30);assert.ok(Math.abs(dot(f.up,f.north))<1e-12);assert.ok(Math.abs(dot(f.east,f.north))<1e-12);assert.ok(Math.abs(dot(f.up,f.up)-1)<1e-12);});
test('azimuth north/east and zenith directions',()=>{assert.deepEqual(direction(0,0),[0,0,-1]);assert.ok(Math.abs(direction(90,0)[0]-1)<1e-12);assert.equal(direction(0,90)[1],1);});
test('azimuth interpolation crosses north, not south',()=>{const r=interpolate([[0,359,1,2,3],[100,1,3,4,5]],50);assert.equal(r[1],0);assert.equal(r[2],2);});
test('linear transitions integrate partial intervals',()=>{assert.equal(integrate([{t:0,m:-1},{t:100,m:3}],'m'),75);assert.equal(integrate([{t:0,m:1},{t:100,m:-3}],'m'),25);assert.equal(integrate([{t:0,m:-1},{t:100,m:-3}],'m'),0);});
test('horizon wrap interpolation',()=>{assert.equal(horizonAt([1,2,3,4],360),1);assert.equal(horizonAt([1,2,3,4],315),2.5);});
test('DEM pixel centers and bilinear sampling',()=>{const m={width:2,height:2,x0:0,y0:2,dx:1,dy:-1};assert.equal(sample([1,2,3,4],m,1,1),2.5);});
import {integrateOverlap} from '../src/math.js';
import {landerOrbitPosition} from '../src/math.js';
import {PerspectiveCamera, Vector3} from '../assets/three.js';
test('overlap finds intersecting windows even when endpoints are not simultaneous',()=>{assert.equal(integrateOverlap([{t:0,s:-1,e:3},{t:100,s:3,e:-1}],'s','e'),50);});

test('orbit keeps the target centered and fits the lander around a slope', () => {
  const center = new Vector3(0, 2, 0);
  const radius = 2.7;
  const heightAt = (x, z) => x * 0.6 - z * 0.25;
  for (const aspect of [0.4, 1, 2]) {
    const camera = new PerspectiveCamera(30, aspect, 0.15, 1000);
    for (let azimuth = 0; azimuth < 360; azimuth += 30) {
      camera.position.fromArray(landerOrbitPosition(center.toArray(), azimuth, 5, 9.5, radius, 30, aspect, heightAt));
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      const projected = center.clone().project(camera);
      assert.ok(Math.abs(projected.x) < 1e-10 && Math.abs(projected.y) < 1e-10);
      assert.ok(camera.position.y >= heightAt(camera.position.x, camera.position.z) + 1);
      for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const point = center.clone().addScaledVector(new Vector3(...direction), radius).project(camera);
        assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1);
      }
    }
  }
});
