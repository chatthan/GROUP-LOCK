const ioClient = require('socket.io-client');
const User = require('../models/User');
const Ride = require('../models/Ride');
const { signAccessToken } = require('./token.service');
const { getRideLocations } = require('../sockets/ride.socket');

// In-memory registry of active simulations: rideId -> simulationSession
const activeSimulations = new Map();

// Virtual convoy members definition
const VIRTUAL_RIDERS = [
  {
    key: 'lead',
    name: 'Rohan (Lead)',
    email: 'sim_rohan_lead@grouplock.test',
    phone: '+91 98765 00001',
    bloodGroup: 'O+',
    isLead: true,
    speedBase: 72,
    offsetLat: 0.0025,
    offsetLng: 0.0020,
  },
  {
    key: 'mid',
    name: 'Aarav (Pack)',
    email: 'sim_aarav_pack@grouplock.test',
    phone: '+91 98765 00002',
    bloodGroup: 'A+',
    isLead: false,
    speedBase: 70,
    offsetLat: 0.0012,
    offsetLng: 0.0010,
  },
  {
    key: 'sweep',
    name: 'Karan (Sweep)',
    email: 'sim_karan_sweep@grouplock.test',
    phone: '+91 98765 00003',
    bloodGroup: 'B+',
    isSweep: true,
    speedBase: 68,
    offsetLat: -0.0008,
    offsetLng: -0.0006,
  },
  {
    key: 'straggler',
    name: 'Dev (Straggler)',
    email: 'sim_dev_straggler@grouplock.test',
    phone: '+91 98765 00004',
    bloodGroup: 'AB+',
    isLead: false,
    speedBase: 65,
    offsetLat: -0.0025,
    offsetLng: -0.0020,
  },
];

async function getOrCreateVirtualUser(def) {
  let user = await User.findOne({ email: def.email });
  if (!user) {
    user = await User.create({
      name: def.name,
      email: def.email,
      phone: def.phone,
      bloodGroup: def.bloodGroup,
      passwordHash: '$2b$10$e8wY8bOcl9U3qYvY9uLp8.1Qj8Q1gG1iB4jB9eO1dE1lB2aC3dE4f', // dummy bcrypt hash
      role: 'rider',
      emergencyContact: {
        name: 'ICE Support',
        phone: '+91 91100 00000',
        relation: 'Convoy Support',
      },
    });
  }
  return user;
}

/**
 * Start multi-rider convoy simulation for a ride
 */
async function startSimulation(rideId, options = {}) {
  if (activeSimulations.has(rideId)) {
    return {
      success: true,
      alreadyRunning: true,
      message: 'Simulation already running for this ride.',
      ridersCount: activeSimulations.get(rideId).virtualClients.length,
    };
  }

  const ride = await Ride.findById(rideId);
  if (!ride) {
    throw new Error('Ride not found');
  }

  // Base coordinates to seed the convoy location
  let baseLat = ride.startCoords?.lat || 12.9716;
  let baseLng = ride.startCoords?.lng || 77.5946;

  // If live location exists from any active rider, use that as center
  const existingLocs = getRideLocations(rideId);
  if (existingLocs && existingLocs.size > 0) {
    const firstLoc = existingLocs.values().next().value;
    if (firstLoc && typeof firstLoc.lat === 'number') {
      baseLat = firstLoc.lat;
      baseLng = firstLoc.lng;
    }
  }

  const session = {
    rideId,
    virtualClients: [],
    intervalId: null,
    scenario: 'NORMAL',
    baseLat,
    baseLng,
    heading: 45, // Northeast heading
    stepCount: 0,
    startTime: Date.now(),
    specialStates: {}, // e.g. { stragglerLagKm: 0, overspeedActive: false }
  };

  // Instantiate socket clients for each virtual rider
  for (const def of VIRTUAL_RIDERS) {
    const user = await getOrCreateVirtualUser(def);
    const token = signAccessToken(user);

    // Make sure user is added to ride participants in DB
    if (!ride.participants.some((p) => p.toString() === user._id.toString())) {
      ride.participants.push(user._id);
    }
    if (def.isSweep && !ride.sweepRider) {
      ride.sweepRider = user._id;
    }

    const socket = ioClient('http://localhost:5000', {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });

    const clientObj = {
      def,
      user,
      socket,
      token,
      currentLat: baseLat + def.offsetLat,
      currentLng: baseLng + def.offsetLng,
      speed: def.speedBase,
      isDeadZone: false,
      bufferedPings: [],
    };

    // Connect and join ride
    await new Promise((resolve) => {
      socket.on('connect', () => {
        socket.emit('join_ride', { rideId }, () => {
          resolve();
        });
      });
      // Safety timeout
      setTimeout(resolve, 1500);
    });

    session.virtualClients.push(clientObj);
  }

  await ride.save();

  // Periodic Telemetry Movement Loop (Runs every 2.5 seconds)
  const dLatPerSec = 0.00015; // Moving forward along route
  const dLngPerSec = 0.00015;

  session.intervalId = setInterval(() => {
    session.stepCount++;

    session.virtualClients.forEach((client) => {
      if (client.isDeadZone) {
        // In cellular dead zone: buffer pings locally, do not emit via socket
        client.bufferedPings.push({
          lat: client.currentLat,
          lng: client.currentLng,
          speed: client.speed,
          heading: session.heading,
          timestamp: Date.now(),
        });
        return;
      }

      // Check special scenario behaviors
      let speed = client.def.speedBase + (Math.random() * 4 - 2);

      if (session.specialStates.overspeedActive && client.def.key === 'mid') {
        speed = 108; // Overspeeding!
      }

      if (session.specialStates.stragglerActive && client.def.key === 'straggler') {
        speed = 8; // Crawling, causing convoy spread to grow!
      }

      client.speed = Math.round(speed);

      // Advance position forward
      const advanceFactor = (client.speed / 70);
      client.currentLat += dLatPerSec * advanceFactor;
      client.currentLng += dLngPerSec * advanceFactor;

      if (client.socket && client.socket.connected) {
        client.socket.emit('location:update', {
          rideId,
          lat: client.currentLat,
          lng: client.currentLng,
          speed: client.speed,
          heading: session.heading,
        });
      }
    });
  }, 2500);

  activeSimulations.set(rideId, session);

  return {
    success: true,
    message: `Started convoy simulation with ${session.virtualClients.length} virtual riders.`,
    riders: session.virtualClients.map((c) => ({
      name: c.def.name,
      role: c.def.isLead ? 'Lead' : c.def.isSweep ? 'Sweep' : 'Convoy',
      speed: c.def.speedBase,
    })),
  };
}

