import * as THREE from 'three';
import { VIEW_MODES } from '../config/constants.js';
import './surfaceContextMenu.css';

export class SurfaceContextMenu {
  /**
   * @param {HTMLElement} canvasContainer
   * @param {Object} options
   * @param {Function} options.getHoveredCoords
   * @param {Function} options.getCurrentDate
   * @param {Function} [options.getSunDirection]
   * @param {Function} [options.getEarthDirection]
   * @param {Function} [options.getMoonQuaternion]
   * @param {Function} [options.getViewMode]
   * @param {Function} [options.getRightClickTarget]
   * @param {Function} [options.onFocusBody]
   * @param {Function} [options.onCreateMission]
   * @param {Function} options.onLandTo
   * @param {Function} [options.onPointView]
   * @param {Function} [options.onSaveLandingSite]
   * @param {Function} [options.onSetMissionTarget]
   * @param {Function} [options.onAddToMission]
   */
  constructor(
    canvasContainer,
    {
      getHoveredCoords,
      getCurrentDate,
      getSunDirection,
      getEarthDirection,
      getMoonQuaternion,
      getViewMode,
      getRightClickTarget,
      onFocusBody,
      onCreateMission,
      onLandTo,
      onPointView,
      onSaveLandingSite,
      onSetMissionTarget,
      onAddToMission,
    }
  ) {
    this.container = canvasContainer;
    this.getHoveredCoords = getHoveredCoords;
    this.getCurrentDate = getCurrentDate;
    this.getSunDirection = getSunDirection;
    this.getEarthDirection = getEarthDirection;
    this.getMoonQuaternion = getMoonQuaternion;
    this.getViewMode = getViewMode;
    this.getRightClickTarget = getRightClickTarget;
    this.onFocusBody = onFocusBody;
    this.onCreateMission = onCreateMission;
    this.onLandTo = onLandTo;
    this.onPointView = onPointView;
    this.onSaveLandingSite = onSaveLandingSite;
    this.onSetMissionTarget = onSetMissionTarget;
    this.onAddToMission = onAddToMission;

    this.activeTarget = null;
    this._pointerDownPos = { x: 0, y: 0 };
    this._surfaceNormal = new THREE.Vector3();
    this._hasEnteredMenu = false;

    this._buildDOM();
    this._bindEvents();
  }

  _buildDOM() {
    this.menuEl = document.createElement('div');
    this.menuEl.className = 'lunar-context-menu';

    this.menuEl.innerHTML = `
      <div class="lunar-context-menu-header">
        <span data-field="coords">0.000°E  0.000°N</span>
        <span class="lunar-context-menu-tag" data-field="tag">TARGET</span>
      </div>
      <div class="lunar-context-telemetry">
        <div class="lunar-telemetry-row">
          <span class="lunar-telemetry-label">Sun Elevation:</span>
          <span class="lunar-telemetry-val" data-field="sun-angle">+0.0°</span>
        </div>
        <div class="lunar-telemetry-row">
          <span class="lunar-telemetry-label">Illumination:</span>
          <span class="lunar-telemetry-val" data-field="illumination">0% (NIGHT)</span>
        </div>
        <div class="lunar-illum-bar-wrap">
          <div class="lunar-illum-bar-fill" data-field="illum-bar"></div>
        </div>
        <div class="lunar-telemetry-row" style="margin-top: 2px;">
          <span class="lunar-telemetry-label">Earth LOS:</span>
          <span class="lunar-telemetry-val" data-field="earth-los">VISIBLE</span>
        </div>
      </div>
      <button type="button" class="lunar-context-menu-item" data-action="create-mission">
        <span>Create Mission</span>
        <span class="lunar-context-menu-item-icon">+NEW</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="focus-earth">
        <span>Focus on Earth</span>
        <span class="lunar-context-menu-item-icon">CAM</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="focus-moon">
        <span>Focus on Moon</span>
        <span class="lunar-context-menu-item-icon">CAM</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="focus-system">
        <span>Frame Earth–Moon System</span>
        <span class="lunar-context-menu-item-icon">SYS</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="set-mission-target">
        <span>Set Mission Landing Target</span>
        <span class="lunar-context-menu-item-icon">TRG</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="add-to-mission">
        <span>Add to Active Mission</span>
        <span class="lunar-context-menu-item-icon">+PT</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="save-landing-site">
        <span>Save Landing Site</span>
        <span class="lunar-context-menu-item-icon">SITE</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="point-view">
        <span>View from Point</span>
        <span class="lunar-context-menu-item-icon">PT</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="land-to">
        <span>Land to</span>
        <span class="lunar-context-menu-item-icon">SURF</span>
      </button>
    `;

    this.coordsEl = this.menuEl.querySelector('[data-field="coords"]');
    this.tagEl = this.menuEl.querySelector('[data-field="tag"]');
    this.telemetryEl = this.menuEl.querySelector('.lunar-context-telemetry');
    this.sunAngleEl = this.menuEl.querySelector('[data-field="sun-angle"]');
    this.illuminationEl = this.menuEl.querySelector('[data-field="illumination"]');
    this.illumBarEl = this.menuEl.querySelector('[data-field="illum-bar"]');
    this.earthLosEl = this.menuEl.querySelector('[data-field="earth-los"]');
    this.createMissionBtn = this.menuEl.querySelector('[data-action="create-mission"]');
    this.focusEarthBtn = this.menuEl.querySelector('[data-action="focus-earth"]');
    this.focusMoonBtn = this.menuEl.querySelector('[data-action="focus-moon"]');
    this.focusSystemBtn = this.menuEl.querySelector('[data-action="focus-system"]');
    this.setMissionTargetBtn = this.menuEl.querySelector('[data-action="set-mission-target"]');
    this.addToMissionBtn = this.menuEl.querySelector('[data-action="add-to-mission"]');
    this.saveSiteBtn = this.menuEl.querySelector('[data-action="save-landing-site"]');
    this.pointViewBtn = this.menuEl.querySelector('[data-action="point-view"]');
    this.landBtn = this.menuEl.querySelector('[data-action="land-to"]');

    document.body.appendChild(this.menuEl);
  }

