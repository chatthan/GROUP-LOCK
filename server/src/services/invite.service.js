const crypto = require('crypto');
const Group = require('../models/Group');

const CODE_LENGTH = 6;
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 chars, unambiguous enough for a mini-project
const MAX_ATTEMPTS = 5;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// crypto.randomInt gives an unbiased pick per character - Math.random() is
// explicitly avoided here since this value gates group access.
function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[crypto.randomInt(0, CHARSET.length)];
  }
  return code;
}

// Retries on the (astronomically unlikely) chance of a collision against
// existing codes - 36^6 possible codes, so this will essentially always
// succeed on the first try.
async function generateUniqueInviteCode() {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode();
    const existing = await Group.findOne({ inviteCode: code });
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique invite code. Please try again.');
}

function newInviteExpiry() {
  return new Date(Date.now() + INVITE_TTL_MS);
}

module.exports = { generateUniqueInviteCode, newInviteExpiry };
