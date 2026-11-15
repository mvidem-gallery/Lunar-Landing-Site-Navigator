import * as THREE from 'three';
import { MOON_CONFIG } from '../config/constants.js';
import { NASA_MOON_EXPLORATION_SITES } from '../data/lunarLandingSites.js';
import './landingSitesMenu.css';

const STORAGE_KEY = 'lunar_custom_landing_sites_v1';
const LL2_LANDING_LOCATIONS_URL =
  'https://ll.thespacedevs.com/2.3.0/config/landing_locations/?limit=200&format=json';

export class LandingSitesMenu {
  static latLonToNormal(latDeg, lonDeg) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    return new THREE.Vector3(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.sin(latRad),
      -Math.cos(latRad) * Math.sin(lonRad)
    ).normalize();
  }

  static normalToLatLon(normal) {
    const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(normal.y, -1, 1)));
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-normal.z, normal.x));
    return { lat, lon };
  }

  static formatCoords(lat, lon) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(3)}°${latDir}, ${Math.abs(lon).toFixed(3)}°${lonDir}`;
  }

  static escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {HTMLElement | null} [options.mountContainer]
   * @param {HTMLElement | null} [options.toggleButton]
   * @param {HTMLElement | null} [options.countBadgeEl]
   * @param {HTMLElement | null} [options.chevronEl]
   * @param {Function | null} [options.onFlyToSite]
   * @param {Function | null} [options.onAddToMission]
   * @param {Function | null} [options.onSetMissionTarget]
   * @param {Function | null} [options.onRequestOpenTab]
   */
  constructor({
    scene,
    camera,
    mountContainer = null,
    toggleButton = null,
    countBadgeEl = null,
    chevronEl = null,
    onFlyToSite = null,
    onAddToMission = null,
    onSetMissionTarget = null,
    onRequestOpenTab = null,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.mountContainer = mountContainer;
    this.isEmbedded = Boolean(mountContainer);
    this.toggleButton = toggleButton;
    this.countBadgeEl = countBadgeEl;
    this.chevronEl = chevronEl;
    this.onFlyToSite = onFlyToSite;
    this.onAddToMission = onAddToMission;
    this.onSetMissionTarget = onSetMissionTarget;
    this.onRequestOpenTab = onRequestOpenTab;

    this.isOpen = this.isEmbedded;
    this.activeTab = 'nasa';
    this.searchQuery = '';
    this.statusFilter = 'all';
    this.selectedSiteId = null;
    this.showCustomPinsOnGlobe = true;

    this.nasaSites = NASA_MOON_EXPLORATION_SITES.map((site) => ({
      ...site,
      origin: 'nasa',
    }));
    this.customSites = this._loadCustomSites();

    this._apiSyncState = 'idle';
    this._apiSyncNote = '';
    this._formError = '';

    this.surfaceRadius = MOON_CONFIG.RADIUS + 0.000022;
    this.group = new THREE.Group();
    this.group.renderOrder = 16;
    if (this.scene) {
      this.scene.add(this.group);
    }

    this._markerOuterGeo = new THREE.RingGeometry(0.6, 1.0, 32);
    this._markerInnerGeo = new THREE.CircleGeometry(0.36, 20);
    this._selectedOuterMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._customOuterMat = new THREE.MeshBasicMaterial({
      color: 0x0095ff,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    this._innerDotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });

    this._pins = [];
    this._camDir = new THREE.Vector3();
    this._projVec = new THREE.Vector3();
    this._localCamPos = new THREE.Vector3();
    this._invWorldMatrix = new THREE.Matrix4();
    this._zAxis = new THREE.Vector3(0, 0, 1);

    this._buildDOM();
    this._bindEvents();
    this._updateTopButtonUI();
    this._renderWindow();
    this._rebuildGlobePins();
  }

  getAllSites() {
    return [...this.customSites, ...this.nasaSites];
  }

  _loadCustomSites() {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (item) =>
            item &&
            typeof item.name === 'string' &&
            Number.isFinite(Number(item.lat)) &&
            Number.isFinite(Number(item.lon))
        )
        .map((item) => ({
          id: String(item.id || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
          name: item.name.trim(),
          lat: Number(item.lat),
          lon: Number(item.lon),
          region: typeof item.region === 'string' ? item.region : 'Custom site',
          description: typeof item.description === 'string' ? item.description : '',
          date: typeof item.date === 'string' ? item.date : '',
          status: 'custom',
          origin: 'custom',
          source: typeof item.source === 'string' ? item.source : 'Custom list',
        }));
    } catch {
      return [];
    }
  }

  _persistCustomSites() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.customSites));
    } catch {
      // Ігноруємо помилки квоти сховища
    }
  }

  _buildDOM() {
    this.windowEl = document.createElement('div');
    this.windowEl.id = 'landing-sites-window';
    this.windowEl.className = this.isEmbedded ? '' : 'hud-panel floating-mode';
    this.windowEl.innerHTML = `
      <div class="panel-header ls-header ${this.isEmbedded ? 'ls-embedded-hide' : ''}">
        <span>LANDING SITES (NASA & CUSTOM)</span>
        <button type="button" class="ls-close-btn" data-action="close" title="Close window">✕</button>
      </div>

      <div class="ls-section-bar">
        <span class="layers-group-label">SITE CATALOG</span>
        <button type="button" class="section-arrow-btn" data-action="toggle-catalog" title="Collapse / Expand Site Catalog" aria-expanded="true">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6l4 4 4-4" /></svg>
        </button>
      </div>

      <div class="ls-catalog-body" data-field="catalog-body" style="display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;">
      <div class="ls-tabs">
        <button type="button" class="ls-tab-btn active" data-tab="nasa">
          NASA Missions (<span data-field="nasa-count">0</span>)
        </button>
        <button type="button" class="ls-tab-btn" data-tab="custom">
          Custom (<span data-field="custom-count">0</span>)
        </button>
      </div>

      <div class="ls-search-wrap">
        <input
          type="text"
          class="hud-input ls-search-input"
          data-field="search"
          placeholder="Search mission by name..."
          autocomplete="off"
        />
        <button type="button" class="ls-search-clear" data-action="clear-search" title="Clear search">✕</button>
      </div>

      <div class="ls-filters-row" data-field="nasa-filters">
        <div class="ls-filter-pills">
          <button type="button" class="ls-pill-btn active" data-status="all">All</button>
          <button type="button" class="ls-pill-btn" data-status="landed">Landed</button>
          <button type="button" class="ls-pill-btn" data-status="planned">Planned</button>
        </div>
        <button
          type="button"
          class="hud-btn ls-sync-btn"
          data-action="sync-api"
          title="Sync additional sites from Launch Library 2 API"
        >SYNC API</button>
      </div>

      <form class="ls-custom-form" data-field="custom-form">
        <input
          type="text"
          class="hud-input"
          data-field="custom-name"
          placeholder="Landing site name (e.g. Artemis Base)"
          maxlength="80"
        />
        <div class="ls-coord-inputs">
          <input
            type="number"
            step="0.0001"
            min="-90"
            max="90"
            class="hud-input"
            data-field="custom-lat"
            placeholder="Latitude (-90..90)"
          />
          <input
            type="number"
            step="0.0001"
            min="-180"
            max="180"
            class="hud-input"
            data-field="custom-lon"
            placeholder="Longitude (-180..180)"
          />
        </div>
        <input
          type="text"
          class="hud-input"
          data-field="custom-desc"
          placeholder="Region or note (optional)"
          maxlength="140"
        />
        <div class="ls-form-error" data-field="form-error" style="display: none; color: #ff8a80; font-size: 10.5px;"></div>
        <div class="ls-form-actions">
          <button type="button" class="hud-btn" data-action="fill-camera">From Cam Center</button>
          <button type="submit" class="hud-btn">Save Site</button>
        </div>
      </form>

      <div class="ls-list" data-field="list"></div>

      <div class="ls-footer-bar">
        <span data-field="footer-status">Ready</span>
        <div class="ls-card-btns">
          <button type="button" class="hud-btn ls-mini-btn" data-action="toggle-custom-pins">Pins: ON</button>
          <button type="button" class="hud-btn ls-mini-btn" data-action="clear-selection" style="display: none;">Clear Pin</button>
        </div>
      </div>
      </div>
    `;

    this.closeBtn = this.windowEl.querySelector('[data-action="close"]');
    this.tabButtons = Array.from(this.windowEl.querySelectorAll('.ls-tab-btn'));
    this.nasaCountEl = this.windowEl.querySelector('[data-field="nasa-count"]');
    this.customCountEl = this.windowEl.querySelector('[data-field="custom-count"]');
    this.searchInputEl = this.windowEl.querySelector('[data-field="search"]');
    this.clearSearchBtn = this.windowEl.querySelector('[data-action="clear-search"]');
    this.nasaFiltersEl = this.windowEl.querySelector('[data-field="nasa-filters"]');
    this.statusPillBtns = Array.from(this.windowEl.querySelectorAll('.ls-pill-btn'));
    this.syncApiBtn = this.windowEl.querySelector('[data-action="sync-api"]');

    this.customFormEl = this.windowEl.querySelector('[data-field="custom-form"]');
    this.customNameInput = this.windowEl.querySelector('[data-field="custom-name"]');
    this.customLatInput = this.windowEl.querySelector('[data-field="custom-lat"]');
    this.customLonInput = this.windowEl.querySelector('[data-field="custom-lon"]');
    this.customDescInput = this.windowEl.querySelector('[data-field="custom-desc"]');
    this.formErrorEl = this.windowEl.querySelector('[data-field="form-error"]');
    this.fillCameraBtn = this.windowEl.querySelector('[data-action="fill-camera"]');

    this.listEl = this.windowEl.querySelector('[data-field="list"]');
    this.footerStatusEl = this.windowEl.querySelector('[data-field="footer-status"]');
    this.togglePinsBtn = this.windowEl.querySelector('[data-action="toggle-custom-pins"]');
    this.clearSelectionBtn = this.windowEl.querySelector('[data-action="clear-selection"]');
    this.catalogCollapseBtn = this.windowEl.querySelector('[data-action="toggle-catalog"]');
    this.catalogBodyEl = this.windowEl.querySelector('[data-field="catalog-body"]');

    if (this.mountContainer) {
      this.mountContainer.appendChild(this.windowEl);
    } else {
      document.body.appendChild(this.windowEl);
    }

    this.labelsLayer = document.createElement('div');
    this.labelsLayer.id = 'landing-labels-layer';
    document.body.appendChild(this.labelsLayer);
  }

  _bindEvents() {
    if (this.toggleButton) {
      this.toggleButton.addEventListener('click', () => this.toggle());
    }

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.close());
    }

    if (this.catalogCollapseBtn && this.catalogBodyEl) {
      this.catalogCollapseBtn.addEventListener('click', () => {
        const collapsed = this.catalogBodyEl.classList.toggle('collapsed');
        this.catalogBodyEl.style.display = collapsed ? 'none' : 'flex';
        this.catalogCollapseBtn.classList.toggle('collapsed', collapsed);
        this.catalogCollapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    }

    this.tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextTab = btn.dataset.tab === 'custom' ? 'custom' : 'nasa';
        this.setActiveTab(nextTab);
      });
    });

    this.searchInputEl.addEventListener('input', (e) => {
      this.searchQuery = e.target.value || '';
      this.clearSearchBtn.classList.toggle('visible', this.searchQuery.length > 0);
      this._renderList();
      this._updateFooterStatus();
    });

    this.clearSearchBtn.addEventListener('click', () => {
      this.searchQuery = '';
      this.searchInputEl.value = '';
      this.clearSearchBtn.classList.remove('visible');
      this._renderList();
      this._updateFooterStatus();
      this.searchInputEl.focus();
    });

    this.statusPillBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.statusFilter = btn.dataset.status || 'all';
        this.statusPillBtns.forEach((b) =>
          b.classList.toggle('active', b.dataset.status === this.statusFilter)
        );
        this._renderList();
        this._updateFooterStatus();
      });
    });

    this.syncApiBtn.addEventListener('click', () => this.syncFromOnlineCatalog());

    this.fillCameraBtn.addEventListener('click', () => this.fillFormFromCameraCenter());

    this.customFormEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleCustomFormSubmit();
    });

    this.togglePinsBtn.addEventListener('click', () => {
      this.showCustomPinsOnGlobe = !this.showCustomPinsOnGlobe;
      this.togglePinsBtn.textContent = this.showCustomPinsOnGlobe
        ? 'Pins: ON'
        : 'Pins: OFF';
      this._rebuildGlobePins();
    });

    this.clearSelectionBtn.addEventListener('click', () => {
      this.selectedSiteId = null;
      this._renderList();
      this._updateFooterStatus();
      this._rebuildGlobePins();
    });

    this.listEl.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-card-action]');
      const card = e.target.closest('[data-site-id]');
      if (!card) return;

      const siteId = card.dataset.siteId;
      const site = this._findSiteById(siteId);
      if (!site) return;

      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.cardAction;
        if (action === 'fly') {
          this.selectAndFlyTo(site);
        } else if (action === 'set-target') {
          if (typeof this.onSetMissionTarget === 'function') {
            this.onSetMissionTarget(site);
          }
        } else if (action === 'add-to-mission') {
          if (typeof this.onAddToMission === 'function') {
            this.onAddToMission(site);
          }
        } else if (action === 'save-to-custom') {
          this.saveSiteAsCustom(site);
        } else if (action === 'delete') {
          this.deleteCustomSite(site.id);
        }
        return;
      }

      this.selectAndFlyTo(site);
    });

    this._onKeyDown = (e) => {
      if (!this.isEmbedded && e.key === 'Escape' && this.isOpen) {
        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
          document.activeElement.blur();
          return;
        }
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isEmbedded) return;
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(tab = null) {
    if (tab === 'nasa' || tab === 'custom') {
      this.activeTab = tab;
    }
    this.isOpen = true;
    if (!this.isEmbedded) {
      this.windowEl.classList.add('open');
    } else if (typeof this.onRequestOpenTab === 'function') {
      this.onRequestOpenTab();
    }
    this._updateTopButtonUI();
    this._renderWindow();
  }

  close() {
    if (this.isEmbedded) return;
    this.isOpen = false;
    this.windowEl.classList.remove('open');
    this._updateTopButtonUI();
  }

  setActiveTab(tab) {
    this.activeTab = tab === 'custom' ? 'custom' : 'nasa';
    this._formError = '';
    this._renderWindow();
  }

  _updateTopButtonUI() {
    if (this.toggleButton) {
      this.toggleButton.classList.toggle('open', this.isOpen);
    }
    if (this.chevronEl) {
      this.chevronEl.textContent = this.isOpen ? '▴' : '▾';
    }
    if (this.countBadgeEl) {
      this.countBadgeEl.textContent = String(this.nasaSites.length + this.customSites.length);
    }
  }

  _findSiteById(id) {
    return (
      this.customSites.find((s) => s.id === id) ||
      this.nasaSites.find((s) => s.id === id) ||
      null
    );
  }

  _isSavedInCustom(site) {
    return this.customSites.some(
      (c) =>
        c.name.toLowerCase() === site.name.toLowerCase() ||
        (Math.abs(c.lat - site.lat) < 0.001 && Math.abs(c.lon - site.lon) < 0.001)
    );
  }

  fillFormFromCameraCenter() {
    if (!this.camera) return;
    const camNormal = this.camera.position.clone().normalize();
    const { lat, lon } = LandingSitesMenu.normalToLatLon(camNormal);
    this.customLatInput.value = lat.toFixed(4);
    this.customLonInput.value = lon.toFixed(4);
    if (!this.customNameInput.value.trim()) {
      this.customNameInput.value = `Site ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    }
    this._formError = '';
    this._renderFormError();
    this.customNameInput.focus();
    this.customNameInput.select();
  }

  promptAndSaveTarget(targetData) {
    if (!targetData || !Number.isFinite(targetData.lat) || !Number.isFinite(targetData.lon)) {
      return;
    }

    const lat = Number(targetData.lat);
    const lon = Number(targetData.lon);

    this.open('custom');
    this.customNameInput.value = `Site ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    this.customLatInput.value = lat.toFixed(4);
    this.customLonInput.value = lon.toFixed(4);

    const sunText =
      typeof targetData.sunElevDeg === 'number'
        ? `Sun: ${targetData.sunElevDeg >= 0 ? '+' : ''}${targetData.sunElevDeg.toFixed(1)}°`
        : '';
    const earthText =
      typeof targetData.hasEarthContact === 'boolean'
        ? targetData.hasEarthContact
          ? 'Earth visible'
          : 'Earth hidden'
        : '';
    this.customDescInput.value = [sunText, earthText].filter(Boolean).join(' · ');

    this._formError = '';
    this._renderFormError();
    this.customNameInput.focus();
    this.customNameInput.select();
  }

  _handleCustomFormSubmit() {
    const name = this.customNameInput.value.trim();
    const lat = Number.parseFloat(this.customLatInput.value);
    const lon = Number.parseFloat(this.customLonInput.value);
    const desc = this.customDescInput.value.trim();

    if (!name) {
      this._formError = 'Enter a landing site name.';
      this._renderFormError();
      this.customNameInput.focus();
      return;
    }

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      this._formError = 'Latitude must be between -90° and +90°.';
      this._renderFormError();
      this.customLatInput.focus();
      return;
    }

    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      this._formError = 'Longitude must be between -180° and +180°.';
      this._renderFormError();
      this.customLonInput.focus();
      return;
    }

    const created = this.saveCustomSite({
      name,
      lat,
      lon,
      region: desc || 'Custom landing site',
      description: desc || 'Saved manually to custom list.',
    });

    this.customNameInput.value = '';
    this.customLatInput.value = '';
    this.customLonInput.value = '';
    this.customDescInput.value = '';
    this._formError = '';
    this._renderFormError();

    this.selectAndFlyTo(created);
  }

  saveSiteAsCustom(site) {
    if (!site) return null;
    if (this._isSavedInCustom(site)) {
      this.setActiveTab('custom');
      return null;
    }
    return this.saveCustomSite({
      name: site.name,
      lat: site.lat,
      lon: site.lon,
      region: site.region,
      description: site.description,
      date: site.date,
      source: `Saved from ${site.program || 'NASA'}`,
    });
  }

  saveCustomSite({ name, lat, lon, region = '', description = '', date = '', source = 'Custom list' }) {
    const site = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name).trim(),
      lat: Number(Number(lat).toFixed(5)),
      lon: Number(Number(lon).toFixed(5)),
      region: region || 'Custom site',
      description: description || '',
      date: date || new Date().toISOString().slice(0, 10),
      status: 'custom',
      origin: 'custom',
      source,
    };

    this.customSites.unshift(site);
    this._persistCustomSites();
    this._updateTopButtonUI();
    this._renderWindow();
    this._rebuildGlobePins();
    return site;
  }

  deleteCustomSite(id) {
    const prevLen = this.customSites.length;
    this.customSites = this.customSites.filter((s) => s.id !== id);
    if (this.customSites.length === prevLen) return;

    if (this.selectedSiteId === id) {
      this.selectedSiteId = null;
    }
    this._persistCustomSites();
    this._updateTopButtonUI();
    this._renderWindow();
    this._rebuildGlobePins();
  }

  selectAndFlyTo(site) {
    if (!site) return;
    this.selectedSiteId = site.id;
    this._renderList();
    this._updateFooterStatus();
    this._rebuildGlobePins();

    if (typeof this.onFlyToSite === 'function') {
      this.onFlyToSite(site);
    }
  }

  async syncFromOnlineCatalog() {
    if (this._apiSyncState === 'loading') return;
    this._apiSyncState = 'loading';
    this._apiSyncNote = 'Querying Launch Library 2 API...';
    this.syncApiBtn.disabled = true;
    this.syncApiBtn.textContent = 'SYNC...';
    this._updateFooterStatus();

    try {
      const response = await fetch(LL2_LANDING_LOCATIONS_URL);
      if (!response.ok) {
        this._apiSyncState = 'error';
        this._apiSyncNote = `API unavailable (HTTP ${response.status})`;
      } else {
        const payload = await response.json();
        const results = Array.isArray(payload?.results) ? payload.results : [];
        let addedCount = 0;

        for (const item of results) {
          const bodyName = item?.celestial_body?.name;
          if (bodyName !== 'Moon') continue;
          const lat = Number(item?.latitude);
          const lon = Number(item?.longitude);
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

          const exists = this.nasaSites.some(
            (s) =>
              s.name.toLowerCase() === name.toLowerCase() ||
              (Math.abs(s.lat - lat) < 0.05 && Math.abs(s.lon - lon) < 0.05)
          );
          if (exists) continue;

          this.nasaSites.push({
            id: `ll2-${item.id ?? `${lat}-${lon}`}`,
            name,
            program: 'NASA / International',
            agency: 'SpaceDevs LL2',
            status: 'landed',
            date: '',
            region: item.description ? item.description.slice(0, 72) : 'Lunar surface',
            lat: Number(lat.toFixed(4)),
            lon: Number(lon.toFixed(4)),
            description: item.description || 'Landing location from Launch Library 2 database.',
            source: 'Launch Library 2 API',
            origin: 'nasa',
          });
          addedCount += 1;
        }

        this._apiSyncState = 'done';
        this._apiSyncNote =
          addedCount > 0 ? `API: +${addedCount} new sites` : 'API: catalog up to date';
      }
    } catch (err) {
      this._apiSyncState = 'error';
      this._apiSyncNote = `API unavailable (${err.message})`;
    } finally {
      this.syncApiBtn.disabled = false;
      this.syncApiBtn.textContent = 'SYNC API';
      this._updateTopButtonUI();
      this._renderWindow();
    }
  }

  _getFilteredSites() {
    const query = this.searchQuery.trim().toLowerCase();
    const sourceList = this.activeTab === 'custom' ? this.customSites : this.nasaSites;

    return sourceList.filter((site) => {
      if (this.activeTab === 'nasa' && this.statusFilter !== 'all' && site.status !== this.statusFilter) {
        return false;
      }
      if (!query) return true;

      const haystack = [
        site.name,
        site.program,
        site.agency,
        site.region,
        site.description,
        site.date,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  _renderFormError() {
    if (!this.formErrorEl) return;
    if (this._formError) {
      this.formErrorEl.textContent = this._formError;
      this.formErrorEl.style.display = 'block';
    } else {
      this.formErrorEl.textContent = '';
      this.formErrorEl.style.display = 'none';
    }
  }

  _renderWindow() {
    this.nasaCountEl.textContent = String(this.nasaSites.length);
    this.customCountEl.textContent = String(this.customSites.length);

    this.tabButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === this.activeTab);
    });

    this.nasaFiltersEl.style.display = this.activeTab === 'nasa' ? 'flex' : 'none';
    this.customFormEl.classList.toggle('visible', this.activeTab === 'custom');

    this._renderFormError();
    this._renderList();
    this._updateFooterStatus();
  }

  _renderList() {
    const sites = this._getFilteredSites();

    if (sites.length === 0) {
      const emptyMsg =
        this.activeTab === 'custom' && this.customSites.length === 0
          ? 'Custom list is empty. Add a site above, from camera center, via right-click on the Moon, or save a NASA mission.'
          : 'Nothing found matching your search query.';
      this.listEl.innerHTML = `<div class="ls-empty">${LandingSitesMenu.escapeHtml(emptyMsg)}</div>`;
      return;
    }

    this.listEl.innerHTML = sites
      .map((site) => {
        const isSelected = site.id === this.selectedSiteId;
        const badgeClass =
          site.origin === 'custom' ? 'custom' : site.status === 'planned' ? 'planned' : 'landed';
        const badgeLabel =
          site.origin === 'custom'
            ? 'CUSTOM'
            : site.status === 'planned'
              ? 'PLANNED'
              : 'LANDED';

        const metaLeft = [site.program, site.date].filter(Boolean).join(' · ') || site.region;
        const coordsText = LandingSitesMenu.formatCoords(site.lat, site.lon);
        const descText =
          site.region && site.description && site.region !== site.description
            ? `${site.region}. ${site.description}`
            : site.description || site.region || '';

        const alreadySaved = site.origin === 'nasa' && this._isSavedInCustom(site);
        const actionButtons =
          site.origin === 'custom'
            ? `
              <button type="button" class="hud-btn ls-mini-btn mission-add" data-card-action="set-target" title="Set as active mission landing target">Target</button>
              <button type="button" class="hud-btn ls-mini-btn" data-card-action="add-to-mission" title="Add waypoint to active mission">+Pt</button>
              <button type="button" class="hud-btn ls-mini-btn" data-card-action="fly">Fly To</button>
              <button type="button" class="hud-btn ls-mini-btn danger" data-card-action="delete">×</button>
            `
            : `
              <button type="button" class="hud-btn ls-mini-btn mission-add" data-card-action="set-target" title="Set as active mission landing target">Target</button>
              <button type="button" class="hud-btn ls-mini-btn" data-card-action="add-to-mission" title="Add waypoint to active mission">+Pt</button>
              <button type="button" class="hud-btn ls-mini-btn" data-card-action="fly">Fly To</button>
              <button type="button" class="hud-btn ls-mini-btn" data-card-action="save-to-custom" ${alreadySaved ? 'disabled' : ''}>
                ${alreadySaved ? 'SAVED' : 'SAVE'}
              </button>
            `;

        return `
          <div class="ls-card ${isSelected ? 'selected' : ''}" data-site-id="${LandingSitesMenu.escapeHtml(site.id)}">
            <div class="ls-card-top">
              <span class="ls-card-title">${LandingSitesMenu.escapeHtml(site.name)}</span>
              <span class="ls-badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="ls-card-meta">
              <span>${LandingSitesMenu.escapeHtml(metaLeft)}</span>
              <span class="ls-card-coords">${LandingSitesMenu.escapeHtml(coordsText)}</span>
            </div>
            ${descText ? `<div class="ls-card-desc">${LandingSitesMenu.escapeHtml(descText)}</div>` : ''}
            <div class="ls-card-footer">
              <span class="ls-card-source">${LandingSitesMenu.escapeHtml(site.source || '')}</span>
              <div class="ls-card-btns">${actionButtons}</div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  _updateFooterStatus() {
    const filteredCount = this._getFilteredSites().length;
    const totalCount =
      this.activeTab === 'custom' ? this.customSites.length : this.nasaSites.length;

    let text = `Showing: ${filteredCount} of ${totalCount}`;
    if (this.activeTab === 'nasa' && this._apiSyncNote) {
      text = `${text} · ${this._apiSyncNote}`;
    }
    this.footerStatusEl.textContent = text;
    this.clearSelectionBtn.style.display = this.selectedSiteId ? 'inline-block' : 'none';
  }

  _clearGlobePins() {
    for (const pin of this._pins) {
      this.group.remove(pin.mesh);
      pin.labelEl.remove();
    }
    this._pins = [];
  }

  _createPin(site, isSelected) {
    const normal = LandingSitesMenu.latLonToNormal(site.lat, site.lon);
    const marker = new THREE.Group();
    const outerMesh = new THREE.Mesh(
      this._markerOuterGeo,
      isSelected ? this._selectedOuterMat : this._customOuterMat
    );
    const innerMesh = new THREE.Mesh(this._markerInnerGeo, this._innerDotMat);
    innerMesh.position.z = 0.001;
    marker.add(outerMesh, innerMesh);

    marker.position.copy(normal).multiplyScalar(this.surfaceRadius);
    marker.quaternion.setFromUnitVectors(this._zAxis, normal);
    marker.renderOrder = isSelected ? 18 : 16;
    this.group.add(marker);

    const labelEl = document.createElement('div');
    labelEl.className = `landing-pin-label ${isSelected ? 'selected' : 'custom'}`;
    labelEl.textContent = site.name;
    labelEl.style.display = 'none';
    this.labelsLayer.appendChild(labelEl);

    this._pins.push({
      site,
      normal,
      mesh: marker,
      labelEl,
      isSelected,
    });
  }

  _rebuildGlobePins() {
    this._clearGlobePins();

    const selectedSite = this.selectedSiteId ? this._findSiteById(this.selectedSiteId) : null;
    if (this.showCustomPinsOnGlobe) {
      for (const site of this.customSites) {
        if (selectedSite && site.id === selectedSite.id) continue;
        this._createPin(site, false);
      }
    }

    if (selectedSite) {
      this._createPin(selectedSite, true);
    }
  }

  update(camera) {
    if (!camera || this._pins.length === 0) return;

    camera.updateMatrixWorld();
    this.group.updateWorldMatrix(true, false);
    this._invWorldMatrix.copy(this.group.matrixWorld).invert();
    const camPos = this._localCamPos.copy(camera.position).applyMatrix4(this._invWorldMatrix);
    const camDist = camPos.length();
    if (camDist <= 0.0001) return;

    this._camDir.copy(camPos).divideScalar(camDist);
    const horizonCos = MOON_CONFIG.RADIUS / camDist;
    const fovRad = THREE.MathUtils.degToRad(camera.fov || 45);
    const tanHalfFov = Math.tan(fovRad * 0.5);

    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;

    for (const pin of this._pins) {
      const distToMarker = camPos.distanceTo(pin.mesh.position);
      const worldHeight = 2 * distToMarker * tanHalfFov;
      const pxRadius = pin.isSelected ? 9.5 : 6.5;
      const worldRadius = (pxRadius / height) * worldHeight;
      pin.mesh.scale.set(worldRadius, worldRadius, 1);

      if (pin.normal.dot(this._camDir) < horizonCos - 0.002) {
        pin.labelEl.style.display = 'none';
        continue;
      }

      this._projVec
        .copy(pin.normal)
        .multiplyScalar(this.surfaceRadius)
        .applyMatrix4(this.group.matrixWorld)
        .project(camera);
      if (
        this._projVec.z > 1.0 ||
        this._projVec.x < -1.05 ||
        this._projVec.x > 1.05 ||
        this._projVec.y < -1.05 ||
        this._projVec.y > 1.05
      ) {
        pin.labelEl.style.display = 'none';
        continue;
      }

      const screenX = (this._projVec.x * 0.5 + 0.5) * width;
      const screenY = (-this._projVec.y * 0.5 + 0.5) * height;
      pin.labelEl.style.left = `${screenX.toFixed(1)}px`;
      pin.labelEl.style.top = `${screenY.toFixed(1)}px`;
      pin.labelEl.style.display = 'block';
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this._clearGlobePins();
    this._markerOuterGeo.dispose();
    this._markerInnerGeo.dispose();
    this._selectedOuterMat.dispose();
    this._customOuterMat.dispose();
    this._innerDotMat.dispose();
    if (this.scene) {
      this.scene.remove(this.group);
    }
    this.windowEl?.remove();
    this.labelsLayer?.remove();
  }
}
