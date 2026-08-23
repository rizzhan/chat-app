// 404 handler for routes that don't exist
const notFound = (req, res, next) => {
  res.status(404).json({
    message: "Route not found",
  });
};

// Central error handler (always 4 parameters so Express knows it's an error handler)
const errorHandler = (err, req, res, next) => {
  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  let message = err.message || "Server Error";

  // Invalid ObjectId format (e.g. /api/conversations/not-a-real-id)
  if (err.name === "CastError") {
    statusCode = 400;
    message = "Invalid ID format. Please check that the ID is correct.";
  }

  // Mongoose validation errors (e.g. missing required fields)
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(", ");
  }

  // Duplicate key errors (e.g. registering an email that already exists)
  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue || {})[0] || "value";
    message = `${field} already exists`;
  }

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV === "local" && { stack: err.stack }),
  });
};

module.exports = { notFound, errorHandler };
