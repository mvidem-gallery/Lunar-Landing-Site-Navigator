import fs from 'node:fs';
import {packPolarDem} from './pack-dem.mjs';
const assets={};
for(const [route,file,type] of [['/','src/index.html','text/html; charset=utf-8'],['/app.js','src/app.js','text/javascript'],['/mission.js','src/mission.js','text/javascript'],['/lander.js','src/lander.js','text/javascript'],['/math.js','src/math.js','text/javascript'],['/terrain-worker.js','src/terrain-worker.js','text/javascript'],['/style.css','src/style.css','text/css'],['/three.js','assets/three.js','text/javascript'],['/terrain.json','data/terrain.json','application/json'],['/far.json','data/far.json','application/json'],['/global-dem.bin','data/global-dem.bin','application/octet-stream'],['/dem.js','src/dem.js','text/javascript'],['/terrain-mesh.js','src/terrain-mesh.js','text/javascript'],['/imagery.js','src/imagery.js','text/javascript'],['/sky.js','src/sky.js','text/javascript'],['/sky-render.js','src/sky-render.js','text/javascript'],['/earth-blue-marble.webp','assets/earth-blue-marble.webp','image/webp'],['/stars-hyg.bin','assets/stars-hyg.bin','application/octet-stream']]){assets[route]={type,base64:fs.readFileSync(file).toString('base64')};}
for (const name of ['terrain', 'far']) {
  assets[`/${name}.packed`] = {type: 'application/octet-stream', base64: packPolarDem(name).toString('base64')};
}
const api=fs.readFileSync('src/server.js','utf8').replaceAll('export async function','async function');
const code = api + '\nconst assets=' + JSON.stringify(assets) + ';\n' + `
function decodeBase64(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/ephemeris') {
        const result = await ephemeris(url);
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/imagery') return await imageryTile(url);
      if (url.pathname === '/api/terrain-detail') return await terrainDetail(url);
      const file = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (!file) return new Response('Not found', { status: 404 });
      const data = Uint8Array.fromBase64 ? Uint8Array.fromBase64(file.base64) : decodeBase64(file.base64);
      return new Response(data, {
        headers: {
          'Content-Type': file.type,
          'Cache-Control': url.pathname === '/' || url.pathname.endsWith('.js') ? 'no-cache' : 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return Response.json({ error: error.message || 'Service temporarily unavailable.' }, { status: 502 });
    }
  },
};`;

fs.writeFileSync('worker/index.js',code);fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});fs.copyFileSync('worker/index.js','dist/server/index.js');fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');console.log('Built worker',Math.round(code.length/1024)+' KB');
