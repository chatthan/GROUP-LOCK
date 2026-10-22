/**
 * Robust Location Service with dual GPS + IP Geolocation Fallback
 * Works smoothly across desktop, mobile browsers, HTTP, and HTTPS.
 */

export function isSecureOrigin() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

export function getHttpsUrl() {
  if (typeof window === 'undefined') return '';
  return `https://${window.location.hostname}:${window.location.port || '5173'}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Fetch approximate coordinates based on the device's public IP address.
 * Used when GPS permission is blocked, denied, or rejected due to HTTP insecure origin on mobile.
 */
export async function getIpLocation() {
  // Provider 1: GeoJS (fast, HTTPS, CORS enabled, no rate limits)
  try {
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json', { timeout: 6000 });
    if (res.ok) {
      const data = await res.json();
      const lat = parseFloat(data.latitude);
      const lng = parseFloat(data.longitude);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        return {
          lat,
          lng,
          city: data.city || '',
          region: data.region || '',
          source: 'ip',
          isApproximate: true,
          label: data.city ? `${data.city}, ${data.country || ''}` : 'IP Location',
        };
      }
    }
  } catch (e) {
    console.warn('[LocationService] GeoJS lookup failed, trying backup provider...', e);
  }

  // Provider 2: IPWho.is fallback
  try {
    const res = await fetch('https://ipwho.is/', { timeout: 6000 });
    if (res.ok) {
      const data = await res.json();
      if (data.success && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        return {
          lat: data.latitude,
          lng: data.longitude,
          city: data.city || '',
          region: data.region || '',
          source: 'ip',
          isApproximate: true,
          label: data.city ? `${data.city}, ${data.country || ''}` : 'IP Location',
        };
      }
    }
  } catch (e) {
    console.warn('[LocationService] IPWho.is lookup failed:', e);
  }

  throw new Error('Unable to determine IP-based location.');
}

/**
 * High-reliability location getter:
 * 1. Tries native GPS (high accuracy).
 * 2. If blocked by mobile HTTP origin error ("Only secure origins are allowed") or permission error,
 *    falls back to IP geolocation automatically!
 */
export function getSmartLocation(options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }) {
  return new Promise((resolve, reject) => {
    // If not secure origin and on mobile IP, browser GPS will fail immediately.
    // We can still try, but provide immediate fallback.
    if (!('geolocation' in navigator)) {
      getIpLocation()
        .then(resolve)
        .catch(() => reject(new Error('Geolocation is not supported by your device.')));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = Math.round(pos.coords.accuracy || 0);
        // PC / Laptop browsers without GPS chip typically have accuracy > 150m (often 500m - 5000m)
        const isCoarse = accuracy > 150;
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy,
          speed: pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
          heading: pos.coords.heading || 0,
          source: 'gps',
          isApproximate: isCoarse,
          isCoarse,
        });
      },
      async (err) => {
        console.warn('[LocationService] Native GPS error:', err.code, err.message);
        
        // Attempt IP fallback
        try {
          const ipLoc = await getIpLocation();
          resolve({
            ...ipLoc,
            accuracy: 5000,
            isApproximate: true,
            isCoarse: true,
            fallbackReason: err.message,
          });
        } catch (ipErr) {
          reject(new Error(err.message || 'Location access denied'));
        }
      },
      options
    );
  });
}

/**
 * Reverse geocode coordinates to a readable place/city name
 */
export async function reverseGeocode(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  // 1. BigDataCloud Client Reverse Geocode API (free, fast, HTTPS, CORS enabled)
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    );
    if (res.ok) {
      const data = await res.json();
      const parts = [
        data.locality || data.city || data.localityInfo?.administrative?.[3]?.name,
        data.principalSubdivision || data.localityInfo?.administrative?.[2]?.name,
        data.countryName,
      ].filter(Boolean);
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
  } catch (e) {
    // try fallback
  }

  // 2. Photon reverse geocode
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`);
    if (res.ok) {
      const data = await res.json();
      const p = data?.features?.[0]?.properties;
      if (p) {
        const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
        const place = [name, p.city || p.town || p.village, p.state].filter(Boolean).join(', ');
        if (place) return place;
      }
    }
  } catch (e) {
    // ignore
  }

  return `Current Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
}

