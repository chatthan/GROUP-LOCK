const { verifyAccessToken } = require('../services/token.service');

// Verifies the Authorization: Bearer <token> header and attaches the
// decoded identity to req.user. Does NOT hit the database - req.user.id and
// req.user.role come straight from the verified JWT, which is what the rest
// of the app must trust (never a client-supplied userId in the body).
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    const err = new Error('Authentication token missing.');
    err.statusCode = 401;
    err.code = 'NO_TOKEN';
    return next(err);
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    const authErr = new Error('Invalid or expired token.');
    authErr.statusCode = 401;
    authErr.code = 'INVALID_TOKEN';
    next(authErr);
  }
}

// Factory: authorize('rideAdmin') or authorize('rideAdmin', 'rider')
// Must run after authenticate - relies on req.user being set.
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      const err = new Error('You do not have permission to perform this action.');
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      return next(err);
    }
    next();
  };
}

module.exports = { authenticate, authorize };
