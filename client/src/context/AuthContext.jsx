import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { registerUser, loginUser, fetchCurrentUser, updateUserProfile } from '../services/auth.service';
import { setRefreshTokenGetter } from '../services/api';

const TOKEN_STORAGE_KEY = 'grouplock_token';
const REFRESH_TOKEN_KEY = 'grouplock_refresh_token';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY));
  // loading=true until we've checked whether a stored token is still valid -
  // prevents a flash of "logged out" state on page refresh.
  const [loading, setLoading] = useState(true);

  // Persist a new access token received from a refresh
  const handleNewAccessToken = useCallback((newToken) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
    setToken(newToken);
  }, []);

  // Wire up the refresh-token getter singleton so api.js can call it on 401
  useEffect(() => {
    setRefreshTokenGetter(
      () => localStorage.getItem(REFRESH_TOKEN_KEY),
      handleNewAccessToken
    );
  }, [handleNewAccessToken]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!storedToken) {
        setLoading(false);
        return;
      }
      try {
        const data = await fetchCurrentUser(storedToken);
        if (!cancelled) {
          setUser(data.user);
          setToken(storedToken);
        }
      } catch {
        // Token expired/invalid - clear it silently, user just appears logged out.
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        if (!cancelled) {
          setUser(null);
          setToken(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async ({ email, password }) => {
    const data = await loginUser({ email, password });
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    if (data.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (userData) => {
    const data = await registerUser(userData);
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    if (data.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const updateProfile = useCallback(async (updateData) => {
    const data = await updateUserProfile(token, updateData);
    setUser(data.user);
    return data.user;
  }, [token]);

  const logout = useCallback(() => {
    // JWT is stateless here - there's no server-side session to invalidate,
    // so logout just discards the token client-side.
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  /** Manually trigger a token refresh (can be called from components if needed). */
  const refreshAccessToken = useCallback(async () => {
    const rt = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!rt) return null;
    try {
      const { refreshToken: refreshFn } = await import('../services/auth.service');
      const data = await refreshFn(rt);
      const newToken = data?.token || data?.accessToken;
      if (newToken) {
        localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
        setToken(newToken);
      }
      return newToken || null;
    } catch {
      return null;
    }
  }, []);

  const value = {
    user,
    token,
    loading,
    isAuthenticated: Boolean(user),
    login,
    register,
    updateProfile,
    logout,
    refreshAccessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
