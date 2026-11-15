import {createSkyVisuals} from './sky-render.js?v=sky-v3';
import {imageryPlan, loadImageryBatch} from './imagery.js?v=imagery-v5';
import {DAY, MINUTE, effectiveStep, solarMargin, darknessIntervals, longestDarkness, earliestWindow} from './mission.js?v=terrain-v3';
import {createLander, seatLander} from './lander.js?v=lander-v2';
import {landingSurface} from './terrain-mesh.js?v=overview-v2';
import * as THREE from './three.js?v=terrain-v3';
import {direction,interpolate,horizonAt,dot,D,integrate,integrateOverlap,landerOrbitPosition} from './math.js?v=orbit-v1';
import {GLOBAL_WIDTH, GLOBAL_HEIGHT, loadPackedDem} from './dem.js?v=terrain-v3';
import {MISSIONS_STORAGE_KEY, MissionWorkspace} from './missions.js?v=flightdeck-v2';
const $=id=>document.getElementById(id),fmt=(v,n=1)=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:n,minimumFractionDigits:n}).format(v),deg=v=>fmt(v)+'°';
let orbitalTexture, orbitalDetailTexture, imageryRequest, imageryLabel, imageryEnabled = true;
let near,far,nm,fm,globalDem,polarDemRequest,terrain,ephem,analysis=[],mission,playing=false,t=0,lastFrame=0,az=0,pitch=4,mesh,version=0;
let missionWorkspace = null;
const scene=new THREE.Scene();scene.background=new THREE.Color('#030508');
const camera=new THREE.PerspectiveCamera(65,1,.15,2000000);camera.rotation.order='YXZ';
let renderer,webglAvailable=true;
try{renderer=new THREE.WebGLRenderer({antialias:true,logarithmicDepthBuffer:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0x030508);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;}catch(error){webglAvailable=false;const canvas=document.createElement('canvas');renderer={domElement:canvas,setSize(w,h){canvas.width=w;canvas.height=h;},render(){}};const notice=document.createElement('div');notice.className='webgl-notice';notice.innerHTML='<strong>WebGL 2 is required for the 3D view</strong><span>Enable hardware acceleration or use a browser with WebGL support.<br>Mission calculations and the timeline are still available.</span>';$('scene').append(notice);}
$('canvas').append(renderer.domElement);
const ambientLight = new THREE.AmbientLight(0x8b9eaf, 0.19);
const light = new THREE.DirectionalLight(0xfff0da, 3.1);
const reliefKey = new THREE.DirectionalLight(0xffeed8, 1.9);
const reliefFill = new THREE.DirectionalLight(0xb9d1f0, 0.38);
reliefKey.position.set(-9, 3, -6);
reliefFill.position.set(6, 4, 8);
scene.add(ambientLight, light, light.target, reliefKey, reliefFill);
let reliefLighting = false;
let solarIntensity = 0;

function applyLighting() {
  ambientLight.intensity = reliefLighting ? 0.66 : 0.19;
  light.intensity = reliefLighting ? 0 : solarIntensity;
  reliefKey.visible = reliefFill.visible = reliefLighting;
  $('reliefLight').setAttribute('aria-pressed', String(reliefLighting));
  $('reliefLight').classList.toggle('active', reliefLighting);
}
$('reliefLight').onclick = () => {
  reliefLighting = !reliefLighting;
  applyLighting();
};
applyLighting();
const skyVisuals = createSkyVisuals(scene, webglAvailable);
const {sun, earth} = skyVisuals;
const glowCanvas = document.createElement('canvas');
glowCanvas.width = glowCanvas.height = 128;
const glowContext = glowCanvas.getContext('2d');
const halo = glowContext.createRadialGradient(64, 64, 0, 64, 64, 64);
halo.addColorStop(0, 'rgba(255,241,173,0.95)');
halo.addColorStop(0.16, 'rgba(255,196,77,0.65)');
halo.addColorStop(0.47, 'rgba(255,137,31,0.16)');
halo.addColorStop(1, 'rgba(255,110,0,0)');
glowContext.fillStyle = halo;
glowContext.fillRect(0, 0, 128, 128);
const glowTexture = new THREE.CanvasTexture(glowCanvas);
glowTexture.colorSpace = THREE.SRGBColorSpace;
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTexture, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
}));
scene.add(sunGlow);
sunGlow.visible = false;
const ro = new ResizeObserver(() => {
  const canvas = $('canvas');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (inspectingLander && !overview) orientLanderOrbit();
  drawTracks();
});
ro.observe($('canvas'));

// Left dock (icon rail + drawer: Missions | Parameters | Metadata)
const LEFT_TAB_META = {
  missions: { title: 'Mission', badge: 'MISSION' },
  params: { title: 'Simulation', badge: 'PARAMETERS' },
  metadata: { title: 'Telemetry', badge: 'METADATA' },
};
let activeLeftTab = 'missions';
const railTabBtns = Array.from(document.querySelectorAll('[data-rail-tab]'));

function setLeftCollapsed(collapsed) {
  document.body.classList.toggle('left-collapsed', Boolean(collapsed));
  const btn = $('left-collapse-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? 'Expand Left Panel' : 'Collapse Left Panel';
  }
  requestAnimationFrame(drawTracks);
  setTimeout(drawTracks, 220);
}

function setLeftTab(tab) {
  const next = LEFT_TAB_META[tab] ? tab : 'missions';
  activeLeftTab = next;
  if (document.body.classList.contains('left-collapsed')) {
    setLeftCollapsed(false);
  }
  for (const btn of railTabBtns) {
    btn.classList.toggle('active', btn.dataset.railTab === next);
  }
  for (const key of Object.keys(LEFT_TAB_META)) {
    $('tab-' + key)?.classList.toggle('active', key === next);
  }
  $('left-drawer-title').textContent = LEFT_TAB_META[next].title;
  $('left-drawer-badge').textContent = LEFT_TAB_META[next].badge;
  if (next === 'metadata') requestAnimationFrame(drawTracks);
}

for (const btn of railTabBtns) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.railTab;
    if (!document.body.classList.contains('left-collapsed') && activeLeftTab === tab) {
      setLeftCollapsed(true);
    } else {
      setLeftTab(tab);
    }
  });
}

$('left-collapse-btn')?.addEventListener('click', () => {
  setLeftCollapsed(!document.body.classList.contains('left-collapsed'));
});

$('top-mission-pill')?.addEventListener('click', () => {
  setLeftTab('missions');
  missionWorkspace?.openList();
});

$('bts-meta-btn')?.addEventListener('click', () => {
  setLeftTab('metadata');
});

setLeftCollapsed(matchMedia('(max-width: 760px)').matches);

function bindCollapsible(btnId, bodyId, expandLabel, collapseLabel) {
  const btn = $(btnId);
  const body = $(bodyId);
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const collapsed = !body.classList.contains('collapsed');
    body.classList.toggle('collapsed', collapsed);
    btn.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? expandLabel : collapseLabel;
  });
}

bindCollapsible('top-bar-collapse-btn', 'top-controls-body', 'Expand Quick Points Bar', 'Collapse Quick Points Bar');
bindCollapsible('right-toolbar-collapse-btn', 'right-toolbar-body', 'Expand Camera & Display Tools', 'Collapse Camera & Display Tools');
bindCollapsible('bts-collapse-btn', 'bts-cells', 'Expand Telemetry Readout', 'Collapse Telemetry Readout');

