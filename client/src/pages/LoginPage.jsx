import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { validateLoginForm } from '../utils/validators.js';
import { ApiError } from '../services/api.js';
import { joinGroup } from '../services/group.service.js';

const initialForm = { email: '', password: '' };

function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const justRegistered = location.state?.justRegistered;
  const redirectTo = location.state?.from?.pathname || '/dashboard';

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
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

    const errors = validateLoginForm(form);
    setFieldErrors(errors);
    setFormError('');
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await login({ email: form.email.trim(), password: form.password });

      // If logging in with a pending group invite, auto-join and redirect to group!
      const codeToJoin = pendingInviteCode || sessionStorage.getItem('grouplock_pending_invite');
      if (codeToJoin) {
        try {
          const storedToken = localStorage.getItem('grouplock_token');
          const joinRes = await joinGroup({ inviteCode: codeToJoin.trim().toUpperCase() }, storedToken);
          sessionStorage.removeItem('grouplock_pending_invite');
          navigate(`/groups/${joinRes.group.id}`, { replace: true });
          return;
        } catch (joinErr) {
          console.warn('Auto-join after login failed:', joinErr);
        }
      }

      navigate(redirectTo, { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Login failed. Please check your credentials.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4 sm:px-6 lg:px-8 flex justify-center items-center">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-100 p-6 sm:p-8">
        {/* Top bar with Register link */}
        <div className="flex justify-end mb-2">
          <Link
            to={pendingInviteCode ? `/register?code=${encodeURIComponent(pendingInviteCode)}` : '/register'}
            className="text-red-600 hover:text-red-700 text-sm font-semibold transition-colors"
          >
            Register
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
                Log in and you&apos;ll automatically enter the group!
              </p>
            </div>
          </div>
        )}

        {/* Header with Title, Welcome, and Circular Motorcycle Badge */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Welcome back!
            </h1>
            <p className="text-slate-500 text-base mt-1">Log in to your rider account</p>
          </div>
          <div className="flex-shrink-0 ml-3">
            <img
              src="/motorcycle_badge.png"
              alt="Motorcycle Badge"
              className="w-16 h-16 sm:w-20 sm:h-20 object-contain rounded-full shadow-sm border border-slate-100 bg-white"
            />
          </div>
        </div>

        {justRegistered && (
          <div className="mb-5 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5 flex items-center">
            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2 flex-shrink-0"></span>
            <span>Rider account registered successfully! Please log in with your credentials.</span>
          </div>
        )}

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
                autoComplete="current-password"
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

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-[#E53935] hover:bg-[#D32F2F] active:bg-[#C62828] text-white text-base font-semibold py-3 rounded-lg shadow-md hover:shadow-lg transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {submitting ? 'Logging in...' : 'Log in'}
            </button>
          </div>
        </form>

        <p className="text-sm text-slate-600 mt-6 text-center border-t border-slate-100 pt-4">
          Don&apos;t have a rider account?{' '}
          <Link
            to={pendingInviteCode ? `/register?code=${encodeURIComponent(pendingInviteCode)}` : '/register'}
            className="text-red-600 font-semibold hover:underline"
          >
            Register now
          </Link>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
