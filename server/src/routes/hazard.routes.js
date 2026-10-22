const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const {
  getHazards,
  reportHazard,
  confirmHazard,
  resolveHazard,
} = require('../controllers/hazard.controller');

const router = express.Router();

router.use(authenticate);

router.get('/', getHazards);
router.post('/', reportHazard);
router.patch('/:id/confirm', confirmHazard);
router.patch('/:id/resolve', resolveHazard);

module.exports = router;
