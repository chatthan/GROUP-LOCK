const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const Ride = require('../models/Ride');
const Message = require('../models/Message');
const Alert = require('../models/Alert');
const RideEvent = require('../models/RideEvent');
const Hazard = require('../models/Hazard');

// In-memory store for live rider locations per active ride:
// Map<rideId, Map<userId, RiderLocationObject>>
const activeRideLocations = new Map();

// In-memory store for active regroup calls:
// Map<rideId, RegroupObject>
const activeRegroups = new Map();

// In-memory store for ride configurations (speedLimit, roadCondition, sweepRiderId)
// Map<rideId, { speedLimit: number, roadCondition: string, sweepRiderId: string | null }>
const activeRideConfigs = new Map();

// In-memory map to throttle overspeed alerts per rider (20s cooldown)
// Map<`${rideId}:${userId}`, number>
const lastOverspeedAlertTimes = new Map();

// In-memory map for socket disconnection grace periods (prevents flapping on brief network drops)
// Map<`${rideId}:${userId}`, NodeJS.Timeout>
const disconnectGraceTimers = new Map();

function getRideLocations(rideId) {
  if (!activeRideLocations.has(rideId)) {
    activeRideLocations.set(rideId, new Map());
  }
  return activeRideLocations.get(rideId);
}

let ioInstance = null;

function getIO() {
  return ioInstance;
}

