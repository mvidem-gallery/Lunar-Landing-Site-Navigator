(() => {
'use strict';

window.LWP = window.LWP || {};

const DB_NAME = 'lwp_mission_datatable_v1';
const DB_STORE = 'state';
const SNAPSHOT_KEY = 'missions_snapshot';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Централизованное хранилище загруженных миссий с сохранением в IndexedDB.
 */
class MissionStore {
  constructor() {
    this.missions = [];
    this.activeMissionId = null;
    this.nextNumber = 1;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      listener(this);
    }
  }

  async persist() {
    try {
      await dbSet(SNAPSHOT_KEY, {
        missions: this.missions,
        activeMissionId: this.activeMissionId,
        nextNumber: this.nextNumber,
      });
    } catch {
      // Тихо игнорируем, если хранилище заблокировано политикой браузера
    }
  }

  async restore() {
    try {
      const saved = await dbGet(SNAPSHOT_KEY);
      if (saved && Array.isArray(saved.missions) && saved.missions.length > 0) {
        this.missions = saved.missions;
        this.activeMissionId = saved.activeMissionId || saved.missions[0].id;
        const maxNum = saved.missions.reduce(
          (max, m) => Math.max(max, Number(m.mission?.num) || 0),
          0
        );
        this.nextNumber = Math.max(Number(saved.nextNumber) || 1, maxNum + 1);
        this.notify();
        return true;
      }
    } catch {
      // Fallback к демо-данным при ошибке чтения
    }
    return false;
  }

  ingest(rawJson, meta = {}) {
    const parsed = window.LWP.parseFlightJson(rawJson, meta);
    const existingIndex = this.missions.findIndex((m) => m.id === parsed.id);

    if (existingIndex >= 0) {
      parsed.mission.num = this.missions[existingIndex].mission.num;
      this.missions[existingIndex] = parsed;
    } else {
      parsed.mission.num = this.nextNumber++;
      this.missions.unshift(parsed);
    }

    this.activeMissionId = parsed.id;
    this.notify();
    this.persist();
    return parsed;
  }

  ingestBatch(items) {
    const results = [];
    for (const item of items) {
      if (item && typeof item === 'object' && 'json' in item) {
        results.push(this.ingest(item.json, item.meta || {}));
      } else {
        results.push(this.ingest(item));
      }
    }
    return results;
  }

  setActiveMission(id) {
    if (this.missions.some((m) => m.id === id)) {
      this.activeMissionId = id;
      this.notify();
      this.persist();
    }
  }

  removeMission(id) {
    this.missions = this.missions.filter((m) => m.id !== id);
    if (this.activeMissionId === id) {
      this.activeMissionId = this.missions[0]?.id ?? null;
    }
    this.notify();
    this.persist();
  }

  clear() {
    this.missions = [];
    this.activeMissionId = null;
    this.nextNumber = 1;
    this.notify();
    this.persist();
  }

  getActiveMission() {
    return (
      this.missions.find((m) => m.id === this.activeMissionId) ||
      this.missions[0] ||
      null
    );
  }
}

window.LWP.store = new MissionStore();

/**
 * Публичный API для интеграции с внешними программами / WebView / postMessage.
 */
window.LWP.attachGlobalApi = function attachGlobalApi(onNotifyStatus) {
  const store = window.LWP.store;
  window.MissionDatatable = {
    ingest: (json, meta = {}) => {
      const result = store.ingest(json, { source: 'api', ...meta });
      onNotifyStatus?.(`Loaded via API: ${result.mission.filename}`);
      return result.id;
    },
    ingestBatch: (items) => {
      const results = store.ingestBatch(items);
      onNotifyStatus?.(`Loaded via API: ${results.length} mission(s)`);
      return results.map((r) => r.id);
    },
    removeMission: (id) => store.removeMission(id),
    clear: () => store.clear(),
    getMissions: () => store.missions.map((m) => m.mission),
    getActiveMission: () => store.getActiveMission(),
    subscribe: (fn) => store.subscribe(fn),
  };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'LWP_INGEST_LOG' && msg.payload) {
      try {
        window.MissionDatatable.ingest(msg.payload, {
          filename: msg.filename,
          source: 'postMessage',
        });
      } catch (err) {
        onNotifyStatus?.(`postMessage API error: ${err.message}`, true);
      }
    }
  });
};
})();
