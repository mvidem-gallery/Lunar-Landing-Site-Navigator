import * as THREE from 'three';
import './surfaceContextMenu.css';

export class SurfaceContextMenu {
  /**
   * @param {HTMLElement} canvasContainer - DOM-контейнер 3D-сцени
   * @param {Object} options
   * @param {Function} options.getHoveredCoords - Повертає { lat, lon } або null
   * @param {Function} options.getCurrentDate - Повертає поточний об'єкт Date симуляції
   * @param {Function} [options.getSunDirection] - Повертає нормалізований THREE.Vector3 напрямку на Сонце
   * @param {Function} [options.getEarthDirection] - Повертає нормалізований THREE.Vector3 напрямку на Землю
   * @param {Function} options.onLandTo - Колбек виклику зовнішньої програми
   * @param {Function} [options.onSaveLandingSite] - Колбек збереження точки посадки
   */
  constructor(
    canvasContainer,
    {
      getHoveredCoords,
      getCurrentDate,
      getSunDirection,
      getEarthDirection,
      onLandTo,
      onSaveLandingSite,
    }
  ) {
    this.container = canvasContainer;
    this.getHoveredCoords = getHoveredCoords;
    this.getCurrentDate = getCurrentDate;
    this.getSunDirection = getSunDirection;
    this.getEarthDirection = getEarthDirection;
    this.onLandTo = onLandTo;
    this.onSaveLandingSite = onSaveLandingSite;

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
        <span class="lunar-context-menu-tag">TARGET</span>
      </div>
      <div class="lunar-context-telemetry">
        <div class="lunar-telemetry-row">
          <span class="lunar-telemetry-label">Кут Сонця:</span>
          <span class="lunar-telemetry-val" data-field="sun-angle">+0.0°</span>
        </div>
        <div class="lunar-telemetry-row">
          <span class="lunar-telemetry-label">Освітленість:</span>
          <span class="lunar-telemetry-val" data-field="illumination">0% (НІЧ)</span>
        </div>
        <div class="lunar-illum-bar-wrap">
          <div class="lunar-illum-bar-fill" data-field="illum-bar"></div>
        </div>
        <div class="lunar-telemetry-row" style="margin-top: 2px;">
          <span class="lunar-telemetry-label">Контакт із Землею:</span>
          <span class="lunar-telemetry-val" data-field="earth-los">ВИДИМА</span>
        </div>
      </div>
      <button type="button" class="lunar-context-menu-item" data-action="land-to">
        <span>Land to</span>
        <span class="lunar-context-menu-item-icon">⌖</span>
      </button>
      <button type="button" class="lunar-context-menu-item" data-action="save-landing-site">
        <span>Зберегти точку посадки</span>
        <span class="lunar-context-menu-item-icon">★</span>
      </button>
    `;

    this.coordsEl = this.menuEl.querySelector('[data-field="coords"]');
    this.sunAngleEl = this.menuEl.querySelector('[data-field="sun-angle"]');
    this.illuminationEl = this.menuEl.querySelector('[data-field="illumination"]');
    this.illumBarEl = this.menuEl.querySelector('[data-field="illum-bar"]');
    this.earthLosEl = this.menuEl.querySelector('[data-field="earth-los"]');
    this.landBtn = this.menuEl.querySelector('[data-action="land-to"]');
    this.saveSiteBtn = this.menuEl.querySelector('[data-action="save-landing-site"]');

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

      const coords = this.getHoveredCoords ? this.getHoveredCoords() : null;
      if (!coords || typeof coords.lat !== 'number' || typeof coords.lon !== 'number') {
        this.hide();
        return;
      }

      const currentDate = this.getCurrentDate ? this.getCurrentDate() : new Date();
      const telemetry = this._evaluateTelemetry(coords.lat, coords.lon);

      this.activeTarget = {
        lon: Number(coords.lon.toFixed(5)),
        lat: Number(coords.lat.toFixed(5)),
        date: new Date(currentDate.getTime()),
        isoDate: currentDate.toISOString(),
        ...telemetry,
      };

      this.show(e.clientX, e.clientY, this.activeTarget);
    });

    this.landBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget && typeof this.onLandTo === 'function') {
        this.onLandTo({ ...this.activeTarget });
      }
      this.hide();
    });

    this.saveSiteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTarget && typeof this.onSaveLandingSite === 'function') {
        this.onSaveLandingSite({ ...this.activeTarget });
      }
      this.hide();
    });

    // Фіксуємо вхід курсора в область вікна меню та закриваємо при виході за його межі
    this.menuEl.addEventListener('pointerenter', () => {
      this._hasEnteredMenu = true;
    });

    this.menuEl.addEventListener('pointerleave', () => {
      this.hide();
    });

    // Контроль відведення курсора, навіть якщо користувач не встиг навести безпосередньо на елемент
    window.addEventListener(
      'pointermove',
      (e) => {
        if (!this.activeTarget) return;

        const rect = this.menuEl.getBoundingClientRect();
        // Буфер 14px навколо вікна, щоб меню не зникало в момент відкриття біля курсора
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

    const latDir = target.lat >= 0 ? 'N' : 'S';
    const lonDir = target.lon >= 0 ? 'E' : 'W';
    this.coordsEl.textContent = `${Math.abs(target.lon).toFixed(3)}°${lonDir}  ${Math.abs(target.lat).toFixed(3)}°${latDir}`;

    const sunSign = target.sunElevDeg >= 0 ? '+' : '';
    this.sunAngleEl.textContent = `${sunSign}${target.sunElevDeg.toFixed(1)}°`;

    this.illuminationEl.className = 'lunar-telemetry-val';
    if (target.sunElevDeg > 3.0) {
      this.illuminationEl.textContent = `${target.illumPercent}% (ДЕНЬ)`;
      this.illuminationEl.classList.add('sun-day');
    } else if (target.sunElevDeg >= -6.0) {
      this.illuminationEl.textContent = `${target.illumPercent}% (СУТІНКИ)`;
      this.illuminationEl.classList.add('sun-twilight');
    } else {
      this.illuminationEl.textContent = `0% (НІЧ)`;
      this.illuminationEl.classList.add('sun-night');
    }

    this.illumBarEl.style.width = `${target.illumPercent}%`;

    const earthSign = target.earthElevDeg >= 0 ? '+' : '';
    this.earthLosEl.className = 'lunar-telemetry-val';
    if (target.hasEarthContact) {
      this.earthLosEl.textContent = `Є (${earthSign}${target.earthElevDeg.toFixed(1)}°)`;
      this.earthLosEl.classList.add('earth-visible');
    } else {
      this.earthLosEl.textContent = `НЕМАЄ (${earthSign}${target.earthElevDeg.toFixed(1)}°)`;
      this.earthLosEl.classList.add('earth-hidden');
    }

    this.menuEl.classList.add('visible');

    // Відкриваємо меню так, щоб курсор одразу опинився всередині верхнього кута вікна
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