function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // Allow mobile apps, curl, dev environment, or wildcard
        if (!origin || env.nodeEnv === 'development' || env.clientOrigins.includes('*')) {
          return callback(null, true);
        }
        if (
          env.clientOrigins.includes(origin) ||
          origin.endsWith('.ngrok-free.app') ||
          origin.endsWith('.ngrok.io') ||
          origin.endsWith('.loca.lt') ||
          origin.endsWith('.trycloudflare.com') ||
          origin.endsWith('.pinggy.link')
        ) {
          return callback(null, true);
        }
        // Allow local LAN IP ranges for mobile testing (192.168.x.x, 10.x.x.x, etc.)
        if (/^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        return callback(null, true);
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  ioInstance = io;

  // Authentication middleware for Socket.IO handshakes
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, env.jwt.accessSecret);
      const user = await User.findById(decoded.id).select(
        '_id name email phone bloodGroup city state profilePic role emergencyContact'
      );

      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user._id.toString();
    console.log(`[Socket] Rider connected: ${socket.user.name} (${userId})`);
    socket.join(`user:${userId}`);

    // Group Rooms: Real-time member synchronization without refreshing
    socket.on('join_group', ({ groupId }) => {
      if (!groupId) return;
      socket.join(`group:${groupId}`);
      console.log(`[Socket] Rider ${socket.user.name} joined group:group:${groupId}`);
    });

    socket.on('leave_group', ({ groupId }) => {
      if (!groupId) return;
      socket.leave(`group:${groupId}`);
      console.log(`[Socket] Rider ${socket.user.name} left group:group:${groupId}`);
    });

    // 1. Join ride room & auto-enroll in participants
    socket.on('join_ride', async ({ rideId, lat, lng, speed, heading, accuracy }, callback) => {
      try {
        if (!rideId) return;

        // Auto-enroll user in ride participants if not already present
        await Ride.findByIdAndUpdate(rideId, {
          $addToSet: { participants: socket.user._id },
        });

        const ride = await Ride.findById(rideId)
          .populate('createdBy', 'name email phone bloodGroup profilePic city state role emergencyContact')
          .populate('participants', 'name email phone bloodGroup profilePic city state role emergencyContact')
          .populate('sweepRider', 'name email phone bloodGroup profilePic city state role emergencyContact');

        if (!ride) {
          if (callback) callback({ error: 'Ride not found' });
          return;
        }

        const roomName = `ride:${rideId}`;
        socket.join(roomName);
        socket.currentRideId = rideId;

        // Cache ride configuration in memory
        activeRideConfigs.set(rideId, {
          speedLimit: ride.speedLimit || 80,
          roadCondition: ride.roadCondition || 'Highway',
          sweepRiderId: ride.sweepRider ? (ride.sweepRider._id || ride.sweepRider).toString() : null,
        });

        const locationsMap = getRideLocations(rideId);
        const timerKey = `${rideId}:${userId}`;

        // Clear any pending disconnect grace timer since rider reconnected
        if (disconnectGraceTimers.has(timerKey)) {
          clearTimeout(disconnectGraceTimers.get(timerKey));
          disconnectGraceTimers.delete(timerKey);
          console.log(`[Socket] Cancelled disconnect grace timer for ${socket.user.name} (${userId})`);
        }

        const existingRider = locationsMap.get(userId);
        const wasAlreadyLive =
          existingRider &&
          existingRider.status !== 'OFFLINE' &&
          existingRider.status !== 'LEFT';

        // If coordinates provided at join time, record them immediately
        if (typeof lat === 'number' && typeof lng === 'number') {
          const riderLocationData = {
            userId,
            name: socket.user.name,
            email: socket.user.email,
            phone: socket.user.phone,
            bloodGroup: socket.user.bloodGroup,
            city: socket.user.city,
            state: socket.user.state,
            profilePic: socket.user.profilePic,
            role: socket.user.role,
            lat,
            lng,
            accuracy: typeof accuracy === 'number' ? Math.round(accuracy) : null,
            speed: typeof speed === 'number' ? Math.round(speed) : 0,
            heading: typeof heading === 'number' ? Math.round(heading) : 0,
            updatedAt: new Date().toISOString(),
            status: 'LIVE',
            lastHeartbeat: Date.now(),
          };
          locationsMap.set(userId, riderLocationData);
        }

        const allRiders = Array.from(locationsMap.values());
        const activeRegroup = activeRegroups.get(rideId) || null;

        // Notify others in room with full rider identification details and initial location
        const joinPayload = {
          userId,
          name: socket.user.name,
          email: socket.user.email,
          phone: socket.user.phone,
          bloodGroup: socket.user.bloodGroup,
          city: socket.user.city,
          state: socket.user.state,
          profilePic: socket.user.profilePic,
          role: socket.user.role,
          ...(typeof lat === 'number' && typeof lng === 'number' ? {
            lat,
            lng,
            accuracy: typeof accuracy === 'number' ? Math.round(accuracy) : null,
            speed: typeof speed === 'number' ? Math.round(speed) : 0,
            heading: typeof heading === 'number' ? Math.round(heading) : 0,
            status: 'LIVE',
            updatedAt: new Date().toISOString(),
          } : {}),
        };

        if (!wasAlreadyLive) {
          socket.to(roomName).emit('rider:joined', joinPayload);
        }

        if (typeof lat === 'number' && typeof lng === 'number') {
          socket.to(roomName).emit('rider:location_update', locationsMap.get(userId));
        }

        // Real-Time Location Handshake:
        // Request all active riders in the room to ping their latest coordinates
        // so the new joiner instantly receives all existing markers without waiting for movement!
        socket.to(roomName).emit('request:location_ping', { requestedBy: userId });

        // Fetch active road hazards for the ride (Stage 10)
        const activeHazards = await Hazard.find({ ride: rideId, resolved: false })
          .populate('reportedBy', 'name profilePic role')
          .populate('confirmations.user', 'name');

        // Send existing live locations, active regroup, participants, config, and hazards to joiner
        if (callback) {
          callback({
            success: true,
            riders: allRiders,
            activeRegroup,
            participants: ride.participants || [],
            ride: {
              id: ride._id,
              title: ride.title,
              status: ride.status,
              startLocation: ride.startLocation,
              destination: ride.destination,
              distanceKm: ride.distanceKm,
              creatorId: ride.createdBy?._id || ride.createdBy,
              sweepRider: ride.sweepRider || null,
              roadCondition: ride.roadCondition || 'Highway',
              speedLimit: ride.speedLimit || 80,
            },
            reports: ride.reports || [],
            kickedParticipants: ride.kickedParticipants || [],
            hazards: activeHazards || [],
          });
        }
      } catch (err) {
        console.error('[Socket] join_ride error:', err);
        if (callback) callback({ error: 'Failed to join ride' });
      }
    });

    // Location Handshake Relay: Riders can request latest pings from everyone
    socket.on('request:location_ping', ({ rideId }) => {
      if (!rideId) return;
      socket.to(`ride:${rideId}`).emit('request:location_ping', { requestedBy: userId });
    });

    // 2. Broadcast live GPS location & Detect Overspeeding / Aggressive Riding
    socket.on('location:update', async ({ rideId, lat, lng, speed, heading, accuracy }) => {
      if (!rideId || typeof lat !== 'number' || typeof lng !== 'number') return;

      const locationsMap = getRideLocations(rideId);
      const riderData = {
        userId,
        name: socket.user.name,
        email: socket.user.email,
        phone: socket.user.phone,
        bloodGroup: socket.user.bloodGroup,
        city: socket.user.city,
        state: socket.user.state,
        profilePic: socket.user.profilePic,
        role: socket.user.role,
        lat,
        lng,
        accuracy: typeof accuracy === 'number' ? Math.round(accuracy) : null,
        speed: typeof speed === 'number' ? Math.round(speed) : 0,
        heading: typeof heading === 'number' ? Math.round(heading) : 0,
        updatedAt: new Date().toISOString(),
        status: 'LIVE',
        lastHeartbeat: Date.now(),
      };

      locationsMap.set(userId, riderData);

      // Broadcast to all other riders in this ride's room
      socket.to(`ride:${rideId}`).emit('rider:location_update', riderData);

      // Stage 4: Overspeed & Aggressive Riding Detection
      try {
        let config = activeRideConfigs.get(rideId);
        if (!config) {
          const r = await Ride.findById(rideId).select('speedLimit roadCondition sweepRider');
          if (r) {
            config = {
              speedLimit: r.speedLimit || 80,
              roadCondition: r.roadCondition || 'Highway',
              sweepRiderId: r.sweepRider ? r.sweepRider.toString() : null,
            };
            activeRideConfigs.set(rideId, config);
          }
        }

        const currentSpeed = riderData.speed;
        const currentLimit = config?.speedLimit || 80;

        // Trigger overspeed alert if rider exceeds limit by more than 5 km/h
        if (currentSpeed > currentLimit + 5) {
          const key = `${rideId}:${userId}`;
          const lastAlert = lastOverspeedAlertTimes.get(key) || 0;
          const now = Date.now();

          // 20-second cooldown per rider
          if (now - lastAlert > 20000) {
            lastOverspeedAlertTimes.set(key, now);
            const excess = currentSpeed - currentLimit;
            const overspeedPayload = {
              rideId,
              userId,
              name: socket.user.name,
              speed: currentSpeed,
              speedLimit: currentLimit,
              excess,
              roadCondition: config?.roadCondition || 'Highway',
              lat,
              lng,
              timestamp: new Date().toISOString(),
            };

            // Broadcast alert to everyone in the ride
            io.to(`ride:${rideId}`).emit('alert:overspeed', overspeedPayload);

            // Log event in database asynchronously
            Ride.findById(rideId).then((r) => {
              if (r) {
                RideEvent.create({
                  ride: rideId,
                  group: r.group,
                  type: 'OVERSPEED',
                  user: socket.user._id,
                  severity: excess >= 25 ? 'CRITICAL' : 'WARNING',
                  location: { lat, lng },
                  metadata: {
                    speed: currentSpeed,
                    speedLimit: currentLimit,
                    excess,
                    roadCondition: config?.roadCondition || 'Highway',
                  },
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('[Socket] Overspeed check error:', err);
      }
    });

    // Stage 7: Synchronize Batch GPS Locations Queued in Dead Zones
    socket.on('ride:batch_locations', async ({ rideId, locations }, callback) => {
      try {
        if (!rideId || !Array.isArray(locations) || locations.length === 0) {
          if (callback) callback({ error: 'No location pings provided in batch' });
          return;
        }

        // Sort chronologically
        const sortedLocations = [...locations].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const latestPoint = sortedLocations[sortedLocations.length - 1];
        const earliestPoint = sortedLocations[0];

        // Retrieve or initialize config
        let config = activeRideConfigs.get(rideId);
        if (!config) {
          const r = await Ride.findById(rideId).select('speedLimit roadCondition sweepRider group');
          if (r) {
            config = {
              speedLimit: r.speedLimit || 80,
              roadCondition: r.roadCondition || 'Highway',
              sweepRiderId: r.sweepRider ? r.sweepRider.toString() : null,
              groupId: r.group,
            };
            activeRideConfigs.set(rideId, config);
          }
        }

        const limit = config?.speedLimit || 80;
        let maxSpeedInBatch = 0;
        let overspeedIncidents = 0;

        // Audit offline pings for speeds & violations
        for (const pt of sortedLocations) {
          const ptSpeed = typeof pt.speed === 'number' ? Math.round(pt.speed) : 0;
          if (ptSpeed > maxSpeedInBatch) {
            maxSpeedInBatch = ptSpeed;
          }
          if (ptSpeed > limit + 5) {
            overspeedIncidents++;
          }
        }

        // If overspeeding occurred in the dead zone, record event for post-ride audit
        if (overspeedIncidents > 0 && config?.groupId) {
          RideEvent.create({
            ride: rideId,
            group: config.groupId,
            type: 'OVERSPEED',
            user: socket.user._id,
            severity: maxSpeedInBatch >= limit + 25 ? 'CRITICAL' : 'WARNING',
            location: { lat: latestPoint.lat, lng: latestPoint.lng },
            metadata: {
              speed: maxSpeedInBatch,
              speedLimit: limit,
              excess: maxSpeedInBatch - limit,
              roadCondition: config.roadCondition || 'Highway',
              note: `Recorded offline in dead zone (${overspeedIncidents} violation ping(s))`,
              batchCount: sortedLocations.length,
            },
          }).catch(() => {});
        }

        // Update active in-memory locations
        const locationsMap = getRideLocations(rideId);
        const riderData = {
          userId,
          name: socket.user.name,
          email: socket.user.email,
          phone: socket.user.phone,
          bloodGroup: socket.user.bloodGroup,
          city: socket.user.city,
          state: socket.user.state,
          profilePic: socket.user.profilePic,
          role: socket.user.role,
          lat: latestPoint.lat,
          lng: latestPoint.lng,
          speed: typeof latestPoint.speed === 'number' ? Math.round(latestPoint.speed) : 0,
          heading: typeof latestPoint.heading === 'number' ? Math.round(latestPoint.heading) : 0,
          updatedAt: new Date(latestPoint.timestamp || Date.now()).toISOString(),
          status: 'LIVE',
          lastHeartbeat: Date.now(),
        };

        locationsMap.set(userId, riderData);

        // Build a sampled breadcrumb trail for smooth map replay (max 40 coordinates)
        const stride = Math.max(1, Math.floor(sortedLocations.length / 40));
        const breadcrumbs = [];
        for (let i = 0; i < sortedLocations.length; i += stride) {
          breadcrumbs.push([sortedLocations[i].lat, sortedLocations[i].lng]);
        }
        // Always include the latest point
        if (breadcrumbs.length === 0 || breadcrumbs[breadcrumbs.length - 1][0] !== latestPoint.lat || breadcrumbs[breadcrumbs.length - 1][1] !== latestPoint.lng) {
          breadcrumbs.push([latestPoint.lat, latestPoint.lng]);
        }

        const syncPayload = {
          userId,
          name: socket.user.name,
          count: sortedLocations.length,
          latestLocation: riderData,
          breadcrumbs,
          maxSpeed: maxSpeedInBatch,
          overspeedIncidents,
          fromTime: earliestPoint.timestamp ? new Date(earliestPoint.timestamp).toISOString() : null,
          toTime: latestPoint.timestamp ? new Date(latestPoint.timestamp).toISOString() : null,
        };

        // Broadcast to all other riders in this ride
        socket.to(`ride:${rideId}`).emit('rider:batch_synced', syncPayload);
        socket.to(`ride:${rideId}`).emit('rider:location_update', riderData);
        io.to(`ride:${rideId}`).emit('rider:status_update', {
          userId,
          status: 'LIVE',
          updatedAt: new Date().toISOString(),
        });

        // Resolve any open network-loss alerts for this user
        Alert.updateMany(
          { ride: rideId, user: socket.user._id, type: 'network-loss', resolved: false },
          { resolved: true, resolvedAt: new Date() }
        ).catch(() => {});

        // Log connectivity restore event
        Ride.findById(rideId).then((r) => {
          if (r) {
            RideEvent.create({
              ride: rideId,
              group: r.group,
              type: 'CONNECTIVITY',
              user: socket.user._id,
              severity: 'INFO',
              location: { lat: latestPoint.lat, lng: latestPoint.lng },
              metadata: {
                action: 'DEAD_ZONE_SYNC',
                syncedCount: sortedLocations.length,
                maxSpeed: maxSpeedInBatch,
              },
            }).catch(() => {});
          }
        }).catch(() => {});

        console.log(`[Socket] Reconciled ${sortedLocations.length} dead-zone pings for ${socket.user.name}`);
        if (callback) {
          callback({
            success: true,
            count: sortedLocations.length,
            latestLocation: riderData,
          });
        }
      } catch (err) {
        console.error('[Socket] ride:batch_locations error:', err);
        if (callback) callback({ error: 'Failed to process batch locations' });
      }
    });

    // 3. In-ride chat message (convoy-wide or private 1-on-1 direct message)
    socket.on('chat:send', async ({ rideId, text, recipientId }, callback) => {
      try {
        if (!rideId || !text || !text.trim()) return;

        const ride = await Ride.findById(rideId);
        if (!ride) return;

        let isPrivate = false;
        let recipientUser = null;

        if (recipientId && recipientId !== 'everyone') {
          recipientUser = await User.findById(recipientId).select('_id name profilePic');
          if (recipientUser) {
            isPrivate = true;
          }
        }

        const message = await Message.create({
          ride: rideId,
          group: ride.group,
          sender: socket.user._id,
          recipient: isPrivate ? recipientUser._id : null,
          isPrivate,
          text: text.trim(),
        });

        const formattedMessage = {
          id: message._id,
          rideId,
          text: message.text,
          isPrivate,
          recipient: isPrivate
            ? {
                id: recipientUser._id.toString(),
                name: recipientUser.name,
                profilePic: recipientUser.profilePic || '',
              }
            : null,
          sender: {
            id: socket.user._id.toString(),
            name: socket.user.name,
            profilePic: socket.user.profilePic || '',
          },
          createdAt: message.createdAt,
        };

        if (isPrivate && recipientUser) {
          // Emit only to recipient's personal user room AND sender's personal user room
          io.to(`user:${recipientUser._id}`).to(`user:${socket.user._id}`).emit('chat:new_message', formattedMessage);
        } else {
          // Broadcast to everyone in the ride room (including sender)
          io.to(`ride:${rideId}`).emit('chat:new_message', formattedMessage);
        }

        if (callback) callback({ success: true, message: formattedMessage });
      } catch (err) {
        console.error('[Socket] chat:send error:', err);
        if (callback) callback({ error: 'Failed to send message' });
      }
    });

    // 4. Trigger SOS Emergency Alert (Stage 6 Enhanced)
    socket.on('sos:trigger', async ({ rideId, lat, lng, note, description }, callback) => {
      try {
        if (!rideId) return;

        const ride = await Ride.findById(rideId);
        if (!ride) return;

        const fullUser = await User.findById(socket.user._id);
        const resolvedNote = (description || note || '').trim() || 'Emergency SOS triggered by rider!';

        const alert = await Alert.create({
          ride: rideId,
          group: ride.group,
          user: socket.user._id,
          type: 'sos',
          location: lat && lng ? { lat, lng } : undefined,
          note: resolvedNote,
          description: resolvedNote,
          escalationLevel: 'CONVOY',
          resolved: false,
        });

        // Record Discrete RideEvent
        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'SOS',
          user: socket.user._id,
          severity: 'CRITICAL',
          location: lat && lng ? { lat, lng } : undefined,
          metadata: {
            alertId: alert._id,
            escalationLevel: 'CONVOY',
            note: resolvedNote,
            description: resolvedNote,
          },
        }).catch(() => {});

        const sosPayload = {
          id: alert._id,
          rideId,
          type: 'sos',
          user: {
            id: socket.user._id,
            name: socket.user.name,
            phone: socket.user.phone,
            bloodGroup: socket.user.bloodGroup,
            profilePic: socket.user.profilePic,
            emergencyContact: fullUser?.emergencyContact || null,
          },
          location: lat && lng ? { lat, lng } : null,
          note: resolvedNote,
          description: resolvedNote,
          escalationLevel: alert.escalationLevel,
          escalatedAt: alert.escalatedAt,
          createdAt: alert.createdAt,
        };

        // Broadcast to ALL riders in the room with highest priority
        io.to(`ride:${rideId}`).emit('sos:alert', sosPayload);

        // Also post an emergency announcement in convoy chat so the description is visible to all
        try {
          const chatMsg = await Message.create({
            ride: rideId,
            group: ride.group,
            sender: socket.user._id,
            isPrivate: false,
            text: `🚨 [EMERGENCY SOS] ${socket.user.name}: ${resolvedNote}`,
          });
          io.to(`ride:${rideId}`).emit('chat:new_message', {
            id: chatMsg._id,
            rideId,
            text: chatMsg.text,
            isPrivate: false,
            recipient: null,
            sender: {
              id: socket.user._id.toString(),
              name: socket.user.name,
              profilePic: socket.user.profilePic || '',
            },
            createdAt: chatMsg.createdAt,
          });
        } catch (chatErr) {
          console.warn('[Socket] Failed to post SOS to chat:', chatErr.message);
        }

        if (callback) callback({ success: true, alert: sosPayload });
      } catch (err) {
        console.error('[Socket] sos:trigger error:', err);
        if (callback) callback({ error: 'Failed to trigger SOS' });
      }
    });

    // 5. Escalate SOS Emergency Alert (Stage 6)
    socket.on('sos:escalate', async ({ alertId, rideId, targetLevel }, callback) => {
      try {
        if (!alertId) return;

        const alert = await Alert.findById(alertId).populate(
          'user',
          'name phone bloodGroup profilePic emergencyContact'
        );
        if (!alert) return;

        const nextLvl = targetLevel || (alert.escalationLevel === 'CONVOY' ? 'EMERGENCY_CONTACTS' : 'AUTHORITIES');
        alert.escalationLevel = nextLvl;
        alert.escalatedAt = new Date();
        await alert.save();

        const ride = await Ride.findById(alert.ride);
        if (ride) {
          await RideEvent.create({
            ride: alert.ride,
            group: ride.group,
            type: 'SOS',
            user: socket.user._id,
            severity: 'CRITICAL',
            metadata: {
              action: 'MANUAL_ESCALATE',
              alertId: alert._id,
              escalationLevel: nextLvl,
              escalatedBy: socket.user._id,
            },
          }).catch(() => {});
        }

        const payload = {
          alertId: alert._id,
          escalationLevel: alert.escalationLevel,
          escalatedAt: alert.escalatedAt,
          user: {
            id: alert.user?._id || alert.user,
            name: alert.user?.name || 'Rider',
            phone: alert.user?.phone || '',
            bloodGroup: alert.user?.bloodGroup || '',
            profilePic: alert.user?.profilePic || '',
            emergencyContact: alert.user?.emergencyContact || null,
          },
        };

        io.to(`ride:${alert.ride.toString()}`).emit('sos:escalated', payload);
        if (callback) callback({ success: true, alert: payload });
      } catch (err) {
        console.error('[Socket] sos:escalate error:', err);
        if (callback) callback({ error: 'Failed to escalate SOS' });
      }
    });

    // 6. Resolve SOS Emergency Alert
    socket.on('sos:resolve', async ({ alertId, rideId }, callback) => {
      try {
        if (!alertId) return;

        await Alert.findByIdAndUpdate(alertId, { resolved: true });

        const ride = await Ride.findById(rideId);
        if (ride) {
          await RideEvent.create({
            ride: rideId,
            group: ride.group,
            type: 'SOS',
            user: socket.user._id,
            severity: 'INFO',
            metadata: { action: 'RESOLVE', alertId },
          }).catch(() => {});
        }

        io.to(`ride:${rideId}`).emit('sos:resolved', { alertId });
        if (callback) callback({ success: true });
      } catch (err) {
        if (callback) callback({ error: 'Failed to resolve SOS' });
      }
    });

    // 7. Trigger Regroup Call (Stage 6)
    socket.on('regroup:trigger', async ({ rideId, location, haltName, reason }, callback) => {
      try {
        if (!rideId) return;

        const ride = await Ride.findById(rideId);
        if (!ride) return;

        const regroupData = {
          id: `rg_${Date.now()}`,
          rideId,
          location: location || null,
          haltName: haltName || 'Convoy Regroup Point',
          reason: reason || 'Convoy regroup requested by leader',
          initiatedBy: {
            id: socket.user._id,
            name: socket.user.name,
            profilePic: socket.user.profilePic,
          },
          acks: [userId],
          createdAt: new Date().toISOString(),
        };

        activeRegroups.set(rideId, regroupData);

        // Record discrete RideEvent
        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'REGROUP',
          user: socket.user._id,
          severity: 'WARNING',
          location: location || undefined,
          metadata: {
            action: 'TRIGGER',
            haltName: regroupData.haltName,
            reason: regroupData.reason,
          },
        }).catch(() => {});

        io.to(`ride:${rideId}`).emit('regroup:active', regroupData);
        if (callback) callback({ success: true, regroup: regroupData });
      } catch (err) {
        console.error('[Socket] regroup:trigger error:', err);
        if (callback) callback({ error: 'Failed to trigger regroup' });
      }
    });

    // 8. Acknowledge Regroup Call (Stage 6)
    socket.on('regroup:ack', ({ rideId, regroupId }) => {
      if (!rideId) return;
      const regroup = activeRegroups.get(rideId);
      if (regroup && (!regroupId || regroup.id === regroupId)) {
        if (!regroup.acks.includes(userId)) {
          regroup.acks.push(userId);
        }
        io.to(`ride:${rideId}`).emit('regroup:rider_ack', {
          regroupId: regroup.id,
          userId,
          name: socket.user.name,
          acks: regroup.acks,
        });
      }
    });

    // 9. Resolve Regroup Call (Stage 6)
    socket.on('regroup:resolve', async ({ rideId, regroupId }) => {
      if (!rideId) return;
      const regroup = activeRegroups.get(rideId);
      if (regroup) {
        const idToResolve = regroup.id;
        activeRegroups.delete(rideId);

        const ride = await Ride.findById(rideId).catch(() => null);
        if (ride) {
          await RideEvent.create({
            ride: rideId,
            group: ride.group,
            type: 'REGROUP',
            user: socket.user._id,
            severity: 'INFO',
            metadata: { action: 'RESOLVED', regroupId: idToResolve },
          }).catch(() => {});
        }

        io.to(`ride:${rideId}`).emit('regroup:resolved', { regroupId: idToResolve });
      }
    });

    // 10. Stage 4: Assign Sweep (Tail) Rider
    socket.on('sweep:assign', async ({ rideId, sweepRiderId }, callback) => {
      try {
        if (!rideId) return;
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        if (ride.createdBy.toString() !== userId) {
          if (callback) callback({ error: 'Only the ride leader can assign the Sweep Rider' });
          return;
        }

        ride.sweepRider = sweepRiderId || null;
        await ride.save();

        let sweepUser = null;
        if (sweepRiderId) {
          sweepUser = await User.findById(sweepRiderId).select(
            '_id name email phone bloodGroup profilePic role'
          );
        }

        const config = activeRideConfigs.get(rideId) || { speedLimit: ride.speedLimit || 80, roadCondition: ride.roadCondition || 'Highway' };
        config.sweepRiderId = sweepRiderId || null;
        activeRideConfigs.set(rideId, config);

        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'SWEEP_ASSIGNED',
          user: sweepRiderId || null,
          severity: 'INFO',
          metadata: {
            assignedBy: userId,
            sweepName: sweepUser ? sweepUser.name : 'None',
          },
        }).catch(() => {});

        io.to(`ride:${rideId}`).emit('sweep:assigned', {
          sweepRider: sweepUser,
          sweepRiderId: sweepRiderId || null,
          assignedBy: userId,
        });

        if (callback) callback({ success: true, sweepRider: sweepUser });
      } catch (err) {
        console.error('[Socket] sweep:assign error:', err);
        if (callback) callback({ error: 'Failed to assign sweep rider' });
      }
    });

    // 11. Stage 4: Update Speed Limit & Road Condition
    socket.on('speed_limit:update', async ({ rideId, roadCondition, speedLimit }, callback) => {
      try {
        if (!rideId) return;
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        if (ride.createdBy.toString() !== userId) {
          if (callback) callback({ error: 'Only the ride leader can update speed limit' });
          return;
        }

        const numSpeed = Number(speedLimit);
        ride.roadCondition = roadCondition || ride.roadCondition;
        ride.speedLimit = numSpeed;
        await ride.save();

        const config = activeRideConfigs.get(rideId) || {};
        config.speedLimit = numSpeed;
        config.roadCondition = ride.roadCondition;
        activeRideConfigs.set(rideId, config);

        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'SPEED_LIMIT_CHANGED',
          user: socket.user._id,
          severity: 'INFO',
          metadata: {
            roadCondition: ride.roadCondition,
            speedLimit: numSpeed,
          },
        }).catch(() => {});

        io.to(`ride:${rideId}`).emit('speed_limit:updated', {
          roadCondition: ride.roadCondition,
          speedLimit: numSpeed,
          updatedBy: userId,
        });

        if (callback) callback({ success: true, roadCondition: ride.roadCondition, speedLimit: numSpeed });
      } catch (err) {
        console.error('[Socket] speed_limit:update error:', err);
        if (callback) callback({ error: 'Failed to update speed limit' });
      }
    });

    // 12. Stage 4: Report Rider for Violations
    socket.on('rider:report', async ({ rideId, reportedUserId, reason, details, speed }, callback) => {
      try {
        if (!rideId || !reportedUserId || !reason) return;
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        const reportItem = {
          reportedUser: reportedUserId,
          reportedBy: socket.user._id,
          reason,
          details: details || '',
          speed: typeof speed === 'number' ? speed : 0,
          createdAt: new Date(),
        };

        ride.reports.push(reportItem);
        await ride.save();

        const reportedUser = await User.findById(reportedUserId).select('_id name email phone profilePic');

        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'REPORT',
          user: reportedUserId,
          severity: 'WARNING',
          metadata: {
            reportedBy: userId,
            reason,
            details,
            speed,
          },
        }).catch(() => {});

        const reportPayload = {
          id: ride.reports[ride.reports.length - 1]._id,
          rideId,
          reportedUser: reportedUser || { _id: reportedUserId, name: 'Rider' },
          reportedBy: { _id: socket.user._id, name: socket.user.name },
          reason,
          details: details || '',
          speed: reportItem.speed,
          createdAt: reportItem.createdAt,
        };

        io.to(`ride:${rideId}`).emit('rider:reported', reportPayload);

        if (callback) callback({ success: true, report: reportPayload });
      } catch (err) {
        console.error('[Socket] rider:report error:', err);
        if (callback) callback({ error: 'Failed to submit report' });
      }
    });

    // 13. Stage 4: Kick / Remove Member from Convoy
    socket.on('rider:kick', async ({ rideId, targetUserId, reason }, callback) => {
      try {
        if (!rideId || !targetUserId) return;
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        if (ride.createdBy.toString() !== userId) {
          if (callback) callback({ error: 'Only the ride leader can remove a rider' });
          return;
        }

        if (ride.createdBy.toString() === targetUserId) {
          if (callback) callback({ error: 'Cannot remove the ride leader' });
          return;
        }

        ride.participants = ride.participants.filter((p) => p.toString() !== targetUserId);
        if (ride.sweepRider && ride.sweepRider.toString() === targetUserId) {
          ride.sweepRider = null;
        }

        const kickReason = reason || 'Violated convoy safety rules / Aggressive riding';
        ride.kickedParticipants.push({
          user: targetUserId,
          reason: kickReason,
          kickedAt: new Date(),
        });
        await ride.save();

        const locationsMap = getRideLocations(rideId);
        locationsMap.delete(targetUserId);

        const kickedUser = await User.findById(targetUserId).select('_id name');

        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'MEMBER_REMOVED',
          user: targetUserId,
          severity: 'CRITICAL',
          metadata: {
            removedBy: userId,
            reason: kickReason,
          },
        }).catch(() => {});

        const kickPayload = {
          rideId,
          userId: targetUserId,
          name: kickedUser?.name || 'Rider',
          reason: kickReason,
          kickedBy: { id: socket.user._id, name: socket.user.name },
        };

        io.to(`ride:${rideId}`).emit('rider:kicked', kickPayload);

        if (callback) callback({ success: true, kicked: kickPayload });
      } catch (err) {
        console.error('[Socket] rider:kick error:', err);
        if (callback) callback({ error: 'Failed to remove rider' });
      }
    });

    // 15. Stage 8: Push-To-Talk (PTT) Walkie-Talkie Voice Transmission
    socket.on('ride:ptt_start', async ({ rideId, channel = 'CONVOY' }, callback) => {
      try {
        if (!rideId) return;
        const config = activeRideConfigs.get(rideId);
        let creatorId = null;
        let sweepId = config?.sweepRiderId || null;

        if (channel === 'LEAD_SWEEP') {
          const ride = await Ride.findById(rideId).select('createdBy sweepRider');
          if (ride) {
            creatorId = (ride.createdBy?._id || ride.createdBy)?.toString();
            sweepId = (ride.sweepRider?._id || ride.sweepRider)?.toString();
          }
          // Only Lead and Sweep can use this private channel
          if (userId !== creatorId && userId !== sweepId) {
            if (callback) callback({ error: 'Lead & Sweep radio channel is restricted to convoy commanders' });
            return;
          }
        }

        const payload = {
          userId,
          name: socket.user.name,
          profilePic: socket.user.profilePic,
          role: socket.user.role,
          channel,
          timestamp: Date.now(),
        };

        if (channel === 'LEAD_SWEEP') {
          if (creatorId) io.to(`user:${creatorId}`).emit('ptt:user_transmitting', payload);
          if (sweepId && sweepId !== creatorId) io.to(`user:${sweepId}`).emit('ptt:user_transmitting', payload);
        } else {
          socket.to(`ride:${rideId}`).emit('ptt:user_transmitting', payload);
        }

        if (callback) callback({ success: true });
      } catch (err) {
        console.error('[Socket] ride:ptt_start error:', err);
        if (callback) callback({ error: 'Failed to start PTT transmission' });
      }
    });

    socket.on('ride:ptt_audio', async ({ rideId, audioBlob, duration, mimeType, channel = 'CONVOY' }, callback) => {
      try {
        if (!rideId || !audioBlob) {
          if (callback) callback({ error: 'No audio data' });
          return;
        }

        let creatorId = null;
        let sweepId = null;

        if (channel === 'LEAD_SWEEP') {
          const ride = await Ride.findById(rideId).select('createdBy sweepRider');
          if (ride) {
            creatorId = (ride.createdBy?._id || ride.createdBy)?.toString();
            sweepId = (ride.sweepRider?._id || ride.sweepRider)?.toString();
          }
          if (userId !== creatorId && userId !== sweepId) {
            if (callback) callback({ error: 'Unauthorized channel' });
            return;
          }
        }

        const payload = {
          userId,
          name: socket.user.name,
          profilePic: socket.user.profilePic,
          channel,
          audioBlob,
          duration: typeof duration === 'number' ? duration : 0,
          mimeType: mimeType || 'audio/webm',
          timestamp: Date.now(),
        };

        if (channel === 'LEAD_SWEEP') {
          if (creatorId) io.to(`user:${creatorId}`).emit('ptt:audio_received', payload);
          if (sweepId && sweepId !== creatorId) io.to(`user:${sweepId}`).emit('ptt:audio_received', payload);
        } else {
          socket.to(`ride:${rideId}`).emit('ptt:audio_received', payload);
        }

        // Record discrete ride event for audits
        Ride.findById(rideId).select('group').then(async (ride) => {
          if (ride) {
            await RideEvent.create({
              ride: rideId,
              group: ride.group,
              type: 'RADIO_BROADCAST',
              user: socket.user._id,
              severity: 'INFO',
              metadata: {
                channel,
                duration: payload.duration,
              },
            }).catch(() => {});
          }
        }).catch(() => {});

        if (callback) callback({ success: true });
      } catch (err) {
        console.error('[Socket] ride:ptt_audio error:', err);
        if (callback) callback({ error: 'Failed to transmit audio' });
      }
    });

    socket.on('ride:ptt_stop', async ({ rideId, channel = 'CONVOY' }) => {
      try {
        if (!rideId) return;
        const payload = {
          userId,
          name: socket.user.name,
          channel,
          timestamp: Date.now(),
        };

        if (channel === 'LEAD_SWEEP') {
          const ride = await Ride.findById(rideId).select('createdBy sweepRider');
          if (ride) {
            const creatorId = (ride.createdBy?._id || ride.createdBy)?.toString();
            const sweepId = (ride.sweepRider?._id || ride.sweepRider)?.toString();
            if (creatorId) io.to(`user:${creatorId}`).emit('ptt:user_stopped', payload);
            if (sweepId && sweepId !== creatorId) io.to(`user:${sweepId}`).emit('ptt:user_stopped', payload);
          }
        } else {
          socket.to(`ride:${rideId}`).emit('ptt:user_stopped', payload);
        }
      } catch (err) {
        console.error('[Socket] ride:ptt_stop error:', err);
      }
    });

    // Stage 10: Real-Time Road Hazard Crowdsourcing & Alerts
    socket.on('hazard:report', async ({ rideId, type, title, description, location, severity }, callback) => {
      try {
        if (!rideId || !type || !location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
          if (callback) callback({ error: 'Missing hazard details or coordinates' });
          return;
        }

        const ride = await Ride.findById(rideId);
        if (!ride) {
          if (callback) callback({ error: 'Ride not found' });
          return;
        }

        const hazardTitle = title || `${type.replace('_', ' ')} on road`;

        const hazard = await Hazard.create({
          ride: rideId,
          group: ride.group,
          reportedBy: socket.user._id,
          type,
          title: hazardTitle,
          description: description || '',
          location: { lat: location.lat, lng: location.lng },
          severity: severity || 'MEDIUM',
          confirmations: [{ user: socket.user._id, confirmedAt: new Date() }],
        });

        const populatedHazard = await Hazard.findById(hazard._id)
          .populate('reportedBy', 'name profilePic role')
          .populate('confirmations.user', 'name');

        await RideEvent.create({
          ride: rideId,
          group: ride.group,
          type: 'ROAD_HAZARD',
          user: socket.user._id,
          severity: severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
          location: { lat: location.lat, lng: location.lng },
          metadata: {
            hazardId: hazard._id,
            hazardType: type,
            title: hazardTitle,
          },
        });

        // Broadcast to all riders in this convoy
        io.to(`ride:${rideId}`).emit('hazard:new', populatedHazard);
        if (callback) callback({ success: true, hazard: populatedHazard });
      } catch (err) {
        console.error('[Socket] hazard:report error:', err);
        if (callback) callback({ error: 'Failed to report hazard' });
      }
    });

    socket.on('hazard:confirm', async ({ rideId, hazardId }, callback) => {
      try {
        if (!hazardId) return;
        const hazard = await Hazard.findById(hazardId);
        if (!hazard || hazard.resolved) {
          if (callback) callback({ error: 'Hazard not found or already resolved' });
          return;
        }

        const alreadyConfirmed = hazard.confirmations.some(
          (c) => c.user?.toString() === socket.user._id.toString()
        );

        if (!alreadyConfirmed) {
          hazard.confirmations.push({ user: socket.user._id, confirmedAt: new Date() });
          await hazard.save();
        }

        const updated = await Hazard.findById(hazardId)
          .populate('reportedBy', 'name profilePic role')
          .populate('confirmations.user', 'name');

        io.to(`ride:${rideId || hazard.ride}`).emit('hazard:confirmed', {
          hazardId: hazard._id,
          confirmationsCount: updated.confirmations.length,
          confirmations: updated.confirmations,
        });

        if (callback) callback({ success: true, hazard: updated });
      } catch (err) {
        console.error('[Socket] hazard:confirm error:', err);
        if (callback) callback({ error: 'Failed to confirm hazard' });
      }
    });

    socket.on('hazard:resolve', async ({ rideId, hazardId }, callback) => {
      try {
        if (!hazardId) return;
        const hazard = await Hazard.findById(hazardId);
        if (!hazard) {
          if (callback) callback({ error: 'Hazard not found' });
          return;
        }

        hazard.resolved = true;
        hazard.resolvedBy = socket.user._id;
        hazard.resolvedAt = new Date();
        await hazard.save();

        io.to(`ride:${rideId || hazard.ride}`).emit('hazard:resolved', {
          hazardId: hazard._id,
          resolvedBy: socket.user._id,
          resolvedByName: socket.user.name,
        });

        if (callback) callback({ success: true });
      } catch (err) {
        console.error('[Socket] hazard:resolve error:', err);
        if (callback) callback({ error: 'Failed to resolve hazard' });
      }
    });

    // 14. Leave ride room
    socket.on('leave_ride', ({ rideId }) => {
      if (!rideId) return;
      socket.leave(`ride:${rideId}`);
      const timerKey = `${rideId}:${userId}`;
      if (disconnectGraceTimers.has(timerKey)) {
        clearTimeout(disconnectGraceTimers.get(timerKey));
        disconnectGraceTimers.delete(timerKey);
      }
      const locationsMap = getRideLocations(rideId);
      locationsMap.delete(userId);

      socket.to(`ride:${rideId}`).emit('rider:left', { userId, name: socket.user.name });
    });

    // 11. Disconnection (with 20-second grace period to prevent network-flap spam)
    socket.on('disconnect', async () => {
      console.log(`[Socket] Rider disconnected: ${socket.user.name} (${userId})`);
      if (socket.currentRideId) {
        const rideId = socket.currentRideId;
        const timerKey = `${rideId}:${userId}`;

        // Clear existing timer if any
        if (disconnectGraceTimers.has(timerKey)) {
          clearTimeout(disconnectGraceTimers.get(timerKey));
          disconnectGraceTimers.delete(timerKey);
        }

        const disconnectedUser = socket.user;

        // Start 20-second grace timer before broadcasting disconnect or creating alerts
        const timer = setTimeout(async () => {
          disconnectGraceTimers.delete(timerKey);
          console.log(`[Socket] Grace period expired for ${disconnectedUser.name} (${userId}). Processing offline status.`);

          const locationsMap = getRideLocations(rideId);
          const rider = locationsMap.get(userId);
          if (rider) {
            rider.status = 'OFFLINE';
            rider.lastHeartbeat = Date.now();
            if (!rider.deadZoneEnteredAt) {
              rider.deadZoneEnteredAt = Date.now();
            }
            locationsMap.set(userId, rider);
            io.to(`ride:${rideId}`).emit('rider:status_update', {
              userId,
              status: 'OFFLINE',
              updatedAt: new Date().toISOString(),
              lastKnownLocation: (rider.lat && rider.lng) ? {
                lat: rider.lat,
                lng: rider.lng,
                speed: rider.speed || 0,
                heading: rider.heading || 0,
              } : null,
              deadZoneEnteredAt: rider.deadZoneEnteredAt,
            });
          }

          io.to(`ride:${rideId}`).emit('rider:disconnected', {
            userId,
            name: disconnectedUser.name,
          });

          // Create a network-loss alert only after grace period expires
          try {
            const ride = await Ride.findById(rideId);
            if (ride && ride.status === 'ongoing') {
              const alert = await Alert.create({
                ride: ride._id,
                group: ride.group,
                user: disconnectedUser._id,
                type: 'network-loss',
                resolved: false,
                location: rider && rider.lat && rider.lng ? { lat: rider.lat, lng: rider.lng } : null,
              });

              await RideEvent.create({
                ride: ride._id,
                group: ride.group,
                type: 'CONNECTIVITY',
                user: disconnectedUser._id,
                severity: 'WARNING',
                location: rider && rider.lat && rider.lng ? { lat: rider.lat, lng: rider.lng } : null,
                metadata: { action: 'DEAD_ZONE_ENTERED', status: 'OFFLINE', lastKnownSpeed: rider?.speed || 0 },
              }).catch(() => {});

              const alertPayload = {
                id: alert._id,
                rideId,
                type: 'network-loss',
                user: {
                  id: disconnectedUser._id,
                  name: disconnectedUser.name,
                  phone: disconnectedUser.phone,
                  bloodGroup: disconnectedUser.bloodGroup,
                  profilePic: disconnectedUser.profilePic,
                },
                location: rider && rider.lat && rider.lng ? { lat: rider.lat, lng: rider.lng } : null,
                createdAt: alert.createdAt,
              };

              io.to(`ride:${rideId}`).emit('sos:alert', alertPayload);
            }
          } catch (err) {
            console.error('[Socket] network-loss alert creation error on grace expiry:', err);
          }
        }, 20000);

        disconnectGraceTimers.set(timerKey, timer);
      }
    });
  });

  // Background task to monitor rider heartbeat, health & SOS auto-escalations
  setInterval(async () => {
    const now = Date.now();
    for (const [rideId, locationsMap] of activeRideLocations.entries()) {
      for (const [userId, rider] of locationsMap.entries()) {
        if (!rider.lastHeartbeat) rider.lastHeartbeat = now;

        const diffSecs = (now - rider.lastHeartbeat) / 1000;
        let newStatus = rider.status || 'LIVE';

        if (rider.status === 'OFFLINE') {
          newStatus = 'OFFLINE';
        } else if (diffSecs > 60) {
          newStatus = 'OFFLINE';
        } else if (diffSecs > 30) {
          newStatus = 'STALE';
        } else if (diffSecs > 15) {
          newStatus = 'WEAK';
        } else {
          newStatus = 'LIVE';
        }

        if (rider.status !== newStatus) {
          rider.status = newStatus;
          if (newStatus === 'OFFLINE' && !rider.deadZoneEnteredAt) {
            rider.deadZoneEnteredAt = now;
          } else if (newStatus === 'LIVE') {
            rider.deadZoneEnteredAt = null;
          }
          ioInstance.to(`ride:${rideId}`).emit('rider:status_update', {
            userId,
            status: newStatus,
            updatedAt: new Date().toISOString(),
            lastKnownLocation: (rider.lat && rider.lng) ? {
              lat: rider.lat,
              lng: rider.lng,
              speed: rider.speed || 0,
              heading: rider.heading || 0,
            } : null,
            deadZoneEnteredAt: rider.deadZoneEnteredAt || (newStatus === 'OFFLINE' ? now : null),
          });
        }
      }

      // Group Health & Convoy Separation Calculation
      const activeRiders = Array.from(locationsMap.values()).filter(
        (r) => r.status !== 'OFFLINE' && r.lat && r.lng
      );

      let maxSpreadKm = 0;
      if (activeRiders.length > 1) {
        for (let i = 0; i < activeRiders.length; i++) {
          for (let j = i + 1; j < activeRiders.length; j++) {
            const r1 = activeRiders[i];
            const r2 = activeRiders[j];
            const dist = calculateDistance(r1.lat, r1.lng, r2.lat, r2.lng);
            if (dist > maxSpreadKm) {
              maxSpreadKm = dist;
            }
          }
        }
      }

      // Calculate base health score
      let healthScore = 100;
      let weakCount = 0;
      let staleCount = 0;
      let offlineCount = 0;

      for (const rider of locationsMap.values()) {
        if (rider.status === 'WEAK') weakCount++;
        else if (rider.status === 'STALE') staleCount++;
        else if (rider.status === 'OFFLINE') offlineCount++;
      }

      healthScore -= weakCount * 5;
      healthScore -= staleCount * 15;
      healthScore -= offlineCount * 25;

      // Penalize for spread > 1km
      if (maxSpreadKm > 1) {
        healthScore -= Math.floor(maxSpreadKm - 1) * 10;
      }

      // Ensure score stays bounded
      if (healthScore < 0) healthScore = 0;
      if (healthScore > 100) healthScore = 100;

      // Determine if a straggler warning is needed (e.g. spread > 2km)
      const isSeparated = maxSpreadKm > 2;

      ioInstance.to(`ride:${rideId}`).emit('ride:health_update', {
        healthScore,
        maxSpreadKm: parseFloat(maxSpreadKm.toFixed(2)),
        isSeparated,
        activeRiders: activeRiders.length,
        totalTracked: locationsMap.size,
      });

      // Update the DB asynchronously (fire and forget)
      Ride.findByIdAndUpdate(rideId, { healthScore }).catch(() => {});

      // Stage 6: Regroup Recommendation check
      if ((isSeparated || healthScore < 70) && !activeRegroups.has(rideId) && activeRiders.length > 1) {
        // Calculate recommended halt point (e.g. leader or average coordinates)
        let haltCoords = null;
        const leader = activeRiders.find((r) => r.role === 'rideAdmin') || activeRiders[0];
        if (leader && leader.lat && leader.lng) {
          haltCoords = { lat: leader.lat, lng: leader.lng };
        }

        ioInstance.to(`ride:${rideId}`).emit('regroup:recommendation', {
          rideId,
          recommendedHalt: haltCoords,
          reason: isSeparated
            ? `Convoy spread reached ${maxSpreadKm.toFixed(1)} km. Regroup strongly recommended!`
            : `Convoy health dropped to ${healthScore}%. Regroup advised.`,
          maxSpreadKm: parseFloat(maxSpreadKm.toFixed(2)),
        });
      }

      // Stage 6: SOS Auto-Escalation Check (>60 seconds unacknowledged)
      const oneMinuteAgo = new Date(now - 60000);
      Alert.find({
        ride: rideId,
        resolved: false,
        type: 'sos',
        escalationLevel: 'CONVOY',
        createdAt: { $lte: oneMinuteAgo },
      })
        .populate('user', 'name phone bloodGroup profilePic emergencyContact')
        .then(async (pendingAlerts) => {
          for (const alert of pendingAlerts) {
            alert.escalationLevel = 'EMERGENCY_CONTACTS';
            alert.escalatedAt = new Date();
            await alert.save();

            const ride = await Ride.findById(rideId).catch(() => null);
            if (ride) {
              await RideEvent.create({
                ride: rideId,
                group: ride.group,
                type: 'SOS',
                user: alert.user?._id || alert.user,
                severity: 'CRITICAL',
                metadata: {
                  action: 'AUTO_ESCALATE',
                  alertId: alert._id,
                  escalationLevel: 'EMERGENCY_CONTACTS',
                },
              }).catch(() => {});
            }

            ioInstance.to(`ride:${rideId}`).emit('sos:escalated', {
              alertId: alert._id,
              escalationLevel: 'EMERGENCY_CONTACTS',
              escalatedAt: alert.escalatedAt,
              autoEscalated: true,
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
        })
        .catch(() => {});
    }
  }, 10000);

  return io;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

module.exports = {
  initSocketServer,
  getRideLocations,
  getIO,
};
