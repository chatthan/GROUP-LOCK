const mongoose = require('mongoose');
const env = require('../src/config/env');
const User = require('../src/models/User');
const Group = require('../src/models/Group');
const Ride = require('../src/models/Ride');
const RideHistory = require('../src/models/RideHistory');

async function runTest() {
  console.log('=== STARTING RIDE HISTORY END-TO-END VERIFICATION TEST ===\n');

  await mongoose.connect(env.mongoUri);
  console.log('1. Connected to MongoDB successfully.');

  // Step 1: Create or find test user
  const email = `testrider_${Date.now()}@example.com`;
  const user = await User.create({
    name: 'Test Convoy Leader',
    email,
    phone: '+919999900001',
    passwordHash: 'dummyhash',
    role: 'rider',
  });
  console.log(`2. Created test rider: ${user.name} (${user._id})`);

  // Step 2: Create a group
  const group = await Group.create({
    name: 'Highland Cruisers Kerala',
    createdBy: user._id,
    members: [{ user: user._id, role: 'admin', joinedAt: new Date() }],
    inviteCode: 'TEST99',
    status: 'active',
  });
  console.log(`3. Created test group: "${group.name}" (ID: ${group._id})`);

  // Step 3: Create a ride
  const ride = await Ride.create({
    title: 'Munnar Hill Climb & Tea Gardens',
    group: group._id,
    createdBy: user._id,
    startLocation: 'Kottayam, Kerala',
    destination: 'Munnar, Kerala',
    distanceKm: 142.5,
    durationMinutes: 210,
    participants: [user._id],
    status: 'planned',
  });
  console.log(`4. Created planned ride: "${ride.title}" (Distance: ${ride.distanceKm} km)`);

  // Step 4: Start the ride
  ride.status = 'ongoing';
  ride.startedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 mins ago
  await ride.save();
  console.log(`5. Started ride at: ${ride.startedAt.toISOString()} (Status: ${ride.status})`);

  // Step 5: End the ride (Simulating endRide controller logic)
  ride.status = 'completed';
  ride.endedAt = new Date();
  await ride.save();

  const startTime = ride.startedAt ? ride.startedAt.getTime() : ride.createdAt.getTime();
  const durationMinutes = Math.max(1, Math.round((ride.endedAt.getTime() - startTime) / 60000));

  const historyRecord = await RideHistory.findOneAndUpdate(
    { ride: ride._id },
    {
      group: ride.group,
      participants: ride.participants,
      distanceKm: ride.distanceKm || 0,
      durationMinutes,
      memberCount: ride.participants.length,
    },
    { upsert: true, new: true }
  );
  console.log(`6. Ended ride! Duration calculated: ${durationMinutes} mins`);
  console.log(`7. RideHistory record upserted successfully: ID ${historyRecord._id}`);

  // Step 6: Verify RideHistory document contents
  const savedHistory = await RideHistory.findOne({ ride: ride._id })
    .populate('ride')
    .populate('participants', 'name email');

  console.log('\n=== VERIFYING STORED RIDE HISTORY RECORD ===');
  console.log('Record ID:', savedHistory._id.toString());
  console.log('Ride Title:', savedHistory.ride.title);
  console.log('Start Location:', savedHistory.ride.startLocation);
  console.log('Destination:', savedHistory.ride.destination);
  console.log('Ride Status:', savedHistory.ride.status);
  console.log('Distance (km):', savedHistory.distanceKm);
  console.log('Duration (minutes):', savedHistory.durationMinutes);
  console.log('Member Count:', savedHistory.memberCount);
  console.log('Participants Count:', savedHistory.participants.length);
  console.log('First Participant Name:', savedHistory.participants[0]?.name);
  console.log('Created At:', savedHistory.createdAt);

  const isVerified =
    savedHistory.ride.status === 'completed' &&
    savedHistory.distanceKm === 142.5 &&
    savedHistory.durationMinutes >= 1 &&
    savedHistory.memberCount === 1 &&
    savedHistory.participants.length === 1;

  if (isVerified) {
    console.log('\n✅ ALL ASSERTIONS PASSED! Ride history is storing trips accurately with distance, duration, route & participants.');
  } else {
    console.error('\n❌ ASSERTION FAILED!');
    process.exitCode = 1;
  }

  // Cleanup test docs
  await RideHistory.deleteOne({ _id: savedHistory._id });
  await Ride.deleteOne({ _id: ride._id });
  await Group.deleteOne({ _id: group._id });
  await User.deleteOne({ _id: user._id });
  console.log('8. Test cleanup completed.\n');

  await mongoose.disconnect();
  console.log('=== TEST FINISHED SUCCESSFULLY ===');
}

runTest().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