const dateAnalysis = document.querySelector('.suitability');
function syncDateAnalysis() {
  const result = dateAnalysis.dataset.result;
  const panel = $('missionDateAnalysis');
  if (result) panel.dataset.result = result;
  else delete panel.dataset.result;
  for (const [source, target] of [
    ['suitabilityTitle', 'panelSuitability'], ['darkResult', 'panelDarkness'],
    ['earthOutage', 'panelOutage'], ['alternative', 'panelAlternative'],
  ]) $(target).textContent = $(source).textContent;
  $('panelApplyWindow').hidden = $('applyWindow').hidden;
  $('panelRetryWindow').hidden = $('retryWindow').hidden;
}
new MutationObserver(syncDateAnalysis).observe(dateAnalysis, {
  subtree: true, childList: true, characterData: true, attributes: true,
  attributeFilter: ['hidden', 'data-result'],
});
syncDateAnalysis();
$('panelApplyWindow').onclick = () => $('applyWindow').click();
$('panelRetryWindow').onclick = () => $('retryWindow').click();

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('info').open) return;
  if (!document.body.classList.contains('left-collapsed') && matchMedia('(max-width: 820px)').matches) {
    setLeftCollapsed(true);
  }
});

const timelineTrackArea = document.querySelector('.timeline-track-area');
if (timelineTrackArea) new ResizeObserver(drawTracks).observe(timelineTrackArea);
const sceneConsole = $('sceneConsole');
const consoleToggle = $('consoleToggle');
consoleToggle.onclick = () => {
  const open = sceneConsole.classList.contains('is-collapsed');
  sceneConsole.classList.toggle('is-collapsed', !open);
  consoleToggle.classList.toggle('collapsed', !open);
  consoleToggle.setAttribute('aria-expanded', String(open));
  const label = open ? 'Hide timeline controls' : 'Show timeline controls';
  consoleToggle.setAttribute('aria-label', label);
  consoleToggle.title = label;
  if (open) requestAnimationFrame(drawTracks);
};

let isSimulationBusy = false;
let lastStatusError = false;

function syncStatusIndicator() {
  const icon = $('bts-status-icon');
  if (!icon) return;
  icon.classList.toggle('error', lastStatusError);
  icon.classList.toggle('loading', !lastStatusError && isSimulationBusy);
}

function status(text, error = false) {
  lastStatusError = Boolean(error);
  const el = $('status');
  el.textContent = text;
  el.title = text;
  el.style.color = error ? '#ef4444' : '#f4f7fa';
  syncStatusIndicator();
}
function showProgress(kind, complete, total, note = '') {
  $(kind + 'LoadingRow').hidden = false;
  const bar = $(kind + 'Progress');
  if (total) {
    bar.max = total;
    bar.value = complete;
  } else {
    bar.removeAttribute('value');
  }
  $(kind + 'ProgressCount').textContent = note;
}
function setBusy(b) {
  isSimulationBusy = Boolean(b);
  $('missionLoadingRow').hidden = !b;
  $('calculate').disabled = b;
  $('calculate').innerHTML = b ? 'CALCULATING…' : 'CALCULATE MISSION <span>↗</span>';
  syncStatusIndicator();
}
const lander = createLander();
lander.visible = false;
scene.add(lander);
let inspectingLander = false;
let cameraBaseHeight = 1.7;
let overview;
function showTerrainOverview(data, observerHeight) {
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  const colors = new Float32Array(data.normals.length);
  for (let i = 0; i < colors.length; i += 3) {
    const shade = 0.06 + 0.23 * Math.max(0, -0.65 * data.normals[i]
      + 0.45 * data.normals[i + 1] - 0.61 * data.normals[i + 2]);
    colors.fill(shade, i, i + 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({vertexColors: true}));
  overview = {
    object, camera: camera.position.clone(), badge: $('dataBadge').textContent,
    visibility: [mesh, lander, sun, sunGlow, earth, skyVisuals.guideFrame].filter(Boolean).map(object => [object, object.visible]),
  };
  for (const [object] of overview.visibility) object.visible = false;
  overview.ranges = data.drawRanges;
  overview.startedAt = performance.now();
  geometry.setDrawRange(0, overview.ranges[0]);
  scene.add(object);
  camera.position.set(0, Math.max(observerHeight, 4), 0);
  $('dataBadge').textContent = 'Terrain overview · loading detail';
}
function advanceTerrainOverview(now) {
  if (!overview?.ranges) return;
  const next = Math.max(0, Math.floor((now - overview.startedAt) / 45));
  overview.object.geometry.setDrawRange(0, overview.ranges[Math.min(next, overview.ranges.length - 1)]);
  if (next >= overview.ranges.length - 1) overview.ranges = undefined;
}
function clearTerrainOverview() {
  if (!overview) return;
  scene.remove(overview.object);
  overview.object.geometry.dispose();
  overview.object.material.dispose();
  camera.position.copy(overview.camera);
  for (const [object, visible] of overview.visibility) object.visible = visible;
  $('dataBadge').textContent = overview.badge;
  overview = undefined;
}
const landerBounds = new THREE.Sphere();
let landerSurface, observerView;
let orbitAzimuth = 0, orbitElevation = 0;
const orbitRadius = 9.5;

function positionLander(data, observerHeight) {
  landerSurface = landingSurface(data);
  seatLander(lander, landerSurface);
  lander.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(lander, true);
  box.getBoundingSphere(landerBounds);
  cameraBaseHeight = Math.max(observerHeight, box.max.y + 0.75);
  lander.visible = true;
}

function orientLanderOrbit() {
  const target = landerBounds.center;
  camera.position.fromArray(landerOrbitPosition(
    target.toArray(), orbitAzimuth, orbitElevation, orbitRadius,
    landerBounds.radius, camera.fov, camera.aspect, landerSurface.heightAt,
  ));
  camera.lookAt(target);
  updateCompass(orbitAzimuth + 180);
  if (ephem) updateSkyObjects(evaluate(t));
}

function setFieldOfView(value) {
  camera.fov = value;
  camera.updateProjectionMatrix();
  $('fovLabel').textContent = 'FIELD OF VIEW ' + Math.round(value) + '°';
}

function setLanderView(on) {
  if (overview || on === inspectingLander || (on && !terrain)) return;
  drag = null;
  inspectingLander = on;
  const btn = $('inspectLander');
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'OBS' : 'LND';
  btn.title = on ? 'Return to Observer surface view' : 'Orbit around the lander';
  if (on) {
    observerView = {az, pitch, fov: camera.fov};
    orbitAzimuth = 140;
    orbitElevation = 24;
    setFieldOfView(55);
    orientLanderOrbit();
  } else {
    ({az, pitch} = observerView);
    setFieldOfView(observerView.fov);
    camera.position.x = camera.position.z = 0;
    orient();
    updateCameraLift();
  }
}
$('inspectLander').onclick = () => setLanderView(!inspectingLander);

function renderTerrain(data,height){
clearTerrainOverview();
const newSite = terrain?.lat !== data.lat || terrain?.lon !== data.lon;
terrain=data;imageryRequest?.abort();if(orbitalTexture){orbitalTexture.dispose();orbitalTexture=undefined;}if(orbitalDetailTexture){orbitalDetailTexture.dispose();orbitalDetailTexture=undefined;}if(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(data.positions,3));g.setAttribute('uv',new THREE.BufferAttribute(data.uvs,2));g.setIndex(new THREE.BufferAttribute(data.indices,1));g.setAttribute('normal',new THREE.BufferAttribute(data.normals,3));mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x898783,roughness:1,metalness:0,side:THREE.FrontSide}));mesh.material.wireframe=$('wire').classList.contains('active');scene.add(mesh);void loadOrbitalImagery(data,mesh).catch(()=>{});positionLander(data, height);
if (newSite) $('cameraLift').value = 0;
if (inspectingLander) setLanderView(false);
else {
  camera.position.set(0, cameraBaseHeight, 0);
  updateCameraLift(false);
}
$('demResolution').textContent = data.resolution === 3790 ? 'Overview DEM · ≈3.8 km grid'
  : data.resolution === 20 ? 'Polar LOLA DEM · 20 m grid'
  : data.resolution === 60 ? 'Stereo terrain · SLDEM2015 · ≈60 m grid'
  : data.resolution === 30 ? 'Landing-site LOLA DEM · ≈30 m grid'
  : data.resolution === 118 ? 'Detailed LOLA DEM · ≈118 m grid'
  : data.resolution === 474 ? 'Regional LOLA DEM · ≈474 m grid'
    : `Polar DEM · ${data.resolution} m/pixel`;}
