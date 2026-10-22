const mongoose = require('mongoose');

// Stores discrete safety and coordination incidents during a ride
// (separation events, connectivity dropouts, regroup recommendations, SOS triggers, status changes).
// Kept separate from Ride.js so the main Ride document remains lean.
const rideEventSchema = new mongoose.Schema(
  {
    ride: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
      index: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'SEPARATION',
        'CONNECTIVITY',
        'REGROUP',
        'SOS',
        'RIDE_STATUS',
        'OVERSPEED',
        'REPORT',
        'MEMBER_REMOVED',
        'SWEEP_ASSIGNED',
        'LEAD_ASSIGNED',
        'SPEED_LIMIT_CHANGED',
        'RADIO_BROADCAST',
        'ROAD_HAZARD',
      ],
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    severity: {
      type: String,
      enum: ['INFO', 'WARNING', 'CRITICAL'],
      default: 'INFO',
    },
    location: {
      lat: { type: Number },
      lng: { type: Number },
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

rideEventSchema.index({ ride: 1, createdAt: -1 });

module.exports = mongoose.model('RideEvent', rideEventSchema);
