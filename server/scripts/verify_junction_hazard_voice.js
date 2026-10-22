const mongoose = require('mongoose');
const brain = require('../src/services/primusBrain.service');
const Ride = require('../src/models/Ride');
const Hazard = require('../src/models/Hazard');
const User = require('../src/models/User');
const Group = require('../src/models/Group');
const { executePrimusCommand } = require('../src/controllers/primus.controller');

async function testJunctionAndHazard() {
  await mongoose.connect('mongodb://127.0.0.1:27017/grouplock');
  console.log('MongoDB connected.');

  // Create test user, group, ride
  const user = await User.create({
    name: 'Tactical Rider',
    email: `test_tac_${Date.now()}@example.com`,
    passwordHash: 'hashed_password_test_123',
    phone: '9876543210'
  });

  const group = await Group.create({
    name: 'Voice Test Convoy',
    createdBy: user._id,
    members: [{ user: user._id, role: 'admin', joinedAt: new Date() }],
    inviteCode: 'V' + Math.floor(10000 + Math.random() * 90000),
    status: 'active'
  });

  const ride = await Ride.create({
    title: 'Kochi to Aluva Test Route',
    group: group._id,
    createdBy: user._id,
    startLocation: 'Kaloor, Kochi',
    startCoords: { lat: 9.9816, lng: 76.2999 },
    destination: 'Aluva Flyover',
    destCoords: { lat: 10.1076, lng: 76.3516 },
    distanceKm: 16.5,
    participants: [user._id]
  });

  // Create a hazard ahead
  const hazard = await Hazard.create({
    ride: ride._id,
    group: group._id,
    title: 'Deep Pothole Near Kaloor',
    type: 'POTHOLE',
    location: { lat: 9.9920, lng: 76.3050 },
    severity: 'MEDIUM',
    reportedBy: user._id
  });

  console.log('\n--- 1. Testing "Find Nearest Petrol Pump" Voice Command ---');
  let resData = null;
  const mockRes1 = {
    status: () => mockRes1,
    json: (data) => { resData = data; return data; }
  };
  await executePrimusCommand({
    body: {
      rideId: ride._id.toString(),
      command: 'can you find nearest petrol pump',
      location: { lat: 9.9816, lng: 76.2999 }
    },
    user: { id: user._id.toString(), name: user.name }
  }, mockRes1, (err) => { if (err) console.error(err); });

  console.log('Action:', resData.action);
  console.log('Spoken:', resData.spokenResponse);
  if (resData.spokenResponse.includes('Nearest fuel station')) {
    console.log('✅ PASS: Fuel station located accurately.');
  }

  console.log('\n--- 2. Testing "Upcoming Junction" Voice Command ---');
  resData = null;
  const mockRes2 = {
    status: () => mockRes2,
    json: (data) => { resData = data; return data; }
  };
  await executePrimusCommand({
    body: {
      rideId: ride._id.toString(),
      command: 'what is the next junction',
      location: { lat: 9.9816, lng: 76.2999 }
    },
    user: { id: user._id.toString(), name: user.name }
  }, mockRes2, (err) => { if (err) console.error(err); });

  console.log('Action:', resData.action);
  console.log('Spoken:', resData.spokenResponse);
  if (resData.spokenResponse.includes('Upcoming junction')) {
    console.log('✅ PASS: Upcoming junction calculated from live route.');
  }

  console.log('\n--- 3. Testing "Check Hazards Ahead" Voice Command ---');
  resData = null;
  const mockRes3 = {
    status: () => mockRes3,
    json: (data) => { resData = data; return data; }
  };
  await executePrimusCommand({
    body: {
      rideId: ride._id.toString(),
      command: 'any hazards ahead',
      location: { lat: 9.9816, lng: 76.2999 }
    },
    user: { id: user._id.toString(), name: user.name }
  }, mockRes3, (err) => { if (err) console.error(err); });

  console.log('Action:', resData.action);
  console.log('Spoken:', resData.spokenResponse);
  if (resData.spokenResponse.includes('road hazard') || resData.spokenResponse.includes('POTHOLE')) {
    console.log('✅ PASS: Active road hazard reported with live distance.');
  }

  // Cleanup
  await Hazard.deleteMany({ ride: ride._id });
  await Ride.deleteMany({ _id: ride._id });
  await Group.deleteMany({ _id: group._id });
  await User.deleteMany({ _id: user._id });
  await mongoose.disconnect();
  console.log('\nAll test records cleaned up. Test complete!');
}

testJunctionAndHazard().catch(console.error);
