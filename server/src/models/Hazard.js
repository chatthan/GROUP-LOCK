const mongoose = require('mongoose');

// GroupLock - Stage 10: Real-Time Road Hazard Crowdsourcing & Safety Warning Model
const hazardSchema = new mongoose.Schema(
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
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: [
        'POTHOLE',
        'OIL_SPILL',
        'ROADBLOCK',
        'CATTLE_DEBRIS',
        'POLICE_CHECK',
        'LOW_VISIBILITY',
        'WEATHER_HAZARD',
        'ACCIDENT',
        'OTHER',
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    severity: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      default: 'MEDIUM',
    },
    confirmations: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        confirmedAt: { type: Date, default: Date.now },
      },
    ],
    resolved: {
      type: Boolean,
      default: false,
      index: true,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

hazardSchema.index({ ride: 1, resolved: 1, createdAt: -1 });

module.exports = mongoose.model('Hazard', hazardSchema);
