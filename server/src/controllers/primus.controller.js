const Ride = require('../models/Ride');
const Group = require('../models/Group');
const Message = require('../models/Message');
const Alert = require('../models/Alert');
const Hazard = require('../models/Hazard');
const User = require('../models/User');
const { getRideLocations, getIO } = require('../sockets/ride.socket');
const brain = require('../services/primusBrain.service');

// In-memory deduplication tracker for proactive alerts (cooldown per rider/event: 45s)
// Map<`${rideId}:${type}:${userId}`, number>
const proactiveCooldowns = new Map();

// Helper to query live Open-Meteo weather along route coordinates
async function fetchWeather(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current_weather=true&hourly=precipitation_probability,rain`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    const cur = data.current_weather;
    if (!cur) return null;

    let description = 'Clear skies';
    let roadCondition = 'Highway';
    let suggestedSpeed = 80;
    let isHazardous = false;
    let isRain = false;

    const code = cur.weathercode;
    if (code === 0) {
      description = 'Clear skies';
    } else if ([1, 2, 3].includes(code)) {
      description = 'Partly cloudy';
    } else if ([45, 48].includes(code)) {
      description = 'Dense fog and mist';
      roadCondition = 'Ghats/Hills';
      suggestedSpeed = 50;
      isHazardous = true;
    } else if ([51, 53, 55, 56, 57].includes(code)) {
      description = 'Light drizzle';
      roadCondition = 'Rain/Wet';
      suggestedSpeed = 60;
      isRain = true;
      isHazardous = true;
    } else if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
      description = 'Rain and wet tarmac';
      roadCondition = 'Rain/Wet';
      suggestedSpeed = 50;
      isRain = true;
      isHazardous = true;
    } else if ([95, 96, 99].includes(code)) {
      description = 'Severe thunderstorm';
      roadCondition = 'Rain/Wet';
      suggestedSpeed = 40;
      isRain = true;
      isHazardous = true;
    }

    const precipProb = data.hourly?.precipitation_probability ? data.hourly.precipitation_probability[0] : 0;
    return {
      temp: Math.round(cur.temperature),
      windSpeed: Math.round(cur.windspeed),
      code,
      description,
      roadCondition,
      suggestedSpeed,
      isHazardous,
      isRain,
      precipProb,
    };
  } catch (err) {
    return null;
  }
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

// Helper to check ride membership & resolve role
async function resolveRiderContext(rideId, userId) {
  const ride = await Ride.findById(rideId)
    .populate('createdBy', 'name email phone role')
    .populate('participants', 'name email phone role bloodGroup')
    .populate('sweepRider', 'name email phone role');

  if (!ride) {
    const err = new Error('Ride not found.');
    err.statusCode = 404;
    throw err;
  }

  const group = await Group.findById(ride.group);
  if (!group) {
    const err = new Error('Associated group not found.');
    err.statusCode = 404;
    throw err;
  }

  const groupMember = group.members.find(
    (m) => (m.user?._id || m.user).toString() === userId.toString()
  );

  const isParticipant = ride.participants.some(
    (p) => (p._id || p).toString() === userId.toString()
  );

  if (!groupMember && !isParticipant) {
    const err = new Error('You are not a member of this ride or group.');
    err.statusCode = 403;
    throw err;
  }

  const isLeader =
    (ride.createdBy?._id || ride.createdBy).toString() === userId.toString() ||
    groupMember?.role === 'admin';

  const isSweep =
    ride.sweepRider &&
    (ride.sweepRider._id || ride.sweepRider).toString() === userId.toString();

  const role = isLeader ? 'leader' : (isSweep ? 'sweep' : 'rider');

  return { ride, group, isLeader, isSweep, role };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/primus/context/:rideId
// ─────────────────────────────────────────────────────────────────────────────
async function getRideContext(req, res, next) {
  try {
    const { rideId } = req.params;
    const { ride, isLeader, role } = await resolveRiderContext(rideId, req.user.id);

    const liveLocations = getRideLocations(rideId);
    const now = Date.now();

    // Identify leader's coordinates for distance baseline
    const leaderId = (ride.createdBy?._id || ride.createdBy).toString();
    const leaderLoc = liveLocations.get(leaderId);

    // Build real rider statuses
    const riders = ride.participants.map((p) => {
      const pid = (p._id || p).toString();
      const loc = liveLocations.get(pid);
      const secondsSinceUpdate = loc?.lastHeartbeat
        ? Math.round((now - loc.lastHeartbeat) / 1000)
        : null;

      const isStale = secondsSinceUpdate !== null && secondsSinceUpdate > 60;
      const isLive = loc && !isStale;

      let distFromLeader = null;
      if (leaderLoc?.lat != null && loc?.lat != null) {
        distFromLeader = calculateDistanceKm(leaderLoc.lat, leaderLoc.lng, loc.lat, loc.lng);
      }

      return {
        id: pid,
        name: p.name || 'Rider',
        role: pid === leaderId ? 'leader' : 'rider',
        isLive,
        isStale,
        secondsSinceUpdate,
        speed: loc?.speed || 0,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        distFromLeaderKm: distFromLeader,
      };
    });

    // Fetch active unresolved alerts
    const alerts = await Alert.find({ ride: rideId, resolved: false })
      .populate('user', 'name phone bloodGroup')
      .sort({ createdAt: -1 })
      .limit(10);

    // Fetch active road hazards
    const hazards = await Hazard.find({ ride: rideId, resolved: false })
      .populate('reportedBy', 'name role')
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      success: true,
      primus: {
        identity: 'PRIMUS',
        status: 'ONLINE',
        authenticatedUser: {
          id: req.user.id,
          name: req.user.name,
          role,
          isLeader,
        },
        ride: {
          id: ride._id,
          title: ride.title,
          status: ride.status,
          startLocation: ride.startLocation,
          destination: ride.destination,
          distanceKm: ride.distanceKm,
          speedLimit: ride.speedLimit || 80,
          roadCondition: ride.roadCondition || 'Highway',
          startedAt: ride.startedAt,
          endedAt: ride.endedAt,
        },
        riders,
        activeAlerts: alerts.map((a) => ({
          id: a._id,
          type: a.type,
          user: a.user?.name || 'Rider',
          message: a.message,
          location: a.location,
          createdAt: a.createdAt,
        })),
        activeHazards: hazards.map((h) => ({
          id: h._id,
          type: h.type,
          description: h.description,
          location: h.location,
          severity: h.severity,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/primus/proactive/:rideId
// ─────────────────────────────────────────────────────────────────────────────
async function getProactiveInsights(req, res, next) {
  try {
    const { rideId } = req.params;
    const { ride, isLeader } = await resolveRiderContext(rideId, req.user.id);

    const liveLocations = getRideLocations(rideId);
    const now = Date.now();
    const insights = [];

    const leaderId = (ride.createdBy?._id || ride.createdBy).toString();
    const leaderLoc = liveLocations.get(leaderId);

    // 1. Separation / Straggler detection
    for (const p of ride.participants) {
      const pid = (p._id || p).toString();
      if (pid === leaderId) continue;

      const loc = liveLocations.get(pid);
      if (leaderLoc?.lat != null && loc?.lat != null) {
        const distKm = calculateDistanceKm(leaderLoc.lat, leaderLoc.lng, loc.lat, loc.lng);
        if (distKm != null && distKm > 1.8) {
          const cooldownKey = `${rideId}:separation:${pid}`;
          const lastAlert = proactiveCooldowns.get(cooldownKey) || 0;

          if (now - lastAlert > 45000) {
            proactiveCooldowns.set(cooldownKey, now);
            const severity = distKm > 4 ? 'CRITICAL' : 'WARNING';
            insights.push({
              type: 'SEPARATION',
              severity,
              riderId: pid,
              riderName: p.name || 'Rider',
              distKm,
              message: `${p.name} has separated from the convoy (${distKm} km behind leader).`,
              spoken: `${p.name} is ${distKm} kilometers behind the leader. Recommend regrouping.`,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }

    // 2. Stale GPS / Connectivity loss detection
    for (const p of ride.participants) {
      const pid = (p._id || p).toString();
      const loc = liveLocations.get(pid);
      if (loc && loc.lastHeartbeat) {
        const secSince = Math.round((now - loc.lastHeartbeat) / 1000);
        if (secSince > 60) {
          const cooldownKey = `${rideId}:stale:${pid}`;
          const lastAlert = proactiveCooldowns.get(cooldownKey) || 0;

          if (now - lastAlert > 60000) {
            proactiveCooldowns.set(cooldownKey, now);
            insights.push({
              type: 'STALE_GPS',
              severity: 'INFO',
              riderId: pid,
              riderName: p.name || 'Rider',
              secondsStale: secSince,
              lastLocation: { lat: loc.lat, lng: loc.lng },
              message: `${p.name}'s GPS is stale (${secSince}s since update). Last known position displayed.`,
              spoken: `GPS signal for ${p.name} has been stale for ${secSince} seconds.`,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }

    // 3. Active Emergency SOS
    const activeSos = await Alert.findOne({ ride: rideId, type: 'sos', resolved: false })
      .populate('user', 'name phone bloodGroup')
      .sort({ createdAt: -1 });

    if (activeSos) {
      insights.push({
        type: 'SOS',
        severity: 'EMERGENCY',
        alertId: activeSos._id,
        riderName: activeSos.user?.name || 'Rider',
        message: `EMERGENCY: SOS triggered by ${activeSos.user?.name || 'Rider'}!`,
        spoken: `Emergency SOS triggered by ${activeSos.user?.name || 'a rider'}. Immediate convoy stop advised.`,
        location: activeSos.location,
        timestamp: activeSos.createdAt,
      });
    }

    // 4. Proactive Road Weather & Climate Safety Alert
    const targetLoc = leaderLoc || liveLocations.get(req.user.id);
    if (targetLoc?.lat != null && targetLoc?.lng != null) {
      const cooldownKey = `${rideId}:proactive_weather`;
      const lastAlert = proactiveCooldowns.get(cooldownKey) || 0;
      if (now - lastAlert > 120000) {
        const wx = await fetchWeather(targetLoc.lat, targetLoc.lng);
        if (wx && wx.isHazardous) {
          proactiveCooldowns.set(cooldownKey, now);
          insights.push({
            type: 'WEATHER_HAZARD',
            severity: 'WARNING',
            message: `Climate Alert: ${wx.description} detected on route. Reduced speed of ${wx.suggestedSpeed} km/h advised.`,
            spoken: `Weather alert from PRIMUS: ${wx.description} reported on your route. Recommended speed limit reduced to ${wx.suggestedSpeed} km/h. Ride cautiously.`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    res.json({ success: true, insights });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/primus/command
// ─────────────────────────────────────────────────────────────────────────────
async function executePrimusCommand(req, res, next) {
  try {
    const {
      rideId,
      command = '',
      action: explicitAction,
      parameters = {},
      location = null, // rider's live GPS from the phone: { lat, lng, speed }
      history = [],   // last few turns, so follow-up questions make sense
    } = req.body;
    if (!rideId) {
      return res.status(400).json({ success: false, error: 'rideId is required.' });
    }

    const { ride, isLeader, role } = await resolveRiderContext(rideId, req.user.id);
    const io = getIO();
    const cmd = command.trim().toLowerCase();

    // Best known position of this rider: phone GPS first, then socket telemetry
    const socketLoc = getRideLocations(rideId).get(req.user.id);
    const myPos =
      location && typeof location.lat === 'number' && typeof location.lng === 'number'
        ? { lat: location.lat, lng: location.lng, speed: location.speed ?? socketLoc?.speed ?? 0 }
        : socketLoc?.lat != null
        ? { lat: socketLoc.lat, lng: socketLoc.lng, speed: socketLoc.speed || 0 }
        : null;

    // ── Intent Classifier (order matters: most specific first) ───────────────
    let targetAction = explicitAction || '';

    if (!targetAction) {
      const has = (...words) => words.some((w) => cmd.includes(w));
      const re = (rx) => rx.test(cmd);

      if (has('stop listening', 'go to sleep', 'standby', 'deactivate', 'go offline')) {
        targetAction = 'deactivate_primus';
      } else if (
        (re(/\b(open\s+(?:the\s+)?chat(?:\s+box)?|show\s+chat|view\s+chat)\b/) ||
         re(/^(?:the\s+)?chat(?:\s+box)?$/)) &&
        !re(/\b(send|say|tell|write|message|post)\b/)
      ) {
        targetAction = 'open_chat';
      } else if (re(/\b(close\s+(?:the\s+)?chat(?:\s+box)?|hide\s+chat|dismiss\s+chat)\b/)) {
        targetAction = 'close_chat';
      } else if (
        re(/\b(open\s+(?:the\s+)?contact(?:s)?|show\s+(?:the\s+)?contact(?:s)?)\b/) ||
        re(/^(?:the\s+)?contact(?:s)?$/)
      ) {
        targetAction = 'open_contacts';
      } else if (re(/\b(close\s+(?:the\s+)?contact(?:s)?|hide\s+(?:the\s+)?contact(?:s)?|dismiss\s+(?:the\s+)?contact(?:s)?)\b/)) {
        targetAction = 'close_contacts';
      } else if (
        re(/\b(open\s+(?:the\s+)?chat(?:\s+box)?\s+and\s+send)\b/) ||
        re(/\b(send\s+(?:a\s+)?(?:chat\s+)?message|send\s+message|tell\s+everyone|tell\s+the\s+group|message\s+(?:the\s+)?group|message\s+everyone|broadcast|post\s+(?:a\s+)?message|say\s+to\s+group)\b/) ||
        re(/\bchat\s+(?:to\s+(?:all|everyone)|that|saying)\b/)
      ) {
        targetAction = 'send_group_message';
      } else if (re(/\b(been riding|riding for|so far|elapsed|trip report|ride summary|distance covered|covered so far)\b/)) {
        targetAction = 'get_ride_summary';
      } else if (
        re(/\b(eta|arrive|arrival|reach|get there|get to|destination)\b/) ||
        re(/\bhow (much )?(time|long|far)\b/) ||
        re(/\bhow many (km|kilomet|minutes|hours)\b/) ||
        re(/\b(distance|time) (left|remaining|to go)\b/)
      ) {
        targetAction = 'get_eta';
      } else if (has('weather', 'climate', 'rain', 'temperature', 'forecast', 'road condition', 'road ahead', 'speed limit', 'fog')) {
        targetAction = 'get_weather_road_conditions';
      } else if (has('notify leader', 'tell the leader', 'tell leader', 'need a stop', 'need stop')) {
        targetAction = 'notify_ride_leader';
      } else if (has('regroup', 'rendezvous', 'meet at')) {
        targetAction = 'request_regrouping_point';
      } else if (re(/\b(petrol|fuel|gas station|pump)\b/)) {
        targetAction = 'find_fuel';
      } else if (re(/\b(hospital|clinic|doctor|medical)\b/)) {
        targetAction = 'find_hospital';
      } else if (re(/\b(restaurant|food|hungry|eat|cafe|tea|coffee|breakfast|lunch|dinner)\b/)) {
        targetAction = 'find_food';
      } else if (re(/\b(atm|cash machine)\b/)) {
        targetAction = 'find_atm';
      } else if (re(/\b(mechanic|puncture shop|bike shop|repair shop|workshop)\b/)) {
        targetAction = 'find_mechanic';
      } else if (has('group status', 'how many riders', 'convoy status', 'members')) {
        targetAction = 'get_group_status';
      } else if (has('who is behind', 'who is far', 'separation', 'straggler', 'trailing', 'where is everyone')) {
        targetAction = 'get_rider_status';
      } else if (has('any alert', 'active alert', 'any hazard', 'any sos', 'what happened', 'any update', 'what did i miss')) {
        targetAction = 'get_active_alerts';
      } else {
        targetAction = 'general_ride_query'; // -> live-knowledge brain
      }
    }

    // ── Action Handlers ──────────────────────────────────────────────────────

    // A. Group Status
    if (targetAction === 'get_group_status') {
      const locations = getRideLocations(rideId);
      const totalCount = ride.participants.length;
      const liveCount = Array.from(locations.values()).filter(
        (l) => Date.now() - (l.lastHeartbeat || 0) < 60000
      ).length;

      const spoken = `Convoy diagnostic, sir: There are ${totalCount} riders registered in this convoy, with ${liveCount} currently broadcasting live telemetry.`;
      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: {
          title: ride.title,
          totalRiders: totalCount,
          activeLiveRiders: liveCount,
          speedLimit: ride.speedLimit || 80,
          roadCondition: ride.roadCondition || 'Highway',
        },
      });
    }

    // B. Rider Status / Separation
    if (targetAction === 'get_rider_status') {
      const locations = getRideLocations(rideId);
      const leaderId = (ride.createdBy?._id || ride.createdBy).toString();
      const leaderLoc = locations.get(leaderId);
      const separatedRiders = [];

      ride.participants.forEach((p) => {
        const pid = (p._id || p).toString();
        if (pid === leaderId) return;
        const loc = locations.get(pid);
        if (leaderLoc?.lat != null && loc?.lat != null) {
          const dist = calculateDistanceKm(leaderLoc.lat, leaderLoc.lng, loc.lat, loc.lng);
          if (dist != null && dist > 1.5) {
            separatedRiders.push({ name: p.name, distanceKm: dist, speed: loc.speed || 0 });
          }
        }
      });

      let spoken = '';
      if (separatedRiders.length === 0) {
        spoken = 'Convoy is in tight tactical formation, sir. No riders are trailing beyond 1.5 kilometers.';
      } else {
        const riderDetails = separatedRiders.map((r) => `${r.name} at ${r.distanceKm} km`).join(', ');
        spoken = `Heads-up, sir: ${separatedRiders.length} rider(s) are separated from the leader: ${riderDetails}.`;
      }

      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: { separatedRiders, totalTracked: locations.size },
      });
    }

    // C. Active Alerts
    if (targetAction === 'get_active_alerts') {
      const alerts = await Alert.find({ ride: rideId, resolved: false }).populate('user', 'name');
      const hazards = await Hazard.find({ ride: rideId, resolved: false });

      let spoken = '';
      if (alerts.length === 0 && hazards.length === 0) {
        spoken = 'All systems nominal, sir. There are no active SOS emergencies or reported road hazards on this route.';
      } else {
        spoken = `Tactical notice, sir: There are ${alerts.length} unresolved alerts and ${hazards.length} road hazards currently flagged.`;
      }

      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: { activeAlerts: alerts, activeHazards: hazards },
      });
    }

    // D. Ride Summary
    if (targetAction === 'get_ride_summary') {
      const startTime = ride.startedAt ? new Date(ride.startedAt).getTime() : new Date(ride.createdAt).getTime();
      const elapsedMinutes = Math.max(1, Math.round((Date.now() - startTime) / 60000));
      const hours = Math.floor(elapsedMinutes / 60);
      const mins = elapsedMinutes % 60;
      const timeStr = hours > 0 ? `${hours} hours and ${mins} minutes` : `${mins} minutes`;

      const spoken = `Ride telemetry for "${ride.title}" to ${ride.destination || 'destination'}, sir. Total planned distance is ${ride.distanceKm || 'not set'} kilometers, en route for ${timeStr}.`;

      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: {
          title: ride.title,
          startLocation: ride.startLocation,
          destination: ride.destination,
          distanceKm: ride.distanceKm,
          elapsedMinutes,
        },
      });
    }

    // E. Send Group Message
    if (targetAction === 'send_group_message') {
      let messageContent = parameters?.message || '';
      if (!messageContent) {
        let text = command.trim();
        // Remove wake phrases if still attached
        text = text.replace(/^(?:hey|hi|okay)?\s*primus\s*[,:]?\s*/i, '');
        // Remove opening/sending prefixes
        text = text.replace(
          /^(?:please\s+)?(?:open\s+(?:the\s+)?chat(?:\s+box)?\s+and\s+)?(?:send\s+(?:a\s+)?(?:chat\s+)?message|send\s+message|tell\s+everyone|tell\s+the\s+group|message\s+(?:the\s+)?group|message\s+everyone|broadcast|post\s+(?:a\s+)?message|say\s+to\s+group|chat)\s*(?:to\s+(?:the\s+)?(?:group|convoy|everyone)\s*)?(?:saying|that|:)?\s*/i,
          ''
        );
        // Strip wrapping double or single quotes
        text = text.replace(/^["'“”‘`](.*)["'“”‘`]$/s, '$1');
        messageContent = text.trim();
      }

      if (!messageContent || messageContent.length < 1) {
        return res.status(400).json({
          success: false,
          spokenResponse: 'What message shall I transmit to the convoy, sir?',
          error: 'Message content is empty.',
        });
      }

      const newMsg = await Message.create({
        ride: ride._id,
        group: ride.group,
        sender: req.user.id,
        text: `[PRIMUS Voice Note] ${messageContent}`,
      });

      const populated = await newMsg.populate('sender', 'name role profilePic');

      if (io) {
        io.to(`ride:${rideId}`).emit('chat:message', {
          id: populated._id,
          rideId,
          user: populated.sender,
          sender: populated.sender,
          content: populated.text,
          text: populated.text,
          createdAt: populated.createdAt,
        });
      }

      const spoken = `Right away, sir. Broadcasted voice transmission to the convoy: "${messageContent}".`;
      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: { messageId: populated._id, content: populated.text, openChat: true },
      });
    }

    // E2. Open / Close In-Ride Chat
    if (targetAction === 'open_chat') {
      return res.json({
        success: true,
        action: 'open_chat',
        spokenResponse: 'Opening the in-ride chat drawer, sir.',
        data: { open: true },
      });
    }

    if (targetAction === 'close_chat') {
      return res.json({
        success: true,
        action: 'close_chat',
        spokenResponse: 'Closing the chat drawer, sir.',
        data: { open: false },
      });
    }

    // E3. Open / Close Contacts Panel
    if (targetAction === 'open_contacts') {
      return res.json({
        success: true,
        action: 'open_contacts',
        spokenResponse: 'Opening contacts panel, sir.',
        data: { openContacts: true },
      });
    }

    if (targetAction === 'close_contacts') {
      return res.json({
        success: true,
        action: 'close_contacts',
        spokenResponse: 'Closing contacts panel, sir.',
        data: { openContacts: false },
      });
    }

    // F. Notify Ride Leader
    if (targetAction === 'notify_ride_leader') {
      const leaderId = (ride.createdBy?._id || ride.createdBy).toString();
      const isLeaderHimself = leaderId === req.user.id;

      let reason = parameters.reason || '';
      if (!reason) {
        const match = command.match(/(?:notify leader|tell leader|need stop|because)\s+(.+)/i);
        reason = match ? match[1].trim() : 'Rider requested assistance or a pause.';
      }

      if (isLeaderHimself) {
        return res.json({
          success: true,
          action: targetAction,
          spokenResponse: 'You are the convoy leader, sir. You can broadcast a message or set a regrouping waypoint.',
          data: { isLeader: true },
        });
      }

      const payload = {
        rideId,
        fromUserId: req.user.id,
        fromName: req.user.name,
        reason,
        timestamp: new Date().toISOString(),
      };

      if (io) {
        // High priority tactical notification delivered to the leader's personal room & ride room
        io.to(`user:${leaderId}`).emit('primus:leader_alert', payload);
        io.to(`ride:${rideId}`).emit('primus:leader_alert', payload);
      }

      const spoken = `Priority alert dispatched directly to Captain ${ride.createdBy?.name || 'Leader'}, sir: "${reason}".`;
      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: payload,
      });
    }

    // G. Request Regrouping Point
    if (targetAction === 'request_regrouping_point') {
      const locations = getRideLocations(rideId);
      const userLoc = locations.get(req.user.id);

      const regroupPoint = {
        name: parameters.pointName || 'Upcoming Regroup Point',
        lat: parameters.lat || userLoc?.lat || myPos?.lat || 9.5916,
        lng: parameters.lng || userLoc?.lng || myPos?.lng || 76.5222,
        proposedBy: req.user.name,
        isLeader,
        timestamp: new Date().toISOString(),
      };

      if (io) {
        io.to(`ride:${rideId}`).emit('primus:regroup_proposed', regroupPoint);
      }

      const spoken = isLeader
        ? `Regrouping coordinates dispatched to the entire convoy, sir: ${regroupPoint.name}.`
        : `Regrouping recommendation submitted for leader confirmation, sir: ${regroupPoint.name}.`;

      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: regroupPoint,
      });
    }

    // H. Nearby places (REAL data from OpenStreetMap Overpass)
    const nearbyKinds = {
      find_fuel: 'fuel',
      suggest_nearby_places: 'fuel',
      find_food: 'food',
      find_hospital: 'hospital',
      find_atm: 'atm',
      find_mechanic: 'mechanic',
    };
    if (nearbyKinds[targetAction]) {
      if (!myPos) {
        return res.json({
          success: true,
          action: targetAction,
          spokenResponse: "I don't have your GPS position yet, sir. Please allow location access and try again.",
        });
      }
      const { label, places } = await brain.findNearby(myPos.lat, myPos.lng, nearbyKinds[targetAction]);
      let spoken;
      if (places === null) {
        spoken = `I couldn't reach the places database just now, sir. Please try again in a moment.`;
      } else if (places.length === 0) {
        spoken = `I don't see any ${label} within 8 kilometers of you, sir.`;
      } else {
        const top = places[0];
        spoken = `Nearest ${label} is ${top.name}, ${top.distanceKm} kilometers away.`;
        if (places[1]) spoken += ` Next is ${places[1].name} at ${places[1].distanceKm} kilometers.`;
      }
      return res.json({ success: true, action: targetAction, spokenResponse: spoken, data: { places: places || [] } });
    }

    // H2. ETA / distance to destination (live: from the rider's current position)
    if (targetAction === 'get_eta') {
      if (!ride.destination && !ride.destCoords?.lat) {
        return res.json({ success: true, action: targetAction, spokenResponse: 'This ride has no destination set, sir.' });
      }
      if (!myPos) {
        const fallback = ride.durationMinutes
          ? `I don't have your live position yet, sir. The planned trip to ${ride.destination} is ${ride.distanceKm || 'unknown'} kilometers, about ${brain.formatDuration(ride.durationMinutes)}.`
          : "I don't have your GPS position yet, sir. Please allow location access.";
        return res.json({ success: true, action: targetAction, spokenResponse: fallback });
      }
      const dest =
        typeof ride.destCoords?.lat === 'number'
          ? { lat: ride.destCoords.lat, lng: ride.destCoords.lng }
          : await brain.geocode(ride.destination);
      if (!dest) {
        return res.json({ success: true, action: targetAction, spokenResponse: `I couldn't locate ${ride.destination} on the map, sir.` });
      }
      const route = await brain.getRoute(myPos, dest);
      const arrival = new Date(Date.now() + route.durationMin * 60000).toLocaleTimeString('en-IN', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      });
      const approx = route.source === 'estimate' ? ' (approximate)' : '';
      const spoken = `${ride.destination || 'Your destination'} is ${route.distanceKm} kilometers away, sir. About ${brain.formatDuration(route.durationMin)}${approx}, arriving around ${arrival}.`;
      return res.json({ success: true, action: targetAction, spokenResponse: spoken, data: { ...route, destination: ride.destination } });
    }

    // I. Weather & Road Conditions (Open-Meteo & Real-Time Convoy Road Status)
    if (targetAction === 'get_weather_road_conditions') {
      const locations = getRideLocations(rideId);
      const userLoc = locations.get(req.user.id);
      const leaderId = (ride.createdBy?._id || ride.createdBy).toString();
      const leaderLoc = locations.get(leaderId);
      const currentPos = myPos || userLoc || leaderLoc;

      const lat = currentPos?.lat || 9.5916;
      const lng = currentPos?.lng || 76.5222;

      const weather = await fetchWeather(lat, lng);
      const hazards = await Hazard.find({ ride: rideId, resolved: false }).populate('reportedBy', 'name');

      const roadCondition = ride.roadCondition || (weather ? weather.roadCondition : 'Highway');
      const speedLimit = ride.speedLimit || (weather ? weather.suggestedSpeed : 80);

      let spoken = '';
      if (weather) {
        spoken = `Route climate scan, sir: Weather is ${weather.description}, temperature is ${weather.temp} degrees Celsius with wind at ${weather.windSpeed} km/h. Road condition is ${roadCondition}, with a speed limit of ${speedLimit} km/h.`;
        if (weather.isRain) {
          spoken += ` Precipitation probability is ${weather.precipProb} percent. Wet asphalt warning active, exercise caution.`;
        }
      } else {
        spoken = `Current road condition is ${roadCondition} with a recommended convoy speed limit of ${speedLimit} km/h, sir.`;
      }

      if (hazards.length > 0) {
        const hazardSummary = hazards.map((h) => `${h.type} reported by ${h.reportedBy?.name || 'rider'}`).join(', ');
        spoken += ` Attention: ${hazards.length} road hazard(s) flagged ahead: ${hazardSummary}.`;
      } else {
        spoken += ' No reported hazards on this stretch.';
      }

      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: spoken,
        data: {
          weather,
          roadCondition,
          speedLimit,
          activeHazardsCount: hazards.length,
          hazards,
        },
      });
    }

    // J. Deactivate PRIMUS Session
    if (targetAction === 'deactivate_primus') {
      return res.json({
        success: true,
        action: targetAction,
        spokenResponse: 'Putting tactical systems on standby, sir. Safety tracking and SOS continue actively in the background.',
        data: { state: 'STANDBY' },
      });
    }

    // Fallback: conversational & live-knowledge brain
    const lower = cmd;

    if (/\b(who are you|what is primus|your name)\b/.test(lower)) {
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: 'I am PRIMUS, your GROUP-LOCK tactical AI ride companion. I monitor convoy telemetry, navigation, and rider safety.',
      });
    }

    if (/\b(what can you do|help|commands|features)\b/.test(lower)) {
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: 'You can ask me to check convoy status, find fuel, food, or hospital nearby, check weather, calculate ETA, notify the leader, or send a message to the group chat.',
      });
    }

    if (/\b(destination|where are we going|where to)\b/.test(lower)) {
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: `Our ride destination is ${ride.destination || 'not set'}, with a total route of ${ride.distanceKm || 0} kilometers.`,
      });
    }

    if (/\b(where did we start|start point|starting point)\b/.test(lower)) {
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: `We rolled out from ${ride.startLocation || 'our origin'}.`,
      });
    }

    if (/\b(my speed|how fast am i|current speed)\b/.test(lower)) {
      const spd = myPos?.speed ? Math.round(myPos.speed) : 0;
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: `Your current telemetry speed is ${spd} kilometers per hour. Speed limit is ${ride.speedLimit || 80} km/h.`,
      });
    }

    if (/^(hi|hello|hey|good morning|good afternoon|good evening|namaste)\b/i.test(command.trim())) {
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: `Hello ${req.user.name || 'sir'}! Tactical systems are active and monitoring your convoy. How can I assist you?`,
      });
    }

    // If external AI brain is configured, query it for open-domain questions
    if (brain.brainAvailable()) {
      const brainContext = {
        ride: { title: ride.title, from: ride.startLocation, to: ride.destination, plannedKm: ride.distanceKm, status: ride.status },
        rider: { name: req.user.name, role, speedKmh: myPos?.speed ?? null, hasGps: !!myPos },
        ridersInRide: ride.participants.length,
        nowIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };
      const answer = await brain.askBrain({ question: command, context: brainContext, history });
      return res.json({
        success: true,
        action: 'general_ride_query',
        spokenResponse: answer || "I couldn't get an answer just now, sir. Please try again.",
      });
    }

    // Default friendly fallback for unrecognized queries without crashing or saying brain is offline
    return res.json({
      success: true,
      action: 'general_ride_query',
      spokenResponse: "I didn't quite catch that ride command, sir. You can say 'check convoy', 'find fuel', 'get ETA', 'notify leader', or 'send message'.",
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/primus/contacts/:rideId  (people in this ride's group, for "message Abhin")
// ─────────────────────────────────────────────────────────────────────────────
async function getRideContacts(req, res, next) {
  try {
    const { rideId } = req.params;
    const { ride, group } = await resolveRiderContext(rideId, req.user.id);
    const ids = new Set();
    (group.members || []).forEach((m) => ids.add((m.user?._id || m.user).toString()));
    (ride.participants || []).forEach((p) => ids.add((p._id || p).toString()));
    ids.delete(req.user.id.toString());
    const users = await User.find({ _id: { $in: [...ids] } }).select('name username phone');
    res.json({
      success: true,
      contacts: users.filter((u) => u.phone).map((u) => ({ id: u._id, name: u.name, username: u.username || '', phone: u.phone })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getRideContacts,
  getRideContext,
  getProactiveInsights,
  executePrimusCommand,
};
