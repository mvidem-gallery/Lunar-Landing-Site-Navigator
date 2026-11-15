import { LOD_CONFIG, MAP_LAYERS, MOON_CONFIG } from '../config/constants.js';

export class UIController {
  constructor() {
    this.datePicker = document.getElementById('date-picker');
    this.nowBtn = document.getElementById('now-btn');
    this.layerSelector = document.getElementById('layer-selector');
    this.toggleEarthDisk = document.getElementById('toggle-earth-disk');
    this.toggleSolarLighting = document.getElementById('toggle-solar-lighting');
    this.cameraStatus = document.getElementById('camera-status');
    this.solarStatus = document.getElementById('solar-status');
    this.telemetryContent = document.getElementById('telemetry-content');
    this.scaleLabel = document.getElementById('scale-label');
    this.scaleLine = document.getElementById('scale-line');

    this.dateChangeCallback = null;
    this.layerChangeCallback = null;
    this.diskToggleCallback = null;
    this.lightingToggleCallback = null;
    this.setPickerToDate(new Date());

    this.datePicker.addEventListener('change', () => {
      if (this.datePicker.value && this.dateChangeCallback) {
        const utcDate = new Date(this.datePicker.value + 'Z');
        this.dateChangeCallback(utcDate);
      }
    });

    this.nowBtn.addEventListener('click', () => {
      const now = new Date();
      this.setPickerToDate(now);
      if (this.dateChangeCallback) this.dateChangeCallback(now);
    });

    this.layerSelector.addEventListener('change', (e) => {
      if (this.layerChangeCallback) {
        this.layerChangeCallback(e.target.value);
      }
    });

    this.toggleEarthDisk.addEventListener('change', (e) => {
      if (this.diskToggleCallback) {
        this.diskToggleCallback(e.target.checked);
      }
    });

    this.toggleSolarLighting.addEventListener('change', (e) => {
      if (this.lightingToggleCallback) {
        this.lightingToggleCallback(e.target.checked);
      }
    });

    if (this.layerSelector) {
      this.layerSelector.value = LOD_CONFIG.DEFAULT_LAYER;
    }
  }

  setPickerToDate(date) {
    this.datePicker.value = date.toISOString().slice(0, 16);
  }

  onDateChange(callback) {
    this.dateChangeCallback = callback;
  }

  onLayerChange(callback) {
    this.layerChangeCallback = callback;
  }

  onToggleEarthDisk(callback) {
    this.diskToggleCallback = callback;
  }

  onToggleSolarLighting(callback) {
    this.lightingToggleCallback = callback;
  }

