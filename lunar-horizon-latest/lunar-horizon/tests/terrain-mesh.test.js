import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTerrainMesh, landingSurface} from '../src/terrain-mesh.js';
import {sampleDetail} from '../src/dem.js';

test('lander clearance detects a ridge between model vertices', () => {
  const mesh = buildTerrainMesh((east, north) => [east, -Math.abs(east), -north], 30, 8, 1);
  const surface = landingSurface(mesh);
  const body = [[-2, -1, -1], [2, -1, -1], [2, -1, 1]];
  assert.ok(body.every(([x, y, z]) => y > surface.heightAt(x, z)));
  assert.equal(surface.penetration(body), 1);
  assert.ok(surface.penetration(body.map(([x, y, z]) => [x, y + 1.02, z])) < 0);
});

test('LOD triangles have uniform aspect and shared edges have no cracks',()=>{
 const local=(e,n)=>[e,120*Math.sin(e/400)*Math.cos(n/700),-n];
 const segments=16, stride=17, count=stride*stride;
 const m=buildTerrainMesh(local,30,segments,3);
 const point=i=>Array.from(m.positions.slice(i*3,i*3+3));
 for(let level=0;level<2;level++) {
   // Top edge of the fine grid matches the coarser grid's inner boundary.
   for(let c=0;c<=segments;c++) {
     const a=point(level*count+c);
     const co=segments/4+c/2;
     const left=point((level+1)*count+segments/4*stride+Math.floor(co));
     const right=point((level+1)*count+segments/4*stride+Math.ceil(co));
     for(let j=0;j<3;j++)assert.ok(Math.abs(a[j]-(left[j]+right[j])/2)<0.001);
   }
 }
 for(let i=0;i<m.indices.length;i+=3) {
   const p=[0,1,2].map(j=>point(m.indices[i+j]));
   const edges=p.map((a,j)=>{const b=p[(j+1)%3];return Math.hypot(a[0]-b[0],a[2]-b[2]);});
   assert.ok(Math.max(...edges)/Math.min(...edges)<1.42,'no long thin triangles');
 }
 assert.ok(m.normals.every(Number.isFinite));
 assert.equal(Math.hypot(...point(m.centerIndex)),0);
});

test('stereo samples retain meter scale and smoothly blend to the fallback',()=>{
 const tile={density:512,firstColumn:10000,firstRow:20000,columns:100,rows:100,values:new Float32Array(10000).fill(-2500),scale:1,blendCells:8};
 const lat=row=>90-(tile.firstRow+row+0.5)/512,lon=col=>(tile.firstColumn+col+0.5)/512;
 assert.equal(sampleDetail(tile,lat(50),lon(50),100),-2500);
 assert.equal(sampleDetail(tile,lat(50),lon(0),100),100);
 assert.equal(sampleDetail(tile,lat(50),lon(4),100),-1200);
});

test('all four curved LOD edges match, including the side edges',()=>{
 const local=(e,n)=>{const r=1737400,a=Math.hypot(e,n)/r,h=100*Math.sin(e/300)*Math.cos(n/450);return [e*Math.sin(a)/(a||1),(r+h)*Math.cos(a)-r,-n*Math.sin(a)/(a||1)];};
 const segments=16,stride=17,count=stride*stride,m=buildTerrainMesh(local,30,segments,3);
 const p=(level,row,col)=>Array.from(m.positions.slice((level*count+row*stride+col)*3,(level*count+row*stride+col)*3+3));
 for(let level=0;level<2;level++)for(let t=0;t<=segments;t++)for(const side of ['top','bottom','left','right']) {
  const v=segments/4+t/2,lo=Math.floor(v),hi=Math.ceil(v);
  const fine=side==='top'?p(level,0,t):side==='bottom'?p(level,segments,t):side==='left'?p(level,t,0):p(level,t,segments);
  const coarse=q=>side==='top'?p(level+1,segments/4,q):side==='bottom'?p(level+1,segments*3/4,q):side==='left'?p(level+1,q,segments/4):p(level+1,q,segments*3/4);
  const a=coarse(lo),b=coarse(hi);
  fine.forEach((v,j)=>assert.ok(Math.abs(v-(a[j]+b[j])/2)<0.001,side));
 }
});
