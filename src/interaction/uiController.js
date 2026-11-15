import * as THREE from 'three';
import {
  LOD_CONFIG,
  MAP_LAYERS,
  MOON_CONFIG,
  TRAJECTORY_CONFIG,
  VIEW_MODES,
} from '../config/constants.js';
import { formatMissionDuration } from '../astronomy/trajectoryGenerator.js';

const TAB_TITLES = {
  missions: { title: 'Mission', badge: 'MISSION' },
  sites: { title: 'Landing Sites', badge: 'CATALOG' },
  layers: { title: 'Map Layers', badge: 'LAYERS' },
};

const LAYER_DESCRIPTIONS = {
  LRO_WAC_LOCAL: {
    title: 'LRO WAC (Z2–Z8) + Kaguya TC (Z9–Z12)',
    desc: 'Local LRO WAC base tiles (up to 83 m/px) with automatic transition to Kaguya TC Ortho 4096ppd (NASA Moon Trek / USGS WMS) when zooming in.',
  },
  KAGUYA_TC_GLOBAL: {
    title: 'Kaguya TC Ortho 4096ppd (Z2–Z12)',
    desc: 'High-resolution global orthophoto mosaic from the SELENE/Kaguya Terrain Camera.',
  },
};

export class UIController {
  constructor() {
    this.leftDock = document.getElementById('left-dock');
    this.leftCollapseBtn = document.getElementById('left-collapse-btn');
    this.leftDrawerTitle = document.getElementById('left-drawer-title');
    this.leftDrawerBadge = document.getElementById('left-drawer-badge');
    this.railTabBtns = Array.from(document.querySelectorAll('[data-rail-tab]'));
    this.tabPanes = {
      missions: document.getElementById('tab-missions'),
      sites: document.getElementById('tab-sites'),
      layers: document.getElementById('tab-layers'),
    };

    this.topFloatingBar = document.getElementById('top-floating-bar');
    this.topMissionPill = document.getElementById('top-mission-pill');
    this.viewModeBtns = Array.from(document.querySelectorAll('[data-view-mode]'));
    this.focusTargetBtns = Array.from(document.querySelectorAll('[data-focus-target]'));
    this.bottomDock = document.getElementById('bottom-dock');

    // Панель прямої траєкторії (Cislunar View)
    this.trajSummaryEl = document.getElementById('traj-summary');
    this.trajTelemetryEl = document.getElementById('traj-telemetry-row');
    this.trajPhaseLegendEl = document.getElementById('traj-phase-legend');
    this.trajVisibilityBtn = document.getElementById('traj-visibility-btn');
    this.trajLoadBtn = document.getElementById('traj-load-btn');
    this.trajFileInput = document.getElementById('traj-file-input');
    this.trajPlayBtn = document.getElementById('traj-play-btn');
    this.trajScrubSlider = document.getElementById('traj-scrub-slider');
    this.trajTimeReadoutEl = document.getElementById('traj-time-readout');

    // Пошук
    this.searchInput = document.getElementById('global-search-input');
    this.searchClearBtn = document.getElementById('global-search-clear');
    this.searchResultsEl = document.getElementById('global-search-results');

    // Шари та оверлеї
    this.layerSelector = document.getElementById('layer-selector');
    this.activeLayerNameEl = document.getElementById('active-layer-name');
    this.activeLayerDescEl = document.getElementById('active-layer-desc');
    this.toggleEarthDisk = document.getElementById('toggle-earth-disk');
    this.toggleSolarLighting = document.getElementById('toggle-solar-lighting');
    this.toggleHeatmap = document.getElementById('toggle-illumination-heatmap');
    this.toggleCoordGrid = document.getElementById('toggle-coord-grid');
    this.heatmapLegend = document.getElementById('heatmap-legend');

    this.overlaysCollapseBtn = document.getElementById('overlays-collapse-btn');
    this.overlaysBody = document.getElementById('overlays-body');
    this.overlayChips = {
      grid: document.querySelector('[data-overlay-toggle="grid"]'),
      solar: document.querySelector('[data-overlay-toggle="solar"]'),
      heatmap: document.querySelector('[data-overlay-toggle="heatmap"]'),
      earth: document.querySelector('[data-overlay-toggle="earth"]'),
    };

    // Права панель та швидкі кнопки
    this.rightInfoToggleBtn = document.getElementById('right-info-toggle-btn');
    this.rightInfoCloseBtn = document.getElementById('right-info-close-btn');
    this.btsInfoBtn = document.getElementById('bts-info-btn');
    this.homeViewBtn = document.getElementById('home-view-btn');
    this.btsHomeBtn = document.getElementById('bts-home-btn');
    this.quickSolarBtn = document.getElementById('quick-solar-btn');
    this.btsSolarBtn = document.getElementById('bts-solar-btn');
    this.railRulerBtn = document.getElementById('rail-ruler-btn');
    this.rightRulerBtn = document.getElementById('ruler-toggle-btn');

    // Телеметрія (права панель + нижня стрічка)
    this.cameraStatus = document.getElementById('camera-status');
    this.solarStatus = document.getElementById('solar-status');
    this.telemetryContent = document.getElementById('telemetry-content');
    this.rightMissionSummary = document.getElementById('right-mission-summary');

    this.btsStatusIcon = document.getElementById('bts-status-icon');
    this.btsLat = document.getElementById('bts-lat');
    this.btsLon = document.getElementById('bts-lon');
    this.btsIllum = document.getElementById('bts-illum');
    this.btsRes = document.getElementById('bts-res');
    this.btsAlt = document.getElementById('bts-alt');

    this.scaleLabel = document.getElementById('scale-label');
    this.scaleLine = document.getElementById('scale-line');

    this.compassNeedleEl = document.getElementById('compass-needle');
    this.compassSunDotEl = document.getElementById('compass-sun-dot');

    this.layerChangeCallback = null;
    this.diskToggleCallback = null;
    this.lightingToggleCallback = null;
    this.heatmapToggleCallback = null;
    this.coordGridToggleCallback = null;
    this.homeCallback = null;
    this.flyToCallback = null;
    this.viewModeChangeCallback = null;
    this.cislunarFocusChangeCallback = null;
    this.searchProvider = null;

    this.trajectoryToggleCallback = null;
    this.trajectoryFileLoadCallback = null;
    this.trajectoryPlayPauseCallback = null;
    this.trajectoryScrubCallback = null;
    this._isTrajectoryPlaying = true;
    this._isTrajectoryVisible = true;
    this._isScrubbingTrajectory = false;

    this._isRightDrawerOpen = false;
    this._isLeftCollapsed = false;
    this._activeLeftTab = 'missions';
    this._camFwd = new THREE.Vector3();
    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._northTangent = new THREE.Vector3();

    this._bindEvents();
    this._syncLayerInfo(LOD_CONFIG.DEFAULT_LAYER);
  }

