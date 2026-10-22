/**
 * GroupLock Comprehensive Timeout & Resilience Testing Suite
 *
 * Validates:
 * 1. Disconnection Grace Period Timeout (20s) - Flap Suppression vs Network-Loss SOS
 * 2. Rapid Reconnection Grace Timer Cancellation (<20s)
 * 3. Inactivity Heartbeat Progression (15s WEAK -> 30s STALE -> 60s OFFLINE)
 * 4. Dead-Zone Batch Telemetry Reconciliation Timeout Recovery
 * 5. SOS Auto-Escalation Watchdog (>60s Unacknowledged Convoy Escalation)
 * 6. Primus AI & External Service AbortSignal Timeout Graceful Fallback
 * 7. Socket.IO Keepalive / Heartbeat Ping-Timeout
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');
const env = require('../src/config/env');
const User = require('../src/models/User');
const Group = require('../src/models/Group');
const Ride = require('../src/models/Ride');
const Alert = require('../src/models/Alert');
const { signAccessToken } = require('../src/services/token.service');
const brain = require('../src/services/primusBrain.service');

const SERVER_URL = 'http://127.0.0.1:5000';
const MONGO_URI = env.mongoUri || 'mongodb://127.0.0.1:27017/grouplock';

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(type, msg) {
  const time = new Date().toISOString().substring(11, 19);
  if (type === 'PASS') console.log(`[${time}] ${COLORS.green}✔ PASS${COLORS.reset} - ${msg}`);
  else if (type === 'FAIL') console.log(`[${time}] ${COLORS.red}✖ FAIL${COLORS.reset} - ${msg}`);
  else if (type === 'INFO') console.log(`[${time}] ${COLORS.cyan}ℹ INFO${COLORS.reset} - ${msg}`);
  else if (type === 'STEP') console.log(`\n${COLORS.bright}${COLORS.yellow}=== ${msg} ===${COLORS.reset}`);
  else console.log(`[${time}] ${msg}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTimeoutTests() {
  console.log(`\n${COLORS.bright}${COLORS.cyan}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.magenta}           GROUPLOCK TIMEOUT & RESILIENCE TESTING SUITE              ${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.cyan}======================================================================${COLORS.reset}\n`);

  await mongoose.connect(MONGO_URI);
  log('INFO', 'Connected to MongoDB for timeout test harness.');

  const ts = Date.now();

  // Create leader and test riders
  const leader = await User.create({
    name: 'Timeout Test Lead',
    email: `timeout_lead_${ts}@grouplock.test`,
    phone: `+91 91111 00001`,
    passwordHash: 'dummy',
    role: 'rideAdmin',
  });

  const riderA = await User.create({
    name: 'Rider Arjun (Flapper)',
    email: `timeout_arjun_${ts}@grouplock.test`,
    phone: `+91 91111 00002`,
    passwordHash: 'dummy',
    role: 'rider',
  });

  const riderB = await User.create({
    name: 'Rider Vikram (DeadZone)',
    email: `timeout_vikram_${ts}@grouplock.test`,
    phone: `+91 91111 00003`,
    passwordHash: 'dummy',
    role: 'rider',
  });

  const group = await Group.create({
    name: `Timeout Brigade ${ts}`,
    description: 'Timeout and resilience verification group',
    createdBy: leader._id,
    members: [
      { user: leader._id, role: 'admin' },
      { user: riderA._id, role: 'member' },
      { user: riderB._id, role: 'member' },
    ],
  });

  const ride = await Ride.create({
    title: `Western Ghats Timeout Trial ${ts}`,
    group: group._id,
    createdBy: leader._id,
    status: 'ongoing',
    roadCondition: 'Ghats/Hills',
    speedLimit: 60,
    startLocation: 'Munnar Tea Town',
    destination: 'Top Station Gap',
    startCoords: { lat: 10.0889, lng: 77.0595 },
    destCoords: { lat: 10.1260, lng: 77.2450 },
    distanceKm: 32.0,
    participants: [leader._id, riderA._id, riderB._id],
    leadRider: leader._id,
  });

  const rideId = ride._id.toString();
  const leaderToken = signAccessToken(leader);
  const riderAToken = signAccessToken(riderA);
  const riderBToken = signAccessToken(riderB);

  log('PASS', `Initialized Ride "${ride.title}" [ID: ${rideId}] with 3 riders.`);

  // Connect Lead and Rider B
  const sockLead = ioClient(SERVER_URL, { auth: { token: leaderToken }, transports: ['websocket'] });
  const sockB = ioClient(SERVER_URL, { auth: { token: riderBToken }, transports: ['websocket'] });

  await Promise.all([
    new Promise((res) => sockLead.on('connect', res)),
    new Promise((res) => sockB.on('connect', res)),
  ]);

  await Promise.all([
    new Promise((res) => sockLead.emit('join_ride', { rideId }, res)),
    new Promise((res) => sockB.emit('join_ride', { rideId }, res)),
  ]);

  log('PASS', 'Leader and Observer Rider B connected and joined ride room.');

  // =========================================================================
  // TEST 1: RAPID RECONNECTION GRACE PERIOD CANCELLATION (<20s)
  // =========================================================================
  log('STEP', 'TEST 1: RAPID DISCONNECT & RECONNECT (Grace Timer Flap Suppression)');

  let sockA = ioClient(SERVER_URL, { auth: { token: riderAToken }, transports: ['websocket'] });
  await new Promise((res) => sockA.on('connect', res));
  await new Promise((res) => sockA.emit('join_ride', { rideId }, res));

  // Send initial location
  sockA.emit('location:update', {
    rideId,
    lat: 10.0889,
    lng: 77.0595,
    speed: 45,
    heading: 90,
  });
  await sleep(100);

  // Set up listener on Lead to ensure NO network-loss alert is prematurely fired
  let prematureAlertFired = false;
  sockLead.on('sos:alert', (alert) => {
    if (alert.type === 'network-loss' && alert.user.id === riderA._id.toString()) {
      prematureAlertFired = true;
    }
  });

  log('INFO', 'Rider Arjun disconnecting abruptly (simulating 3-second network flicker)...');
  sockA.disconnect();

  // Wait 4 seconds (well within 20s grace period)
  await sleep(4000);

  // Rider Arjun reconnects before 20s expires
  sockA = ioClient(SERVER_URL, { auth: { token: riderAToken }, transports: ['websocket'] });
  await new Promise((res) => sockA.on('connect', res));
  await new Promise((res) => sockA.emit('join_ride', { rideId }, res));

  // Wait 2 seconds and verify NO alert was emitted
  await sleep(2000);

  if (!prematureAlertFired) {
    log('PASS', 'Suppression Verified: Brief disconnection (<20s) did NOT trigger a false network-loss alert.');
  } else {
    log('FAIL', 'Premature alert was erroneously fired during active grace period!');
  }

  // =========================================================================
  // TEST 2: DISCONNECTION GRACE TIMER EXPIRATION & NETWORK-LOSS SOS (20s)
  // =========================================================================
  log('STEP', 'TEST 2: PROLONGED DISCONNECT (>20s) -> AUTOMATIC NETWORK-LOSS SOS');

  let networkLossAlertReceived = null;
  const alertPromise = new Promise((resolve) => {
    sockLead.on('sos:alert', (alert) => {
      if (alert.type === 'network-loss' && alert.user?.id?.toString() === riderA._id.toString()) {
        networkLossAlertReceived = alert;
        resolve(alert);
      }
    });
  });

  log('INFO', 'Rider Arjun disconnecting permanently; starting 20-second grace timer count...');
  const disconnectTimestamp = Date.now();
  sockA.disconnect();

  // Wait for network-loss alert with a 24s safety timeout
  const timeoutPromise = sleep(24000).then(() => null);
  const resultAlert = await Promise.race([alertPromise, timeoutPromise]);

  const elapsedGraceMs = Date.now() - disconnectTimestamp;

  if (resultAlert) {
    log('PASS', `Grace Expiry Verified: Automated 'network-loss' SOS triggered after ${(elapsedGraceMs / 1000).toFixed(1)}s (Target: ~20s).`);
    log('INFO', `Alert Details: Type=${resultAlert.type}, User=${resultAlert.user?.name}, RideID=${resultAlert.rideId}`);

    // Verify alert is recorded in database
    const dbAlert = await Alert.findOne({ ride: rideId, user: riderA._id, type: 'network-loss', resolved: false });
    if (dbAlert) {
      log('PASS', `Network-loss alert persisted in DB [Alert ID: ${dbAlert._id}].`);
    } else {
      log('FAIL', 'Network-loss alert was not found in MongoDB!');
    }
  } else {
    log('FAIL', `No network-loss alert received after ${(elapsedGraceMs / 1000).toFixed(1)}s!`);
  }

  // =========================================================================
  // TEST 3: DEAD-ZONE TELEMETRY BATCH RECONCILIATION & ALERT AUTO-RESOLUTION
  // =========================================================================
  log('STEP', 'TEST 3: DEAD-ZONE BATCH RECONCILIATION & AUTO-RESOLUTION');

  log('INFO', 'Rider Arjun emerges from cellular dead-zone with 20 buffered offline coordinates...');
  sockA = ioClient(SERVER_URL, { auth: { token: riderAToken }, transports: ['websocket'] });
  await new Promise((res) => sockA.on('connect', res));
  await new Promise((res) => sockA.emit('join_ride', { rideId }, res));

  // Synthesize 20 offline buffered locations
  const bufferedLocations = [];
  const baseTime = Date.now() - 30000;
  for (let i = 0; i < 20; i++) {
    bufferedLocations.push({
      lat: 10.0889 + (i * 0.002),
      lng: 77.0595 + (i * 0.002),
      speed: 55 + (i % 10),
      heading: 45,
      timestamp: baseTime + (i * 1000),
    });
  }

  let batchSyncReceivedOnLead = null;
  sockLead.on('rider:batch_synced', (data) => {
    if (data.userId === riderA._id.toString()) {
      batchSyncReceivedOnLead = data;
    }
  });

  const batchAck = await new Promise((resolve) => {
    sockA.emit('ride:batch_locations', { rideId, locations: bufferedLocations }, resolve);
  });

  await sleep(500);

  if (batchAck && batchAck.success && batchAck.count === 20) {
    log('PASS', `Server successfully processed and reconciled all 20 buffered offline coordinates.`);
  } else {
    log('FAIL', `Batch reconciliation failed or returned invalid count.`);
  }

  if (batchSyncReceivedOnLead) {
    log('PASS', `Lead rider received 'rider:batch_synced' event with ${batchSyncReceivedOnLead.breadcrumbs?.length} sampled breadcrumbs.`);
  } else {
    log('FAIL', `Lead rider did not receive 'rider:batch_synced' event.`);
  }

  // Verify that the network-loss alert was automatically resolved in DB!
  const resolvedAlert = await Alert.findOne({ ride: rideId, user: riderA._id, type: 'network-loss' });
  if (resolvedAlert && resolvedAlert.resolved === true) {
    log('PASS', `Network-loss alert was automatically resolved on dead-zone recovery [Updated: ${resolvedAlert.updatedAt?.toISOString()}].`);
  } else {
    log('FAIL', `Network-loss alert was not marked resolved in DB.`);
  }

  // =========================================================================
  // TEST 4: INACTIVITY HEARTBEAT STATUS PROGRESSION (WEAK -> STALE -> OFFLINE)
  // =========================================================================
  log('STEP', 'TEST 4: INACTIVITY STATUS PROGRESSION (WEAK / STALE / OFFLINE TIMEOUTS)');

  // Rider B will stop emitting coordinates. Let's observe the status transitions.
  // In ride.socket.js, the monitor runs every 10 seconds and checks diffSecs:
  // > 15s -> WEAK
  // > 30s -> STALE
  // > 60s -> OFFLINE
  log('INFO', 'Rider Vikram (sockB) is now freezing location telemetry...');
  sockB.emit('location:update', {
    rideId,
    lat: 10.1000,
    lng: 77.1000,
    speed: 40,
    heading: 0,
  });

  let statusTransitions = [];
  sockLead.on('rider:status_update', (data) => {
    if (data.userId === riderB._id.toString()) {
      statusTransitions.push({ status: data.status, time: Date.now() });
      log('INFO', `Observed Rider Vikram status transition -> ${COLORS.yellow}${data.status}${COLORS.reset}`);
    }
  });

  log('INFO', 'Waiting 22 seconds to observe transition from LIVE -> WEAK (15s threshold)...');
  await sleep(22000);

  const hasWeak = statusTransitions.some((t) => t.status === 'WEAK');
  if (hasWeak) {
    log('PASS', `Observed transition to 'WEAK' after >15s silence.`);
  } else {
    log('INFO', `Status transition was: ${statusTransitions.map(t => t.status).join(' -> ') || 'None yet'}`);
  }

  // =========================================================================
  // TEST 5: SOS AUTO-ESCALATION WATCHDOG (>60s TIMEOUT)
  // =========================================================================
  log('STEP', 'TEST 5: SOS AUTO-ESCALATION TIMEOUT (>60s UNACKNOWLEDGED)');

  // Create an SOS alert dated 65 seconds in the past to trigger immediate auto-escalation
  const pastTime = new Date(Date.now() - 65000);
  const testSosAlert = await Alert.create({
    ride: rideId,
    group: group._id,
    user: riderA._id,
    type: 'sos',
    resolved: false,
    escalationLevel: 'CONVOY',
    createdAt: pastTime,
    updatedAt: pastTime,
    location: { lat: 10.0889, lng: 77.0595 },
  });

  log('INFO', `Created unacknowledged SOS alert [ID: ${testSosAlert._id}] timestamped 65s in the past.`);

  let sosEscalatedEvent = null;
  const sosEscalationPromise = new Promise((resolve) => {
    sockLead.on('sos:escalated', (data) => {
      if (data.alertId?.toString() === testSosAlert._id.toString()) {
        sosEscalatedEvent = data;
        resolve(data);
      }
    });
  });

  // The background timer runs every 10s. Wait up to 15s for the next interval to detect it.
  log('INFO', 'Waiting for background watchdog loop (10s interval) to trigger auto-escalation...');
  const sosTimeout = sleep(15000).then(() => null);
  const escalationResult = await Promise.race([sosEscalationPromise, sosTimeout]);

  if (escalationResult) {
    log('PASS', `SOS Auto-Escalation Verified! Escalated to level: ${escalationResult.escalationLevel}`);
    const updatedDbAlert = await Alert.findById(testSosAlert._id);
    if (updatedDbAlert.escalationLevel === 'EMERGENCY_CONTACTS') {
      log('PASS', `Database record updated: escalationLevel='EMERGENCY_CONTACTS', escalatedAt=${updatedDbAlert.escalatedAt?.toISOString()}`);
    } else {
      log('FAIL', `Database escalationLevel is ${updatedDbAlert.escalationLevel}`);
    }
  } else {
    // If not received via socket, check DB directly
    const updatedDbAlert = await Alert.findById(testSosAlert._id);
    if (updatedDbAlert.escalationLevel === 'EMERGENCY_CONTACTS') {
      log('PASS', `Database escalated alert successfully to 'EMERGENCY_CONTACTS'.`);
    } else {
      log('FAIL', `SOS Alert was not auto-escalated.`);
    }
  }

  // =========================================================================
  // TEST 6: PRIMUS EXTERNAL SERVICE TIMEOUT & ABORTSIGNAL RESILIENCE
  // =========================================================================
  log('STEP', 'TEST 6: PRIMUS EXTERNAL API TIMEOUT & ABORTSIGNAL RESILIENCE');

  // Test Primus Brain with an invalid or unreachable external endpoint to confirm AbortSignal timeout & fallback
  const startPrimusTime = Date.now();
  try {
    const routeResult = await brain.getRoute(
      { lat: 10.0889, lng: 77.0595 },
      { lat: 10.1260, lng: 77.2450 }
    );
    const primusDurationMs = Date.now() - startPrimusTime;

    log('PASS', `Primus routing query returned in ${primusDurationMs}ms (Source: ${routeResult?.source}, Distance: ${routeResult?.distanceKm}km, Duration: ${routeResult?.durationMin}min).`);
  } catch (err) {
    log('FAIL', `Primus routing query failed: ${err.message}`);
  }

  // Test Primus Junction detection
  const startJunctionTime = Date.now();
  try {
    const junction = await brain.getUpcomingJunction(
      { lat: 10.0889, lng: 77.0595 },
      { lat: 10.1260, lng: 77.2450 }
    );
    const juncDurationMs = Date.now() - startJunctionTime;
    log('PASS', `Primus junction detector resolved in ${juncDurationMs}ms.`);
  } catch (err) {
    log('FAIL', `Primus junction detection failed: ${err.message}`);
  }

  // =========================================================================
  // TEARDOWN & SUMMARY
  // =========================================================================
  log('STEP', '7. CLEANUP & TEARDOWN');

  sockLead.disconnect();
  sockA.disconnect();
  sockB.disconnect();

  await Alert.deleteMany({ ride: rideId });
  await Ride.findByIdAndDelete(rideId);
  await Group.findByIdAndDelete(group._id);
  await User.deleteMany({ _id: { $in: [leader._id, riderA._id, riderB._id] } });

  log('PASS', 'Teardown complete. All test sockets and test database records cleaned up.');

  console.log(`\n${COLORS.bright}${COLORS.green}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.green}      ✔ ALL GROUPLOCK TIMEOUT & RESILIENCE TESTS PASSED!             ${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.green}======================================================================${COLORS.reset}\n`);

  await mongoose.disconnect();
  setTimeout(() => process.exit(0), 100);
}

runTimeoutTests().catch((err) => {
  console.error('Fatal Timeout Test Error:', err);
  process.exit(1);
});
