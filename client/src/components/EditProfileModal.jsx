import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { ApiError } from '../services/api.js';

const PINCODE_LOOKUP_CACHE = {
  '686607': { district: 'KOTTAYAM', state: 'KERALA' },
  '682001': { district: 'ERNAKULAM', state: 'KERALA' },
  '695001': { district: 'THIRUVANANTHAPURAM', state: 'KERALA' },
  '680001': { district: 'THRISSUR', state: 'KERALA' },
  '673001': { district: 'KOZHIKODE', state: 'KERALA' },
  '560001': { district: 'BENGALURU', state: 'KARNATAKA' },
  '600001': { district: 'CHENNAI', state: 'TAMIL NADU' },
  '400001': { district: 'MUMBAI', state: 'MAHARASHTRA' },
  '110001': { district: 'NEW DELHI', state: 'DELHI' },
  '500001': { district: 'HYDERABAD', state: 'TELANGANA' },
};

function EditProfileModal({ onClose }) {
  const { user, updateProfile } = useAuth();

  const [form, setForm] = useState({
    name: user?.name || '',
    username: user?.username || '',
    phone: (user?.phone || '').replace(/^\+91/, ''),
    pincode: user?.pincode || '',
    city: user?.city || '',
    state: user?.state || '',
    dob: user?.dob || '',
    gender: user?.gender || '',
    bloodGroup: user?.bloodGroup || '',
    profilePic: user?.profilePic || '',
    iceName: user?.emergencyContact?.name || '',
    icePhone: (user?.emergencyContact?.phone || '').replace(/^\+91/, ''),
    iceRelationship: user?.emergencyContact?.relationship || '',
  });

  const [profilePicPreview, setProfilePicPreview] = useState(user?.profilePic || '');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [locationLabel, setLocationLabel] = useState(
    user?.city || user?.state ? `${user.city || ''} , ${user.state || ''}`.trim() : ''
  );
  const [loadingLocation, setLoadingLocation] = useState(false);

  const todayDate = new Date().toISOString().split('T')[0];

  // Live Pincode Resolver
  useEffect(() => {
    const pin = form.pincode.trim();
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      setLocationLabel('');
      return;
    }

    if (PINCODE_LOOKUP_CACHE[pin]) {
      const loc = PINCODE_LOOKUP_CACHE[pin];
      const text = `${loc.district} , ${loc.state}`;
      setLocationLabel(text);
      setForm((prev) => ({ ...prev, city: loc.district, state: loc.state }));
      return;
    }

    let isMounted = true;
    setLoadingLocation(true);
    fetch(`https://api.postalpincode.in/pincode/${pin}`)
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data && data[0] && data[0].Status === 'Success' && data[0].PostOffice?.length > 0) {
          const po = data[0].PostOffice[0];
          const district = po.District ? po.District.toUpperCase() : '';
          const state = po.State ? po.State.toUpperCase() : '';
          const text = district && state ? `${district} , ${state}` : district || state;
          setLocationLabel(text);
          setForm((prev) => ({ ...prev, city: district, state }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) setLoadingLocation(false);
      });

    return () => {
      isMounted = false;
    };
  }, [form.pincode]);

  function handleChange(e) {
    const { name, value } = e.target;
    if (name === 'dob' && value && value > todayDate) {
      setFieldErrors((prev) => ({ ...prev, dob: 'Date of Birth cannot be in the future.' }));
      return;
    }
    setForm((prev) => ({ ...prev, [name]: value }));
    if (fieldErrors[name]) {
      setFieldErrors((prev) => {
        const updated = { ...prev };
        delete updated[name];
        return updated;
      });
    }
  }

  // 1:1 WhatsApp aspect ratio crop
  function handlePhotoSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setFormError('Please select a valid image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const size = Math.min(img.width, img.height);
        const startX = (img.width - size) / 2;
        const startY = (img.height - size) / 2;

        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 400;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, startX, startY, size, size, 0, 0, 400, 400);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setProfilePicPreview(dataUrl);
        setForm((prev) => ({ ...prev, profilePic: dataUrl }));
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  function handleRemovePhoto() {
    setProfilePicPreview('');
    setForm((prev) => ({ ...prev, profilePic: '' }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;

    const errors = {};
    if (!form.name.trim()) errors.name = 'Full Name is required.';
    if (!form.phone.trim()) errors.phone = 'Phone number is required.';
    if (form.username && form.username.trim().length < 3) {
      errors.username = 'Username must be at least 3 characters.';
    }
    if (form.pincode && !/^[0-9]{6}$/.test(form.pincode.trim())) {
      errors.pincode = 'Pincode must be 6 digits.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    let cleanPhone = form.phone.trim().replace(/\s+/g, '');
    if (/^[0-9]{10}$/.test(cleanPhone)) {
      cleanPhone = `+91${cleanPhone}`;
    }

    let cleanIcePhone = (form.icePhone || '').trim().replace(/\s+/g, '');
    if (/^[0-9]{10}$/.test(cleanIcePhone)) {
      cleanIcePhone = `+91${cleanIcePhone}`;
    }

    setSubmitting(true);
    setFormError('');
    try {
      await updateProfile({
        name: form.name.trim(),
        username: form.username ? form.username.trim().toLowerCase() : '',
        phone: cleanPhone,
        pincode: form.pincode.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        dob: form.dob.trim(),
        gender: form.gender,
        bloodGroup: form.bloodGroup,
        profilePic: form.profilePic,
        emergencyContact: {
          name: form.iceName.trim(),
          phone: cleanIcePhone,
          relationship: form.iceRelationship.trim(),
        },
      });
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to update profile.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 w-full max-w-lg overflow-hidden my-8">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Edit Rider Profile</h3>
            <p className="text-xs text-slate-500">Update your personal details, ICE contacts, and profile picture</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 transition-colors"
          >
            ✕
          </button>
        </div>

        {formError && (
          <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {formError}
          </div>
        )}

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* WhatsApp-Style Circular Photo Uploader */}
          <div className="flex flex-col items-center justify-center pb-2">
            <div className="relative">
              <div className="w-28 h-28 rounded-full overflow-hidden border-4 border-slate-100 shadow-md bg-slate-100 flex items-center justify-center">
                {profilePicPreview ? (
                  <img
                    src={profilePicPreview}
                    alt="Rider Preview"
                    className="w-full h-full object-cover aspect-square"
                  />
                ) : (
                  <img
                    src="/grouplock_logo.png"
                    alt="GroupLock Default Rider Emblem"
                    className="w-full h-full object-contain p-1"
                  />
                )}
              </div>

              {/* Floating Camera Button */}
              <label
                htmlFor="edit-profile-photo-upload"
                className="absolute bottom-1 right-1 w-9 h-9 rounded-full bg-[#E53935] hover:bg-[#D32F2F] text-white flex items-center justify-center shadow-lg border-2 border-white cursor-pointer transition-transform transform active:scale-95"
                title="Change Photo"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <input
                  id="edit-profile-photo-upload"
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoSelect}
                  className="hidden"
                />
              </label>
            </div>

            <div className="flex items-center gap-3 mt-2">
              <label
                htmlFor="edit-profile-photo-upload"
                className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
              >
                Change Photo
              </label>
              {profilePicPreview && (
                <button
                  type="button"
                  onClick={handleRemovePhoto}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Full Name */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Full Name *
            </label>
            <input
              name="name"
              type="text"
              value={form.name}
              onChange={handleChange}
              className={`w-full border rounded-lg px-3.5 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.name ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {fieldErrors.name && <p className="text-xs text-red-600 mt-1">{fieldErrors.name}</p>}
          </div>

          {/* Username */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Username
            </label>
            <input
              name="username"
              type="text"
              value={form.username}
              onChange={handleChange}
              className={`w-full border rounded-lg px-3.5 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.username ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {fieldErrors.username && <p className="text-xs text-red-600 mt-1">{fieldErrors.username}</p>}
          </div>

          {/* Mobile Number */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Mobile Number *
            </label>
            <div className="flex rounded-lg border border-slate-300 overflow-hidden focus-within:ring-2 focus-within:ring-red-500 focus-within:border-red-500">
              <span className="inline-flex items-center px-3 bg-slate-100 text-slate-600 text-sm font-semibold border-r border-slate-300">
                +91
              </span>
              <input
                name="phone"
                type="tel"
                value={form.phone}
                onChange={handleChange}
                className="w-full px-3 py-2 text-sm text-slate-900 focus:outline-none"
              />
            </div>
            {fieldErrors.phone && <p className="text-xs text-red-600 mt-1">{fieldErrors.phone}</p>}
          </div>

          {/* Pincode with Auto Location Display */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Pincode
            </label>
            <input
              name="pincode"
              type="text"
              maxLength={6}
              value={form.pincode}
              onChange={handleChange}
              className={`w-full border rounded-lg px-3.5 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.pincode ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {loadingLocation && (
              <p className="text-xs text-slate-400 mt-1 italic animate-pulse">Detecting area...</p>
            )}
            {locationLabel && !loadingLocation && (
              <div className="mt-1 flex items-center text-xs font-semibold text-slate-600">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1.5"></span>
                <span>{locationLabel}</span>
              </div>
            )}
            {fieldErrors.pincode && <p className="text-xs text-red-600 mt-1">{fieldErrors.pincode}</p>}
          </div>

          {/* DOB & Gender */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                DOB
              </label>
              <input
                name="dob"
                type="date"
                max={todayDate}
                value={form.dob}
                onChange={handleChange}
                className={`w-full border rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                  fieldErrors.dob ? 'border-red-400' : 'border-slate-300'
                }`}
              />
              {fieldErrors.dob && <p className="text-xs text-red-600 mt-1">{fieldErrors.dob}</p>}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                Gender
              </label>
              <select
                name="gender"
                value={form.gender}
                onChange={handleChange}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
              >
                <option value="">Select Gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          {/* Blood Group */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Blood Group
            </label>
            <select
              name="bloodGroup"
              value={form.bloodGroup}
              onChange={handleChange}
              className="w-full border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
            >
              <option value="">Select Blood Group</option>
              <option value="A+">A+</option>
              <option value="A-">A-</option>
              <option value="B+">B+</option>
              <option value="B-">B-</option>
              <option value="AB+">AB+</option>
              <option value="AB-">AB-</option>
              <option value="O+">O+</option>
              <option value="O-">O-</option>
            </select>
          </div>

          {/* Stage 6: In-Case-Of-Emergency (ICE) Contact */}
          <div className="pt-3 border-t border-slate-200">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-red-500 text-sm">🆘</span>
              <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                Emergency Contact (ICE)
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">
              This contact will be prioritized if you or your convoy trigger an Emergency SOS during a ride.
            </p>

            <div className="space-y-3 bg-red-50/50 p-3 rounded-xl border border-red-100">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Contact Person Name
                </label>
                <input
                  name="iceName"
                  type="text"
                  placeholder="e.g. Rahul Sharma"
                  value={form.iceName}
                  onChange={handleChange}
                  className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 bg-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Emergency Phone
                  </label>
                  <div className="flex rounded-lg border border-slate-300 overflow-hidden bg-white focus-within:ring-2 focus-within:ring-red-500">
                    <span className="inline-flex items-center px-2.5 bg-slate-100 text-slate-600 text-xs font-semibold border-r border-slate-300">
                      +91
                    </span>
                    <input
                      name="icePhone"
                      type="tel"
                      placeholder="10-digit number"
                      value={form.icePhone}
                      onChange={handleChange}
                      className="w-full px-2.5 py-1.5 text-sm text-slate-900 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Relationship
                  </label>
                  <select
                    name="iceRelationship"
                    value={form.iceRelationship}
                    onChange={handleChange}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">Select Relation</option>
                    <option value="Parent">Parent</option>
                    <option value="Spouse">Spouse</option>
                    <option value="Sibling">Sibling</option>
                    <option value="Friend">Friend</option>
                    <option value="Guardian">Guardian</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 bg-[#E53935] hover:bg-[#D32F2F] text-white text-sm font-semibold rounded-lg shadow-md hover:shadow-lg transition-all disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default EditProfileModal;
