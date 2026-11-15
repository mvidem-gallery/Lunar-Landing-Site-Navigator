import test from 'node:test';import assert from 'node:assert/strict';
import {imageryProjection,imageryCoordinates,imageryPlan,imageryBlendWeight,loadImageryBatch} from '../src/imagery.js';
test('polar image coordinates are continuous across longitude seams and at the pole',()=>{
 for(const [lat,projection] of [[-89.45,'SP'],[89.45,'NP']]) {
  assert.equal(imageryProjection(lat),projection);
  const a=imageryCoordinates(lat,179.999,projection),b=imageryCoordinates(lat,-179.999,projection);
  assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<1);
  const pole=imageryCoordinates(Math.sign(lat)*90,30,projection);assert.equal(Math.hypot(...pole),0);
 }
});
test('photo footprints nest correctly at reported sites and the date line',()=>{
 for(const [lat,lon] of [[-89.45,30],[-21.67,-7.7],[0,179.99],[0,-179.99],[89.45,30],[-74.99,120]]) {
  const near=imageryPlan(lat,lon,true),far=imageryPlan(lat,lon,false),uv=imageryCoordinates(lat,lon,near.projection,lon);
  for(const p of [near,far]) {
   const [x,y,w,h]=p.bounds;assert.ok(uv[0]>x&&uv[0]<x+w&&uv[1]>y&&uv[1]<y+h);
   assert.ok(p.firstY>=0&&p.firstY+p.count<=p.height);
  }
  const [nx,ny,nw,nh]=near.bounds,[fx,fy,fw,fh]=far.bounds;
  assert.ok(nx>=fx&&ny>=fy&&nx+nw<=fx+fw&&ny+nh<=fy+fh);
 }
});
test('photo detail blends into overview without a hard border',()=>{
 assert.equal(imageryBlendWeight(-0.1,0.5),0);assert.equal(imageryBlendWeight(0,0.5),0);
 assert.ok(imageryBlendWeight(0.001,0.5)<0.001);assert.equal(imageryBlendWeight(0.5,0.5),1);
 assert.ok(Math.abs(imageryBlendWeight(0.1799,0.5)-1)<0.00001);
});

test('a stalled final pair cannot block the 78 ready tiles', async () => {
  const ready = [];
  const progress = [];
  const result = await loadImageryBatch(Array.from({length: 80}, (_, i) => i), tile => {
    if (tile >= 78) return new Promise(() => {});
    ready.push(tile);
  }, count => progress.push(count), {budgetMs: 80, attemptMs: 1000});
  assert.deepEqual(result, {received: 78, total: 80, timedOut: true});
  assert.equal(ready.length, 78);
  assert.deepEqual(progress.at(-1), {checked: 78, received: 78});
});