  onToggleIlluminationHeatmap(callback) {
    const checkbox = document.getElementById('toggle-illumination-heatmap');
    const legend = document.getElementById('heatmap-legend');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        if (legend) {
          legend.style.display = e.target.checked ? 'block' : 'none';
        }
        callback(e.target.checked);
      });
    }
  }

  onToggleCoordGrid(callback) {
    const checkbox = document.getElementById('toggle-coord-grid');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        callback(e.target.checked);
      });
    }
  }

  setLoading(isLoading) {
    if (isLoading) {
      this.solarStatus.innerHTML = 'Запит ефемерид JPL Horizons...';
    }
  }

  _calculateTileResolutionMetersPerPixel(estimatedLod) {
    const zoomLevel = Number.parseInt(String(estimatedLod), 10);
    const z = Number.isFinite(zoomLevel) ? zoomLevel : LOD_CONFIG.MIN_ZOOM;

    const currentLayerId = this.layerSelector ? this.layerSelector.value : LOD_CONFIG.DEFAULT_LAYER;
    const layer = MAP_LAYERS[currentLayerId];

    // Перевіряємо, чи належить поточний рівень тайлу до WebMercator (2^z стовпців) або Plate Carrée (2^(z+1) стовпців)
    let isWebMercator = Boolean(layer && layer.isWebMercatorQuad);
    if (layer && Array.isArray(layer.overlays)) {
      const baseMax = layer.baseMaxZoom ?? layer.maxZoom ?? 8;
      if (z > baseMax) {
        const activeOverlay = layer.overlays.find(
          (ov) => z >= (ov.minZoom ?? baseMax + 1) && z <= (ov.maxZoom ?? layer.maxZoom)
        );
        if (activeOverlay) {
          isWebMercator = Boolean(activeOverlay.isWebMercatorQuad);
        }
      }
    }

    const cols = isWebMercator ? Math.pow(2, z) : Math.pow(2, z + 1);
    const circumferenceMeters = 2 * Math.PI * MOON_CONFIG.RADIUS_METERS;
    const metersPerPixel = circumferenceMeters / (cols * LOD_CONFIG.TILE_SIZE_PX);

    if (metersPerPixel >= 100) {
      return `${Math.round(metersPerPixel)} м/піксель`;
    }
    if (metersPerPixel >= 10) {
      return `${metersPerPixel.toFixed(1)} м/піксель`;
    }
    return `${metersPerPixel.toFixed(2)} м/піксель`;
  }

  updateCameraZoom({ zoomFactor, altitudeKm, kmPerPixel, estimatedLod }) {
    const formattedZoom = zoomFactor >= 10
      ? `${zoomFactor.toFixed(1)}×`
      : `${zoomFactor.toFixed(2)}×`;

    const formattedAlt = altitudeKm >= 100
      ? `${Math.round(altitudeKm)} км`
      : `${altitudeKm.toFixed(1)} км`;

    const resolutionText = this._calculateTileResolutionMetersPerPixel(estimatedLod);

    this.cameraStatus.innerHTML = `
      <div class="data-row"><span>Масштаб (Zoom):</span> <span class="data-val" style="color:#ffd54f">${formattedZoom}</span></div>
      <div class="data-row"><span>Висота орбіти:</span> <span class="data-val">${formattedAlt}</span></div>
      <div class="data-row"><span>Рівень тайлів (LOD):</span> <span class="data-val">Z${estimatedLod}</span></div>
      <div class="data-row"><span>Роздільна здатність:</span> <span class="data-val" style="color:#80deea">${resolutionText}</span></div>
    `;

    if (kmPerPixel && this.scaleLabel && this.scaleLine) {
      this.updateScaleBar(kmPerPixel);
    }
  }

  updateScaleBar(kmPerPixel) {
    const targetWidthPx = 130;
    const rawKm = kmPerPixel * targetWidthPx;

    const magnitude = Math.pow(10, Math.floor(Math.log10(rawKm)));
    const residual = rawKm / magnitude;

    let niceMultiplier = 1;
    if (residual >= 5) {
      niceMultiplier = 5;
    } else if (residual >= 2) {
      niceMultiplier = 2;
    }

    const niceKm = niceMultiplier * magnitude;
    const actualWidthPx = Math.round(niceKm / kmPerPixel);

    this.scaleLine.style.width = `${actualWidthPx}px`;

    if (niceKm >= 1) {
      this.scaleLabel.textContent = `${niceKm >= 10 ? Math.round(niceKm) : niceKm.toFixed(1)} км`;
    } else {
      this.scaleLabel.textContent = `${Math.round(niceKm * 1000)} м`;
    }
  }

  updateSolarInfo(data) {
    const sLonDir = data.subSolarLon >= 0 ? 'E' : 'W';
    const sLatDir = data.subSolarLat >= 0 ? 'N' : 'S';
    const eLonDir = data.subEarthLon >= 0 ? 'E' : 'W';
    const eLatDir = data.subEarthLat >= 0 ? 'N' : 'S';

    this.solarStatus.innerHTML = `
      <div class="data-row"><span>Джерело:</span> <span class="data-val">${data.source}</span></div>
      <div class="data-row"><span>Субсонячна точка:</span> <span class="data-val">${Math.abs(data.subSolarLat).toFixed(2)}°${sLatDir}, ${Math.abs(data.subSolarLon).toFixed(2)}°${sLonDir}</span></div>
      <div class="data-row"><span>Центр диска (Земля):</span> <span class="data-val" style="color:#4fc3f7">${Math.abs(data.subEarthLat).toFixed(2)}°${eLatDir}, ${Math.abs(data.subEarthLon).toFixed(2)}°${eLonDir}</span></div>
    `;
  }

  updateCursorTelemetry(data) {
    if (!data) {
      this.telemetryContent.innerHTML = 'Наведіть курсор на поверхню Місяця';
      return;
    }

    const latDir = data.lat >= 0 ? 'N' : 'S';
    const lonDir = data.lon >= 0 ? 'E' : 'W';
    const statusText = data.isDaylight ? 'День (Освітлено)' : 'Ніч (За термінатором)';
    const visibilityText = data.isVisibleFromEarth ? 'Видима із Землі' : 'Зворотний бік (Невидима)';

    this.telemetryContent.innerHTML = `
      <div class="data-row"><span>Широта:</span> <span class="data-val">${Math.abs(data.lat).toFixed(4)}° ${latDir}</span></div>
      <div class="data-row"><span>Довгота:</span> <span class="data-val">${Math.abs(data.lon).toFixed(4)}° ${lonDir}</span></div>
      <div class="data-row"><span>Видимість:</span> <span class="data-val" style="color:${data.isVisibleFromEarth ? '#4fc3f7' : '#90a4ae'}">${visibilityText}</span></div>
      <div class="data-row"><span>Освітлення:</span> <span class="data-val">${statusText}</span></div>
      <div class="data-row"><span>Висота Сонця:</span> <span class="data-val">${data.solarElevationDeg.toFixed(2)}°</span></div>
      <div class="data-row"><span>Освітленість:</span> <span class="data-val">${data.illuminationPercent.toFixed(1)}%</span></div>
      <div class="data-row"><span>Інсоляція:</span> <span class="data-val">${data.irradianceWm2.toFixed(1)} Вт/м²</span></div>
    `;
  }
}
