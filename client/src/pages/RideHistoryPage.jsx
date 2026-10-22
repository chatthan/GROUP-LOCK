import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { getRideHistory, getRideEvents } from '../services/ride.service';
import { ApiError } from '../services/api';

function formatDuration(minutes) {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatEventTimestamp(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatElapsed(startIso, eventIso) {
  if (!startIso || !eventIso) return '';
  const start = new Date(startIso).getTime();
  const ev = new Date(eventIso).getTime();
  const diffMins = Math.max(0, Math.round((ev - start) / 60000));
  return `+${diffMins}m into ride`;
}

function getGradeStyles(grade) {
  switch (grade) {
    case 'A+':
      return {
        bg: 'bg-emerald-500',
        text: 'text-emerald-500',
        border: 'border-emerald-500',
        badge: 'bg-emerald-100 text-emerald-800 border-emerald-300',
        label: 'Exemplary Convoy Discipline',
      };
    case 'A':
      return {
        bg: 'bg-teal-500',
        text: 'text-teal-500',
        border: 'border-teal-500',
        badge: 'bg-teal-100 text-teal-800 border-teal-300',
        label: 'Safe & Well-Coordinated',
      };
    case 'B':
      return {
        bg: 'bg-blue-500',
        text: 'text-blue-500',
        border: 'border-blue-500',
        badge: 'bg-blue-100 text-blue-800 border-blue-300',
        label: 'Moderate (Minor Warnings)',
      };
    case 'C':
      return {
        bg: 'bg-amber-500',
        text: 'text-amber-500',
        border: 'border-amber-500',
        badge: 'bg-amber-100 text-amber-800 border-amber-300',
        label: 'Needs Formation Review',
      };
    case 'D':
      return {
        bg: 'bg-orange-500',
        text: 'text-orange-500',
        border: 'border-orange-500',
        badge: 'bg-orange-100 text-orange-800 border-orange-300',
        label: 'High Risk Infractions',
      };
    default:
      return {
        bg: 'bg-red-500',
        text: 'text-red-500',
        border: 'border-red-500',
        badge: 'bg-red-100 text-red-800 border-red-300',
        label: 'Critical Safety Violations',
      };
  }
}

function RideHistoryPage() {
  const { id: groupId } = useParams();
  const { token } = useAuth();

  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filter state for rides list
  const [safetyFilter, setSafetyFilter] = useState('ALL'); // 'ALL', 'EXEMPLARY', 'INCIDENTS'

  // Deep Analytics & Incident Log modal state
  const [activeLogRide, setActiveLogRide] = useState(null);
  const [modalTab, setModalTab] = useState('timeline'); // 'timeline', 'roster', 'audit'
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventError, setEventError] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [copiedReport, setCopiedReport] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getRideHistory(groupId, token);
      const list = data.history || data.rides || [];
      setRides(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load ride history.');
    } finally {
      setLoading(false);
    }
  }, [groupId, token]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function handleViewEvents(ride) {
    setActiveLogRide(ride);
    setModalTab('timeline');
    setCategoryFilter('ALL');
    setSeverityFilter('ALL');
    setEvents([]);
    setEventError('');
    setLoadingEvents(true);
    try {
      const res = await getRideEvents(ride.rideId || ride.id, token);
      setEvents(res.events || []);
    } catch (err) {
      setEventError(err instanceof ApiError ? err.message : 'Could not load incident log for this ride.');
    } finally {
      setLoadingEvents(false);
    }
  }

  // Summary statistics across all completed rides in this group
  const overallStats = useMemo(() => {
    if (!rides.length) return null;
    const totalDist = rides.reduce((acc, r) => acc + (r.distanceKm || 0), 0);
    const totalDuration = rides.reduce((acc, r) => acc + (r.durationMinutes || 0), 0);
    const avgSafety = Math.round(
      rides.reduce((acc, r) => acc + (typeof r.safetyScore === 'number' ? r.safetyScore : 100), 0) /
        rides.length
    );
    const cleanRides = rides.filter(
      (r) => (r.overspeedCount || 0) === 0 && (r.sosCount || 0) === 0 && (r.kickCount || 0) === 0
    ).length;

    return {
      totalRides: rides.length,
      totalDist: totalDist.toFixed(1),
      totalDuration,
      avgSafety,
      cleanRides,
      cleanPercent: Math.round((cleanRides / rides.length) * 100),
    };
  }, [rides]);

  // Filtered rides list
  const filteredRides = useMemo(() => {
    if (safetyFilter === 'EXEMPLARY') {
      return rides.filter((r) => (r.safetyScore || 100) >= 95);
    }
    if (safetyFilter === 'INCIDENTS') {
      return rides.filter(
        (r) =>
          (r.overspeedCount || 0) > 0 ||
          (r.reportCount || 0) > 0 ||
          (r.kickCount || 0) > 0 ||
          (r.sosCount || 0) > 0
      );
    }
    return rides;
  }, [rides, safetyFilter]);

  // Filtered incident events in modal
  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      // Category filter
      if (categoryFilter !== 'ALL') {
        if (categoryFilter === 'SPEEDING' && ev.type !== 'OVERSPEED' && ev.type !== 'SPEED_LIMIT_CHANGED') return false;
        if (categoryFilter === 'SOS' && ev.type !== 'SOS') return false;
        if (categoryFilter === 'REPORT' && ev.type !== 'REPORT') return false;
        if (categoryFilter === 'REGROUP' && ev.type !== 'REGROUP') return false;
        if (categoryFilter === 'ROLES' && ev.type !== 'SWEEP_ASSIGNED' && ev.type !== 'LEAD_ASSIGNED') return false;
        if (categoryFilter === 'DISCIPLINE' && ev.type !== 'MEMBER_REMOVED') return false;
      }
      // Severity filter
      if (severityFilter !== 'ALL' && ev.severity !== severityFilter) {
        return false;
      }
      return true;
    });
  }, [events, categoryFilter, severityFilter]);

  // Event category counts
  const eventCounts = useMemo(() => {
    const counts = {
      ALL: events.length,
      SPEEDING: 0,
      SOS: 0,
      REPORT: 0,
      REGROUP: 0,
      ROLES: 0,
      DISCIPLINE: 0,
    };
    events.forEach((ev) => {
      if (ev.type === 'OVERSPEED' || ev.type === 'SPEED_LIMIT_CHANGED') counts.SPEEDING++;
      if (ev.type === 'SOS') counts.SOS++;
      if (ev.type === 'REPORT') counts.REPORT++;
      if (ev.type === 'REGROUP') counts.REGROUP++;
      if (ev.type === 'SWEEP_ASSIGNED' || ev.type === 'LEAD_ASSIGNED') counts.ROLES++;
      if (ev.type === 'MEMBER_REMOVED') counts.DISCIPLINE++;
    });
    return counts;
  }, [events]);

  function getEventIcon(type) {
    switch (type) {
      case 'OVERSPEED': return '⚡';
      case 'REPORT': return '📢';
      case 'MEMBER_REMOVED': return '🚫';
      case 'SOS': return '🚨';
      case 'REGROUP': return '🔄';
      case 'SWEEP_ASSIGNED': return '🛡️';
      case 'LEAD_ASSIGNED': return '👑';
      case 'SPEED_LIMIT_CHANGED': return '🛣️';
      case 'SEPARATION': return '📍';
      case 'CONNECTIVITY': return '📡';
      default: return 'ℹ️';
    }
  }

  function getEventBadgeColor(type) {
    switch (type) {
      case 'OVERSPEED': return 'bg-amber-100 text-amber-900 border-amber-300';
      case 'REPORT': return 'bg-rose-100 text-rose-900 border-rose-300';
      case 'MEMBER_REMOVED': return 'bg-red-900 text-white border-red-950 font-bold';
      case 'SOS': return 'bg-red-600 text-white border-red-700 animate-pulse font-bold';
      case 'REGROUP': return 'bg-blue-100 text-blue-900 border-blue-300';
      case 'SWEEP_ASSIGNED': return 'bg-violet-100 text-violet-900 border-violet-300';
      case 'LEAD_ASSIGNED': return 'bg-yellow-100 text-yellow-900 border-yellow-300';
      case 'SPEED_LIMIT_CHANGED': return 'bg-emerald-100 text-emerald-900 border-emerald-300';
      default: return 'bg-slate-100 text-slate-800 border-slate-300';
    }
  }

  function handleCopyMarkdownReport() {
    if (!activeLogRide) return;
    const r = activeLogRide;
    const grade = r.safetyGrade || 'A+';
    const score = r.safetyScore ?? 100;

    let text = `🏍️ GROUPLOCK POST-RIDE SAFETY SUMMARY & AUDIT\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `Ride: ${r.title}\n`;
    text += `Route: ${r.startLocation || 'Start'} ➔ ${r.destination || 'Destination'}\n`;
    text += `Distance: ${r.distanceKm || 0} km | Duration: ${formatDuration(r.durationMinutes)}\n`;
    text += `Avg Speed: ${r.avgSpeed || 0} km/h | Max Speed: ${r.maxSpeed || 0} km/h\n`;
    text += `Convoy Safety Score: ${score}/100 [Grade: ${grade}]\n\n`;

    text += `Convoy Formation:\n`;
    text += `👑 Lead Rider: ${r.leadRider?.name || 'Assigned Lead'}\n`;
    text += `🛡️ Tail (Sweep) Rider: ${r.sweepRider?.name || 'Assigned Sweep'}\n`;
    text += `Total Riders: ${r.memberCount || r.participants?.length || 0}\n\n`;

    text += `Safety & Incident Statistics:\n`;
    text += `• Overspeed Violations: ${r.overspeedCount || 0}\n`;
    text += `• Rider Reports: ${r.reportCount || 0}\n`;
    text += `• Removed (Kicked) Riders: ${r.kickCount || 0}\n`;
    text += `• Emergency SOS Calls: ${r.sosCount || 0}\n`;
    text += `• Regroups Completed: ${r.regroupCount || 0}\n`;
    text += `• Convoy Separations (>2km): ${r.separationCount || 0}\n\n`;

    if (r.summaryHighlights?.length) {
      text += `Highlights:\n`;
      r.summaryHighlights.forEach((h) => {
        text += `• ${h}\n`;
      });
      text += `\n`;
    }

    if (r.riderStats?.length) {
      text += `Per-Rider Performance & Safety:\n`;
      r.riderStats.forEach((rs) => {
        text += `• ${rs.name}: ${rs.safetyScore}/100 | Max Speed: ${rs.maxSpeed} km/h | Speed Violations: ${rs.overspeedCount}\n`;
      });
    }

    text += `\nGenerated via GroupLock Stage 9 Advanced Post-Ride Analytics`;

    navigator.clipboard.writeText(text);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2500);
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Top Banner and Navigation */}
      <div className="bg-white shadow-sm border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-3">
          <Link
            to={`/groups/${groupId}`}
            className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            ← Back to Group Dashboard
          </Link>
          <span className="text-[10px] uppercase font-bold tracking-wider bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full border border-blue-200">
            Stage 9: Safety Analytics
          </span>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-2">
              <span>📊</span>
              <span>Post-Ride Analytics & Incident Summary</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Automated safety scoring, formation discipline audit, per-rider telemetry, and interactive incident logs.
            </p>
          </div>
        </div>

        {/* Group-Wide Aggregate Telemetry Cards */}
        {overallStats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-5 border-t border-slate-100">
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-slate-400 text-[10px] font-bold uppercase block tracking-wider">
                Total Distance
              </span>
              <span className="text-lg font-black text-emerald-700">{overallStats.totalDist} km</span>
              <span className="text-[10px] text-slate-500 block mt-0.5">Across {overallStats.totalRides} rides</span>
            </div>

            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-slate-400 text-[10px] font-bold uppercase block tracking-wider">
                Total Moving Time
              </span>
              <span className="text-lg font-black text-blue-700">
                {formatDuration(overallStats.totalDuration)}
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">In convoy formation</span>
            </div>

            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-slate-400 text-[10px] font-bold uppercase block tracking-wider">
                Avg Safety Score
              </span>
              <span className="text-lg font-black text-purple-700">
                {overallStats.avgSafety} / 100
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">Convoy rating</span>
            </div>

            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-slate-400 text-[10px] font-bold uppercase block tracking-wider">
                Clean Rides
              </span>
              <span className="text-lg font-black text-teal-700">
                {overallStats.cleanPercent}%
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">{overallStats.cleanRides} zero-incident runs</span>
            </div>
          </div>
        )}
      </div>

      {/* Main List Section */}
      <div className="bg-white shadow-sm border border-slate-200 rounded-2xl p-6 space-y-4">
        {/* Filter Pills */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            Completed Convoy Runs ({filteredRides.length})
          </h3>

          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl text-xs self-start">
            <button
              onClick={() => setSafetyFilter('ALL')}
              className={`px-3 py-1 rounded-lg font-bold transition ${
                safetyFilter === 'ALL' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              All Rides
            </button>
            <button
              onClick={() => setSafetyFilter('EXEMPLARY')}
              className={`px-3 py-1 rounded-lg font-bold transition flex items-center gap-1 ${
                safetyFilter === 'EXEMPLARY' ? 'bg-emerald-600 text-white shadow' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>🌟</span>
              <span>A+ Clean</span>
            </button>
            <button
              onClick={() => setSafetyFilter('INCIDENTS')}
              className={`px-3 py-1 rounded-lg font-bold transition flex items-center gap-1 ${
                safetyFilter === 'INCIDENTS' ? 'bg-amber-600 text-white shadow' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>⚠️</span>
              <span>With Alerts</span>
            </button>
          </div>
        </div>

        {loading && (
          <div className="py-12 text-center text-xs text-slate-400 space-y-2">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p>Loading convoy telemetry & safety archives...</p>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-4">
            {error}
          </div>
        )}

        {!loading && !error && filteredRides.length === 0 && (
          <div className="py-16 text-center">
            <span className="text-5xl mb-3 block">🏍️</span>
            <p className="text-base font-bold text-slate-700">No completed rides match this filter</p>
            <p className="text-xs text-slate-400 mt-1">Once a scheduled ride is started and ended, its Stage 9 safety breakdown will appear here.</p>
          </div>
        )}

        {/* Rides List */}
        {!loading && filteredRides.length > 0 && (
          <div className="space-y-4">
            {filteredRides.map((ride) => {
              const score = typeof ride.safetyScore === 'number' ? ride.safetyScore : 100;
              const grade = ride.safetyGrade || 'A+';
              const styles = getGradeStyles(grade);

              return (
                <div
                  key={ride.id || ride._id}
                  className="border border-slate-200 rounded-2xl p-5 bg-white hover:border-slate-300 hover:shadow-md transition space-y-4"
                >
                  {/* Card Header with Safety Score Gauge */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-lg font-black text-slate-900 tracking-tight">
                          {ride.title}
                        </h4>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                          🛣️ {ride.roadCondition || 'Highway'} ({ride.speedLimit || 80} km/h max)
                        </span>
                      </div>
                      {(ride.startLocation || ride.destination) && (
                        <p className="text-xs font-semibold text-slate-600 mt-0.5 flex items-center gap-1.5">
                          <span>📍 {ride.startLocation || 'Start'}</span>
                          <span>➔</span>
                          <span>🏁 {ride.destination || 'Destination'}</span>
                        </p>
                      )}
                    </div>

                    {/* Safety Score Pill Badge */}
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <span className="text-[10px] font-extrabold uppercase text-slate-400 block tracking-wider">
                          Convoy Safety Score
                        </span>
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className={`text-xl font-black ${styles.text}`}>
                            {score}/100
                          </span>
                          <span className={`text-xs font-black px-2 py-0.5 rounded-full border ${styles.badge}`}>
                            {grade}
                          </span>
                        </div>
                      </div>
                      <div className={`w-12 h-12 rounded-2xl ${styles.bg} text-white flex items-center justify-center font-black text-base shadow-md`}>
                        {grade}
                      </div>
                    </div>
                  </div>

                  {/* Primary Ride Metrics Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">
                        Distance
                      </span>
                      <span className="text-base font-extrabold text-emerald-700">
                        {ride.distanceKm ? `${ride.distanceKm} km` : '—'}
                      </span>
                    </div>

                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">
                        Duration
                      </span>
                      <span className="text-base font-extrabold text-blue-700">
                        {formatDuration(ride.durationMinutes)}
                      </span>
                    </div>

                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">
                        Avg / Peak Speed
                      </span>
                      <span className="text-base font-extrabold text-amber-700">
                        {ride.avgSpeed || 0} / {ride.maxSpeed || 0} km/h
                      </span>
                    </div>

                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">
                        Riders in Convoy
                      </span>
                      <span className="text-base font-extrabold text-purple-700">
                        {ride.memberCount || ride.participants?.length || 0} Riders
                      </span>
                    </div>
                  </div>

                  {/* Convoy Formation (Head / Tail) Chips */}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      Convoy Roles:
                    </span>
                    <span className="bg-yellow-50 text-yellow-900 border border-yellow-300 px-2.5 py-0.5 rounded-full font-bold text-[11px] flex items-center gap-1">
                      <span>👑 Head (Lead):</span>
                      <span>{ride.leadRider?.name || 'Assigned Lead'}</span>
                    </span>
                    <span className="bg-violet-50 text-violet-900 border border-violet-300 px-2.5 py-0.5 rounded-full font-bold text-[11px] flex items-center gap-1">
                      <span>🛡️ Tail (Sweep):</span>
                      <span>{ride.sweepRider?.name || 'Assigned Sweep'}</span>
                    </span>
                  </div>

                  {/* Safety & Discipline Counters */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {ride.overspeedCount > 0 ? (
                        <span className="bg-amber-100 text-amber-900 border border-amber-300 px-2.5 py-0.5 rounded-full font-bold text-[11px] flex items-center gap-1">
                          <span>⚠️</span> {ride.overspeedCount} Speeding
                        </span>
                      ) : (
                        <span className="bg-emerald-50 text-emerald-800 border border-emerald-200 px-2.5 py-0.5 rounded-full font-medium text-[11px]">
                          ✅ 0 Speed Violations
                        </span>
                      )}

                      {ride.reportCount > 0 && (
                        <span className="bg-rose-100 text-rose-800 border border-rose-300 px-2.5 py-0.5 rounded-full font-bold text-[11px] flex items-center gap-1">
                          <span>📢</span> {ride.reportCount} Reports
                        </span>
                      )}

                      {ride.kickCount > 0 && (
                        <span className="bg-red-800 text-white px-2.5 py-0.5 rounded-full font-bold text-[11px] flex items-center gap-1">
                          <span>🚫</span> {ride.kickCount} Removed
                        </span>
                      )}

                      {ride.sosCount > 0 && (
                        <span className="bg-red-600 text-white px-2.5 py-0.5 rounded-full font-bold text-[11px] flex items-center gap-1 animate-pulse">
                          <span>🚨</span> {ride.sosCount} SOS
                        </span>
                      )}

                      {ride.regroupCount > 0 && (
                        <span className="bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-0.5 rounded-full font-medium text-[11px]">
                          🔄 {ride.regroupCount} Regroups
                        </span>
                      )}
                    </div>

                    {/* Launch Deep Analytics Modal */}
                    <button
                      onClick={() => handleViewEvents(ride)}
                      className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold px-3.5 py-1.5 rounded-xl transition flex items-center gap-1.5 shadow-sm active:scale-95 cursor-pointer"
                    >
                      <span>📊</span>
                      <span>Deep Analytics & Incident Log</span>
                      <span>➔</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* STAGE 9: DEEP ANALYTICS & INCIDENT SUMMARY MODAL                         */}
      {/* ========================================================================= */}
      {activeLogRide && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
          <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-slate-700">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 bg-slate-950 text-white flex items-start justify-between border-b border-slate-800 shrink-0">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xl">📊</span>
                  <h3 className="font-extrabold text-base sm:text-lg tracking-tight truncate">
                    Stage 9: Convoy Analytics & Incident Summary
                  </h3>
                </div>
                <p className="text-xs text-slate-300 font-medium truncate">
                  {activeLogRide.title} • {activeLogRide.startLocation || 'Start'} ➔ {activeLogRide.destination || 'End'}
                </p>
                <div className="flex items-center gap-2 pt-1 text-[11px] text-slate-400">
                  <span>🛣️ {activeLogRide.roadCondition || 'Highway'} ({activeLogRide.speedLimit || 80} km/h)</span>
                  <span>•</span>
                  <span>⏱️ {formatDuration(activeLogRide.durationMinutes)}</span>
                  <span>•</span>
                  <span>📏 {activeLogRide.distanceKm || 0} km</span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleCopyMarkdownReport}
                  className="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-3 py-1.5 rounded-xl border border-white/15 transition flex items-center gap-1.5"
                  title="Copy formatted markdown report to clipboard"
                >
                  <span>{copiedReport ? '✅' : '📋'}</span>
                  <span>{copiedReport ? 'Copied!' : 'Copy Summary'}</span>
                </button>
                <button
                  onClick={() => setActiveLogRide(null)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-sm font-bold transition"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal Sub-Header Tabs */}
            <div className="bg-slate-900 border-b border-slate-800 px-4 pt-2 flex items-center gap-2 shrink-0 overflow-x-auto text-xs">
              <button
                onClick={() => setModalTab('timeline')}
                className={`px-4 py-2 font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 ${
                  modalTab === 'timeline'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                <span>📋</span>
                <span>Incident Timeline ({events.length})</span>
              </button>

              <button
                onClick={() => setModalTab('roster')}
                className={`px-4 py-2 font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 ${
                  modalTab === 'roster'
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                <span>👥</span>
                <span>Rider Roster & Discipline</span>
              </button>

              <button
                onClick={() => setModalTab('audit')}
                className={`px-4 py-2 font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 ${
                  modalTab === 'audit'
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                <span>🛡️</span>
                <span>Safety Score Audit ({activeLogRide.safetyScore ?? 100}/100)</span>
              </button>
            </div>

            {/* Modal Content Scroll Area */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
              {/* ========================================================= */}
              {/* TAB 1: INCIDENT TIMELINE                                  */}
              {/* ========================================================= */}
              {modalTab === 'timeline' && (
                <div className="space-y-4">
                  {/* Category Filter Chips */}
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs scrollbar-thin">
                    <button
                      onClick={() => setCategoryFilter('ALL')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition ${
                        categoryFilter === 'ALL'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      All ({eventCounts.ALL})
                    </button>
                    <button
                      onClick={() => setCategoryFilter('SPEEDING')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition flex items-center gap-1 ${
                        categoryFilter === 'SPEEDING'
                          ? 'bg-amber-600 text-white'
                          : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      <span>⚡</span>
                      <span>Speeding ({eventCounts.SPEEDING})</span>
                    </button>
                    <button
                      onClick={() => setCategoryFilter('SOS')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition flex items-center gap-1 ${
                        categoryFilter === 'SOS'
                          ? 'bg-red-600 text-white'
                          : 'bg-red-50 text-red-800 border border-red-200 hover:bg-red-100'
                      }`}
                    >
                      <span>🚨</span>
                      <span>SOS ({eventCounts.SOS})</span>
                    </button>
                    <button
                      onClick={() => setCategoryFilter('REPORT')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition flex items-center gap-1 ${
                        categoryFilter === 'REPORT'
                          ? 'bg-rose-600 text-white'
                          : 'bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100'
                      }`}
                    >
                      <span>📢</span>
                      <span>Reports ({eventCounts.REPORT})</span>
                    </button>
                    <button
                      onClick={() => setCategoryFilter('REGROUP')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition flex items-center gap-1 ${
                        categoryFilter === 'REGROUP'
                          ? 'bg-blue-600 text-white'
                          : 'bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100'
                      }`}
                    >
                      <span>🔄</span>
                      <span>Regroups ({eventCounts.REGROUP})</span>
                    </button>
                    <button
                      onClick={() => setCategoryFilter('ROLES')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition flex items-center gap-1 ${
                        categoryFilter === 'ROLES'
                          ? 'bg-violet-600 text-white'
                          : 'bg-violet-50 text-violet-800 border border-violet-200 hover:bg-violet-100'
                      }`}
                    >
                      <span>🛡️</span>
                      <span>Roles ({eventCounts.ROLES})</span>
                    </button>
                    <button
                      onClick={() => setCategoryFilter('DISCIPLINE')}
                      className={`px-2.5 py-1 rounded-lg font-bold shrink-0 transition flex items-center gap-1 ${
                        categoryFilter === 'DISCIPLINE'
                          ? 'bg-red-900 text-white'
                          : 'bg-red-50 text-red-900 border border-red-300 hover:bg-red-100'
                      }`}
                    >
                      <span>🚫</span>
                      <span>Kicks ({eventCounts.DISCIPLINE})</span>
                    </button>
                  </div>

                  {loadingEvents && (
                    <div className="py-12 text-center text-xs text-slate-500 space-y-2">
                      <div className="w-7 h-7 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
                      <p>Loading chronological safety incidents...</p>
                    </div>
                  )}

                  {eventError && (
                    <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl">
                      {eventError}
                    </div>
                  )}

                  {!loadingEvents && !eventError && filteredEvents.length === 0 && (
                    <div className="py-12 text-center text-xs text-slate-500">
                      <span className="text-4xl block mb-2">🎉</span>
                      <p className="font-bold text-slate-800 text-sm">No incidents in this category!</p>
                      <p className="text-slate-400 mt-1">The convoy operated cleanly with no logged events matching this filter.</p>
                    </div>
                  )}

                  {/* Vertical Timeline */}
                  {!loadingEvents && filteredEvents.length > 0 && (
                    <div className="relative pl-6 sm:pl-8 border-l-2 border-slate-200 space-y-4 my-2">
                      {filteredEvents.map((ev) => {
                        const elapsed = formatElapsed(activeLogRide.startedAt || activeLogRide.createdAt, ev.createdAt);
                        return (
                          <div key={ev.id} className="relative">
                            {/* Dot on timeline */}
                            <span className="absolute -left-[33px] sm:-left-[41px] top-1.5 w-6 h-6 rounded-full bg-white border-2 border-slate-400 flex items-center justify-center text-xs shadow-xs">
                              {getEventIcon(ev.type)}
                            </span>

                            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5 shadow-2xs">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5">
                                  <span className={`px-2.5 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${getEventBadgeColor(ev.type)}`}>
                                    {ev.type.replace(/_/g, ' ')}
                                  </span>
                                  {ev.severity && ev.severity !== 'INFO' && (
                                    <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase ${
                                      ev.severity === 'CRITICAL' ? 'bg-red-600 text-white' : 'bg-amber-500 text-slate-950'
                                    }`}>
                                      {ev.severity}
                                    </span>
                                  )}
                                </div>

                                <div className="flex items-center gap-2 text-slate-400 text-[11px] font-mono">
                                  {elapsed && <span className="bg-slate-200 text-slate-700 font-semibold px-2 py-0.5 rounded">{elapsed}</span>}
                                  <span>{formatEventTimestamp(ev.createdAt)}</span>
                                </div>
                              </div>

                              {/* Event Details based on Type */}
                              {ev.type === 'OVERSPEED' && (
                                <div className="text-slate-800 pt-1">
                                  <span className="font-bold text-amber-950">{ev.metadata?.userName || ev.user?.name || 'Rider'}</span> exceeded limit:
                                  <span className="font-black text-red-600 ml-1 text-sm">{ev.metadata?.speed} km/h</span>
                                  <span className="text-slate-500 text-[11px] ml-1.5">
                                    (Limit: {ev.metadata?.speedLimit} km/h, +{ev.metadata?.excess} km/h on {ev.metadata?.roadCondition || 'Highway'})
                                  </span>
                                </div>
                              )}

                              {ev.type === 'REPORT' && (
                                <div className="text-slate-800 pt-1 space-y-0.5">
                                  <div>
                                    <span className="font-bold text-rose-950">{ev.metadata?.reportedUserName || 'Rider'}</span> was reported by{' '}
                                    <span className="font-semibold text-slate-700">{ev.metadata?.reportedByName || 'fellow rider'}</span>
                                  </div>
                                  <div className="font-bold text-red-700 text-xs">
                                    Reason: {ev.metadata?.reason}
                                  </div>
                                  {ev.metadata?.details && (
                                    <p className="text-[11px] text-slate-600 italic bg-white p-2 rounded border border-slate-200 mt-1">
                                      &ldquo;{ev.metadata.details}&rdquo;
                                    </p>
                                  )}
                                </div>
                              )}

                              {ev.type === 'MEMBER_REMOVED' && (
                                <div className="text-slate-800 pt-1">
                                  <span className="font-black text-red-700">{ev.user?.name || 'Rider'}</span> was removed from the convoy by the leader.
                                  <div className="text-slate-700 text-[11px] mt-0.5">
                                    Removal reason: <strong>&ldquo;{ev.metadata?.reason}&rdquo;</strong>
                                  </div>
                                </div>
                              )}

                              {ev.type === 'SOS' && (
                                <div className="text-red-700 font-bold pt-1">
                                  🚨 Emergency SOS Triggered by {ev.user?.name || 'Rider'}!
                                  {ev.metadata?.note && (
                                    <p className="text-xs font-normal text-slate-700 mt-0.5 italic">&ldquo;{ev.metadata.note}&rdquo;</p>
                                  )}
                                </div>
                              )}

                              {ev.type === 'REGROUP' && (
                                <div className="text-blue-900 pt-1">
                                  Convoy regroup called: <strong className="font-bold">{ev.metadata?.haltName || ev.metadata?.reason || 'Convoy Regroup'}</strong>
                                </div>
                              )}

                              {ev.type === 'SWEEP_ASSIGNED' && (
                                <div className="text-violet-900 pt-1">
                                  Convoy Tail (Sweep) Rider assigned: <strong className="font-bold">{ev.metadata?.sweepRiderName || 'Rider'}</strong>
                                </div>
                              )}

                              {ev.type === 'LEAD_ASSIGNED' && (
                                <div className="text-yellow-900 pt-1">
                                  Convoy Head (Lead) Rider appointed: <strong className="font-bold">{ev.metadata?.leadRiderName || 'Rider'}</strong>
                                </div>
                              )}

                              {ev.type === 'SPEED_LIMIT_CHANGED' && (
                                <div className="text-emerald-900 pt-1">
                                  Speed limit adjusted to <span className="font-bold text-emerald-800">{ev.metadata?.speedLimit} km/h</span> for <strong>{ev.metadata?.roadCondition}</strong> conditions.
                                </div>
                              )}

                              {ev.type === 'SEPARATION' && (
                                <div className="text-slate-800 pt-1">
                                  Convoy spread exceeded safe threshold: maximum gap of <strong>{ev.metadata?.spreadKm || '2+'} km</strong> between lead and tail.
                                </div>
                              )}

                              {ev.type === 'RIDE_STATUS' && (
                                <div className="text-slate-700 pt-1">
                                  Convoy completed: <strong>{ev.metadata?.distanceKm || 0} km</strong> in <strong>{ev.metadata?.durationMinutes || 0} mins</strong>.
                                </div>
                              )}

                              {/* GPS Coordinates pill if present */}
                              {ev.location && ev.location.lat && ev.location.lng && (
                                <div className="pt-1 text-[10px] text-slate-500 font-mono flex items-center gap-1.5">
                                  <span>📍 Location: {ev.location.lat.toFixed(5)}, {ev.location.lng.toFixed(5)}</span>
                                  <a
                                    href={`https://maps.google.com/?q=${ev.location.lat},${ev.location.lng}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-600 hover:underline font-sans font-bold"
                                  >
                                    View on Map ↗
                                  </a>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ========================================================= */}
              {/* TAB 2: PER-RIDER ROSTER & TELEMETRY BREAKDOWN             */}
              {/* ========================================================= */}
              {modalTab === 'roster' && (
                <div className="space-y-4">
                  <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 text-xs text-purple-900 flex items-center gap-2">
                    <span className="text-lg">🛡️</span>
                    <span>
                      Individual rider performance metrics, recorded top speeds, and safety scores during this convoy.
                    </span>
                  </div>

                  {(!activeLogRide.riderStats || activeLogRide.riderStats.length === 0) ? (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-500 italic text-center py-4">
                        Displaying registered participants for this run:
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {(activeLogRide.participants || []).map((p, idx) => (
                          <div
                            key={p._id || idx}
                            className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-slate-800 text-white flex items-center justify-center font-bold text-xs">
                                {(p.name || 'R')[0].toUpperCase()}
                              </div>
                              <div>
                                <h5 className="font-bold text-slate-900">{p.name || 'Rider'}</h5>
                                <span className="text-[10px] text-slate-400">{p.phone || p.email || 'Convoy Member'}</span>
                              </div>
                            </div>
                            <span className="bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded font-bold text-[10px]">
                              100/100 Clean
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {activeLogRide.riderStats.map((rs, idx) => {
                        const rScore = rs.safetyScore ?? 100;
                        const rStyles = rScore >= 90 ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : rScore >= 75 ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-red-100 text-red-800 border-red-300';

                        return (
                          <div
                            key={rs.user || idx}
                            className="bg-slate-50 border border-slate-200 rounded-2xl p-3.5 space-y-2 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <div className="w-9 h-9 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-sm">
                                  {rs.profilePic ? (
                                    <img src={rs.profilePic} alt={rs.name} className="w-full h-full rounded-full object-cover" />
                                  ) : (
                                    (rs.name || 'R')[0].toUpperCase()
                                  )}
                                </div>
                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-bold text-slate-900">{rs.name}</span>
                                    {rs.isLead && (
                                      <span className="bg-yellow-100 text-yellow-900 text-[10px] font-extrabold px-1.5 py-0.2 rounded border border-yellow-300">
                                        👑 Head
                                      </span>
                                    )}
                                    {rs.isSweep && (
                                      <span className="bg-violet-100 text-violet-900 text-[10px] font-extrabold px-1.5 py-0.2 rounded border border-violet-300">
                                        🛡️ Tail
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-[10px] text-slate-400 block">{rs.isKicked ? '🚫 Removed from convoy' : 'Active participant'}</span>
                                </div>
                              </div>

                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border ${rStyles}`}>
                                {rScore}/100
                              </span>
                            </div>

                            <div className="grid grid-cols-3 gap-1 pt-1 border-t border-slate-200 text-center text-[11px]">
                              <div className="bg-white p-1.5 rounded-lg border border-slate-100">
                                <span className="text-[9px] text-slate-400 block font-bold">TOP SPEED</span>
                                <span className="font-black text-slate-800">{rs.maxSpeed || 0} km/h</span>
                              </div>
                              <div className="bg-white p-1.5 rounded-lg border border-slate-100">
                                <span className="text-[9px] text-slate-400 block font-bold">OVERSPEED</span>
                                <span className={`font-black ${rs.overspeedCount > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                                  {rs.overspeedCount || 0}
                                </span>
                              </div>
                              <div className="bg-white p-1.5 rounded-lg border border-slate-100">
                                <span className="text-[9px] text-slate-400 block font-bold">REPORTS</span>
                                <span className={`font-black ${rs.reportCount > 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                                  {rs.reportCount || 0}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ========================================================= */}
              {/* TAB 3: SAFETY SCORE & DISCIPLINE AUDIT                    */}
              {/* ========================================================= */}
              {modalTab === 'audit' && (
                <div className="space-y-4">
                  {/* Gauge Card */}
                  <div className="bg-slate-900 text-white rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                    <div className="space-y-1 text-center sm:text-left">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">
                        Final Convoy Safety Grade
                      </span>
                      <h4 className="text-2xl sm:text-3xl font-black text-white flex items-center justify-center sm:justify-start gap-2">
                        <span>{activeLogRide.safetyScore ?? 100} / 100</span>
                        <span className="text-emerald-400">[{activeLogRide.safetyGrade || 'A+'}]</span>
                      </h4>
                      <p className="text-xs text-slate-300">
                        {getGradeStyles(activeLogRide.safetyGrade || 'A+').label}
                      </p>
                    </div>

                    <div className="bg-white/10 p-3.5 rounded-xl border border-white/10 text-xs space-y-1 min-w-[200px]">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Base Score:</span>
                        <span className="font-bold text-emerald-400">100 pts</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Speed Violations:</span>
                        <span className="font-bold text-amber-400">-{Math.min(30, (activeLogRide.overspeedCount || 0) * 4)} pts</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Rider Reports:</span>
                        <span className="font-bold text-rose-400">-{Math.min(24, (activeLogRide.reportCount || 0) * 8)} pts</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Kicked Members:</span>
                        <span className="font-bold text-red-400">-{Math.min(30, (activeLogRide.kickCount || 0) * 15)} pts</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Separations:</span>
                        <span className="font-bold text-blue-400">-{Math.min(15, (activeLogRide.separationCount || 0) * 3)} pts</span>
                      </div>
                    </div>
                  </div>

                  {/* Highlights Card */}
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2 text-xs">
                    <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                      <span>✨</span>
                      <span>Run Highlights & Formation Assessment</span>
                    </h5>
                    <ul className="space-y-1.5 text-slate-700">
                      {(activeLogRide.summaryHighlights || [
                        activeLogRide.overspeedCount > 0
                          ? `⚠️ ${activeLogRide.overspeedCount} speed violation(s) observed during ride.`
                          : '✅ Zero speed violations recorded.',
                        activeLogRide.sosCount > 0
                          ? `🚨 ${activeLogRide.sosCount} Emergency SOS call(s) were managed.`
                          : '🛡️ Safe ride with zero emergency SOS triggers.',
                        activeLogRide.regroupCount > 0
                          ? `🔄 ${activeLogRide.regroupCount} regroup(s) coordinated.`
                          : '🔄 Continuous convoy pacing maintained.',
                      ]).map((hl, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-blue-500 font-bold">•</span>
                          <span>{hl}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Formation Discipline Audit */}
                  <div className="border border-slate-200 rounded-2xl p-4 text-xs space-y-3">
                    <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px]">
                      Formation & Role Audit
                    </h5>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-3 bg-yellow-50/60 border border-yellow-200 rounded-xl">
                        <span className="text-[10px] font-bold text-yellow-900 uppercase block">👑 Head / Lead Position</span>
                        <p className="font-bold text-slate-900 text-sm mt-0.5">{activeLogRide.leadRider?.name || 'Assigned Lead Rider'}</p>
                        <p className="text-[11px] text-slate-600 mt-1">Responsible for route navigation and adhering to the {activeLogRide.speedLimit || 80} km/h speed limit on {activeLogRide.roadCondition || 'Highway'}.</p>
                      </div>

                      <div className="p-3 bg-violet-50/60 border border-violet-200 rounded-xl">
                        <span className="text-[10px] font-bold text-violet-900 uppercase block">🛡️ Tail / Sweep Position</span>
                        <p className="font-bold text-slate-900 text-sm mt-0.5">{activeLogRide.sweepRider?.name || 'Assigned Sweep Rider'}</p>
                        <p className="text-[11px] text-slate-600 mt-1">Monitored stragglers and maintained rearguard formation. Total separations flagged: {activeLogRide.separationCount || 0}.</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs shrink-0">
              <span className="text-slate-400 font-mono text-[11px]">
                Ride ID: {(activeLogRide.rideId || activeLogRide.id || '').toString().slice(-8)}
              </span>
              <button
                onClick={() => setActiveLogRide(null)}
                className="font-bold px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl transition cursor-pointer"
              >
                Close Summary
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RideHistoryPage;
