// Loads and validates environment variables in one place.
// Other modules should import from here instead of reading process.env directly.
require('dotenv').config();

const requiredVars = ['MONGO_URI', 'JWT_ACCESS_SECRET'];

for (const key of requiredVars) {
  if (!process.env[key]) {
    // Fail fast on startup if a critical variable is missing.
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI,
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  clientOrigins: (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean),
};
