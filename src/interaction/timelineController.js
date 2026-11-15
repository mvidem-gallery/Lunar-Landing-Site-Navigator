import './timelineController.css';

const SPEED_PRESETS = [
  { label: '1×', multiplier: 1 },
  { label: '60×', multiplier: 60 },
  { label: '15m/s', multiplier: 900 },
  { label: '1h/s', multiplier: 3600 },
  { label: '3h/s', multiplier: 10800 },
  { label: '6h/s', multiplier: 21600 },
  { label: '1d/s', multiplier: 86400 },
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SHORT_EVENT_LABELS = {
  launch: 'T0',
  tli: 'TLI',
  loi: 'LOI',
  doi: 'DOI',
  pdi: 'PDI',
  touchdown: 'TD',
};

export class TimelineController {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - контейнер .timeline-bar або dock
   * @param {Date} [options.initialDate]
   * @param {Function} options.onDatePreview - швидке оновлення при скрабі/програванні
   * @param {Function} options.onDateCommit - точний запит (напр. JPL Horizons) при завершенні скрабу/виборі
   * @param {Function} [options.onPlayStateChange] - сповіщення про зміну стану відтворення
   */
  constructor({
    container,
    initialDate = new Date(),
    onDatePreview,
    onDateCommit,
    onPlayStateChange,
  }) {
    this.container = container;
    this.currentDate = new Date(initialDate.getTime());
    this.onDatePreview = onDatePreview;
    this.onDateCommit = onDateCommit;
    this.onPlayStateChange = onPlayStateChange;

    // Видимий діапазон шкали (мс), за замовчуванням ~28 діб
    this.spanMs = 28 * 86400 * 1000;
    this.minSpanMs = 30 * 60 * 1000; // 30 хвилин
    this.maxSpanMs = 180 * 86400 * 1000; // 180 діб

    // Положення бігунка на екрані (частка ширини: 0.14 щоб центр дати був як на макеті зліва)
    this.playheadRatio = 0.12;

    this.isPlaying = false;
    this.speedIndex = 3; // 1h/s за замовчуванням для наочного руху тіні
    this._lastRafTime = 0;
    this._rafId = null;

    this._isDragging = false;
    this._dragStartX = 0;
    this._dragStartMs = 0;
    this._commitDebounceTimer = null;
    this._lastPlayCommitTime = 0;
    this.trajectoryWindow = null;

    this._buildDOM();
    this._bindEvents();
    this.render();
  }

  _buildDOM() {
    this.barEl = document.createElement('div');
    this.barEl.className = 'timeline-bar';
    this.barEl.innerHTML = `
      <div class="timeline-controls-box">
        <div class="timeline-transport-row">
          <div class="timeline-btn-group">
            <button type="button" class="tl-btn" data-action="step-back" title="Step back">&lt;</button>
            <button type="button" class="tl-btn" data-action="play-pause" title="Play / Pause (Space)">PLAY</button>
            <button type="button" class="tl-btn" data-action="step-forward" title="Step forward">&gt;</button>
          </div>
          <div class="timeline-btn-group">
            <button type="button" class="tl-btn tl-speed-btn" data-action="cycle-speed" title="Cycle time speed">1h/s</button>
            <button type="button" class="tl-btn tl-now-btn" data-action="now" title="Current UTC time">NOW</button>
          </div>
        </div>
        <div class="timeline-date-row">
          <span class="timeline-utc-readout" data-field="utc-readout" title="Click to pick exact UTC date">—</span>
          <input type="datetime-local" class="timeline-hidden-picker" data-field="date-input" />
        </div>
      </div>

      <div class="timeline-track-wrap" data-field="track-wrap" title="Drag to scrub time, scroll wheel to zoom timeline scale">
        <canvas class="timeline-canvas" data-field="canvas"></canvas>
        <span class="timeline-zoom-hint" data-field="span-hint">28d</span>
      </div>
    `;

    this.container.appendChild(this.barEl);

    this.stepBackBtn = this.barEl.querySelector('[data-action="step-back"]');
    this.playPauseBtn = this.barEl.querySelector('[data-action="play-pause"]');
    this.stepForwardBtn = this.barEl.querySelector('[data-action="step-forward"]');
    this.speedBtn = this.barEl.querySelector('[data-action="cycle-speed"]');
    this.nowBtn = this.barEl.querySelector('[data-action="now"]');
    this.utcReadoutEl = this.barEl.querySelector('[data-field="utc-readout"]');
    this.dateInputEl = this.barEl.querySelector('[data-field="date-input"]');
    this.trackWrapEl = this.barEl.querySelector('[data-field="track-wrap"]');
    this.canvasEl = this.barEl.querySelector('[data-field="canvas"]');
    this.spanHintEl = this.barEl.querySelector('[data-field="span-hint"]');
    this.ctx = this.canvasEl.getContext('2d');
  }

  _bindEvents() {
    this.playPauseBtn.addEventListener('click', () => this.togglePlay());

    this.speedBtn.addEventListener('click', () => {
      this.speedIndex = (this.speedIndex + 1) % SPEED_PRESETS.length;
      this.speedBtn.textContent = SPEED_PRESETS[this.speedIndex].label;
    });

    this.stepBackBtn.addEventListener('click', () => {
      const stepMs = this._getStepMs();
      this.setDate(new Date(this.currentDate.getTime() - stepMs), true);
    });

    this.stepForwardBtn.addEventListener('click', () => {
      const stepMs = this._getStepMs();
      this.setDate(new Date(this.currentDate.getTime() + stepMs), true);
    });

    this.nowBtn.addEventListener('click', () => {
      this.pause();
      if (this.trajectoryWindow) {
        this.setDate(new Date(this.trajectoryWindow.startMs), true);
        return;
      }
      this.setDate(new Date(), true);
    });

    this.utcReadoutEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dateInputEl.value = this.currentDate.toISOString().slice(0, 16);
      this.dateInputEl.classList.toggle('open');
      if (this.dateInputEl.classList.contains('open')) {
        this.dateInputEl.focus();
      }
    });

    this.dateInputEl.addEventListener('change', () => {
      if (this.dateInputEl.value) {
        const utcDate = new Date(this.dateInputEl.value + 'Z');
        if (!Number.isNaN(utcDate.getTime())) {
          this.pause();
          this.setDate(utcDate, true);
        }
      }
      this.dateInputEl.classList.remove('open');
    });

    window.addEventListener('pointerdown', (e) => {
      if (!this.dateInputEl.contains(e.target) && e.target !== this.utcReadoutEl) {
        this.dateInputEl.classList.remove('open');
      }
    });

    this.trackWrapEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._isDragging = true;
      this._dragStartX = e.clientX;
      this._dragStartMs = this.currentDate.getTime();
      this.trackWrapEl.classList.add('dragging');
      this.trackWrapEl.setPointerCapture(e.pointerId);
      if (this.isPlaying) {
        this.pause();
      }
    });

    this.trackWrapEl.addEventListener('pointermove', (e) => {
      if (!this._isDragging) return;
      const rect = this.trackWrapEl.getBoundingClientRect();
      if (rect.width <= 0) return;

      const deltaPx = e.clientX - this._dragStartX;
      // Перетягування шкали вліво рухає час вперед (як у часовій стрічці)
      const deltaMs = -(deltaPx / rect.width) * this.spanMs;
      this.setDate(new Date(this._dragStartMs + deltaMs), false);
      this._scheduleDebouncedCommit();
    });

    const endDrag = (e) => {
      if (!this._isDragging) return;
      this._isDragging = false;
      this.trackWrapEl.classList.remove('dragging');
      try {
        this.trackWrapEl.releasePointerCapture(e.pointerId);
      } catch {
        // ігноруємо
      }
      this._scheduleDebouncedCommit(180);
    };

    this.trackWrapEl.addEventListener('pointerup', endDrag);
    this.trackWrapEl.addEventListener('pointercancel', endDrag);

    this.trackWrapEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.25 : 0.8;
        this.spanMs = Math.max(this.minSpanMs, Math.min(this.maxSpanMs, this.spanMs * factor));
        this.render();
      },
      { passive: false }
    );

    window.addEventListener('resize', () => this.render());

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.togglePlay();
      }
    });
  }

  _clampMsToTrajectory(ms) {
    if (!this.trajectoryWindow) return ms;
    return Math.max(this.trajectoryWindow.startMs, Math.min(this.trajectoryWindow.endMs, ms));
  }

  setTrajectoryWindow(windowConfig) {
    clearTimeout(this._commitDebounceTimer);
    if (!windowConfig) {
      this.trajectoryWindow = null;
      this.nowBtn.textContent = 'NOW';
      this.nowBtn.title = 'Current UTC time';
      this.nowBtn.classList.remove('traj-t0');
      this.render();
      return;
    }
    const startMs = Number(windowConfig.startMs);
    const endMs = Math.max(startMs, Number(windowConfig.endMs));
    this.trajectoryWindow = {
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      phases: Array.isArray(windowConfig.phases) ? windowConfig.phases : [],
      events: Array.isArray(windowConfig.events) ? windowConfig.events : [],
    };
    this.nowBtn.textContent = 'T0';
    this.nowBtn.title = 'Jump to Launch (T0)';
    this.nowBtn.classList.add('traj-t0');
    this.currentDate = new Date(this._clampMsToTrajectory(this.currentDate.getTime()));
    this.render();
  }

  setSpanMs(spanMs) {
    if (!Number.isFinite(spanMs)) return;
    this.spanMs = Math.max(this.minSpanMs, Math.min(this.maxSpanMs, spanMs));
    this.render();
  }

  setSpeedByLabel(label) {
    const idx = SPEED_PRESETS.findIndex((p) => p.label === label);
    if (idx !== -1) {
      this.speedIndex = idx;
      this.speedBtn.textContent = SPEED_PRESETS[this.speedIndex].label;
    }
  }

  setSpeedIndex(index) {
    if (Number.isInteger(index) && index >= 0 && index < SPEED_PRESETS.length) {
      this.speedIndex = index;
      this.speedBtn.textContent = SPEED_PRESETS[this.speedIndex].label;
    }
  }

  getSpeedLabel() {
    return SPEED_PRESETS[this.speedIndex]?.label || '1h/s';
  }

  _getStepMs() {
    if (this.spanMs <= 2 * 3600 * 1000) return 300 * 1000; // 5 хв
    if (this.spanMs <= 8 * 3600 * 1000) return 900 * 1000; // 15 хв
    if (this.spanMs <= 24 * 3600 * 1000) return 3600 * 1000; // 1 год
    if (this.spanMs <= 10 * 86400 * 1000) return 6 * 3600 * 1000; // 6 год
    return 86400 * 1000; // 1 доба
  }

  _scheduleDebouncedCommit(delayMs = 420) {
    clearTimeout(this._commitDebounceTimer);
    this._commitDebounceTimer = setTimeout(() => {
      if (typeof this.onDateCommit === 'function') {
        this.onDateCommit(new Date(this.currentDate.getTime()));
      }
    }, delayMs);
  }

  setDate(date, commitImmediately = false) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
    const clampedMs = this._clampMsToTrajectory(date.getTime());
    this.currentDate = new Date(clampedMs);
    this.render();

    if (commitImmediately) {
      clearTimeout(this._commitDebounceTimer);
      if (typeof this.onDateCommit === 'function') {
        this.onDateCommit(new Date(this.currentDate.getTime()));
      }
    } else if (typeof this.onDatePreview === 'function') {
      this.onDatePreview(new Date(this.currentDate.getTime()));
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.playPauseBtn.textContent = 'PAUSE';
    this.playPauseBtn.classList.add('playing');
    this.onPlayStateChange?.(true);
    this._lastRafTime = performance.now();
    this._lastPlayCommitTime = performance.now();

    const step = (now) => {
      if (!this.isPlaying) return;
      const dtSec = Math.min(0.1, (now - this._lastRafTime) / 1000);
      this._lastRafTime = now;

      const mult = SPEED_PRESETS[this.speedIndex].multiplier;
      let nextMs = this.currentDate.getTime() + dtSec * mult * 1000;
      if (this.trajectoryWindow && this.trajectoryWindow.durationMs > 0) {
        const { startMs, endMs, durationMs } = this.trajectoryWindow;
        if (nextMs > endMs) {
          nextMs = startMs + ((nextMs - startMs) % durationMs);
        }
      }
      this.currentDate = new Date(nextMs);
      this.render();

      if (typeof this.onDatePreview === 'function') {
        this.onDatePreview(new Date(this.currentDate.getTime()));
      }

      if (!this.trajectoryWindow && now - this._lastPlayCommitTime > 2500) {
        this._lastPlayCommitTime = now;
        if (typeof this.onDateCommit === 'function') {
          this.onDateCommit(new Date(this.currentDate.getTime()));
        }
      }

      this._rafId = requestAnimationFrame(step);
    };

    this._rafId = requestAnimationFrame(step);
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.playPauseBtn.textContent = 'PLAY';
    this.playPauseBtn.classList.remove('playing');
    this.onPlayStateChange?.(false);
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._scheduleDebouncedCommit(150);
  }

  _formatUtcTimestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getUTCFullYear();
    const m = pad(date.getUTCMonth() + 1);
    const d = pad(date.getUTCDate());
    const hh = pad(date.getUTCHours());
    const mm = pad(date.getUTCMinutes());
    const ss = pad(date.getUTCSeconds());
    return `${y}-${m}-${d} ${hh}:${mm}:${ss} UTC`;
  }

  _formatSpanHint(spanMs) {
    const mins = spanMs / 60000;
    if (mins < 90) return `${Math.round(mins)}m`;
    const hours = spanMs / 3600000;
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  }

  _formatTickLabel(ms, majorStepMs) {
    const d = new Date(ms);
    const mon = MONTHS_SHORT[d.getUTCMonth()];
    const day = d.getUTCDate();
    const year = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');

    if (majorStepMs >= 86400 * 1000) {
      return `${mon} ${day} ${year} ${hh}:${mm}:00 UTC`;
    }
    return `${mon} ${day} ${hh}:${mm} UTC`;
  }

  _pickTickIntervals(widthPx) {
    const candidates = [
      { major: 300 * 1000, minor: 60 * 1000 }, // 5m / 1m
      { major: 900 * 1000, minor: 300 * 1000 }, // 15m / 5m
      { major: 3600 * 1000, minor: 900 * 1000 }, // 1h / 15m
      { major: 3 * 3600 * 1000, minor: 3600 * 1000 }, // 3h / 1h
      { major: 6 * 3600 * 1000, minor: 3600 * 1000 }, // 6h / 1h
      { major: 12 * 3600 * 1000, minor: 3 * 3600 * 1000 }, // 12h / 3h
      { major: 24 * 3600 * 1000, minor: 6 * 3600 * 1000 }, // 1d / 6h
      { major: 3 * 86400 * 1000, minor: 12 * 3600 * 1000 }, // 3d / 12h
      { major: 7 * 86400 * 1000, minor: 86400 * 1000 }, // 7d / 1d
      { major: 14 * 86400 * 1000, minor: 2 * 86400 * 1000 }, // 14d / 2d
      { major: 30 * 86400 * 1000, minor: 5 * 86400 * 1000 }, // 30d / 5d
    ];

    const targetMinSpacingPx = 155;
    for (const c of candidates) {
      const spacingPx = (c.major / this.spanMs) * widthPx;
      if (spacingPx >= targetMinSpacingPx) {
        return c;
      }
    }
    return candidates[candidates.length - 1];
  }

  render() {
    this.utcReadoutEl.textContent = this._formatUtcTimestamp(this.currentDate);
    this.spanHintEl.textContent = this._formatSpanHint(this.spanMs);

    const rect = this.trackWrapEl.getBoundingClientRect();
    const width = Math.max(100, Math.floor(rect.width));
    const height = Math.max(40, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (this.canvasEl.width !== width * dpr || this.canvasEl.height !== height * dpr) {
      this.canvasEl.width = width * dpr;
      this.canvasEl.height = height * dpr;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const nowMs = this.currentDate.getTime();
    const playheadX = width * this.playheadRatio;
    const startMs = nowMs - this.playheadRatio * this.spanMs;
    const endMs = startMs + this.spanMs;

    const { major, minor } = this._pickTickIntervals(width);

    // Горизонтальна лінія основи
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 18);
    ctx.lineTo(width, height - 18);
    ctx.stroke();

    // Дрібні поділки
    const firstMinor = Math.floor(startMs / minor) * minor;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    for (let t = firstMinor; t <= endMs; t += minor) {
      const x = ((t - startMs) / this.spanMs) * width;
      if (x < 0 || x > width) continue;
      ctx.beginPath();
      ctx.moveTo(x, height - 18);
      ctx.lineTo(x, height - 11);
      ctx.stroke();
    }

    // Головні поділки + підписи дат
    const firstMajor = Math.floor(startMs / major) * major;
    ctx.font = '500 10px "JetBrains Mono", "SFMono-Regular", Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    for (let t = firstMajor; t <= endMs; t += major) {
      const x = ((t - startMs) / this.spanMs) * width;
      if (x < -40 || x > width + 40) continue;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, height - 6);
      ctx.stroke();

      ctx.fillStyle = '#94a0b0';
      ctx.fillText(this._formatTickLabel(t, major), x + 5, 5);
    }

    // У режимі траєкторії малюємо смугу фаз місії та маркерів подій на шкалі часу
    if (this.trajectoryWindow && this.trajectoryWindow.durationMs > 0) {
      const { startMs: trajStartMs, endMs: trajEndMs, phases, events } = this.trajectoryWindow;
      const bandLeft = ((trajStartMs - startMs) / this.spanMs) * width;
      const bandRight = ((trajEndMs - startMs) / this.spanMs) * width;

      // Приглушення за межами часового вікна місії
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      if (bandLeft > 0) {
        ctx.fillRect(0, 0, Math.min(width, bandLeft), height);
      }
      if (bandRight < width) {
        const rx = Math.max(0, bandRight);
        ctx.fillRect(rx, 0, width - rx, height);
      }

      // Кольорова стрічка фаз польоту над лінією шкали
      const barY = height - 20;
      for (const seg of phases) {
        const x0 = ((seg.startMs - startMs) / this.spanMs) * width;
        const x1 = ((seg.endMs - startMs) / this.spanMs) * width;
        if (x1 < 0 || x0 > width) continue;
        const cx0 = Math.max(0, x0);
        const cx1 = Math.min(width, x1);
        ctx.save();
        ctx.strokeStyle = seg.colorCss || '#34d399';
        ctx.lineWidth = 3.2;
        if (seg.isCompressed) {
          ctx.setLineDash([5, 4]);
        }
        ctx.beginPath();
        ctx.moveTo(cx0, barY);
        ctx.lineTo(Math.max(cx0 + 1, cx1), barY);
        ctx.stroke();
        ctx.restore();
      }

      // Віхи місії (T0, TLI, LOI, DOI, PDI, TD)
      let lastBadgeRight = -Infinity;
      ctx.font = '600 9px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const ev of events) {
        const ex = ((ev.ms - startMs) / this.spanMs) * width;
        if (ex < -20 || ex > width + 20) continue;

        ctx.fillStyle = ev.colorCss || '#38bdf8';
        ctx.beginPath();
        ctx.arc(ex, barY, 3, 0, Math.PI * 2);
        ctx.fill();

        const shortLabel = SHORT_EVENT_LABELS[ev.name] || ev.name?.toUpperCase() || '';
        if (!shortLabel) continue;
        const labelWidth = ctx.measureText(shortLabel).width + 8;
        if (ex - labelWidth * 0.5 > lastBadgeRight + 4) {
          const badgeY = height - 32;
          ctx.fillStyle = 'rgba(8, 10, 13, 0.94)';
          ctx.fillRect(ex - labelWidth * 0.5, badgeY - 7, labelWidth, 14);
          ctx.strokeStyle = ev.colorCss || '#38bdf8';
          ctx.lineWidth = 1;
          ctx.strokeRect(ex - labelWidth * 0.5, badgeY - 7, labelWidth, 14);
          ctx.fillStyle = '#f4f7fa';
          ctx.fillText(shortLabel, ex, badgeY + 0.5);
          lastBadgeRight = ex + labelWidth * 0.5;
        }
      }
    }

    // Вертикальний бігунок поточного часу (червоно-кораловий індикатор як на макеті)
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Наконечник бігунка
    ctx.fillStyle = '#f4f7fa';
    ctx.beginPath();
    ctx.moveTo(playheadX - 4, height - 24);
    ctx.lineTo(playheadX + 4, height - 24);
    ctx.lineTo(playheadX, height - 17);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  dispose() {
    this.pause();
    clearTimeout(this._commitDebounceTimer);
    this.barEl?.remove();
  }
}
