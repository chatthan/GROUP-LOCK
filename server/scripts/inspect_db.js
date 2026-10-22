require('dotenv').config();
const mongoose = require('mongoose');

async function inspectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/grouplock';
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('Database Name:', db.databaseName);
  console.log('Connection URI:', uri);

  const collections = await db.listCollections().toArray();
  console.log('\n=== COLLECTIONS SUMMARY ===');
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    console.log('- ' + col.name + ': ' + count + ' document(s)');
  }

  console.log('\n=== USERS (Latest 5, passwordHash excluded) ===');
  const users = await db.collection('users').find({}, { projection: { passwordHash: 0 } }).sort({ _id: -1 }).limit(5).toArray();
  console.log(JSON.stringify(users, null, 2));

  console.log('\n=== GROUPS (Latest 5) ===');
  const groups = await db.collection('groups').find({}).sort({ _id: -1 }).limit(5).toArray();
  console.log(JSON.stringify(groups, null, 2));

  console.log('\n=== RIDES (Latest 5) ===');
  const rides = await db.collection('rides').find({}).sort({ _id: -1 }).limit(5).toArray();
  console.log(JSON.stringify(rides, null, 2));

  process.exit(0);
}

inspectDB().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
