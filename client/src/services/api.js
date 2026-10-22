// Central place for the backend API base URL and a small fetch wrapper.
// Defaults to relative '/api' so Vite proxy forwards requests to http://localhost:5000 automatically across any domain/tunnel.
export const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export class ApiError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Token-refresh singleton
// AuthContext calls setRefreshTokenGetter(fn) on mount, passing a getter that
// returns the current refresh token string (or null).  On 401, apiRequest
// calls refreshTokenGetter(), hits POST /api/auth/refresh, stores the new
// access token, then retries the original request once.
// ---------------------------------------------------------------------------
let refreshTokenGetter = null;
let onNewAccessToken = null;

/** Called once from AuthContext to wire up the refresh flow. */
export function setRefreshTokenGetter(getter, onToken) {
  refreshTokenGetter = getter;
  onNewAccessToken = onToken;
}

async function attemptTokenRefresh() {
  if (!refreshTokenGetter) return null;
  const rt = refreshTokenGetter();
  if (!rt) return null;
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const newAccessToken = data?.token || data?.accessToken || null;
    if (newAccessToken && onNewAccessToken) {
      onNewAccessToken(newAccessToken);
    }
    return newAccessToken;
  } catch {
    return null;
  }
}

// token is passed in explicitly (rather than read from localStorage here)
// so this module stays a plain utility with no hidden dependency on storage.
export async function apiRequest(path, { method = 'GET', body, token } = {}, _isRetry = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new ApiError('Could not reach the server. Check your connection.', 0, 'NETWORK_ERROR');
  }

  // If 401 and not already retrying, attempt a token refresh once
  if (response.status === 401 && !_isRetry) {
    const newToken = await attemptTokenRefresh();
    if (newToken) {
      // Retry with the fresh token
      return apiRequest(path, { method, body, token: newToken }, true);
    }
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON response (shouldn't normally happen against this API).
  }

  if (!response.ok) {
    const message = data?.message || 'Something went wrong.';
    throw new ApiError(message, response.status, data?.code);
  }

  return data;
}
