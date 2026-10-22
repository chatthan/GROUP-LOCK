// IndexedDB & Local Storage Fallback utility for Stage 7 Offline Resiliency & Dead-Zone Telemetry

const DB_NAME = 'GroupLock_OfflineDB';
const DB_VERSION = 1;

let dbPromise = null;

export function initOfflineDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      console.warn('[OfflineSync] IndexedDB not available in this environment. Falling back to memory/localStorage.');
      return resolve(null);
    }

    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store 1: Queued offline GPS locations
        if (!db.objectStoreNames.contains('offline_locations')) {
          const locStore = db.createObjectStore('offline_locations', { keyPath: 'id', autoIncrement: true });
          locStore.createIndex('rideId', 'rideId', { unique: false });
          locStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Store 2: Cached route definitions for offline map rendering
        if (!db.objectStoreNames.contains('cached_routes')) {
          db.createObjectStore('cached_routes', { keyPath: 'rideId' });
        }

        // Store 3: Queued offline chat messages
        if (!db.objectStoreNames.contains('offline_messages')) {
          const msgStore = db.createObjectStore('offline_messages', { keyPath: 'id', autoIncrement: true });
          msgStore.createIndex('rideId', 'rideId', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        console.error('[OfflineSync] IndexedDB open error:', event.target.error);
        resolve(null);
      };
    } catch (e) {
      console.error('[OfflineSync] Failed to initialize IndexedDB:', e);
      resolve(null);
    }
  });

  return dbPromise;
}

// 1. Cache Ride Route for offline viewing (polyline, start, destination)
export async function cacheRideRoute(rideId, routeData) {
  if (!rideId || !routeData) return;

  try {
    const db = await initOfflineDB();
    const payload = {
      rideId: rideId.toString(),
      startLocation: routeData.startLocation || '',
      destination: routeData.destination || '',
      startCoords: routeData.startCoords || null,
      destCoords: routeData.destCoords || null,
      coordinates: routeData.coordinates || [],
      distanceKm: routeData.distanceKm || null,
      durationMinutes: routeData.durationMinutes || null,
      speedLimit: routeData.speedLimit || 80,
      roadCondition: routeData.roadCondition || 'Highway',
      savedAt: Date.now(),
    };

    if (db) {
      const tx = db.transaction('cached_routes', 'readwrite');
      const store = tx.objectStore('cached_routes');
      store.put(payload);
    } else {
      // LocalStorage fallback
      localStorage.setItem(`grouplock:route:${rideId}`, JSON.stringify(payload));
    }
  } catch (err) {
    console.warn('[OfflineSync] Error caching ride route:', err);
  }
}

// Retrieve cached route when offline
export async function getCachedRideRoute(rideId) {
  if (!rideId) return null;

  try {
    const db = await initOfflineDB();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('cached_routes', 'readonly');
        const store = tx.objectStore('cached_routes');
        const req = store.get(rideId.toString());
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } else {
      const raw = localStorage.getItem(`grouplock:route:${rideId}`);
      return raw ? JSON.parse(raw) : null;
    }
  } catch (err) {
    console.warn('[OfflineSync] Error reading cached route:', err);
    return null;
  }
}

// 2. Queue Location Ping into IndexedDB
export async function queueLocationPing(rideId, locationData) {
  if (!rideId || !locationData || typeof locationData.lat !== 'number' || typeof locationData.lng !== 'number') {
    return;
  }

  const ping = {
    rideId: rideId.toString(),
    lat: Number(locationData.lat.toFixed(6)),
    lng: Number(locationData.lng.toFixed(6)),
    speed: typeof locationData.speed === 'number' ? Math.round(locationData.speed) : 0,
    heading: typeof locationData.heading === 'number' ? Math.round(locationData.heading) : 0,
    timestamp: locationData.timestamp || Date.now(),
  };

  try {
    const db = await initOfflineDB();
    if (db) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('offline_locations', 'readwrite');
        const store = tx.objectStore('offline_locations');
        const req = store.add(ping);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } else {
      // LocalStorage fallback
      const key = `grouplock:pings:${rideId}`;
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      existing.push({ ...ping, id: Date.now() + Math.random() });
      localStorage.setItem(key, JSON.stringify(existing));
    }
  } catch (err) {
    console.warn('[OfflineSync] Error queuing offline location ping:', err);
  }
}

// 3. Get all queued locations for a ride
export async function getQueuedLocations(rideId) {
  if (!rideId) return [];

  try {
    const db = await initOfflineDB();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('offline_locations', 'readonly');
        const store = tx.objectStore('offline_locations');
        const index = store.index('rideId');
        const req = index.getAll(rideId.toString());
        req.onsuccess = () => {
          const list = req.result || [];
          // Sort chronologically
          list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          resolve(list);
        };
        req.onerror = () => resolve([]);
      });
    } else {
      const key = `grouplock:pings:${rideId}`;
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return list;
    }
  } catch (err) {
    console.warn('[OfflineSync] Error fetching queued locations:', err);
    return [];
  }
}

// 4. Remove successfully synced locations
export async function removeQueuedLocations(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;

  try {
    const db = await initOfflineDB();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('offline_locations', 'readwrite');
        const store = tx.objectStore('offline_locations');
        ids.forEach((id) => {
          store.delete(id);
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } else {
      // LocalStorage fallback
      // Since fallback items have id, filter them out across all stored rides
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('grouplock:pings:')) {
          const list = JSON.parse(localStorage.getItem(key) || '[]');
          const idSet = new Set(ids);
          const remaining = list.filter((item) => !idSet.has(item.id));
          localStorage.setItem(key, JSON.stringify(remaining));
        }
      }
    }
  } catch (err) {
    console.warn('[OfflineSync] Error removing queued locations:', err);
  }
}

// 5. Clear entire queue for a ride
export async function clearRideQueue(rideId) {
  if (!rideId) return;

  try {
    const db = await initOfflineDB();
    if (db) {
      const items = await getQueuedLocations(rideId);
      const ids = items.map((i) => i.id);
      await removeQueuedLocations(ids);
    }
    localStorage.removeItem(`grouplock:pings:${rideId}`);
  } catch (err) {
    console.warn('[OfflineSync] Error clearing ride queue:', err);
  }
}

// 6. Get count of queued items
export async function getQueuedCount(rideId) {
  if (!rideId) return 0;
  const list = await getQueuedLocations(rideId);
  return list.length;
}

// 7. Queued offline chat messages (so rider chat messages written in dead zone auto-send on reconnection)
export async function queueOfflineMessage(rideId, text, recipientId) {
  if (!rideId || !text || !text.trim()) return;

  const msg = {
    rideId: rideId.toString(),
    text: text.trim(),
    recipientId: recipientId || null,
    timestamp: Date.now(),
  };

  try {
    const db = await initOfflineDB();
    if (db) {
      const tx = db.transaction('offline_messages', 'readwrite');
      const store = tx.objectStore('offline_messages');
      store.add(msg);
    }
  } catch (e) {
    console.warn('[OfflineSync] Error queuing offline message:', e);
  }
}

export async function getQueuedMessages(rideId) {
  if (!rideId) return [];

  try {
    const db = await initOfflineDB();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction('offline_messages', 'readonly');
      const store = tx.objectStore('offline_messages');
      const index = store.index('rideId');
      const req = index.getAll(rideId.toString());
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

export async function removeQueuedMessage(id) {
  if (!id) return;
  try {
    const db = await initOfflineDB();
    if (!db) return;
    const tx = db.transaction('offline_messages', 'readwrite');
    tx.objectStore('offline_messages').delete(id);
  } catch (e) {}
}
