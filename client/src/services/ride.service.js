import { apiRequest } from './api';

export async function createRide({ title, groupId, startLocation, startCoords, destination, destCoords, distanceKm, durationMinutes, creatorCoords, roadCondition, speedLimit }, token) {
  return apiRequest('/rides', {
    method: 'POST',
    token,
    body: { title, groupId, startLocation, startCoords, destination, destCoords, distanceKm, durationMinutes, creatorCoords, roadCondition, speedLimit },
  });
}

export async function shareRiderLocation(rideId, { lat, lng }, token) {
  return apiRequest(`/rides/${rideId}/share-location`, {
    method: 'POST',
    token,
    body: { lat, lng },
  });
}

export async function getRidesByGroup(groupId, token, status = '') {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiRequest(`/rides/group/${groupId}${query}`, { token });
}

export async function getRideDetails(rideId, token) {
  return apiRequest(`/rides/${rideId}`, { token });
}

export async function joinRide(rideId, token) {
  return apiRequest(`/rides/${rideId}/join`, {
    method: 'POST',
    token,
  });
}

export async function startRide(rideId, token) {
  return apiRequest(`/rides/${rideId}/start`, {
    method: 'POST',
    token,
  });
}

export async function endRide(rideId, token) {
  return apiRequest(`/rides/${rideId}/end`, {
    method: 'POST',
    token,
  });
}

function getGooglePlacesPredictions(query) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.places?.AutocompleteService) {
      return resolve(null);
    }
    try {
      const service = new window.google.maps.places.AutocompleteService();
      service.getPlacePredictions({ input: query }, (predictions, status) => {
        if (
          status === window.google.maps.places.PlacesServiceStatus.OK &&
          Array.isArray(predictions) &&
          predictions.length > 0
        ) {
          const formatted = predictions.map((p) => ({
            id: p.place_id,
            description: p.description,
            mainText: p.structured_formatting ? p.structured_formatting.main_text : p.description,
            secondaryText: p.structured_formatting ? p.structured_formatting.secondary_text : '',
            source: 'google',
          }));
          resolve(formatted);
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

export async function getPlaceSuggestions(query, token) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) return [];

  // 1. Try Google Maps JS SDK if loaded in browser
  const googleResults = await getGooglePlacesPredictions(trimmed);
  if (googleResults && googleResults.length > 0) {
    return googleResults;
  }

  // 2. Try backend endpoint (handles server-side Google Places API or fallback)
  try {
    const res = await apiRequest(`/rides/places-autocomplete?query=${encodeURIComponent(trimmed)}`, { token });
    if (res && Array.isArray(res.predictions) && res.predictions.length > 0) {
      return res.predictions;
    }
  } catch (err) {
    // continue to direct Photon fallback
  }

  // 3. Direct browser Photon API fallback
  try {
    const resp = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(trimmed)}&limit=6`);
    const data = await resp.json();
    if (data && Array.isArray(data.features)) {
      return data.features.map((f, idx) => {
        const props = f.properties || {};
        const coords = f.geometry && f.geometry.coordinates; // [lon, lat]
        const mainText = props.name || [props.street, props.housenumber].filter(Boolean).join(' ') || trimmed;
        const secondaryParts = [props.city || props.town || props.village, props.state, props.country].filter(Boolean);
        const secondaryText = secondaryParts.filter((part) => part !== mainText).join(', ');
        const description = secondaryText ? `${mainText}, ${secondaryText}` : mainText;
        return {
          id: `osm-${idx}-${props.osm_id || Math.random()}`,
          description,
          mainText,
          secondaryText,
          source: 'osm',
          coordinates: coords ? { lon: coords[0], lat: coords[1] } : null,
        };
      });
    }
  } catch (e) {
    return [];
  }

  return [];
}

export async function geocodePlace(placeName) {
  if (!placeName || !placeName.trim()) return null;
  const raw = placeName.trim();

  // 1. Direct coordinate extraction (e.g. "(9.9816, 76.2999)" or "9.9816, 76.2999")
  const coordMatch = raw.match(/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon, lng: lon };
    }
  }

  // Clean string if wrapped in "Current Location (...)"
  let query = raw.replace(/^Current Location\s*[\(\[]?(.*?)[\)\]]?$/i, '$1').trim();
  if (!query) query = raw;

  // 2. Try Google Geocoder if available in browser
  if (window.google?.maps?.Geocoder) {
    try {
      const geocoder = new window.google.maps.Geocoder();
      const googleRes = await new Promise((resolve) => {
        geocoder.geocode({ address: query }, (results, status) => {
          if (status === 'OK' && results && results[0]?.geometry?.location) {
            const loc = results[0].geometry.location;
            resolve({ lat: loc.lat(), lon: loc.lng(), lng: loc.lng() });
          } else {
            resolve(null);
          }
        });
      });
      if (googleRes) return googleRes;
    } catch (e) {
      // fallback
    }
  }

  // 3. Try Photon Komoot API
  try {
    const resp = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`);
    if (resp.ok) {
      const data = await resp.json();
      if (data?.features?.[0]?.geometry?.coordinates) {
        const [lon, lat] = data.features[0].geometry.coordinates;
        return { lon, lat, lng: lon };
      }
    }
  } catch (err) {
    // continue to next fallback
  }

  // 4. Try OpenStreetMap Nominatim API
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`, {
      headers: { 'Accept-Language': 'en' }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data[0] && data[0].lat && data[0].lon) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        return { lat, lon, lng: lon };
      }
    }
  } catch (err) {
    // continue
  }

  // 5. If query contains comma or spaces, try primary keyword
  if (query.includes(',') || query.includes(' ')) {
    const firstWord = query.split(/[,]/)[0].trim();
    if (firstWord.length >= 2 && firstWord !== query) {
      try {
        const resp = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(firstWord)}&limit=1`);
        if (resp.ok) {
          const data = await resp.json();
          if (data?.features?.[0]?.geometry?.coordinates) {
            const [lon, lat] = data.features[0].geometry.coordinates;
            return { lon, lat, lng: lon };
          }
        }
      } catch (err) {}
    }
  }

  return null;
}

