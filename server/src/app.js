const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const groupRoutes = require('./routes/group.routes');
const rideRoutes = require('./routes/ride.routes');
const messageRoutes = require('./routes/message.routes');
const alertRoutes = require('./routes/alert.routes');
const hazardRoutes = require('./routes/hazard.routes');
const simulationRoutes = require('./routes/simulation.routes');
const primusRoutes = require('./routes/primus.routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1);

// Resolve the built frontend dist folder (sits next to /server at project root)
const DIST_DIR = path.resolve(__dirname, '../../client/dist');

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or Postman)
      if (!origin) return callback(null, true);

      // If '*' is in clientOrigins, allow all
      if (env.clientOrigins.includes('*')) return callback(null, true);

      // Allow exact matches from CLIENT_ORIGINS or public tunnel domains
      const isExplicitlyAllowed =
        env.clientOrigins.includes(origin) ||
        origin.endsWith('.ngrok-free.app') ||
        origin.endsWith('.ngrok.io') ||
        origin.endsWith('.loca.lt') ||
        origin.endsWith('.trycloudflare.com') ||
        origin.endsWith('.pinggy.link');

      if (isExplicitlyAllowed) {
        return callback(null, true);
      }

      // In development mode, allow any local LAN or tunnel origin
      if (env.nodeEnv === 'development') {
        return callback(null, true);
      }

      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/hazards', hazardRoutes);
app.use('/api/simulation', simulationRoutes);
app.use('/api/primus', primusRoutes);

// ── Serve built React frontend ────────────────────────────────────────────────
// Serve static assets (JS/CSS/images) from the Vite dist folder
app.use(express.static(DIST_DIR));

// SPA fallback — every non-API route returns index.html so React Router works
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

app.use(errorHandler);

module.exports = app;