  _bindEvents() {
    this.viewModeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.viewMode === VIEW_MODES.CISLUNAR ? VIEW_MODES.CISLUNAR : VIEW_MODES.LUNAR;
        this.setViewModeUI(mode);
        this.viewModeChangeCallback?.(mode);
      });
    });

    this.focusTargetBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const focus = btn.dataset.focusTarget || 'SYSTEM';
        this.setCislunarFocusUI(focus);
        this.cislunarFocusChangeCallback?.(focus);
      });
    });

    this.trajVisibilityBtn?.addEventListener('click', () => {
      this._isTrajectoryVisible = !this._isTrajectoryVisible;
      this.trajVisibilityBtn.classList.toggle('active', this._isTrajectoryVisible);
      this.trajectoryToggleCallback?.(this._isTrajectoryVisible);
    });

    this.trajLoadBtn?.addEventListener('click', () => {
      this.trajFileInput?.click();
    });

    this.trajFileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const jsonDoc = JSON.parse(text);
        await this.trajectoryFileLoadCallback?.(jsonDoc, file.name);
      } catch (err) {
        this.setTrajectoryError(err?.message || 'Invalid trajectory JSON file');
      } finally {
        e.target.value = '';
      }
    });

    this.trajPlayBtn?.addEventListener('click', () => {
      this._isTrajectoryPlaying = !this._isTrajectoryPlaying;
      this._syncPlayButtonUI();
      this.trajectoryPlayPauseCallback?.(this._isTrajectoryPlaying);
    });

    if (this.trajScrubSlider) {
      this.trajScrubSlider.addEventListener('pointerdown', () => {
        this._isScrubbingTrajectory = true;
      });
      window.addEventListener('pointerup', () => {
        this._isScrubbingTrajectory = false;
      });
      this.trajScrubSlider.addEventListener('input', () => {
        const progress = Number(this.trajScrubSlider.value) / 1000;
        this.trajectoryScrubCallback?.(progress);
      });
    }

    this.railTabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.railTab;
        if (this._isLeftCollapsed) {
          this.setLeftCollapsed(false);
        }
        this.setLeftTab(tab);
      });
    });

    if (this.leftCollapseBtn) {
      this.leftCollapseBtn.addEventListener('click', () => {
        this.setLeftCollapsed(!this._isLeftCollapsed);
      });
    }

    if (this.overlaysCollapseBtn && this.overlaysBody) {
      this.overlaysCollapseBtn.addEventListener('click', () => {
        const collapsed = this.overlaysBody.classList.toggle('collapsed');
        const label = this.overlaysCollapseBtn.querySelector('span:first-child');
        if (label) {
          label.textContent = collapsed ? '▸ Map Overlays' : '▾ Map Overlays';
        }
      });
    }

    if (this.layerSelector) {
      this.layerSelector.value = LOD_CONFIG.DEFAULT_LAYER;
      this.layerSelector.addEventListener('change', (e) => {
        this._syncLayerInfo(e.target.value);
        if (this.layerChangeCallback) {
          this.layerChangeCallback(e.target.value);
        }
      });
    }

    // Синхронізація чекбоксів (вкладка Layers) та чіпів (Map Overlays)
    const setSolar = (enabled) => {
      if (this.toggleSolarLighting) this.toggleSolarLighting.checked = enabled;
      if (this.overlayChips.solar) this.overlayChips.solar.classList.toggle('active', enabled);
      if (this.quickSolarBtn) this.quickSolarBtn.classList.toggle('active', enabled);
      if (this.btsSolarBtn) this.btsSolarBtn.classList.toggle('active', enabled);
      if (this.lightingToggleCallback) this.lightingToggleCallback(enabled);
    };

    const setEarthDisk = (enabled) => {
      if (this.toggleEarthDisk) this.toggleEarthDisk.checked = enabled;
      if (this.overlayChips.earth) this.overlayChips.earth.classList.toggle('active', enabled);
      if (this.diskToggleCallback) this.diskToggleCallback(enabled);
    };

    const setHeatmap = (enabled) => {
      if (this.toggleHeatmap) this.toggleHeatmap.checked = enabled;
      if (this.overlayChips.heatmap) this.overlayChips.heatmap.classList.toggle('active', enabled);
      if (this.heatmapLegend) this.heatmapLegend.style.display = enabled ? 'block' : 'none';
      if (this.heatmapToggleCallback) this.heatmapToggleCallback(enabled);
    };

    const setCoordGrid = (enabled) => {
      if (this.toggleCoordGrid) this.toggleCoordGrid.checked = enabled;
      if (this.overlayChips.grid) this.overlayChips.grid.classList.toggle('active', enabled);
      if (this.coordGridToggleCallback) this.coordGridToggleCallback(enabled);
    };

    this.toggleSolarLighting?.addEventListener('change', (e) => setSolar(e.target.checked));
    this.overlayChips.solar?.addEventListener('click', () => setSolar(!this.toggleSolarLighting.checked));
    this.quickSolarBtn?.addEventListener('click', () => setSolar(!this.toggleSolarLighting.checked));
    this.btsSolarBtn?.addEventListener('click', () => setSolar(!this.toggleSolarLighting.checked));

    this.toggleEarthDisk?.addEventListener('change', (e) => setEarthDisk(e.target.checked));
    this.overlayChips.earth?.addEventListener('click', () => setEarthDisk(!this.toggleEarthDisk.checked));

    this.toggleHeatmap?.addEventListener('change', (e) => setHeatmap(e.target.checked));
    this.overlayChips.heatmap?.addEventListener('click', () => setHeatmap(!this.toggleHeatmap.checked));

    this.toggleCoordGrid?.addEventListener('change', (e) => setCoordGrid(e.target.checked));
    this.overlayChips.grid?.addEventListener('click', () => setCoordGrid(!this.toggleCoordGrid.checked));

    // Права панель інформації
    this.rightInfoToggleBtn?.addEventListener('click', () => this.toggleRightDrawer());
    this.btsInfoBtn?.addEventListener('click', () => this.toggleRightDrawer());
    this.rightInfoCloseBtn?.addEventListener('click', () => this.setRightDrawerOpen(false));

    // Кнопка Home
    this.homeViewBtn?.addEventListener('click', () => this.homeCallback?.());
    this.btsHomeBtn?.addEventListener('click', () => this.homeCallback?.());

    // Клавіша I для відкриття/закриття правої панелі інформації
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyI' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.toggleRightDrawer();
      }
    });

    // Глобальний пошук координат і точок
    this._bindSearchEvents();
  }

  _bindSearchEvents() {
    if (!this.searchInput) return;

    const closeResults = () => {
      this.searchResultsEl?.classList.remove('open');
    };

    const parseLatLon = (raw) => {
      const cleaned = raw.trim().replace(/°/g, '');
      const match = cleaned.match(
        /^(-?\d+(?:\.\d+)?)\s*([NSns])?[\s,;]+(-?\d+(?:\.\d+)?)\s*([EWew])?$/
      );
      if (!match) return null;
      let lat = Number.parseFloat(match[1]);
      let lon = Number.parseFloat(match[3]);
      if (match[2] && match[2].toUpperCase() === 'S') lat = -Math.abs(lat);
      if (match[4] && match[4].toUpperCase() === 'W') lon = -Math.abs(lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return null;
      }
      return { lat, lon };
    };

    const renderResults = () => {
      const q = this.searchInput.value.trim();
      this.searchClearBtn?.classList.toggle('visible', q.length > 0);
      if (!q) {
        closeResults();
        return;
      }

      const items = [];
      const coords = parseLatLon(q);
      if (coords) {
        items.push({
          name: 'Go to coordinates',
          lat: coords.lat,
          lon: coords.lon,
          zoom: 55,
          isDirectCoord: true,
        });
      }

      if (typeof this.searchProvider === 'function') {
        const lower = q.toLowerCase();
        const catalog = this.searchProvider() || [];
        for (const entry of catalog) {
          if (
            entry.name?.toLowerCase().includes(lower) ||
            entry.region?.toLowerCase().includes(lower) ||
            entry.program?.toLowerCase().includes(lower)
          ) {
            items.push({
              name: entry.name,
              lat: entry.lat,
              lon: entry.lon,
              zoom: entry.status === 'planned' ? 45 : 65,
            });
          }
          if (items.length >= 12) break;
        }
      }

      if (items.length === 0) {
        closeResults();
        return;
      }

      const esc = UIController.escapeHtml;
      this.searchResultsEl.innerHTML = items
        .map(
          (item, idx) => `
          <div class="search-result-item" data-search-idx="${idx}">
            <span class="search-result-name">${item.isDirectCoord ? '⌖ ' : ''}${esc(item.name)}</span>
            <span class="search-result-coords">${item.lat.toFixed(2)}°, ${item.lon.toFixed(2)}°</span>
          </div>
        `
        )
        .join('');

      this._lastSearchItems = items;
      this.searchResultsEl.classList.add('open');
    };

    this.searchInput.addEventListener('input', renderResults);
    this.searchInput.addEventListener('focus', renderResults);
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const coords = parseLatLon(this.searchInput.value);
        if (coords && this.flyToCallback) {
          this.flyToCallback(coords.lat, coords.lon, 55);
          closeResults();
        } else if (this._lastSearchItems && this._lastSearchItems.length > 0 && this.flyToCallback) {
          const first = this._lastSearchItems[0];
          this.flyToCallback(first.lat, first.lon, first.zoom || 60);
          closeResults();
        }
      } else if (e.key === 'Escape') {
        closeResults();
        this.searchInput.blur();
      }
    });

    this.searchResultsEl?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-search-idx]');
      if (!row || !this._lastSearchItems) return;
      const item = this._lastSearchItems[Number(row.dataset.searchIdx)];
      if (item && this.flyToCallback) {
        this.flyToCallback(item.lat, item.lon, item.zoom || 60);
        closeResults();
      }
    });

    this.searchClearBtn?.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchClearBtn.classList.remove('visible');
      closeResults();
      this.searchInput.focus();
    });

    window.addEventListener('pointerdown', (e) => {
      if (!this.searchInput.contains(e.target) && !this.searchResultsEl?.contains(e.target)) {
        closeResults();
      }
    });
  }

  _syncPlayButtonUI() {
    if (!this.trajPlayBtn) return;
    this.trajPlayBtn.textContent = this._isTrajectoryPlaying ? '❚❚' : '▶';
  }

  setTrajectoryPlayingUI(isPlaying) {
    this._isTrajectoryPlaying = Boolean(isPlaying);
    this._syncPlayButtonUI();
  }

  setLeftTab(tabName) {
    if (!this.tabPanes[tabName]) return;
    this._activeLeftTab = tabName;

    this.railTabBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.railTab === tabName);
    });
    Object.entries(this.tabPanes).forEach(([key, pane]) => {
      pane?.classList.toggle('active', key === tabName);
    });

    const meta = TAB_TITLES[tabName] || { title: 'Panel', badge: '' };
    if (this.leftDrawerTitle) this.leftDrawerTitle.textContent = meta.title;
    if (this.leftDrawerBadge) this.leftDrawerBadge.textContent = meta.badge;
  }

  setLeftCollapsed(collapsed) {
    this._isLeftCollapsed = Boolean(collapsed);
    this.leftDock?.classList.toggle('collapsed', this._isLeftCollapsed);
    this.bottomDock?.classList.toggle('left-collapsed', this._isLeftCollapsed);
    this.topFloatingBar?.classList.toggle('left-collapsed', this._isLeftCollapsed);
    window.dispatchEvent(new Event('resize'));
  }

  toggleRightDrawer() {
    this.setRightDrawerOpen(!this._isRightDrawerOpen);
  }

  setRightDrawerOpen(open) {
    this._isRightDrawerOpen = Boolean(open);
    document.body.classList.toggle('right-drawer-open', this._isRightDrawerOpen);
    this.rightInfoToggleBtn?.classList.toggle('active', this._isRightDrawerOpen);
    this.btsInfoBtn?.classList.toggle('active', this._isRightDrawerOpen);
  }

  setRulerActiveUI(isActive) {
    this.railRulerBtn?.classList.toggle('active', isActive);
    this.rightRulerBtn?.classList.toggle('active', isActive);
  }

  setViewModeUI(mode) {
    const activeMode =
      mode === VIEW_MODES.CISLUNAR || mode === 'CISLUNAR_VIEW'
        ? VIEW_MODES.CISLUNAR
        : VIEW_MODES.LUNAR;
    document.body.classList.toggle('cislunar-mode', activeMode === VIEW_MODES.CISLUNAR);
    this.viewModeBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.viewMode === activeMode);
    });
  }

  setCislunarFocusUI(focus) {
    this.focusTargetBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.focusTarget === focus);
    });
  }

  updateTrajectoryInfo(info) {
    if (!info) return;
    const { meta, landingSite, spaceport, segments, isPlaying, userVisible } = info;
    this._isTrajectoryPlaying = Boolean(isPlaying);
    this._isTrajectoryVisible = Boolean(userVisible);
    this._syncPlayButtonUI();
    this.trajVisibilityBtn?.classList.toggle('active', this._isTrajectoryVisible);

    if (this.trajSummaryEl) {
      const esc = UIController.escapeHtml;
      const latDir = landingSite.latDeg >= 0 ? 'N' : 'S';
      const lonDir = landingSite.lonDeg >= 0 ? 'E' : 'W';
      const targetStr = `${Math.abs(landingSite.latDeg).toFixed(2)}°${latDir}, ${Math.abs(landingSite.lonDeg).toFixed(2)}°${lonDir}`;
      this.trajSummaryEl.innerHTML = `
        <div><strong>${esc(meta.rocket)}</strong> · ${esc(spaceport.name)} → <strong>${targetStr}</strong></div>
        <div>Duration: <strong>${formatMissionDuration(meta.durationSec)}</strong> · Δv: <strong>${meta.totalDeltaVKmS.toFixed(2)} km/s</strong></div>
      `;
    }

    if (this.trajPhaseLegendEl) {
      const phaseCompressed = new Map();
      for (const seg of segments || []) {
        const prev = phaseCompressed.get(seg.phase) || false;
        phaseCompressed.set(seg.phase, prev || Boolean(seg.isCompressed));
      }
      const items = [];
      for (const [phase, isCompressed] of phaseCompressed.entries()) {
        const cfg = TRAJECTORY_CONFIG.PHASES[phase];
        if (!cfg) continue;
        const swatchStyle = isCompressed
          ? `border-top: 2px dashed ${cfg.css}; background: transparent;`
          : `background: ${cfg.css};`;
        const dashedCls = isCompressed ? ' traj-phase-dot--dashed' : '';
        items.push(
          `<span class="traj-phase-item"><span class="traj-phase-dot${dashedCls}" style="${swatchStyle}"></span>${UIController.escapeHtml(cfg.label)}</span>`
        );
      }
      this.trajPhaseLegendEl.innerHTML = items.join('');
    }
  }

  updateTrajectoryTelemetry(sample) {
    if (!sample) return;
    if (this.trajScrubSlider && !this._isScrubbingTrajectory) {
      this.trajScrubSlider.value = String(Math.round(sample.progress * 1000));
    }
    if (this.trajTimeReadoutEl) {
      this.trajTimeReadoutEl.textContent = `T+ ${formatMissionDuration(sample.t_s)}`;
    }
    if (this.trajTelemetryEl) {
      const phaseMeta = TRAJECTORY_CONFIG.PHASES[sample.phase];
      const phaseName = phaseMeta ? phaseMeta.label : sample.phase;
      const speedText =
        sample.speedKmS < 0.1
          ? `${(sample.speedKmS * 1000).toFixed(1)} m/s`
          : `${sample.speedKmS.toFixed(2)} km/s`;
      const speedRef = sample.isLunarRelSpeed ? ' (Moon)' : '';
      const altText =
        sample.moonAltKm < 35000
          ? `Alt Moon: ${Math.max(0, Math.round(sample.moonAltKm)).toLocaleString()} km`
          : `Alt Earth: ${Math.max(0, Math.round(sample.earthAltKm)).toLocaleString()} km`;
      this.trajTelemetryEl.textContent = `${phaseName} · ${speedText}${speedRef} · ${altText}`;
    }
  }

  setTrajectoryError(message) {
    if (this.trajSummaryEl) {
      this.trajSummaryEl.innerHTML = `<span style="color:#f87171">${UIController.escapeHtml(message)}</span>`;
    }
  }

  onTrajectoryToggle(callback) {
    this.trajectoryToggleCallback = callback;
  }

  onTrajectoryFileLoad(callback) {
    this.trajectoryFileLoadCallback = callback;
  }

  onTrajectoryPlayPause(callback) {
    this.trajectoryPlayPauseCallback = callback;
  }

  onTrajectoryScrub(callback) {
    this.trajectoryScrubCallback = callback;
  }

  _syncLayerInfo(layerId) {
    const info = LAYER_DESCRIPTIONS[layerId];
    if (info && this.activeLayerNameEl && this.activeLayerDescEl) {
      this.activeLayerNameEl.textContent = info.title;
      this.activeLayerDescEl.textContent = info.desc;
    }
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
    this.heatmapToggleCallback = callback;
  }

  onToggleCoordGrid(callback) {
    this.coordGridToggleCallback = callback;
  }

  onHomeClick(callback) {
    this.homeCallback = callback;
  }

  onFlyToSearch(callback) {
    this.flyToCallback = callback;
  }

  onViewModeChange(callback) {
    this.viewModeChangeCallback = callback;
  }

  onCislunarFocusChange(callback) {
    this.cislunarFocusChangeCallback = callback;
  }

  setSearchProvider(providerFn) {
    this.searchProvider = providerFn;
  }

  setLoading(isLoading) {
    if (this.btsStatusIcon) {
      this.btsStatusIcon.classList.toggle('loading', Boolean(isLoading));
    }
    if (isLoading && this.solarStatus) {
      this.solarStatus.innerHTML = 'Querying JPL Horizons ephemeris...';
    }
  }

  updateMissionSummary(mission) {
    if (!mission) return;
    if (this.topMissionPill) {
      this.topMissionPill.textContent = `🎯 ${mission.name}`;
      this.topMissionPill.title = `Active Mission: ${mission.name}`;
    }
    if (this.rightMissionSummary) {
      this.rightMissionSummary.innerHTML = `
        <div class="data-row"><span>Name:</span> <span class="data-val">${UIController.escapeHtml(mission.name)}</span></div>
        <div class="data-row"><span>Saved Points:</span> <span class="data-val" style="color:#4fc3f7">${mission.points.length}</span></div>
        <div class="data-row"><span>Ruler Measurements:</span> <span class="data-val" style="color:#6ef3e6">${mission.measurements.length}</span></div>
      `;
    }
  }

  static escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  updateCompass(camera, sunDir) {
    if (!camera || !this.compassNeedleEl) return;
    camera.getWorldDirection(this._camFwd);
    this._camRight.crossVectors(this._camFwd, camera.up).normalize();
    this._camUp.crossVectors(this._camRight, this._camFwd).normalize();

    // Проєктуємо вісь +Y (Північ Місяця) на площину екрана камери
    const worldNorth = this._northTangent.set(0, 1, 0);
    const nx = worldNorth.dot(this._camRight);
    const ny = worldNorth.dot(this._camUp);
    const angleRad = Math.atan2(nx, ny);
    const angleDeg = THREE.MathUtils.radToDeg(angleRad);
    this.compassNeedleEl.style.transform = `rotate(${angleDeg.toFixed(1)}deg)`;

    if (sunDir && this.compassSunDotEl) {
      const sx = sunDir.dot(this._camRight);
      const sy = sunDir.dot(this._camUp);
      const len = Math.hypot(sx, sy) || 1;
      const r = 17;
      const px = (sx / len) * r;
      const py = -(sy / len) * r;
      this.compassSunDotEl.style.transform = `translate(calc(-50% + ${px.toFixed(1)}px), calc(-50% + ${py.toFixed(1)}px))`;
    }
  }

  _calculateTileResolutionMetersPerPixel(estimatedLod) {
    const zoomLevel = Number.parseInt(String(estimatedLod), 10);
    const z = Number.isFinite(zoomLevel) ? zoomLevel : LOD_CONFIG.MIN_ZOOM;

    const currentLayerId = this.layerSelector ? this.layerSelector.value : LOD_CONFIG.DEFAULT_LAYER;
    const layer = MAP_LAYERS[currentLayerId];

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
      return `${Math.round(metersPerPixel)} m/px`;
    }
    if (metersPerPixel >= 10) {
      return `${metersPerPixel.toFixed(1)} m/px`;
    }
    return `${metersPerPixel.toFixed(2)} m/px`;
  }

  updateCameraZoom({ zoomFactor, altitudeKm, kmPerPixel, estimatedLod }) {
    const formattedZoom = zoomFactor >= 10 ? `${zoomFactor.toFixed(1)}×` : `${zoomFactor.toFixed(2)}×`;
    const formattedAlt = altitudeKm >= 100 ? `${Math.round(altitudeKm)} km` : `${altitudeKm.toFixed(1)} km`;
    const resolutionText = this._calculateTileResolutionMetersPerPixel(estimatedLod);

    if (this.cameraStatus) {
      this.cameraStatus.innerHTML = `
        <div class="data-row"><span>Zoom:</span> <span class="data-val" style="color:#ffd54f">${formattedZoom}</span></div>
        <div class="data-row"><span>Orbit Altitude:</span> <span class="data-val">${formattedAlt}</span></div>
        <div class="data-row"><span>Tile Level (LOD):</span> <span class="data-val">Z${estimatedLod}</span></div>
        <div class="data-row"><span>Resolution:</span> <span class="data-val" style="color:#80deea">${resolutionText}</span></div>
      `;
    }

    if (this.btsRes) {
      this.btsRes.textContent = resolutionText;
    }
    if (this.btsAlt) {
      this.btsAlt.textContent = formattedAlt;
    }

    if (kmPerPixel && this.scaleLabel && this.scaleLine) {
      this.updateScaleBar(kmPerPixel);
    }
  }

  updateScaleBar(kmPerPixel) {
    const targetWidthPx = 120;
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
      this.scaleLabel.textContent = `${niceKm >= 10 ? Math.round(niceKm) : niceKm.toFixed(1)} km`;
    } else {
      this.scaleLabel.textContent = `${Math.round(niceKm * 1000)} m`;
    }
  }

  updateSolarInfo(data) {
    const sLonDir = data.subSolarLon >= 0 ? 'E' : 'W';
    const sLatDir = data.subSolarLat >= 0 ? 'N' : 'S';
    const eLonDir = data.subEarthLon >= 0 ? 'E' : 'W';
    const eLatDir = data.subEarthLat >= 0 ? 'N' : 'S';

    if (this.solarStatus) {
      this.solarStatus.innerHTML = `
        <div class="data-row"><span>Source:</span> <span class="data-val">${data.source}</span></div>
        <div class="data-row"><span>Subsolar Point:</span> <span class="data-val">${Math.abs(data.subSolarLat).toFixed(2)}°${sLatDir}, ${Math.abs(data.subSolarLon).toFixed(2)}°${sLonDir}</span></div>
        <div class="data-row"><span>Sub-Earth Point:</span> <span class="data-val" style="color:#4fc3f7">${Math.abs(data.subEarthLat).toFixed(2)}°${eLatDir}, ${Math.abs(data.subEarthLon).toFixed(2)}°${eLonDir}</span></div>
      `;
    }

    if (this.btsStatusIcon) {
      this.btsStatusIcon.title = `Ephemeris source: ${data.source}`;
    }
  }

  updateCursorTelemetry(data) {
    if (!data) {
      if (this.telemetryContent) {
        this.telemetryContent.innerHTML = 'Hover cursor over the lunar surface';
      }
      if (this.btsLat) this.btsLat.textContent = '—';
      if (this.btsLon) this.btsLon.textContent = '—';
      if (this.btsIllum) this.btsIllum.textContent = '—';
      return;
    }

    const latDir = data.lat >= 0 ? 'N' : 'S';
    const lonDir = data.lon >= 0 ? 'E' : 'W';
    const statusText = data.isDaylight ? 'Day (Illuminated)' : 'Night (Beyond Terminator)';
    const visibilityText = data.isVisibleFromEarth ? 'Visible from Earth' : 'Far Side (Hidden)';

    if (this.btsLat) {
      this.btsLat.textContent = `${Math.abs(data.lat).toFixed(4)}°${latDir}`;
    }
    if (this.btsLon) {
      this.btsLon.textContent = `${Math.abs(data.lon).toFixed(4)}°${lonDir}`;
    }
    if (this.btsIllum) {
      this.btsIllum.textContent = `${data.illuminationPercent.toFixed(0)}% (${data.solarElevationDeg >= 0 ? '+' : ''}${data.solarElevationDeg.toFixed(1)}°)`;
    }

    if (this.telemetryContent) {
      this.telemetryContent.innerHTML = `
        <div class="data-row"><span>Latitude:</span> <span class="data-val">${Math.abs(data.lat).toFixed(4)}° ${latDir}</span></div>
        <div class="data-row"><span>Longitude:</span> <span class="data-val">${Math.abs(data.lon).toFixed(4)}° ${lonDir}</span></div>
        <div class="data-row"><span>Visibility:</span> <span class="data-val" style="color:${data.isVisibleFromEarth ? '#4fc3f7' : '#90a4ae'}">${visibilityText}</span></div>
        <div class="data-row"><span>Lighting:</span> <span class="data-val">${statusText}</span></div>
        <div class="data-row"><span>Solar Elevation:</span> <span class="data-val">${data.solarElevationDeg.toFixed(2)}°</span></div>
        <div class="data-row"><span>Illumination:</span> <span class="data-val">${data.illuminationPercent.toFixed(1)}%</span></div>
        <div class="data-row"><span>Irradiance:</span> <span class="data-val">${data.irradianceWm2.toFixed(1)} W/m²</span></div>
      `;
    }
  }
}
