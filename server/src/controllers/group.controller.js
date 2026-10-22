const Group = require('../models/Group');
const { validateGroupName, validateInviteCode, isValidObjectId } = require('../validators/group.validators');
const { generateUniqueInviteCode, newInviteExpiry } = require('../services/invite.service');

function makeError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

// Finds the caller's membership entry within an already-loaded group doc.
// Returns undefined if the user is not a member.
function findMembership(group, userId) {
  return group.members.find((m) => {
    const memberUserId = m.user && m.user._id ? m.user._id.toString() : (m.user ? m.user.toString() : '');
    return memberUserId === userId;
  });
}

// POST /api/groups
async function createGroup(req, res, next) {
  try {
    const { name } = req.body;

    const nameErrors = validateGroupName(name);
    if (nameErrors.length > 0) {
      return next(makeError(nameErrors.join(' '), 400, 'VALIDATION_ERROR'));
    }

    const inviteCode = await generateUniqueInviteCode();

    const group = await Group.create({
      name: name.trim(),
      createdBy: req.user.id,
      members: [{ user: req.user.id, role: 'admin', joinedAt: new Date() }],
      inviteCode,
      inviteExpiresAt: newInviteExpiry(),
      status: 'active',
    });

    res.status(201).json({
      success: true,
      group: {
        id: group._id,
        name: group.name,
        inviteCode: group.inviteCode,
        createdBy: group.createdBy,
        members: group.members,
        status: group.status,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/groups/join
async function joinGroup(req, res, next) {
  try {
    const { code, errors } = validateInviteCode(req.body.inviteCode);
    if (errors.length > 0) {
      return next(makeError(errors.join(' '), 400, 'VALIDATION_ERROR'));
    }

    const group = await Group.findOne({ inviteCode: code });
    if (!group) {
      return next(makeError('Invite code not found.', 404, 'INVITE_NOT_FOUND'));
    }

    if (group.status !== 'active') {
      return next(makeError('This group is not currently active.', 400, 'GROUP_INACTIVE'));
    }

    if (group.inviteExpiresAt && group.inviteExpiresAt.getTime() < Date.now()) {
      return next(makeError('This invite code has expired.', 400, 'INVITE_EXPIRED'));
    }

    const existingMembership = findMembership(group, req.user.id);
    if (existingMembership) {
      return res.json({
        success: true,
        alreadyMember: true,
        message: 'You are already a member of this group.',
        group: {
          id: group._id,
          name: group.name,
          status: group.status,
          memberCount: group.members.length,
          myRole: existingMembership.role,
        },
      });
    }

    group.members.push({ user: req.user.id, role: 'member', joinedAt: new Date() });
    await group.save();

    res.json({
      success: true,
      group: {
        id: group._id,
        name: group.name,
        status: group.status,
        memberCount: group.members.length,
        myRole: 'member',
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/groups
async function getMyGroups(req, res, next) {
  try {
    const groups = await Group.find({ 'members.user': req.user.id }).sort({ createdAt: -1 });

    const result = groups.map((group) => {
      const membership = findMembership(group, req.user.id);
      return {
        id: group._id,
        name: group.name,
        status: group.status,
        createdBy: group.createdBy,
        memberCount: group.members.length,
        myRole: membership ? membership.role : null,
        createdAt: group.createdAt,
      };
    });

    res.json({ success: true, groups: result });
  } catch (err) {
    next(err);
  }
}

// GET /api/groups/:id
async function getGroupDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid group ID.', 400, 'INVALID_ID'));
    }

    const group = await Group.findById(id)
      .populate('createdBy', 'name email')
      .populate('members.user', 'name email');

    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    const membership = findMembership(group, req.user.id);
    if (!membership) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    const isAdmin = membership.role === 'admin';

    res.json({
      success: true,
      group: {
        id: group._id,
        name: group.name,
        status: group.status,
        creator: group.createdBy, // populated {_id, name, email}
        members: group.members.map((m) => ({
          user: m.user, // populated {_id, name, email}
          role: m.role,
          joinedAt: m.joinedAt,
        })),
        myRole: membership.role,
        joinedAt: membership.joinedAt,
        createdAt: group.createdAt,
        // Invite details are only useful to admins (they're the ones who'd
        // share/regenerate it) - members don't need it in this view.
        ...(isAdmin
          ? { inviteCode: group.inviteCode, inviteExpiresAt: group.inviteExpiresAt }
          : {}),
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/groups/:id/leave
async function leaveGroup(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid group ID.', 400, 'INVALID_ID'));
    }

    const group = await Group.findById(id);
    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    const membership = findMembership(group, req.user.id);
    if (!membership) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }

    if (membership.role === 'admin') {
      const adminCount = group.members.filter((m) => m.role === 'admin').length;
      if (adminCount <= 1) {
        return next(
          makeError(
            'You are the only admin. Promote another member to admin before leaving.',
            409,
            'LAST_ADMIN'
          )
        );
      }
    }

    group.members = group.members.filter((m) => m.user.toString() !== req.user.id);
    await group.save();

    res.json({ success: true, message: 'You have left the group.' });
  } catch (err) {
    next(err);
  }
}

// POST /api/groups/:id/regenerate-invite
async function regenerateInvite(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(makeError('Invalid group ID.', 400, 'INVALID_ID'));
    }

    const group = await Group.findById(id);
    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    const membership = findMembership(group, req.user.id);
    if (!membership) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }
    if (membership.role !== 'admin') {
      return next(makeError('Only a group admin can regenerate the invite code.', 403, 'FORBIDDEN'));
    }

    group.inviteCode = await generateUniqueInviteCode();
    group.inviteExpiresAt = newInviteExpiry();
    await group.save();

    res.json({
      success: true,
      inviteCode: group.inviteCode,
      inviteExpiresAt: group.inviteExpiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/groups/:id/promote/:userId
async function promoteMember(req, res, next) {
  try {
    const { id, userId } = req.params;

    if (!isValidObjectId(id)) {
      return next(makeError('Invalid group ID.', 400, 'INVALID_ID'));
    }
    if (!isValidObjectId(userId)) {
      return next(makeError('Invalid user ID.', 400, 'INVALID_ID'));
    }

    const group = await Group.findById(id).populate('members.user', 'name email');
    if (!group) {
      return next(makeError('Group not found.', 404, 'GROUP_NOT_FOUND'));
    }

    const callerMembership = findMembership(group, req.user.id);
    if (!callerMembership) {
      return next(makeError('You are not a member of this group.', 403, 'NOT_A_MEMBER'));
    }
    if (callerMembership.role !== 'admin') {
      return next(makeError('Only a group admin can promote members.', 403, 'FORBIDDEN'));
    }

    const targetMembership = findMembership(group, userId);
    if (!targetMembership) {
      return next(makeError('Target user is not a member of this group.', 404, 'MEMBER_NOT_FOUND'));
    }

    if (targetMembership.role === 'admin') {
      return next(makeError('User is already an admin.', 409, 'ALREADY_ADMIN'));
    }

    targetMembership.role = 'admin';
    await group.save();

    const members = group.members.map((m) => ({
      user: m.user,
      role: m.role,
      joinedAt: m.joinedAt,
    }));

    res.json({ success: true, members });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createGroup,
  joinGroup,
  getMyGroups,
  getGroupDetails,
  leaveGroup,
  regenerateInvite,
  promoteMember,
};
