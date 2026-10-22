import { apiRequest } from './api';

export async function startSimulation(rideId, token) {
  return apiRequest('/simulation/start', {
    method: 'POST',
    token,
    body: { rideId },
  });
}

export async function triggerScenario(rideId, scenario, token) {
  return apiRequest('/simulation/scenario', {
    method: 'POST',
    token,
    body: { rideId, scenario },
  });
}

export async function stopSimulation(rideId, token) {
  return apiRequest('/simulation/stop', {
    method: 'POST',
    token,
    body: { rideId },
  });
}

export async function getSimulationStatus(rideId, token) {
  return apiRequest(`/simulation/status?rideId=${rideId}`, { token });
}