function applyImagery() {
  const btn = $('imagery');
  btn.setAttribute('aria-pressed', String(imageryEnabled));
  btn.classList.toggle('active', imageryEnabled);
  if (!mesh) return;
  mesh.material.map = imageryEnabled && orbitalTexture ? orbitalTexture : null;
  mesh.material.color.set(mesh.material.map ? 0xffffff : 0x898783);
  mesh.material.needsUpdate = true;
  const imgEl = $('imageryStatus');
  const text = imageryEnabled ? (imageryLabel || 'Loading…') : 'Geometry lighting only';
  imgEl.textContent = text;
  imgEl.title = text;
}
$('imagery').onclick = () => {imageryEnabled = !imageryEnabled; applyImagery();};
async function loadOrbitalImagery(data, target) {
  const request = new AbortController();
  imageryRequest = request;
  imageryLabel = 'Loading orbital imagery…';
  applyImagery();

  const makeAtlas = detail => {
    const plan = imageryPlan(data.lat, data.lon, detail);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = plan.count * 256;
    return {plan, canvas, context: canvas.getContext('2d')};
  };
  const wide = makeAtlas(false), near = makeAtlas(true);
  const tiles = [near, wide].flatMap(atlas => {
    const {plan} = atlas;
    return Array.from({length: plan.count ** 2}, (_, index) => {
      const col = index % plan.count, row = Math.floor(index / plan.count);
      const rawX = plan.firstX + col;
      const x = plan.projection === 'EQ' ? (rawX % plan.width + plan.width) % plan.width : rawX;
      return {atlas, col, row, query: new URLSearchParams({
        x, y: plan.firstY + row, z: plan.z, projection: plan.projection,
      })};
    }).sort((a, b) => {
      const center = (plan.count - 1) / 2;
      return Math.hypot(a.col - center, a.row - center) - Math.hypot(b.col - center, b.row - center);
    });
  });

  function makeTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = webglAvailable ? renderer.capabilities.getMaxAnisotropy() : 1;
    return texture;
  }
  function showTextures() {
    if (orbitalTexture) {
      orbitalTexture.needsUpdate = true;
      orbitalDetailTexture.needsUpdate = true;
      return;
    }
    const [wx, wy, ww, wh] = wide.plan.bounds;
    const [nx, ny, nw, nh] = near.plan.bounds;
    orbitalTexture = makeTexture(wide.canvas);
    orbitalDetailTexture = makeTexture(near.canvas);
    orbitalTexture.repeat.set(1 / ww, 1 / wh);
    orbitalTexture.offset.set(-wx / ww, -wy / wh);
    const detailImagery = {value: orbitalDetailTexture};
    const detailTransform = {value: new THREE.Vector4(ww / nw, wh / nh, (wx - nx) / nw, (wy - ny) / nh)};
    target.material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, {detailImagery, detailTransform});
      shader.fragmentShader = 'uniform sampler2D detailImagery;\nuniform vec4 detailTransform;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 overview = texture2D(map, vMapUv);
          vec2 detailUv = vMapUv * detailTransform.xy + detailTransform.zw;
          vec4 detail = texture2D(detailImagery, detailUv);
          float edge = min(min(detailUv.x, detailUv.y), min(1.0 - detailUv.x, 1.0 - detailUv.y));
          float blend = smoothstep(0.0, 0.18, edge) * detail.a;
          vec3 base = mix(vec3(0.216), overview.rgb, overview.a);
          diffuseColor.rgb *= mix(base, detail.rgb, blend);
        #endif
      `);
    };
    target.material.customProgramCacheKey = () => 'lunar-multiscale-imagery-v5';
    applyImagery();
  }

  let lastUpload = -Infinity;
  showProgress('imagery', 0, tiles.length, `Orbital tiles: 0 / ${tiles.length}`);
  const result = await loadImageryBatch(tiles, async ({atlas, col, row, query}, signal) => {
    const response = await fetch('./api/imagery?' + query, {signal});
    if (!response.ok) throw new Error('Imagery unavailable');
    const bitmap = await createImageBitmap(await response.blob());
    try {
      signal.throwIfAborted();
      atlas.context.drawImage(bitmap, col * 256, row * 256, 256, 256);
    } finally {
      bitmap.close();
    }
    const now = performance.now();
    if (now - lastUpload >= 250) {
      showTextures();
      lastUpload = now;
    }
  }, ({checked, received}) => {
    showProgress('imagery', checked, tiles.length, `Orbital tiles: ${received} / ${tiles.length}`);
  }, {signal: request.signal, concurrency: 12});

  if (request.signal.aborted || mesh !== target) return;
  $('imageryLoadingRow').hidden = true;
  if (result.received) showTextures();
  imageryLabel = result.received === result.total ? 'LRO WAC · fixed photo lighting'
    : result.received ? `Partial imagery · ${result.received} / ${result.total} tiles`
      : 'Imagery unavailable · terrain only';
  applyImagery();
}

let terrainWorker = null;
let nextWorkerJobId = 1;
const workerJobs = new Map();
const workerCacheState = {global: null, near: null, far: null};

function getTerrainWorker() {
  if (terrainWorker) return terrainWorker;
  const worker = new Worker('./terrain-worker.js?v=fast-v1', {type: 'module'});
  worker.onmessage = ({data}) => {
    const job = workerJobs.get(data.jobId);
    if (!job) return;
    if (data.phase === 'horizon') {
      job.onProgress?.(data.complete, data.total);
      return;
    }
    if (data.phase === 'ground') {
      job.onGround?.(data.ground);
      return;
    }
    workerJobs.delete(data.jobId);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data);
  };
  worker.onerror = error => {
    const err = new Error(error.message || 'Terrain worker error.');
    for (const job of workerJobs.values()) job.reject(err);
    workerJobs.clear();
    worker.terminate();
    terrainWorker = null;
    workerCacheState.global = workerCacheState.near = workerCacheState.far = null;
  };
  terrainWorker = worker;
  return worker;
}

function terrainJob(m, detailTile, fineTile, landingTile, {preview = false, onGround, onProgress} = {}) {
  return new Promise((resolve, reject) => {
    const worker = getTerrainWorker();
    const cacheUpdate = {};
    let hasCacheUpdate = false;
    if (globalDem && workerCacheState.global !== globalDem) {
      cacheUpdate.global = globalDem;
      workerCacheState.global = globalDem;
      hasCacheUpdate = true;
    }
    if (near && workerCacheState.near !== near) {
      cacheUpdate.near = near;
      cacheUpdate.nm = nm;
      workerCacheState.near = near;
      hasCacheUpdate = true;
    }
    if (far && workerCacheState.far !== far) {
      cacheUpdate.far = far;
      cacheUpdate.fm = fm;
      workerCacheState.far = far;
      hasCacheUpdate = true;
    }
    if (hasCacheUpdate) {
      worker.postMessage({type: 'cache', ...cacheUpdate});
    }
    const jobId = nextWorkerJobId++;
    workerJobs.set(jobId, {resolve, reject, onGround, onProgress});
    worker.postMessage({
      jobId,
      ...m,
      detailTile,
      fineTile,
      landingTile,
      preview,
      reportGround: Boolean(onGround),
      reportProgress: Boolean(onProgress),
    });
  });
}
function evaluate(time){const s=interpolate(ephem.sun,time),e=interpolate(ephem.earth,time,[5,7,9]),{incidence:inc,margin:sm}=solarMargin(s, terrain);const em=e[2]-horizonAt(terrain.horizon,e[1]);return {t:time,s,e,inc,sm,em,bm:Math.min(sm,em)};}
function duration(ms){const hours=ms/36e5;return fmt(hours,1)+' hr';}
function analyze(){const times=[...new Set([...ephem.sun.map(r=>r[0]),mission.end])].sort((a,b)=>a-b).filter(v=>v>=mission.start&&v<=mission.end);analysis=times.map(evaluate);const all=mission.end-mission.start;for(const [id,key]of [['sunTotal','sm'],['earthTotal','em'],['bothTotal','bm']]){const ms=key==='bm'?integrateOverlap(analysis,'sm','em'):integrate(analysis,key);const total = duration(ms)+' · '+fmt(ms/all*100,0)+'%';
$(id).textContent = total;
if (key === 'sm') $('timelineSunTotal').textContent = total;
if (key === 'em') $('timelineEarthTotal').textContent = total;}drawTracks();}
function drawTracks(){if(!analysis.length||!mission)return;for(const [id,key,color]of [['sunTrack','sm','#f59e0b'],['earthTrack','em','#0095ff']]){const c=$(id),ctx=c.getContext('2d'),width=c.clientWidth;if(!width)continue;c.width=Math.max(100,width*2);c.height=20;ctx.fillStyle='rgba(255, 255, 255, 0.08)';ctx.fillRect(0,0,c.width,20);ctx.fillStyle=color;for(let i=1;i<analysis.length;i++){const a=analysis[i-1],b=analysis[i];let left=a.t,right=b.t;if(a[key]<=0&&b[key]<=0)continue;if(a[key]<=0)left=a.t+(b.t-a.t)*(-a[key])/(b[key]-a[key]);if(b[key]<=0)right=a.t+(b.t-a.t)*a[key]/(a[key]-b[key]);ctx.fillRect((left-mission.start)/(mission.end-mission.start)*c.width,0,Math.max(.4,(right-left)/(mission.end-mission.start)*c.width),20);}}}
const dateLabel=(time,full=false)=>new Date(time).toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'2-digit',...(full?{year:'numeric',hour:'2-digit',minute:'2-digit'}:{})});
function update(){if(!ephem||!terrain)return;const v=evaluate(t);$('sunEl').textContent=deg(v.s[2]);$('sunAz').textContent=deg(v.s[1]);$('earthEl').textContent=deg(v.e[2]);$('incidence').textContent=deg(v.inc);$('distance').textContent=fmt(v.e[4],0)+' km';$('delay').textContent=fmt(v.e[4]/299792.458,2)+' / '+fmt(v.e[4]/299792.458*2,2)+' s';$('sunState').textContent=v.sm>0?'SUNLIT':'SHADOW';$('sunState').classList.toggle('on',v.sm>0);$('earthState').textContent=v.em>0?'VISIBLE':'OCCLUDED';$('earthState').classList.toggle('on',v.em>0);
if ($('bts-sun-el')) $('bts-sun-el').textContent = deg(v.s[2]);
if ($('bts-earth-el')) $('bts-earth-el').textContent = deg(v.e[2]);
const timestamp = dateLabel(t, true);
$('currentTime').textContent = timestamp + ' UTC';
const progress = Math.max(0, Math.min(1, (t - mission.start) / (mission.end - mission.start)));
timeSlider.value = progress * 1000;
trackTimeMarker.style.left = `${progress * 100}%`;
trackTimeMarker.hidden = false;
updateSkyObjects(v);
updateCompass(inspectingLander ? orbitAzimuth + 180 : az, v.s[1]);
const dir=direction(v.s[1],v.s[2]);light.position.set(...dir.map(x=>x*10000));solarIntensity=v.s[2]>-2?3.1:0;applyLighting();}
let discMagnification = 3;
$('discScale').onclick = () => {
  discMagnification = discMagnification === 3 ? 1 : 3;
  const btn = $('discScale');
  btn.textContent = discMagnification === 3 ? '×3' : '1:1';
  btn.setAttribute('aria-pressed', String(discMagnification === 3));
  btn.classList.toggle('active', discMagnification === 3);
  btn.title = discMagnification === 3
    ? 'Discs 3× magnified (click for true 1:1 angular size)'
    : 'True 1:1 angular size (click for 3×)';
  if (ephem && terrain && !overview) updateSkyObjects(evaluate(t));
};
let showSkyElevations = false;
const skyBodyReadouts = {sun: null, earth: null};
function formatSignedDeg(value) {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${fmt(Math.abs(rounded), 1)}°`;
}
function renderSkyLabel(labelEl, name, readout) {
  if (!labelEl) return;
  if (!showSkyElevations || !readout) {
    labelEl.classList.remove('has-elevation');
    labelEl.textContent = name;
    return;
  }
  labelEl.classList.add('has-elevation');
  labelEl.innerHTML =
    `<span class="object-label-main">${name} · ${formatSignedDeg(readout.elDeg)}</span>` +
    `<span class="object-label-sub">TERRAIN ${formatSignedDeg(readout.aboveHorizonDeg)}</span>`;
}
function refreshSkyLabels() {
  renderSkyLabel($('sunLabel'), 'SUN', skyBodyReadouts.sun);
  renderSkyLabel($('objectLabel'), 'EARTH', skyBodyReadouts.earth);
}
function applySkyElevationButton() {
  const btn = $('skyElevation');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(showSkyElevations));
  btn.classList.toggle('active', showSkyElevations);
  btn.title = showSkyElevations
    ? 'Hide Sun & Earth elevation angles above horizon (°)'
    : 'Show Sun & Earth elevation angles above horizon (°)';
}
$('skyElevation').onclick = () => {
  showSkyElevations = !showSkyElevations;
  applySkyElevationButton();
  refreshSkyLabels();
  if (ephem && terrain && !overview) updateSkyObjects(evaluate(t));
  else skyVisuals.updateGuides({show: false});
};
applySkyElevationButton();
function updateSkyObjects({s, e}) {
  skyVisuals.update({time: t, lat: terrain.lat, lon: terrain.lon, earthRow: e, sunRow: s});
  $('sunDiameter').textContent = fmt(s[3], 3) + '°';
  $('earthDiameter').textContent = fmt(e[3], 3) + '°';
  const observerHeight = mission?.height ?? Number($('height').value);
  const lift = Math.max(0, camera.position.y - observerHeight);
  for (const [object, row, key] of [[sun, s, 'sun'], [earth, e, 'earth']]) {
    const distance = 1000000;
    const relative = new THREE.Vector3(...direction(row[1], row[2])).multiplyScalar(row[4] * 1000);
    relative.y += observerHeight;
    relative.sub(camera.position);
    const range = relative.length();
    const elevation = Math.asin(relative.y / range) / D;
    object.position.copy(relative).multiplyScalar(distance / range).add(camera.position);
    // Scale radius and distance together to preserve the angular silhouette.
    const physicalRadius = row[4] * 1000 * Math.sin(row[3] * D / 2);
    const sceneRadius = physicalRadius * distance / range;
    const angularRadius = Math.asin(sceneRadius / distance);
    object.scale.setScalar(distance * Math.sin(angularRadius * discMagnification));
    const groundHorizon = horizonAt(terrain.horizon, row[1]);
    const sphereDip = -Math.acos(1737400 / (1737400 + lift)) / D;
    // Raising the viewer cannot increase terrain obstruction along the same bearing.
    // The rendered mesh still occludes the disc where it crosses the local skyline.
    const horizon = Math.min(groundHorizon, sphereDip);
    const effectiveHorizon = lift === 0 ? groundHorizon : horizon;
    object.visible = elevation + row[3] / 2 >= effectiveHorizon;
    skyBodyReadouts[key] = {
      azDeg: row[1],
      elDeg: elevation,
      horizonDeg: effectiveHorizon,
      aboveHorizonDeg: elevation - effectiveHorizon,
    };
  }
  sunGlow.position.copy(sun.position);
  sunGlow.scale.setScalar(sun.scale.x * 7);
  sunGlow.visible = sun.visible;
  refreshSkyLabels();
  skyVisuals.updateGuides({
    show: showSkyElevations && !overview,
    sun: {visible: sun.visible, ...skyBodyReadouts.sun},
    earth: {visible: earth.visible, ...skyBodyReadouts.earth},
  });
}

