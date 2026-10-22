const mongoose = require('mongoose');
const env = require('./env');

async function connectDB() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log(`MongoDB connected: ${mongoose.connection.host}`);
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    // Exit - the app is not useful without a database connection.
    process.exit(1);
  }
}

module.exports = connectDB;
