// Server-side proxy: Horizons does not support browser CORS.
export async function ephemeris(url) {
 const p=url.searchParams, lat=Number(p.get('lat')),lon=Number(p.get('lon')),alt=Number(p.get('alt'));
 const start=Date.parse(p.get('start')),end=Date.parse(p.get('end')),step=Number(p.get('step')||10);
 if(![lat,lon,alt,start,end,step].every(Number.isFinite)||lat < -90||lat > 90||lon < -180||lon>180||alt < -15||alt>15||start>=end||end-start>(p.get('target') === 'sun' ? 730 : 365)*86400000||step<1||step>60||new Date(start).getUTCFullYear()<2000||new Date(end).getUTCFullYear()>2100) throw new Error('Check coordinates, dates (2000–2100), mission duration up to 365 days and time step (1–60 min).');
 const sunOnly = p.get('target') === 'sun';
 const count=Math.ceil((end-start)/(step*60000));
 if(count>15000)throw new Error('Too many samples. Increase the time step.');
 const getChunk=async(target, from, to)=>{
  const q={format:'json',COMMAND:`'${target}'`,OBJ_DATA:"'NO'",EPHEM_TYPE:"'OBSERVER'",CENTER:"'coord@301'",COORD_TYPE:"'GEODETIC'",SITE_COORD:`'${lon},${lat},${alt}'`,START_TIME:`'${new Date(from).toISOString().slice(0,16).replace('T',' ')}'`,STOP_TIME:`'${new Date(to).toISOString().slice(0,16).replace('T',' ')}'`,STEP_SIZE:`'${step} m'`,QUANTITIES:"'4,13,20'",CSV_FORMAT:"'YES'",ANG_FORMAT:"'DEG'",TIME_DIGITS:"'SECONDS'",EXTRA_PREC:"'YES'"};
  const response=await fetch('https://ssd.jpl.nasa.gov/api/horizons.api?'+new URLSearchParams(q),{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error('JPL Horizons is temporarily unavailable ('+response.status+').');
  const data=await response.json();const body=data.result;
  if(data.error||!body?.includes('$$SOE'))throw new Error('Horizons returned no ephemerides. Try another date range.');
  const rows=body.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n').map(line=>{
   const c=line.split(',').map(x=>x.trim());
   const t=Date.parse(c[0].replace(/(\d{4})-(\w{3})-(\d{2})/,'$3 $2 $1')+' UTC');
   return [t,+c[3],+c[4],+c[5]/3600,+c[6]*149597870.7];
  });
  if(!rows.length||rows.some(r=>r.some(v=>!Number.isFinite(v))))throw new Error('Unexpected Horizons response format.');
  const expected = Math.round((to - from) / (step * 60000)) + 1;
  if (rows.length !== expected || rows[0][0] !== from || rows.at(-1)[0] !== to) {
    throw new Error('JPL Horizons returned an incomplete time series.');
  }
  return rows;
 };
 async function get(target) {
  const rows = [];
  const interval = step * 60000;
  for (let i = 0; i < count; i += 8000) {
    const chunk = await getChunk(target, start + i * interval, start + Math.min(i + 8000, count) * interval);
    rows.push(...(i ? chunk.slice(1) : chunk));
  }
  return rows;
 }
 const sun = await get(10);
 const earth = sunOnly ? [] : await get(399);
 return {sun,earth,source:'NASA/JPL Horizons',step,frame:'MOON_ME / DE421',generated:new Date().toISOString()};
}

const LOLA64_URL = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img';

export async function terrainDetail(url) {
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  if (!url.searchParams.has('lat') || !url.searchParams.has('lon') ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return new Response('Invalid coordinates.', {status: 400});
  }

  if (url.searchParams.get('detail') === 'stereo') {
    if (Math.abs(latitude) > 59.3) return new Response(null, {status: 204});
    return stereoTerrain(latitude, longitude);
  }
  if (url.searchParams.get('detail') === 'landing') {
    if (Math.abs(latitude) >= 89.7) return new Response(null, {status: 204});
    return fineTerrain(latitude, longitude, 1024);
  }
  if (url.searchParams.get('detail') === 'fine') return fineTerrain(latitude, longitude);

  const columns = 23040, rows = 11520, cellsPerDegree = 64;
  const radius = 1.75;
  const firstRow = Math.max(0, Math.floor((90 - latitude - radius) * cellsPerDegree) - 1);
  const lastRow = Math.min(rows - 1, Math.ceil((90 - latitude + radius) * cellsPerDegree));
  const rowCount = lastRow - firstRow + 1;
  const bytesPerRow = columns * 2;
  const start = firstRow * bytesPerRow;
  const end = (lastRow + 1) * bytesPerRow - 1;
  const upstream = await fetch(LOLA64_URL, {
    headers: {Range: `bytes=${start}-${end}`},
    signal: AbortSignal.timeout(22000),
  });
  if (upstream.status !== 206 || upstream.headers.get('Content-Range') !== `bytes ${start}-${end}/${rows * bytesPerRow}`) {
    await upstream.body?.cancel();
    throw new Error('LOLA archive did not return the requested elevation tile.');
  }
  const band = new Uint8Array(await upstream.arrayBuffer());
  if (band.byteLength !== rowCount * bytesPerRow) throw new Error('Incomplete LOLA elevation tile.');

  const poleward = Math.abs(latitude) + radius;
  const halfWidth = poleward >= 90 ? columns / 2
    : Math.min(columns / 2, Math.ceil(radius * cellsPerDegree / Math.cos(poleward * Math.PI / 180)) + 2);
  const centerColumn = Math.floor((((longitude % 360) + 360) % 360) * cellsPerDegree);
  const firstColumn = (centerColumn - halfWidth + columns) % columns;
  const columnCount = Math.min(columns, halfWidth * 2 + 1);
  const tile = new Uint8Array(rowCount * columnCount * 2);
  const leadingBytes = Math.min(columnCount, columns - firstColumn) * 2;
  for (let row = 0; row < rowCount; row++) {
    const rowStart = row * bytesPerRow;
    const segmentStart = rowStart + firstColumn * 2;
    const outputStart = row * columnCount * 2;
    tile.set(band.subarray(segmentStart, segmentStart + leadingBytes), outputStart);
    tile.set(band.subarray(rowStart, rowStart + columnCount * 2 - leadingBytes), outputStart + leadingBytes);
  }
  return new Response(tile, {headers: {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400',
    'X-LOLA-Grid': [firstRow, firstColumn, rowCount, columnCount].join(','),
  }});
}

