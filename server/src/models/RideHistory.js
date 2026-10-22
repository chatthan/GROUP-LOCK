const mongoose = require('mongoose');

// A denormalized summary created once a ride ends, so history/dashboard
// pages can list past rides without recomputing stats from raw location
// data every time. The underlying Ride document still holds the source of
// truth for participants/timestamps; this is a fast-read projection of it.
const rideHistorySchema = new mongoose.Schema(
  {
    ride: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
      unique: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    distanceKm: {
      type: Number,
      default: 0,
    },
    durationMinutes: {
      type: Number,
      default: 0,
    },
    memberCount: {
      type: Number,
      default: 0,
    },
    maxSpeed: {
      type: Number,
      default: 0,
    },
    avgSpeed: {
      type: Number,
      default: 0,
    },
    separationCount: {
      type: Number,
      default: 0,
    },
    sosCount: {
      type: Number,
      default: 0,
    },
    connectivityIncidentCount: {
      type: Number,
      default: 0,
    },
    regroupCount: {
      type: Number,
      default: 0,
    },
    overspeedCount: {
      type: Number,
      default: 0,
    },
    reportCount: {
      type: Number,
      default: 0,
    },
    kickCount: {
      type: Number,
      default: 0,
    },
    safetyScore: {
      type: Number,
      default: 100,
    },
    safetyGrade: {
      type: String,
      default: 'A+',
    },
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
    riderStats: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: { type: String, default: 'Rider' },
        profilePic: { type: String, default: '' },
        role: { type: String, default: 'rider' },
        isLead: { type: Boolean, default: false },
        isSweep: { type: Boolean, default: false },
        overspeedCount: { type: Number, default: 0 },
        maxSpeed: { type: Number, default: 0 },
        reportCount: { type: Number, default: 0 },
        isKicked: { type: Boolean, default: false },
        safetyScore: { type: Number, default: 100 },
      },
    ],
    summaryHighlights: [
      {
        type: String,
      },
    ],
  },
  { timestamps: true }
);

rideHistorySchema.index({ group: 1, createdAt: -1 });

module.exports = mongoose.model('RideHistory', rideHistorySchema);
