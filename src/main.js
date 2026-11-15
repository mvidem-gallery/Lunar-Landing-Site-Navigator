import * as THREE from 'three';
import { SceneManager } from './core/sceneManager.js';
import { MoonBuilder } from './core/moonBuilder.js';
import { LightingSystem } from './core/lightingSystem.js';
import { CelestialEnvironment } from './core/celestialEnvironment.js';
import { VisualOverlayManager } from './core/visualOverlayManager.js';
import { HorizonsClient } from './astronomy/horizonsClient.js';
import { SolarMath } from './astronomy/solarMath.js';
import { RaycastController } from './interaction/raycastController.js';
import { UIController } from './interaction/uiController.js';
import { SurfaceContextMenu } from './interaction/surfaceContextMenu.js';
import { CelestialTooltip } from './interaction/celestialTooltip.js';
import { RulerTool } from './interaction/rulerTool.js';
import { LandingSitesMenu } from './interaction/landingSitesMenu.js';
import { MissionPanel } from './interaction/missionPanel.js';
import { TimelineController } from './interaction/timelineController.js';
import { LunarHorizonModal } from './lunar-horizon/lunarHorizonModal.js';
import { MAP_LAYERS, TRAJECTORY_CONFIG, VIEW_MODES } from './config/constants.js';