async function fineTerrain(latitude, longitude, density = 256) {
  const latitudeSpan = density === 1024 ? 15 : 90;
  const longitudeSpan = density === 1024 ? 30 : 180;
  const fileWidth = longitudeSpan * density, fileHeight = latitudeSpan * density;
  const width = 360 * density, height = 180 * density;
  const radius = density === 1024 ? 0.09 : 0.32;
  const firstRow = Math.max(0, Math.floor((90 - latitude - radius) * density) - 1);
  const lastRow = Math.min(height - 1, Math.ceil((90 - latitude + radius) * density));
  const rows = lastRow - firstRow + 1;
  const poleward = Math.abs(latitude) + radius;
  const halfWidth = poleward >= 90 ? width / 2
    : Math.min(width / 2, Math.ceil(radius * density / Math.cos(poleward * Math.PI / 180)) + 2);
  const center = Math.floor(((longitude + 360) % 360) * density);
  const firstColumn = (center - halfWidth + width) % width;
  const columns = Math.min(width, halfWidth * 2 + 1);
  const tile = new Uint8Array(rows * columns * 2);
  const fileRowBytes = fileWidth * 2;

  for (let row = firstRow; row <= lastRow;) {
    const rowOffset = Math.floor(row / fileHeight) * fileHeight;
    const northLatitude = 90 - rowOffset / density;
    const rowEnd = Math.min(lastRow, rowOffset + fileHeight - 1);
    const startByte = (row - rowOffset) * fileRowBytes;
    const endByte = (rowEnd - rowOffset + 1) * fileRowBytes - 1;
    // Adjacent archive files may meet inside this viewport.
    const bands = new Map();
    for (let written = 0; written < columns;) {
      const column = (firstColumn + written) % width;
      const tileColumn = Math.floor(column / fileWidth);
      const localColumn = column % fileWidth;
      const length = Math.min(columns - written, fileWidth - localColumn);
      if (!bands.has(tileColumn)) {
        const latitudeLabel = value => String(Math.abs(value)).padStart(2, '0') + (value < 0 || (value === 0 && northLatitude === 0) ? 's' : 'n');
        const latitudeTag = `${latitudeLabel(northLatitude - latitudeSpan)}_${latitudeLabel(northLatitude)}`;
        const longitudeLabel = value => String(value).padStart(3, '0');
        const longitudeTag = `${longitudeLabel(tileColumn * longitudeSpan)}_${longitudeLabel((tileColumn + 1) * longitudeSpan)}`;
        const source = LOLA64_URL.replace('ldem_64.img', `ldem_${density}_${latitudeTag}_${longitudeTag}.img`);
        const response = await fetch(source, {
          headers: {Range: `bytes=${startByte}-${endByte}`},
          signal: AbortSignal.timeout(12000),
        });
        if (response.status !== 206 ||
          response.headers.get('Content-Range') !== `bytes ${startByte}-${endByte}/${fileHeight * fileRowBytes}`) {
          await response.body?.cancel();
          throw new Error('Could not retrieve detailed LOLA elevation data.');
        }
        const band = new Uint8Array(await response.arrayBuffer());
        if (band.length !== endByte - startByte + 1) throw new Error('Incomplete LOLA elevation data.');
        bands.set(tileColumn, band);
      }
      const band = bands.get(tileColumn);
      for (let line = row; line <= rowEnd; line++) {
        const offset = (line - row) * fileRowBytes + localColumn * 2;
        tile.set(band.subarray(offset, offset + length * 2), ((line - firstRow) * columns + written) * 2);
      }
      written += length;
    }
    row = rowEnd + 1;
  }
  return new Response(tile, {headers: {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400',
    'X-LOLA-Grid': [firstRow, firstColumn, rows, columns, density].join(','),
  }});
}

