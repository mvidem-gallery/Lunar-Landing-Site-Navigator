import { fetchMissionReport } from '../data/reportServiceClient.js';
import { formatCoords, formatTransitDuration } from '../data/missionModel.js';
import './aiReportPanel.css';

const DEFAULT_WINDOW_DAYS = 14;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toIsoDateYmd(dateLike) {
  if (dateLike instanceof Date && !Number.isNaN(dateLike.getTime())) {
    return dateLike.toISOString().slice(0, 10);
  }
  if (typeof dateLike === 'string' && dateLike.trim()) {
    const trimmed = dateLike.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return '2026-11-15';
}

function formatHeadlineCoords(headline) {
  const match = String(headline || '').match(
    /(\d+(?:\.\d+)?)°\s*([NS]),\s*(\d+(?:\.\d+)?)°\s*([EW])/i
  );
  if (!match) return 'GLOBAL LUNAR SURFACE';
  return `${match[1]}° ${match[2].toUpperCase()}, ${match[3]}° ${match[4].toUpperCase()}`;
}

export class AIReportPanel {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container
   * @param {Function} [options.getActiveMission]
   * @param {Function} [options.getCurrentTimelineDate]
   * @param {Function} [options.onFlyTo]
   */
  constructor({
    container,
    getActiveMission = null,
    getCurrentTimelineDate = null,
    onFlyTo = null,
  }) {
    this.container = container;
    this.getActiveMission = getActiveMission;
    this.getCurrentTimelineDate = getCurrentTimelineDate;
    this.onFlyTo = onFlyTo;

    this.lat = null;
    this.lon = null;
    this.landingDate = '2026-11-15';
    this.windowDays = DEFAULT_WINDOW_DAYS;

    this.syncedMission = null;
    this.report = null;
    this.lastReportKey = null;
    this.activeReportTab = 'favorable';
    this.isLoading = false;
    this.loadingStage = 1;
    this.errorMsg = null;

    this._loadingTimers = [];
    this._typingTimer = null;
    this._abortController = null;
    this._requestSeq = 0;

    this._buildDOM();
    this._bindEvents();
    this.syncFromActiveMission({ autoGenerate: false });
    this.render();
  }

  _getCurrentRequestKey(
    lat = this.lat,
    lon = this.lon,
    landingDate = this.landingDate,
    windowDays = this.windowDays
  ) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    return [
      Number.isFinite(nLat) ? nLat.toFixed(4) : 'unset',
      Number.isFinite(nLon) ? nLon.toFixed(4) : 'unset',
      String(landingDate || '2026-11-15'),
      Number(windowDays) || DEFAULT_WINDOW_DAYS,
    ].join('|');
  }

  _buildMissionContext() {
    const mission = this.getActiveMission?.() || null;
    const timelineDate = this.getCurrentTimelineDate?.() || null;
    if (!mission) {
      return {
        hasMission: false,
        missionName: null,
        siteName: null,
        lat: null,
        lon: null,
        landingDate: toIsoDateYmd(timelineDate || new Date()),
        launchUtc: null,
        transitDurationSec: null,
        rocket: null,
      };
    }

    const site = mission.landingSite;
    const hasSite =
      site && Number.isFinite(Number(site.lat)) && Number.isFinite(Number(site.lon));
    const dateSource =
      mission.flight?.landingDateIso ||
      mission.trajectory?.meta?.touchdownUtc ||
      timelineDate ||
      new Date();

    return {
      hasMission: true,
      missionId: mission.id,
      missionName: mission.name,
      siteName: hasSite ? site.name : null,
      lat: hasSite ? Number(site.lat) : null,
      lon: hasSite ? Number(site.lon) : null,
      landingDate: toIsoDateYmd(dateSource),
      launchUtc: mission.flight?.launchDateIso || mission.trajectory?.meta?.launchUtc || null,
      transitDurationSec:
        mission.flight?.transitDurationSec ?? mission.trajectory?.meta?.durationSec ?? null,
      rocket: mission.trajectory?.meta?.rocket || null,
    };
  }

  syncFromActiveMission({ autoGenerate = false, forceRefresh = false } = {}) {
    const ctx = this._buildMissionContext();
    this.syncedMission = ctx;

    if (ctx.lat !== null && ctx.lon !== null) {
      this.lat = ctx.lat;
      this.lon = ctx.lon;
    } else {
      this.lat = null;
      this.lon = null;
      this.report = null;
      this.lastReportKey = null;
    }
    if (ctx.landingDate) {
      this.landingDate = ctx.landingDate;
    }

    this.render();

    if (autoGenerate && this.lat !== null && this.lon !== null) {
      const currentKey = this._getCurrentRequestKey();
      if (forceRefresh || !this.report || this.lastReportKey !== currentKey) {
        this.generateReport();
      }
    }
  }

  onTabActivated() {
    this.syncFromActiveMission({ autoGenerate: true });
  }

  onMissionChanged({ isTabOpen = false } = {}) {
    this.syncFromActiveMission({ autoGenerate: isTabOpen });
  }

  _clearLoadingTimers() {
    for (const timer of this._loadingTimers) {
      clearTimeout(timer);
    }
    this._loadingTimers = [];
  }

  _clearTypingTimer() {
    if (this._typingTimer) {
      clearInterval(this._typingTimer);
      this._typingTimer = null;
    }
  }

  async generateReport() {
    if (this.lat === null || this.lon === null) {
      this.errorMsg = null;
      this.report = null;
      this.render();
      return;
    }

    const numLat = Number(this.lat);
    const numLon = Number(this.lon);
    if (!Number.isFinite(numLat) || numLat < -90 || numLat > 90) {
      this.errorMsg = 'INVALID LATITUDE: Must be between -90° and +90°.';
      this.render();
      return;
    }
    if (!Number.isFinite(numLon) || numLon < -180 || numLon > 180) {
      this.errorMsg = 'INVALID LONGITUDE: Must be between -180° and +180°.';
      this.render();
      return;
    }

    const cleanDate = toIsoDateYmd(this.landingDate);
    const cleanWindow = this.windowDays;

    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();
    const seq = ++this._requestSeq;

    this._clearLoadingTimers();
    this._clearTypingTimer();
    this.isLoading = true;
    this.errorMsg = null;
    this.loadingStage = 1;
    this.render();

    this._loadingTimers.push(
      setTimeout(() => {
        if (seq === this._requestSeq && this.isLoading) {
          this.loadingStage = 2;
          this.render();
        }
      }, 280),
      setTimeout(() => {
        if (seq === this._requestSeq && this.isLoading) {
          this.loadingStage = 3;
          this.render();
        }
      }, 700)
    );

    try {
      const nextReport = await fetchMissionReport({
        lat: numLat,
        lon: numLon,
        landingDate: cleanDate,
        windowDays: cleanWindow,
        signal: this._abortController.signal,
      });

      if (seq !== this._requestSeq) return;

      this.report = nextReport;
      this.lastReportKey = this._getCurrentRequestKey(numLat, numLon, cleanDate, cleanWindow);
      this.activeReportTab = nextReport.favorable.length === 0 ? 'risks' : 'favorable';
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== this._requestSeq) return;
      this.errorMsg = err?.message || 'FAILED_TO_GENERATE_REPORT';
    } finally {
      if (seq === this._requestSeq) {
        this._clearLoadingTimers();
        this.isLoading = false;
        this.render({ animateSummary: Boolean(this.report && !this.errorMsg) });
      }
    }
  }

  _startSummaryTypewriter(fullText) {
    this._clearTypingTimer();
    const summaryEl = this.rootEl?.querySelector('[data-field="ai-summary-text"]');
    if (!summaryEl || !fullText) return;

    let idx = 0;
    const step = Math.max(3, Math.ceil(fullText.length / 40));
    summaryEl.textContent = '';
    this._typingTimer = setInterval(() => {
      idx += step;
      if (idx >= fullText.length) {
        summaryEl.textContent = fullText;
        this._clearTypingTimer();
      } else {
        summaryEl.textContent = fullText.slice(0, idx);
      }
    }, 16);
  }

  _buildDOM() {
    this.rootEl = document.createElement('div');
    this.rootEl.className = 'ai-report-panel';
    this.container.appendChild(this.rootEl);
  }

  _bindEvents() {
    this.rootEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ai-action]');
      if (!btn) return;
      const action = btn.dataset.aiAction;

      switch (action) {
        case 'refresh-report':
          this.syncFromActiveMission({ autoGenerate: true, forceRefresh: true });
          break;
        case 'switch-report-tab': {
          const tab = btn.dataset.reportTab;
          if (tab && ['favorable', 'risks', 'sources'].includes(tab)) {
            this.activeReportTab = tab;
            this.render();
          }
          break;
        }
        case 'fly-to-report-site': {
          const nLat = Number(this.lat);
          const nLon = Number(this.lon);
          if (Number.isFinite(nLat) && Number.isFinite(nLon)) {
            this.onFlyTo?.(nLat, nLon, 60);
          }
          break;
        }
        default:
          break;
      }
    });
  }

  render({ animateSummary = false } = {}) {
    if (!this.rootEl) return;
    this._clearTypingTimer();

    const ctx = this.syncedMission || this._buildMissionContext();
    const hasCoords = this.lat !== null && this.lon !== null;

    const missionHeaderHtml = ctx.hasMission
      ? `
        <div class="ai-mission-sync-bar">
          <div class="ai-sync-left">
            <span class="ai-sync-pill is-synced">ACTIVE MISSION</span>
            <span class="ai-sync-mission-name">${escapeHtml(ctx.missionName)}</span>
            <span class="ai-sync-meta-inline">
              ${hasCoords ? escapeHtml(formatCoords(this.lat, this.lon)) : 'Landing Site Unset'}
              · ${escapeHtml(this.landingDate)} UTC
              ${ctx.rocket ? ` · ${escapeHtml(ctx.rocket)}` : ''}
              ${ctx.transitDurationSec !== null ? ` · Transit ${escapeHtml(formatTransitDuration(ctx.transitDurationSec))}` : ''}
            </span>
          </div>
          ${
            hasCoords
              ? `<div class="ai-sync-actions">
                  <button
                    type="button"
                    class="ai-mini-btn ai-mini-btn--primary"
                    data-ai-action="refresh-report"
                    ${this.isLoading ? 'disabled' : ''}
                    title="Recompute report for active mission telemetry"
                  >
                    ${this.isLoading ? 'Running...' : 'Refresh'}
                  </button>
                </div>`
              : ''
          }
        </div>
      `
      : '';

    const noTargetHtml = !hasCoords
      ? `
        <div class="ai-empty-state">
          <div class="ai-empty-title">NO LANDING TARGET FOR ACTIVE MISSION</div>
          <p class="ai-empty-desc">
            Select a mission with a configured landing site or right-click on the lunar surface to create one, then open the AI report.
          </p>
        </div>
      `
      : '';

    const errorHtml = this.errorMsg
      ? `
        <div class="ai-error-banner">
          <span>ERROR: ${escapeHtml(this.errorMsg)}</span>
          ${
            hasCoords
              ? `<button type="button" class="ai-mini-btn" data-ai-action="refresh-report">Retry</button>`
              : ''
          }
        </div>
      `
      : '';

    const progressWidth = this.loadingStage === 1 ? '35%' : this.loadingStage === 2 ? '72%' : '92%';
    const loadingHtml = this.isLoading
      ? `
      <section class="ai-loading-card">
        <div class="ai-loading-top">
          <span>NASA GLOBAL LOLA LDEM_64 + DE440 EPHEMERIS</span>
          <span>COMPUTING TELEMETRY PIPELINE...</span>
        </div>
        <div class="ai-loading-frame">
          <div class="ai-loading-header">
            <span class="ai-loading-title">CLPS SIMULATION ACTIVE</span>
            <span class="ai-loading-coords">${Number(this.lat).toFixed(2)}°, ${Number(this.lon).toFixed(2)}° · ${this.windowDays}D</span>
          </div>
          <div class="ai-progress-track">
            <div class="ai-progress-fill" style="width: ${progressWidth}"></div>
          </div>
          <div class="ai-stage-list">
            <div class="ai-stage-row active">
              <span>01 · SAMPLING GLOBAL LDEM_64 ELEVATION &amp; SLOPE</span>
              <span class="ai-stage-badge">${this.loadingStage > 1 ? 'DONE' : 'ACTIVE'}</span>
            </div>
            <div class="ai-stage-row ${this.loadingStage >= 2 ? 'active' : ''}">
              <span>02 · SPHERICAL RAYCASTING &amp; DE440 EPHEMERIS</span>
              <span class="ai-stage-badge">${this.loadingStage > 2 ? 'DONE' : this.loadingStage === 2 ? 'ACTIVE' : 'QUEUED'}</span>
            </div>
            <div class="ai-stage-row ${this.loadingStage >= 3 ? 'active' : ''}">
              <span>03 · EVALUATING CLPS LANDER CONSTRAINTS</span>
              <span class="ai-stage-badge">${this.loadingStage === 3 ? 'ACTIVE' : 'QUEUED'}</span>
            </div>
          </div>
        </div>
      </section>
    `
      : '';

    const reportHtml = !this.isLoading && hasCoords && this.report ? this._renderReport(this.report) : '';

    this.rootEl.innerHTML = `
      <div class="ai-scroll-wrap">
        ${missionHeaderHtml}
        ${noTargetHtml}
        ${errorHtml}
        ${loadingHtml}
        ${reportHtml}
      </div>
    `;

    if (animateSummary && !this.isLoading && this.report?.summary) {
      this._startSummaryTypewriter(this.report.summary);
    }
  }

  _renderReport(report) {
    const timeline = Array.isArray(report.sunlightTimeline) ? report.sunlightTimeline : [];
    const totalHours = timeline.length || 336;
    const midHours = Math.round(totalHours / 2);

    const latMatch = String(report.headline || '').match(/(\d+(?:\.\d+)?)°\s*([NS])/i);
    const absLat = latMatch ? Number.parseFloat(latMatch[1]) : Math.abs(Number(this.lat) || 0);
    const isPolarRegion = absLat >= 75;
    const coordsDisplay = formatHeadlineCoords(report.headline);
    const dateMatch = String(report.meta?.window || '').match(/\((\d{4}-\d{2}-\d{2})\)/);
    const epochDate = dateMatch ? dateMatch[1] : this.landingDate;
    const verdictClass = `ai-verdict--${String(report.verdict || 'conditional').toLowerCase()}`;

    const ctxCardHtml = report.siteContext
      ? `
        <section class="ai-section ai-context-box">
          <div class="ai-context-badge">${escapeHtml(report.siteContext.badge)}</div>
          <div class="ai-context-title">${escapeHtml(report.siteContext.title)}</div>
          <p class="ai-context-desc">${escapeHtml(report.siteContext.description)}</p>
        </section>
      `
      : '';

    const scorecardHtml =
      Array.isArray(report.scoreBreakdown) && report.scoreBreakdown.length > 0
        ? `
        <section class="ai-section">
          <div class="ai-section-header">
            <span class="ai-section-title">ENGINEERING SCORECARD</span>
            <span class="ai-pill-subtle">${escapeHtml(report.scoreBadge)}</span>
          </div>
          <div class="ai-score-table">
            ${report.scoreBreakdown
              .map(
                (row) => `
              <div class="ai-score-row">
                <div class="ai-score-crit">${escapeHtml(row.criterion)}</div>
                <div class="ai-score-val">${escapeHtml(row.value)}</div>
                <div class="ai-score-thresh">Limit ${escapeHtml(row.threshold)}</div>
                <div class="ai-score-margin">${escapeHtml(row.margin)}</div>
                <span class="ai-status-pill ai-status--${String(row.status || '').toLowerCase()}">${escapeHtml(row.status)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </section>
      `
        : '';

    let tabBodyHtml = '';
    if (this.activeReportTab === 'favorable') {
      tabBodyHtml =
        report.favorable?.length > 0
          ? report.favorable
              .map(
                (item) => `
            <div class="ai-finding-item">
              <div class="ai-finding-head">
                <h4>${escapeHtml(item.title)}</h4>
                ${item.tag ? `<span class="ai-finding-tag">${escapeHtml(item.tag)}</span>` : ''}
              </div>
              <p>${escapeHtml(item.body)}</p>
            </div>
          `
              )
              .join('')
          : `<div class="ai-finding-empty">NO ENGINEERING PARAMETERS MET NOMINAL CLPS LANDER MARGINS FOR THIS WINDOW. REVIEW RISKS &amp; CONTINGENCY TAB.</div>`;
    } else if (this.activeReportTab === 'risks') {
      tabBodyHtml =
        report.risks?.length > 0
          ? report.risks
              .map(
                (item) => `
            <div class="ai-finding-item ai-finding-item--risk">
              <div class="ai-finding-head">
                <h4>${escapeHtml(item.title)}</h4>
                ${
                  item.sourceIds?.length > 0
                    ? `<span class="ai-finding-tag">${escapeHtml(item.sourceIds.join(' · ').toUpperCase())}</span>`
                    : ''
                }
              </div>
              <p>${escapeHtml(item.body)}</p>
            </div>
          `
              )
              .join('')
          : `<div class="ai-finding-empty">NO CRITICAL ENGINEERING CONSTRAINTS FLAGGED FOR THIS CONFIGURATION.</div>`;
    } else {
      tabBodyHtml =
        report.sources?.length > 0
          ? report.sources
              .map(
                (src) => `
            <div class="ai-finding-item">
              <div class="ai-finding-head">
                <h4>${escapeHtml(src.id.toUpperCase())} · ${escapeHtml(src.name)}</h4>
                <span class="ai-finding-tag">${escapeHtml(src.domain)}</span>
              </div>
              <p>${escapeHtml(src.usage)}</p>
              <div class="ai-source-foot">
                <span>${escapeHtml(src.publisher)}</span>
                <a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">NASA Reference ↗</a>
              </div>
            </div>
          `
              )
              .join('')
          : '';
    }

    const timelineBlocks = timeline
      .map((lit) => `<div class="ai-solar-seg ${lit === 1 ? 'lit' : 'dark'}"></div>`)
      .join('');

    return `
      <article class="ai-report-article">
        <div class="ai-report-topbar">
          <span>${escapeHtml(report.demResolutionLabel || 'LUNAR GLOBAL DEM')} + DE440 EPHEMERIS</span>
          <span>COMPUTED: ${escapeHtml(report.computedAtUtc)}</span>
        </div>

        <div class="ai-report-card">
          <header class="ai-report-header">
            <div class="ai-badges-row">
              <span class="ai-badge-main">&#9737; MODEL-BACKED REPORT</span>
              <span class="ai-badge-sub">WINDOW: ${escapeHtml(report.meta?.window)}</span>
              <span class="ai-badge-sub">${escapeHtml(report.scoreBadge)}</span>
              <button
                type="button"
                class="ai-fly-btn"
                data-ai-action="fly-to-report-site"
                title="Fly 3D Moon camera to analyzed landing coordinates"
              >
                Fly to Site ⌖
              </button>
            </div>
            <h1 class="ai-report-headline">${escapeHtml(report.headline)}</h1>
          </header>

          <section class="ai-verdict-grid">
            <div class="ai-verdict-box">
              <span class="ai-verdict-label">MISSION VERDICT</span>
              <span class="ai-verdict-pill ${verdictClass}">${escapeHtml(report.verdict)}</span>
            </div>
            <div class="ai-meta-box">
              <div class="ai-meta-row">
                <span>PROFILE</span>
                <strong>${escapeHtml(report.meta?.profile)}</strong>
              </div>
              <div class="ai-meta-row">
                <span>WINDOW</span>
                <strong>${escapeHtml(report.meta?.window)}</strong>
              </div>
              <div class="ai-meta-row">
                <span>RELAY REQUIRED</span>
                <strong>${escapeHtml(report.meta?.relay)}</strong>
              </div>
              <div class="ai-meta-row">
                <span>SYNTHESIS ENGINE</span>
                <strong>${escapeHtml(report.models?.synthesis || 'telemetry')}</strong>
              </div>
            </div>
          </section>

          <section class="ai-section">
            <div class="ai-section-header">
              <span class="ai-section-title">MISSION OVERVIEW</span>
              <span class="ai-pill-subtle">SYNTHESIS</span>
            </div>
            <p class="ai-summary-text" data-field="ai-summary-text">${escapeHtml(report.summary)}</p>
          </section>

          ${ctxCardHtml}

          <section class="ai-section">
            <div class="ai-solar-head">
              <span class="ai-section-title">DAY / NIGHT SOLAR RHYTHM</span>
              <div class="ai-solar-legend">
                <span><i class="ai-dot-lit"></i>SUNLIT</span>
                <span><i class="ai-dot-dark"></i>SHADOW</span>
              </div>
            </div>
            <div class="ai-solar-bar" aria-label="Hourly solar illumination timeline">
              ${timelineBlocks}
            </div>
            <div class="ai-solar-ticks">
              <span>0H (LANDING)</span>
              <span>+${midHours}H</span>
              <span>+${totalHours}H</span>
            </div>
          </section>

          <section class="ai-section">
            <div class="ai-params-head">
              <div class="ai-section-title">INVARIANT TECHNICAL PARAMETERS</div>
              <div class="ai-params-note">${escapeHtml(report.demUncertaintyNote)}</div>
            </div>
            <div class="ai-params-grid">
              <div class="ai-param-col">
                <div class="ai-param-col-title">1. TOPOGRAPHY &amp; HORIZ</div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">SLOPE</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.slope)} <span>${escapeHtml(report.params?.slopeNote)}</span></div>
                </div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">ELEVATION</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.elevation)}</div>
                </div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">HORIZON BLOCK</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.horizon)}</div>
                </div>
              </div>

              <div class="ai-param-col">
                <div class="ai-param-col-title">2. SOLAR &amp; POWER</div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">TOTAL SUNLIGHT</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.sunlight)}</div>
                </div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">PEAK SUN ELEV</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.peakElev)}</div>
                </div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">MAX ECLIPSE</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.eclipse)}</div>
                </div>
              </div>

              <div class="ai-param-col">
                <div class="ai-param-col-title">3. COMMS &amp; SCIENCE</div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">DTE UPTIME</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.dte)}</div>
                </div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">MAX BLACKOUT</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.blackout)}</div>
                </div>
                <div class="ai-param-item">
                  <div class="ai-param-lbl">${isPolarRegion ? 'DIST TO PSR ICE' : 'DIST TO NEAREST POLE'}</div>
                  <div class="ai-param-val">${escapeHtml(report.params?.psr)}</div>
                </div>
              </div>
            </div>
          </section>

          ${scorecardHtml}

          <section class="ai-tabs-section">
            <div class="ai-findings-tabs">
              <button
                type="button"
                class="ai-tab-btn ${this.activeReportTab === 'favorable' ? 'active' : ''}"
                data-ai-action="switch-report-tab"
                data-report-tab="favorable"
              >
                <span>+ FAVORABLE (${report.favorable?.length || 0})</span>
              </button>
              <button
                type="button"
                class="ai-tab-btn ${this.activeReportTab === 'risks' ? 'active' : ''}"
                data-ai-action="switch-report-tab"
                data-report-tab="risks"
              >
                <span>&#9888; RISKS (${report.risks?.length || 0})</span>
              </button>
              <button
                type="button"
                class="ai-tab-btn ${this.activeReportTab === 'sources' ? 'active' : ''}"
                data-ai-action="switch-report-tab"
                data-report-tab="sources"
              >
                <span>SOURCES (${report.sources?.length || 0})</span>
              </button>
            </div>
            <div class="ai-findings-body">
              ${tabBodyHtml}
            </div>
          </section>
        </div>

        <footer class="ai-report-footer">
          <span>LUNAR GLOBAL LANDING DECISION SUPPORT SYSTEM</span>
          <span>COORDINATES: ${escapeHtml(coordsDisplay)} | EPOCH: ${escapeHtml(epochDate)}T00:00:00Z</span>
        </footer>
      </article>
    `;
  }
}
