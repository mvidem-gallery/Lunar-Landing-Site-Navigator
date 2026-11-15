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

    document.body.appendChild(this.backdropEl);
  }

  _bindEvents() {
    this.closeBtn.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
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

    return `/lunar-horizon/index.html?${params.toString()}`;
  }

  open(targetData = {}, options = {}) {
    const url = this.buildUrl(targetData, options);
    this.currentUrl = url;

    const lat = Number(targetData.lat) || 0;
    const lon = Number(targetData.lon) || 0;
    this.coordsEl.textContent = formatCoordsLabel(lat, lon);

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

    this.openTabLink.href = url;
    this.iframeEl.src = url;
    this.backdropEl.classList.add('open');
    this.isOpen = true;
    this.closeBtn.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.backdropEl.classList.remove('open');
    this.iframeEl.src = 'about:blank';
    this.isOpen = false;
  }
}
