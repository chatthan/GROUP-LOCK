const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // excluded from queries by default - must opt in explicitly
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      unique: true,
    },
    pincode: {
      type: String,
      trim: true,
      default: '',
    },
    city: {
      type: String,
      trim: true,
      default: '',
    },
    state: {
      type: String,
      trim: true,
      default: '',
    },
    dob: {
      type: String,
      trim: true,
      default: '',
    },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other', ''],
      default: '',
    },
    bloodGroup: {
      type: String,
      enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', ''],
      default: '',
    },
    profilePic: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      enum: ['rider', 'rideAdmin'],
      default: 'rider',
    },
    emergencyContact: {
      name: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      relationship: { type: String, trim: true, default: '' },
    },
  },
  { timestamps: true }
);

// Belt-and-suspenders: even if a query does select passwordHash, strip it
// (and other internals) whenever a User doc is serialized to JSON/API response.
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
