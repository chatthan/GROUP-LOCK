const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const Message = require('../models/Message');
const { isValidObjectId } = require('../validators/ride.validators');

const router = express.Router();

router.use(authenticate);

// GET /api/messages?rideId=<id>
router.get('/', async (req, res, next) => {
  try {
    const { rideId } = req.query;

    if (!rideId || !isValidObjectId(rideId)) {
      const err = new Error('A valid rideId query parameter is required.');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    const currentUserId = req.user?._id;

    const messages = await Message.find({
      ride: rideId,
      $or: [
        { isPrivate: false },
        { recipient: null },
        { recipient: { $exists: false } },
        ...(currentUserId
          ? [{ sender: currentUserId }, { recipient: currentUserId }]
          : []),
      ],
    })
      .populate('sender', 'name profilePic')
      .populate('recipient', 'name profilePic')
      .sort({ createdAt: 1 })
      .limit(200);

    const formatted = messages.map((m) => ({
      id: m._id,
      rideId: m.ride,
      text: m.text,
      isPrivate: Boolean(m.isPrivate || m.recipient),
      recipient: m.recipient
        ? {
            id: m.recipient._id || m.recipient,
            name: m.recipient.name || 'Rider',
            profilePic: m.recipient.profilePic || '',
          }
        : null,
      sender: {
        id: m.sender?._id || m.sender,
        name: m.sender?.name || 'Rider',
        profilePic: m.sender?.profilePic || '',
      },
      createdAt: m.createdAt,
    }));

    res.json({ success: true, messages: formatted });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
