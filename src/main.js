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
      onLandTo: (targetData) => {
        window.dispatchEvent(
          new CustomEvent('lunar:land-to', {
            detail: targetData,
          })
        );

        if (window.SurfaceRendererBridge && typeof window.SurfaceRendererBridge.open === 'function') {
          window.SurfaceRendererBridge.open(targetData);
        } else {
          console.log('[Land to] Передача параметрів у зовнішній модуль:', targetData);
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

    if (typeof uiController.onToggleIlluminationHeatmap === 'function') {
      uiController.onToggleIlluminationHeatmap((isHeatmapVisible) => {
        overlayManager.setIlluminationHeatmapVisible(isHeatmapVisible);
      });
    }

    if (typeof uiController.onToggleCoordGrid === 'function') {
      uiController.onToggleCoordGrid((isGridVisible) => {
        overlayManager.setCoordGridVisible(isGridVisible);
      });
    }

    async function updateSimulationTime(date) {
      currentSimulationDate = date;
      uiController.setLoading(true);
      const ephemData = await HorizonsClient.fetchEphemerisData(date);
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
      uiController.setLoading(false);
    }

    uiController.onDateChange((newDate) => updateSimulationTime(newDate));

    sceneManager.startRenderLoop((camera, cameraTelemetry) => {
      const elapsedSeconds = performance.now() * 0.001;
      celestialEnv.update(camera, elapsedSeconds);
      raycastController.update();

      const altitudeUnits = Math.max(0.001, camera.position.length() - 1.0);
      overlayManager.updateAdaptiveGrid(altitudeUnits);
      overlayManager.updateGridLabels(camera);

      const actualMaxZoom = lodManager ? lodManager.update(camera) : 2;
      const pendingCount = lodManager
        ? lodManager.cache.queue.length + lodManager.cache.activeRequests
        : 0;

      uiController.updateCameraZoom({
        ...cameraTelemetry,
        estimatedLod:
          pendingCount > 0 ? `${actualMaxZoom} (завант: ${pendingCount})` : `${actualMaxZoom}`,
      });
    });

    await updateSimulationTime(currentSimulationDate);
  } catch (err) {
    console.error('Помилка запуску 3D-сцени:', err);
    if (statusEl) {
      statusEl.textContent = `Помилка: ${err.message}`;
      statusEl.style.color = '#ff6b6b';
    }
  }
}

bootstrap();