// SLDEM2015 fills the gaps between LOLA laser tracks using Kaguya stereo terrain.
// Copy only the selected columns while streaming the archive's latitude band.
// Never retain a full 50–60 MB upstream band in the Worker heap.
async function stereoTerrain(latitude, longitude) {
  const density=512, radius=0.6, worldWidth=360*density;
  const firstRow=Math.floor((90-latitude-radius)*density)-1;
  const lastRow=Math.ceil((90-latitude+radius)*density)+1;
  const rows=lastRow-firstRow+1;
  const half=Math.ceil(radius*density/Math.cos((Math.abs(latitude)+radius)*Math.PI/180))+2;
  const firstColumn=((Math.floor(((longitude+360)%360)*density)-half)%worldWidth+worldWidth)%worldWidth;
  const columns=2*half+1;
  const output=new Uint8Array(rows*columns*4);
  const fileWidth=45*density, fileHeight=30*density, rowBytes=fileWidth*4;
  const latLabel=v=>String(Math.abs(v)).padStart(2,'0')+(v<0?'S':'N');
  for(let row=firstRow;row<=lastRow;) {
    const rowOffset=Math.floor(row/fileHeight)*fileHeight;
    const north=90-rowOffset/density, south=north-30;
    // The archive names zero on southern tiles as 00S.
    const northTag=north===0?'00S':latLabel(north);
    const southTag=south===0?'00N':latLabel(south);
    const endRow=Math.min(lastRow,rowOffset+fileHeight-1);
    for(let written=0;written<columns;) {
      const col=(firstColumn+written)%worldWidth;
      const fileColumn=Math.floor(col/fileWidth), localColumn=col%fileWidth;
      const length=Math.min(columns-written,fileWidth-localColumn);
      const west=String(fileColumn*45).padStart(3,'0'),east=String((fileColumn+1)*45).padStart(3,'0');
      const url=`https://imbrium.mit.edu/DATA/SLDEM2015/TILES/FLOAT_IMG/SLDEM2015_512_${southTag}_${northTag}_${west}_${east}_FLOAT.IMG`;
      const start=(row-rowOffset)*rowBytes, end=(endRow-rowOffset+1)*rowBytes-1;
      const response=await fetch(url,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(65000)});
      if(response.status!==206||response.headers.get('Content-Range')!==`bytes ${start}-${end}/${fileHeight*rowBytes}`) {
        await response.body?.cancel(); throw new Error('SLDEM2015 stereo terrain is temporarily unavailable.');
      }
      const reader=response.body.getReader();let received=0;
      while(true) {
        const {value,done}=await reader.read();if(done)break;
        const chunkStart=received,chunkEnd=received+value.length;
        for(let line=Math.floor(chunkStart/rowBytes);line<=Math.floor((chunkEnd-1)/rowBytes);line++) {
          const begin=line*rowBytes+localColumn*4,finish=begin+length*4;
          const left=Math.max(begin,chunkStart),right=Math.min(finish,chunkEnd);
          if(left<right)output.set(value.subarray(left-chunkStart,right-chunkStart),((row-firstRow+line)*columns+written)*4+left-begin);
        }
        received=chunkEnd;
      }
      if(received!==end-start+1)throw new Error('Incomplete SLDEM2015 terrain band.');
      written+=length;
    }
    row=endRow+1;
  }
  return new Response(output,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, max-age=86400',
    'X-LOLA-Grid':[firstRow,firstColumn,rows,columns,density].join(','),'X-DEM-Format':'float32-km','X-DEM-Source':'SLDEM2015'}});
}

export async function imageryTile(url) {
  const x=Number(url.searchParams.get('x')), y=Number(url.searchParams.get('y'));
  const z=Number(url.searchParams.get('z')??8), projection=url.searchParams.get('projection')??'EQ';
  const polar=projection==='SP'||projection==='NP';
  if(!['EQ','SP','NP'].includes(projection)||!Number.isInteger(z)||!(polar?[2,5]:[4,8]).includes(z)||!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>=2**(z+1)||y<0||y>=2**z) return new Response('Invalid imagery tile.',{status:400});
  const product=polar?`LRO_WAC_Mosaic_${projection[0]}Pole60_100m_v02`:'LRO_WAC_Mosaic_Global_303ppd_v02';
  const extension=polar?'png':'jpg';
  const source=`https://trek.nasa.gov/tiles/Moon/${projection}/${product}/1.0.0/default/default028mm/${z}/${y}/${x}.${extension}`;
  const response=await fetch(source,{signal:AbortSignal.timeout(20000)});
  if(!response.ok||!response.headers.get('Content-Type')?.includes('image')) {await response.body?.cancel();return new Response('Orbital imagery unavailable.',{status:502});}
  return new Response(response.body,{headers:{'Content-Type':polar?'image/png':'image/jpeg','Cache-Control':'private, max-age=86400'}});
}