/**
 * Trigger an interactive edge-case scenario during a live simulation
 */
async function triggerScenario(rideId, scenarioType) {
  const session = activeSimulations.get(rideId);
  if (!session) {
    throw new Error('No active simulation running for this ride. Start simulation first.');
  }

  const result = { scenario: scenarioType, success: true };

  switch (scenarioType) {
    case 'OVERSPEED': {
      session.specialStates.overspeedActive = true;
      result.message = 'Aarav is now accelerating to 108 km/h (violating speed limit).';
      // Auto-revert after 12 seconds
      setTimeout(() => {
        session.specialStates.overspeedActive = false;
      }, 12000);
      break;
    }

    case 'STRAGGLER': {
      session.specialStates.stragglerActive = true;
      result.message = 'Dev has dropped speed to 8 km/h. Convoy spread expanding beyond 2 km!';
      // Revert after 20 seconds
      setTimeout(() => {
        session.specialStates.stragglerActive = false;
      }, 20000);
      break;
    }

    case 'DEAD_ZONE': {
      const target = session.virtualClients.find((c) => c.def.key === 'straggler') || session.virtualClients[0];
      target.isDeadZone = true;
      target.bufferedPings = [];
      result.message = `${target.def.name} entered a cellular dead zone. Telemetry buffering offline.`;

      // After 8 seconds, re-emerge and batch reconcile buffered points!
      setTimeout(() => {
        target.isDeadZone = false;
        if (target.socket && target.bufferedPings.length > 0) {
          target.socket.emit('ride:batch_locations', {
            rideId,
            locations: target.bufferedPings,
          });
          result.reconciled = target.bufferedPings.length;
        }
      }, 8000);
      break;
    }

    case 'ROAD_HAZARD': {
      const reporter = session.virtualClients.find((c) => c.def.key === 'lead') || session.virtualClients[0];
      const hazardLat = reporter.currentLat + 0.0022; // ~240m directly ahead
      const hazardLng = reporter.currentLng + 0.0022;

      reporter.socket.emit(
        'hazard:report',
        {
          rideId,
          type: 'POTHOLE',
          title: 'Deep Trench Pothole on Curve',
          description: 'Simulated road crater in left lane. Slow down!',
          location: { lat: hazardLat, lng: hazardLng },
          severity: 'HIGH',
        },
        (res) => {
          if (res?.success && res.hazard) {
            // Confirm it after 3.5 seconds from another rider
            setTimeout(() => {
              const confirmer = session.virtualClients.find((c) => c.def.key === 'mid');
              if (confirmer) {
                confirmer.socket.emit('hazard:confirm', {
                  rideId,
                  hazardId: res.hazard._id,
                });
              }
            }, 3500);
          }
        }
      );
      result.message = 'Reported road hazard (Deep Trench Pothole) 250m ahead of convoy!';
      break;
    }

    case 'EMERGENCY_SOS': {
      const victim = session.virtualClients.find((c) => c.def.key === 'straggler') || session.virtualClients[1];
      victim.socket.emit('sos:trigger', {
        rideId,
        lat: victim.currentLat,
        lng: victim.currentLng,
        note: 'Simulated puncture & chain slip on hillside.',
      });
      result.message = `Emergency SOS triggered by ${victim.def.name}!`;
      break;
    }

    default:
      throw new Error(`Unknown scenario type: ${scenarioType}`);
  }

  return result;
}

/**
 * Stop simulation and disconnect all virtual sockets cleanly
 */
function stopSimulation(rideId) {
  const session = activeSimulations.get(rideId);
  if (!session) {
    return { success: true, message: 'No active simulation was running.' };
  }

  clearInterval(session.intervalId);

  session.virtualClients.forEach((client) => {
    try {
      if (client.socket) {
        client.socket.emit('leave_ride', { rideId });
        client.socket.disconnect();
      }
    } catch (_) {}
  });

  activeSimulations.delete(rideId);

  return {
    success: true,
    message: 'Convoy simulation stopped. All virtual riders disconnected.',
  };
}

/**
 * Get current simulation status
 */
function getSimulationStatus(rideId) {
  const session = activeSimulations.get(rideId);
  if (!session) {
    return { isRunning: false };
  }

  return {
    isRunning: true,
    stepCount: session.stepCount,
    uptimeSeconds: Math.round((Date.now() - session.startTime) / 1000),
    riders: session.virtualClients.map((c) => ({
      name: c.def.name,
      role: c.def.isLead ? 'Lead' : c.def.isSweep ? 'Sweep' : 'Convoy',
      speed: c.speed,
      lat: Number(c.currentLat.toFixed(5)),
      lng: Number(c.currentLng.toFixed(5)),
      isDeadZone: c.isDeadZone,
    })),
  };
}

module.exports = {
  startSimulation,
  triggerScenario,
  stopSimulation,
  getSimulationStatus,
};
