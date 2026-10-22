/**
 * PRIMUS Security & RBAC Tests
 * Run: node scripts/test_primus_security.js
 */
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

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    pass++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    fail++;
  }
}

function createMockRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.jsonPayload = data; return this; },
  };
}

async function runTests() {
  console.log('\n=== PRIMUS SECURITY & RBAC TESTS ===\n');

  await mongoose.connect(env.mongoUri);
  console.log('Connected to MongoDB.\n');

  const ts = Date.now();

  // ── Setup ────────────────────────────────────────────────────────────────
  const leader = await User.create({ name: 'Leader Sam', email: `sec_leader_${ts}@x.com`, phone: `+9100${ts}1`, passwordHash: 'x', role: 'rider' });
  const rider = await User.create({ name: 'Rider Raj', email: `sec_rider_${ts}@x.com`, phone: `+9100${ts}2`, passwordHash: 'x', role: 'rider' });
  const outsider = await User.create({ name: 'Outsider', email: `sec_out_${ts}@x.com`, phone: `+9100${ts}3`, passwordHash: 'x', role: 'rider' });

  const group = await Group.create({
    name: 'Security Test Group',
    createdBy: leader._id,
    members: [
      { user: leader._id, role: 'admin', joinedAt: new Date() },
      { user: rider._id, role: 'member', joinedAt: new Date() },
    ],
    inviteCode: `SEC${ts}`,
    status: 'active',
  });

  const ride = await Ride.create({
    title: 'Security Test Ride',
    group: group._id,
    createdBy: leader._id,
    startLocation: 'Test Start',
    destination: 'Test End',
    distanceKm: 50,
    participants: [leader._id, rider._id],
    status: 'ongoing',
    startedAt: new Date(),
  });

  const rideId = ride._id.toString();

  // Seed GPS for leader and rider
  const locs = getRideLocations(rideId);
  locs.set(leader._id.toString(), { lat: 10.0, lng: 76.0, speed: 60, status: 'LIVE', lastHeartbeat: Date.now() });
  locs.set(rider._id.toString(), { lat: 10.05, lng: 76.0, speed: 55, status: 'LIVE', lastHeartbeat: Date.now() });

  // ── Test 1: Unauthenticated request rejected ─────────────────────────────
  console.log('--- TEST 1: Unauthenticated request ---');
  // The middleware handles this before the controller runs; simulate by
  // calling the controller without req.user
  let blocked1 = false;
  await primusController.getRideContext(
    { params: { rideId }, user: null },
    createMockRes(),
    (err) => { if (err) blocked1 = true; }
  ).catch(() => { blocked1 = true; });
  assert(blocked1, 'Controller throws or calls next(err) when req.user is null');

  // ── Test 2: Non-member cannot access ride context ────────────────────────
  console.log('\n--- TEST 2: Non-member access ---');
  let blocked2 = false;
  const res2 = createMockRes();
  await primusController.getRideContext(
    { params: { rideId }, user: { id: outsider._id.toString(), name: 'Outsider' } },
    res2,
    (err) => { if (err && err.statusCode === 403) blocked2 = true; }
  );
  assert(blocked2, 'Non-member gets HTTP 403 from getRideContext');

  // ── Test 3: Non-member cannot post commands ───────────────────────────────
  console.log('\n--- TEST 3: Non-member command ---');
  let blocked3 = false;
  const res3 = createMockRes();
  await primusController.executePrimusCommand(
    { body: { rideId, command: 'get group status' }, user: { id: outsider._id.toString(), name: 'Outsider' } },
    res3,
    (err) => { if (err && err.statusCode === 403) blocked3 = true; }
  );
  assert(blocked3, 'Non-member gets HTTP 403 from executePrimusCommand');

  // ── Test 4: Member (rider) CAN access context ─────────────────────────────
  console.log('\n--- TEST 4: Legitimate member access ---');
  const res4 = createMockRes();
  await primusController.getRideContext(
    { params: { rideId }, user: { id: rider._id.toString(), name: 'Rider Raj' } },
    res4,
    (err) => { if (err) throw err; }
  );
  assert(res4.jsonPayload?.success === true, 'Legitimate rider can access ride context');
  assert(res4.jsonPayload?.primus?.identity === 'PRIMUS', 'Context identity field is PRIMUS');

  // ── Test 5: No rideId in command body ─────────────────────────────────────
  console.log('\n--- TEST 5: Missing rideId ---');
  const res5 = createMockRes();
  await primusController.executePrimusCommand(
    { body: { command: 'group status' }, user: { id: rider._id.toString() } },
    res5,
    () => {}
  );
  assert(res5.statusCode === 400 || res5.jsonPayload?.success === false, 'Missing rideId returns 400 or error');

  // ── Test 6: Leader-self notify returns informational message ──────────────
  console.log('\n--- TEST 6: Leader cannot notify themselves ---');
  const res6 = createMockRes();
  await primusController.executePrimusCommand(
    { body: { rideId, command: 'notify leader I need fuel' }, user: { id: leader._id.toString(), name: 'Leader Sam' } },
    res6,
    (err) => { if (err) throw err; }
  );
  assert(res6.jsonPayload?.success === true, 'Leader self-notify returns success (with informational message)');
  assert(res6.jsonPayload?.data?.isLeader === true, 'Response indicates caller is the leader');

  // ── Test 7: Group message is stored in DB ─────────────────────────────────
  console.log('\n--- TEST 7: Message persistence ---');
  const testMsg = `SecTest_${ts}`;
  const res7 = createMockRes();
  await primusController.executePrimusCommand(
    { body: { rideId, command: `tell everyone ${testMsg}` }, user: { id: leader._id.toString(), name: 'Leader Sam' } },
    res7,
    (err) => { if (err) throw err; }
  );
  const savedMsg = await Message.findOne({ ride: rideId, text: { $regex: testMsg } });
  assert(res7.jsonPayload?.success === true, 'send_group_message returns success');
  assert(savedMsg !== null, 'Message was actually persisted in MongoDB');

  // ── Test 8: Nearby places returns real structure (no fabricated coords) ───
  console.log('\n--- TEST 8: Nearby places structure ---');
  const res8 = createMockRes();
  await primusController.executePrimusCommand(
    { body: { rideId, command: 'find petrol station nearby', location: { lat: 10.0, lng: 76.0 } }, user: { id: rider._id.toString(), name: 'Rider Raj' } },
    res8,
    (err) => { if (err) throw err; }
  );
  assert(res8.jsonPayload?.success === true, 'find_fuel action returns success');
  // Places may be [] if Overpass returned no results — that is correct behavior
  assert(Array.isArray(res8.jsonPayload?.data?.places) || res8.jsonPayload?.data?.places === undefined, 'places field is array or absent (not synthetic data)');
  // Verify no fabricated ±0.01 offsets from hardcoded lat/lng
  const fakePlaces = (res8.jsonPayload?.data?.places || []).filter(
    (p) => p.lat === 10.01 || p.lat === 10.025
  );
  assert(fakePlaces.length === 0, 'No fabricated place coordinates returned');

  // ── Test 9: Deactivate PRIMUS ─────────────────────────────────────────────
  console.log('\n--- TEST 9: Deactivate PRIMUS ---');
  const res9 = createMockRes();
  await primusController.executePrimusCommand(
    { body: { rideId, command: 'stop listening' }, user: { id: rider._id.toString(), name: 'Rider Raj' } },
    res9,
    (err) => { if (err) throw err; }
  );
  assert(res9.jsonPayload?.action === 'deactivate_primus', 'Deactivate action is returned');
  assert(res9.jsonPayload?.data?.state === 'STANDBY', 'State is STANDBY after deactivation');

  // ── Test 10: getRideContacts excludes the requesting user ────────────────
  console.log('\n--- TEST 10: Contact list excludes self ---');
  const res10 = createMockRes();
  await primusController.getRideContacts(
    { params: { rideId }, user: { id: rider._id.toString() } },
    res10,
    (err) => { if (err) throw err; }
  );
  assert(res10.jsonPayload?.success === true, 'getRideContacts returns success');
  const selfInContacts = (res10.jsonPayload?.contacts || []).some(
    (c) => c.id?.toString() === rider._id.toString()
  );
  assert(!selfInContacts, 'Requesting user is excluded from their own contact list');

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log('\nCleaning up test records...');
  await Message.deleteMany({ ride: rideId });
  await Alert.deleteMany({ ride: rideId });
  await Ride.deleteOne({ _id: ride._id });
  await Group.deleteOne({ _id: group._id });
  await User.deleteMany({ _id: { $in: [leader._id, rider._id, outsider._id] } });

  await mongoose.disconnect();

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.error('Some security tests FAILED.');
    process.exit(1);
  } else {
    console.log('🎉 All security tests PASSED.');
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUNNER ERROR:', err);
  process.exit(1);
});
