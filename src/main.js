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
import { MAP_LAYERS } from './config/constants.js';

async function bootstrap() {
  const statusEl = document.getElementById('solar-status');
  try {
    const container = document.getElementById('canvas-container');
    const sceneManager = new SceneManager(container);
    const lightingSystem = new LightingSystem(sceneManager.scene);
    const celestialEnv = new CelestialEnvironment(sceneManager.scene);
    const uiController = new UIController();

    const fontsReady =
      document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();

    const [moonGroup] = await Promise.all([
      MoonBuilder.build(),
      celestialEnv.init(),
      fontsReady,
    ]);
    sceneManager.scene.add(moonGroup);

    const { baseMesh, uniforms, lodManager } = moonGroup.userData || {};
    const overlayManager = new VisualOverlayManager(uniforms, lightingSystem, moonGroup);

    let latestHoverData = null;
    let latestEphemData = null;
    let currentSimulationDate = new Date();
    const currentSunDir = new THREE.Vector3(1, 0, 0);
    const currentEarthDir = new THREE.Vector3(1, 0, 0);

    const celestialTooltip = new CelestialTooltip();

    let missionPanel = null;

    const rulerTool = new RulerTool({
      scene: sceneManager.scene,
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
      scene: sceneManager.scene,
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
      scene: sceneManager.scene,
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

    new SurfaceContextMenu(container, {
      getHoveredCoords: () => latestHoverData,
      getCurrentDate: () => currentSimulationDate,
      getSunDirection: () => currentSunDir,
      getEarthDirection: () => currentEarthDir,
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
        window.dispatchEvent(
          new CustomEvent('lunar:land-to', {
            detail: targetData,
          })
        );

        if (window.SurfaceRendererBridge && typeof window.SurfaceRendererBridge.open === 'function') {
          window.SurfaceRendererBridge.open(targetData);
        } else {
          console.log('[Land to] Forwarding parameters to external module:', targetData);
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
      uiController.updateSolarInfo(ephemData);
    }

    function previewSimulationTime(date) {
      currentSimulationDate = date;
      const analytical = HorizonsClient.calculateAnalyticalFallback(date);
      applyEphemerisToScene(
        { ...analytical, source: 'Quick Ephemeris (Scrub)' },
        date
      );
    }

    let activeCommitSeq = 0;
    async function commitSimulationTime(date) {
      currentSimulationDate = date;
      const seq = ++activeCommitSeq;
      uiController.setLoading(true);
      const ephemData = await HorizonsClient.fetchEphemerisData(date);
      if (seq !== activeCommitSeq) return;
      applyEphemerisToScene(ephemData, date);
      uiController.setLoading(false);
    }

    new TimelineController({
      container: document.getElementById('timeline-mount'),
      initialDate: currentSimulationDate,
      onDatePreview: previewSimulationTime,
      onDateCommit: commitSimulationTime,
    });

    sceneManager.startRenderLoop((camera, cameraTelemetry) => {
      const elapsedSeconds = performance.now() * 0.001;
      celestialEnv.update(camera, elapsedSeconds);
      rulerTool.update(camera);
      landingSitesMenu.update(camera);
      missionPanel.update(camera);
      raycastController.update();
      uiController.updateCompass(camera, currentSunDir);

      const altitudeUnits = Math.max(0.001, camera.position.length() - 1.0);
      overlayManager.updateAdaptiveGrid(altitudeUnits);
      overlayManager.updateGridLabels(camera);

      const actualMaxZoom = lodManager ? lodManager.update(camera) : 2;
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