  _computeSurfaceNormal(latDeg, lonDeg, outVec) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    return outVec
      .set(
        Math.cos(latRad) * Math.cos(lonRad),
        Math.sin(latRad),
        -Math.cos(latRad) * Math.sin(lonRad)
      )
      .normalize();
  }

  _evaluateTelemetry(lat, lon) {
    this._computeSurfaceNormal(lat, lon, this._surfaceNormal);

    if (typeof this.getMoonQuaternion === 'function') {
      const moonQuat = this.getMoonQuaternion();
      if (moonQuat) {
        this._surfaceNormal.applyQuaternion(moonQuat).normalize();
      }
    }

    let sunElevDeg = 0;
    let illumPercent = 0;
    if (typeof this.getSunDirection === 'function') {
      const sunDir = this.getSunDirection();
      if (sunDir) {
        const sinSun = THREE.MathUtils.clamp(this._surfaceNormal.dot(sunDir), -1, 1);
        sunElevDeg = THREE.MathUtils.radToDeg(Math.asin(sinSun));
        illumPercent = Math.max(0, sinSun) * 100;
      }
    }

    let earthElevDeg = 0;
    let hasEarthContact = false;
    if (typeof this.getEarthDirection === 'function') {
      const earthDir = this.getEarthDirection();
      if (earthDir) {
        const sinEarth = THREE.MathUtils.clamp(this._surfaceNormal.dot(earthDir), -1, 1);
        earthElevDeg = THREE.MathUtils.radToDeg(Math.asin(sinEarth));
        hasEarthContact = earthElevDeg > 0;
      }
    }

    return {
      sunElevDeg: Number(sunElevDeg.toFixed(1)),
      illumPercent: Math.round(illumPercent),
      earthElevDeg: Number(earthElevDeg.toFixed(1)),
      hasEarthContact,
    };
  }

  _bindEvents() {
    this.container.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        this._pointerDownPos.x = e.clientX;
        this._pointerDownPos.y = e.clientY;
      }
    });

    this.container.addEventListener('contextmenu', (e) => {
      e.preventDefault();

      const moveDist = Math.hypot(
        e.clientX - this._pointerDownPos.x,
        e.clientY - this._pointerDownPos.y
      );
      if (moveDist > 5) {
        this.hide();
        return;
      }

      const viewMode = this.getViewMode ? this.getViewMode() : VIEW_MODES.LUNAR;
      const isCislunar = viewMode === VIEW_MODES.CISLUNAR || viewMode === 'CISLUNAR_VIEW';
      const hitBody = this.getRightClickTarget ? this.getRightClickTarget(e.clientX, e.clientY) : null;
      const coords = this.getHoveredCoords ? this.getHoveredCoords() : null;
      const hasCoords = Boolean(coords && typeof coords.lat === 'number' && typeof coords.lon === 'number');

      if (hitBody === 'EARTH') {
        this.activeTarget = {
          mode: 'body',
          bodyType: 'EARTH',
          headerLabel: 'PLANET EARTH',
          tagLabel: 'BODY',
          showTelemetry: false,
          showFocusEarth: true,
          showFocusMoon: false,
          showFocusSystem: isCislunar,
          showLunarActions: false,
          showPointView: false,
          showLandTo: false,
        };
        this.show(e.clientX, e.clientY, this.activeTarget);
        return;
      }

      if (hitBody === 'MOON' || (!hitBody && hasCoords)) {
        if (!isCislunar && !hasCoords) {
          this.hide();
          return;
        }
        const currentDate = this.getCurrentDate ? this.getCurrentDate() : new Date();
        const telemetry = hasCoords ? this._evaluateTelemetry(coords.lat, coords.lon) : null;

        this.activeTarget = {
          mode: hasCoords ? 'surface' : 'body',
          bodyType: 'MOON',
          headerLabel: hasCoords ? null : 'MOON · LUNA',
          tagLabel: isCislunar ? 'CISLUNAR' : viewMode === VIEW_MODES.POINT ? 'POINT' : 'TARGET',
          lon: hasCoords ? Number(coords.lon.toFixed(5)) : null,
          lat: hasCoords ? Number(coords.lat.toFixed(5)) : null,
          date: new Date(currentDate.getTime()),
          isoDate: currentDate.toISOString(),
          ...(telemetry || {}),
          showTelemetry: hasCoords,
          showFocusEarth: false,
          showFocusMoon: isCislunar,
          showFocusSystem: isCislunar,
          showLunarActions: hasCoords,
          showPointView: hasCoords,
          // Функція Land to недоступна у режимі перегляду траєкторії
          showLandTo: !isCislunar && hasCoords,
        };
        this.show(e.clientX, e.clientY, this.activeTarget);
        return;
      }

      if (!hasCoords) {
        this.hide();
        return;
      }
    });

    this.focusEarthBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onFocusBody?.('EARTH');
      this.hide();
    });

    this.focusMoonBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onFocusBody?.('MOON');
      this.hide();
    });

    this.focusSystemBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onFocusBody?.('SYSTEM');
      this.hide();
    });

    this.createMissionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget?.showLunarActions && typeof this.onCreateMission === 'function') {
        this.onCreateMission({ ...this.activeTarget });
      }
      this.hide();
    });

    this.setMissionTargetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget?.showLunarActions && typeof this.onSetMissionTarget === 'function') {
        this.onSetMissionTarget({ ...this.activeTarget });
      }
      this.hide();
    });

    this.addToMissionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget?.showLunarActions && typeof this.onAddToMission === 'function') {
        this.onAddToMission({ ...this.activeTarget });
      }
      this.hide();
    });

    this.pointViewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget?.showPointView && typeof this.onPointView === 'function') {
        this.onPointView({ ...this.activeTarget });
      }
      this.hide();
    });

    this.landBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget?.showLandTo && typeof this.onLandTo === 'function') {
        this.onLandTo({ ...this.activeTarget });
      }
      this.hide();
    });

    this.saveSiteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget?.showLunarActions && typeof this.onSaveLandingSite === 'function') {
        this.onSaveLandingSite({ ...this.activeTarget });
      }
      this.hide();
    });

    this.menuEl.addEventListener('pointerenter', () => {
      this._hasEnteredMenu = true;
    });

    this.menuEl.addEventListener('pointerleave', () => {
      this.hide();
    });

    window.addEventListener(
      'pointermove',
      (e) => {
        if (!this.activeTarget) return;

        const rect = this.menuEl.getBoundingClientRect();
        const pad = this._hasEnteredMenu ? 2 : 14;
        const isInside =
          e.clientX >= rect.left - pad &&
          e.clientX <= rect.right + pad &&
          e.clientY >= rect.top - pad &&
          e.clientY <= rect.bottom + pad;

        if (!isInside) {
          this.hide();
        }
      },
      { passive: true }
    );

    window.addEventListener('pointerdown', (e) => {
      if (!this.menuEl.contains(e.target) && e.button !== 2) {
        this.hide();
      }
    });

    window.addEventListener('wheel', () => this.hide(), { passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  show(clientX, clientY, target) {
    this._hasEnteredMenu = false;

    if (target.tagLabel && this.tagEl) {
      this.tagEl.textContent = target.tagLabel;
    }

    if (target.showTelemetry && typeof target.lat === 'number' && typeof target.lon === 'number') {
      const latDir = target.lat >= 0 ? 'N' : 'S';
      const lonDir = target.lon >= 0 ? 'E' : 'W';
      this.coordsEl.textContent = `${Math.abs(target.lon).toFixed(3)}°${lonDir}  ${Math.abs(target.lat).toFixed(3)}°${latDir}`;
      this.telemetryEl.style.display = 'flex';

      const sunSign = target.sunElevDeg >= 0 ? '+' : '';
      this.sunAngleEl.textContent = `${sunSign}${target.sunElevDeg.toFixed(1)}°`;

      this.illuminationEl.className = 'lunar-telemetry-val';
      if (target.sunElevDeg > 3.0) {
        this.illuminationEl.textContent = `${target.illumPercent}% (DAY)`;
        this.illuminationEl.classList.add('sun-day');
      } else if (target.sunElevDeg >= -6.0) {
        this.illuminationEl.textContent = `${target.illumPercent}% (TWILIGHT)`;
        this.illuminationEl.classList.add('sun-twilight');
      } else {
        this.illuminationEl.textContent = `0% (NIGHT)`;
        this.illuminationEl.classList.add('sun-night');
      }

      this.illumBarEl.style.width = `${target.illumPercent}%`;

      const earthSign = target.earthElevDeg >= 0 ? '+' : '';
      this.earthLosEl.className = 'lunar-telemetry-val';
      if (target.hasEarthContact) {
        this.earthLosEl.textContent = `YES (${earthSign}${target.earthElevDeg.toFixed(1)}°)`;
        this.earthLosEl.classList.add('earth-visible');
      } else {
        this.earthLosEl.textContent = `NONE (${earthSign}${target.earthElevDeg.toFixed(1)}°)`;
        this.earthLosEl.classList.add('earth-hidden');
      }
    } else {
      this.coordsEl.textContent = target.headerLabel || 'CELESTIAL BODY';
      this.telemetryEl.style.display = 'none';
    }

    this.createMissionBtn.style.display = target.showLunarActions ? 'flex' : 'none';
    this.focusEarthBtn.style.display = target.showFocusEarth ? 'flex' : 'none';
    this.focusMoonBtn.style.display = target.showFocusMoon ? 'flex' : 'none';
    this.focusSystemBtn.style.display = target.showFocusSystem ? 'flex' : 'none';
    this.setMissionTargetBtn.style.display = target.showLunarActions ? 'flex' : 'none';
    this.addToMissionBtn.style.display = target.showLunarActions ? 'flex' : 'none';
    this.saveSiteBtn.style.display = target.showLunarActions ? 'flex' : 'none';
    this.pointViewBtn.style.display = target.showPointView ? 'flex' : 'none';
    this.landBtn.style.display = target.showLandTo ? 'flex' : 'none';

    this.menuEl.classList.add('visible');

    const rect = this.menuEl.getBoundingClientRect();
    const rawX = clientX - 6;
    const rawY = clientY - 6;

    const posX = rawX + rect.width > window.innerWidth ? clientX - rect.width + 6 : rawX;
    const posY = rawY + rect.height > window.innerHeight ? clientY - rect.height + 6 : rawY;

    this.menuEl.style.left = `${Math.max(4, posX)}px`;
    this.menuEl.style.top = `${Math.max(4, posY)}px`;
  }

  hide() {
    this.menuEl.classList.remove('visible');
    this.activeTarget = null;
    this._hasEnteredMenu = false;
  }

  dispose() {
    if (this.menuEl && this.menuEl.parentNode) {
      this.menuEl.parentNode.removeChild(this.menuEl);
    }
  }
}
