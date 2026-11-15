import './lunarHorizonModal.css';

const DAY_MS = 86400000;
const MIN_SIM_MS = Date.UTC(2000, 0, 1, 0, 0, 0);
const MAX_START_MS = Date.UTC(2100, 10, 30, 23, 59, 0);
const DEFAULT_MISSION_DAYS = 30;
const DEFAULT_OBSERVER_HEIGHT_M = 1.7;
const DEFAULT_DARK_LIMIT_DAYS = 3;

function formatUtcLocalInput(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function formatCoordsLabel(lat, lon) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

export class LunarHorizonModal {
  constructor() {
    this.isOpen = false;
    this.currentUrl = '';
    this._openSeq = 0;
    this._minRevealTimer = null;
    this._fallbackTimer = null;
    this._closeResetTimer = null;
    this._stageTimers = [];
    this._lastTargetData = null;
    this.onOpenCallback = null;
    this.onCloseCallback = null;
    this._buildDOM();
    this._bindEvents();
  }

  _buildDOM() {
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'lh-modal-backdrop';
    this.backdropEl.setAttribute('role', 'dialog');
    this.backdropEl.setAttribute('aria-modal', 'true');
    this.backdropEl.setAttribute('aria-label', 'Lunar Horizon Surface Simulator');

    this.backdropEl.innerHTML = `
      <div class="lh-modal-topbar">
        <div class="lh-modal-title-group">
          <span class="lh-modal-badge">LUNAR HORIZON // SURFACE LANDING</span>
          <span class="lh-modal-coords" data-field="coords">—</span>
          <span class="lh-modal-meta" data-field="meta">—</span>
        </div>
        <div class="lh-modal-actions">
          <a
            class="lh-modal-btn"
            data-action="open-tab"
            href="./"
            target="_blank"
            rel="noopener noreferrer"
            title="Open Lunar Horizon in a separate browser tab"
          >
            Open in Tab
          </a>
          <button
            type="button"
            class="lh-modal-btn lh-modal-btn-primary"
            data-action="close"
            title="Close surface view and return to 3D Lunar Globe (Esc)"
          >
            Back to Globe
          </button>
        </div>
      </div>
      <div class="lh-modal-frame-wrap">
        <div class="lh-modal-loader" aria-live="polite">
          <div class="lh-loader-card">
            <div class="lh-loader-reticle" aria-hidden="true">
              <svg viewBox="0 0 72 72" width="64" height="64" fill="none">
                <circle class="lh-reticle-outer" cx="36" cy="36" r="30" stroke="currentColor" stroke-width="1.4" stroke-dasharray="16 8 5 8" />
                <circle class="lh-reticle-inner" cx="36" cy="36" r="20" stroke="#4db5ff" stroke-width="1.5" stroke-dasharray="38 20" />
                <path d="M16 44c6-5 13-7 20-7s14 2 20 7" stroke="#94a0b0" stroke-width="1.2" stroke-linecap="round" />
                <circle class="lh-reticle-pulse" cx="36" cy="36" r="3.2" fill="#f4f7fa" />
              </svg>
            </div>
            <div class="lh-loader-kicker">3D MOON → SURFACE LANDING VIEW</div>
            <div class="lh-loader-title">INITIALIZING SURFACE SIMULATOR</div>
            <div class="lh-loader-target" data-field="loader-target">—</div>
            <div class="lh-loader-bar-track"><div class="lh-loader-bar-fill"></div></div>
            <div class="lh-loader-status" data-field="loader-status">ACQUIRING TARGET EPHEMERIS...</div>
          </div>
        </div>
        <iframe
          class="lh-modal-iframe"
          title="Lunar Horizon Surface Simulator"
          allow="fullscreen"
          allowfullscreen
        ></iframe>
      </div>
    `;

    this.coordsEl = this.backdropEl.querySelector('[data-field="coords"]');
    this.metaEl = this.backdropEl.querySelector('[data-field="meta"]');
    this.openTabLink = this.backdropEl.querySelector('[data-action="open-tab"]');
    this.closeBtn = this.backdropEl.querySelector('[data-action="close"]');
    this.iframeEl = this.backdropEl.querySelector('.lh-modal-iframe');
    this.loaderTargetEl = this.backdropEl.querySelector('[data-field="loader-target"]');
    this.loaderStatusEl = this.backdropEl.querySelector('[data-field="loader-status"]');

    document.body.appendChild(this.backdropEl);
  }

  onOpen(callback) {
    this.onOpenCallback = callback;
  }

  onClose(callback) {
    this.onCloseCallback = callback;
  }

  _bindEvents() {
    this.closeBtn.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }

  _clearTimers() {
    if (this._minRevealTimer) {
      clearTimeout(this._minRevealTimer);
      this._minRevealTimer = null;
    }
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    if (this._closeResetTimer) {
      clearTimeout(this._closeResetTimer);
      this._closeResetTimer = null;
    }
    for (const id of this._stageTimers) clearTimeout(id);
    this._stageTimers = [];
  }

  buildUrl(targetData = {}, options = {}) {
    const lat = Math.max(-90, Math.min(90, Number(targetData.lat) || 0));
    const lon = Math.max(-180, Math.min(180, Number(targetData.lon) || 0));
    const height = Number.isFinite(options.height) ? options.height : DEFAULT_OBSERVER_HEIGHT_M;
    const durationDays = Number.isFinite(options.durationDays)
      ? options.durationDays
      : DEFAULT_MISSION_DAYS;
    const darkLimit = Number.isFinite(options.darkLimit)
      ? options.darkLimit
      : DEFAULT_DARK_LIMIT_DAYS;

    const rawStartMs = targetData.date instanceof Date
      ? targetData.date.getTime()
      : Date.parse(targetData.isoDate || '') || Date.now();
    const startMs = Math.max(MIN_SIM_MS, Math.min(MAX_START_MS, rawStartMs));
    const endMs = Math.min(Date.UTC(2100, 11, 31, 23, 0, 0), startMs + durationDays * DAY_MS);

    const params = new URLSearchParams({
      lat: lat.toFixed(5),
      lon: lon.toFixed(5),
      height: String(height),
      start: formatUtcLocalInput(startMs),
      end: formatUtcLocalInput(endMs),
      darkLimit: String(darkLimit),
    });

    if (targetData.missionId) {
      params.set('missionId', String(targetData.missionId));
    }
    if (targetData.pointName) {
      params.set('pointName', String(targetData.pointName));
    }

    const base = import.meta.env?.BASE_URL || '/';
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return `${normalizedBase}lunar-horizon/index.html?${params.toString()}`;
  }

  open(targetData = {}, options = {}) {
    this._clearTimers();
    const seq = ++this._openSeq;
    const openedAt = performance.now();

    const url = this.buildUrl(targetData, options);
    this.currentUrl = url;
    this._lastTargetData = targetData;

    const lat = Number(targetData.lat) || 0;
    const lon = Number(targetData.lon) || 0;
    const coordsLabel = formatCoordsLabel(lat, lon);
    this.coordsEl.textContent = coordsLabel;

    const metaParts = [];
    if (targetData.missionName) {
      metaParts.push(String(targetData.missionName));
    }
    if (targetData.pointName) {
      metaParts.push(String(targetData.pointName));
    }
    if (typeof targetData.sunElevDeg === 'number') {
      const sign = targetData.sunElevDeg >= 0 ? '+' : '';
      metaParts.push(`Sun: ${sign}${targetData.sunElevDeg.toFixed(1)}°`);
    }
    if (typeof targetData.hasEarthContact === 'boolean') {
      metaParts.push(`Earth LOS: ${targetData.hasEarthContact ? 'VISIBLE' : 'OCCLUDED'}`);
    }
    const startDate = targetData.date instanceof Date ? targetData.date : new Date();
    metaParts.push(`Landing UTC: ${formatUtcLocalInput(startDate.getTime()).replace('T', ' ')}`);
    this.metaEl.textContent = metaParts.join('  ·  ');

    if (this.loaderTargetEl) {
      const place = [targetData.pointName, targetData.missionName].filter(Boolean).join(' · ');
      this.loaderTargetEl.textContent = place ? `${place} (${coordsLabel})` : coordsLabel;
    }
    if (this.loaderStatusEl) {
      this.loaderStatusEl.textContent = 'ACQUIRING TARGET EPHEMERIS...';
    }

    this._stageTimers.push(
      setTimeout(() => {
        if (seq === this._openSeq && this.loaderStatusEl) {
          this.loaderStatusEl.textContent = 'LOADING LOLA DEM TERRAIN MESH...';
        }
      }, 420),
      setTimeout(() => {
        if (seq === this._openSeq && this.loaderStatusEl) {
          this.loaderStatusEl.textContent = 'CALIBRATING HORIZON & SOLAR VECTOR...';
        }
      }, 1050)
    );

    const finishLoading = () => {
      if (seq !== this._openSeq) return;
      if (this._fallbackTimer) {
        clearTimeout(this._fallbackTimer);
        this._fallbackTimer = null;
      }
      for (const id of this._stageTimers) clearTimeout(id);
      this._stageTimers = [];
      this.backdropEl.classList.remove('is-loading');
    };

    const onIframeLoad = () => {
      if (seq !== this._openSeq) return;
      if (this.iframeEl.getAttribute('src') === 'about:blank') return;
      const remaining = Math.max(0, 650 - (performance.now() - openedAt));
      this._minRevealTimer = setTimeout(finishLoading, remaining);
    };

    this.iframeEl.addEventListener('load', onIframeLoad, { once: true });
    this._fallbackTimer = setTimeout(finishLoading, 10000);

    this.openTabLink.href = url;
    this.backdropEl.classList.add('open', 'is-loading');
    this.iframeEl.src = url;
    this.isOpen = true;
    this.closeBtn.focus();
    this.onOpenCallback?.(targetData);
  }

  close() {
    if (!this.isOpen) return;
    const seq = ++this._openSeq;
    this._clearTimers();
    this.backdropEl.classList.remove('open', 'is-loading');
    this.isOpen = false;
    this._closeResetTimer = setTimeout(() => {
      if (seq === this._openSeq && !this.isOpen) {
        this.iframeEl.src = 'about:blank';
      }
    }, 280);
    this.onCloseCallback?.(this._lastTargetData);
  }
}
