import * as THREE from 'three';
import { LOD_CONFIG } from '../config/constants.js';

export class TileCache {
  constructor(maxSize = LOD_CONFIG.CACHE_SIZE) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.pending = new Map();
    this.inFlight = new Set();
    this.failed = new Set();
    this.resolvedTemplates = new Map();
    this.resolvingPromises = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
  }

  clear() {
    for (const entry of this.queue) {
      entry.aborted = true;
    }
    for (const entry of this.pending.values()) {
      entry.aborted = true;
    }
    for (const entry of this.inFlight) {
      entry.aborted = true;
    }
    this.queue = [];
    this.pending.clear();
    this.failed.clear();
    for (const tex of this.cache.values()) {
      tex.dispose();
    }
    this.cache.clear();
  }

  get(key) {
    if (this.cache.has(key)) {
      const tex = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, tex);
      return tex;
    }
    return null;
  }

  set(key, texture) {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldTex = this.cache.get(oldestKey);
      if (oldTex) oldTex.dispose();
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, texture);
  }

  normalizeWmtsTemplate(rawTemplate) {
    return rawTemplate
      .replace(/\{Style\}/gi, 'default')
      .replace(/\{TileMatrixSet\}/gi, 'default028mm')
      .replace(/\{TileMatrix\}/gi, '{z}')
      .replace(/\{TileRow\}/gi, '{y}')
      .replace(/\{TileCol\}/gi, '{x}');
  }

  async resolveOverlayTemplate(sourceSpec) {
    if (!sourceSpec || !sourceSpec.isOverlay) return;

    if (this.resolvedTemplates.has(sourceSpec.sourceId)) {
      return;
    }

    if (this.resolvingPromises.has(sourceSpec.sourceId)) {
      await this.resolvingPromises.get(sourceSpec.sourceId);
      return;
    }

    const promise = (async () => {
      try {
        let capUrl = null;

        // 1. Отримуємо точний productLabel місії Kaguya через параметр q
        if (sourceSpec.trekDiscoveryQuery) {
          const searchRes = await fetch(sourceSpec.trekDiscoveryQuery);
          if (searchRes.ok) {
            const data = await searchRes.json();
            const docs = data?.response?.docs || [];
            // Обираємо глобальну мозаїку Kaguya (виключаючи DEM/Confidence/Apollo)
            const kaguyaProduct =
              docs.find(
                (d) =>
                  d.productLabel &&
                  d.productLabel.toLowerCase().includes('kaguya') &&
                  (d.productCat2 === 'Ortho' || d.productCat2 === 'Mosaic')
              ) ||
              docs.find(
                (d) =>
                  d.productLabel &&
                  d.productLabel.toLowerCase().includes('kaguya') &&
                  !d.productLabel.toLowerCase().includes('dem')
              );

            if (kaguyaProduct?.productLabel) {
              capUrl = `https://trek.nasa.gov/tiles/Moon/EQ/${kaguyaProduct.productLabel}/1.0.0/WMTSCapabilities.xml`;
            }
          }
        }

        // 2. Резервний шлях до WMTSCapabilities.xml з базового URL
        if (!capUrl && sourceSpec.url.includes('trek.nasa.gov')) {
          const baseEnd = sourceSpec.url.indexOf('/1.0.0/');
          if (baseEnd !== -1) {
            capUrl = `${sourceSpec.url.substring(0, baseEnd)}/1.0.0/WMTSCapabilities.xml`;
          }
        }

        if (!capUrl) return;

        const response = await fetch(capUrl);
        if (!response.ok) return;

        const xmlText = await response.text();
        const xmlDoc = new DOMParser().parseFromString(xmlText, 'text/xml');
        const resourceUrl = xmlDoc.querySelector('ResourceURL');

        if (resourceUrl) {
          const rawTemplate = resourceUrl.getAttribute('template');
          if (rawTemplate) {
            const normalized = this.normalizeWmtsTemplate(rawTemplate);
            this.resolvedTemplates.set(sourceSpec.sourceId, normalized);
          }
        }
      } catch {
        // Використовуємо статичний URL з constants.js у разі мережевої помилки
      } finally {
        this.resolvingPromises.delete(sourceSpec.sourceId);
      }
    })();

    this.resolvingPromises.set(sourceSpec.sourceId, promise);
    await promise;
  }

  requestTile(sourceSpec, z, x, y, priority, onLoad, onError) {
    const key = `${sourceSpec.sourceId}_${z}_${y}_${x}`;

    if (!sourceSpec || !sourceSpec.url || this.failed.has(key)) {
      if (onError) onError();
      return;
    }

    const cached = this.get(key);
    if (cached) {
      onLoad(cached);
      return;
    }

    const effectivePriority = sourceSpec.isLocal ? priority - 1000 : priority;

    if (this.pending.has(key)) {
      const entry = this.pending.get(key);
      entry.callbacks.push({ onLoad, onError });
      entry.priority = Math.min(entry.priority, effectivePriority);
      return;
    }

    const entry = {
      key,
      sourceSpec,
      z,
      x,
      y,
      priority: effectivePriority,
      callbacks: [{ onLoad, onError }],
      aborted: false,
    };

    this.pending.set(key, entry);
    this.queue.push(entry);
    this.processQueue();
  }

  buildUrl(urlTemplate, z, x, y, isWebMercatorQuad, isTms = false) {
    let targetX = x;
    let targetY = y;

    if (isWebMercatorQuad) {
      // Перетворення з рівнопроміжної сітки вузлів (2^(z+1) x 2^z) у квадратну сітку (2^z x 2^z)
      targetX = Math.floor(x / 2);
      // Для TMS (наприклад, S3 opmbuilder) вісь Y інвертована; для стандартного XYZ — без інверсії
      if (isTms || urlTemplate.includes('opmbuilder')) {
        const maxRow = Math.pow(2, z) - 1;
        targetY = maxRow - y;
      }
    }

    return urlTemplate
      .replace('{z}', z)
      .replace('{x}', targetX)
      .replace('{y}', targetY);
  }

  processQueue() {
    while (this.activeRequests < LOD_CONFIG.MAX_CONCURRENT_REQUESTS && this.queue.length > 0) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const entry = this.queue.shift();
      if (entry.aborted) continue;

      this.activeRequests++;
      this.inFlight.add(entry);
      this.startEntryDownload(entry);
    }
  }

  async startEntryDownload(entry) {
    if (entry.sourceSpec.isOverlay) {
      await this.resolveOverlayTemplate(entry.sourceSpec);
    }

    if (entry.aborted) {
      this.inFlight.delete(entry);
      this.activeRequests--;
      this.processQueue();
      return;
    }

    const activeTemplate =
      this.resolvedTemplates.get(entry.sourceSpec.sourceId) || entry.sourceSpec.url;

    const primaryUrl = this.buildUrl(
      activeTemplate,
      entry.z,
      entry.x,
      entry.y,
      entry.sourceSpec.isWebMercatorQuad,
      entry.sourceSpec.isTms
    );

    const handleSuccess = (texture) => {
      this.inFlight.delete(entry);
      this.pending.delete(entry.key);
      this.activeRequests--;

      if (entry.aborted) {
        texture.dispose();
        this.processQueue();
        return;
      }

      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 8;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;

      this.set(entry.key, texture);

      for (const cb of entry.callbacks) {
        cb.onLoad(texture);
      }
      this.processQueue();
    };

    const handleFinalFailure = () => {
      this.inFlight.delete(entry);
      this.pending.delete(entry.key);
      this.activeRequests--;

      if (entry.aborted) {
        this.processQueue();
        return;
      }

      this.failed.add(entry.key);

      for (const cb of entry.callbacks) {
        if (cb.onError) cb.onError();
      }
      this.processQueue();
    };

    this.loader.load(
      primaryUrl,
      handleSuccess,
      undefined,
      () => {
        if (entry.aborted) {
          handleFinalFailure();
          return;
        }
        if (entry.sourceSpec.fallbackUrl) {
          const fbUrl = this.buildUrl(
            entry.sourceSpec.fallbackUrl,
            entry.z,
            entry.x,
            entry.y,
            entry.sourceSpec.isWebMercatorQuad,
            entry.sourceSpec.isTms
          );
          this.loader.load(fbUrl, handleSuccess, undefined, handleFinalFailure);
        } else if (entry.sourceSpec.isOverlay) {
          const altUrl = primaryUrl.endsWith('.jpg')
            ? primaryUrl.replace(/\.jpg$/, '.png')
            : primaryUrl.replace(/\.png$/, '.jpg');
          this.loader.load(altUrl, handleSuccess, undefined, handleFinalFailure);
        } else {
          handleFinalFailure();
        }
      }
    );
  }
}
