const express = require('express');
const mongoose = require('mongoose');
const os = require('os');
const env = require('../config/env');
const { getPublicUrl } = require('../services/tunnel.service');

const router = express.Router();

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Simple health check - confirms the API is up and reports DB connection state.
router.get('/', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    success: true,
    message: 'GROUP-LOCK API is running',
    db: dbStates[mongoose.connection.readyState],
    timestamp: new Date().toISOString(),
  });
});

// Network host discovery - helps frontend dynamically construct accurate LAN & public invite URLs
router.get('/network', (req, res) => {
  const lanIps = getLocalIpAddresses();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || '';
  const currentOrigin = `${protocol}://${hostHeader}`;
  const publicUrl = getPublicUrl() || process.env.PUBLIC_URL || '';

  res.json({
    success: true,
    lanIps,
    primaryLanIp: lanIps[0] || '127.0.0.1',
    requestOrigin: currentOrigin,
    publicUrl,
    clientOrigins: env.clientOrigins || [],
    serverPort: env.port || 5000,
  });
});

module.exports = router;
