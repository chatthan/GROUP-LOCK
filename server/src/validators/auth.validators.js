// Small dependency-free validators. Kept intentionally simple - a project
// this size doesn't need a full validation library.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[+]?[0-9]{7,15}$/; // digits, optional leading +, 7-15 digits
const MIN_PASSWORD_LENGTH = 8;

function validateRegisterInput({ name, email, phone, username, password, pincode, dob }) {
  const errors = [];

  if (!name || !name.trim()) errors.push('Name is required.');
  if (!email || !email.trim()) errors.push('Email is required.');
  else if (!EMAIL_REGEX.test(email.trim())) errors.push('Email is not valid.');

  if (!phone || !phone.trim()) errors.push('Phone number is required.');
  else if (!PHONE_REGEX.test(phone.trim())) errors.push('Phone number is not valid.');

  if (username && username.trim().length < 3) {
    errors.push('Username must be at least 3 characters.');
  }

  if (pincode && pincode.trim() && !/^[0-9]{6}$/.test(pincode.trim())) {
    errors.push('Pincode must be 6 digits.');
  }

  if (dob && dob.trim()) {
    const dobDate = new Date(dob);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const eighteenYearsAgo = new Date();
    eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);
    eighteenYearsAgo.setHours(23, 59, 59, 999);

    if (isNaN(dobDate.getTime()) || dobDate > today) {
      errors.push('Date of Birth cannot be in the future.');
    } else if (dobDate > eighteenYearsAgo) {
      errors.push('You must be at least 18 years old to register.');
    }
  }

  if (!password) errors.push('Password is required.');
  else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  return errors;
}

function validateLoginInput({ email, password }) {
  const errors = [];
  if (!email || !email.trim()) errors.push('Email is required.');
  if (!password) errors.push('Password is required.');
  return errors;
}

module.exports = { validateRegisterInput, validateLoginInput, EMAIL_REGEX };
