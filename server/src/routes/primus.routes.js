const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const primusController = require('../controllers/primus.controller');

// All PRIMUS endpoints require authenticated session/JWT
router.use(authenticate);

// 1. Full contextual snapshot for the active ride
router.get('/context/:rideId', primusController.getRideContext);

// 2. Real-time proactive insights (stragglers, stale locations, emergencies)
router.get('/proactive/:rideId', primusController.getProactiveInsights);

// 3. Command execution (voice or text NL commands & structured actions)
router.post('/command', primusController.executePrimusCommand);

// 4. Contacts in this ride's group (for voice messaging)
router.get('/contacts/:rideId', primusController.getRideContacts);

module.exports = router;
