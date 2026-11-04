const Ride = require('../models/Ride');
const Group = require('../models/Group');
const User = require('../models/User');
const RideHistory = require('../models/RideHistory');
const Message = require('../models/Message');
const Alert = require('../models/Alert');
const RideEvent = require('../models/RideEvent');
const { validateRideInput, isValidObjectId } = require('../validators/ride.validators');
const { getIO, getRideLocations } = require('../sockets/ride.socket');

function makeError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function isGroupMember(group, userId) {
  if (!group || !group.members) return false;
  return group.members.some((m) => {
    const memberUserId = m.user && m.user._id ? m.user._id.toString() : (m.user ? m.user.toString() : '');
    return memberUserId === userId;
  });
}

function getGroupMemberRole(group, userId) {
  if (!group || !group.members) return null;
  const member = group.members.find((m) => {
    const memberUserId = m.user && m.user._id ? m.user._id.toString() : (m.user ? m.user.toString() : '');
    return memberUserId === userId;
  });
  return member ? member.role : null;
}

// POST /api/rides
async function createRide(req, res, next) {
  try {
    const { title, groupId, startLocation, destination, startCoords, destCoords, distanceKm, durationMinutes, creatorCoords } = req.body;

    const validationErrors = validateRideInput({ title, groupId });
    if (validationErrors.length > 0) {
      return next(makeError(validationErrors.join(' '), 400, 'VALIDATION_ERROR'));
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const initialRiderLocations = [];
    if (creatorCoords && typeof creatorCoords.lat === 'number' && typeof creatorCoords.lng === 'number') {
      initialRiderLocations.push({
        user: req.user.id,
        lat: creatorCoords.lat,
        lng: creatorCoords.lng,
        updatedAt: new Date(),
      });
    }

    const validStartCoords = startCoords && typeof startCoords.lat === 'number' ? {
      lat: startCoords.lat,
      lng: startCoords.lng ?? startCoords.lon
    } : null;

    const validDestCoords = destCoords && typeof destCoords.lat === 'number' ? {
      lat: destCoords.lat,
      lng: destCoords.lng ?? destCoords.lon
    } : null;

    const ride = await Ride.create({
      title: title.trim(),
      group: groupId,
      createdBy: req.user.id,
      leadRider: req.body.leadRiderId || req.user.id,
      sweepRider: req.body.sweepRiderId || null,
      startLocation: (startLocation || '').trim(),
      startCoords: validStartCoords,
      destination: (destination || '').trim(),
      destCoords: validDestCoords,
      distanceKm: typeof distanceKm === 'number' ? distanceKm : (distanceKm ? parseFloat(distanceKm) : null),
      durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : (durationMinutes ? parseInt(durationMinutes, 10) : null),
      roadCondition: req.body.roadCondition || 'Highway',
      speedLimit: typeof req.body.speedLimit === 'number' ? req.body.speedLimit : 80,
      participants: [req.user.id],
      riderLocations: initialRiderLocations,
      status: 'planned',
    });

    res.status(201).json({
      success: true,
      ride: {
        id: ride._id,
        title: ride.title,
        group: ride.group,
        createdBy: ride.createdBy,
        leadRider: ride.leadRider || ride.createdBy,
        sweepRider: ride.sweepRider || null,
        startLocation: ride.startLocation,
        startCoords: ride.startCoords,
        destination: ride.destination,
        destCoords: ride.destCoords,
        distanceKm: ride.distanceKm,
        durationMinutes: ride.durationMinutes,
        roadCondition: ride.roadCondition,
        speedLimit: ride.speedLimit,
        participants: ride.participants,
        riderLocations: ride.riderLocations,
        status: ride.status,
        createdAt: ride.createdAt,
      },
    });

    try {
      const io = getIO();
      if (io) {
        io.to(`group:${groupId}`).emit('ride:created', {
          groupId: groupId.toString(),
          ride: {
            id: ride._id,
            title: ride.title,
            status: ride.status,
            startLocation: ride.startLocation,
            destination: ride.destination,
            distanceKm: ride.distanceKm,
            createdAt: ride.createdAt,
          },
        });
      }
    } catch (socketErr) {
      console.warn('[RideController] Error broadcasting ride:created:', socketErr);
    }
  } catch (err) {
    next(err);
  }
}

// GET /api/rides/group/:groupId
async function getRidesByGroup(req, res, next) {
  try {
    const { groupId } = req.params;
    if (!isValidObjectId(groupId)) {
      return next(makeError('Invalid group ID.', 400, 'INVALID_ID'));
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const filter = { group: groupId };
    if (req.query.status) {
      filter.status = req.query.status;
    }

    const rides = await Ride.find(filter)
      .populate('createdBy', 'name email phone bloodGroup profilePic city state role')
      .populate('leadRider', 'name email phone bloodGroup profilePic city state role')
      .populate('participants', 'name email phone bloodGroup profilePic city state role')
      .populate('sweepRider', 'name email phone bloodGroup profilePic city state role')
      .populate('riderLocations.user', 'name email phone bloodGroup profilePic city state role')
      .sort({ createdAt: -1 });

    const result = rides.map((ride) => ({
      id: ride._id,
      title: ride.title,
      group: ride.group,
      creator: ride.createdBy,
      leadRider: ride.leadRider || ride.createdBy,
      sweepRider: ride.sweepRider || null,
      startLocation: ride.startLocation,
      startCoords: ride.startCoords,
      destination: ride.destination,
      destCoords: ride.destCoords,
      distanceKm: ride.distanceKm,
      durationMinutes: ride.durationMinutes,
      roadCondition: ride.roadCondition || 'Highway',
      speedLimit: ride.speedLimit || 80,
      participants: ride.participants,
      riderLocations: ride.riderLocations || [],
      status: ride.status,
      startedAt: ride.startedAt,
      endedAt: ride.endedAt,
      createdAt: ride.createdAt,
    }));

    res.json({ success: true, rides: result });
  } catch (err) {
    next(err);
  }
}

// GET /api/rides/:id
async function getRideDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id)
      .populate('createdBy', 'name email phone bloodGroup profilePic city state role')
      .populate('leadRider', 'name email phone bloodGroup profilePic city state role')
      .populate('participants', 'name email phone bloodGroup profilePic city state role')
      .populate('sweepRider', 'name email phone bloodGroup profilePic city state role')
      .populate('reports.reportedUser', 'name email phone profilePic')
      .populate('reports.reportedBy', 'name email phone profilePic')
      .populate('kickedParticipants.user', 'name email phone profilePic')
      .populate('riderLocations.user', 'name email phone bloodGroup profilePic city state role');

    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    res.json({
      success: true,
      ride: {
        id: ride._id,
        title: ride.title,
        group: ride.group,
        creator: ride.createdBy,
        leadRider: ride.leadRider || ride.createdBy,
        sweepRider: ride.sweepRider || null,
        startLocation: ride.startLocation,
        startCoords: ride.startCoords,
        destination: ride.destination,
        destCoords: ride.destCoords,
        distanceKm: ride.distanceKm,
        durationMinutes: ride.durationMinutes,
        roadCondition: ride.roadCondition || 'Highway',
        speedLimit: ride.speedLimit || 80,
        reports: ride.reports || [],
        kickedParticipants: ride.kickedParticipants || [],
        participants: ride.participants,
        riderLocations: ride.riderLocations || [],
        status: ride.status,
        startedAt: ride.startedAt,
        endedAt: ride.endedAt,
        createdAt: ride.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/join
async function joinRide(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    if (ride.status === 'completed' || ride.status === 'cancelled') {
      return next(makeError('Cannot join a completed or cancelled ride.', 400, 'RIDE_INACTIVE'));
    }

    const isParticipant = ride.participants.some((p) => p.toString() === req.user.id);
    if (isParticipant) {
      return next(makeError('You are already a participant in this ride.', 409, 'ALREADY_PARTICIPANT'));
    }

    ride.participants.push(req.user.id);
    await ride.save();

    // Fetch joining user's full identification details
    const joiningUser = await User.findById(req.user.id).select(
      '_id name email phone bloodGroup city state profilePic role'
    );

    // Notify all active clients in the live ride room
    const io = getIO();
    if (io && joiningUser) {
      io.to(`ride:${id}`).emit('rider:joined', {
        userId: joiningUser._id.toString(),
        name: joiningUser.name,
        email: joiningUser.email,
        phone: joiningUser.phone,
        bloodGroup: joiningUser.bloodGroup,
        city: joiningUser.city,
        state: joiningUser.state,
        profilePic: joiningUser.profilePic,
        role: joiningUser.role,
      });
    }

    res.json({
      success: true,
      message: 'Joined ride successfully.',
      participantCount: ride.participants.length,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/start
async function startRide(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const role = getGroupMemberRole(group, req.user.id);
    const isCreator = ride.createdBy.toString() === req.user.id;
    if (role !== 'admin' && !isCreator) {
      return next(makeError('Only group admins or the ride creator can start this ride.', 403, 'FORBIDDEN'));
    }

    if (ride.status !== 'planned') {
      return next(makeError(`Cannot start a ride with status '${ride.status}'.`, 400, 'INVALID_STATUS_TRANSITION'));
    }

    ride.status = 'ongoing';
    ride.startedAt = new Date();

    // Ensure the starter is in participants
    if (!ride.participants.some((p) => p.toString() === req.user.id)) {
      ride.participants.push(req.user.id);
    }

    await ride.save();

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('ride:started', { rideId: id, status: 'ongoing' });
    }

    res.json({
      success: true,
      message: 'Ride started.',
      ride: {
        id: ride._id,
        status: ride.status,
        startedAt: ride.startedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/end
async function endRide(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const role = getGroupMemberRole(group, req.user.id);
    const isCreator = ride.createdBy.toString() === req.user.id;
    if (role !== 'admin' && !isCreator) {
      return next(makeError('Only group admins or the ride creator can end this ride.', 403, 'FORBIDDEN'));
    }

    if (ride.status !== 'ongoing') {
      return next(makeError(`Cannot end a ride with status '${ride.status}'.`, 400, 'INVALID_STATUS_TRANSITION'));
    }

    ride.status = 'completed';
    ride.endedAt = new Date();
    await ride.save();

    // Populate participants and roles for detailed analytics
    await ride.populate('participants', 'name email phone bloodGroup profilePic');
    if (ride.leadRider) await ride.populate('leadRider', 'name email phone bloodGroup profilePic');
    if (ride.sweepRider) await ride.populate('sweepRider', 'name email phone bloodGroup profilePic');

    const startTime = ride.startedAt ? ride.startedAt.getTime() : ride.createdAt.getTime();
    const durationMinutes = Math.max(1, Math.round((ride.endedAt.getTime() - startTime) / 60000));
    const distKm = ride.distanceKm || 0;
    const avgSpeed = durationMinutes > 0 && distKm > 0 ? Math.round(distKm / (durationMinutes / 60)) : 0;

    // Aggregate incidents from RideEvents
    let separationCount = 0;
    let sosCount = 0;
    let connectivityIncidentCount = 0;
    let regroupCount = 0;
    let overspeedCount = 0;
    let reportCount = (ride.reports && ride.reports.length) || 0;
    let kickCount = (ride.kickedParticipants && ride.kickedParticipants.length) || 0;
    let maxSpeed = 0;
    let events = [];

    try {
      events = await RideEvent.find({ ride: ride._id });
      for (const ev of events) {
        if (ev.type === 'SEPARATION') separationCount++;
        else if (ev.type === 'SOS') sosCount++;
        else if (ev.type === 'CONNECTIVITY') connectivityIncidentCount++;
        else if (ev.type === 'REGROUP') regroupCount++;
        else if (ev.type === 'OVERSPEED') {
          overspeedCount++;
          if (ev.metadata?.speed && ev.metadata.speed > maxSpeed) {
            maxSpeed = ev.metadata.speed;
          }
        }
        else if (ev.type === 'REPORT') reportCount = Math.max(reportCount, 1);
        else if (ev.type === 'MEMBER_REMOVED') kickCount = Math.max(kickCount, 1);
      }
    } catch (e) {
      console.warn('Could not aggregate ride events for history:', e.message);
    }

    // Check active memory locations for max recorded speed
    const liveLocs = getRideLocations(id);
    if (liveLocs) {
      for (const loc of liveLocs.values()) {
        if (loc.speed && loc.speed > maxSpeed) {
          maxSpeed = Math.round(loc.speed);
        }
      }
    }

    // Stage 9: Convoy Safety Score Algorithm (0-100)
    let score = 100;
    score -= Math.min(30, overspeedCount * 4);
    score -= Math.min(24, reportCount * 8);
    score -= Math.min(30, kickCount * 15);
    score -= Math.min(20, sosCount * 10);
    score -= Math.min(15, separationCount * 3);
    score -= Math.min(10, connectivityIncidentCount * 1);
    const safetyScore = Math.max(0, Math.min(100, Math.round(score)));

    let safetyGrade = 'A+';
    if (safetyScore >= 95) safetyGrade = 'A+';
    else if (safetyScore >= 85) safetyGrade = 'A';
    else if (safetyScore >= 75) safetyGrade = 'B';
    else if (safetyScore >= 60) safetyGrade = 'C';
    else if (safetyScore >= 45) safetyGrade = 'D';
    else safetyGrade = 'F';

    // Summary Highlights
    const summaryHighlights = [];
    if (safetyScore >= 95) {
      summaryHighlights.push('🌟 Exemplary Convoy Formation (Clean ride with zero critical incidents)');
    } else if (safetyScore >= 80) {
      summaryHighlights.push('✅ Safe & Well-Coordinated Run with minor alerts');
    } else {
      summaryHighlights.push('⚠️ High incident count - Convoy formation & discipline review recommended');
    }

    if (overspeedCount === 0) {
      summaryHighlights.push('🛣️ 100% Speed Limit Adherence across all road sections');
    } else {
      summaryHighlights.push(`⚡ ${overspeedCount} speed violation event${overspeedCount > 1 ? 's' : ''} detected (Peak convoy speed: ${maxSpeed} km/h)`);
    }

    if (sosCount === 0) {
      summaryHighlights.push('🛡️ Safe Convoy: Zero Emergency SOS calls triggered');
    } else {
      summaryHighlights.push(`🚨 ${sosCount} Emergency SOS call${sosCount > 1 ? 's' : ''} recorded & managed`);
    }

    if (regroupCount > 0) {
      summaryHighlights.push(`🔄 ${regroupCount} convoy regroup${regroupCount > 1 ? 's' : ''} completed`);
    }
    if (kickCount > 0) {
      summaryHighlights.push(`🚫 ${kickCount} rider${kickCount > 1 ? 's' : ''} removed for rule violations`);
    }

    // Per-Rider Performance & Safety Roster
    const leadRiderId = (ride.leadRider?._id || ride.leadRider || ride.createdBy)?.toString();
    const sweepRiderId = (ride.sweepRider?._id || ride.sweepRider)?.toString();
    const riderMap = new Map();

    if (Array.isArray(ride.participants)) {
      for (const p of ride.participants) {
        const pId = (p._id || p.id || p).toString();
        riderMap.set(pId, {
          user: p._id || p,
          name: p.name || 'Rider',
          profilePic: p.profilePic || '',
          isLead: pId === leadRiderId,
          isSweep: pId === sweepRiderId,
          overspeedCount: 0,
          maxSpeed: 0,
          reportCount: 0,
          isKicked: Array.isArray(ride.kickedParticipants) && ride.kickedParticipants.some((k) => (k.user?._id || k.user || k).toString() === pId),
          safetyScore: 100,
        });
      }
    }

    // Aggregate rider-specific metrics from events
    if (Array.isArray(events)) {
      for (const ev of events) {
        const evUserId = (ev.user?._id || ev.user)?.toString();
        if (ev.type === 'OVERSPEED' && evUserId && riderMap.has(evUserId)) {
          const r = riderMap.get(evUserId);
          r.overspeedCount++;
          if (ev.metadata?.speed && ev.metadata.speed > r.maxSpeed) {
            r.maxSpeed = ev.metadata.speed;
          }
        } else if (ev.type === 'REPORT') {
          const repUserId = (ev.metadata?.reportedUserId || evUserId)?.toString();
          if (repUserId && riderMap.has(repUserId)) {
            riderMap.get(repUserId).reportCount++;
          }
        }
      }
    }

    // Check liveLocs for max speed per rider
    if (liveLocs) {
      for (const [uId, loc] of liveLocs.entries()) {
        if (riderMap.has(uId) && loc.speed) {
          const r = riderMap.get(uId);
          if (loc.speed > r.maxSpeed) {
            r.maxSpeed = Math.round(loc.speed);
          }
        }
      }
    }

    // Compute individual rider safety scores
    for (const r of riderMap.values()) {
      let rScore = 100;
      rScore -= r.overspeedCount * 12;
      rScore -= r.reportCount * 20;
      if (r.isKicked) rScore -= 40;
      r.safetyScore = Math.max(0, Math.min(100, rScore));
    }

    const riderStats = Array.from(riderMap.values());

    // Log ride completion event
    try {
      await RideEvent.create({
        ride: ride._id,
        group: ride.group,
        type: 'RIDE_STATUS',
        severity: 'INFO',
        metadata: {
          status: 'completed',
          durationMinutes,
          distanceKm: distKm,
          avgSpeed,
          maxSpeed,
          safetyScore,
          safetyGrade,
        },
      });
    } catch (_) {}

    // Create or update denormalized RideHistory summary
    await RideHistory.findOneAndUpdate(
      { ride: ride._id },
      {
        group: ride.group,
        participants: ride.participants,
        distanceKm: distKm,
        durationMinutes,
        memberCount: ride.participants.length,
        maxSpeed,
        avgSpeed,
        separationCount,
        sosCount,
        connectivityIncidentCount,
        regroupCount,
        overspeedCount,
        reportCount,
        kickCount,
        safetyScore,
        safetyGrade,
        leadRider: ride.leadRider ? (ride.leadRider._id || ride.leadRider) : null,
        sweepRider: ride.sweepRider ? (ride.sweepRider._id || ride.sweepRider) : null,
        riderStats,
        summaryHighlights,
      },
      { upsert: true, new: true }
    );

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('ride:ended', { rideId: id, status: 'completed' });
    }

    res.json({
      success: true,
      message: 'Ride completed.',
      ride: {
        id: ride._id,
        status: ride.status,
        startedAt: ride.startedAt,
        endedAt: ride.endedAt,
        durationMinutes,
        participantCount: ride.participants.length,
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/rides/places-autocomplete?query=...
async function getPlacesAutocomplete(req, res, next) {
  try {
    const query = (req.query.query || req.query.input || '').trim();
    if (!query || query.length < 2) {
      return res.json({ success: true, predictions: [] });
    }

    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (googleApiKey) {
      try {
        const googleUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&key=${googleApiKey}`;
        const response = await fetch(googleUrl);
        const data = await response.json();
        if (data.status === 'OK' && Array.isArray(data.predictions)) {
          const formatted = data.predictions.map((p) => ({
            id: p.place_id,
            description: p.description,
            mainText: p.structured_formatting ? p.structured_formatting.main_text : p.description,
            secondaryText: p.structured_formatting ? p.structured_formatting.secondary_text : '',
            source: 'google',
          }));
          return res.json({ success: true, predictions: formatted });
        }
      } catch (err) {
        // Fallback to OSM / Photon if Google call fails
      }
    }

    // Fallback: Photon (OpenStreetMap geocoding API)
    try {
      const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`;
      const response = await fetch(photonUrl);
      const data = await response.json();
      if (data && Array.isArray(data.features)) {
        const formatted = data.features.map((f, idx) => {
          const props = f.properties || {};
          const mainText = props.name || [props.street, props.housenumber].filter(Boolean).join(' ') || query;
          const secondaryParts = [props.city || props.town || props.village, props.state, props.country].filter(Boolean);
          const secondaryText = secondaryParts.filter((part) => part !== mainText).join(', ');
          const description = secondaryText ? `${mainText}, ${secondaryText}` : mainText;
          return {
            id: `osm-${idx}-${props.osm_id || Math.random()}`,
            description,
            mainText,
            secondaryText,
            source: 'osm',
          };
        });
        return res.json({ success: true, predictions: formatted });
      }
    } catch (err) {
      return res.json({ success: true, predictions: [] });
    }

    return res.json({ success: true, predictions: [] });
  } catch (err) {
    next(err);
  }
}

// GET /api/rides/:id/messages
async function getRideMessages(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const currentUserId = req.user?._id;

    const messages = await Message.find({
      ride: id,
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
}

// GET /api/rides/:id/alerts
async function getRideAlerts(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const alerts = await Alert.find({ ride: id, resolved: false })
      .populate('user', 'name phone bloodGroup profilePic')
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
      },
      location: a.location,
      createdAt: a.createdAt,
    }));

    res.json({ success: true, alerts: formatted });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/share-location
async function shareRiderLocation(req, res, next) {
  try {
    const { id } = req.params;
    const { lat, lng } = req.body;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return next(makeError('Valid latitude and longitude are required.', 400, 'INVALID_COORDINATES'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    // Ensure user is marked as participant
    if (!ride.participants.some((p) => p.toString() === req.user.id)) {
      ride.participants.push(req.user.id);
    }

    if (!ride.riderLocations) {
      ride.riderLocations = [];
    }

    const existingIdx = ride.riderLocations.findIndex(
      (r) => r.user && r.user.toString() === req.user.id
    );

    if (existingIdx >= 0) {
      ride.riderLocations[existingIdx].lat = lat;
      ride.riderLocations[existingIdx].lng = lng;
      ride.riderLocations[existingIdx].updatedAt = new Date();
    } else {
      ride.riderLocations.push({
        user: req.user.id,
        lat,
        lng,
        updatedAt: new Date(),
      });
    }

    await ride.save();

    // Populate user profile for broadcasting
    const populatedUser = await User.findById(req.user.id).select(
      '_id name email phone bloodGroup profilePic city state role'
    );

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('ride:location_shared', {
        rideId: id,
        riderLocation: {
          user: populatedUser,
          lat,
          lng,
          updatedAt: new Date(),
        },
      });
    }

    res.json({
      success: true,
      message: 'Location shared successfully for scheduled ride preview.',
      riderLocations: ride.riderLocations,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/cancel
async function cancelRide(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const role = getGroupMemberRole(group, req.user.id);
    const isCreator = ride.createdBy.toString() === req.user.id;
    if (role !== 'admin' && !isCreator) {
      return next(makeError('Only group admins or the ride creator can cancel this ride.', 403, 'FORBIDDEN'));
    }

    if (ride.status !== 'planned') {
      return next(makeError(`Cannot cancel a ride with status '${ride.status}'.`, 400, 'INVALID_STATUS_TRANSITION'));
    }

    ride.status = 'cancelled';
    await ride.save();

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('ride:cancelled', { rideId: id, status: 'cancelled' });
    }

    res.json({
      success: true,
      message: 'Ride cancelled.',
      ride: {
        id: ride._id,
        status: ride.status,
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/rides/history/:groupId
async function getRideHistory(req, res, next) {
  try {
    const { groupId } = req.params;
    if (!isValidObjectId(groupId)) {
      return next(makeError('Invalid group ID.', 400, 'INVALID_ID'));
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const historyDocs = await RideHistory.find({ group: groupId })
      .populate('ride', 'title startLocation destination distanceKm startedAt endedAt status roadCondition speedLimit leadRider sweepRider')
      .populate('participants', 'name email phone bloodGroup profilePic')
      .populate('leadRider', 'name email phone bloodGroup profilePic')
      .populate('sweepRider', 'name email phone bloodGroup profilePic')
      .sort({ createdAt: -1 })
      .limit(50);

    const formatted = historyDocs.map((h) => {
      const rideData = h.ride || {};

      // Dynamic calculation fallback for legacy records that didn't have precomputed score
      let safetyScore = h.safetyScore;
      let safetyGrade = h.safetyGrade;
      if (typeof safetyScore !== 'number' || (safetyScore === 0 && (h.overspeedCount || 0) === 0 && (h.sosCount || 0) === 0)) {
        let score = 100;
        score -= Math.min(30, (h.overspeedCount || 0) * 4);
        score -= Math.min(24, (h.reportCount || 0) * 8);
        score -= Math.min(30, (h.kickCount || 0) * 15);
        score -= Math.min(20, (h.sosCount || 0) * 10);
        score -= Math.min(15, (h.separationCount || 0) * 3);
        score -= Math.min(10, (h.connectivityIncidentCount || 0) * 1);
        safetyScore = Math.max(0, Math.min(100, Math.round(score)));
        if (safetyScore >= 95) safetyGrade = 'A+';
        else if (safetyScore >= 85) safetyGrade = 'A';
        else if (safetyScore >= 75) safetyGrade = 'B';
        else if (safetyScore >= 60) safetyGrade = 'C';
        else if (safetyScore >= 45) safetyGrade = 'D';
        else safetyGrade = 'F';
      }

      return {
        id: h._id,
        rideId: rideData._id || h.ride,
        title: rideData.title || 'Completed Ride',
        startLocation: rideData.startLocation || '',
        destination: rideData.destination || '',
        roadCondition: rideData.roadCondition || 'Highway',
        speedLimit: rideData.speedLimit || 80,
        distanceKm: h.distanceKm || rideData.distanceKm || 0,
        durationMinutes: h.durationMinutes || 0,
        memberCount: h.memberCount || (h.participants ? h.participants.length : 0),
        participants: h.participants || [],
        leadRider: h.leadRider || rideData.leadRider || null,
        sweepRider: h.sweepRider || rideData.sweepRider || null,
        maxSpeed: h.maxSpeed || 0,
        avgSpeed: h.avgSpeed || 0,
        separationCount: h.separationCount || 0,
        sosCount: h.sosCount || 0,
        connectivityIncidentCount: h.connectivityIncidentCount || 0,
        regroupCount: h.regroupCount || 0,
        overspeedCount: h.overspeedCount || 0,
        reportCount: h.reportCount || 0,
        kickCount: h.kickCount || 0,
        safetyScore,
        safetyGrade,
        riderStats: h.riderStats || [],
        summaryHighlights: h.summaryHighlights || [],
        startedAt: rideData.startedAt,
        endedAt: rideData.endedAt,
        createdAt: h.createdAt,
      };
    });

    res.json({ success: true, history: formatted, rides: formatted });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/sweep
async function assignSweepRider(req, res, next) {
  try {
    const { id } = req.params;
    const { sweepRiderId } = req.body;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const isLeader = ride.createdBy.toString() === req.user.id || getGroupMemberRole(group, req.user.id) === 'admin';
    if (!isLeader) {
      return next(makeError('Only the ride leader or group admin can assign a Sweep Rider.', 403, 'FORBIDDEN'));
    }

    if (sweepRiderId) {
      if (!isValidObjectId(sweepRiderId)) {
        return next(makeError('Invalid sweep rider ID.', 400, 'INVALID_ID'));
      }
      const isParticipant = ride.participants.some((p) => p.toString() === sweepRiderId);
      if (!isParticipant) {
        return next(makeError('Sweep rider must be an active participant in this ride.', 400, 'NOT_PARTICIPANT'));
      }
      ride.sweepRider = sweepRiderId;
    } else {
      ride.sweepRider = null;
    }

    await ride.save();

    let sweepUser = null;
    if (ride.sweepRider) {
      sweepUser = await User.findById(ride.sweepRider).select(
        '_id name email phone bloodGroup profilePic role'
      );
    }

    // Log event
    await RideEvent.create({
      ride: ride._id,
      group: ride.group,
      type: 'SWEEP_ASSIGNED',
      user: sweepRiderId || null,
      severity: 'INFO',
      metadata: {
        assignedBy: req.user.id,
        sweepName: sweepUser ? sweepUser.name : 'None',
      },
    }).catch(() => {});

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('sweep:assigned', {
        sweepRider: sweepUser,
        sweepRiderId: sweepRiderId || null,
        assignedBy: req.user.id,
      });
    }

    res.json({
      success: true,
      sweepRider: sweepUser,
      message: sweepUser ? `${sweepUser.name} assigned as Sweep Rider.` : 'Sweep Rider unassigned.',
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/lead
async function assignLeadRider(req, res, next) {
  try {
    const { id } = req.params;
    const { leadRiderId } = req.body;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const isLeader = ride.createdBy.toString() === req.user.id || getGroupMemberRole(group, req.user.id) === 'admin';
    if (!isLeader) {
      return next(makeError('Only the ride organizer or group admin can assign the Head Rider.', 403, 'FORBIDDEN'));
    }

    if (leadRiderId) {
      if (!isValidObjectId(leadRiderId)) {
        return next(makeError('Invalid lead rider ID.', 400, 'INVALID_ID'));
      }
      const isParticipant = ride.participants.some((p) => p.toString() === leadRiderId);
      if (!isParticipant) {
        ride.participants.push(leadRiderId);
      }
      ride.leadRider = leadRiderId;
    } else {
      ride.leadRider = ride.createdBy;
    }

    await ride.save();

    const leadUser = await User.findById(ride.leadRider || ride.createdBy).select(
      '_id name email phone bloodGroup profilePic role'
    );

    // Log event
    await RideEvent.create({
      ride: ride._id,
      group: ride.group,
      type: 'LEAD_ASSIGNED',
      user: ride.leadRider,
      severity: 'INFO',
      metadata: {
        assignedBy: req.user.id,
        leadName: leadUser ? leadUser.name : 'Convoy Leader',
      },
    }).catch(() => {});

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('lead:assigned', {
        leadRider: leadUser,
        leadRiderId: ride.leadRider,
        assignedBy: req.user.id,
      });
      io.to(`ride:${id}`).emit('convoy_roles:updated', {
        rideId: id,
        leadRider: leadUser,
        sweepRider: ride.sweepRider,
      });
    }

    res.json({
      success: true,
      leadRider: leadUser,
      message: `${leadUser.name} assigned as Head / Lead Rider.`,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/roles
async function assignConvoyRoles(req, res, next) {
  try {
    const { id } = req.params;
    const { leadRiderId, sweepRiderId } = req.body;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const isLeader = ride.createdBy.toString() === req.user.id || getGroupMemberRole(group, req.user.id) === 'admin';
    if (!isLeader) {
      return next(makeError('Only the ride organizer or group admin can assign convoy roles.', 403, 'FORBIDDEN'));
    }

    // Process Lead Rider (Head)
    if (leadRiderId !== undefined) {
      if (leadRiderId) {
        if (!isValidObjectId(leadRiderId)) {
          return next(makeError('Invalid lead rider ID.', 400, 'INVALID_ID'));
        }
        if (!ride.participants.some((p) => p.toString() === leadRiderId.toString())) {
          ride.participants.push(leadRiderId);
        }
        ride.leadRider = leadRiderId;
      } else {
        ride.leadRider = ride.createdBy;
      }
    }

    // Process Sweep Rider (Tail)
    if (sweepRiderId !== undefined) {
      if (sweepRiderId) {
        if (!isValidObjectId(sweepRiderId)) {
          return next(makeError('Invalid sweep rider ID.', 400, 'INVALID_ID'));
        }
        if (!ride.participants.some((p) => p.toString() === sweepRiderId.toString())) {
          ride.participants.push(sweepRiderId);
        }
        ride.sweepRider = sweepRiderId;
      } else {
        ride.sweepRider = null;
      }
    }

    await ride.save();

    const populatedLead = await User.findById(ride.leadRider || ride.createdBy).select(
      '_id name email phone bloodGroup profilePic role'
    );
    const populatedSweep = ride.sweepRider
      ? await User.findById(ride.sweepRider).select('_id name email phone bloodGroup profilePic role')
      : null;

    if (leadRiderId) {
      await RideEvent.create({
        ride: ride._id,
        group: ride.group,
        type: 'LEAD_ASSIGNED',
        user: ride.leadRider,
        severity: 'INFO',
        metadata: { assignedBy: req.user.id, leadName: populatedLead?.name },
      }).catch(() => {});
    }

    if (sweepRiderId !== undefined) {
      await RideEvent.create({
        ride: ride._id,
        group: ride.group,
        type: 'SWEEP_ASSIGNED',
        user: ride.sweepRider || null,
        severity: 'INFO',
        metadata: { assignedBy: req.user.id, sweepName: populatedSweep ? populatedSweep.name : 'Unassigned' },
      }).catch(() => {});
    }

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('convoy_roles:updated', {
        rideId: id,
        leadRider: populatedLead,
        sweepRider: populatedSweep,
      });
      if (leadRiderId) {
        io.to(`ride:${id}`).emit('lead:assigned', { leadRider: populatedLead, assignedBy: req.user.id });
      }
      if (sweepRiderId !== undefined) {
        io.to(`ride:${id}`).emit('sweep:assigned', { sweepRider: populatedSweep, assignedBy: req.user.id });
      }
    }

    res.json({
      success: true,
      message: 'Convoy formation (Head & Tail) updated successfully.',
      leadRider: populatedLead,
      sweepRider: populatedSweep,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/rides/:id/speed-limit
async function updateSpeedLimit(req, res, next) {
  try {
    const { id } = req.params;
    const { roadCondition, speedLimit } = req.body;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const isLeader = ride.createdBy.toString() === req.user.id || getGroupMemberRole(group, req.user.id) === 'admin';
    if (!isLeader) {
      return next(makeError('Only the ride leader or group admin can update speed limit & road conditions.', 403, 'FORBIDDEN'));
    }

    if (roadCondition) {
      ride.roadCondition = roadCondition;
    }

    const numSpeed = Number(speedLimit);
    if (!isNaN(numSpeed) && numSpeed > 0) {
      ride.speedLimit = numSpeed;
    }

    await ride.save();

    await RideEvent.create({
      ride: ride._id,
      group: ride.group,
      type: 'SPEED_LIMIT_CHANGED',
      user: req.user.id,
      severity: 'INFO',
      metadata: {
        roadCondition: ride.roadCondition,
        speedLimit: ride.speedLimit,
      },
    }).catch(() => {});

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('speed_limit:updated', {
        roadCondition: ride.roadCondition,
        speedLimit: ride.speedLimit,
        updatedBy: req.user.id,
      });
    }

    res.json({
      success: true,
      roadCondition: ride.roadCondition,
      speedLimit: ride.speedLimit,
      message: `Road condition updated to ${ride.roadCondition} (Speed limit: ${ride.speedLimit} km/h).`,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/report
async function reportRider(req, res, next) {
  try {
    const { id } = req.params;
    const { reportedUserId, reason, details, speed } = req.body;

    if (!isValidObjectId(id) || !isValidObjectId(reportedUserId)) {
      return next(makeError('Invalid ride or user ID.', 400, 'INVALID_ID'));
    }

    if (!reason || !reason.trim()) {
      return next(makeError('Report reason is required.', 400, 'REASON_REQUIRED'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const isParticipant = ride.participants.some((p) => p.toString() === req.user.id);
    if (!isParticipant) {
      return next(makeError('Only ride participants can submit safety reports.', 403, 'NOT_PARTICIPANT'));
    }

    const reportedUser = await User.findById(reportedUserId).select('_id name email phone profilePic');
    if (!reportedUser) {
      return next(makeError('Reported user not found.', 404, 'USER_NOT_FOUND'));
    }

    const reportItem = {
      reportedUser: reportedUserId,
      reportedBy: req.user.id,
      reason: reason.trim(),
      details: (details || '').trim(),
      speed: typeof speed === 'number' ? speed : (speed ? parseFloat(speed) : 0),
      createdAt: new Date(),
    };

    ride.reports.push(reportItem);
    await ride.save();

    await RideEvent.create({
      ride: ride._id,
      group: ride.group,
      type: 'REPORT',
      user: reportedUserId,
      severity: 'WARNING',
      metadata: {
        reportedBy: req.user.id,
        reason: reportItem.reason,
        details: reportItem.details,
        speed: reportItem.speed,
      },
    }).catch(() => {});

    const reportPayload = {
      id: ride.reports[ride.reports.length - 1]._id,
      rideId: id,
      reportedUser,
      reportedBy: { _id: req.user.id, name: req.user.name },
      reason: reportItem.reason,
      details: reportItem.details,
      speed: reportItem.speed,
      createdAt: reportItem.createdAt,
    };

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('rider:reported', reportPayload);
    }

    res.json({
      success: true,
      message: `Report against ${reportedUser.name} submitted successfully.`,
      report: reportPayload,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/kick/:userId
async function kickRider(req, res, next) {
  try {
    const { id, userId: targetUserId } = req.params;
    const { reason } = req.body;

    if (!isValidObjectId(id) || !isValidObjectId(targetUserId)) {
      return next(makeError('Invalid ride or target user ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const isLeader = ride.createdBy.toString() === req.user.id || getGroupMemberRole(group, req.user.id) === 'admin';
    if (!isLeader) {
      return next(makeError('Only the ride leader or group admin can remove riders from the convoy.', 403, 'FORBIDDEN'));
    }

    if (ride.createdBy.toString() === targetUserId) {
      return next(makeError('Cannot remove the ride creator from the convoy.', 400, 'CANNOT_REMOVE_CREATOR'));
    }

    const targetUser = await User.findById(targetUserId).select('_id name');
    if (!targetUser) {
      return next(makeError('Rider not found.', 404, 'USER_NOT_FOUND'));
    }

    // Remove from participants
    ride.participants = ride.participants.filter((p) => p.toString() !== targetUserId);

    // If target was sweep rider, unset
    if (ride.sweepRider && ride.sweepRider.toString() === targetUserId) {
      ride.sweepRider = null;
    }

    // Add to kickedParticipants
    const kickReason = reason && reason.trim() ? reason.trim() : 'Violated convoy safety rules / Aggressive riding';
    ride.kickedParticipants.push({
      user: targetUserId,
      reason: kickReason,
      kickedAt: new Date(),
    });

    await ride.save();

    // Clean up in-memory live location
    const locationsMap = getRideLocations(id);
    if (locationsMap) {
      locationsMap.delete(targetUserId);
    }

    await RideEvent.create({
      ride: ride._id,
      group: ride.group,
      type: 'MEMBER_REMOVED',
      user: targetUserId,
      severity: 'CRITICAL',
      metadata: {
        removedBy: req.user.id,
        reason: kickReason,
      },
    }).catch(() => {});

    const kickPayload = {
      rideId: id,
      userId: targetUserId,
      name: targetUser.name,
      reason: kickReason,
      kickedBy: { id: req.user.id, name: req.user.name },
    };

    const io = getIO();
    if (io) {
      io.to(`ride:${id}`).emit('rider:kicked', kickPayload);
    }

    res.json({
      success: true,
      message: `${targetUser.name} has been removed from the ride convoy.`,
      kicked: kickPayload,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/rides/:id/events
async function getRideEvents(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const events = await RideEvent.find({ ride: id })
      .populate('user', 'name email phone bloodGroup profilePic')
      .sort({ createdAt: -1 })
      .limit(100);

    const formatted = events.map((e) => ({
      id: e._id,
      rideId: e.ride,
      type: e.type,
      user: e.user,
      severity: e.severity,
      location: e.location,
      metadata: e.metadata,
      createdAt: e.createdAt,
    }));

    res.json({ success: true, events: formatted });
  } catch (err) {
    next(err);
  }
}

// POST /api/rides/:id/batch-locations (Stage 7 Offline Sync REST Fallback)
async function batchSyncLocations(req, res, next) {
  try {
    const { id } = req.params;
    const { locations } = req.body;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid ride ID.', 400, 'INVALID_ID'));
    }

    if (!Array.isArray(locations) || locations.length === 0) {
      return next(makeError('Locations array is required and must not be empty.', 400, 'INVALID_LOCATIONS'));
    }

    const ride = await Ride.findById(id);
    if (!ride) {
      return next(makeError('Ride not found.', 404, 'RIDE_NOT_FOUND'));
    }

    const group = await Group.findById(ride.group);
    if (!isGroupMember(group, req.user.id)) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const sortedLocations = [...locations].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const latestPoint = sortedLocations[sortedLocations.length - 1];
    const earliestPoint = sortedLocations[0];
    const limit = ride.speedLimit || 80;

    let maxSpeedInBatch = 0;
    let overspeedIncidents = 0;

    for (const pt of sortedLocations) {
      const ptSpeed = typeof pt.speed === 'number' ? Math.round(pt.speed) : 0;
      if (ptSpeed > maxSpeedInBatch) maxSpeedInBatch = ptSpeed;
      if (ptSpeed > limit + 5) overspeedIncidents++;
    }

    const user = await User.findById(req.user.id).select('name email phone bloodGroup profilePic role');
    const locationsMap = getRideLocations(id);
    const riderData = {
      userId: req.user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      bloodGroup: user.bloodGroup,
      profilePic: user.profilePic,
      role: user.role,
      lat: latestPoint.lat,
      lng: latestPoint.lng,
      speed: typeof latestPoint.speed === 'number' ? Math.round(latestPoint.speed) : 0,
      heading: typeof latestPoint.heading === 'number' ? Math.round(latestPoint.heading) : 0,
      updatedAt: new Date(latestPoint.timestamp || Date.now()).toISOString(),
      status: 'LIVE',
      lastHeartbeat: Date.now(),
    };

    locationsMap.set(req.user.id, riderData);

    // If overspeeding occurred in dead zone, record event
    if (overspeedIncidents > 0) {
      RideEvent.create({
        ride: id,
        group: ride.group,
        type: 'OVERSPEED',
        user: req.user.id,
        severity: maxSpeedInBatch >= limit + 25 ? 'CRITICAL' : 'WARNING',
        location: { lat: latestPoint.lat, lng: latestPoint.lng },
        metadata: {
          speed: maxSpeedInBatch,
          speedLimit: limit,
          excess: maxSpeedInBatch - limit,
          roadCondition: ride.roadCondition || 'Highway',
          note: `Recorded offline in dead zone (${overspeedIncidents} violation ping(s))`,
          batchCount: sortedLocations.length,
        },
      }).catch(() => {});
    }

    // Build sampled breadcrumbs
    const stride = Math.max(1, Math.floor(sortedLocations.length / 40));
    const breadcrumbs = [];
    for (let i = 0; i < sortedLocations.length; i += stride) {
      breadcrumbs.push([sortedLocations[i].lat, sortedLocations[i].lng]);
    }
    if (breadcrumbs.length === 0 || breadcrumbs[breadcrumbs.length - 1][0] !== latestPoint.lat || breadcrumbs[breadcrumbs.length - 1][1] !== latestPoint.lng) {
      breadcrumbs.push([latestPoint.lat, latestPoint.lng]);
    }

    const io = getIO();
    if (io) {
      const syncPayload = {
        userId: req.user.id,
        name: user.name,
        count: sortedLocations.length,
        latestLocation: riderData,
        breadcrumbs,
        maxSpeed: maxSpeedInBatch,
        overspeedIncidents,
        fromTime: earliestPoint.timestamp ? new Date(earliestPoint.timestamp).toISOString() : null,
        toTime: latestPoint.timestamp ? new Date(latestPoint.timestamp).toISOString() : null,
      };

      io.to(`ride:${id}`).emit('rider:batch_synced', syncPayload);
      io.to(`ride:${id}`).emit('rider:location_update', riderData);
      io.to(`ride:${id}`).emit('rider:status_update', {
        userId: req.user.id,
        status: 'LIVE',
        updatedAt: new Date().toISOString(),
      });
    }

    Alert.updateMany(
      { ride: id, user: req.user.id, type: 'network-loss', resolved: false },
      { resolved: true, resolvedAt: new Date() }
    ).catch(() => {});

    RideEvent.create({
      ride: id,
      group: ride.group,
      type: 'CONNECTIVITY',
      user: req.user.id,
      severity: 'INFO',
      location: { lat: latestPoint.lat, lng: latestPoint.lng },
      metadata: {
        action: 'DEAD_ZONE_SYNC',
        syncedCount: sortedLocations.length,
        maxSpeed: maxSpeedInBatch,
        method: 'REST_HTTP',
      },
    }).catch(() => {});

    res.json({
      success: true,
      count: sortedLocations.length,
      latestLocation: riderData,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createRide,
  getRidesByGroup,
  getRideDetails,
  joinRide,
  startRide,
  endRide,
  cancelRide,
  shareRiderLocation,
  getPlacesAutocomplete,
  getRideMessages,
  getRideAlerts,
  getRideHistory,
  getRideEvents,
  assignSweepRider,
  assignLeadRider,
  assignConvoyRoles,
  updateSpeedLimit,
  reportRider,
  kickRider,
  batchSyncLocations,
};
