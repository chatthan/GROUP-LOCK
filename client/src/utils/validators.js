// Mirrors the backend's validation rules for instant feedback - the backend
// remains the source of truth and re-validates everything server-side.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[+]?[0-9]{7,15}$/;
const MIN_PASSWORD_LENGTH = 8;

export function validateRegisterForm({
  name,
  email,
  phone,
  username,
  pincode,
  dob,
  gender,
  password,
  confirmPassword,
}) {
  const errors = {};

  if (!phone || !phone.trim()) {
    errors.phone = 'Mobile Number is required.';
  } else if (!PHONE_REGEX.test(phone.trim().replace(/\s+/g, ''))) {
    errors.phone = 'Enter a valid mobile number.';
  }

  if (!name || !name.trim()) errors.name = 'Full Name is required.';

  if (!username || !username.trim()) {
    errors.username = 'Username is required.';
  } else if (username.trim().length < 3) {
    errors.username = 'Username must be at least 3 characters.';
  } else if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
    errors.username = 'Username can only contain letters, numbers, and underscores.';
  }

  if (!pincode || !pincode.trim()) {
    errors.pincode = 'Pincode is required.';
  } else if (!/^[0-9]{6}$/.test(pincode.trim())) {
    errors.pincode = 'Pincode must be 6 digits.';
  }

  if (!dob || !dob.trim()) {
    errors.dob = 'Date of Birth is required.';
  } else {
    const dobDate = new Date(dob);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (isNaN(dobDate.getTime())) {
      errors.dob = 'Enter a valid Date of Birth.';
    } else if (dobDate > today) {
      errors.dob = 'Date of Birth cannot be in the future.';
    }
  }

  if (!gender || !gender.trim()) {
    errors.gender = 'Please select your gender.';
  }

  if (!email || !email.trim()) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_REGEX.test(email.trim())) {
    errors.email = 'Enter a valid email address.';
  }

  if (!password) {
    errors.password = 'Password is required.';
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (!confirmPassword) {
    errors.confirmPassword = 'Please confirm your password.';
  } else if (password !== confirmPassword) {
    errors.confirmPassword = 'Passwords do not match.';
  }

  return errors;
}

export function validateLoginForm({ email, password }) {
  const errors = {};
  if (!email.trim()) errors.email = 'Email is required.';
  if (!password) errors.password = 'Password is required.';
  return errors;
}