async function bootstrap() {
  const statusEl = document.getElementById('solar-status');
  try {
    const container = document.getElementById('canvas-container');
    const sceneManager = new SceneManager(container);
    const lightingSystem = new LightingSystem(sceneManager.scene);
    const celestialEnv = new CelestialEnvironment(sceneManager.scene);
    celestialEnv.setTrajectoryPlaying(false);
    const uiController = new UIController();

    const fontsReady =
      document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();

    const [moonGroup] = await Promise.all([
      MoonBuilder.build(),
      celestialEnv.init(),
      fontsReady,
    ]);
    sceneManager.scene.add(moonGroup);
    celestialEnv.setMoonGroup(moonGroup);

    const { baseMesh, uniforms, lodManager } = moonGroup.userData || {};
    const overlayManager = new VisualOverlayManager(uniforms, lightingSystem, moonGroup);

    let latestHoverData = null;
    let latestEphemData = null;
    let latestTimelineEphemData = null;
    let latestPhysicalState = null;
    let currentSimulationDate = new Date();
    const currentSunDir = new THREE.Vector3(1, 0, 0);
    const currentEarthDir = new THREE.Vector3(1, 0, 0);
    const tmpEarthPos = new THREE.Vector3();
    const tmpMoonPos = new THREE.Vector3();
    let lastTrajectoryHudSyncMs = 0;

    let timelineController = null;
    let savedLunarTimelineState = null;
    let trajectoryPlaybackActive = true;
    let trajectorySpeedLabel = '3h/s';
    let trajectorySpanMs = null;

    function isTrajectoryTimelineActive() {
      return celestialEnv.viewMode === VIEW_MODES.CISLUNAR && Boolean(celestialEnv.getTrajectoryInfo());
    }

    function setTrajectoryTimeFromDate(date) {
      const info = celestialEnv.getTrajectoryInfo();
      if (!info || !(date instanceof Date)) return;
      const startMs = info.meta.launchTimestampMs ?? currentSimulationDate.getTime();
      const t_s = (date.getTime() - startMs) / 1000;
      celestialEnv.setTrajectoryTime(t_s);
    }

    function syncTimelineWithMode(mode, { resetToStart = false } = {}) {
      if (!timelineController) return;
      const info = celestialEnv.getTrajectoryInfo();
      if (mode === VIEW_MODES.CISLUNAR && info) {
        if (!savedLunarTimelineState) {
          savedLunarTimelineState = {
            date: new Date(timelineController.currentDate.getTime()),
            spanMs: timelineController.spanMs,
            speedIndex: timelineController.speedIndex,
            isPlaying: timelineController.isPlaying,
          };
        }
        const startMs = info.meta.launchTimestampMs ?? currentSimulationDate.getTime();
        const durationMs = Math.max(0, (info.meta.durationSec ?? 0) * 1000);
        const endMs = startMs + durationMs;
        const phases = (info.segments || []).map((seg) => ({
          startMs: startMs + seg.tStart * 1000,
          endMs: startMs + seg.tEnd * 1000,
          phase: seg.phase,
          isCompressed: Boolean(seg.isCompressed),
          colorCss: TRAJECTORY_CONFIG.PHASES[seg.phase]?.css || '#34d399',
        }));
        const events = (info.events || [])
          .filter((ev) => ev.isMajor)
          .map((ev) => ({
            name: ev.name,
            ms: startMs + ev.t_s * 1000,
            colorCss: TRAJECTORY_CONFIG.PHASES[ev.phase]?.css || '#38bdf8',
          }));

        timelineController.setTrajectoryWindow({ startMs, endMs, phases, events });
        const targetSpanMs =
          trajectorySpanMs ??
          Math.max(
            4 * 3600 * 1000,
            Math.min(timelineController.maxSpanMs, durationMs > 0 ? durationMs * 1.25 : 3 * 86400 * 1000)
          );
        timelineController.setSpanMs(targetSpanMs);
        timelineController.setSpeedByLabel(trajectorySpeedLabel);

        const tSec = resetToStart ? (info.meta.tStart ?? 0) : (info.currentTimeSec ?? 0);
        timelineController.setDate(new Date(startMs + tSec * 1000), false);
        if (trajectoryPlaybackActive) {
          timelineController.play();
        } else {
          timelineController.pause();
        }
        uiController.setTrajectoryPlayingUI(timelineController.isPlaying);
      } else {
        if (savedLunarTimelineState) {
          trajectoryPlaybackActive = timelineController.isPlaying;
          trajectorySpeedLabel = timelineController.getSpeedLabel();
          trajectorySpanMs = timelineController.spanMs;
          timelineController.pause();
          timelineController.setTrajectoryWindow(null);
          timelineController.setSpanMs(savedLunarTimelineState.spanMs);
          timelineController.setSpeedIndex(savedLunarTimelineState.speedIndex);
          timelineController.setDate(savedLunarTimelineState.date, false);
          if (savedLunarTimelineState.isPlaying) {
            timelineController.play();
          }
          savedLunarTimelineState = null;
        } else {
          timelineController.setTrajectoryWindow(null);
        }
      }
    }

    celestialEnv.onTrajectoryLoaded((info) => {
      uiController.updateTrajectoryInfo(info);
      if (celestialEnv.viewMode === VIEW_MODES.CISLUNAR) {
        trajectorySpanMs = null;
        syncTimelineWithMode(VIEW_MODES.CISLUNAR, { resetToStart: true });
      }
    });
    celestialEnv.onTrajectoryTelemetryTick((sample) => {
      uiController.updateTrajectoryTelemetry(sample);
    });

    uiController.onTrajectoryToggle((visible) => {
      celestialEnv.setTrajectoryVisible(visible);
    });
    uiController.onTrajectoryPlayPause((playing) => {
      trajectoryPlaybackActive = playing;
      if (isTrajectoryTimelineActive() && timelineController) {
        if (playing) timelineController.play();
        else timelineController.pause();
      } else {
        celestialEnv.setTrajectoryPlaying(playing);
      }
    });
    uiController.onTrajectoryScrub((progress) => {
      const info = celestialEnv.getTrajectoryInfo();
      if (!info) return;
      const tStart = info.meta.tStart ?? 0;
      const duration = info.meta.durationSec ?? 0;
      if (isTrajectoryTimelineActive() && timelineController) {
        const startMs = info.meta.launchTimestampMs ?? currentSimulationDate.getTime();
        timelineController.setDate(new Date(startMs + (tStart + duration * progress) * 1000), false);
      } else {
        celestialEnv.setTrajectoryTime(tStart + duration * progress);
      }
    });
    uiController.onTrajectoryFileLoad((jsonDoc) => {
      celestialEnv.setTrajectoryDocument(jsonDoc);
    });

    function setViewMode(mode, options = {}) {
      const normalized =
        mode === VIEW_MODES.CISLUNAR || mode === 'CISLUNAR_VIEW'
          ? VIEW_MODES.CISLUNAR
          : VIEW_MODES.LUNAR;
      celestialEnv.setViewMode(normalized);
      if (lodManager) {
        lodManager.setViewMode(normalized);
      }
      syncTimelineWithMode(normalized);
      if (normalized === VIEW_MODES.LUNAR && latestTimelineEphemData) {
        applyEphemerisToScene(latestTimelineEphemData, currentSimulationDate);
      }
      sceneManager.setViewMode(normalized, options);
      uiController.setViewModeUI(normalized);
    }

    sceneManager.onViewModeChange((mode) => {
      celestialEnv.setViewMode(mode);
      if (lodManager) {
        lodManager.setViewMode(mode);
      }
      syncTimelineWithMode(mode);
      if (mode === VIEW_MODES.LUNAR && latestTimelineEphemData) {
        applyEphemerisToScene(latestTimelineEphemData, currentSimulationDate);
      }
      uiController.setViewModeUI(mode);
    });

    uiController.onViewModeChange((mode) => {
      setViewMode(mode);
    });

    uiController.onCislunarFocusChange((focus) => {
      if (sceneManager.viewMode !== VIEW_MODES.CISLUNAR) {
        setViewMode(VIEW_MODES.CISLUNAR, { focus });
      } else {
        sceneManager.setCislunarFocus(focus, { animate: true });
      }
    });

    sceneManager.onCislunarFocusChange((focus) => {
      uiController.setCislunarFocusUI(focus);
    });

    const celestialTooltip = new CelestialTooltip();
    const lunarHorizonModal = new LunarHorizonModal();
    if (!window.SurfaceRendererBridge) {
      window.SurfaceRendererBridge = lunarHorizonModal;
    }

    let missionPanel = null;

    const rulerTool = new RulerTool({
      scene: moonGroup,
      camera: sceneManager.camera,
      domElement: container,
      toggleButton: document.getElementById('ruler-toggle-btn'),
      onSaveToMission: (snapshot) => {
        if (missionPanel && snapshot) {
          missionPanel.saveRulerMeasurement(snapshot);
          uiController.setLeftCollapsed(false);
          uiController.setLeftTab('missions');
        }
      },
      onStateChange: ({ isActive, canSave }) => {
        uiController.setRulerActiveUI(isActive);
        if (missionPanel) {
          missionPanel.setSaveRulerEnabled(canSave);
        }
      },
    });

    // Друга кнопка лінійки на лівій рейці
    uiController.railRulerBtn?.addEventListener('click', () => {
      rulerTool.toggle();
    });

    missionPanel = new MissionPanel({
      container: document.getElementById('mission-panel-slot'),
      scene: moonGroup,
      camera: sceneManager.camera,
      onFlyTo: (lat, lon, zoom) => {
        sceneManager.flyToCoordinates(lat, lon, zoom);
      },
      onOpenRuler: () => {
        rulerTool.setActive(true);
      },
      getRulerSnapshot: () => rulerTool.getSnapshot(),
      onLoadRulerSnapshot: (measurement) => {
        rulerTool.loadSnapshot(measurement);
        if (measurement?.points?.length > 0) {
          const mid = measurement.points[Math.floor(measurement.points.length / 2)];
          sceneManager.flyToCoordinates(mid.lat, mid.lon, 28);
        }
      },
      onOpenCatalog: () => {
        uiController.setLeftCollapsed(false);
        uiController.setLeftTab('sites');
      },
      onActiveMissionChange: (mission) => {
        uiController.updateMissionSummary(mission);
      },
    });

    const landingSitesMenu = new LandingSitesMenu({
      scene: moonGroup,
      camera: sceneManager.camera,
      mountContainer: document.getElementById('sites-drawer-slot'),
      onFlyToSite: (site) => {
        const targetZoom = site.status === 'planned' ? 45 : 70;
        sceneManager.flyToCoordinates(site.lat, site.lon, targetZoom);
      },
      onAddToMission: (site) => {
        missionPanel.addPointToActiveMission({
          name: site.name,
          lat: site.lat,
          lon: site.lon,
          note: site.region || site.description || '',
        });
        uiController.setLeftCollapsed(false);
        uiController.setLeftTab('missions');
      },
      onRequestOpenTab: () => {
        uiController.setLeftCollapsed(false);
        uiController.setLeftTab('sites');
      },
    });

    uiController.setSearchProvider(() => {
      const mission = missionPanel.getActiveMission();
      const missionPts = (mission?.points || []).map((p) => ({
        name: `[Mission] ${p.name}`,
        lat: p.lat,
        lon: p.lon,
        region: p.note,
      }));
      return [...missionPts, ...landingSitesMenu.getAllSites()];
    });

    uiController.onFlyToSearch((lat, lon, zoom) => {
      sceneManager.flyToCoordinates(lat, lon, zoom);
    });

    uiController.onHomeClick(() => {
      sceneManager.resetView();
    });

    const raycastController = new RaycastController(
      sceneManager.scene,
      sceneManager.camera,
      baseMesh,
      lightingSystem,
      (hoverData) => {
        latestHoverData = hoverData;
        uiController.updateCursorTelemetry(hoverData);
      }
    );

    if (typeof raycastController.setCelestialTargets === 'function') {
      raycastController.setCelestialTargets(
        celestialEnv.getInteractiveTargets(),
        (hoverBody) => {
          celestialTooltip.update(
            hoverBody ? { ...hoverBody, ephemData: latestEphemData } : null
          );
        }
      );
    }

    container.addEventListener('dblclick', (e) => {
      const hitBody = raycastController.getBodyAtClientPos(e.clientX, e.clientY);
      if (!hitBody) return;
      if (hitBody === 'EARTH') {
        if (sceneManager.viewMode !== VIEW_MODES.CISLUNAR) {
          setViewMode(VIEW_MODES.CISLUNAR, { focus: 'EARTH' });
        } else {
          sceneManager.setCislunarFocus('EARTH', { animate: true });
        }
      } else if (hitBody === 'MOON' && sceneManager.viewMode === VIEW_MODES.CISLUNAR) {
        sceneManager.setCislunarFocus('MOON', { animate: true });
      }
    });

    celestialEnv.onPhysicalStateChange((phys) => {
      latestPhysicalState = phys;
      currentSunDir.set(phys.sunDirScene[0], phys.sunDirScene[1], phys.sunDirScene[2]).normalize();
      currentEarthDir
        .set(phys.earthDirFromMoonWorld[0], phys.earthDirFromMoonWorld[1], phys.earthDirFromMoonWorld[2])
        .normalize();

      lightingSystem.sunVector.copy(currentSunDir);
      lightingSystem.sunLight.position.copy(currentSunDir).multiplyScalar(50);

      if (uniforms && uniforms.uSunDirection) {
        uniforms.uSunDirection.value.copy(currentSunDir);
      }
      if (uniforms && uniforms.uEarthDirection) {
        uniforms.uEarthDirection.value.copy(currentEarthDir);
      }
      raycastController.setEarthDirection(currentEarthDir);

      tmpEarthPos.set(phys.earthPositionScene[0], phys.earthPositionScene[1], phys.earthPositionScene[2]);
      tmpMoonPos.set(phys.moonPositionScene[0], phys.moonPositionScene[1], phys.moonPositionScene[2]);
      sceneManager.setCislunarBodyPositions(tmpEarthPos, tmpMoonPos);

      const trajEphem = {
        source: 'Trajectory DE440 / ITRF93',
        subSolarLat: phys.subSolarLatDeg,
        subSolarLon: phys.subSolarLonDeg,
        subEarthLat: phys.subEarthLatDeg,
        subEarthLon: phys.subEarthLonDeg,
        earthDistanceKm: phys.moonOrbitRadiusKm,
      };
      latestEphemData = trajEphem;
      const nowMs = performance.now();
      if (nowMs - lastTrajectoryHudSyncMs >= 120) {
        lastTrajectoryHudSyncMs = nowMs;
        uiController.updateSolarInfo(trajEphem);
      }
    });

    celestialEnv
      .loadTrajectory(TRAJECTORY_CONFIG.DEFAULT_URL)
      .catch((err) => {
        console.warn('Default cislunar trajectory preload skipped:', err?.message || err);
        uiController.setTrajectoryError('Trajectory not loaded — use "Load JSON"');
      });

    new SurfaceContextMenu(container, {
      getHoveredCoords: () => latestHoverData,
      getCurrentDate: () =>
        celestialEnv.viewMode === VIEW_MODES.CISLUNAR && latestPhysicalState?.utcTimestampMs
          ? new Date(latestPhysicalState.utcTimestampMs)
          : currentSimulationDate,
      getSunDirection: () => currentSunDir,
      getEarthDirection: () => currentEarthDir,
      getMoonQuaternion: () => moonGroup.quaternion,
      getViewMode: () => sceneManager.viewMode,
      getRightClickTarget: (clientX, clientY) => raycastController.getBodyAtClientPos(clientX, clientY),
      onFocusBody: (focus) => {
        if (sceneManager.viewMode !== VIEW_MODES.CISLUNAR) {
          setViewMode(VIEW_MODES.CISLUNAR, { focus });
        } else {
          sceneManager.setCislunarFocus(focus, { animate: true });
        }
      },
      onAddToMission: (targetData) => {
        missionPanel.addPointToActiveMission({
          name: `Point ${targetData.lat.toFixed(2)}°, ${targetData.lon.toFixed(2)}°`,
          lat: targetData.lat,
          lon: targetData.lon,
          note: `Sun: ${targetData.sunElevDeg >= 0 ? '+' : ''}${targetData.sunElevDeg.toFixed(1)}°`,
        });
        uiController.setLeftCollapsed(false);
        uiController.setLeftTab('missions');
      },
      onSaveLandingSite: (targetData) => {
        landingSitesMenu.promptAndSaveTarget(targetData);
      },
      onLandTo: (targetData) => {
        if (sceneManager.viewMode === VIEW_MODES.CISLUNAR) return;
        window.dispatchEvent(
          new CustomEvent('lunar:land-to', {
            detail: targetData,
          })
        );

        if (window.SurfaceRendererBridge && typeof window.SurfaceRendererBridge.open === 'function') {
          window.SurfaceRendererBridge.open(targetData);
        } else {
          lunarHorizonModal.open(targetData);
        }
      },
    });

    uiController.onLayerChange((layerId) => {
      if (lodManager) {
        lodManager.switchMapLayer(layerId);
      }

      const selectedLayer = MAP_LAYERS[layerId];
      if (selectedLayer && selectedLayer.targetCoords) {
        const { lat, lon, zoom } = selectedLayer.targetCoords;
        sceneManager.flyToCoordinates(lat, lon, zoom);
      }
    });

    uiController.onToggleEarthDisk((isVisible) => {
      overlayManager.setEarthDiskVisible(isVisible);
    });

    uiController.onToggleSolarLighting((isSolarEnabled) => {
      overlayManager.setSolarLightingEnabled(isSolarEnabled);
    });

    uiController.onToggleIlluminationHeatmap((isHeatmapVisible) => {
      overlayManager.setIlluminationHeatmapVisible(isHeatmapVisible);
    });

    uiController.onToggleCoordGrid((isGridVisible) => {
      overlayManager.setCoordGridVisible(isGridVisible);
    });

    function applyEphemerisToScene(ephemData, date) {
      latestTimelineEphemData = ephemData;
      if (celestialEnv.viewMode === VIEW_MODES.CISLUNAR && celestialEnv.getTrajectoryInfo()) {
        return;
      }
      latestEphemData = ephemData;
      lightingSystem.updateSunPosition(ephemData.subSolarLon, ephemData.subSolarLat);
      celestialEnv.updatePositions(ephemData, date);

      currentSunDir
        .copy(SolarMath.subSolarToVector3(ephemData.subSolarLon, ephemData.subSolarLat, 1.0))
        .normalize();

      currentEarthDir
        .copy(SolarMath.subSolarToVector3(ephemData.subEarthLon, ephemData.subEarthLat, 1.0))
        .normalize();

      if (uniforms && uniforms.uSunDirection) {
        uniforms.uSunDirection.value.copy(currentSunDir);
      }
      if (uniforms && uniforms.uEarthDirection) {
        uniforms.uEarthDirection.value.copy(currentEarthDir);
      }
      raycastController.setEarthDirection(currentEarthDir);
      sceneManager.setEarthDirection(currentEarthDir);
      uiController.updateSolarInfo(ephemData);
    }

    function previewSimulationTime(date) {
      if (isTrajectoryTimelineActive()) {
        setTrajectoryTimeFromDate(date);
        return;
      }
      currentSimulationDate = date;
      const analytical = HorizonsClient.calculateAnalyticalFallback(date);
      applyEphemerisToScene(
        { ...analytical, source: 'Quick Ephemeris (Scrub)' },
        date
      );
    }

    let activeCommitSeq = 0;
    async function commitSimulationTime(date) {
      if (isTrajectoryTimelineActive()) {
        setTrajectoryTimeFromDate(date);
        return;
      }
      currentSimulationDate = date;
      const seq = ++activeCommitSeq;
      uiController.setLoading(true);
      const ephemData = await HorizonsClient.fetchEphemerisData(date);
      if (seq !== activeCommitSeq) return;
      applyEphemerisToScene(ephemData, date);
      uiController.setLoading(false);
    }

    timelineController = new TimelineController({
      container: document.getElementById('timeline-mount'),
      initialDate: currentSimulationDate,
      onDatePreview: previewSimulationTime,
      onDateCommit: commitSimulationTime,
      onPlayStateChange: (playing) => {
        if (isTrajectoryTimelineActive()) {
          trajectoryPlaybackActive = playing;
          uiController.setTrajectoryPlayingUI(playing);
        }
      },
    });

    sceneManager.startRenderLoop((camera, cameraTelemetry) => {
      const elapsedSeconds = performance.now() * 0.001;
      celestialEnv.update(camera, elapsedSeconds);
      rulerTool.update(camera);
      landingSitesMenu.update(camera);
      missionPanel.update(camera);
      raycastController.update();
      uiController.updateCompass(camera, currentSunDir);

      const altitudeUnits = Math.max(0.00002, camera.position.distanceTo(moonGroup.position) - 1.0);
      overlayManager.updateAdaptiveGrid(altitudeUnits);

      const actualMaxZoom = lodManager ? lodManager.update(camera) : 2;
      overlayManager.updateGridLabels(camera, lodManager);
      const pendingCount = lodManager ? lodManager.cache.pendingCount : 0;

      uiController.updateCameraZoom({
        ...cameraTelemetry,
        estimatedLod:
          pendingCount > 0 ? `${actualMaxZoom} (loading: ${pendingCount})` : `${actualMaxZoom}`,
      });
    });

    await commitSimulationTime(currentSimulationDate);
  } catch (err) {
    console.error('Failed to launch 3D scene:', err);
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = '#ff6b6b';
    }
  }
}

bootstrap();
