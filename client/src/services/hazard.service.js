// GroupLock - Stage 10: Real-Time Road Hazard Service
import { apiRequest } from './api';

export async function fetchHazards(rideId, token) {
  try {
    const res = await apiRequest(`/hazards?rideId=${rideId}`, { token });
    return res?.hazards || [];
  } catch (err) {
    console.warn('[HazardService] Failed to fetch hazards:', err);
    return [];
  }
}

export async function reportRoadHazard({ rideId, type, title, description, location, severity }, token) {
  try {
    const res = await apiRequest('/hazards', {
      method: 'POST',
      token,
      body: {
        rideId,
        type,
        title,
        description,
        location,
        severity,
      },
    });
    return res?.hazard;
  } catch (err) {
    console.error('[HazardService] Failed to report hazard:', err);
    throw err;
  }
}

export async function confirmRoadHazard(hazardId, token) {
  try {
    const res = await apiRequest(`/hazards/${hazardId}/confirm`, {
      method: 'PATCH',
      token,
    });
    return res?.hazard;
  } catch (err) {
    console.error('[HazardService] Failed to confirm hazard:', err);
    throw err;
  }
}

export async function resolveRoadHazard(hazardId, token) {
  try {
    const res = await apiRequest(`/hazards/${hazardId}/resolve`, {
      method: 'PATCH',
      token,
    });
    return res;
  } catch (err) {
    console.error('[HazardService] Failed to resolve hazard:', err);
    throw err;
  }
}