function updateCameraLift(updateSky = true) {
  const lift = Number($('cameraLift').value);
  const label = lift < 1000 ? fmt(lift, 0) + ' m' : fmt(lift / 1000, 2) + ' km';
  $('eyeLabel').textContent = label;
  if (terrain && !overview) {
    camera.position.y = cameraBaseHeight + lift;
    if (updateSky && ephem) updateSkyObjects(evaluate(t));
  }
}
$('cameraLift').oninput = () => {
  if (inspectingLander) setLanderView(false);
  else updateCameraLift();
};
$('lookDown').onclick = () => {
  if (inspectingLander) setLanderView(false);
  if (!$('cameraLift').valueAsNumber) $('cameraLift').value = $('cameraLift').max;
  updateCameraLift();
  pitch = -85;
  orient();
};
$('resetLift').onclick = () => {
  if (inspectingLander) setLanderView(false);
  $('cameraLift').value = 0;
  updateCameraLift();
  pitch = 4;
  orient();
};
function updateCompass(heading, sunAz = null) {
  const angle = (heading % 360 + 360) % 360;
  $('compass').textContent = ['N','NE','E','SE','S','SW','W','NW'][Math.round(angle / 45) % 8]
    + ' · ' + String(Math.round(angle) % 360).padStart(3, '0') + '°';
  const needle = $('compass-needle');
  if (needle) {
    needle.style.transform = `rotate(${-angle}deg)`;
  }
  const sunDot = $('compass-sun-dot');
  if (sunDot) {
    const resolvedSunAz = Number.isFinite(sunAz)
      ? sunAz
      : (ephem ? interpolate(ephem.sun, t)[1] : NaN);
    if (Number.isFinite(resolvedSunAz)) {
      const relDeg = (resolvedSunAz - angle + 360) % 360;
      sunDot.hidden = false;
      sunDot.style.transform = `translate(-50%, -50%) rotate(${relDeg}deg) translateY(-16px)`;
    } else {
      sunDot.hidden = true;
    }
  }
}
function orient() {
  camera.rotation.set(pitch * D, -az * D, 0);
  updateCompass(az);
}
let drag = null;
renderer.domElement.addEventListener('pointerdown', event => {
  drag = {
    id: event.pointerId, x: event.clientX, y: event.clientY,
    azimuth: inspectingLander ? orbitAzimuth : az,
    elevation: inspectingLander ? orbitElevation : pitch,
  };
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', event => {
  if (drag?.id !== event.pointerId) return;
  const dx = (event.clientX - drag.x) * 0.15;
  const dy = (event.clientY - drag.y) * 0.15;
  if (inspectingLander) {
    if (overview) return;
    orbitAzimuth = (drag.azimuth + dx) % 360;
    orbitElevation = Math.max(5, Math.min(85, drag.elevation + dy));
    orientLanderOrbit();
  } else {
    az = (drag.azimuth - dx) % 360;
    pitch = Math.max(-85, Math.min(85, drag.elevation + dy));
    orient();
  }
});
function endDrag(event) {
  if (drag?.id === event.pointerId) drag = null;
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  renderer.domElement.addEventListener(event, endDrag);
}
renderer.domElement.addEventListener('wheel', event => {
  event.preventDefault();
  const minimum = inspectingLander ? 30 : 5;
  setFieldOfView(Math.max(minimum, Math.min(95, camera.fov + event.deltaY * 0.035)));
  if (inspectingLander && !overview) orientLanderOrbit();
}, {passive: false});
$('lookSun').onclick = () => look('sun');
$('lookEarth').onclick = () => look('earth');
function look(body) {
  if (!ephem || overview) return;
  if (inspectingLander) setLanderView(false);
  updateSkyObjects(evaluate(t));
  const relative = (body === 'sun' ? sun : earth).position.clone().sub(camera.position);
  az = (Math.atan2(relative.x, -relative.z) / D + 360) % 360;
  pitch = Math.atan2(relative.y, Math.hypot(relative.x, relative.z)) / D;
  orient();
}

