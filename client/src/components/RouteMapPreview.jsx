import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { geocodePlace, fetchRouteGeometry } from '../services/ride.service';

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  if (typeof lat1 !== 'number' || typeof lon1 !== 'number' || typeof lat2 !== 'number' || typeof lon2 !== 'number') {
    return null;
  }
  const R = 6371; // km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(1));
}

function RouteMapPreview({
  startLocation,
  destination,
  startCoords,
  destCoords,
  riders = [], // array of { user: { _id, name, phone, bloodGroup, profilePic }, lat, lng }
  onRouteCalculated,
  allowPinSelection = false,
  selectedPin = null,
  onPinSelected = null,
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const polylineLayerRef = useRef(null);
  const feederPolylineLayersRef = useRef([]);
  const startMarkerRef = useRef(null);
  const destMarkerRef = useRef(null);
  const riderMarkersRef = useRef([]);
  const selectedPinMarkerRef = useRef(null);
  const resolvedStartCoordsRef = useRef(null);
  const resolvedDestCoordsRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [routeInfo, setRouteInfo] = useState(null);
  const [feederInfo, setFeederInfo] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [mapInitialized, setMapInitialized] = useState(false);

  // 1. Initialize Leaflet Map once
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    try {
      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        scrollWheelZoom: false,
      }).setView([20.5937, 78.9629], 5);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      mapInstanceRef.current = map;
      setMapInitialized(true);

      setTimeout(() => {
        map.invalidateSize();
      }, 250);
    } catch (err) {
      console.error('RouteMapPreview Leaflet error:', err);
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        setMapInitialized(false);
      }
    };
  }, []);

  // 2. Compute route when locations or coordinates change
  useEffect(() => {
    let isCancelled = false;

    async function loadRoute() {
      if (!startLocation && !destination && (!riders || riders.length === 0)) {
        setRouteInfo(null);
        setRouteError('');
        return;
      }

      setLoading(true);
      setRouteError('');

      try {
        const map = mapInstanceRef.current;

        // Resolve start coordinates
        let sCoords = startCoords;
        if ((!sCoords || (!sCoords.lat && !sCoords.lon)) && startLocation) {
          sCoords = await geocodePlace(startLocation);
        }

        // Resolve destination coordinates
        let dCoords = destCoords;
        if ((!dCoords || (!dCoords.lat && !dCoords.lon)) && destination) {
          dCoords = await geocodePlace(destination);
        }

        if (isCancelled) return;

        resolvedStartCoordsRef.current = sCoords;
        resolvedDestCoordsRef.current = dCoords;

        if (map) {
          // Clear previous route layers
          if (polylineLayerRef.current && map.hasLayer(polylineLayerRef.current)) {
            map.removeLayer(polylineLayerRef.current);
            polylineLayerRef.current = null;
          }
          if (startMarkerRef.current && map.hasLayer(startMarkerRef.current)) {
            map.removeLayer(startMarkerRef.current);
            startMarkerRef.current = null;
          }
          if (destMarkerRef.current && map.hasLayer(destMarkerRef.current)) {
            map.removeLayer(destMarkerRef.current);
            destMarkerRef.current = null;
          }
          feederPolylineLayersRef.current.forEach((layer) => {
            if (map.hasLayer(layer)) map.removeLayer(layer);
          });
          feederPolylineLayersRef.current = [];
        }

        // Custom start icon (Green A)
        const startIcon = L.divIcon({
          className: 'custom-route-marker',
          html: `
            <div style="
              background: #10b981;
              color: white;
              width: 30px;
              height: 30px;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 700;
              font-size: 13px;
              border: 2px solid #ffffff;
              box-shadow: 0 4px 10px rgba(0,0,0,0.35);
            ">A</div>
          `,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });

        // Custom destination icon (Red B)
        const destIcon = L.divIcon({
          className: 'custom-route-marker',
          html: `
            <div style="
              background: #ef4444;
              color: white;
              width: 30px;
              height: 30px;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 700;
              font-size: 13px;
              border: 2px solid #ffffff;
              box-shadow: 0 4px 10px rgba(0,0,0,0.35);
            ">B</div>
          `,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });

        const allBoundsCoords = [];

        // 1. Plot Start Marker if available
        if (sCoords && map) {
          const sLatLng = [sCoords.lat, sCoords.lon ?? sCoords.lng];
          const startMarker = L.marker(sLatLng, { icon: startIcon })
            .bindPopup(`<strong>🏁 Start / Leader Location:</strong><br/>${startLocation || 'Start'}`)
            .addTo(map);
          startMarkerRef.current = startMarker;
          allBoundsCoords.push(sLatLng);
        }

        // 2. Plot Destination Marker if available
        if (dCoords && map) {
          const dLatLng = [dCoords.lat, dCoords.lon ?? dCoords.lng];
          const destMarker = L.marker(dLatLng, { icon: destIcon })
            .bindPopup(`<strong>🎯 Destination:</strong><br/>${destination || 'Destination'}`)
            .addTo(map);
          destMarkerRef.current = destMarker;
          allBoundsCoords.push(dLatLng);
        }

        // 3. Compute Main Route if both Start & Destination exist
        if (sCoords && dCoords && map) {
          const routeData = await fetchRouteGeometry(sCoords, dCoords);
          if (isCancelled) return;

          let latLngs = [];
          if (routeData && routeData.latLngs && routeData.latLngs.length > 0) {
            latLngs = routeData.latLngs;
            setRouteInfo({
              distanceKm: routeData.distanceKm,
              durationText: routeData.durationText,
              durationMinutes: routeData.durationMinutes,
            });

            if (onRouteCalculated) {
              onRouteCalculated({
                distanceKm: routeData.distanceKm,
                durationText: routeData.durationText,
                durationMinutes: routeData.durationMinutes,
              });
            }
          } else {
            // Straight line fallback
            latLngs = [
              [sCoords.lat, sCoords.lon ?? sCoords.lng],
              [dCoords.lat, dCoords.lon ?? dCoords.lng],
            ];
            const directDist = calculateDistanceKm(
              sCoords.lat,
              sCoords.lon ?? sCoords.lng,
              dCoords.lat,
              dCoords.lon ?? dCoords.lng
            );
            setRouteInfo({
              distanceKm: directDist,
              durationText: directDist ? `~${Math.round((directDist / 45) * 60)} mins` : null,
              durationMinutes: directDist ? Math.round((directDist / 45) * 60) : null,
            });
          }

          // Draw Main Route Polyline
          const polyline = L.polyline(latLngs, {
            color: '#2563eb',
            weight: 5,
            opacity: 0.85,
            lineJoin: 'round',
          }).addTo(map);
          polylineLayerRef.current = polyline;

          latLngs.forEach((coord) => allBoundsCoords.push(coord));
        } else if (startLocation && destination && (!sCoords || !dCoords)) {
          setRouteError('Could not pinpoint one of the entered addresses. Try selecting from suggestions.');
        }

        // 4. Compute Feeder Route(s) from Riders to Leader/Start Location
        if (sCoords && riders && riders.length > 0 && map) {
          let primaryFeeder = null;
          for (const r of riders) {
            if (typeof r.lat !== 'number' || typeof r.lng !== 'number') continue;
            const distToStart = calculateDistanceKm(
              r.lat,
              r.lng,
              sCoords.lat,
              sCoords.lon ?? sCoords.lng
            );

            // If rider is more than 60m away from the start meeting point, draw feeder route to leader
            if (distToStart && distToStart > 0.06) {
              let feederLatLngs = [];
              try {
                const fData = await fetchRouteGeometry(
                  { lat: r.lat, lng: r.lng },
                  sCoords
                );
                if (fData && fData.latLngs && fData.latLngs.length > 0) {
                  feederLatLngs = fData.latLngs;
                }
              } catch (e) {}

              if (feederLatLngs.length === 0) {
                feederLatLngs = [
                  [r.lat, r.lng],
                  [sCoords.lat, sCoords.lon ?? sCoords.lng],
                ];
              }

              const feederLine = L.polyline(feederLatLngs, {
                color: '#9333ea',
                weight: 4,
                dashArray: '6, 8',
                opacity: 0.85,
                lineJoin: 'round',
              }).addTo(map);

              feederLine.bindTooltip(
                `🏍️ ${r.user?.name || 'Rider'} → Route to Leader / Meeting Point (${distToStart} km)`,
                { sticky: true }
              );

              feederPolylineLayersRef.current.push(feederLine);
              feederLatLngs.forEach((c) => allBoundsCoords.push(c));

              if (!primaryFeeder) {
                primaryFeeder = {
                  distanceKm: distToStart,
                  riderName: r.user?.name || 'You',
                };
              }
            }
          }
          setFeederInfo(primaryFeeder);
        } else {
          setFeederInfo(null);
        }

        // 5. Fit Map View
        if (allBoundsCoords.length > 0 && map) {
          const bounds = L.latLngBounds(allBoundsCoords);
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        }

        setTimeout(() => {
          if (mapInstanceRef.current) {
            mapInstanceRef.current.invalidateSize();
          }
        }, 200);
      } catch (err) {
        if (!isCancelled) {
          console.warn('Route calculation error:', err);
          setRouteError('Error displaying route. Tap refresh to retry.');
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    }

    const timer = setTimeout(loadRoute, 250);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [startLocation, destination, startCoords, destCoords, riders, mapInitialized]);

  // Helper to fit both the route and rider pins
  const fitRouteAndRiders = (map, routeBounds) => {
    if (!map) return;
    const allLatLngs = [];

    if (routeBounds) {
      allLatLngs.push(routeBounds.getNorthEast());
      allLatLngs.push(routeBounds.getSouthWest());
    }

    riders.forEach((r) => {
      if (typeof r.lat === 'number' && typeof r.lng === 'number') {
        allLatLngs.push([r.lat, r.lng]);
      }
    });

    if (allLatLngs.length > 0) {
      const combinedBounds = L.latLngBounds(allLatLngs);
      map.fitBounds(combinedBounds, { padding: [40, 40] });
    }
  };

  // 3. Render and Update Rider Markers on Map Preview
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // Clear existing rider markers
    riderMarkersRef.current.forEach((marker) => {
      if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    });
    riderMarkersRef.current = [];

    const startC = resolvedStartCoordsRef.current || startCoords;

    riders.forEach((r) => {
      if (typeof r.lat !== 'number' || typeof r.lng !== 'number') return;

      const u = r.user || {};
      const name = u.name || 'Rider';
      const initial = name.charAt(0).toUpperCase();
      const distFromStart = startC
        ? calculateDistanceKm(r.lat, r.lng, startC.lat, startC.lon ?? startC.lng)
        : null;

      const isLead = Boolean(r.isLead || r.role === 'lead' || r.role === 'head');
      const isSweep = Boolean(r.isSweep || r.role === 'sweep' || r.role === 'tail');

      const borderColor = isLead ? '#eab308' : isSweep ? '#8b5cf6' : '#3b82f6';
      const roleBadge = isLead ? '👑' : isSweep ? '🛡️' : null;
      const roleLabel = isLead ? ' (Head)' : isSweep ? ' (Tail)' : '';

      const avatarHtml = u.profilePic
        ? `<img src="${u.profilePic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`
        : `<span style="color:#fff;font-weight:bold;font-size:11px;">${initial}</span>`;

      const riderIcon = L.divIcon({
        className: 'preview-rider-marker',
        html: `
          <div style="position:relative;display:flex;flex-direction:column;align-items:center;cursor:pointer;">
            ${roleBadge ? `
              <div style="
                position:absolute;
                top:-8px;
                right:-6px;
                font-size:12px;
                background:${isLead ? '#eab308' : '#8b5cf6'};
                border-radius:50%;
                width:18px;
                height:18px;
                display:flex;
                align-items:center;
                justify-content:center;
                box-shadow:0 2px 4px rgba(0,0,0,0.4);
                z-index:10;
              ">
                ${roleBadge}
              </div>
            ` : ''}
            <div style="
              width: 34px;
              height: 34px;
              border-radius: 50%;
              border: 3px solid ${borderColor};
              background: #1e1b4b;
              display: flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 4px 10px rgba(0,0,0,0.4);
              overflow: hidden;
            ">
              ${avatarHtml}
            </div>
            <div style="
              margin-top: 1px;
              background: #1e1b4b;
              color: #fff;
              font-size: 9px;
              font-weight: 700;
              padding: 1px 5px;
              border-radius: 4px;
              white-space: nowrap;
              border: 1px solid rgba(255,255,255,0.3);
            ">
              ${name.split(' ')[0]}${roleLabel}
            </div>
          </div>
        `,
        iconSize: [38, 50],
        iconAnchor: [19, 25],
      });

      const popupContent = `
        <div style="font-family:ui-sans-serif,system-ui,sans-serif;min-width:180px;padding:3px;color:#0f172a;">
          <div style="font-weight:bold;font-size:13px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:6px;">
            🏍️ ${name}
          </div>
          <div style="font-size:11px;display:flex;flex-direction:column;gap:4px;">
            ${u.bloodGroup ? `<div style="color:#b91c1c;font-weight:700;">🩸 Blood Group: ${u.bloodGroup}</div>` : ''}
            ${u.phone ? `<div>📞 <a href="tel:${u.phone}" style="color:#2563eb;text-decoration:underline;">${u.phone}</a></div>` : ''}
            <div style="color:#64748b;font-family:monospace;font-size:10px;">📍 ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</div>
            ${distFromStart !== null ? `<div style="background:#f1f5f9;padding:2px 4px;border-radius:4px;font-weight:600;color:#0f172a;">🏁 ${distFromStart} km from meeting point</div>` : ''}
          </div>
        </div>
      `;

      const marker = L.marker([r.lat, r.lng], { icon: riderIcon })
        .bindPopup(popupContent)
        .bindTooltip(name, { direction: 'top', offset: [0, -18] })
        .addTo(map);

      riderMarkersRef.current.push(marker);
    });

    // Re-fit map bounds with riders
    if (polylineLayerRef.current) {
      fitRouteAndRiders(map, polylineLayerRef.current.getBounds());
    }
  }, [riders]);

  // 4. Interactive Pin Placement Mode (Click & Drag)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (!allowPinSelection) {
      if (selectedPinMarkerRef.current && map.hasLayer(selectedPinMarkerRef.current)) {
        map.removeLayer(selectedPinMarkerRef.current);
        selectedPinMarkerRef.current = null;
      }
      map.getContainer().style.cursor = '';
      return;
    }

    map.getContainer().style.cursor = 'crosshair';

    const handleMapClick = (e) => {
      const { lat, lng } = e.latlng;
      if (onPinSelected) {
        onPinSelected({ lat, lng });
      }
    };

    map.on('click', handleMapClick);

    return () => {
      map.off('click', handleMapClick);
      if (map.getContainer()) {
        map.getContainer().style.cursor = '';
      }
    };
  }, [allowPinSelection, onPinSelected]);

  // Update selectedPin marker position on map
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !allowPinSelection) return;

    if (selectedPin && typeof selectedPin.lat === 'number' && typeof selectedPin.lng === 'number') {
      const pinIcon = L.divIcon({
        className: 'selected-pin-marker',
        html: `
          <div style="position:relative;display:flex;flex-direction:column;align-items:center;cursor:grab;">
            <div style="
              width: 38px;
              height: 38px;
              border-radius: 50%;
              background: #10b981;
              color: white;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 20px;
              border: 3px solid #ffffff;
              box-shadow: 0 4px 14px rgba(0,0,0,0.5);
            ">
              📍
            </div>
            <div style="
              margin-top: 2px;
              background: #065f46;
              color: #ecfdf5;
              font-size: 10px;
              font-weight: 700;
              padding: 2px 6px;
              border-radius: 4px;
              white-space: nowrap;
              border: 1px solid rgba(255,255,255,0.4);
              box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            ">
              Drag to Adjust
            </div>
          </div>
        `,
        iconSize: [42, 58],
        iconAnchor: [21, 29],
      });

      if (selectedPinMarkerRef.current) {
        selectedPinMarkerRef.current.setLatLng([selectedPin.lat, selectedPin.lng]);
      } else {
        const marker = L.marker([selectedPin.lat, selectedPin.lng], {
          icon: pinIcon,
          draggable: true,
          zIndexOffset: 2000,
        }).addTo(map);

        marker.on('dragend', (e) => {
          const pos = e.target.getLatLng();
          if (onPinSelected) {
            onPinSelected({ lat: pos.lat, lng: pos.lng });
          }
        });

        marker.bindTooltip('Your exact spot (Drag to fine-tune)', {
          permanent: true,
          direction: 'top',
          offset: [0, -28],
        });

        selectedPinMarkerRef.current = marker;
      }
    }
  }, [allowPinSelection, selectedPin, onPinSelected]);

  const ridersWithLocation = riders.filter(
    (r) => typeof r.lat === 'number' && typeof r.lng === 'number'
  );

  if (!startLocation && !destination) {
    return null;
  }

  return (
    <div className="mt-3 bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
      {/* Pin Mode Instruction Banner */}
      {allowPinSelection && (
        <div className="bg-emerald-600 text-white px-3 py-2 text-xs flex items-center justify-between border-b border-emerald-500 animate-pulse">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎯</span>
            <span className="font-semibold">
              Pin Mode Active: Click anywhere on the map or drag the pin to set your exact location!
            </span>
          </div>
          {selectedPin && (
            <span className="font-mono text-[11px] bg-emerald-800/80 px-2 py-0.5 rounded font-bold">
              {selectedPin.lat.toFixed(4)}, {selectedPin.lng.toFixed(4)}
            </span>
          )}
        </div>
      )}
      {/* Route Statistics & Rider Count Bar */}
      <div className="bg-slate-900 text-white p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-base">🏍️</span>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-semibold text-slate-100">
                Route & Riders Map Preview
              </p>
              {ridersWithLocation.length > 0 && (
                <span className="bg-purple-500/30 text-purple-300 border border-purple-400/50 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                  <span>📍</span>
                  <span>{ridersWithLocation.length} Rider{ridersWithLocation.length > 1 ? 's' : ''} on Map</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 truncate max-w-[260px] sm:max-w-md">
              {startLocation || 'Start'} → {destination || 'Destination'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {feederInfo && (
            <div className="bg-purple-500/20 border border-purple-400/40 rounded px-2.5 py-1 text-right">
              <span className="text-[10px] text-purple-300 uppercase block font-medium">To Leader / Start</span>
              <span className="text-sm font-bold text-purple-300">{feederInfo.distanceKm} km</span>
            </div>
          )}

          {routeInfo && (
            <>
              <div className="bg-emerald-500/20 border border-emerald-400/40 rounded px-2.5 py-1 text-right">
                <span className="text-[10px] text-emerald-300 uppercase block font-medium">Convoy Route</span>
                <span className="text-sm font-bold text-emerald-400">{routeInfo.distanceKm} km</span>
              </div>
              {routeInfo.durationText && (
                <div className="bg-blue-500/20 border border-blue-400/40 rounded px-2.5 py-1 text-right">
                  <span className="text-[10px] text-blue-300 uppercase block font-medium">Est. Time</span>
                  <span className="text-sm font-bold text-blue-300">{routeInfo.durationText}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {routeError && (
        <div className="p-2.5 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>{routeError}</span>
        </div>
      )}

      {/* Leaflet Map Canvas */}
      <div className="relative">
        <div
          ref={mapContainerRef}
          className="w-full h-56 sm:h-72 bg-slate-100 z-0"
        />

        {loading && (
          <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px] flex items-center justify-center z-10">
            <div className="bg-white/95 px-3 py-1.5 rounded-full shadow text-xs font-medium text-slate-800 flex items-center gap-2">
              <div className="w-3.5 h-3.5 border-2 border-slate-700 border-t-transparent rounded-full animate-spin" />
              <span>Fetching road route & distance...</span>
            </div>
          </div>
        )}
      </div>

      {/* Pinned Riders Quick Chips */}
      {ridersWithLocation.length > 0 && (
        <div className="bg-slate-50 border-t border-slate-200 p-2.5 flex items-center gap-2 overflow-x-auto text-xs">
          <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wider shrink-0 flex items-center gap-1">
            <span>📍 Pinned:</span>
          </span>
          {ridersWithLocation.map((r, idx) => {
            const u = r.user || {};
            const startC = resolvedStartCoordsRef.current || startCoords;
            const dist = startC
              ? calculateDistanceKm(r.lat, r.lng, startC.lat, startC.lon ?? startC.lng)
              : null;

            return (
              <button
                key={u._id || idx}
                type="button"
                onClick={() => {
                  if (mapInstanceRef.current) {
                    mapInstanceRef.current.setView([r.lat, r.lng], 15, { animate: true });
                    const marker = riderMarkersRef.current[idx];
                    if (marker) marker.openPopup();
                  }
                }}
                className="bg-white hover:bg-slate-100 border border-slate-300 rounded-full px-2.5 py-1 text-slate-800 flex items-center gap-1.5 shrink-0 shadow-sm transition"
              >
                <div className="w-4 h-4 rounded-full bg-purple-600 text-white text-[9px] font-bold flex items-center justify-center overflow-hidden">
                  {u.profilePic ? (
                    <img src={u.profilePic} alt="" className="w-full h-full object-cover" />
                  ) : (
                    (u.name || 'R')[0].toUpperCase()
                  )}
                </div>
                <span className="font-semibold text-[11px]">{u.name || 'Rider'}</span>
                {dist !== null && (
                  <span className="text-[10px] text-slate-500 font-mono">({dist} km)</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RouteMapPreview;
