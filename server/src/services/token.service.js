const jwt = require('jsonwebtoken');
const env = require('../config/env');

// Payload is deliberately minimal - just enough to identify and authorize
// the user without another DB lookup on every request.
function signAccessToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiry,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

// Payload is identical to the access token - the refresh token's only job is
// to prove the session is still valid long-term; it does not grant API access.
function signRefreshToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiry,
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

module.exports = { signAccessToken, verifyAccessToken, signRefreshToken, verifyRefreshToken };
