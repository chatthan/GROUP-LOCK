import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { getGroupDetails, leaveGroup, regenerateInvite, promoteMember } from '../services/group.service';
import { getRidesByGroup } from '../services/ride.service';
import { ApiError } from '../services/api';
import CreateRideForm from '../components/CreateRideForm.jsx';
import RideCard from '../components/RideCard.jsx';
import ShareInviteBox from '../components/ShareInviteBox.jsx';

const RIDES_PER_PAGE = 5;

function GroupDetailsPage() {
  const { id } = useParams();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [group, setGroup] = useState(null);
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingRides, setLoadingRides] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showCreateRide, setShowCreateRide] = useState(false);
  const [promotingId, setPromotingId] = useState(null);

  // Pagination
  const [ridePage, setRidePage] = useState(1);

  const loadRides = useCallback(async () => {
    if (!id || !token) return;
    setLoadingRides(true);
    try {
      const data = await getRidesByGroup(id, token);
      setRides(data.rides || []);
      setRidePage(1); // reset page on reload
    } catch (err) {
      console.error('Could not load rides:', err);
    } finally {
      setLoadingRides(false);
    }
  }, [id, token]);

  const loadGroup = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getGroupDetails(id, token);
      setGroup(data.group);
      await loadRides();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load group.');
    } finally {
      setLoading(false);
    }
  }, [id, token, loadRides]);

  useEffect(() => {
    loadGroup();
  }, [loadGroup]);

  async function handleLeave() {
    if (leaving) return;
    setActionError('');
    setLeaving(true);
    try {
      await leaveGroup(id, token);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not leave group.');
    } finally {
      setLeaving(false);
    }
  }

  async function handleRegenerate() {
    if (regenerating) return;
    setActionError('');
    setRegenerating(true);
    try {
      const res = await regenerateInvite(id, token);
      if (res && res.inviteCode) {
        setGroup((prev) => ({
          ...prev,
          inviteCode: res.inviteCode,
          inviteExpiresAt: res.inviteExpiresAt,
        }));
      } else {
        await loadGroup();
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not regenerate invite.');
    } finally {
      setRegenerating(false);
    }
  }

  async function handlePromote(memberId) {
    if (promotingId) return;
    setActionError('');
    setPromotingId(memberId);
    try {
      await promoteMember(id, memberId, token);
      await loadGroup();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not promote member.');
    } finally {
      setPromotingId(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading group details...</p>;
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto bg-white shadow rounded-lg p-6">
        <p className="text-sm text-red-700 mb-4">{error}</p>
        <Link to="/dashboard" className="text-sm font-medium text-slate-900 hover:underline">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const isAdmin = group.myRole === 'admin';
  const currentUserId = user?.id;

  // Pagination calculations
  const totalPages = Math.max(1, Math.ceil(rides.length / RIDES_PER_PAGE));
  const pagedRides = rides.slice((ridePage - 1) * RIDES_PER_PAGE, ridePage * RIDES_PER_PAGE);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-white shadow rounded-lg p-6">
        <Link to="/dashboard" className="text-xs text-slate-400 hover:text-slate-600">
          ← Back to Dashboard
        </Link>

        <h2 className="text-xl font-semibold text-slate-900 mt-2 mb-1">{group.name}</h2>
        <p className="text-xs text-slate-500 mb-4">
          <span className={group.status === 'active' ? 'text-emerald-600 font-medium' : 'text-slate-400'}>
            {group.status}
          </span>{' '}
          · Your role: <span className="uppercase font-semibold text-slate-700">{group.myRole}</span>
        </p>

        {actionError && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {actionError}
          </div>
        )}

        {isAdmin && group.inviteCode && (
          <div className="mb-6 space-y-2">
            <ShareInviteBox
              groupName={group.name}
              inviteCode={group.inviteCode}
              expiresAt={group.inviteExpiresAt}
            />
            <div className="flex justify-end pt-1">
              <button
                onClick={handleRegenerate}
                disabled={regenerating}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 underline disabled:opacity-50 transition"
              >
                {regenerating ? 'Regenerating new code...' : '🔄 Regenerate Invite Code'}
              </button>
            </div>
          </div>
        )}

        <div className="mb-6">
          <p className="text-sm font-semibold text-slate-900 mb-3">
            Group Members ({group.members.length})
          </p>
          <ul className="space-y-2">
            {group.members.map((m) => {
              const memberId = m.user?._id || m.user;
              const isCurrentUser = memberId?.toString() === currentUserId?.toString();
              const alreadyAdmin = m.role === 'admin';
              return (
                <li
                  key={memberId}
                  className="flex items-center justify-between text-sm border-b border-slate-100 pb-2"
                >
                  <div>
                    <span className="text-slate-900 font-medium">{m.user?.name || 'Rider'}</span>
                    <span className="text-slate-400 ml-2 text-xs">{m.user?.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase font-medium text-slate-500">{m.role}</span>
                    {isAdmin && !alreadyAdmin && !isCurrentUser && (
                      <button
                        onClick={() => handlePromote(memberId)}
                        disabled={promotingId === memberId}
                        className="text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-emerald-100 disabled:opacity-50 transition"
                      >
                        {promotingId === memberId ? '…' : 'Promote'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-slate-200 pt-4 flex items-center justify-between flex-wrap gap-3">
          <button
            onClick={handleLeave}
            disabled={leaving}
            className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            {leaving ? 'Leaving Group...' : 'Leave Group'}
          </button>

          <Link
            to={`/groups/${id}/history`}
            className="text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center gap-1"
          >
            📋 Ride History
          </Link>
        </div>
      </div>

      {/* Rides Section */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">Group Rides</h3>
          <button
            onClick={() => setShowCreateRide(!showCreateRide)}
            className="text-xs font-medium bg-slate-900 text-white px-3 py-1.5 rounded-md hover:bg-slate-800"
          >
            {showCreateRide ? 'Cancel' : '+ Schedule Ride'}
          </button>
        </div>

        {showCreateRide && (
          <div className="mb-4">
            <CreateRideForm
              groupId={group.id}
              onCreated={() => {
                setShowCreateRide(false);
                loadRides();
              }}
              onCancel={() => setShowCreateRide(false)}
            />
          </div>
        )}

        {loadingRides && <p className="text-sm text-slate-500">Loading rides...</p>}

        {!loadingRides && rides.length === 0 && (
          <p className="text-sm text-slate-500 py-2">
            No rides scheduled yet for this group. Click &quot;+ Schedule Ride&quot; to create one.
          </p>
        )}

        <div className="space-y-3">
          {pagedRides.map((ride) => (
            <RideCard
              key={ride.id}
              ride={ride}
              currentUserId={user?.id}
              userRole={group.myRole}
              onRefresh={loadRides}
            />
          ))}
        </div>

        {/* Pagination Controls */}
        {rides.length > RIDES_PER_PAGE && (
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <button
              onClick={() => setRidePage((p) => Math.max(1, p - 1))}
              disabled={ridePage === 1}
              className="px-3 py-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 font-medium transition"
            >
              ← Previous
            </button>
            <span>
              Page {ridePage} of {totalPages}
            </span>
            <button
              onClick={() => setRidePage((p) => Math.min(totalPages, p + 1))}
              disabled={ridePage === totalPages}
              className="px-3 py-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 font-medium transition"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default GroupDetailsPage;