export async function fetchRouteGeometry(startCoords, destCoords) {
  if (!startCoords || !destCoords) return null;
  const startLon = startCoords.lon ?? startCoords.lng;
  const startLat = startCoords.lat;
  const destLon = destCoords.lon ?? destCoords.lng;
  const destLat = destCoords.lat;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${destLon},${destLat}?overview=full&geometries=geojson`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.code === 'Ok' && data.routes && data.routes[0]) {
      const route = data.routes[0];
      const distanceKm = Number((route.distance / 1000).toFixed(1));
      const totalSec = Math.round(route.duration);
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.round((totalSec % 3600) / 60);
      const durationText = hours > 0 ? `${hours}h ${mins}m` : `${mins} mins`;
      const durationMinutes = Math.round(totalSec / 60);

      // GeoJSON coordinates in OSRM are [lon, lat], for Leaflet polyline we need [lat, lon]
      const latLngs = (route.geometry.coordinates || []).map(([lon, lat]) => [lat, lon]);

      return {
        distanceKm,
        durationText,
        durationMinutes,
        latLngs,
        rawGeoJson: route.geometry,
      };
    }
  } catch (err) {
    // console.error('Route geometry error:', err);
  }
  return null;
}

export async function getRideMessages(rideId, token) {
  return apiRequest(`/rides/${rideId}/messages`, { token });
}

export async function getRideAlerts(rideId, token) {
  return apiRequest(`/rides/${rideId}/alerts`, { token });
}

export async function getRideHistory(groupId, token) {
  return apiRequest(`/rides/history/${groupId}`, { token });
}

export async function cancelRide(rideId, token) {
  return apiRequest(`/rides/${rideId}/cancel`, { method: 'POST', token });
}

export async function assignSweepRider(rideId, sweepRiderId, token) {
  return apiRequest(`/rides/${rideId}/sweep`, {
    method: 'POST',
    token,
    body: { sweepRiderId },
  });
}

export async function updateSpeedLimit(rideId, { roadCondition, speedLimit }, token) {
  return apiRequest(`/rides/${rideId}/speed-limit`, {
    method: 'PATCH',
    token,
    body: { roadCondition, speedLimit },
  });
}

export async function reportRider(rideId, { reportedUserId, reason, details, speed }, token) {
  return apiRequest(`/rides/${rideId}/report`, {
    method: 'POST',
    token,
    body: { reportedUserId, reason, details, speed },
  });
}

export async function kickRider(rideId, userId, reason, token) {
  return apiRequest(`/rides/${rideId}/kick/${userId}`, {
    method: 'POST',
    token,
    body: { reason },
  });
}

export async function getRideEvents(rideId, token) {
  return apiRequest(`/rides/${rideId}/events`, { token });
}

export async function assignLeadRider(rideId, leadRiderId, token) {
  return apiRequest(`/rides/${rideId}/lead`, {
    method: 'POST',
    token,
    body: { leadRiderId },
  });
}

export async function assignConvoyRoles(rideId, { leadRiderId, sweepRiderId }, token) {
  return apiRequest(`/rides/${rideId}/roles`, {
    method: 'POST',
    token,
    body: { leadRiderId, sweepRiderId },
  });
}

export async function batchSyncLocations(rideId, locations, token) {
  return apiRequest(`/rides/${rideId}/batch-locations`, {
    method: 'POST',
    token,
    body: { locations },
  });
}
