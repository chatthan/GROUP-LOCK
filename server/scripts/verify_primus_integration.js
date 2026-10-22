const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const env = require('../src/config/env');
const User = require('../src/models/User');
const Group = require('../src/models/Group');
const Ride = require('../src/models/Ride');
const Message = require('../src/models/Message');
const Alert = require('../src/models/Alert');
const primusController = require('../src/controllers/primus.controller');
const { getRideLocations } = require('../src/sockets/ride.socket');

async function testPrimus() {
  console.log('=== STARTING PRIMUS INTEGRATION & ACCEPTANCE TESTS ===\n');

  await mongoose.connect(env.mongoUri);
  console.log('1. Connected to MongoDB database successfully.');

  // Create Leader user
  const leaderEmail = `primus_leader_${Date.now()}@example.com`;
  const leader = await User.create({
    name: 'Captain Alex (Leader)',
    email: leaderEmail,
    phone: '+919876500001',
    passwordHash: 'dummyhash',
    role: 'rider',
  });

  // Create Rider user
  const riderEmail = `primus_rider_${Date.now()}@example.com`;
  const rider = await User.create({
    name: 'Rider Rohan',
    email: riderEmail,
    phone: '+919876500002',
    passwordHash: 'dummyhash',
    role: 'rider',
  });

  // Create Non-member user (for auth testing)
  const nonMember = await User.create({
    name: 'Unauthorized User',
    email: `outsider_${Date.now()}@example.com`,
    phone: '+919876500003',
    passwordHash: 'dummyhash',
    role: 'rider',
  });

  console.log(`2. Test users created: Leader (${leader._id}), Rider (${rider._id})`);

  // Create group
  const group = await Group.create({
    name: 'Iron Wolves Kerala',
    createdBy: leader._id,
    members: [
      { user: leader._id, role: 'admin', joinedAt: new Date() },
      { user: rider._id, role: 'member', joinedAt: new Date() },
    ],
    inviteCode: 'W' + Math.floor(10000 + Math.random() * 90000),
    status: 'active',
  });

  // Create planned ride
  const ride = await Ride.create({
    title: 'Wayanad Ghats Tactical Convoy',
    group: group._id,
    createdBy: leader._id,
    startLocation: 'Kozhikode, Kerala',
    destination: 'Wayanad, Kerala',
    distanceKm: 85.0,
    speedLimit: 75,
    roadCondition: 'Ghats/Hills',
    participants: [leader._id, rider._id],
    status: 'ongoing',
    startedAt: new Date(Date.now() - 45 * 60 * 1000), // 45 mins ago
  });

  console.log(`3. Active convoy initialized: "${ride.title}" (ID: ${ride._id})`);

  // Seed live locations in memory (Rohan is 2.5 km behind the leader)
  const locs = getRideLocations(ride._id.toString());
  locs.set(leader._id.toString(), {
    userId: leader._id.toString(),
    name: leader.name,
    lat: 11.5000,
    lng: 76.0000,
    speed: 68,
    heading: 45,
    status: 'LIVE',
    lastHeartbeat: Date.now(),
  });

  locs.set(rider._id.toString(), {
    userId: rider._id.toString(),
    name: rider.name,
    lat: 11.4800, // ~2.2 km south
    lng: 76.0000,
    speed: 55,
    heading: 45,
    status: 'LIVE',
    lastHeartbeat: Date.now(),
  });

  // Mock res & req helpers
  function createMockRes() {
    return {
      statusCode: 200,
      jsonPayload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonPayload = data;
        return this;
      },
    };
  }

  // ── TEST A: Context Retrieval ──────────────────────────────────────────────
  console.log('\n--- TEST A: GET /api/primus/context/:rideId ---');
  const reqContext = {
    params: { rideId: ride._id.toString() },
    user: { id: rider._id.toString(), name: rider.name },
  };
  const resContext = createMockRes();
  await primusController.getRideContext(reqContext, resContext, (err) => {
    if (err) throw err;
  });

  console.log('Status code:', resContext.statusCode);
  console.log('Primus identity:', resContext.jsonPayload?.primus?.identity);
  console.log('Convoy riders tracked:', resContext.jsonPayload?.primus?.riders?.length);
  if (resContext.jsonPayload?.primus?.identity === 'PRIMUS') {
    console.log('✅ TEST A PASSED: Real-time context successfully returned.');
  } else {
    throw new Error('TEST A FAILED: Invalid context payload');
  }

  // ── TEST B: Proactive Separation Intelligence ──────────────────────────────
  console.log('\n--- TEST B: GET /api/primus/proactive/:rideId ---');
  const reqProactive = {
    params: { rideId: ride._id.toString() },
    user: { id: leader._id.toString(), name: leader.name },
  };
  const resProactive = createMockRes();
  await primusController.getProactiveInsights(reqProactive, resProactive, (err) => {
    if (err) throw err;
  });

  console.log('Proactive insights count:', resProactive.jsonPayload?.insights?.length);
  const separationAlert = resProactive.jsonPayload?.insights?.find((i) => i.type === 'SEPARATION');
  console.log('Detected separation message:', separationAlert?.message);
  console.log('Spoken audio instruction:', separationAlert?.spoken);

  if (separationAlert && separationAlert.distKm > 1.5) {
    console.log('✅ TEST B PASSED: Convoy separation dynamically caught and alert generated.');
  } else {
    throw new Error('TEST B FAILED: Proactive separation not flagged');
  }

  // ── TEST C: Natural Language Command Execution ─────────────────────────────
  console.log('\n--- TEST C: Natural Language Command Execution ---');

  // Command 1: Group Status
  const reqCmd1 = {
    body: { rideId: ride._id.toString(), command: 'Hey PRIMUS, how many riders in our group?' },
    user: { id: rider._id.toString(), name: rider.name },
  };
  const resCmd1 = createMockRes();
  await primusController.executePrimusCommand(reqCmd1, resCmd1, (err) => { if (err) throw err; });
  console.log('[Command 1 response]:', resCmd1.jsonPayload?.spokenResponse);

  // Command 2: Notify Leader
  const reqCmd2 = {
    body: { rideId: ride._id.toString(), command: 'Notify leader that I have a low tire pressure and need a quick pause.' },
    user: { id: rider._id.toString(), name: rider.name },
  };
  const resCmd2 = createMockRes();
  await primusController.executePrimusCommand(reqCmd2, resCmd2, (err) => { if (err) throw err; });
  console.log('[Command 2 response]:', resCmd2.jsonPayload?.spokenResponse);

  // Command 3: Send Group Message
  const reqCmd3 = {
    body: { rideId: ride._id.toString(), command: 'Tell everyone stop at the next mountain view point' },
    user: { id: leader._id.toString(), name: leader.name },
  };
  const resCmd3 = createMockRes();
  await primusController.executePrimusCommand(reqCmd3, resCmd3, (err) => { if (err) throw err; });
  console.log('[Command 3 response]:', resCmd3.jsonPayload?.spokenResponse);

  // Verify message doc was actually stored in MongoDB
  const savedMsg = await Message.findOne({ ride: ride._id, text: { $regex: 'mountain view point' } });
  if (savedMsg) {
    console.log('✅ Database verified: In-ride tactical message stored:', savedMsg.text);
  } else {
    throw new Error('TEST C FAILED: Group message was not stored in database');
  }

  // ── TEST D: Security & Role-Based Access Control ───────────────────────────
  console.log('\n--- TEST D: RBAC & Non-Member Access Rejection ---');
  const reqOutsider = {
    params: { rideId: ride._id.toString() },
    user: { id: nonMember._id.toString(), name: nonMember.name },
  };
  let rejectedAsExpected = false;
  await primusController.getRideContext(reqOutsider, createMockRes(), (err) => {
    if (err && err.statusCode === 403) {
      rejectedAsExpected = true;
      console.log('✅ TEST D PASSED: Unauthorized outsider was blocked with HTTP 403 Forbidden.');
    }
  });

  if (!rejectedAsExpected) {
    throw new Error('TEST D FAILED: Non-member was not rejected!');
  }

  // Cleanup
  console.log('\nCleaning up test records...');
  await Message.deleteMany({ ride: ride._id });
  await Alert.deleteMany({ ride: ride._id });
  await Ride.deleteOne({ _id: ride._id });
  await Group.deleteOne({ _id: group._id });
  await User.deleteMany({ _id: { $in: [leader._id, rider._id, nonMember._id] } });

  await mongoose.disconnect();
  console.log('\n🎉 ALL PRIMUS INTEGRATION TESTS COMPLETED SUCCESSFULLY WITH 100% PASS RATE!');
}

testPrimus().catch((err) => {
  console.error('\n❌ TEST RUNNER ERROR:', err);
  process.exit(1);
});
