const mongoose = require('mongoose');

// Membership is embedded (not a separate collection) because groups are
// small (friends/riding clubs), membership rarely changes mid-ride, and
// embedding lets us fetch "who is in this group + their role" in one read
// without a join - which matters since this check runs on socket auth too.
const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const groupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    members: [memberSchema],
    inviteCode: {
      type: String,
      unique: true,
      sparse: true, // allows null while code is revoked, without breaking uniqueness
    },
    inviteExpiresAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Group', groupSchema);
