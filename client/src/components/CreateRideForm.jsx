import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { createRide } from '../services/ride.service';
import { ApiError } from '../services/api';
import { getSmartLocation, reverseGeocode } from '../services/location.service';
import PlaceAutocompleteInput from './PlaceAutocompleteInput.jsx';
import RouteMapPreview from './RouteMapPreview.jsx';

function CreateRideForm({ groupId, onCreated, onCancel }) {
  const { user, token } = useAuth();
  const [title, setTitle] = useState('');
  const [startLocation, setStartLocation] = useState('');
  const [destination, setDestination] = useState('');
  const [startCoords, setStartCoords] = useState(null);
  const [destCoords, setDestCoords] = useState(null);
  const [distanceKm, setDistanceKm] = useState(null);
  const [durationMinutes, setDurationMinutes] = useState(null);
  const [creatorCoords, setCreatorCoords] = useState(null);
  const [shareLocation, setShareLocation] = useState(true);
  const [locating, setLocating] = useState(false);
  const [locatingStart, setLocatingStart] = useState(false);
  const [locationMsg, setLocationMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [roadCondition, setRoadCondition] = useState('Highway');
  const [terrainSpeeds, setTerrainSpeeds] = useState({
    Highway: 80,
    City: 45,
    'Ghats/Hills': 40,
    'Rain/Wet': 50,
    Night: 60,
    Custom: 80,
  });

  const speedLimit = terrainSpeeds[roadCondition] ?? 80;

  const handleUpdateCurrentSpeed = (newSpeed) => {
    const clamped = Math.max(20, Math.min(140, newSpeed));
    setTerrainSpeeds((prev) => ({
      ...prev,
      [roadCondition]: clamped,
      Custom: roadCondition === 'Custom' ? clamped : prev.Custom,
    }));
  };

  // Road condition presets
  const ROAD_PRESETS = [
    { name: 'Highway', icon: '🛣️', defaultSpeed: 80, desc: 'Expressway / Highway' },
    { name: 'City', icon: '🏙️', defaultSpeed: 45, desc: 'Urban / City Roads' },
    { name: 'Ghats/Hills', icon: '⛰️', defaultSpeed: 40, desc: 'Curved Hill Roads' },
    { name: 'Rain/Wet', icon: '🌧️', defaultSpeed: 50, desc: 'Wet / Rainy Weather' },
    { name: 'Night', icon: '🌙', defaultSpeed: 60, desc: 'Night Cruising' },
    { name: 'Custom', icon: '⚙️', defaultSpeed: 80, desc: 'Custom Limit' },
  ];

  // Automatically request location permission if shareLocation is true
  useEffect(() => {
    if (shareLocation && !creatorCoords) {
      handleGetLocation();
    }
  }, [shareLocation]);

  async function handleGetLocation() {
    setLocating(true);
    setLocationMsg('Acquiring your location...');
    try {
      const loc = await getSmartLocation({ enableHighAccuracy: true, timeout: 8000 });
      setCreatorCoords({
        lat: loc.lat,
        lng: loc.lng,
      });
      setLocationMsg(
        loc.isApproximate
          ? `Location captured via network IP (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`
          : `GPS Location captured (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`
      );
    } catch (err) {
      console.warn('Location capture error:', err.message);
      setLocationMsg('Location access was denied or unavailable.');
    } finally {
      setLocating(false);
    }
  }

  async function handleUseCurrentLocationAsStart() {
    setLocatingStart(true);
    setError('');
    try {
      const loc = await getSmartLocation({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      const coords = {
        lat: loc.lat,
        lng: loc.lng,
        lon: loc.lng,
      };
      setStartCoords(coords);
      setCreatorCoords({ lat: loc.lat, lng: loc.lng });
      setShareLocation(true);
      setLocationMsg(
        loc.isApproximate
          ? `Location captured via network IP (${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`
          : `GPS Location captured (${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`
      );

      // Reverse geocode to get a readable address
      let placeName = '';
      try {
        placeName = await reverseGeocode(loc.lat, loc.lng);
      } catch {
        // ignore
      }

      const label = placeName
        ? `Leader Location (${placeName}) [${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}]`
        : `Leader Location (${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`;
      setStartLocation(label);
    } catch (err) {
      console.warn('Location capture error:', err.message);
      setError('Could not access your location. Please ensure location permissions are granted.');
    } finally {
      setLocatingStart(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!title.trim()) {
      setError('Ride title is required.');
      return;
    }

    setLoading(true);
    try {
      await createRide(
        {
          title,
          groupId,
          startLocation,
          startCoords,
          destination,
          destCoords,
          distanceKm,
          durationMinutes,
          creatorCoords: shareLocation ? creatorCoords : null,
          roadCondition,
          speedLimit: Number(speedLimit) || 80,
        },
        token
      );
      setTitle('');
      setStartLocation('');
      setDestination('');
      setStartCoords(null);
      setDestCoords(null);
      setDistanceKm(null);
      setDurationMinutes(null);
      setCreatorCoords(null);
      setRoadCondition('Highway');
      setTerrainSpeeds({
        Highway: 80,
        City: 45,
        'Ghats/Hills': 40,
        'Rain/Wet': 50,
        Night: 60,
        Custom: 80,
      });
      if (onCreated) onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create ride.');
    } finally {
      setLoading(false);
    }
  }

  const previewRiders =
    shareLocation && creatorCoords && user
      ? [
          {
            user: {
              _id: user.id,
              name: user.name,
              phone: user.phone,
              bloodGroup: user.bloodGroup,
              profilePic: user.profilePic,
              role: 'rideAdmin',
            },
            lat: creatorCoords.lat,
            lng: creatorCoords.lng,
          },
        ]
      : [];

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
      <h4 className="text-sm font-semibold text-slate-900 mb-3">Schedule a New Ride</h4>
      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Ride Title <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter ride title"
            className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-900 bg-white"
            disabled={loading}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PlaceAutocompleteInput
            label="Start Location"
            value={startLocation}
            onChange={(val) => {
              setStartLocation(val);
              setStartCoords(null);
            }}
            onSelectPlace={async (place) => {
              if (place.coordinates) {
                setStartCoords(place.coordinates);
              } else {
                const coords = await geocodePlace(place.description || place.mainText);
                if (coords) setStartCoords(coords);
              }
            }}
            placeholder="Search start location"
            disabled={loading || locatingStart}
            id="ride-start-location"
            rightAction={
              <button
                type="button"
                onClick={handleUseCurrentLocationAsStart}
                disabled={loading || locatingStart}
                className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900 bg-emerald-100/90 hover:bg-emerald-200 border border-emerald-300 px-2 py-0.5 rounded flex items-center gap-1 transition shadow-xs cursor-pointer disabled:opacity-50"
                title="Use current live GPS location as start point"
              >
                {locatingStart ? (
                  <>
                    <div className="w-2.5 h-2.5 border-2 border-emerald-700 border-t-transparent rounded-full animate-spin" />
                    <span>Locating...</span>
                  </>
                ) : (
                  <>
                    <span>📍</span>
                    <span>(Your Location)</span>
                  </>
                )}
              </button>
            }
          />
          <PlaceAutocompleteInput
            label="Destination"
            value={destination}
            onChange={(val) => {
              setDestination(val);
              setDestCoords(null);
            }}
            onSelectPlace={async (place) => {
              if (place.coordinates) {
                setDestCoords(place.coordinates);
              } else {
                const coords = await geocodePlace(place.description || place.mainText);
                if (coords) setDestCoords(coords);
              }
            }}
            placeholder="Search destination"
            disabled={loading}
            id="ride-destination"
          />
        </div>

        {/* Road Condition & Speed Limit Preset Selection */}
        <div className="bg-white border border-slate-200 rounded-md p-3 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-800 flex items-center gap-1.5">
              <span>🛡️</span>
              <span>Road Condition & Convoy Speed Limit</span>
            </span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
              {speedLimit} km/h limit
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
            {ROAD_PRESETS.map((preset) => {
              const isSelected = roadCondition === preset.name;
              const currentPresetSpeed = terrainSpeeds[preset.name] ?? preset.defaultSpeed;
              return (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => {
                    setRoadCondition(preset.name);
                  }}
                  className={`p-2 rounded-lg border text-left transition flex flex-col justify-between ${
                    isSelected
                      ? 'border-slate-900 bg-slate-900 text-white shadow-xs'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="text-sm">{preset.icon}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${
                      isSelected ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-800'
                    }`}>
                      {currentPresetSpeed} km/h
                    </span>
                  </div>
                  <div className="mt-1">
                    <div className="font-semibold text-xs leading-tight">{preset.name}</div>
                    <div className={`text-[9px] truncate ${isSelected ? 'text-slate-300' : 'text-slate-400'}`}>
                      {preset.desc}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Leader Custom Speed Editor - Available for ALL Road Conditions */}
          <div className="mt-2 p-2.5 bg-slate-50 rounded-lg border border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-700 font-semibold flex items-center gap-1">
                <span>⚡</span>
                <span>Custom Speed Limit for <strong>{roadCondition}</strong>:</span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleUpdateCurrentSpeed(speedLimit - 5)}
                  className="w-5 h-5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold flex items-center justify-center text-xs"
                >
                  -
                </button>
                <span className="font-mono font-bold text-slate-900 px-2 py-0.5 rounded bg-white border border-slate-200">
                  {speedLimit} km/h
                </span>
                <button
                  type="button"
                  onClick={() => handleUpdateCurrentSpeed(speedLimit + 5)}
                  className="w-5 h-5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold flex items-center justify-center text-xs"
                >
                  +
                </button>
              </div>
            </div>
            <input
              type="range"
              min="20"
              max="140"
              step="5"
              value={speedLimit}
              onChange={(e) => handleUpdateCurrentSpeed(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-300 rounded-lg appearance-none cursor-pointer accent-slate-900"
            />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>20 km/h (Tight/City)</span>
              <span>80 km/h (Standard Highway)</span>
              <span>140 km/h (Expressway)</span>
            </div>
          </div>
        </div>

        {/* Location Permission / Sharing for Organizer */}
        <div className="bg-white border border-slate-200 rounded-md p-3 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-800">
              <input
                type="checkbox"
                checked={shareLocation}
                onChange={(e) => setShareLocation(e.target.checked)}
                className="w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500"
              />
              <span>📍 Share my current location as Organizer on the Map Preview</span>
            </label>
            {shareLocation && (
              <button
                type="button"
                onClick={handleGetLocation}
                disabled={locating}
                className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold"
              >
                {locating ? 'Locating...' : 'Refresh GPS'}
              </button>
            )}
          </div>
          {shareLocation && locationMsg && (
            <p className={`text-[11px] ${creatorCoords ? 'text-emerald-700 font-medium' : 'text-slate-500'}`}>
              {creatorCoords ? '✅ ' : '⏳ '}
              {locationMsg}
            </p>
          )}
        </div>

        {/* Live Route & Distance Preview with Rider Pin & Route to Leader */}
        {(startLocation.trim() || destination.trim()) && (
          <RouteMapPreview
            startLocation={startLocation.trim()}
            destination={destination.trim()}
            startCoords={startCoords}
            destCoords={destCoords}
            riders={previewRiders}
            onRouteCalculated={({ distanceKm: km, durationMinutes: mins }) => {
              setDistanceKm(km);
              setDurationMinutes(mins);
            }}
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-xs font-medium text-slate-600 hover:text-slate-800 px-3 py-1.5"
              disabled={loading}
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={loading}
            className="text-xs font-medium bg-slate-900 text-white px-4 py-1.5 rounded hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Scheduled Ride'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreateRideForm;
