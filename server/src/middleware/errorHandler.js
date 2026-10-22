// Standard error shape across the API: { success: false, message, code }
// Route handlers can throw or call next(err); this catches everything centrally.

function notFoundHandler(req, res, next) {
  const err = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  err.statusCode = 404;
  err.code = 'NOT_FOUND';
  next(err);
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'SERVER_ERROR';

  // Log full error server-side; never leak stack traces to the client.
  console.error(`[${code}]`, err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Something went wrong',
    code,
  });
}

module.exports = { notFoundHandler, errorHandler };
