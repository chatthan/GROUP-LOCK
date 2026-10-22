import { io } from 'socket.io-client';
import { API_BASE_URL } from './api';

let socket = null;

export function getSocketBaseUrl() {
  if (API_BASE_URL.startsWith('http')) {
    return API_BASE_URL.replace(/\/api\/?$/, '');
  }
  // Connect to the current origin (works seamlessly with Vite proxy on both HTTP and HTTPS)
  return window.location.origin;
}

export function initSocket(token) {
  if (socket && socket.connected) {
    return socket;
  }

  if (socket) {
    socket.disconnect();
  }

  const serverUrl = getSocketBaseUrl();
  socket = io(serverUrl, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected to server at', serverUrl);
  });

  socket.on('connect_error', (err) => {
    console.warn('[Socket] Connection error:', err.message);
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
