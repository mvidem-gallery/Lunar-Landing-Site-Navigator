import './dashboardModal.css';

export class DashboardModal {
  constructor() {
    this.isOpen = false;
    this.currentUrl = '';
    this._openSeq = 0;
    this._iframeReady = false;
    this._pendingLogs = [];
    this._fallbackTimer = null;
    this._readyFallbackTimer = null;
    this._closeResetTimer = null;
    this.onOpenCallback = null;
    this.onCloseCallback = null;
    this._buildDOM();
    this._bindEvents();
  }

  _buildDOM() {
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'db-modal-backdrop';
    this.backdropEl.setAttribute('role', 'dialog');
    this.backdropEl.setAttribute('aria-modal', 'true');
    this.backdropEl.setAttribute('aria-label', 'LWP Mission Datatable Dashboard');

    this.backdropEl.innerHTML = `
      <div class="db-modal-topbar">
        <div class="db-modal-title-group">
          <span class="db-modal-badge">LWP // MISSION DATATABLE</span>
          <span class="db-modal-mission" data-field="mission">—</span>
          <span class="db-modal-meta" data-field="meta">—</span>
        </div>
        <div class="db-modal-actions">
          <a
            class="db-modal-btn"
            data-action="open-tab"
            href="./"
            target="_blank"
            rel="noopener noreferrer"
            title="Open Mission Datatable in a separate browser tab"
          >
            Open in Tab
          </a>
          <button
            type="button"
            class="db-modal-btn db-modal-btn-primary"
            data-action="close"
            title="Close dashboard and return to 3D Lunar Globe (Esc)"
          >
            Back to Globe
          </button>
        </div>
      </div>
      <div class="db-modal-frame-wrap">
        <div class="db-modal-loader" aria-live="polite">
          <div class="db-loader-card">
            <div class="db-loader-kicker">LAUNCH WINDOW PREDICTION</div>
            <div class="db-loader-title">LOADING MISSION DATATABLE</div>
            <div class="db-loader-bar-track"><div class="db-loader-bar-fill"></div></div>
            <div class="db-loader-status" data-field="loader-status">RESTORING TELEMETRY LOGS...</div>
          </div>
        </div>
        <iframe
          class="db-modal-iframe"
          title="LWP Mission & Trajectory Analyzer"
        ></iframe>
      </div>
    `;

    this.missionEl = this.backdropEl.querySelector('[data-field="mission"]');
    this.metaEl = this.backdropEl.querySelector('[data-field="meta"]');
    this.openTabLink = this.backdropEl.querySelector('[data-action="open-tab"]');
    this.closeBtn = this.backdropEl.querySelector('[data-action="close"]');
    this.iframeEl = this.backdropEl.querySelector('.db-modal-iframe');
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
    window.addEventListener('message', (event) => {
      if (event.source !== this.iframeEl.contentWindow) return;
      if (event.data?.type === 'LWP_DATATABLE_READY') {
        this._markIframeReady();
      }
    });
  }

  _clearTimers() {
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    if (this._readyFallbackTimer) {
      clearTimeout(this._readyFallbackTimer);
      this._readyFallbackTimer = null;
    }
    if (this._closeResetTimer) {
      clearTimeout(this._closeResetTimer);
      this._closeResetTimer = null;
    }
  }

  buildUrl() {
    const base = import.meta.env?.BASE_URL || '/';
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return `${normalizedBase}datatable/index.html`;
  }

  setStatusMeta(missionTitle, metaText) {
    if (this.missionEl && missionTitle !== undefined) {
      this.missionEl.textContent = missionTitle || 'All Missions';
    }
    if (this.metaEl && metaText !== undefined) {
      this.metaEl.textContent = metaText || '—';
    }
  }

  _markIframeReady() {
    if (this._iframeReady) return;
    this._iframeReady = true;
    if (this._readyFallbackTimer) {
      clearTimeout(this._readyFallbackTimer);
      this._readyFallbackTimer = null;
    }
    this._flushPendingLogs();
  }

