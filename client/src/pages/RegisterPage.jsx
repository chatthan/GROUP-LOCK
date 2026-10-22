import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { validateRegisterForm } from '../utils/validators.js';
import { ApiError } from '../services/api.js';
import { joinGroup } from '../services/group.service.js';

// Common pincode lookup cache for instant feedback (e.g. Kerala / Major cities)
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

const initialForm = {
  name: '',
  email: '',
  phone: '',
  username: '',
  pincode: '',
  city: '',
  state: '',
  dob: '',
  gender: '',
  bloodGroup: '',
  profilePic: '',
  password: '',
  confirmPassword: '',
};

function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const queryCode = searchParams.get('code') || searchParams.get('invite') || '';
  const [pendingInviteCode, setPendingInviteCode] = useState(() => {
    return queryCode || (typeof window !== 'undefined' ? sessionStorage.getItem('grouplock_pending_invite') || '' : '');
  });

  useEffect(() => {
    if (queryCode) {
      setPendingInviteCode(queryCode);
      sessionStorage.setItem('grouplock_pending_invite', queryCode);
    }
  }, [queryCode]);

  const [form, setForm] = useState(initialForm);
  const [profilePicPreview, setProfilePicPreview] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [locationLabel, setLocationLabel] = useState('');
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // WhatsApp-style 1:1 image square crop & compression
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
        // Enforce 1:1 square ratio centered crop
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

  // Live Pincode Resolver (resolves to "KOTTAYAM , KERALA" as in RidingVerse)
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
        } else {
          setLocationLabel('');
        }
      })
      .catch(() => {
        if (isMounted) setLocationLabel('');
      })
      .finally(() => {
        if (isMounted) setLoadingLocation(false);
      });

    return () => {
      isMounted = false;
    };
  }, [form.pincode]);

  const todayDate = new Date().toISOString().split('T')[0];

  function handleChange(e) {
    const { name, value } = e.target;
    if (name === 'dob') {
      if (value && value > todayDate) {
        setFieldErrors((prev) => ({ ...prev, dob: 'Date of Birth cannot be in the future.' }));
        return;
      }
    }
    setForm((prev) => ({ ...prev, [name]: value }));
    // Clear specific field error as user types
    if (fieldErrors[name]) {
      setFieldErrors((prev) => {
        const updated = { ...prev };
        delete updated[name];
        return updated;
      });
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;

    // Clean phone number with country code if not present
    let rawPhone = form.phone.trim().replace(/\s+/g, '');
    if (/^[0-9]{10}$/.test(rawPhone)) {
      rawPhone = `+91${rawPhone}`;
    }

    const payloadToValidate = {
      ...form,
      phone: rawPhone,
    };

    const errors = validateRegisterForm(payloadToValidate);
    setFieldErrors(errors);
    setFormError('');
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: rawPhone,
        username: form.username.trim().toLowerCase(),
        pincode: form.pincode.trim(),
        city: form.city || '',
        state: form.state || '',
        dob: form.dob.trim(),
        gender: form.gender,
        bloodGroup: form.bloodGroup,
        profilePic: form.profilePic || '',
        password: form.password,
      });

      // If registered via group invite code, auto-join the group and redirect directly to it!
      const codeToJoin = pendingInviteCode || sessionStorage.getItem('grouplock_pending_invite');
      if (codeToJoin) {
        try {
          const storedToken = localStorage.getItem('grouplock_token');
          const joinRes = await joinGroup({ inviteCode: codeToJoin.trim().toUpperCase() }, storedToken);
          sessionStorage.removeItem('grouplock_pending_invite');
          navigate(`/groups/${joinRes.group.id}`, { replace: true });
          return;
        } catch (joinErr) {
          console.warn('Auto-join after register failed:', joinErr);
        }
      }

      // Default redirect to dashboard
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Registration failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6 lg:px-8 flex justify-center items-center">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-100 p-6 sm:p-8">
        {/* Top bar with Logout / Log in link matching RidingVerse screenshot */}
        <div className="flex justify-end mb-2">
          <Link
            to={pendingInviteCode ? `/login?code=${encodeURIComponent(pendingInviteCode)}` : '/login'}
            className="text-red-600 hover:text-red-700 text-sm font-semibold transition-colors"
          >
            Log in
          </Link>
        </div>

        {pendingInviteCode && (
          <div className="mb-4 bg-emerald-50 border border-emerald-300 rounded-xl p-3 flex items-center gap-2.5">
            <span className="text-xl">🏍️</span>
            <div>
              <p className="text-xs font-bold text-emerald-900">
                Group Invite Code: <span className="font-mono tracking-wider text-emerald-700">{pendingInviteCode}</span>
              </p>
              <p className="text-[11px] text-emerald-700">
                Register now and you&apos;ll automatically enter the group!
              </p>
            </div>
          </div>
        )}

        {/* Header with Title, Welcome, and Circular Motorcycle Badge */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Let's get you started!
            </h1>
            <p className="text-slate-500 text-base mt-1">Welcome!</p>
          </div>
          <div className="flex-shrink-0 ml-3">
            <img
              src="/motorcycle_badge.png"
              alt="Motorcycle Badge"
              className="w-16 h-16 sm:w-20 sm:h-20 object-contain rounded-full shadow-sm border border-slate-100 bg-white"
            />
          </div>
        </div>

        {formError && (
          <div className="mb-5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 flex items-center justify-between">
            <span>{formError}</span>
            <button
              type="button"
              onClick={() => setFormError('')}
              className="text-red-400 hover:text-red-600 font-bold ml-2"
            >
              ✕
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* WhatsApp-style Profile Photo Upload Frame (1:1 aspect ratio) */}
          <div className="flex flex-col items-center justify-center pt-1 pb-3">
            <div className="relative">
              {/* Circular 1:1 Aspect Ratio Frame */}
              <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-full overflow-hidden border-4 border-slate-100 shadow-md bg-slate-100 flex items-center justify-center relative">
                {profilePicPreview ? (
                  <img
                    src={profilePicPreview}
                    alt="Rider Profile"
                    className="w-full h-full object-cover aspect-square"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-slate-400">
                    <svg className="w-16 h-16 sm:w-18 sm:h-18" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                    </svg>
                  </div>
                )}
              </div>

              {/* Floating Camera Button (WhatsApp Style) */}
              <label
                htmlFor="profile-pic-upload"
                className="absolute bottom-1 right-1 w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-[#E53935] hover:bg-[#D32F2F] text-white flex items-center justify-center shadow-lg border-2 border-white cursor-pointer transition-transform transform active:scale-95"
                title="Upload Profile Picture"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <input
                  id="profile-pic-upload"
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoSelect}
                  className="hidden"
                />
              </label>
            </div>

            <div className="flex items-center gap-3 mt-2.5">
              <label
                htmlFor="profile-pic-upload"
                className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
              >
                {profilePicPreview ? 'Change Photo' : 'Upload Profile Photo'}
              </label>
              {profilePicPreview && (
                <button
                  type="button"
                  onClick={handleRemovePhoto}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">1:1 square ratio • Circular frame</p>
          </div>
          {/* Mobile Number with country prefix */}
          <div>
            <label htmlFor="phone" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Mobile Number *
            </label>
            <div className="flex rounded-lg border border-slate-300 overflow-hidden focus-within:ring-2 focus-within:ring-red-500 focus-within:border-red-500">
              <span className="inline-flex items-center px-3.5 bg-slate-100 text-slate-600 text-sm font-semibold border-r border-slate-300">
                +91
              </span>
              <input
                id="phone"
                name="phone"
                type="tel"
                value={form.phone}
                onChange={handleChange}
                autoComplete="tel"
                className="w-full px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none"
              />
            </div>
            {fieldErrors.phone && <p className="text-xs text-red-600 mt-1">{fieldErrors.phone}</p>}
          </div>

          {/* Full Name */}
          <div>
            <label htmlFor="name" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Full Name *
            </label>
            <input
              id="name"
              name="name"
              type="text"
              value={form.name}
              onChange={handleChange}
              autoComplete="name"
              className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.name ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {fieldErrors.name && <p className="text-xs text-red-600 mt-1">{fieldErrors.name}</p>}
          </div>

          {/* Username */}
          <div>
            <label htmlFor="username" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Username *
            </label>
            <input
              id="username"
              name="username"
              type="text"
              value={form.username}
              onChange={handleChange}
              autoComplete="username"
              className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.username ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {fieldErrors.username && <p className="text-xs text-red-600 mt-1">{fieldErrors.username}</p>}
          </div>

          {/* Pincode with Auto Location Display */}
          <div>
            <label htmlFor="pincode" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Pincode *
            </label>
            <input
              id="pincode"
              name="pincode"
              type="text"
              maxLength={6}
              value={form.pincode}
              onChange={handleChange}
              className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.pincode ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {/* Auto-detected district & state label as in screenshot */}
            {loadingLocation && (
              <p className="text-xs text-slate-400 mt-1 italic animate-pulse">Detecting area...</p>
            )}
            {locationLabel && !loadingLocation && (
              <div className="mt-1 flex items-center text-xs font-semibold text-slate-600 tracking-wider">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1.5"></span>
                <span>{locationLabel}</span>
              </div>
            )}
            {fieldErrors.pincode && <p className="text-xs text-red-600 mt-1">{fieldErrors.pincode}</p>}
          </div>

          {/* DOB */}
          <div>
            <label htmlFor="dob" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              DOB *
            </label>
            <input
              id="dob"
              name="dob"
              type="date"
              max={todayDate}
              value={form.dob}
              onChange={handleChange}
              className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.dob ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {fieldErrors.dob && <p className="text-xs text-red-600 mt-1">{fieldErrors.dob}</p>}
          </div>

          {/* Select Gender */}
          <div>
            <label htmlFor="gender" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Select Gender *
            </label>
            <select
              id="gender"
              name="gender"
              value={form.gender}
              onChange={handleChange}
              className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.gender ? 'border-red-400' : 'border-slate-300'
              }`}
            >
              <option value="">Select Gender</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
            {fieldErrors.gender && <p className="text-xs text-red-600 mt-1">{fieldErrors.gender}</p>}
          </div>

          {/* Select Blood Group (Optional) */}
          <div>
            <label htmlFor="bloodGroup" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Select Blood Group (Optional)
            </label>
            <select
              id="bloodGroup"
              name="bloodGroup"
              value={form.bloodGroup}
              onChange={handleChange}
              className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
            >
              <option value="">Select Blood Group (Optional)</option>
              <option value="A+">A+</option>
              <option value="A-">A-</option>
              <option value="B+">B+</option>
              <option value="B-">B-</option>
              <option value="AB+">AB+</option>
              <option value="AB-">AB-</option>
              <option value="O+">O+</option>
              <option value="O-">O-</option>
            </select>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Crucial for emergency responders and in-ride medical alert.
            </p>
          </div>

          {/* Email Address */}
          <div>
            <label htmlFor="email" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Email Address *
            </label>
            <input
              id="email"
              name="email"
              type="email"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
              className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                fieldErrors.email ? 'border-red-400' : 'border-slate-300'
              }`}
            />
            {fieldErrors.email && <p className="text-xs text-red-600 mt-1">{fieldErrors.email}</p>}
          </div>

          {/* Password & Confirm Password */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="password" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                Password *
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={handleChange}
                  autoComplete="new-password"
                  className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 pr-9 ${
                    fieldErrors.password ? 'border-red-400' : 'border-slate-300'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 text-xs"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              {fieldErrors.password && <p className="text-xs text-red-600 mt-1">{fieldErrors.password}</p>}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                Confirm *
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                value={form.confirmPassword}
                onChange={handleChange}
                autoComplete="new-password"
                className={`w-full border rounded-lg px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 ${
                  fieldErrors.confirmPassword ? 'border-red-400' : 'border-slate-300'
                }`}
              />
              {fieldErrors.confirmPassword && (
                <p className="text-xs text-red-600 mt-1">{fieldErrors.confirmPassword}</p>
              )}
            </div>
          </div>

          {/* Red Verification / Registration Button matching screenshot */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-[#E53935] hover:bg-[#D32F2F] active:bg-[#C62828] text-white text-base font-semibold py-3 rounded-lg shadow-md hover:shadow-lg transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {submitting ? 'Registering Rider...' : 'Verify Number'}
            </button>
          </div>
        </form>

        <p className="text-xs text-slate-400 mt-4 text-center">
          By continuing, you agree to our{' '}
          <span className="text-red-600 cursor-pointer hover:underline">Terms & Conditions</span> and{' '}
          <span className="text-red-600 cursor-pointer hover:underline">Privacy Policy</span>
        </p>

        <p className="text-sm text-slate-600 mt-5 text-center border-t border-slate-100 pt-4">
          Already registered as a rider?{' '}
          <Link to="/login" className="text-red-600 font-semibold hover:underline">
            Log in here
          </Link>
        </p>
      </div>
    </div>
  );
}

export default RegisterPage;
