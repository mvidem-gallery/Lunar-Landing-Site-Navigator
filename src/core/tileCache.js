import * as THREE from 'three';
import { LOD_CONFIG, MAP_LAYERS } from '../config/constants.js';

export class TileCache {
  constructor() {
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.resolvedTemplates = new Map();
    this.activeLayer = MAP_LAYERS[LOD_CONFIG.DEFAULT_LAYER];

    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');

    this.resolveLayerTemplate(this.activeLayer);
  }

  async resolveLayerTemplate(layer) {
    if (!layer.trekLayerId || this.resolvedTemplates.has(layer.id)) return;

    try {
      const capUrl = `https://trek.nasa.gov/tiles/Moon/EQ/${layer.trekLayerId}/1.0.0/WMTSCapabilities.xml`;
      const response = await fetch(capUrl);
      if (!response.ok) return;

      const xmlText = await response.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      const resourceUrl = xmlDoc.querySelector('ResourceURL');

      if (resourceUrl) {
        const template = resourceUrl.getAttribute('template');
        if (template) {
          const normalized = template
            .replace('{TileMatrix}', '{z}')
            .replace('{TileRow}', '{y}')
            .replace('{TileCol}', '{x}');
          this.resolvedTemplates.set(layer.id, normalized);
        }
      }
    } catch {
      // Якщо CORS або XML недоступний, використовується базовий шаблон
    }
  }

  async setLayer(layerId) {
    if (!MAP_LAYERS[layerId] || this.activeLayer.id === layerId) return;
    this.activeLayer = MAP_LAYERS[layerId];

    this.queue.forEach((task) => { task.aborted = true; });
    this.queue = [];
    this.pending.forEach((task) => { task.aborted = true; });
    this.pending.clear();

    this.cache.forEach((texture) => texture.dispose());
    this.cache.clear();

    await this.resolveLayerTemplate(this.activeLayer);
  }

  getKey(z, x, y) {
    return `${this.activeLayer.id}_${z}_${x}_${y}`;
  }

  get(z, x, y) {
    const key = this.getKey(z, x, y);
    if (this.cache.has(key)) {
      const texture = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, texture);
      return texture;
    }
    return null;
  }

  buildUrl(template, z, x, y, isWebMercatorQuad = false) {
    if (isWebMercatorQuad) {
      // Перетворення з рівнопроміжної сітки (2^(z+1) x 2^z) у стандартну квадратну сітку (2^z x 2^z)
      const qZ = z;
      const qX = Math.floor(x / 2);
      const qY = y;
      return template
        .replace('{z}', qZ)
        .replace('{x}', qX)
        .replace('{y}', qY);
    }

    return template
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y);
  }

  requestTile(z, x, y, priorityDistance, onLoad, onError = null) {
    const key = this.getKey(z, x, y);
    const cached = this.get(z, x, y);
    if (cached) {
      onLoad(cached);
      return;
    }

    if (this.pending.has(key)) {
      const existing = this.pending.get(key);
      existing.callbacks.push(onLoad);
      if (onError) existing.errorCallbacks.push(onError);
      return;
    }

    const isRegionalNac = this.activeLayer.id.startsWith('NAC_');
    const activeTemplate = this.resolvedTemplates.get(this.activeLayer.id) || this.activeLayer.url;

    const useFallbackDirectly =
      (z > this.activeLayer.maxZoom && this.activeLayer.fallbackUrl) ||
      (isRegionalNac && z <= 8 && this.activeLayer.fallbackUrl);

    const primaryUrl = useFallbackDirectly
      ? this.buildUrl(this.activeLayer.fallbackUrl, z, x, y, false)
      : this.buildUrl(activeTemplate, z, x, y, Boolean(this.activeLayer.isWebMercatorQuad));

    // Якщо основний NAC-тайл поверне 404 (наприклад, .jpg замість .png), пробуємо альтернативне розширення
    let altExtUrl = null;
    if (!useFallbackDirectly && isRegionalNac) {
      altExtUrl = primaryUrl.endsWith('.jpg')
        ? primaryUrl.replace(/\.jpg$/, '.png')
        : primaryUrl.replace(/\.png$/, '.jpg');
    }

    const fallbackUrl = (!useFallbackDirectly && !isRegionalNac && this.activeLayer.fallbackUrl)
      ? this.buildUrl(this.activeLayer.fallbackUrl, z, x, y, false)
      : altExtUrl;

    const task = {
      key,
      url: primaryUrl,
      fallbackUrl,
      priority: priorityDistance,
      callbacks: [onLoad],
      errorCallbacks: onError ? [onError] : [],
      aborted: false,
    };

    this.pending.set(key, task);
    this.queue.push(task);
    this.processQueue();
  }

  cancelRequest(z, x, y) {
    const key = this.getKey(z, x, y);
    if (this.pending.has(key)) {
      this.pending.get(key).aborted = true;
      this.pending.delete(key);
    }
  }

  processQueue() {
    if (this.activeRequests >= LOD_CONFIG.MAX_CONCURRENT_REQUESTS || this.queue.length === 0) {
      return;
    }

    this.queue.sort((a, b) => a.priority - b.priority);
    const task = this.queue.shift();

    if (task.aborted) {
      this.processQueue();
      return;
    }

    this.activeRequests++;
    this.loadImageWithFallback(task, task.url, true);
  }

  loadImageWithFallback(task, targetUrl, allowFallback) {
    this.loader.load(
      targetUrl,
      (texture) => {
        this.activeRequests--;
        this.pending.delete(task.key);

        if (task.aborted) {
          texture.dispose();
        } else {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.anisotropy = 8;
          this.put(task.key, texture);
          task.callbacks.forEach((cb) => cb(texture));
        }
        this.processQueue();
      },
      undefined,
      () => {
        if (allowFallback && task.fallbackUrl && !task.aborted) {
          this.loadImageWithFallback(task, task.fallbackUrl, false);
          return;
        }

        this.activeRequests--;
        this.pending.delete(task.key);
        if (!task.aborted) {
          task.errorCallbacks.forEach((cb) => cb());
        }
        this.processQueue();
      }
    );
  }

  put(key, texture) {
    if (this.cache.size >= LOD_CONFIG.CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      const oldestTexture = this.cache.get(oldestKey);
      oldestTexture.dispose();
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, texture);
  }
}