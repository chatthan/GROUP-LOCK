const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema(
  {
    ride: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['sos', 'network-loss'],
      required: true,
    },
    location: {
      lat: { type: Number },
      lng: { type: Number },
    },
    note: {
      type: String,
      default: '',
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    escalationLevel: {
      type: String,
      enum: ['CONVOY', 'EMERGENCY_CONTACTS', 'AUTHORITIES'],
      default: 'CONVOY',
    },
    escalatedAt: {
      type: Date,
      default: null,
    },
    resolved: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

alertSchema.pre('save', function (next) {
  if (!this.note && this.description) this.note = this.description;
  if (!this.description && this.note) this.description = this.note;
  next();
});

alertSchema.index({ ride: 1, resolved: 1 });

module.exports = mongoose.model('Alert', alertSchema);
