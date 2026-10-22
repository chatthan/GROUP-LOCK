const simulationService = require('../services/simulation.service');

// POST /api/simulation/start
async function startSimulation(req, res, next) {
  try {
    const { rideId } = req.body;
    if (!rideId) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    const result = await simulationService.startSimulation(rideId, req.body);
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/simulation/scenario
async function triggerScenario(req, res, next) {
  try {
    const { rideId, scenario } = req.body;
    if (!rideId || !scenario) {
      return res.status(400).json({ error: 'rideId and scenario are required' });
    }
    const result = await simulationService.triggerScenario(rideId, scenario);
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/simulation/stop
async function stopSimulation(req, res, next) {
  try {
    const { rideId } = req.body;
    if (!rideId) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    const result = simulationService.stopSimulation(rideId);
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

// GET /api/simulation/status?rideId=...
async function getStatus(req, res, next) {
  try {
    const { rideId } = req.query;
    if (!rideId) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    const result = simulationService.getSimulationStatus(rideId);
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  startSimulation,
  triggerScenario,
  stopSimulation,
  getStatus,
};
