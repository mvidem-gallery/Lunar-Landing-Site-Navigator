export const R=1737400,D=Math.PI/180;
export function project(lat,lon){const r=2*R*Math.tan(Math.PI/4+lat*D/2);return [r*Math.sin(lon*D),r*Math.cos(lon*D)];}
export function unproject(x,y){return [(2*Math.atan(Math.hypot(x,y)/(2*R))-Math.PI/2)/D,Math.atan2(x,y)/D];}
export function frame(lat,lon){const p=lat*D,l=lon*D;return {up:[Math.cos(p)*Math.cos(l),Math.cos(p)*Math.sin(l),Math.sin(p)],east:[-Math.sin(l),Math.cos(l),0],north:[-Math.sin(p)*Math.cos(l),-Math.sin(p)*Math.sin(l),Math.cos(p)]};}
export const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export function sample(grid,meta,x,y){const c=(x-meta.x0)/meta.dx-.5,r=(y-meta.y0)/meta.dy-.5,i=Math.floor(c),j=Math.floor(r),u=c-i,v=r-j;if(i<0||j<0||i>=meta.width-1||j>=meta.height-1)return NaN;return grid[j*meta.width+i]*(1-u)*(1-v)+grid[j*meta.width+i+1]*u*(1-v)+grid[(j+1)*meta.width+i]*(1-u)*v+grid[(j+1)*meta.width+i+1]*u*v;}
export function direction(az,el){return [Math.sin(az*D)*Math.cos(el*D),Math.sin(el*D),-Math.cos(az*D)*Math.cos(el*D)];}

export function landerOrbitPosition(target, azimuth, elevation, radius, boundsRadius, fov, aspect, heightAt) {
  // Fit the whole craft in whichever dimension has the narrower field of view.
  const halfAngle = Math.atan(Math.tan(fov * D / 2) * Math.min(1, aspect));
  const distance = Math.max(radius, 1.25 * boundsRadius / Math.sin(halfAngle));
  const offset = direction(azimuth, elevation);
  const [x, y, z] = target.map((value, i) => value + offset[i] * distance);
  let cameraY = Math.max(y, (heightAt(x, z) ?? y - 1) + 1);
  // Keep the sightline clear when moving around the uphill side.
  for (let i = 1; i < 16; i++) {
    const t = i / 16;
    const ground = heightAt(target[0] + (x - target[0]) * t, target[2] + (z - target[2]) * t);
    if (ground !== undefined) cameraY = Math.max(cameraY, target[1] + (ground + 0.1 - target[1]) / t);
  }
  return [x, cameraY, z];
}
export function interpolate(rows,t){let lo=0,hi=rows.length-1;if(t<=rows[0][0])return rows[0].slice();if(t>=rows[hi][0])return rows[hi].slice();while(hi-lo>1){let m=(lo+hi)>>1;if(rows[m][0]<=t)lo=m;else hi=m;}const a=rows[lo],b=rows[hi],f=(t-a[0])/(b[0]-a[0]);return [t,(a[1]+(((b[1]-a[1]+540)%360)-180)*f+360)%360,...a.slice(2).map((v,i)=>v+(b[i+2]-v)*f)];}
export function horizonAt(h,az){const p=((az%360)+360)%360/360*h.length,i=Math.floor(p);return h[i]*(1-(p-i))+h[(i+1)%h.length]*(p-i);}
export function integrate(rows,key){let ms=0;for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i],v=a[key],w=b[key],dt=b.t-a.t;if(v>0&&w>0)ms+=dt;else if(v>0)ms+=dt*v/(v-w);else if(w>0)ms+=dt*w/(w-v);}return ms;}
export function integrateOverlap(rows,keyA,keyB){let ms=0;const interval=(a,b)=>a>0&&b>0?[0,1]:a<=0&&b<=0?[0,0]:a>0?[0,a/(a-b)]:[-a/(b-a),1];for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i],x=interval(a[keyA],b[keyA]),y=interval(a[keyB],b[keyB]);ms+=(b.t-a.t)*Math.max(0,Math.min(x[1],y[1])-Math.max(x[0],y[0]));}return ms;}
