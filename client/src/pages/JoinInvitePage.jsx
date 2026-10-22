import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { joinGroup } from '../services/group.service';
import { ApiError } from '../services/api';

function JoinInvitePage() {
  const { code: routeCode } = useParams();
  const [searchParams] = useSearchParams();
  const queryCode = searchParams.get('code') || searchParams.get('invite');
  const initialCode = (routeCode || queryCode || '').toUpperCase().trim();

  const { user, token, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [inputCode, setInputCode] = useState(initialCode);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [joinedGroup, setJoinedGroup] = useState(null);

  const attemptJoin = useCallback(
    async (codeToJoin) => {
      const trimmed = (codeToJoin || '').trim().toUpperCase();
      if (!trimmed || trimmed.length !== 6) {
        setError('Please enter a valid 6-character invite code.');
        return;
      }

      setError('');
      setJoining(true);
      try {
        const res = await joinGroup({ inviteCode: trimmed }, token);
        sessionStorage.removeItem('grouplock_pending_invite');
        setJoinedGroup(res.group);

        // Auto-redirect to the group page after brief success state
        setTimeout(() => {
          navigate(`/groups/${res.group.id}`, { replace: true });
        }, 1200);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to join group with this invite code.');
      } finally {
        setJoining(false);
      }
    },
    [token, navigate]
  );

  // Store code in sessionStorage so it persists through register/login flow
  useEffect(() => {
    if (initialCode) {
      sessionStorage.setItem('grouplock_pending_invite', initialCode);
    }
  }, [initialCode]);

  // If user is already authenticated and an invite code was provided in URL, auto-join immediately
  useEffect(() => {
    if (!authLoading && user && token && initialCode && !joinedGroup && !joining && !error) {
      attemptJoin(initialCode);
    }
  }, [authLoading, user, token, initialCode, joinedGroup, joining, error, attemptJoin]);

  function handleManualSubmit(e) {
    e.preventDefault();
    if (!user) {
      navigate(`/register?code=${encodeURIComponent(inputCode.trim().toUpperCase())}`);
      return;
    }
    attemptJoin(inputCode);
  }

  const activeCode = initialCode || inputCode;

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-slate-950 py-10 px-4 sm:px-6 lg:px-8 flex justify-center items-center">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl p-6 sm:p-8 text-center text-white relative overflow-hidden">
        {/* Decorative background glow */}
        <div className="absolute -top-24 -left-24 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-red-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Big Icon */}
        <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-400 p-0.5 shadow-lg shadow-emerald-900/40">
          <div className="w-full h-full bg-slate-900 rounded-[14px] flex items-center justify-center text-3xl">
            🏍️
          </div>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-white mb-1">
          Group Ride Invitation
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mb-6">
          Join your fellow riders on GROUP-LOCK for live convoy tracking & safety.
        </p>

        {/* State 1: Joining in Progress */}
        {joining && (
          <div className="bg-slate-800/80 border border-slate-700 rounded-2xl p-6 space-y-3 animate-pulse">
            <div className="w-10 h-10 mx-auto border-3 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-emerald-400">
              Connecting you to the group...
            </p>
            <p className="text-xs text-slate-400">Code: {activeCode}</p>
          </div>
        )}

        {/* State 2: Success State */}
        {joinedGroup && !joining && (
          <div className="bg-emerald-950/60 border border-emerald-500/60 rounded-2xl p-6 space-y-3">
            <span className="text-4xl block">🎉</span>
            <p className="text-base font-bold text-emerald-300">
              Successfully Joined &quot;{joinedGroup.name}&quot;!
            </p>
            <p className="text-xs text-slate-300">
              Redirecting you to the group dashboard now...
            </p>
            <Link
              to={`/groups/${joinedGroup.id}`}
              className="inline-block mt-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold px-4 py-2 rounded-xl transition"
            >
              Open Group Now →
            </Link>
          </div>
        )}

        {/* State 3: User NOT Authenticated -> Prompt to Register or Login */}
        {!authLoading && !user && !joinedGroup && !joining && (
          <div className="space-y-5">
            {activeCode && (
              <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                  Invite Code Attached
                </span>
                <span className="text-2xl font-mono font-extrabold tracking-widest text-emerald-400">
                  {activeCode}
                </span>
              </div>
            )}

            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 text-left">
              <p className="text-xs font-bold text-emerald-400 flex items-center gap-1.5 mb-1">
                <span>⚡</span> Auto-Join Ready
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">
                Create a quick rider account or log in. You will be automatically added to this group immediately upon completion!
              </p>
            </div>

            <div className="space-y-2.5 pt-2">
              <Link
                to={`/register?code=${encodeURIComponent(activeCode)}`}
                className="w-full bg-[#E53935] hover:bg-[#D32F2F] text-white font-bold text-sm py-3 px-4 rounded-xl shadow-lg transition-all block text-center"
              >
                Register as New Rider (Fast)
              </Link>
              <Link
                to={`/login?code=${encodeURIComponent(activeCode)}`}
                className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold text-sm py-3 px-4 rounded-xl transition-all block text-center"
              >
                Log in to Existing Account
              </Link>
            </div>
          </div>
        )}

        {/* State 4: Authenticated with error or manual input */}
        {!authLoading && user && !joinedGroup && !joining && (
          <div className="space-y-4">
            {error && (
              <div className="bg-red-950/50 border border-red-500/50 rounded-2xl p-4 text-xs text-red-300 text-left">
                <p className="font-bold mb-1 flex items-center gap-1">
                  <span>⚠️</span> Could not join group
                </p>
                <p>{error}</p>
              </div>
            )}

            <form onSubmit={handleManualSubmit} className="space-y-3">
              <div className="text-left">
                <label
                  htmlFor="inviteInput"
                  className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1"
                >
                  Enter Invite Code
                </label>
                <input
                  id="inviteInput"
                  type="text"
                  maxLength={6}
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                  placeholder="e.g. A7K9PX"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-center text-lg font-mono font-bold tracking-widest text-emerald-400 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <button
                type="submit"
                disabled={joining || !inputCode.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white font-bold text-sm py-3 rounded-xl transition"
              >
                Join Group Now
              </button>
            </form>

            <Link
              to="/dashboard"
              className="inline-block text-xs text-slate-400 hover:text-slate-200 mt-2 transition"
            >
              ← Back to Dashboard
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default JoinInvitePage;
