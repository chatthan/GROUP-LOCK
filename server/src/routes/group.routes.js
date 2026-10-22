const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const {
  createGroup,
  joinGroup,
  getMyGroups,
  getGroupDetails,
  leaveGroup,
  regenerateInvite,
  promoteMember,
} = require('../controllers/group.controller');

const router = express.Router();

// Every group route requires a valid JWT - applied once here rather than
// repeating `authenticate` on each route.
router.use(authenticate);

router.post('/', createGroup);
router.get('/', getMyGroups);
router.post('/join', joinGroup);
router.get('/:id', getGroupDetails);
router.post('/:id/leave', leaveGroup);
router.post('/:id/regenerate-invite', regenerateInvite);
router.post('/:id/promote/:userId', promoteMember);

module.exports = router;
