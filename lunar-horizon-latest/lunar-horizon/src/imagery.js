const R=1737400, D=Math.PI/180;
export const imageryProjection = lat => Math.abs(lat)>=75 ? (lat<0?'SP':'NP') : 'EQ';
export function imageryCoordinates(lat,lon,projection,referenceLon=lon) {
  if(projection==='EQ') return [referenceLon+((lon-referenceLon+540)%360)-180,lat];
  const radius=2*R*Math.tan((90-Math.abs(lat))*D/2);
  return [radius*Math.sin(lon*D),(projection==='SP'?1:-1)*radius*Math.cos(lon*D)];
}
export function imageryPlan(lat,lon,detail) {
  const projection=imageryProjection(lat), polar=projection!=='EQ';
  const z=polar?(detail?5:2):(detail?8:4);
  const count=polar?4:(detail?4:8), span=(polar?2191860:180)/2**z;
  const originX=polar?-1095930:-180,originY=polar?1095930:90;
  const width=2**(z+1),height=2**z;
  const [x,y]=imageryCoordinates(lat,lon,projection);
  const firstX=polar?Math.max(0,Math.min(height-count,Math.floor((x-originX)/span)-Math.floor((count-1)/2))):Math.floor((x-originX)/span)-Math.floor((count-1)/2);
  const firstY=Math.max(0,Math.min(height-count,Math.floor((originY-y)/span)-Math.floor((count-1)/2)));
  return {projection,z,count,span,width,height,firstX,firstY,
    bounds:[originX+firstX*span,originY-(firstY+count)*span,count*span,count*span]};
}
export function imageryBlendWeight(u,v) {
  const edge=Math.min(u,v,1-u,1-v),t=Math.max(0,Math.min(1,edge/0.18));
  return t*t*(3-2*t);
}

// A response body or image decoder can stall after headers arrive.
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => work(signal)).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export async function loadImageryBatch(tiles, loadTile, report, {
  signal, budgetMs = 15000, attemptMs = 4500, concurrency = 8,
} = {}) {
  const deadline = new AbortController();
  const batch = AbortSignal.any(signal ? [signal, deadline.signal] : [deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  let next = 0, checked = 0, received = 0;
  try {
    await Promise.all(Array.from({length: Math.min(concurrency, tiles.length)}, async () => {
      while (next < tiles.length && !batch.aborted) {
        const tile = tiles[next++];
        for (let attempt = 0; attempt < 2 && !batch.aborted; attempt++) {
          const timeout = new AbortController();
          const request = AbortSignal.any([batch, timeout.signal]);
          const attemptTimer = setTimeout(() => timeout.abort(), attemptMs);
          try {
            await abortable(signal => loadTile(tile, signal), request);
            received++;
            break;
          } catch {
            // A failed tile can be retried within the remaining batch budget.
          } finally {
            clearTimeout(attemptTimer);
          }
        }
        checked++;
        if (!batch.aborted) report({checked, received});
      }
    }));
  } finally {
    clearTimeout(timer);
  }
  return {received, total: tiles.length, timedOut: deadline.signal.aborted};
}
