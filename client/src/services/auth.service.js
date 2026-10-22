import { apiRequest } from './api';

export function registerUser(userData) {
  return apiRequest('/auth/register', {
    method: 'POST',
    body: userData,
  });
}

export function loginUser({ email, password }) {
  return apiRequest('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

export function fetchCurrentUser(token) {
  return apiRequest('/auth/me', { token });
}

export function updateUserProfile(token, updateData) {
  return apiRequest('/auth/profile', {
    method: 'PUT',
    token,
    body: updateData,
  });
}

export function refreshToken(refreshTok) {
  return apiRequest('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: refreshTok },
  });
}
