const mongoose = require('mongoose');

// Messages are scoped to a ride (not just a group) because in-app chat is
// only meaningful while a ride is active - matches the ride-scoped Socket.IO
// room design. `group` is kept alongside for convenient filtering/history
// without needing to populate through `ride` every time.
const messageSchema = new mongoose.Schema(
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
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    isPrivate: {
      type: Boolean,
      default: false,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

messageSchema.index({ ride: 1, createdAt: 1 });
messageSchema.index({ ride: 1, recipient: 1 });
messageSchema.index({ ride: 1, sender: 1 });

module.exports = mongoose.model('Message', messageSchema);
