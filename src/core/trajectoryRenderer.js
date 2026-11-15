import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { EARTH_CONFIG, TRAJECTORY_CONFIG } from '../config/constants.js';
import { TrajectoryGenerator } from '../astronomy/trajectoryGenerator.js';

const EVENT_DISPLAY_LABELS = {
  launch: 'LAUNCH',
  tli: 'TLI',
  loi: 'LOI',
  doi: 'DOI',
  pdi: 'PDI',
  touchdown: 'TOUCHDOWN',
};

function createGlowTexture(innerHex = '#ffffff', outerHex = '#34d399') {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, innerHex);
  grad.addColorStop(0.32, outerHex);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createBadgeSprite(title, subtitle, accentCss) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Pill background
  const padX = 12;
  const padY = 12;
  const w = canvas.width - padX * 2;
  const h = canvas.height - padY * 2;
  const r = 14;

  ctx.beginPath();
  ctx.moveTo(padX + r, padY);
  ctx.lineTo(padX + w - r, padY);
  ctx.quadraticCurveTo(padX + w, padY, padX + w, padY + r);
  ctx.lineTo(padX + w, padY + h - r);
  ctx.quadraticCurveTo(padX + w, padY + h, padX + w - r, padY + h);
  ctx.lineTo(padX + r, padY + h);
  ctx.quadraticCurveTo(padX, padY + h, padX, padY + h - r);
  ctx.lineTo(padX, padY + r);
  ctx.quadraticCurveTo(padX, padY, padX + r, padY);
  ctx.closePath();

  ctx.fillStyle = 'rgba(7, 13, 24, 0.84)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = accentCss || '#38bdf8';
  ctx.stroke();

  // Accent dot
  ctx.beginPath();
  ctx.arc(padX + 20, padY + 26, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = accentCss || '#38bdf8';
  ctx.fill();

  ctx.font = '700 22px Rajdhani, "Segoe UI", sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, padX + 34, padY + 26);

  if (subtitle) {
    ctx.font = '600 17px Rajdhani, "Segoe UI", sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(subtitle, padX + 34, padY + 52);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 0.94,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 8;
  return { sprite, texture, material };
}

export class TrajectoryRenderer {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'DirectTrajectoryGroup';
    this.group.visible = false;
    this.scene.add(this.group);

    this._generated = null;
    this._lineMaterials = [];
    this._disposables = [];
    this._eventMarkers = [];
    this._eventSprites = [];
    this._sceneScaleFactor = 1;

    this._spacecraftGroup = null;
    this._spacecraftHalo = null;
    this._spacecraftDir = new THREE.Vector3();
    this._spacecraftUp = new THREE.Vector3(0, 1, 0);
    this._tmpCamPos = new THREE.Vector3();
    this._tmpWorldPos = new THREE.Vector3();

    this._currentTimeSec = 0;
    this._isPlaying = true;
    this._lastUpdatePerfMs = null;
    this._playbackDurationSec = TRAJECTORY_CONFIG.DEFAULT_PLAYBACK_DURATION_SEC;
    this._onTelemetryTick = null;

    this._resolution = new THREE.Vector2(
      typeof window !== 'undefined' ? window.innerWidth : 1280,
      typeof window !== 'undefined' ? window.innerHeight : 720
    );
  }

  setVisible(visible) {
    const next = Boolean(visible && this._generated);
    if (next && !this.group.visible) {
      this._lastUpdatePerfMs = performance.now();
    }
    this.group.visible = next;
  }

  isVisible() {
    return this.group.visible;
  }

  setPlaying(playing) {
    this._isPlaying = Boolean(playing);
    this._lastUpdatePerfMs = performance.now();
  }

  isPlaying() {
    return this._isPlaying;
  }

  setTimeSeconds(t_s) {
    if (!this._generated) return null;
    const tMin = this._generated.meta.tStart ?? 0;
    const tMax = this._generated.meta.tEnd ?? this._generated.meta.durationSec;
    this._currentTimeSec = Math.max(tMin, Math.min(tMax, t_s));
    return this._applySpacecraftPose();
  }

  getTimeSeconds() {
    return this._currentTimeSec;
  }

  onTelemetryTick(callback) {
    this._onTelemetryTick = callback;
  }

  clear() {
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
    for (const item of this._disposables) {
      if (typeof item?.dispose === 'function') {
        item.dispose();
      }
    }
    this._disposables = [];
    this._lineMaterials = [];
    this._eventMarkers = [];
    this._eventSprites = [];
    this._spacecraftGroup = null;
    this._spacecraftHalo = null;
  }

  setGeneratedTrajectory(generated, { preserveTime = true } = {}) {
    const prevTime = this._currentTimeSec;
    this.clear();
    this._generated = generated || null;

    if (!this._generated) {
      this.group.visible = false;
      return;
    }

    const { segments, moonOrbitPoints, events, sceneParams, meta } = this._generated;
    const cislunarDist = sceneParams?.cislunarDistance ?? EARTH_CONFIG.CISLUNAR_DISTANCE;
    this._sceneScaleFactor = Math.max(
      1,
      cislunarDist / Math.max(1, EARTH_CONFIG.CISLUNAR_DISTANCE)
    );
    const earthCenter = new THREE.Vector3(...(sceneParams.earthCenter || [0, 0, 0]));
    const defaultMoonCenter = new THREE.Vector3(...(sceneParams.initialMoonCenter || [15, 0, 0]));
    const evMoonCenter = new THREE.Vector3();

    // 0. Moon orbital arc during the mission window
    if (moonOrbitPoints && moonOrbitPoints.length >= 6) {
      const orbitStyle = TRAJECTORY_CONFIG.MOON_ORBIT_ARC || {
        color: 0x94a3b8,
        lineWidth: 1.6,
        opacity: 0.45,
        dashSize: 0.28,
        gapSize: 0.22,
      };
      const orbitGeom = new LineGeometry();
      orbitGeom.setPositions(Array.from(moonOrbitPoints));
      const orbitMat = new LineMaterial({
        color: orbitStyle.color,
        linewidth: orbitStyle.lineWidth,
        transparent: true,
        opacity: orbitStyle.opacity,
        dashed: true,
        dashSize: orbitStyle.dashSize * this._sceneScaleFactor,
        gapSize: orbitStyle.gapSize * this._sceneScaleFactor,
        dashScale: 1,
        depthTest: true,
        depthWrite: false,
        resolution: this._resolution.clone(),
      });
      const orbitLine = new Line2(orbitGeom, orbitMat);
      orbitLine.computeLineDistances();
      orbitLine.name = 'MoonOrbitalArc';
      orbitLine.renderOrder = 2;
      this.group.add(orbitLine);
      this._lineMaterials.push(orbitMat);
      this._disposables.push(orbitGeom, orbitMat);
    }

    // 1. Phase-colored Line2 trajectory curves (dashed across the compressed cislunar transfer bridge, solid near Earth & Moon)
    for (const seg of segments) {
      if (!seg.points || seg.points.length < 6) continue;
      const phaseStyle = TRAJECTORY_CONFIG.PHASES[seg.phase] || {
        color: 0x34d399,
        lineWidth: 2.6,
        opacity: 0.92,
      };

      const geom = new LineGeometry();
      geom.setPositions(Array.from(seg.points));

      const isDashed = Boolean(seg.isCompressed);
      const mat = new LineMaterial({
        color: phaseStyle.color,
        linewidth: phaseStyle.lineWidth,
        transparent: true,
        opacity: phaseStyle.opacity,
        dashed: isDashed,
        dashSize: isDashed ? TRAJECTORY_CONFIG.COMPRESSED_DASH_SIZE : 1,
        gapSize: isDashed ? TRAJECTORY_CONFIG.COMPRESSED_GAP_SIZE : 0,
        dashScale: 1,
        depthTest: true,
        depthWrite: false,
        resolution: this._resolution.clone(),
      });

      const line = new Line2(geom, mat);
      line.computeLineDistances();
      line.name = `TrajectoryPhase_${seg.phase}${isDashed ? '_compressed' : ''}`;
      line.renderOrder = 4;
      this.group.add(line);

      this._lineMaterials.push(mat);
      this._disposables.push(geom, mat);
    }

    // 2. Milestone event markers & floating labels
    const nodeGeo = new THREE.SphereGeometry(1, 14, 12);
    this._disposables.push(nodeGeo);
    const haloTex = createGlowTexture('#ffffff', '#38bdf8');
    if (haloTex) this._disposables.push(haloTex);

    for (const ev of events) {
      if (!ev.scenePos) continue;
      const phaseStyle = TRAJECTORY_CONFIG.PHASES[ev.phase] || {
        color: 0x38bdf8,
        css: '#38bdf8',
      };

      const markerMat = new THREE.MeshBasicMaterial({
        color: ev.isMajor ? 0xffffff : phaseStyle.color,
        transparent: true,
        opacity: ev.isMajor ? 0.98 : 0.78,
        depthTest: true,
      });
      this._disposables.push(markerMat);

      const marker = new THREE.Mesh(nodeGeo, markerMat);
      marker.position.set(ev.scenePos[0], ev.scenePos[1], ev.scenePos[2]);
      marker.userData = {
        baseRadius: ev.isMajor ? 0.062 : 0.036,
        isMajor: ev.isMajor,
        phase: ev.phase,
      };
      marker.renderOrder = 5;
      this.group.add(marker);
      this._eventMarkers.push(marker);

      if (ev.isMajor) {
        const displayTitle = EVENT_DISPLAY_LABELS[ev.name] || ev.name.toUpperCase();
        const subtitle = ev.deltaVKmS
          ? `Δv ${ev.deltaVKmS.toFixed(2)} km/s`
          : `T+${Math.round(ev.t_s)} s`;
        const badge = createBadgeSprite(displayTitle, subtitle, phaseStyle.css);
        if (badge) {
          // Offset label outward from nearest celestial body center at that instant to avoid overlaps
          if (Array.isArray(ev.moonCenterScene)) {
            evMoonCenter.set(ev.moonCenterScene[0], ev.moonCenterScene[1], ev.moonCenterScene[2]);
          } else {
            evMoonCenter.copy(defaultMoonCenter);
          }
          const distToMoon = marker.position.distanceTo(evMoonCenter);
          const distToEarth = marker.position.distanceTo(earthCenter);
          const anchorCenter = distToEarth < distToMoon ? earthCenter : evMoonCenter;
          const outward = marker.position.clone().sub(anchorCenter);
          if (outward.lengthSq() < 1e-6) outward.set(0, 1, 0);
          outward.normalize();

          const verticalSign = ev.name === 'doi' ? -0.64 : ev.name === 'loi' ? 0.64 : 0.4;
          const initialOffset = 0.55 * this._sceneScaleFactor;
          badge.sprite.userData = {
            anchorPos: marker.position.clone(),
            outward: outward.clone(),
            verticalSign,
          };
          badge.sprite.position
            .copy(marker.position)
            .addScaledVector(outward, initialOffset);
          badge.sprite.position.y += verticalSign * initialOffset;

          this.group.add(badge.sprite);
          this._eventSprites.push(badge.sprite);
          this._disposables.push(badge.texture, badge.material);
        }
      }
    }

    // 3. Spacecraft live marker
    this._createSpacecraftMarker(haloTex);

    const tMin = meta.tStart ?? 0;
    const tMax = meta.tEnd ?? meta.durationSec;
    this._currentTimeSec = preserveTime
      ? Math.max(tMin, Math.min(tMax, prevTime))
      : tMin;
    this._applySpacecraftPose();
  }

  _createSpacecraftMarker(glowTexture) {
    const scGroup = new THREE.Group();
    scGroup.name = 'SpacecraftMarker';
    scGroup.renderOrder = 7;

    const coneGeom = new THREE.ConeGeometry(0.085, 0.24, 12);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      depthTest: true,
    });
    const coneMesh = new THREE.Mesh(coneGeom, coneMat);
    scGroup.add(coneMesh);

    const engineGeom = new THREE.SphereGeometry(0.055, 12, 10);
    const engineMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      depthTest: true,
    });
    const engineMesh = new THREE.Mesh(engineGeom, engineMat);
    engineMesh.position.y = -0.11;
    scGroup.add(engineMesh);

    if (glowTexture) {
      const haloMat = new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xfef08a,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        opacity: 0.9,
      });
      const haloSprite = new THREE.Sprite(haloMat);
      haloSprite.scale.set(0.65, 0.65, 1);
      scGroup.add(haloSprite);
      this._spacecraftHalo = haloSprite;
      this._disposables.push(haloMat);
    }

    this._disposables.push(coneGeom, coneMat, engineGeom, engineMat);
    this.group.add(scGroup);
    this._spacecraftGroup = scGroup;
  }

  _applySpacecraftPose() {
    if (!this._generated || !this._spacecraftGroup) return null;
    const sample = TrajectoryGenerator.sampleSpacecraftAtTime(
      this._generated,
      this._currentTimeSec
    );
    if (!sample) return null;

    this._spacecraftGroup.position.set(sample.pos[0], sample.pos[1], sample.pos[2]);
    this._spacecraftDir.set(sample.dir[0], sample.dir[1], sample.dir[2]).normalize();
    this._spacecraftGroup.quaternion.setFromUnitVectors(this._spacecraftUp, this._spacecraftDir);

    if (this._onTelemetryTick) {
      this._onTelemetryTick(sample, this._generated.meta);
    }
    return sample;
  }

  _syncLineResolutions() {
    if (typeof window === 'undefined' || this._lineMaterials.length === 0) return;
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    if (this._resolution.x !== w || this._resolution.y !== h) {
      this._resolution.set(w, h);
      for (const mat of this._lineMaterials) {
        mat.resolution.set(w, h);
      }
    }
  }

  update(camera, elapsedSeconds = 0) {
    if (!this.group.visible || !this._generated) return;
    this._syncLineResolutions();

    // Advance playback along trajectory
    const nowMs = performance.now();
    if (this._isPlaying && this._lastUpdatePerfMs !== null) {
      const dtReal = Math.min(0.1, Math.max(0, (nowMs - this._lastUpdatePerfMs) * 0.001));
      const { tStart, tEnd, durationSec } = this._generated.meta;
      if (durationSec > 0 && dtReal > 0) {
        const simRate = durationSec / this._playbackDurationSec;
        this._currentTimeSec += dtReal * simRate;
        if (this._currentTimeSec > tEnd) {
          this._currentTimeSec = tStart + ((this._currentTimeSec - tStart) % durationSec);
        }
        this._applySpacecraftPose();
      }
    }
    this._lastUpdatePerfMs = nowMs;

    // Distance-adaptive sizing so markers & milestone labels stay readable across zoom levels
    if (camera) {
      camera.getWorldPosition(this._tmpCamPos);

      for (const marker of this._eventMarkers) {
        marker.getWorldPosition(this._tmpWorldPos);
        const camDist = this._tmpCamPos.distanceTo(this._tmpWorldPos);
        const base = marker.userData.baseRadius || 0.05;
        const scale = THREE.MathUtils.clamp(
          camDist * base * 0.042,
          base * 0.16,
          base * 1.9 * this._sceneScaleFactor
        );
        marker.scale.setScalar(scale);
      }

      for (const sprite of this._eventSprites) {
        const anchorPos = sprite.userData?.anchorPos;
        if (anchorPos && sprite.userData?.outward) {
          this._tmpWorldPos.copy(anchorPos);
          this.group.localToWorld(this._tmpWorldPos);
          const anchorCamDist = this._tmpCamPos.distanceTo(this._tmpWorldPos);
          const offset = THREE.MathUtils.clamp(
            anchorCamDist * 0.022,
            0.28,
            0.55 * this._sceneScaleFactor
          );
          sprite.position.copy(anchorPos).addScaledVector(sprite.userData.outward, offset);
          sprite.position.y += (sprite.userData.verticalSign || 0) * offset;
        }
        sprite.getWorldPosition(this._tmpWorldPos);
        const camDist = this._tmpCamPos.distanceTo(this._tmpWorldPos);
        const h = THREE.MathUtils.clamp(camDist * 0.032, 0.06, 0.92 * this._sceneScaleFactor);
        sprite.scale.set(h * (320 / 96), h, 1);
      }

      if (this._spacecraftGroup) {
        this._spacecraftGroup.getWorldPosition(this._tmpWorldPos);
        const camDist = this._tmpCamPos.distanceTo(this._tmpWorldPos);
        const scScale = THREE.MathUtils.clamp(camDist * 0.04, 0.08, 1.5 * this._sceneScaleFactor);
        this._spacecraftGroup.scale.setScalar(scScale);
      }
    }

    if (this._spacecraftHalo) {
      const pulse = 0.58 + 0.14 * Math.sin(elapsedSeconds * 5.2);
      this._spacecraftHalo.scale.set(pulse, pulse, 1);
    }
  }
}