$('lookNorth').onclick=()=>{if(inspectingLander)setLanderView(false);az=0;pitch=4;orient();};$('wire').onclick=()=>{$('wire').classList.toggle('active');const enabled = $('wire').classList.contains('active');$('wire').setAttribute('aria-pressed',String(enabled));if(mesh)mesh.material.wireframe=enabled;};
const timeSlider = $('time');
const trackTimeMarker = $('trackTimeMarker');
timeSlider.oninput = () => {
  playing = false;
  $('play').textContent = '▶';
  t = mission.start + timeSlider.valueAsNumber / 1000 * (mission.end - mission.start);
  update();
};
$('play').onclick=()=>{if(t>=mission.end)t=mission.start;playing=!playing;$('play').textContent=playing?'Ⅱ':'▶';};
$('about').onclick=()=>$('info').showModal();$('closeInfo').onclick=()=>$('info').close();$('info').addEventListener('click',e=>{if(e.target===$('info')){const b=$('info').getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)$('info').close();}});
$('mission').onsubmit=e=>{e.preventDefault();calculate();};
function readCoordinate(id, limit, label) {
  const input = $(id);
  const normalized = input.value.trim().replace(/^−/, '-').replace(',', '.');
  const value = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized) ? Number(normalized) : NaN;
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    input.focus();
    throw new Error(`${label}: enter a number from −${limit} to ${limit} (for example, -12.5).`);
  }
  return value;
}
function readCoordSafe(id) {
  const raw = ($(id)?.value || '').trim().replace(/^−/, '-').replace(',', '.');
  const val = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(val) ? val : null;
}
const IS_LITTLE_ENDIAN = new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;
const detailTileCache = new Map();

