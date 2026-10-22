const mongoose = require('mongoose');

const MAX_GROUP_NAME_LENGTH = 60;
const INVITE_CODE_REGEX = /^[A-Z0-9]{6}$/;

function validateGroupName(name) {
  const errors = [];
  if (!name || !name.trim()) {
    errors.push('Group name is required.');
  } else if (name.trim().length > MAX_GROUP_NAME_LENGTH) {
    errors.push(`Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer.`);
  }
  return errors;
}

// Normalizes to uppercase and checks the expected 6-char alphanumeric shape.
// Returns { code, errors } so the controller can use the normalized value.
function validateInviteCode(rawCode) {
  const errors = [];
  const code = (rawCode || '').trim().toUpperCase();

  if (!code) {
    errors.push('Invite code is required.');
  } else if (!INVITE_CODE_REGEX.test(code)) {
    errors.push('Invite code must be 6 uppercase letters/numbers.');
  }

  return { code, errors };
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

module.exports = { validateGroupName, validateInviteCode, isValidObjectId, MAX_GROUP_NAME_LENGTH };
