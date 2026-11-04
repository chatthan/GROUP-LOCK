import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { getMyGroups } from '../services/group.service';
import { initSocket, getSocket } from '../services/socket.service';
import { ApiError } from '../services/api';
import GroupCard from '../components/GroupCard.jsx';
import CreateGroupForm from '../components/CreateGroupForm.jsx';
import JoinGroupForm from '../components/JoinGroupForm.jsx';
import EditProfileModal from '../components/EditProfileModal.jsx';

function DashboardPage() {
  const { user, token, logout } = useAuth();

  const [groups, setGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [groupsError, setGroupsError] = useState('');
  const [activePanel, setActivePanel] = useState(null); // 'create' | 'join' | null
  const [showEditProfile, setShowEditProfile] = useState(false);

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    setGroupsError('');
    try {
      const data = await getMyGroups(token);
      setGroups(data.groups);
    } catch (err) {
      setGroupsError(err instanceof ApiError ? err.message : 'Could not load groups.');
    } finally {
      setLoadingGroups(false);
    }
  }, [token]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Real-Time Auto-Sync: Listen for group membership changes so member counts stay up-to-date without refreshing
  useEffect(() => {
    if (!token) return;
    const socket = initSocket(token);

    const silentRefresh = () => {
      getMyGroups(token)
        .then((res) => {
          if (res && res.groups) {
            setGroups(res.groups);
          }
        })
        .catch(() => {});
    };

    groups.forEach((g) => {
      if (g.id) socket.emit('join_group', { groupId: g.id });
    });

    socket.on('group:member_joined', silentRefresh);
    socket.on('group:member_left', silentRefresh);
    socket.on('group:member_promoted', silentRefresh);
    socket.on('ride:created', silentRefresh);

    const interval = setInterval(silentRefresh, 12000);

    return () => {
      clearInterval(interval);
      socket.off('group:member_joined', silentRefresh);
      socket.off('group:member_left', silentRefresh);
      socket.off('group:member_promoted', silentRefresh);
      socket.off('ride:created', silentRefresh);
    };
  }, [token, groups.length]);

  function closePanel() {
    setActivePanel(null);
    loadGroups();
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Rider Profile Card with WhatsApp-style Profile Photo */}
      <div className="bg-white shadow-md rounded-2xl p-6 border border-slate-100">
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
          {/* Profile Picture with 1:1 circular frame */}
          <div className="flex-shrink-0">
            <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden border-4 border-red-500 shadow-lg bg-slate-100 flex items-center justify-center">
              {user?.profilePic ? (
                <img
                  src={user.profilePic}
                  alt={user.name}
                  className="w-full h-full object-cover aspect-square"
                />
              ) : (
                <img
                  src="/grouplock_logo.png"
                  alt="GroupLock Mascot Emblem"
                  className="w-full h-full object-contain p-1"
                />
              )}
            </div>
          </div>

          {/* Rider Info & Details */}
          <div className="flex-1 text-center sm:text-left space-y-1.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-2xl font-bold text-slate-900 tracking-tight">{user?.name}</h2>
                {user?.username && (
                  <p className="text-sm font-semibold text-red-600">@{user.username}</p>
                )}
              </div>
              <div className="flex items-center gap-2 self-center sm:self-auto">
                <button
                  onClick={() => setShowEditProfile(true)}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors shadow-sm"
                >
                  Edit Profile
                </button>
                <button
                  onClick={logout}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                >
                  Log out
                </button>
              </div>
            </div>

            <p className="text-sm text-slate-500">{user?.email}</p>
            {user?.phone && (
              <p className="text-xs text-slate-600 font-medium">📱 {user.phone}</p>
            )}

            {/* Badges: Blood Group, Location, Role */}
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-2">
              {user?.bloodGroup && (
                <span className="inline-flex items-center text-xs font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-700 border border-red-200">
                  🩸 {user.bloodGroup}
                </span>
              )}
              {(user?.city || user?.state) && (
                <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  📍 {user.city ? `${user.city}, ` : ''}{user.state} {user?.pincode ? `(${user.pincode})` : ''}
                </span>
              )}
              <span className="inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase tracking-wide">
                🏍️ {user?.role || 'rider'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">My Groups</h3>
          <div className="flex gap-3">
            <button
              onClick={() => setActivePanel(activePanel === 'create' ? null : 'create')}
              className="text-sm font-medium bg-slate-900 text-white px-3 py-1.5 rounded-md hover:bg-slate-800"
            >
              Create Group
            </button>
            <button
              onClick={() => setActivePanel(activePanel === 'join' ? null : 'join')}
              className="text-sm font-medium border border-slate-300 text-slate-700 px-3 py-1.5 rounded-md hover:bg-slate-50"
            >
              Join Group
            </button>
          </div>
        </div>

        {activePanel === 'create' && (
          <div className="mb-4">
            <CreateGroupForm onCreated={loadGroups} onCancel={closePanel} />
          </div>
        )}
        {activePanel === 'join' && (
          <div className="mb-4">
            <JoinGroupForm onJoined={closePanel} onCancel={closePanel} />
          </div>
        )}

        {loadingGroups && <p className="text-sm text-slate-500">Loading groups...</p>}
        {groupsError && <p className="text-sm text-red-600">{groupsError}</p>}
        {!loadingGroups && !groupsError && groups.length === 0 && (
          <p className="text-sm text-slate-500">
            You're not in any groups yet. Create one or join with an invite code.
          </p>
        )}

        <div className="space-y-3">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </div>
      </div>

      {showEditProfile && (
        <EditProfileModal onClose={() => setShowEditProfile(false)} />
      )}
    </div>
  );
}

export default DashboardPage;
