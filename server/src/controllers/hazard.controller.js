const Hazard = require('../models/Hazard');
const Ride = require('../models/Ride');
const RideEvent = require('../models/RideEvent');
const { getIO } = require('../sockets/ride.socket');

// GET /api/hazards?rideId=...
async function getHazards(req, res, next) {
  try {
    const { rideId } = req.query;
    if (!rideId) {
      return res.status(400).json({ error: 'rideId is required' });
    }

    const hazards = await Hazard.find({ ride: rideId, resolved: false })
      .populate('reportedBy', 'name profilePic role')
      .populate('confirmations.user', 'name')
      .sort({ createdAt: -1 });

    return res.json({ success: true, count: hazards.length, hazards });
  } catch (err) {
    next(err);
  }
}

// POST /api/hazards
async function reportHazard(req, res, next) {
  try {
    const { rideId, type, title, description, location, severity } = req.body;
    const userId = req.user.id;

    if (!rideId || !type || !location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      return res.status(400).json({ error: 'rideId, type, and location (lat, lng) are required' });
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const hazardTitle = title || `${type.replace('_', ' ')} reported on road`;

    const hazard = await Hazard.create({
      ride: rideId,
      group: ride.group,
      reportedBy: userId,
      type,
      title: hazardTitle,
      description: description || '',
      location: {
        lat: location.lat,
        lng: location.lng,
      },
      severity: severity || 'MEDIUM',
      confirmations: [{ user: userId, confirmedAt: new Date() }],
    });

    const populatedHazard = await Hazard.findById(hazard._id)
      .populate('reportedBy', 'name profilePic role')
      .populate('confirmations.user', 'name');

    // Record RideEvent for audit trail & analytics
    await RideEvent.create({
      ride: rideId,
      group: ride.group,
      type: 'ROAD_HAZARD',
      user: userId,
      severity: severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      location: { lat: location.lat, lng: location.lng },
      metadata: {
        hazardId: hazard._id,
        hazardType: type,
        title: hazardTitle,
      },
    });

    // Broadcast in real-time to all riders in this ride room
    const io = getIO();
    if (io) {
      io.to(`ride:${rideId}`).emit('hazard:new', populatedHazard);
    }

    return res.status(201).json({ success: true, hazard: populatedHazard });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/hazards/:id/confirm
async function confirmHazard(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const hazard = await Hazard.findById(id);
    if (!hazard) {
      return res.status(404).json({ error: 'Hazard not found' });
    }

    // Check if user already confirmed
    const alreadyConfirmed = hazard.confirmations.some(
      (c) => c.user?.toString() === userId.toString()
    );

    if (!alreadyConfirmed) {
      hazard.confirmations.push({ user: userId, confirmedAt: new Date() });
      await hazard.save();
    }

    const updated = await Hazard.findById(id)
      .populate('reportedBy', 'name profilePic role')
      .populate('confirmations.user', 'name');

    const io = getIO();
    if (io) {
      io.to(`ride:${hazard.ride}`).emit('hazard:confirmed', {
        hazardId: hazard._id,
        confirmationsCount: updated.confirmations.length,
        confirmations: updated.confirmations,
      });
    }

    return res.json({ success: true, hazard: updated });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/hazards/:id/resolve
async function resolveHazard(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const hazard = await Hazard.findById(id);
    if (!hazard) {
      return res.status(404).json({ error: 'Hazard not found' });
    }

    hazard.resolved = true;
    hazard.resolvedBy = userId;
    hazard.resolvedAt = new Date();
    await hazard.save();

    const io = getIO();
    if (io) {
      io.to(`ride:${hazard.ride}`).emit('hazard:resolved', {
        hazardId: hazard._id,
        resolvedBy: userId,
      });
    }

    return res.json({ success: true, message: 'Hazard cleared' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getHazards,
  reportHazard,
  confirmHazard,
  resolveHazard,
};