async function fetchDetail({lat, lon}, layer, {timeoutMs = 50000} = {}) {
  const latKey = lat.toFixed(3), lonKey = lon.toFixed(3);
  const cacheKey = `${latKey}:${lonKey}:${layer || 'regional'}`;
  if (detailTileCache.has(cacheKey)) {
    const cached = detailTileCache.get(cacheKey);
    detailTileCache.delete(cacheKey);
    detailTileCache.set(cacheKey, cached);
    return cached;
  }
  const query = new URLSearchParams({lat: latKey, lon: lonKey});
  if (layer) query.set('detail', layer);
  const response = await fetch('./api/terrain-detail?' + query, {signal: AbortSignal.timeout(timeoutMs)});
  if (response.status === 204) {
    detailTileCache.set(cacheKey, undefined);
    return undefined;
  }
  if (!response.ok) throw new Error('LOLA elevation data is temporarily unavailable.');
  const [firstRow, firstColumn, rows, columns, density = 64] = (response.headers.get('X-LOLA-Grid') || '').split(',').map(Number);
  const buffer = await response.arrayBuffer();
  const stereo = response.headers.get('X-DEM-Format') === 'float32-km';
  const count = rows * columns;
  if (!rows || !columns || buffer.byteLength !== count * (stereo ? 4 : 2)) throw new Error('Incomplete LOLA elevation data.');

  let values;
  if (stereo) {
    values = new Float32Array(count);
    if (IS_LITTLE_ENDIAN) {
      const raw = new Float32Array(buffer);
      for (let i = 0; i < count; i++) {
        const m = raw[i] * 1000;
        if (!Number.isFinite(m) || Math.abs(m) > 15000) throw new Error('Invalid elevation sample.');
        values[i] = m;
      }
    } else {
      const bytes = new DataView(buffer);
      for (let i = 0; i < count; i++) {
        const m = bytes.getFloat32(i * 4, true) * 1000;
        if (!Number.isFinite(m) || Math.abs(m) > 15000) throw new Error('Invalid elevation sample.');
        values[i] = m;
      }
    }
  } else if (IS_LITTLE_ENDIAN) {
    values = new Int16Array(buffer);
  } else {
    values = new Int16Array(count);
    const bytes = new DataView(buffer);
    for (let i = 0; i < count; i++) values[i] = bytes.getInt16(i * 2, true);
  }

  const tile = {firstRow, firstColumn, rows, columns, density, values, scale: stereo ? 1 : 0.5, source: stereo ? 'SLDEM2015' : 'LOLA', blendCells: stereo ? 48 : 8};
  if (detailTileCache.size >= 32) {
    detailTileCache.delete(detailTileCache.keys().next().value);
  }
  detailTileCache.set(cacheKey, tile);
  return tile;
}

let recommendedWindow;
function ephemerisQuery(m, ground) {
  return new URLSearchParams({
    lat: m.lat, lon: m.lon, alt: (ground + m.height) / 1000,
    start: new Date(m.start).toISOString(), end: new Date(m.end).toISOString(), step: m.step, view: 'sky-v1',
  });
}

async function assessMission(m, tr, current) {
  const box = dateAnalysis;
  const title = $('suitabilityTitle'), result = $('darkResult'), alternative = $('alternative');
  const limit = m.darkDays * DAY;
  const duration = m.end - m.start;
  $('missionDateRange').textContent = `${dateLabel(m.start, true)} — ${dateLabel(m.end, true)} UTC`;
  const intervals = darknessIntervals(analysis);
  const longest = longestDarkness(intervals, m.start, m.end);
  const darkness = longest.end - longest.start;
  const pass = darkness <= limit;
  title.textContent = pass ? 'Within darkness endurance' : 'Darkness endurance exceeded';
  box.dataset.result = pass ? 'pass' : 'fail';
  result.textContent = `Longest darkness: ${fmt(darkness / DAY, 2)} days (${fmt(darkness / 36e5, 1)} hr). Endurance: ${fmt(m.darkDays, 2)} days.`;
  if (darkness > 0) {
    result.textContent += ` Shadow: ${dateLabel(longest.start, true)} — ${dateLabel(longest.end, true)} UTC.`;
  }
  const outage = longestDarkness(darknessIntervals(analysis, 'em'), m.start, m.end);
  const outageLength = outage.end - outage.start;
  $('earthOutage').textContent = outageLength > 0
    ? `Longest loss of Earth visibility: ${fmt(outageLength / DAY, 2)} days (${fmt(outageLength / 36e5, 1)} hr). ${dateLabel(outage.start, true)} — ${dateLabel(outage.end, true)} UTC.`
    : 'Earth remained directly visible throughout the mission.';
  if (pass) return;

  const extension = Math.min(m.end + 365 * DAY, Date.parse('2100-12-31T23:00:00Z'));
  if (extension < m.end + MINUTE) {
    alternative.textContent = 'No later window can be checked within the supported date range.';
    return;
  }
  alternative.textContent = 'Searching for the nearest later mission of the same duration…';
  $('retryWindow').hidden = true;
  try {
    const query = ephemerisQuery({...m, start: m.end, end: extension, step: effectiveStep(extension - m.end, m.step)}, tr.ground);
    query.set('target', 'sun');
    const response = await fetch('./api/ephemeris?' + query, {signal: AbortSignal.timeout(135000)});
    const data = await response.json();
    if (!response.ok || !data.sun?.length) throw new Error('Could not retrieve future ephemerides.');
    if (current !== version) return;
    const future = data.sun.filter(row => row[0] > m.end)
      .map(row => ({t: row[0], sm: solarMargin(row, tr).margin}));
    const allDarkness = darknessIntervals([...analysis, ...future]);
    const next = earliestWindow(allDarkness, m.start + MINUTE, extension - duration, duration, limit);
    if (next === null) {
      alternative.textContent = `By ${dateLabel(extension - duration, true)} UTC no suitable start of the same duration was found.`;
      return;
    }
    recommendedWindow = {start: next, end: next + duration};
    const candidate = longestDarkness(allDarkness, next, next + duration);
    alternative.textContent = `Nearest suitable window: ${dateLabel(next, true)} — ${dateLabel(next + duration, true)} UTC. Longest darkness ≈ ${fmt((candidate.end - candidate.start) / DAY, 2)} days.`;
    $('applyWindow').hidden = false;
  } catch {
    if (current !== version) return;
    alternative.textContent = 'Could not check later dates. Please retry.';
    $('retryWindow').hidden = false;
  }
}
$('retryWindow').onclick = () => {
  if (mission) void assessMission(mission, terrain, version);
};
$('applyWindow').onclick = () => {
  if (!recommendedWindow) return;
  for (const id of ['start', 'end']) $(id).value = new Date(recommendedWindow[id]).toISOString().slice(0, 16);
  $('mission').requestSubmit();
};