  _flushPendingLogs() {
    if (!this._iframeReady || !this.iframeEl.contentWindow || this._pendingLogs.length === 0) {
      return;
    }
    const queue = this._pendingLogs.splice(0, this._pendingLogs.length);
    for (const item of queue) {
      try {
        this.iframeEl.contentWindow.postMessage(
          {
            type: 'LWP_INGEST_LOG',
            filename: item.filename,
            payload: item.payload,
          },
          '*'
        );
      } catch {
        // Ignore postMessage failure
      }
    }
  }

  ingestFlightLog(payload, { filename = null } = {}) {
    if (!payload || typeof payload !== 'object') return;
    const resolvedName =
      filename ||
      payload.files?.flight_log ||
      `flight-${Date.now()}.json`;

    // Replace existing queued item with same filename so the latest log stays at the end
    const idx = this._pendingLogs.findIndex((item) => item.filename === resolvedName);
    if (idx >= 0) {
      this._pendingLogs.splice(idx, 1);
    }
    this._pendingLogs.push({ filename: resolvedName, payload });

    if (this.isOpen && this._iframeReady) {
      this._flushPendingLogs();
    }
  }

  ingestFlightLogs(items = []) {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const entry of items) {
      if (!entry) continue;
      if ('payload' in entry) {
        this.ingestFlightLog(entry.payload, { filename: entry.filename });
      } else {
        this.ingestFlightLog(entry);
      }
    }
  }

  open({ mission = null, flightLogs = [], metaText = null } = {}) {
    this._clearTimers();
    const seq = ++this._openSeq;
    const url = this.buildUrl();
    this.currentUrl = url;

    const missionTitle = mission?.name || 'Mission Comparison & Logs';
    const resolvedMeta =
      metaText ||
      (mission?.modules?.generation?.jobId
        ? `Job ${mission.modules.generation.jobId}`
        : 'Trajectory Δv · Windows · Spaceports');
    this.setStatusMeta(missionTitle, resolvedMeta);

    if (Array.isArray(flightLogs) && flightLogs.length > 0) {
      this.ingestFlightLogs(flightLogs);
    }

    const currentSrc = this.iframeEl.getAttribute('src') || '';
    const needsLoad = !currentSrc || currentSrc === 'about:blank' || currentSrc !== url;

    this.openTabLink.href = url;
    this.isOpen = true;

    if (needsLoad) {
      this._iframeReady = false;
      if (this.loaderStatusEl) {
        this.loaderStatusEl.textContent = 'RESTORING TELEMETRY LOGS...';
      }

      const finishLoading = () => {
        if (seq !== this._openSeq) return;
        if (this._fallbackTimer) {
          clearTimeout(this._fallbackTimer);
          this._fallbackTimer = null;
        }
        this.backdropEl.classList.remove('is-loading');
      };

      const onIframeLoad = () => {
        if (seq !== this._openSeq) return;
        if (this.iframeEl.getAttribute('src') === 'about:blank') return;
        // Fallback in case LWP_DATATABLE_READY was posted before listener attached or blocked
        this._readyFallbackTimer = setTimeout(() => {
          if (seq === this._openSeq) {
            this._markIframeReady();
          }
        }, 300);
        setTimeout(finishLoading, 220);
      };

      this.iframeEl.addEventListener('load', onIframeLoad, { once: true });
      this._fallbackTimer = setTimeout(finishLoading, 8000);
      this.backdropEl.classList.add('open', 'is-loading');
      this.iframeEl.src = url;
    } else {
      this.backdropEl.classList.add('open');
      this.backdropEl.classList.remove('is-loading');
      if (this._iframeReady) {
        this._flushPendingLogs();
      }
    }

    this.closeBtn.focus();
    this.onOpenCallback?.(mission);
  }

  close() {
    if (!this.isOpen) return;
    const seq = ++this._openSeq;
    this._clearTimers();
    this.backdropEl.classList.remove('open', 'is-loading');
    this.isOpen = false;
    this._iframeReady = false;
    this._pendingLogs = [];
    this._closeResetTimer = setTimeout(() => {
      if (seq === this._openSeq && !this.isOpen) {
        this.iframeEl.src = 'about:blank';
      }
    }, 280);
    this.onCloseCallback?.();
  }
}
