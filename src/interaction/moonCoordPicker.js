import * as THREE from 'three';
import { MOON_CONFIG } from '../config/constants.js';

export class MoonCoordPicker {
  /**
   * @param {Object} options
   * @param {THREE.Camera} options.camera
   * @param {THREE.Object3D} options.moonGroup
   * @param {HTMLElement | null} [options.domElement]
   * @param {Function | null} [options.onBeforeStart]
   */
  constructor({ camera, moonGroup, domElement = null, onBeforeStart = null }) {
    this.camera = camera;
    this.moonGroup = moonGroup;
    this.domElement = domElement || document.getElementById('canvas-container');
    this.onBeforeStart = onBeforeStart;

    this.isActive = false;
    this.targetKey = null;
    this._onPick = null;
    this._onCancel = null;
    this._downPos = null;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._moonSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), MOON_CONFIG.RADIUS);
    this._hitPoint = new THREE.Vector3();

    this._buildDOM();
    this._bindEvents();
  }

  _buildDOM() {
    this.bannerEl = document.createElement('div');
    this.bannerEl.className = 'moon-picker-banner';
    this.bannerEl.setAttribute('role', 'status');
    this.bannerEl.innerHTML = `
      <span class="moon-picker-dot" aria-hidden="true"></span>
      <span class="moon-picker-text">
        <strong data-field="label">Click on the Moon to pick coordinates</strong>
        <span class="moon-picker-sub">Drag to rotate · Right-click or ESC to cancel</span>
      </span>
      <button type="button" class="moon-picker-cancel" data-action="cancel">CANCEL</button>
    `;
    document.body.appendChild(this.bannerEl);

    this.labelEl = this.bannerEl.querySelector('[data-field="label"]');
    this.cancelBtn = this.bannerEl.querySelector('[data-action="cancel"]');

    this.cursorPillEl = document.createElement('div');
    this.cursorPillEl.className = 'moon-picker-cursor-pill';
    document.body.appendChild(this.cursorPillEl);
  }

  _bindEvents() {
    this.cancelBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cancel();
    });

    this._onPointerDown = (e) => {
      if (!this.isActive || e.button !== 0) return;
      if (!this.domElement || !this.domElement.contains(e.target)) return;
      this._downPos = { x: e.clientX, y: e.clientY };
    };

    this._onPointerUp = (e) => {
      if (!this.isActive || e.button !== 0 || !this._downPos) return;
      const moveDist = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      this._downPos = null;
      if (moveDist > 5) return;
      if (!this.domElement || !this.domElement.contains(e.target)) return;

      const coords = this._raycastMoonLatLon(e.clientX, e.clientY);
      if (!coords) return;

      e.preventDefault();
      e.stopPropagation();
      const cb = this._onPick;
      this._deactivate(false);
      cb?.(coords);
    };

    this._onPointerMove = (e) => {
      if (!this.isActive) return;
      if (!this.domElement || !this.domElement.contains(e.target)) {
        this.cursorPillEl.style.display = 'none';
        return;
      }
      const coords = this._raycastMoonLatLon(e.clientX, e.clientY);
      if (!coords) {
        this.cursorPillEl.style.display = 'none';
        return;
      }
      const latDir = coords.lat >= 0 ? 'N' : 'S';
      const lonDir = coords.lon >= 0 ? 'E' : 'W';
      this.cursorPillEl.textContent = `${Math.abs(coords.lat).toFixed(4)}°${latDir}, ${Math.abs(coords.lon).toFixed(4)}°${lonDir}`;
      this.cursorPillEl.style.left = `${e.clientX + 14}px`;
      this.cursorPillEl.style.top = `${e.clientY + 14}px`;
      this.cursorPillEl.style.display = 'block';
    };

    this._onContextMenu = (e) => {
      if (!this.isActive) return;
      if (this.domElement && this.domElement.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      }
    };

    this._onKeyDown = (e) => {
      if (!this.isActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      }
    };

    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointerup', this._onPointerUp, { capture: true });
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('contextmenu', this._onContextMenu, { capture: true });
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
  }

  _getCanvasRect() {
    const target = this.domElement?.querySelector('canvas') || this.domElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  _raycastMoonLatLon(clientX, clientY) {
    if (!this.camera || !this.moonGroup) return null;
    const rect = this._getCanvasRect();
    if (
      clientX < rect.left ||
      clientX > rect.left + rect.width ||
      clientY < rect.top ||
      clientY > rect.top + rect.height
    ) {
      return null;
    }

    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.camera.updateMatrixWorld();
    this.moonGroup.updateWorldMatrix(true, false);
    this._moonSphere.center.setFromMatrixPosition(this.moonGroup.matrixWorld);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this._raycaster.ray.intersectSphere(this._moonSphere, this._hitPoint);
    if (!hit) return null;

    const localNormal = this.moonGroup.worldToLocal(hit.clone()).normalize();
    const lat = Number(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(localNormal.y, -1, 1))).toFixed(4));
    const lon = Number(THREE.MathUtils.radToDeg(Math.atan2(-localNormal.z, localNormal.x)).toFixed(4));
    return { lat, lon };
  }

  startPicking({ targetKey = null, label = '', onPick, onCancel = null } = {}) {
    if (this.isActive && targetKey && this.targetKey === targetKey) {
      this.cancel();
      return false;
    }
    if (this.isActive) {
      this._deactivate(true);
    }

    this.onBeforeStart?.();

    this.isActive = true;
    this.targetKey = targetKey;
    this._onPick = typeof onPick === 'function' ? onPick : null;
    this._onCancel = typeof onCancel === 'function' ? onCancel : null;
    this._downPos = null;

    if (this.labelEl) {
      this.labelEl.textContent = label || 'Click on the Moon to pick coordinates';
    }
    this.bannerEl.classList.add('visible');
    if (this.domElement) {
      this.domElement.style.cursor = 'crosshair';
    }
    return true;
  }

  cancel() {
    if (!this.isActive) return;
    this._deactivate(true);
  }

  _deactivate(notifyCancel) {
    const cancelCb = notifyCancel ? this._onCancel : null;
    this.isActive = false;
    this.targetKey = null;
    this._onPick = null;
    this._onCancel = null;
    this._downPos = null;
    this.bannerEl.classList.remove('visible');
    this.cursorPillEl.style.display = 'none';
    if (this.domElement) {
      this.domElement.style.cursor = '';
    }
    cancelCb?.();
  }

  dispose() {
    this._deactivate(false);
    window.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('contextmenu', this._onContextMenu, { capture: true });
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    this.bannerEl?.remove();
    this.cursorPillEl?.remove();
  }
}