function loadPolarDem() {
  if (!polarDemRequest) {
    async function load(name) {
      const response = await fetch(`./${name}.json`);
      if (!response.ok) throw new Error('Could not load polar terrain metadata.');
      const meta = await response.json();
      const grid = await loadPackedDem(`./${name}.packed`, meta.width, meta.height, 0.5);
      return {meta, grid};
    }
    polarDemRequest = Promise.all([load('terrain'), load('far')]).then(([local, regional]) => {
      nm = local.meta; near = local.grid;
      fm = regional.meta; far = regional.grid;
    }).catch(() => {
      polarDemRequest = undefined;
    });
  }
  return polarDemRequest;
}

async function terrainForMission(m, isCurrent, showQuickView, onGround) {
  if (terrain?.hasOnlineDetail && mission && m.lat === mission.lat && m.lon === mission.lon && m.height === mission.height) {
    status('Using the terrain already loaded for this site…');
    onGround(terrain.ground);
    return terrain;
  }
status(Math.abs(m.lat) <= 59.3 ? 'Loading Kaguya + LOLA stereo terrain (may take a minute)…' : 'Loading detailed LOLA terrain…');
if (webglAvailable && (terrain?.lat !== m.lat || terrain?.lon !== m.lon)) {
  void terrainJob(m, undefined, undefined, undefined, {preview: true}).then(data => {
    if (showQuickView()) showTerrainOverview(data, m.height);
  }).catch(() => {});
}
// The widest view cannot reach the south polar DEM from 55°S or farther north.
const polarReady = m.lat < -55 ? loadPolarDem() : undefined;
const useStereo = Math.abs(m.lat) <= 59.3;
const layers = [undefined, 'fine', useStereo ? 'stereo' : 'landing'];
let layersChecked = 0;
let landingFallbackPromise = null;
let stereoSettled = !useStereo;
let pdsLayersPending = 2;
const startLandingFallback = () => {
  if (useStereo && !stereoSettled && !landingFallbackPromise && isCurrent()) {
    landingFallbackPromise = fetchDetail(m, 'landing', {timeoutMs: 65000}).catch(() => undefined);
  }
};
showProgress('mission', 0, layers.length, `Elevation sources checked: 0 / ${layers.length}`);
const [regionalResult, fineResult, landingResult] = await Promise.allSettled(
  layers.map(layer => fetchDetail(m, layer, {timeoutMs: layer === 'stereo' ? 85000 : 65000}).finally(() => {
    if (layer === 'stereo') {
      stereoSettled = true;
    } else if (useStereo && --pdsLayersPending === 0) {
      startLandingFallback();
    }
    if (isCurrent()) showProgress('mission', ++layersChecked, layers.length,
      `Elevation sources checked: ${layersChecked} / ${layers.length}`);
  }))
);
if (!isCurrent()) return;
const detailTile = regionalResult.status === 'fulfilled' ? regionalResult.value : undefined;
const fineTile = fineResult.status === 'fulfilled' ? fineResult.value : undefined;
let landingTile = landingResult.status === 'fulfilled' ? landingResult.value : undefined;
if (!landingTile && useStereo) {
  status('Stereo terrain unavailable. Loading the LOLA fallback…');
  showProgress('mission');
  try {
    landingTile = await (landingFallbackPromise || fetchDetail(m, 'landing', {timeoutMs: 65000}));
  } catch {}
}
if (!detailTile && !fineTile && !landingTile) status('Detailed DEM unavailable. Using overview elevation data…');
if (!isCurrent()) return;
status('Building detailed terrain and horizon…');
showProgress('mission');
await polarReady;
if (!isCurrent()) return;
const result = await terrainJob(m, detailTile, fineTile, landingTile, {
  onGround,
  onProgress(complete, total) {
    if (isCurrent()) showProgress('mission', complete, total, `Horizon: ${complete} / ${total} directions`);
  },
});
result.hasOnlineDetail = Boolean(detailTile || fineTile || landingTile);
return result;
}

async function loadEphemeris(m, ground) {
  const query = ephemerisQuery(m, ground);
  const key = 'lunar-sky-v1:' + query;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch {}
  const response = await fetch('./api/ephemeris?' + query);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Could not retrieve ephemerides.');
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
  return data;
}

function applyPointCoordsToInputs(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
  $('lat').value = Number(point.lat).toFixed(5);
  $('lon').value = Number(point.lon).toFixed(5);
}

function applyMissionDatesToInputs(selectedMission) {
  const landingIso = selectedMission?.flight?.landingDateIso;
  if (!landingIso) return false;
  const landingMs = Date.parse(landingIso);
  const minMs = Date.UTC(2000, 0, 1, 0, 0, 0);
  const maxStartMs = Date.UTC(2100, 10, 30, 23, 59, 0);
  const maxEndMs = Date.UTC(2100, 11, 31, 23, 0, 0);
  if (!Number.isFinite(landingMs) || landingMs < minMs || landingMs > maxStartMs) {
    return false;
  }
  const curStart = Date.parse($('start').value + 'Z');
  const curEnd = Date.parse($('end').value + 'Z');
  const curDuration = Number.isFinite(curStart) && Number.isFinite(curEnd) && curEnd > curStart && curEnd - curStart <= 365 * DAY
    ? curEnd - curStart
    : 30 * DAY;
  const startMs = landingMs;
  const endMs = Math.min(maxEndMs, startMs + curDuration);
  $('start').value = new Date(startMs).toISOString().slice(0, 16);
  $('end').value = new Date(endMs).toISOString().slice(0, 16);
  return true;
}

