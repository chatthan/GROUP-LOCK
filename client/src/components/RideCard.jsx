import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { joinRide, startRide, endRide, shareRiderLocation, geocodePlace, cancelRide, assignConvoyRoles } from '../services/ride.service';
import { ApiError } from '../services/api';
import { getSmartLocation, isSecureOrigin, getHttpsUrl } from '../services/location.service';
import RouteMapPreview from './RouteMapPreview.jsx';
import PlaceAutocompleteInput from './PlaceAutocompleteInput.jsx';

function RideCard({ ride, currentUserId, userRole, onRefresh }) {
  const { user, token } = useAuth();
  const [loadingAction, setLoadingAction] = useState(false);
  const [actionError, setActionError] = useState('');

  // Default to showing the map preview for planned/scheduled rides
  const [showMapPreview, setShowMapPreview] = useState(ride.status === 'planned');

  // Rider locations for this scheduled ride
  const [riderLocations, setRiderLocations] = useState(ride.riderLocations || []);
  const [locating, setLocating] = useState(false);
  const [locationSuccess, setLocationSuccess] = useState('');
  const [locationError, setLocationError] = useState('');

  // Interactive Pin Placement on Map (for exact PC location setting)
  const [isPinningOnMap, setIsPinningOnMap] = useState(false);
  const [customPin, setCustomPin] = useState(null);
  const [searchPlaceText, setSearchPlaceText] = useState('');
  const [isSavingCustomPin, setIsSavingCustomPin] = useState(false);
  const [isCoarse, setIsCoarse] = useState(false);

  // Convoy Formation: Head (Lead) and Tail (Sweep) roles
  const [isUpdatingRoles, setIsUpdatingRoles] = useState(false);
  const [roleActionMsg, setRoleActionMsg] = useState('');
  const [roleActionError, setRoleActionError] = useState('');

  // Sync riderLocations when prop changes
  useEffect(() => {
    if (ride.riderLocations) {
      setRiderLocations(ride.riderLocations);
    }
  }, [ride.riderLocations]);

  const isCreator = (ride.creator?._id || ride.creator) === currentUserId;
  const isAdmin = userRole === 'admin';
  const canManage = isAdmin || isCreator;

  const isParticipant = (ride.participants || []).some(
    (p) => (p._id || p)?.toString() === currentUserId?.toString()
  );

  const mySharedLocation = riderLocations.find(
    (r) => (r.user?._id || r.user)?.toString() === currentUserId?.toString()
  );

  const leadUser = ride.leadRider || ride.creator;
  const sweepUser = ride.sweepRider;

  const leadUserId = (leadUser?._id || leadUser)?.toString();
  const sweepUserId = (sweepUser?._id || sweepUser)?.toString();

  const [showFormationPanel, setShowFormationPanel] = useState(false);

  async function handleAssignConvoyRoles(leadId, sweepId) {
    if (isUpdatingRoles) return;
    setIsUpdatingRoles(true);
    setRoleActionMsg('');
    setRoleActionError('');
    try {
      await assignConvoyRoles(
        ride.id,
        {
          leadRiderId: leadId !== undefined ? leadId : leadUserId,
          sweepRiderId: sweepId !== undefined ? sweepId : (sweepUserId || null),
        },
        token
      );
      setRoleActionMsg('Convoy formation roles updated successfully!');
      if (onRefresh) onRefresh();
    } catch (err) {
      setRoleActionError(err instanceof ApiError ? err.message : 'Could not update convoy roles.');
    } finally {
      setIsUpdatingRoles(false);
    }
  }

  // Request browser location permission and share with convoy (smart GPS + IP fallback)
  const handleShareLocation = useCallback(async () => {
    setLocationError('');
    setLocationSuccess('');
    setLocating(true);

    try {
      const loc = await getSmartLocation({ enableHighAccuracy: true, timeout: 8000 });
      const lat = loc.lat;
      const lng = loc.lng;
      const res = await shareRiderLocation(ride.id, { lat, lng }, token);

      if (res && res.riderLocations) {
        setRiderLocations(res.riderLocations);
      } else {
        setRiderLocations((prev) => {
          const copy = [...prev];
          const idx = copy.findIndex(
            (r) => (r.user?._id || r.user)?.toString() === currentUserId?.toString()
          );
          const entry = {
            user: {
              _id: user?.id,
              name: user?.name,
              phone: user?.phone,
              bloodGroup: user?.bloodGroup,
              profilePic: user?.profilePic,
              role: userRole,
            },
            lat,
            lng,
            updatedAt: new Date().toISOString(),
          };
          if (idx >= 0) copy[idx] = entry;
          else copy.push(entry);
          return copy;
        });
      }

      if (loc.isCoarse) {
        setIsCoarse(true);
        setLocationSuccess(
          `Location estimated from Wi-Fi/IP (±${loc.accuracy}m). Click "🎯 Adjust on Map" to set your exact spot!`
        );
      } else {
        setIsCoarse(false);
        setLocationSuccess(`GPS location shared on map! (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
      }
      setShowMapPreview(true);
      if (onRefresh) onRefresh();
    } catch (err) {
      setLocationError(err instanceof ApiError ? err.message : `Location error: ${err.message || 'Permission denied'}`);
    } finally {
      setLocating(false);
    }
  }, [currentUserId, onRefresh, ride.id, token, user, userRole]);

  // Save manual/custom pin placement
  async function handleSaveCustomPin() {
    if (!customPin || typeof customPin.lat !== 'number' || typeof customPin.lng !== 'number') {
      setLocationError('Please click anywhere on the map to place your pin first.');
      return;
    }
    setIsSavingCustomPin(true);
    setLocationError('');
    try {
      const res = await shareRiderLocation(ride.id, customPin, token);
      if (res && res.riderLocations) {
        setRiderLocations(res.riderLocations);
      } else {
        setRiderLocations((prev) => {
          const copy = [...prev];
          const idx = copy.findIndex(
            (r) => (r.user?._id || r.user)?.toString() === currentUserId?.toString()
          );
          const entry = {
            user: {
              _id: user?.id,
              name: user?.name,
              phone: user?.phone,
              bloodGroup: user?.bloodGroup,
              profilePic: user?.profilePic,
              role: userRole,
            },
            lat: customPin.lat,
            lng: customPin.lng,
            updatedAt: new Date().toISOString(),
          };
          if (idx >= 0) copy[idx] = entry;
          else copy.push(entry);
          return copy;
        });
      }
      setIsPinningOnMap(false);
      setIsCoarse(false);
      setLocationSuccess(`Exact location pinned and saved! (${customPin.lat.toFixed(4)}, ${customPin.lng.toFixed(4)})`);
      if (onRefresh) onRefresh();
    } catch (err) {
      setLocationError(err instanceof ApiError ? err.message : 'Failed to save location.');
    } finally {
      setIsSavingCustomPin(false);
    }
  }

  // Auto-request location for participant if not yet shared for planned ride
  useEffect(() => {
    if (ride.status === 'planned' && isParticipant && !mySharedLocation && 'geolocation' in navigator) {
      handleShareLocation();
    }
  }, [ride.status, isParticipant, mySharedLocation, handleShareLocation]);

  async function handleJoin() {
    if (loadingAction) return;
    setActionError('');
    setLoadingAction(true);
    try {
      await joinRide(ride.id, token);
      if (onRefresh) onRefresh();
      // Auto-share location on joining
      setTimeout(() => {
        handleShareLocation();
      }, 500);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not join ride.');
    } finally {
      setLoadingAction(false);
    }
  }

  // Participants sharing status calculation
  const totalParticipants = ride.participants?.length || 0;
  const sharedCount = (ride.participants || []).filter((p) => {
    const pId = (p._id || p.id || p)?.toString();
    return riderLocations.some(
      (r) => (r.user?._id || r.user)?.toString() === pId && typeof r.lat === 'number'
    );
  }).length;
  const allParticipantsShared = totalParticipants > 0 && sharedCount >= totalParticipants;

  async function handleStart() {
    if (loadingAction) return;

    // Enforce location sharing before starting the ride
    if (!allParticipantsShared) {
      const proceed = window.confirm(
        `⚠️ Location Sharing Incomplete:\nOnly ${sharedCount} of ${totalParticipants} participants have shared their current location on the map.\n\nAll participants must grant location permission and appear on the map before starting the ride.\n\nDo you want to proceed and start the ride anyway?`
      );
      if (!proceed) return;
    }

    setActionError('');
    setLoadingAction(true);
    try {
      await startRide(ride.id, token);
      if (onRefresh) onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not start ride.');
    } finally {
      setLoadingAction(false);
    }
  }

  async function handleEnd() {
    if (loadingAction) return;
    setActionError('');
    setLoadingAction(true);
    try {
      await endRide(ride.id, token);
      if (onRefresh) onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not end ride.');
    } finally {
      setLoadingAction(false);
    }
  }

  async function handleCancel() {
    if (loadingAction) return;
    const confirmed = window.confirm(
      `Cancel ride "${ride.title}"?\n\nThis cannot be undone. All participants will be notified.`
    );
    if (!confirmed) return;
    setActionError('');
    setLoadingAction(true);
    try {
      await cancelRide(ride.id, token);
      if (onRefresh) onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not cancel ride.');
    } finally {
      setLoadingAction(false);
    }
  }

  const statusColors = {
    planned: 'bg-blue-50 text-blue-700 border-blue-200',
    ongoing: 'bg-emerald-50 text-emerald-700 border-emerald-200 font-bold animate-pulse',
    completed: 'bg-slate-100 text-slate-600 border-slate-200',
    cancelled: 'bg-red-50 text-red-700 border-red-200',
  };

  const validRiderPins = riderLocations.filter(
    (r) => typeof r.lat === 'number' && typeof r.lng === 'number'
  );

  return (
    <div className="border border-slate-200 rounded-lg p-4 bg-white shadow-sm space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h4 className="text-base font-semibold text-slate-900">{ride.title}</h4>
          {(ride.startLocation || ride.destination) && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5">
              <span>{ride.startLocation || 'Anywhere'} → {ride.destination || 'Destination'}</span>
              {ride.distanceKm && (
                <span className="font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                  {ride.distanceKm} km
                </span>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200 px-2 py-0.5 rounded-full">
              <span>{ride.roadCondition === 'Highway' ? '🛣️' : ride.roadCondition === 'City' ? '🏙️' : ride.roadCondition === 'Ghats/Hills' ? '⛰️' : ride.roadCondition === 'Rain/Wet' ? '🌧️' : ride.roadCondition === 'Night' ? '🌙' : '⚙️'}</span>
              <span>{ride.roadCondition || 'Highway'}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full">
              <span>⚡</span>
              <span>{ride.speedLimit || 80} km/h max</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-yellow-50 text-yellow-800 border border-yellow-300 px-2 py-0.5 rounded-full">
              <span>👑 Head:</span>
              <span>{leadUser?.name || 'Leader'}</span>
            </span>
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
              sweepUser ? 'bg-violet-50 text-violet-700 border-violet-200' : 'bg-slate-100 text-slate-500 border-slate-200'
            }`}>
              <span>🛡️ Tail:</span>
              <span>{sweepUser ? sweepUser.name : 'Unassigned'}</span>
            </span>
          </div>
        </div>
        <span
          className={`text-xs px-2.5 py-0.5 rounded-full border uppercase tracking-wider ${
            statusColors[ride.status] || 'bg-slate-100 text-slate-600'
          }`}
        >
          {ride.status}
        </span>
      </div>

      {actionError && <p className="text-xs text-red-600">{actionError}</p>}

      {/* Before Starting Ride: Mandatory Location Sharing Status Banner */}
      {ride.status === 'planned' && (
        <div
          className={`rounded-lg p-2.5 text-xs flex flex-wrap items-center justify-between gap-2 border ${
            allParticipantsShared
              ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
              : 'bg-amber-50 border-amber-300 text-amber-900'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-base">{allParticipantsShared ? '✅' : '⚠️'}</span>
            <div>
              <p className="font-bold">
                {allParticipantsShared
                  ? `All ${totalParticipants} participants have shared their location!`
                  : `Location Sharing Required Before Start (${sharedCount}/${totalParticipants} Shared)`}
              </p>
              <p className="text-[11px] opacity-90">
                {allParticipantsShared
                  ? 'All riders are plotted on the map. Ready to start the convoy.'
                  : 'All participants must grant location permission and appear on the map before starting.'}
              </p>
            </div>
          </div>

          {!mySharedLocation && isParticipant && (
            <button
              onClick={handleShareLocation}
              disabled={locating}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3 py-1 rounded shadow transition"
            >
              {locating ? 'Acquiring...' : '📍 Share My Location'}
            </button>
          )}
        </div>
      )}

      {/* Control Bar: Creator, Rider count & Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 border-t border-slate-100 pt-2">
        <div className="flex items-center gap-2">
          <span>Organized by: <strong>{ride.creator?.name || 'Admin'}</strong></span>
          <span>·</span>
          <span>{ride.participants?.length || 0} Riders</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Toggle Map Preview */}
          <button
            onClick={() => setShowMapPreview(!showMapPreview)}
            className={`px-2.5 py-1 text-xs font-semibold rounded border transition flex items-center gap-1.5 ${
              showMapPreview
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-300'
            }`}
          >
            <span>🗺️</span>
            <span>{showMapPreview ? 'Hide Map' : 'Map Preview'}</span>
            {validRiderPins.length > 0 && (
              <span className="bg-purple-600 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {validRiderPins.length}
              </span>
            )}
          </button>

          {/* Toggle Convoy Formation & Roles */}
          {ride.status === 'planned' && (
            <button
              onClick={() => {
                setShowFormationPanel(!showFormationPanel);
                if (!showMapPreview) setShowMapPreview(true);
              }}
              className={`px-2.5 py-1 text-xs font-semibold rounded border transition flex items-center gap-1.5 ${
                showFormationPanel
                  ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                  : 'bg-amber-50 text-amber-900 hover:bg-amber-100 border-amber-300'
              }`}
              title="Assign Head (Lead) and Tail (Sweep) roles for convoy discipline"
            >
              <span>👑</span>
              <span>{showFormationPanel ? 'Close Roles' : 'Convoy Roles (Head/Tail)'}</span>
            </button>
          )}

          {!isParticipant && (ride.status === 'planned' || ride.status === 'ongoing') && (
            <button
              onClick={handleJoin}
              disabled={loadingAction}
              className="px-2.5 py-1 text-xs font-medium bg-slate-100 text-slate-800 rounded hover:bg-slate-200 disabled:opacity-50"
            >
              {loadingAction ? 'Joining...' : 'Join Ride'}
            </button>
          )}

          {canManage && ride.status === 'planned' && (
            <button
              onClick={handleStart}
              disabled={loadingAction}
              className={`px-3 py-1 text-xs font-bold rounded shadow-sm transition flex items-center gap-1.5 ${
                allParticipantsShared
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  : 'bg-amber-600 hover:bg-amber-700 text-white'
              }`}
              title={
                allParticipantsShared
                  ? 'Start the convoy now'
                  : 'All participants should share location before starting'
              }
            >
              <span>🚀</span>
              <span>{loadingAction ? 'Starting...' : 'Start Ride'}</span>
            </button>
          )}

          {canManage && ride.status === 'planned' && (
            <button
              onClick={handleCancel}
              disabled={loadingAction}
              className="px-2.5 py-1 text-xs font-medium bg-red-100 text-red-700 border border-red-300 rounded hover:bg-red-200 disabled:opacity-50 transition flex items-center gap-1"
            >
              <span>✕</span>
              <span>Cancel Ride</span>
            </button>
          )}

          {ride.status === 'ongoing' && (
            <Link
              to={`/rides/${ride.id}/live`}
              className="px-3 py-1 text-xs font-bold bg-emerald-600 text-white rounded hover:bg-emerald-700 shadow-sm flex items-center gap-1.5 animate-pulse"
            >
              <span>🏍️</span>
              <span>Live Convoy</span>
            </Link>
          )}

          {canManage && ride.status === 'ongoing' && (
            <button
              onClick={handleEnd}
              disabled={loadingAction}
              className="px-2.5 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {loadingAction ? 'Ending...' : 'End Ride'}
            </button>
          )}
        </div>
      </div>

      {/* Expandable Map Preview with Rider Location Permissions & Pins */}
      {showMapPreview && (
        <div className="mt-3 border-t border-slate-200 pt-3 space-y-3">
          {/* Location Permission & Sharing Prompt for Participants */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="font-semibold text-slate-800 flex items-center gap-1.5">
                <span>📍</span>
                <span>Rider Location Permission</span>
              </p>
              <p className="text-[11px] text-slate-500">
                {mySharedLocation
                  ? 'Your location is active and visible on this scheduled map preview.'
                  : 'Grant location permission so your fellow riders can see your meeting point on the map preview.'}
              </p>
              {locationSuccess && <p className="text-[11px] text-emerald-600 font-semibold">{locationSuccess}</p>}
              {locationError && (
                <div className="mt-1">
                  <p className="text-[11px] text-red-600 font-semibold">{locationError}</p>
                  {!isSecureOrigin() && (
                    <a
                      href={getHttpsUrl()}
                      className="inline-block mt-1 text-[11px] bg-amber-600 hover:bg-amber-700 text-white font-bold px-2.5 py-1 rounded transition shadow-sm"
                    >
                      🔒 Switch to HTTPS for Phone GPS
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsPinningOnMap((prev) => !prev);
                  if (!isPinningOnMap && mySharedLocation) {
                    setCustomPin({ lat: mySharedLocation.lat, lng: mySharedLocation.lng });
                  }
                }}
                className={`px-3 py-1.5 rounded-md font-semibold text-xs flex items-center gap-1.5 transition shadow-sm ${
                  isPinningOnMap
                    ? 'bg-amber-600 hover:bg-amber-700 text-white'
                    : isCoarse
                    ? 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-400 animate-pulse'
                    : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-300'
                }`}
                title="Pin exact location on map or search landmark"
              >
                <span>🎯</span>
                <span>{isPinningOnMap ? 'Exit Pin Mode' : 'Adjust / Pin on Map'}</span>
              </button>

              <button
                onClick={handleShareLocation}
                disabled={locating}
                className={`px-3 py-1.5 rounded-md font-semibold text-xs flex items-center gap-1.5 transition shadow-sm ${
                  mySharedLocation
                    ? 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-300'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                }`}
              >
                <span>{locating ? '📡' : mySharedLocation ? '🔄' : '📍'}</span>
                <span>
                  {locating
                    ? 'Acquiring GPS...'
                    : mySharedLocation
                    ? 'Refresh Auto Location'
                    : 'Grant & Share Location'}
                </span>
              </button>
            </div>
          </div>

          {/* Interactive Pinning Toolbar (for manual location adjustments on PC) */}
          {isPinningOnMap && (
            <div className="bg-emerald-50 border border-emerald-300 rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-bold text-emerald-950 text-xs">
                  <span className="text-base">🎯</span>
                  <span>Pin Your Exact Location on PC</span>
                </div>
                {customPin && (
                  <span className="font-mono text-emerald-900 text-[11px] bg-emerald-200/80 px-2 py-0.5 rounded font-bold">
                    📍 {customPin.lat.toFixed(5)}, {customPin.lng.toFixed(5)}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-emerald-800">
                👉 <strong>Click anywhere on the road or map below</strong>, drag the glowing green pin, or search your street/town:
              </p>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex-1">
                  <PlaceAutocompleteInput
                    value={searchPlaceText}
                    onChange={setSearchPlaceText}
                    onSelectPlace={async (place) => {
                      setSearchPlaceText(place.description || place.mainText);
                      try {
                        const coords = await geocodePlace(place.description || place.mainText);
                        if (coords) {
                          setCustomPin({ lat: coords.lat, lng: coords.lon ?? coords.lng });
                        }
                      } catch (e) {
                        console.warn('Geocoding error:', e);
                      }
                    }}
                    placeholder="Search town, junction or building to drop pin..."
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleSaveCustomPin}
                    disabled={!customPin || isSavingCustomPin}
                    className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs px-3.5 py-2 rounded shadow transition flex items-center gap-1"
                  >
                    <span>{isSavingCustomPin ? '⏳' : '✅'}</span>
                    <span>{isSavingCustomPin ? 'Saving...' : 'Save This Spot'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPinningOnMap(false)}
                    className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 text-xs px-3 py-2 rounded transition"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Map Preview with Route and All Rider Pins (With Head and Tail styling) */}
          {ride.startLocation && ride.destination && (
            <RouteMapPreview
              startLocation={ride.startLocation}
              destination={ride.destination}
              riders={riderLocations.map((r) => {
                const pId = (r.user?._id || r.user)?.toString();
                const isHead = pId === leadUserId;
                const isTail = pId === sweepUserId;
                return {
                  ...r,
                  isLead: isHead,
                  isSweep: isTail,
                  role: isHead ? 'head' : isTail ? 'tail' : 'rider',
                };
              })}
              allowPinSelection={isPinningOnMap}
              selectedPin={
                customPin ||
                (mySharedLocation && typeof mySharedLocation.lat === 'number'
                  ? { lat: mySharedLocation.lat, lng: mySharedLocation.lng }
                  : null)
              }
              onPinSelected={(coords) => {
                setCustomPin(coords);
                setLocationError('');
              }}
            />
          )}

          {/* Convoy Formation: Head, Tail and Riders Allocation (Available in Scheduled Phase) */}
          <div className="bg-white border border-slate-200 rounded-lg p-3 text-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
              <div>
                <span className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                  <span>👑</span>
                  <span>Convoy Formation: Head (Lead), Tail (Sweep) & Riders</span>
                </span>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Allocate convoy positions during start/destination preview before rolling out.
                </p>
              </div>
              <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-600">
                <span>{ride.participants?.length || 0} Riders Joined</span>
              </div>
            </div>

            {roleActionMsg && (
              <div className="p-2 bg-emerald-50 border border-emerald-200 rounded text-emerald-800 text-[11px] font-medium flex items-center justify-between">
                <span>✅ {roleActionMsg}</span>
                <button onClick={() => setRoleActionMsg('')} className="text-emerald-600 font-bold ml-2">✕</button>
              </div>
            )}

            {roleActionError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-[11px] font-medium flex items-center justify-between">
                <span>⚠️ {roleActionError}</span>
                <button onClick={() => setRoleActionError('')} className="text-red-500 font-bold ml-2">✕</button>
              </div>
            )}

            {/* Admin Quick Role Allocation Bar */}
            {canManage && ride.status === 'planned' && (
              <div className="bg-amber-50/70 border border-amber-200 rounded-lg p-2.5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-amber-950 mb-1 flex items-center gap-1">
                    <span>👑 Head / Lead Rider:</span>
                  </label>
                  <select
                    value={leadUserId || ''}
                    disabled={isUpdatingRoles}
                    onChange={(e) => handleAssignConvoyRoles(e.target.value, undefined)}
                    className="w-full text-xs bg-white border border-amber-300 rounded px-2.5 py-1.5 font-medium text-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
                  >
                    {(ride.participants || []).map((p) => {
                      const id = (p._id || p.id || p)?.toString();
                      return (
                        <option key={id} value={id}>
                          👑 {p.name || 'Rider'} {id === (ride.creator?._id || ride.creator)?.toString() ? '(Organizer)' : ''}
                        </option>
                      );
                    })}
                  </select>
                  <p className="text-[10px] text-amber-800/80 mt-0.5">Leads pace, navigates route, signals road hazards.</p>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-violet-950 mb-1 flex items-center gap-1">
                    <span>🛡️ Tail / Sweep Rider:</span>
                  </label>
                  <select
                    value={sweepUserId || ''}
                    disabled={isUpdatingRoles}
                    onChange={(e) => handleAssignConvoyRoles(undefined, e.target.value ? e.target.value : null)}
                    className="w-full text-xs bg-white border border-violet-300 rounded px-2.5 py-1.5 font-medium text-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                  >
                    <option value="">(None - No Sweep Assigned)</option>
                    {(ride.participants || []).map((p) => {
                      const id = (p._id || p.id || p)?.toString();
                      return (
                        <option key={id} value={id}>
                          🛡️ {p.name || 'Rider'}
                        </option>
                      );
                    })}
                  </select>
                  <p className="text-[10px] text-violet-800/80 mt-0.5">Rides at rear, ensures no rider gets left behind or separated.</p>
                </div>
              </div>
            )}

            {/* Convoy Gathering Riders List */}
            {ride.participants && ride.participants.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
                  <span>Convoy Formation Roster</span>
                  <span className={allParticipantsShared ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                    {sharedCount} of {totalParticipants} shared location
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ride.participants.map((p) => {
                    const pId = (p._id || p.id || p)?.toString();
                    const pName = p.name || 'Rider';
                    const isHead = pId === leadUserId;
                    const isTail = pId === sweepUserId;
                    const loc = riderLocations.find(
                      (r) => (r.user?._id || r.user)?.toString() === pId
                    );

                    return (
                      <div
                        key={pId}
                        className={`border rounded-lg p-2.5 flex items-center justify-between gap-2 transition ${
                          isHead
                            ? 'bg-yellow-50/60 border-yellow-300 shadow-2xs'
                            : isTail
                            ? 'bg-violet-50/60 border-violet-300 shadow-2xs'
                            : 'bg-slate-50 border-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-2 overflow-hidden">
                          <div className={`w-8 h-8 rounded-full text-white text-xs font-bold flex items-center justify-center overflow-hidden border-2 shrink-0 ${
                            isHead ? 'border-yellow-500 bg-yellow-600' : isTail ? 'border-violet-500 bg-violet-600' : 'border-slate-400 bg-slate-800'
                          }`}>
                            {p.profilePic ? (
                              <img src={p.profilePic} alt="" className="w-full h-full object-cover" />
                            ) : (
                              pName.charAt(0).toUpperCase()
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-slate-900 truncate text-xs">{pName}</span>
                              {isHead && (
                                <span className="text-[10px] bg-yellow-400 text-yellow-950 px-1.5 py-0.2 rounded font-extrabold flex items-center gap-0.5 shadow-2xs">
                                  <span>👑</span>
                                  <span>HEAD</span>
                                </span>
                              )}
                              {isTail && (
                                <span className="text-[10px] bg-violet-600 text-white px-1.5 py-0.2 rounded font-extrabold flex items-center gap-0.5 shadow-2xs">
                                  <span>🛡️</span>
                                  <span>TAIL</span>
                                </span>
                              )}
                              {!isHead && !isTail && (
                                <span className="text-[9px] bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-semibold">
                                  RIDER
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
                              {p.bloodGroup && <span>🩸 {p.bloodGroup}</span>}
                              {loc && typeof loc.lat === 'number' ? (
                                <span className="text-emerald-700 font-semibold flex items-center gap-0.5">
                                  <span>· 📍 Plotted</span>
                                </span>
                              ) : (
                                <span className="text-amber-600">· ⏳ Pin pending</span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Quick Role Actions for Leader/Admin */}
                        {canManage && ride.status === 'planned' && (
                          <div className="flex items-center gap-1 shrink-0">
                            {!isHead && (
                              <button
                                type="button"
                                disabled={isUpdatingRoles}
                                onClick={() => handleAssignConvoyRoles(pId, undefined)}
                                className="text-[10px] font-semibold bg-white hover:bg-yellow-100 text-yellow-900 border border-yellow-300 px-1.5 py-0.5 rounded transition disabled:opacity-50"
                                title="Assign as Head / Lead Rider"
                              >
                                👑 Head
                              </button>
                            )}
                            {!isTail ? (
                              <button
                                type="button"
                                disabled={isUpdatingRoles}
                                onClick={() => handleAssignConvoyRoles(undefined, pId)}
                                className="text-[10px] font-semibold bg-white hover:bg-violet-100 text-violet-900 border border-violet-300 px-1.5 py-0.5 rounded transition disabled:opacity-50"
                                title="Assign as Tail / Sweep Rider"
                              >
                                🛡️ Tail
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isUpdatingRoles}
                                onClick={() => handleAssignConvoyRoles(undefined, null)}
                                className="text-[10px] font-semibold bg-white hover:bg-red-50 text-red-600 border border-red-200 px-1.5 py-0.5 rounded transition disabled:opacity-50"
                                title="Unassign Tail Rider"
                              >
                                ✕ Clear
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default RideCard;
