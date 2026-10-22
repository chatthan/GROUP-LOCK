// PRIMUS brain: live-knowledge answers + routing/places helpers.
//
// - askBrain():   general + live questions via the Anthropic API (optional web search).
//                 Needs ANTHROPIC_API_KEY in server/.env. Without it, returns null and
//                 the controller tells the rider honestly that the brain is offline.
// - getRoute():   driving distance/time from OSRM (free, no key), haversine fallback.
// - geocode():    destination text -> coords via Nominatim (cached).
// - findNearby(): REAL nearby fuel/food/hospital/etc. via OpenStreetMap Overpass.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.PRIMUS_MODEL || 'claude-haiku-5-5';
const WEB_SEARCH = (process.env.PRIMUS_WEB_SEARCH || 'true') !== 'false';

const UA = { 'User-Agent': 'GroupLock-Primus/1.0 (ride companion)' };

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url, opts = {}, timeoutMs = 6000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Geocoding (cached) ──────────────────────────────────────────────────────
const geoCache = new Map();
async function geocode(text) {
  const key = (text || '').trim().toLowerCase();
  if (!key) return null;
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const data = await fetchJson(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text)}`,
      { headers: UA }
    );
    const hit = data?.[0] ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
    geoCache.set(key, hit);
    return hit;
  } catch {
    return null;
  }
}

// ── Route: current position -> destination ─────────────────────────────────
async function getRoute(from, to) {
  if (!from || !to) return null;
  try {
    const data = await fetchJson(
      `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`
    );
    const r = data?.routes?.[0];
    if (r) {
      return {
        distanceKm: Math.round((r.distance / 1000) * 10) / 10,
        durationMin: Math.round(r.duration / 60),
        source: 'route',
      };
    }
  } catch {
    /* fall through to estimate */
  }
  const straight = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const roadKm = straight * 1.3; // rough road-winding factor
  return {
    distanceKm: Math.round(roadKm * 10) / 10,
    durationMin: Math.round((roadKm / 45) * 60), // assume ~45 km/h average
    source: 'estimate',
  };
}

function formatDuration(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0 && m > 0) return `${h} hour${h > 1 ? 's' : ''} ${m} minute${m !== 1 ? 's' : ''}`;
  if (h > 0) return `${h} hour${h > 1 ? 's' : ''}`;
  return `${m} minute${m !== 1 ? 's' : ''}`;
}

// ── Nearby places via Overpass & OSM ───────────────────────────────────────
const PLACE_KINDS = {
  fuel: { label: 'fuel station', filter: '["amenity"="fuel"]', kw: 'petrol pump' },
  food: { label: 'restaurant', filter: '["amenity"~"restaurant|cafe|fast_food"]', kw: 'restaurant' },
  hospital: { label: 'hospital', filter: '["amenity"~"hospital|clinic"]', kw: 'hospital' },
  atm: { label: 'ATM', filter: '["amenity"="atm"]', kw: 'atm' },
  mechanic: { label: 'bike mechanic', filter: '["shop"~"motorcycle_repair|car_repair|motorcycle"]', kw: 'bike mechanic' },
  pharmacy: { label: 'pharmacy', filter: '["amenity"="pharmacy"]', kw: 'pharmacy' },
};

const OVERPASS_SERVERS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function findNearby(lat, lng, kind = 'fuel', radiusM = 8000) {
  const spec = PLACE_KINDS[kind] || PLACE_KINDS.fuel;
  // Node query first (lightweight, avoids heavy relation traversal timeouts & 502s)
  const q = `[out:json][timeout:6];node${spec.filter}(around:${radiusM},${lat},${lng});out center 15;`;
  const body = `data=${encodeURIComponent(q)}`;

  // 1. Try Overpass servers
  for (const server of OVERPASS_SERVERS) {
    try {
      const data = await fetchJson(
        server,
        { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body },
        5000
      );
      if (data && Array.isArray(data.elements)) {
        const places = data.elements
          .map((e) => {
            const pLat = e.lat ?? e.center?.lat;
            const pLng = e.lon ?? e.center?.lon;
            if (pLat == null || pLng == null) return null;
            return {
              name: e.tags?.name || e.tags?.brand || `Nearby ${spec.label}`,
              lat: pLat,
              lng: pLng,
              distanceKm: Math.round(haversineKm(lat, lng, pLat, pLng) * 10) / 10,
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, 3);

        if (places.length > 0) {
          return { label: spec.label, places };
        }
      }
    } catch {
      // Try next mirror
    }
  }

  // 2. High-speed Nominatim fallback if Overpass servers are congested
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(spec.kw)}+near+${lat}+${lng}&limit=4`;
    const nomData = await fetchJson(nomUrl, { headers: UA }, 4000);
    if (Array.isArray(nomData) && nomData.length > 0) {
      const places = nomData
        .map((n) => {
          const pLat = parseFloat(n.lat);
          const pLng = parseFloat(n.lon);
          if (isNaN(pLat) || isNaN(pLng)) return null;
          return {
            name: (n.display_name || '').split(',')[0] || `Nearby ${spec.label}`,
            lat: pLat,
            lng: pLng,
            distanceKm: Math.round(haversineKm(lat, lng, pLat, pLng) * 10) / 10,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 3);

      return { label: spec.label, places };
    }
  } catch {
    // Both failed
  }

  return { label: spec.label, places: [] };
}

// ── LLM brain ──────────────────────────────────────────────────────────────
function brainAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function askBrain({ question, context, history = [] }) {
  if (!brainAvailable()) return null;

  const system = [
    'You are PRIMUS, the voice assistant inside the GROUP-LOCK motorcycle group-ride app.',
    'Your replies are SPOKEN aloud through a rider\'s helmet, so: 1-2 short sentences, plain words, no markdown, no lists, no emojis.',
    'Address the rider as "sir". Be direct and useful. If a question needs current facts (news, prices, scores, weather elsewhere, traffic, opening hours), use web search.',
    'Use the ride context below when relevant. Never invent live GPS, ETA or rider data that is not in the context; if it is missing, say so briefly.',
    'You cannot open apps or send messages yourself; the app handles those separately.',
    `Ride context (JSON): ${JSON.stringify(context)}`,
  ].join('\n');

  const messages = [
    ...history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text).slice(0, 500) })),
    { role: 'user', content: question },
  ];

  const body = { model: MODEL, max_tokens: 350, system, messages };
  if (WEB_SEARCH) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }];

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn('[PRIMUS brain] API error', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text || null;
  } catch (err) {
    console.warn('[PRIMUS brain] request failed:', err.message);
    return null;
  }
}

module.exports = {
  haversineKm,
  geocode,
  getRoute,
  formatDuration,
  findNearby,
  PLACE_KINDS,
  brainAvailable,
  askBrain,
};
