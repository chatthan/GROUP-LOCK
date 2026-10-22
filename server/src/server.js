const http = require('http');
const env = require('./config/env');
const connectDB = require('./config/db');
const app = require('./app');
const { initSocketServer } = require('./sockets/ride.socket');
const { startAutoTunnel } = require('./services/tunnel.service');

async function start() {
  await connectDB();

  const server = http.createServer(app);
  initSocketServer(server);

  server.listen(env.port, () => {
    console.log(`GROUP-LOCK API + Socket.IO listening on port ${env.port} [${env.nodeEnv}]`);
    // Automatically start the Cloudflare tunnel for mobile/cross-network joining on port 5000
    startAutoTunnel(env.port || 5000);
  });
}

start();
