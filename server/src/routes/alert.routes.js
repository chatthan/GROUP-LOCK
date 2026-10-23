const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const Alert = require('../models/Alert');
const { getIO } = require('../sockets/ride.socket');
const { isValidObjectId } = require('../validators/ride.validators');

const router = express.Router();

router.use(authenticate);

// GET /api/alerts?rideId=<id>  — unresolved alerts only
router.get('/', async (req, res, next) => {
  try {
    const { rideId } = req.query;

    if (!rideId || !isValidObjectId(rideId)) {
      const err = new Error('A valid rideId query parameter is required.');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    const alerts = await Alert.find({ ride: rideId, resolved: false })
      .populate('user', 'name phone bloodGroup profilePic emergencyContact')
      .sort({ createdAt: -1 });

    const formatted = alerts.map((a) => ({
      id: a._id,
      rideId: a.ride,
      type: a.type,
      user: {
        id: a.user?._id || a.user,
        name: a.user?.name || 'Rider',
        phone: a.user?.phone || '',
        bloodGroup: a.user?.bloodGroup || '',
        profilePic: a.user?.profilePic || '',
        emergencyContact: a.user?.emergencyContact || null,
      },
      location: a.location,
      note: a.note || a.description || '',
      description: a.description || a.note || '',
      escalationLevel: a.escalationLevel || 'CONVOY',
      escalatedAt: a.escalatedAt || null,
      createdAt: a.createdAt,
    }));

    res.json({ success: true, alerts: formatted });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alerts/:id/escalate — manually escalate alert level
router.patch('/:id/escalate', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { escalationLevel } = req.body;

    if (!isValidObjectId(id)) {
      const err = new Error('Invalid alert ID.');
      err.statusCode = 400;
      err.code = 'INVALID_ID';
      return next(err);
    }

    const alert = await Alert.findById(id).populate('user', 'name phone bloodGroup profilePic emergencyContact');
    if (!alert) {
      const err = new Error('Alert not found.');
      err.statusCode = 404;
      err.code = 'ALERT_NOT_FOUND';
      return next(err);
    }

    const targetLevel = escalationLevel || (alert.escalationLevel === 'CONVOY' ? 'EMERGENCY_CONTACTS' : 'AUTHORITIES');
    alert.escalationLevel = targetLevel;
    alert.escalatedAt = new Date();
    await alert.save();

    const io = getIO();
    if (io) {
      io.to(`ride:${alert.ride.toString()}`).emit('sos:escalated', {
        alertId: id,
        escalationLevel: alert.escalationLevel,
        escalatedAt: alert.escalatedAt,
        note: alert.note || alert.description || '',
        description: alert.description || alert.note || '',
        user: {
          id: alert.user?._id || alert.user,
          name: alert.user?.name || 'Rider',
          phone: alert.user?.phone || '',
          bloodGroup: alert.user?.bloodGroup || '',
          profilePic: alert.user?.profilePic || '',
          emergencyContact: alert.user?.emergencyContact || null,
        },
      });
    }

    res.json({ success: true, message: 'Alert escalated.', alert });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alerts/:id/resolve  — mark alert resolved, emit sos:resolved
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      const err = new Error('Invalid alert ID.');
      err.statusCode = 400;
      err.code = 'INVALID_ID';
      return next(err);
    }

    const alert = await Alert.findById(id);
    if (!alert) {
      const err = new Error('Alert not found.');
      err.statusCode = 404;
      err.code = 'ALERT_NOT_FOUND';
      return next(err);
    }

    alert.resolved = true;
    await alert.save();

    const io = getIO();
    if (io) {
      io.to(`ride:${alert.ride.toString()}`).emit('sos:resolved', { alertId: id });
    }

    res.json({ success: true, message: 'Alert resolved.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
