const express = require('express');
const router = express.Router();
const simulationController = require('../controllers/simulation.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

router.post('/start', simulationController.startSimulation);
router.post('/scenario', simulationController.triggerScenario);
router.post('/stop', simulationController.stopSimulation);
router.get('/status', simulationController.getStatus);

module.exports = router;
