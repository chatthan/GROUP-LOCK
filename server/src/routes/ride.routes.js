const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const {
  createRide,
  getRidesByGroup,
  getRideDetails,
  joinRide,
  startRide,
  endRide,
  cancelRide,
  shareRiderLocation,
  getPlacesAutocomplete,
  getRideMessages,
  getRideAlerts,
  getRideHistory,
  getRideEvents,
  assignSweepRider,
  assignLeadRider,
  assignConvoyRoles,
  updateSpeedLimit,
  reportRider,
  kickRider,
  batchSyncLocations,
} = require('../controllers/ride.controller');

const router = express.Router();

router.use(authenticate);

router.get('/places-autocomplete', getPlacesAutocomplete);
// history/:groupId must be before /:id to avoid Express treating "history" as an :id param
router.get('/history/:groupId', getRideHistory);
router.post('/', createRide);
router.get('/group/:groupId', getRidesByGroup);
router.get('/:id', getRideDetails);
router.get('/:id/messages', getRideMessages);
router.get('/:id/alerts', getRideAlerts);
router.get('/:id/events', getRideEvents);
router.post('/:id/join', joinRide);
router.post('/:id/start', startRide);
router.post('/:id/end', endRide);
router.post('/:id/cancel', cancelRide);
router.post('/:id/share-location', shareRiderLocation);
router.post('/:id/sweep', assignSweepRider);
router.post('/:id/lead', assignLeadRider);
router.post('/:id/roles', assignConvoyRoles);
router.patch('/:id/speed-limit', updateSpeedLimit);
router.post('/:id/report', reportRider);
router.post('/:id/kick/:userId', kickRider);
router.post('/:id/batch-locations', batchSyncLocations);

module.exports = router;