async function calculate(){const current=++version;let showOverview = true;
try{setBusy(true);
showProgress('mission');
clearTerrainOverview();
recommendedWindow = undefined;
$('applyWindow').hidden = $('retryWindow').hidden = true;
dateAnalysis.removeAttribute('data-result');
$('missionDateRange').textContent = '';
$('suitabilityTitle').textContent = 'Mission suitability';
$('darkResult').textContent = 'Waiting for calculation.';
$('earthOutage').textContent = '';
$('alternative').textContent = '';playing=false;$('play').textContent='▶';const m={lat:readCoordinate('lat',90,'Latitude'),lon:readCoordinate('lon',180,'Longitude'),height:Number($('height').value),darkDays:readCoordinate('darkLimit',365,'Endurance'),start:Date.parse($('start').value+'Z'),end:Date.parse($('end').value+'Z'),step:Number($('step').value)};
if(!Object.values(m).every(Number.isFinite)||m.height<.1||m.height>100||m.start>=m.end||m.end-m.start>365*DAY||m.darkDays<0||m.start<Date.parse('2000-01-01')||m.end>=Date.parse('2101-01-01'))throw new Error('Check observer height (0.1–100 m), dates (2000–2100) and mission duration (up to 365 days).');
missionWorkspace?.syncWithExternalParams({lat: m.lat, lon: m.lon});
const requestedStep = m.step;
m.step = effectiveStep(m.end - m.start, requestedStep);
$('play').disabled=true;timeSlider.disabled = true;$('export').disabled=true;
let ephemerisRequest;
const tr = await terrainForMission(m, () => current === version, () => showOverview && current === version, ground => {
  if (current === version) {
    ephemerisRequest = loadEphemeris(m, ground).then(data => ({data}), error => ({error}));
  }
});
if (current !== version) return;
if (!ephem) {
  showOverview = false;
  renderTerrain(tr, m.height);
  $('coordinates').textContent = `${fmt(m.lat, 4)}° / ${fmt(m.lon, 4)}° E`;
}
status('Retrieving Sun and Earth ephemerides from JPL Horizons…');
showProgress('mission');
const {data, error} = await ephemerisRequest;
if (error) throw error;
if(current!==version)return;mission=m;ephem=data;if(terrain!==tr)renderTerrain(tr,m.height);$('coordinates').textContent = `${fmt(m.lat, 4)}° / ${fmt(m.lon, 4)}° E`;t=m.start;analyze();update();look('earth');$('startLabel').textContent=dateLabel(m.start,true);$('endLabel').textContent=dateLabel(m.end,true);$('missionDuration').textContent=fmt((m.end-m.start)/864e5,1)+' days';$('play').disabled=false;timeSlider.disabled = false;$('export').disabled=false;$('dataBadge').textContent=tr.resolution===60?'SLDEM2015 + JPL · Real data':'LOLA + JPL · Real data';status('Calculated · '+ephem.sun.length.toLocaleString('en-GB')+' samples · step '+m.step+' min' + (m.step > requestedStep ? ' Time step automatically increased for this long mission.' : '') + (tr.hasOnlineDetail ? '' : ' Detailed LOLA data unavailable; using the bundled DEM.'));
void assessMission(m, tr, current);
}catch(e){$('darkResult').textContent='These parameters have not been assessed.';status(e.message,true);if(mission&&ephem){$('play').disabled=false;timeSlider.disabled = false;$('export').disabled=false;status(e.message+' Showing the previous successful calculation.',true);}}finally{showOverview = false;if(current===version){clearTerrainOverview();setBusy(false);}}}
$('export').onclick=()=>{const meta=[['# Lunar Horizon research prototype'],['# NASA LOLA DEM; JPL Horizons; center-of-disk visibility; no eclipses'],['# UTC; Moon_ME; horizon radius 250 km; angular step 0.5 degrees'],['# latitude',mission.lat,'longitude_east',mission.lon,'eye_height_m',mission.height,'dem_spacing_m',terrain.resolution,'step_min',mission.step]];const rows=[...meta,['utc','sun_az_deg','sun_el_deg','incidence_deg','sun_center_visible_and_front_lit','earth_az_deg','earth_el_deg','earth_center_visible','earth_distance_km','one_way_s','round_trip_s'],...analysis.map(v=>[new Date(v.t).toISOString(),v.s[1],v.s[2],v.inc,v.sm>0?1:0,v.e[1],v.e[2],v.em>0?1:0,v.e[4],v.e[4]/299792.458,v.e[4]/299792.458*2])];const blob=new Blob(['\uFEFF'+rows.map(r=>r.join(',')).join('\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='lunar-mission.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function loop(now){requestAnimationFrame(loop);const delta=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;if(playing&&mission){t=Math.min(mission.end,t+delta*Number($('speed').value)*1000);if(t===mission.end){playing=false;$('play').textContent='▶';}update();}advanceTerrainOverview(now);skyVisuals.followCamera(camera.position);renderer.render(scene,camera);if (ephem && webglAvailable) {
  positionLabel(earth, $('objectLabel'));
  positionLabel(sun, $('sunLabel'));
}}
const discCenter = new THREE.Vector3();
const projectedDisc = new THREE.Vector3();
function positionLabel(object, label) {
  const canvas = $('canvas');
  const projected = projectedDisc.copy(object.position).project(camera);
  const visible = object.visible && projected.z > -1 && projected.z < 1
    && Math.abs(projected.x) < 0.90 && Math.abs(projected.y) < 0.95;
  if (!visible) {
    label.style.display = 'none';
    return;
  }

  // Project the upper and lower tangents of the displayed sphere. Its size
  // varies with the angular scale, field of view, and position in the frame.
  const center = discCenter.copy(object.position).applyMatrix4(camera.matrixWorldInverse);
  const bearing = Math.atan2(center.y, -center.z);
  const radius = Math.asin(object.scale.y / Math.hypot(center.y, center.z));
  const verticalScale = camera.projectionMatrix.elements[5];
  const topAngle = bearing + radius;
  const bottomAngle = bearing - radius;
  const edgeY = angle => (1 - Math.tan(angle) * verticalScale) * canvas.clientHeight / 2;
  const top = topAngle >= Math.PI / 2 ? -Infinity : edgeY(topAngle) - 7;
  const bottom = bottomAngle <= -Math.PI / 2 ? Infinity : edgeY(bottomAngle) + 7;
  const minMargin = showSkyElevations ? 34 : 18;
  const above = top >= minMargin;
  if (!above && bottom > canvas.clientHeight - minMargin) {
    label.style.display = 'none';
    return;
  }
  label.classList.toggle('below-disc', !above);
  label.style.left = ((projected.x + 1) / 2 * canvas.clientWidth) + 'px';
  label.style.top = (above ? top : bottom) + 'px';
  label.style.display = 'block';
}
orient();requestAnimationFrame(loop);
try {
  setBusy(true);
  const query = new URLSearchParams(location.search);
  for (const id of ['lat', 'lon', 'height', 'start', 'end', 'darkLimit']) {
    if (query.has(id)) $(id).value = query.get(id);
  }
  if (query.has('step')) {
    const requestedStep = query.get('step');
    if ([...$('step').options].some(opt => opt.value === requestedStep)) {
      $('step').value = requestedStep;
    }
  }

  missionWorkspace = new MissionWorkspace({
    container: $('mission-workspace-slot'),
    quickBarContainer: $('quick-point-chips'),
    onSelectMission(selectedMission, point) {
      applyPointCoordsToInputs(point);
      applyMissionDatesToInputs(selectedMission);
      void calculate();
    },
    onSelectPoint(point) {
      applyPointCoordsToInputs(point);
      void calculate();
    },
    onRequestParams() {
      setLeftTab('params');
    },
    getCurrentCoords() {
      return { lat: readCoordSafe('lat'), lon: readCoordSafe('lon') };
    },
    getCurrentDates() {
      const startMs = Date.parse(($('start')?.value || '') + 'Z');
      const endMs = Date.parse(($('end')?.value || '') + 'Z');
      return {
        startIso: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
        endIso: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
      };
    },
  });

  if (query.has('lat') && query.has('lon')) {
    missionWorkspace.syncWithExternalParams({
      missionId: query.get('missionId'),
      lat: readCoordSafe('lat'),
      lon: readCoordSafe('lon'),
    });
  } else {
    let hasStoredMissions = false;
    try {
      hasStoredMissions = Boolean(localStorage.getItem(MISSIONS_STORAGE_KEY));
    } catch {}
    if (query.has('missionId')) {
      missionWorkspace.syncWithExternalParams({ missionId: query.get('missionId') });
      const activePt = missionWorkspace.getActivePoint();
      applyPointCoordsToInputs(activePt);
      applyMissionDatesToInputs(missionWorkspace.getActiveMission());
    } else if (hasStoredMissions) {
      const activeMission = missionWorkspace.getActiveMission();
      const activePt = missionWorkspace.getActivePoint();
      applyPointCoordsToInputs(activePt);
      applyMissionDatesToInputs(activeMission);
    }
    missionWorkspace.syncWithExternalParams({
      missionId: query.get('missionId') || missionWorkspace.getActiveMission()?.id,
      lat: readCoordSafe('lat'),
      lon: readCoordSafe('lon'),
    });
  }

  globalDem = await loadPackedDem('./global-dem.bin', GLOBAL_WIDTH, GLOBAL_HEIGHT);
  await calculate();
} catch (error) {
  status('Could not load data: ' + error.message, true);
  setBusy(false);
}
