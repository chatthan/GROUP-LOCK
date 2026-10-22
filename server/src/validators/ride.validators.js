const mongoose = require('mongoose');

const MAX_TITLE_LENGTH = 80;

function validateRideInput({ title, groupId }) {
  const errors = [];
  if (!title || !title.trim()) {
    errors.push('Ride title is required.');
  } else if (title.trim().length > MAX_TITLE_LENGTH) {
    errors.push(`Ride title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  }

  if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) {
    errors.push('Valid group ID is required.');
  }

  return errors;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

module.exports = {
  validateRideInput,
  isValidObjectId,
  MAX_TITLE_LENGTH,
};
