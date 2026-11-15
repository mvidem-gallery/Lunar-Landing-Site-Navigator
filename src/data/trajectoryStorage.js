const DB_NAME = 'lunar_missions_trajectory_db';
const DB_VERSION = 1;
const STORE_NAME = 'trajectories';

const memoryFallback = new Map();

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

export async function saveTrajectoryDoc(docId, jsonDoc) {
  if (!docId || !jsonDoc) return;
  memoryFallback.set(docId, jsonDoc);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ id: docId, savedAt: Date.now(), doc: jsonDoc });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save trajectory'));
    });
    db.close();
  } catch {
    // Fallback already populated in memory
  }
}

export async function loadTrajectoryDoc(docId) {
  if (!docId) return null;
  if (memoryFallback.has(docId)) {
    return memoryFallback.get(docId);
  }
  try {
    const db = await openDatabase();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(docId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Failed to read trajectory'));
    });
    db.close();
    if (record?.doc) {
      memoryFallback.set(docId, record.doc);
      return record.doc;
    }
    return null;
  } catch {
    return memoryFallback.get(docId) || null;
  }
}

export async function deleteTrajectoryDoc(docId) {
  if (!docId) return;
  memoryFallback.delete(docId);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(docId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to delete trajectory'));
    });
    db.close();
  } catch {
    // Ignore storage cleanup errors
  }
}
