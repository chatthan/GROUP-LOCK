const bcrypt = require('bcrypt');
const User = require('../models/User');
const { validateRegisterInput, validateLoginInput } = require('../validators/auth.validators');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../services/token.service');

const SALT_ROUNDS = 10;

// POST /api/auth/register
async function register(req, res, next) {
  try {
    const {
      name,
      email,
      phone,
      username,
      pincode,
      city,
      state,
      dob,
      gender,
      bloodGroup,
      profilePic,
      password,
    } = req.body;

    const errors = validateRegisterInput({
      name,
      email,
      phone,
      username,
      password,
      pincode,
      dob,
    });
    if (errors.length > 0) {
      const err = new Error(errors.join(' '));
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      const err = new Error('An account with this email already exists.');
      err.statusCode = 409;
      err.code = 'EMAIL_IN_USE';
      return next(err);
    }

    if (username && username.trim()) {
      const normalizedUsername = username.trim().toLowerCase();
      const existingUsername = await User.findOne({ username: normalizedUsername });
      if (existingUsername) {
        const err = new Error('Username is already taken.');
        err.statusCode = 409;
        err.code = 'USERNAME_IN_USE';
        return next(err);
      }
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // role is never taken from the request body - registration always
    // creates a plain "rider". Privileged roles must be assigned separately
    // (e.g. by an existing admin), never through open self-registration.
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      username: username ? username.trim().toLowerCase() : undefined,
      pincode: pincode ? pincode.trim() : '',
      city: city ? city.trim() : '',
      state: state ? state.trim() : '',
      dob: dob ? dob.trim() : '',
      gender: gender || '',
      bloodGroup: bloodGroup || '',
      profilePic: profilePic || '',
      passwordHash,
      role: 'rider',
    });

    const token = signAccessToken(user);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        pincode: user.pincode,
        city: user.city,
        state: user.state,
        dob: user.dob,
        gender: user.gender,
        bloodGroup: user.bloodGroup,
        profilePic: user.profilePic || '',
        role: user.role,
      },
    });
  } catch (err) {
    // Fallback for a rare race condition on the unique email index.
    if (err.code === 11000) {
      err.statusCode = 409;
      err.message = 'An account with this email already exists.';
      err.code = 'EMAIL_IN_USE';
    }
    next(err);
  }
}

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const errors = validateLoginInput({ email, password });
    if (errors.length > 0) {
      const err = new Error(errors.join(' '));
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    const normalizedEmail = email.trim().toLowerCase();

    // passwordHash has select:false on the schema, so it must be requested explicitly.
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

    // Same generic message whether the email doesn't exist or the password is
    // wrong - avoids leaking which accounts exist.
    const invalidCredentialsError = () => {
      const err = new Error('Invalid email or password.');
      err.statusCode = 401;
      err.code = 'INVALID_CREDENTIALS';
      return err;
    };

    if (!user) return next(invalidCredentialsError());

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) return next(invalidCredentialsError());

    const token = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    res.json({
      success: true,
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        pincode: user.pincode,
        city: user.city,
        state: user.state,
        dob: user.dob,
        gender: user.gender,
        bloodGroup: user.bloodGroup,
        profilePic: user.profilePic || '',
        role: user.role,
        emergencyContact: user.emergencyContact || { name: '', phone: '', relationship: '' },
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/refresh
async function refreshAccessToken(req, res, next) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      const err = new Error('Refresh token is required.');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (e) {
      const err = new Error('Invalid or expired refresh token.');
      err.statusCode = 401;
      err.code = 'INVALID_REFRESH_TOKEN';
      return next(err);
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      const err = new Error('User not found.');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      return next(err);
    }

    const token = signAccessToken(user);

    res.json({ success: true, token });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me (protected - req.user is set by the authenticate middleware)
async function getMe(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      const err = new Error('User not found.');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      return next(err);
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        pincode: user.pincode,
        city: user.city,
        state: user.state,
        dob: user.dob,
        gender: user.gender,
        bloodGroup: user.bloodGroup,
        profilePic: user.profilePic || '',
        role: user.role,
        emergencyContact: user.emergencyContact || { name: '', phone: '', relationship: '' },
      },
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/auth/profile (protected)
async function updateProfile(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      const err = new Error('User not found.');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      return next(err);
    }

    const {
      name,
      phone,
      username,
      pincode,
      city,
      state,
      dob,
      gender,
      bloodGroup,
      profilePic,
      emergencyContact,
    } = req.body;

    if (name !== undefined) {
      if (!name || !name.trim()) {
        const err = new Error('Name cannot be empty.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        return next(err);
      }
      user.name = name.trim();
    }

    if (phone !== undefined) {
      const trimmedPhone = phone.trim().replace(/\s+/g, '');
      const PHONE_REGEX = /^[+]?[0-9]{7,15}$/;
      if (!trimmedPhone || !PHONE_REGEX.test(trimmedPhone)) {
        const err = new Error('Enter a valid phone number.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        return next(err);
      }
      user.phone = trimmedPhone;
    }

    if (username !== undefined && username.trim()) {
      const normalizedUsername = username.trim().toLowerCase();
      if (normalizedUsername !== user.username) {
        if (normalizedUsername.length < 3 || !/^[a-zA-Z0-9_]+$/.test(normalizedUsername)) {
          const err = new Error('Username must be at least 3 characters (letters, numbers, underscore only).');
          err.statusCode = 400;
          err.code = 'VALIDATION_ERROR';
          return next(err);
        }
        const existingUsername = await User.findOne({ username: normalizedUsername, _id: { $ne: user._id } });
        if (existingUsername) {
          const err = new Error('Username is already taken.');
          err.statusCode = 409;
          err.code = 'USERNAME_IN_USE';
          return next(err);
        }
        user.username = normalizedUsername;
      }
    }

    if (pincode !== undefined) {
      if (pincode && !/^[0-9]{6}$/.test(pincode.trim())) {
        const err = new Error('Pincode must be 6 digits.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        return next(err);
      }
      user.pincode = pincode ? pincode.trim() : '';
    }

    if (city !== undefined) user.city = city.trim();
    if (state !== undefined) user.state = state.trim();

    if (dob !== undefined) {
      if (dob && dob.trim()) {
        const dobDate = new Date(dob);
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        const eighteenYearsAgo = new Date();
        eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);
        eighteenYearsAgo.setHours(23, 59, 59, 999);

        if (isNaN(dobDate.getTime()) || dobDate > today) {
          const err = new Error('Date of Birth cannot be in the future.');
          err.statusCode = 400;
          err.code = 'VALIDATION_ERROR';
          return next(err);
        }
        if (dobDate > eighteenYearsAgo) {
          const err = new Error('You must be at least 18 years old.');
          err.statusCode = 400;
          err.code = 'AGE_RESTRICTION';
          return next(err);
        }
      }
      user.dob = dob ? dob.trim() : '';
    }

    if (gender !== undefined) user.gender = gender;
    if (bloodGroup !== undefined) user.bloodGroup = bloodGroup;
    if (profilePic !== undefined) user.profilePic = profilePic;

    if (emergencyContact !== undefined) {
      user.emergencyContact = {
        name: emergencyContact?.name ? emergencyContact.name.trim() : '',
        phone: emergencyContact?.phone ? emergencyContact.phone.trim().replace(/\s+/g, '') : '',
        relationship: emergencyContact?.relationship ? emergencyContact.relationship.trim() : '',
      };
    }

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        pincode: user.pincode,
        city: user.city,
        state: user.state,
        dob: user.dob,
        gender: user.gender,
        bloodGroup: user.bloodGroup,
        profilePic: user.profilePic || '',
        role: user.role,
        emergencyContact: user.emergencyContact || { name: '', phone: '', relationship: '' },
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, getMe, updateProfile, refreshAccessToken };
