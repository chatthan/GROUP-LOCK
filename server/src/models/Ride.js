const mongoose = require('mongoose');

// Note: live GPS location and route-history data are deliberately NOT part
// of this model. High-frequency location updates need a separate, controlled
// storage strategy (latest-position upsert + interval snapshots) which will
// be added in the location-sharing phase - storing them here would make this
// document grow unbounded.
const rideSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    startLocation: {
      type: String,
      default: '',
      trim: true,
    },
    startCoords: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    destination: {
      type: String,
      default: '',
      trim: true,
    },
    destCoords: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    distanceKm: {
      type: Number,
      default: null,
    },
    durationMinutes: {
      type: Number,
      default: null,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    leadRider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    sweepRider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    roadCondition: {
      type: String,
      enum: ['Highway', 'City', 'Ghats/Hills', 'Rain/Wet', 'Night', 'Custom'],
      default: 'Highway',
    },
    speedLimit: {
      type: Number,
      default: 80,
    },
    reports: [
      {
        reportedUser: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        reportedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        reason: {
          type: String,
          required: true,
        },
        details: {
          type: String,
          default: '',
        },
        speed: {
          type: Number,
          default: 0,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    kickedParticipants: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        reason: {
          type: String,
          default: '',
        },
        kickedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    healthScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    riderLocations: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        lat: {
          type: Number,
          required: true,
        },
        lng: {
          type: Number,
          required: true,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    status: {
      type: String,
      enum: ['planned', 'ongoing', 'completed', 'cancelled'],
      default: 'planned',
    },
    startedAt: {
      type: Date,
    },
    endedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

rideSchema.index({ group: 1, status: 1 });

module.exports = mongoose.model('Ride', rideSchema);
