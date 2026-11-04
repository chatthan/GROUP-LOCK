import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useAuth } from '../context/AuthContext.jsx';
import {
  getRideDetails,
  endRide,
  getRideMessages,
  getRideAlerts,
  geocodePlace,
  fetchRouteGeometry,
  shareRiderLocation,
  assignSweepRider,
  updateSpeedLimit,
  reportRider,
  kickRider,
  batchSyncLocations,
} from '../services/ride.service';
import { initSocket, getSocket } from '../services/socket.service';
import { getSmartLocation, isSecureOrigin, getHttpsUrl } from '../services/location.service';
import PlaceAutocompleteInput from '../components/PlaceAutocompleteInput.jsx';
import {
  cacheRideRoute,
  getCachedRideRoute,
  queueLocationPing,
  getQueuedLocations,
  removeQueuedLocations,
  getQueuedCount,
} from '../utils/offlineSync';
import WalkieTalkiePTT from '../components/WalkieTalkiePTT.jsx';
import {
  speakVoiceAlert,
  playAudioChime,
  getVoiceSettings,
  saveVoiceSettings,
  testVoiceAlert,
} from '../utils/audioAlerts';
import {
  fetchHazards,
  reportRoadHazard,
  confirmRoadHazard,
  resolveRoadHazard,
} from '../services/hazard.service';
import { fetchLiveRoadWeather } from '../utils/weatherService';
import ConvoySimulationModal from '../components/ConvoySimulationModal.jsx';
import PrimusAssistant from '../components/PrimusAssistant.jsx';

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  if (typeof lat1 !== 'number' || typeof lon1 !== 'number' || typeof lat2 !== 'number' || typeof lon2 !== 'number') {
    return null;
  }
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

// Stage 10: Helper for hazard pin styling & visual identifiers
function getHazardIconData(type) {
  switch (type) {
    case 'POTHOLE':
      return { symbol: '⚠️', bg: '#d97706', border: '#f59e0b', glow: 'rgba(217, 119, 6, 0.7)' };
    case 'OIL_SPILL':
      return { symbol: '🛢️', bg: '#dc2626', border: '#ef4444', glow: 'rgba(220, 38, 38, 0.8)' };
    case 'ROADBLOCK':
      return { symbol: '🚧', bg: '#ea580c', border: '#f97316', glow: 'rgba(234, 88, 12, 0.7)' };
    case 'CATTLE_DEBRIS':
      return { symbol: '🐄', bg: '#ca8a04', border: '#eab308', glow: 'rgba(202, 138, 4, 0.7)' };
    case 'POLICE_CHECK':
      return { symbol: '🚔', bg: '#4f46e5', border: '#6366f1', glow: 'rgba(79, 70, 229, 0.7)' };
    case 'LOW_VISIBILITY':
      return { symbol: '🌫️', bg: '#475569', border: '#64748b', glow: 'rgba(71, 85, 105, 0.7)' };
    case 'ACCIDENT':
      return { symbol: '💥', bg: '#991b1b', border: '#b91c1c', glow: 'rgba(153, 27, 27, 0.8)' };
    default:
      return { symbol: '⚠️', bg: '#d97706', border: '#f59e0b', glow: 'rgba(217, 119, 6, 0.7)' };
  }
}

// Web Audio API chime generator for join notifications (no external assets required)
function playSoundNotification(type = 'join') {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    if (type === 'join') {
      // Pleasant two-tone chime (C5 -> G5)
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc1.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.15); // G5

      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

      osc1.connect(gain);
      gain.connect(ctx.destination);

      osc1.start();
      osc1.stop(ctx.currentTime + 0.5);
    } else if (type === 'sos') {
      // Urgent siren tone
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    }
  } catch (e) {
    // Audio autoplay might be blocked before user interaction, safely ignore
  }
}

function LiveRidePage() {
  const { id: rideId } = useParams();
  const navigate = useNavigate();
  const { user, token } = useAuth();

  const [ride, setRide] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mapReady, setMapReady] = useState(false);

  // Live Riders Map: userId -> riderData
  const [riders, setRiders] = useState({});
  const [myLocation, setMyLocation] = useState(null);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [gpsStatus, setGpsStatus] = useState('searching'); // 'searching', 'active', 'simulating', 'error'

  // Real-time telemetry refs for zero-latency handshake & auto-syncing
  const myLocationRef = useRef(myLocation);
  useEffect(() => {
    myLocationRef.current = myLocation;
  }, [myLocation]);

  const currentSpeedRef = useRef(currentSpeed);
  useEffect(() => {
    currentSpeedRef.current = currentSpeed;
  }, [currentSpeed]);

  const currentHeadingRef = useRef(0);

  // Notifications banner/toasts
  const [toasts, setToasts] = useState([]);

  // Group Health
  const [healthScore, setHealthScore] = useState(100);
  const [convoySpread, setConvoySpread] = useState(0);

  // Convoy Members Drawer & Chat & SOS
  const [isMembersOpen, setIsMembersOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [chatFontSize, setChatFontSize] = useState(() => {
    try {
      return localStorage.getItem('grouplock_chat_font_size') || 'large';
    } catch {
      return 'large';
    }
  });

  const handleSetChatFontSize = (size) => {
    setChatFontSize(size);
    try {
      localStorage.setItem('grouplock_chat_font_size', size);
    } catch {
      // ignore
    }
  };

  // Private direct chat selection & unread tracking
  const [selectedChatRecipient, setSelectedChatRecipient] = useState('everyone'); // 'everyone' or riderUserId
  const [unreadPrivateCounts, setUnreadPrivateCounts] = useState({}); // { [userId]: number }

  const [activeSosAlert, setActiveSosAlert] = useState(null);
  const [showSosModal, setShowSosModal] = useState(false);
  const [sosNote, setSosNote] = useState('');
  const [isEscalatingSos, setIsEscalatingSos] = useState(false);

  // Stage 6: Regroup Recommendation & Active Regroup State
  const [activeRegroup, setActiveRegroup] = useState(null);
  const [regroupRecommendation, setRegroupRecommendation] = useState(null);
  const [showRegroupModal, setShowRegroupModal] = useState(false);
  const [regroupHaltName, setRegroupHaltName] = useState('');
  const [regroupReason, setRegroupReason] = useState('');
  const [isTriggeringRegroup, setIsTriggeringRegroup] = useState(false);

  // Stage 4: Sweep Rider, Road Condition Speed Limits, Reporting & Kicking States
  const [roadCondition, setRoadCondition] = useState('Highway');
  const [speedLimit, setSpeedLimit] = useState(80);
  const [sweepRider, setSweepRider] = useState(null);
  const [leadRider, setLeadRider] = useState(null);
  const [overspeedAlert, setOverspeedAlert] = useState(null);
  const [kickedNotice, setKickedNotice] = useState(null);
  const [showSpeedLimitModal, setShowSpeedLimitModal] = useState(false);
  const [selectedRoadCondition, setSelectedRoadCondition] = useState('Highway');
  const [conditionSpeeds, setConditionSpeeds] = useState({
    Highway: 80,
    City: 45,
    'Ghats/Hills': 40,
    'Rain/Wet': 50,
    Night: 60,
    Custom: 80,
  });

  const customSpeedLimit = conditionSpeeds[selectedRoadCondition] ?? 80;

  const handleUpdateModalSpeed = (newSpeed) => {
    const clamped = Math.max(20, Math.min(140, newSpeed));
    setConditionSpeeds((prev) => ({
      ...prev,
      [selectedRoadCondition]: clamped,
      Custom: selectedRoadCondition === 'Custom' ? clamped : prev.Custom,
    }));
  };
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportingTargetUser, setReportingTargetUser] = useState(null);
  const [reportReason, setReportReason] = useState('Rash Riding / Overspeeding');
  const [reportDetails, setReportDetails] = useState('');
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [showKickModal, setShowKickModal] = useState(false);
  const [kickingTargetUser, setKickingTargetUser] = useState(null);
  const [kickReason, setKickReason] = useState('Violated convoy safety rules');
  const [isKickingRider, setIsKickingRider] = useState(false);
  const [isAssigningSweep, setIsAssigningSweep] = useState(false);

  const [isAdjustingLocation, setIsAdjustingLocation] = useState(false);
  const [pendingPin, setPendingPin] = useState(null);
  const [searchPlaceText, setSearchPlaceText] = useState('');
  const [isSavingPin, setIsSavingPin] = useState(false);
  const [stragglerBannerDismissed, setStragglerBannerDismissed] = useState(false);
  const pendingMarkerRef = useRef(null);
  const lastJoinToastRef = useRef(new Map());
  const lastDisconnectToastRef = useRef(new Map());

  // Expandable Scroll-to-Top & Convoy Quick-Tools State
  const [isScrollMenuOpen, setIsScrollMenuOpen] = useState(false);
  const [scrollMenuTab, setScrollMenuTab] = useState('tools'); // 'tools' or 'helmet_audio'
  const [pttChannel, setPttChannel] = useState('CONVOY'); // 'CONVOY' or 'LEAD_SWEEP'
  const [isPttMuted, setIsPttMuted] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState(getVoiceSettings);

  // Stage 10: Real-Time Road Hazard Crowdsourcing & Live Road Weather
  const [hazards, setHazards] = useState([]);
  const [activeHazardAlert, setActiveHazardAlert] = useState(null);
  const [showReportHazardModal, setShowReportHazardModal] = useState(false);
  const [selectedHazardType, setSelectedHazardType] = useState('POTHOLE');
  const [hazardNote, setHazardNote] = useState('');
  const [isReportingHazard, setIsReportingHazard] = useState(false);
  const [liveWeather, setLiveWeather] = useState(null);
  const [showWeatherModal, setShowWeatherModal] = useState(false);
  const [showSimulationModal, setShowSimulationModal] = useState(false);
  const hazardMarkersRef = useRef({});
  const lastHazardAlertTimesRef = useRef(new Map());

  // Stage 7: Offline & Dead-Zone Telemetry State
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [simulatedDeadZone, setSimulatedDeadZone] = useState(false);
  const [queuedPingsCount, setQueuedPingsCount] = useState(0);
  const [isSyncingBatch, setIsSyncingBatch] = useState(false);
  const [lowBandwidthMode, setLowBandwidthMode] = useState(() => {
    try {
      return localStorage.getItem('grouplock:low_bandwidth') === 'true';
    } catch {
      return false;
    }
  });

  const deadZoneReplayTrailsRef = useRef({});
  const lastBroadcastTimeRef = useRef(0);
  const lastBroadcastCoordRef = useRef(null);
  const isSyncingBatchRef = useRef(false);

  // Map references
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const riderMarkersRef = useRef({});
  const routePolylineRef = useRef(null);
  const traveledPolylineRef = useRef(null);
  const feederPolylinesRef = useRef({});
  const routeCoordinatesRef = useRef([]);
  const regroupMarkerRef = useRef(null);
  const regroupLineRef = useRef(null);
  const sosMarkerRef = useRef(null);
  const chatMessagesEndRef = useRef(null);

  // Convoy Members Roster for Private Chat and Roster Selection
  const convoyMembers = useMemo(() => {
    const memberMap = new Map();

    // 1. Add participants from ride
    if (Array.isArray(ride?.participants)) {
      ride.participants.forEach((p) => {
        const id = (p._id || p.id || p).toString();
        memberMap.set(id, {
          id,
          userId: id,
          name: p.name || 'Rider',
          email: p.email,
          phone: p.phone,
          bloodGroup: p.bloodGroup,
          profilePic: p.profilePic,
          role: p.role,
        });
      });
    }

    // 2. Add lead rider
    if (leadRider) {
      const id = (leadRider._id || leadRider.id || leadRider).toString();
      const existing = memberMap.get(id) || {};
      memberMap.set(id, {
        ...existing,
        id,
        userId: id,
        name: leadRider.name || existing.name || 'Lead Rider',
        profilePic: leadRider.profilePic || existing.profilePic,
        isLead: true,
      });
    }

    // 3. Add sweep rider
    if (sweepRider) {
      const id = (sweepRider._id || sweepRider.id || sweepRider).toString();
      const existing = memberMap.get(id) || {};
      memberMap.set(id, {
        ...existing,
        id,
        userId: id,
        name: sweepRider.name || existing.name || 'Sweep Rider',
        profilePic: sweepRider.profilePic || existing.profilePic,
        isSweep: true,
      });
    }

    // 4. Enrich from live active riders
    Object.values(riders).forEach((r) => {
      const id = (r.userId || r.id || r._id)?.toString();
      if (id) {
        const existing = memberMap.get(id) || {};
        memberMap.set(id, {
          ...existing,
          id,
          userId: id,
          name: r.name || existing.name || 'Rider',
          phone: r.phone || existing.phone,
          bloodGroup: r.bloodGroup || existing.bloodGroup,
          profilePic: r.profilePic || existing.profilePic,
          isOnline: true,
          isLead: r.isLead || existing.isLead,
          isSweep: r.isSweep || existing.isSweep,
        });
      }
    });

    return Array.from(memberMap.values());
  }, [ride, leadRider, sweepRider, riders]);

  // Filtered messages:
  // 'everyone' = public broadcast messages
  // userId = private 1-on-1 direct messages between current user and that recipient
  const filteredMessages = useMemo(() => {
    const myId = (user?.id || user?._id)?.toString();
    if (selectedChatRecipient === 'everyone') {
      return messages.filter((m) => !m.isPrivate && !m.recipient);
    }
    const targetId = selectedChatRecipient.toString();
    return messages.filter((m) => {
      if (!m.isPrivate && !m.recipient) return false;
      const sId = (m.sender?.id || m.sender?._id || m.sender)?.toString();
      const rId = (m.recipient?.id || m.recipient?._id || m.recipient)?.toString();
      return (
        (sId === myId && rId === targetId) ||
        (sId === targetId && rId === myId)
      );
    });
  }, [messages, selectedChatRecipient, user?.id, user?._id]);

  // Selected recipient user details
  const activeChatPartner = useMemo(() => {
    if (selectedChatRecipient === 'everyone') return null;
    return (
      convoyMembers.find((m) => m.id === selectedChatRecipient) || {
        id: selectedChatRecipient,
        name: 'Convoy Member',
      }
    );
  }, [selectedChatRecipient, convoyMembers]);

  // Auto-scroll chat to latest message
  useEffect(() => {
    if (isChatOpen && chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredMessages, isChatOpen]);

  // Listen for PRIMUS voice commands to open / close in-ride chat drawer
  useEffect(() => {
    const handleToggleChat = (e) => {
      if (typeof e.detail?.open === 'boolean') {
        setIsChatOpen(e.detail.open);
      } else {
        setIsChatOpen((prev) => !prev);
      }
    };
    window.addEventListener('primus:toggle_chat', handleToggleChat);
    return () => window.removeEventListener('primus:toggle_chat', handleToggleChat);
  }, []);

  const isLeader =
    ride && (
      (leadRider?._id || leadRider) === user?.id ||
      (ride.leadRider?._id || ride.leadRider) === user?.id ||
      ride.creator?._id === user?.id ||
      ride.creator === user?.id
    );

  // Toast Helper
  const addToast = useCallback((toast) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Stage 7: Synchronize Queued Offline Locations with Convoy
  const syncOfflineQueue = useCallback(async () => {
    if (isSyncingBatchRef.current || !rideId) return;

    try {
      const items = await getQueuedLocations(rideId);
      if (!items || items.length === 0) {
        setQueuedPingsCount(0);
        return;
      }

      isSyncingBatchRef.current = true;
      setIsSyncingBatch(true);

      const payloadLocations = items.map((i) => ({
        lat: i.lat,
        lng: i.lng,
        speed: i.speed,
        heading: i.heading,
        timestamp: i.timestamp,
      }));
      const itemIds = items.map((i) => i.id);

      const socket = getSocket();
      if (socket && socket.connected) {
        socket.emit('ride:batch_locations', { rideId, locations: payloadLocations }, async (res) => {
          if (res && res.success) {
            await removeQueuedLocations(itemIds);
            const remaining = await getQueuedCount(rideId);
            setQueuedPingsCount(remaining);
            playSoundNotification('join');
            addToast({
              type: 'join',
              title: '📶 Convoy Reconnected & Synced!',
              message: `Successfully synchronized ${items.length} offline GPS breadcrumb(s) recorded in dead zone!`,
            });
          }
          isSyncingBatchRef.current = false;
          setIsSyncingBatch(false);
        });
      } else if (token) {
        // Fallback to HTTP REST endpoint
        try {
          const res = await batchSyncLocations(rideId, payloadLocations, token);
          if (res && res.success) {
            await removeQueuedLocations(itemIds);
            const remaining = await getQueuedCount(rideId);
            setQueuedPingsCount(remaining);
            playSoundNotification('join');
            addToast({
              type: 'join',
              title: '📶 Convoy Reconnected (HTTP Sync)!',
              message: `Synchronized ${items.length} offline GPS breadcrumb(s) via secure fallback.`,
            });
          }
        } catch (httpErr) {
          console.warn('[OfflineSync] REST sync error:', httpErr);
        } finally {
          isSyncingBatchRef.current = false;
          setIsSyncingBatch(false);
        }
      } else {
        isSyncingBatchRef.current = false;
        setIsSyncingBatch(false);
      }
    } catch (err) {
      console.error('[OfflineSync] Error syncing queue:', err);
      isSyncingBatchRef.current = false;
      setIsSyncingBatch(false);
    }
  }, [rideId, token, addToast]);

  // Load initial queued count
  useEffect(() => {
    if (!rideId) return;
    getQueuedCount(rideId).then((cnt) => setQueuedPingsCount(cnt));
  }, [rideId]);

  // Network Online/Offline Listeners
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      addToast({
        type: 'join',
        title: '📶 Mobile Network Restored',
        message: 'Reconnected to internet. Automatically syncing dead-zone telemetry...',
      });
      speakVoiceAlert('Mobile network restored. Synchronizing convoy telemetry.', {
        priority: 'INFO',
        category: 'NETWORK',
      });
      syncOfflineQueue();
    };

    const handleOffline = () => {
      setIsOnline(false);
      addToast({
        type: 'warning',
        title: '📵 Entered Dead Zone',
        message: 'Mobile signal lost. Offline satellite GPS buffering is now ACTIVE.',
      });
      speakVoiceAlert('Warning: Mobile signal lost. Entering offline dead zone mode.', {
        priority: 'HIGH',
        category: 'NETWORK',
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [syncOfflineQueue, addToast]);

  const handleToggleSimulatedDeadZone = () => {
    setSimulatedDeadZone((prev) => {
      const nextVal = !prev;
      if (!nextVal) {
        // Disabling simulated dead zone -> sync!
        addToast({
          type: 'join',
          title: '📶 Signal Restored (Sim Ended)',
          message: 'Exited dead zone simulator. Triggering batch telemetry reconciliation...',
        });
        speakVoiceAlert('Cellular signal restored. Reconciling queued coordinates.', {
          priority: 'INFO',
          category: 'NETWORK',
        });
        setTimeout(() => syncOfflineQueue(), 300);
      } else {
        addToast({
          type: 'warning',
          title: '📵 Dead-Zone Simulation Active',
          message: 'Simulating cell loss (e.g. mountain pass). All GPS fixes will buffer in local IndexedDB.',
        });
        speakVoiceAlert('Dead zone simulator active. Switched to offline GPS buffering.', {
          priority: 'HIGH',
          category: 'NETWORK',
        });
      }
      return nextVal;
    });
  };

  const handleToggleLowBandwidth = () => {
    setLowBandwidthMode((prev) => {
      const nextVal = !prev;
      try {
        localStorage.setItem('grouplock:low_bandwidth', String(nextVal));
      } catch (_) {}
      addToast({
        type: 'info',
        title: nextVal ? '⚡ Low-Bandwidth Mode ON' : '🌐 Standard Telemetry Mode',
        message: nextVal
          ? 'Optimized for 2G/3G mountain routes: Throttles pings to save data & battery.'
          : 'Full real-time streaming enabled.',
      });
      return nextVal;
    });
  };

  // 1. Load Ride Data, Messages, and Alerts
  useEffect(() => {
    async function loadInitialData() {
      try {
        setLoading(true);
        const [rideRes, msgRes, alertRes, initialHazards] = await Promise.all([
          getRideDetails(rideId, token),
          getRideMessages(rideId, token).catch(() => ({ messages: [] })),
          getRideAlerts(rideId, token).catch(() => ({ alerts: [] })),
          fetchHazards(rideId, token).catch(() => []),
        ]);

        if (Array.isArray(initialHazards)) {
          setHazards(initialHazards);
        }

        const rideData = rideRes.ride;
        setRide(rideData);
        if (rideData.roadCondition) {
          setRoadCondition(rideData.roadCondition);
          setSelectedRoadCondition(rideData.roadCondition);
        }
        if (typeof rideData.speedLimit === 'number') {
          setSpeedLimit(rideData.speedLimit);
          if (rideData.roadCondition) {
            setConditionSpeeds((prev) => ({
              ...prev,
              [rideData.roadCondition]: rideData.speedLimit,
              Custom: rideData.roadCondition === 'Custom' ? rideData.speedLimit : prev.Custom,
            }));
          }
        }
        if (rideData.sweepRider) {
          setSweepRider(rideData.sweepRider);
        }
        if (rideData.leadRider) {
          setLeadRider(rideData.leadRider);
        }
        setMessages(msgRes.messages || []);
        if (alertRes.alerts && alertRes.alerts.length > 0) {
          setActiveSosAlert(alertRes.alerts[0]);
        }

        // Initialize riders state from ride participants so identification details are ready immediately
        const initialRiders = {};
        if (Array.isArray(rideData.participants)) {
          rideData.participants.forEach((p) => {
            const pId = (p._id || p.id || p).toString();
            initialRiders[pId] = {
              userId: pId,
              name: p.name || 'Rider',
              email: p.email,
              phone: p.phone,
              bloodGroup: p.bloodGroup,
              city: p.city,
              state: p.state,
              profilePic: p.profilePic,
              role: p.role,
              lat: null,
              lng: null,
              speed: 0,
              heading: 0,
              updatedAt: null,
            };
          });
        }

        // Include current user
        if (user) {
          initialRiders[user.id] = {
            ...(initialRiders[user.id] || {}),
            userId: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            bloodGroup: user.bloodGroup,
            city: user.city,
            state: user.state,
            profilePic: user.profilePic,
            role: user.role,
            lat: myLocation?.lat || null,
            lng: myLocation?.lng || null,
            speed: currentSpeed || 0,
          };
        }

        // Merge pre-shared rider locations from the scheduled phase
        if (Array.isArray(rideData.riderLocations)) {
          rideData.riderLocations.forEach((loc) => {
            const u = loc.user || {};
            const uId = (u._id || u.id || u).toString();
            if (initialRiders[uId] && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
              initialRiders[uId].lat = loc.lat;
              initialRiders[uId].lng = loc.lng;
              initialRiders[uId].updatedAt = loc.updatedAt;
            }
          });
        }

        setRiders((prev) => ({
          ...initialRiders,
          ...prev,
        }));
      } catch (err) {
        console.error('Error loading ride details:', err);
        setError('Could not load ride details.');
      } finally {
        setLoading(false);
      }
    }

    loadInitialData();
  }, [rideId, token]);

  // 2. Initialize Leaflet Map (Mounted once container exists)
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    try {
      const map = L.map(mapContainerRef.current, {
        zoomControl: false,
      }).setView([20.5937, 78.9629], 5);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      L.control.zoom({ position: 'topright' }).addTo(map);
      mapRef.current = map;
      setMapReady(true);

      // Force layout invalidation after DOM settlement
      setTimeout(() => {
        if (mapRef.current) {
          mapRef.current.invalidateSize();
        }
      }, 300);

      const handleResize = () => {
        if (mapRef.current) {
          mapRef.current.invalidateSize();
        }
      };
      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }
        setMapReady(false);
      };
    } catch (e) {
      console.error('Leaflet initialization error:', e);
    }
  }, []);

  // Invalidate map size when loading transitions to false
  useEffect(() => {
    if (!loading && mapRef.current) {
      setTimeout(() => {
        mapRef.current?.invalidateSize();
      }, 200);
    }
  }, [loading]);

  // 3. Load Route onto Map
  useEffect(() => {
    if (!mapRef.current || !ride || !mapReady) return;

    let isMounted = true;

    async function setupRoute() {
      try {
        let sCoords = (ride.startCoords && typeof ride.startCoords.lat === 'number')
          ? ride.startCoords
          : null;
        if (!sCoords) {
          sCoords = await geocodePlace(ride.startLocation);
        }

        let dCoords = (ride.destCoords && typeof ride.destCoords.lat === 'number')
          ? ride.destCoords
          : null;
        if (!dCoords) {
          dCoords = await geocodePlace(ride.destination);
        }

        if (!isMounted || !mapRef.current) return;

        if (sCoords && dCoords) {
          const routeData = await fetchRouteGeometry(sCoords, dCoords);

          if (!isMounted || !mapRef.current) return;

          let latLngs = [];
          if (routeData && routeData.latLngs && routeData.latLngs.length > 0) {
            latLngs = routeData.latLngs;
          } else {
            // Fallback straight line between start and dest
            latLngs = [
              [sCoords.lat, sCoords.lon ?? sCoords.lng],
              [dCoords.lat, dCoords.lon ?? dCoords.lng],
            ];
          }

          routeCoordinatesRef.current = latLngs;

          if (routePolylineRef.current && mapRef.current.hasLayer(routePolylineRef.current)) {
            mapRef.current.removeLayer(routePolylineRef.current);
          }

          // Draw Route Polyline
          const polyline = L.polyline(latLngs, {
            color: '#3b82f6',
            weight: 6,
            opacity: 0.85,
            lineJoin: 'round',
          }).addTo(mapRef.current);
          routePolylineRef.current = polyline;

          // Start Marker (Green A)
          const startIcon = L.divIcon({
            className: 'custom-pin',
            html: `<div style="background:#10b981;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,0.4)">A</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });

          // Finish Marker (Checkered Flag)
          const finishIcon = L.divIcon({
            className: 'custom-pin',
            html: `<div style="background:#ef4444;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:14px;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,0.4)">🏁</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });

          L.marker(latLngs[0], { icon: startIcon })
            .bindPopup(`<b>Start Point:</b><br/>${ride.startLocation}`)
            .addTo(mapRef.current);

          L.marker(latLngs[latLngs.length - 1], { icon: finishIcon })
            .bindPopup(`<b>Destination:</b><br/>${ride.destination}`)
            .addTo(mapRef.current);

          mapRef.current.fitBounds(polyline.getBounds(), { padding: [50, 50] });
          mapRef.current.invalidateSize();

          // Stage 7: Cache Route into IndexedDB for offline resiliency
          cacheRideRoute(rideId, {
            startLocation: ride.startLocation,
            destination: ride.destination,
            startCoords: sCoords,
            destCoords: dCoords,
            coordinates: latLngs,
            distanceKm: ride.distanceKm,
            durationMinutes: ride.durationMinutes,
            speedLimit: ride.speedLimit || 80,
            roadCondition: ride.roadCondition || 'Highway',
          });
        }
      } catch (e) {
        console.warn('Network route fetch failed, attempting offline cached route:', e);
        // Stage 7: Offline Route Fallback
        getCachedRideRoute(rideId).then((cached) => {
          if (cached && cached.coordinates && cached.coordinates.length > 0 && mapRef.current) {
            routeCoordinatesRef.current = cached.coordinates;
            if (routePolylineRef.current && mapRef.current.hasLayer(routePolylineRef.current)) {
              mapRef.current.removeLayer(routePolylineRef.current);
            }
            const polyline = L.polyline(cached.coordinates, {
              color: '#3b82f6',
              weight: 6,
              opacity: 0.85,
              lineJoin: 'round',
            }).addTo(mapRef.current);
            routePolylineRef.current = polyline;
            mapRef.current.fitBounds(polyline.getBounds(), { padding: [50, 50] });
            mapRef.current.invalidateSize();
          }
        });
      }
    }

    setupRoute();

    return () => {
      isMounted = false;
    };
  }, [ride, mapReady]);

  // 4. Socket.IO Connection & Real-time Event Handlers
  useEffect(() => {
    if (!token || !rideId) return;

    const socket = initSocket(token);

    // Join ride room with initial coordinates if available
    const initLoc = myLocationRef.current || lastGoodGpsRef.current;
    socket.emit(
      'join_ride',
      {
        rideId,
        lat: initLoc?.lat,
        lng: initLoc?.lng,
        accuracy: initLoc?.accuracy,
        speed: currentSpeedRef.current || 0,
        heading: currentHeadingRef.current || 0,
      },
      (res) => {
      if (res && res.success) {
        setRiders((prev) => {
          const updated = { ...prev };
          // Merge participants
          if (Array.isArray(res.participants)) {
            res.participants.forEach((p) => {
              const pId = (p._id || p.id || p).toString();
              updated[pId] = {
                ...(updated[pId] || {}),
                userId: pId,
                name: p.name || 'Rider',
                email: p.email,
                phone: p.phone,
                bloodGroup: p.bloodGroup,
                city: p.city,
                state: p.state,
                profilePic: p.profilePic,
                role: p.role,
              };
            });
          }
          // Merge active live GPS locations
          if (Array.isArray(res.riders)) {
            res.riders.forEach((r) => {
              updated[r.userId] = {
                ...(updated[r.userId] || {}),
                ...r,
              };
            });
          }
          return updated;
        });

        if (res.activeRegroup) {
          setActiveRegroup(res.activeRegroup);
        }

        if (res.ride) {
          if (res.ride.roadCondition) {
            setRoadCondition(res.ride.roadCondition);
            setSelectedRoadCondition(res.ride.roadCondition);
          }
          if (typeof res.ride.speedLimit === 'number') {
            setSpeedLimit(res.ride.speedLimit);
            setCustomSpeedLimit(res.ride.speedLimit);
          }
          if (res.ride.sweepRider) {
            setSweepRider(res.ride.sweepRider);
          }
        }

        // Stage 10: Sync active road hazards
        if (Array.isArray(res.hazards)) {
          setHazards(res.hazards);
        }
      }
    });

    // Real-time: Live location updates from other riders
    socket.on('rider:location_update', (riderData) => {
      setRiders((prev) => ({
        ...prev,
        [riderData.userId]: {
          ...(prev[riderData.userId] || {}),
          ...riderData,
          updatedAt: new Date().toISOString(),
        },
      }));
    });

    // Real-time: Rider Joined event (from phone or desktop)
    socket.on('rider:joined', (data) => {
      console.log('Realtime Rider Joined:', data);

      const now = Date.now();
      const lastJoinTime = lastJoinToastRef.current.get(data.userId) || 0;
      const isRecent = now - lastJoinTime < 45000;

      // Only play sound and show toast if not toasted in the last 45 seconds (prevents reconnect spam)
      if (!isRecent) {
        lastJoinToastRef.current.set(data.userId, now);
        // 1. Play sound
        playSoundNotification('join');

        // 2. Show prominent join notification toast
        addToast({
          type: 'join',
          title: 'Rider Joined Convoy!',
          message: `${data.name || 'A rider'} joined the live convoy.`,
          rider: data,
        });
      }

      // 3. Immediately update riders state in real time without refreshing
      setRiders((prev) => ({
        ...prev,
        [data.userId]: {
          ...(prev[data.userId] || {}),
          ...data,
          speed: data.speed || 0,
          updatedAt: new Date().toISOString(),
          isActive: true,
          isOffline: false,
        },
      }));

      // 4. Update ride participants list so header counter updates instantly
      setRide((prevRide) => {
        if (!prevRide) return prevRide;
        const currentParticipants = prevRide.participants || [];
        const exists = currentParticipants.some(
          (p) => (p._id || p.id || p).toString() === data.userId.toString()
        );
        if (exists) return prevRide;
        return {
          ...prevRide,
          participants: [...currentParticipants, data],
        };
      });

      // 5. Automatic Handshake: If we have an active GPS position, immediately reply by broadcasting our location
      // so the newly joined rider instantly sees our pin on their map without needing to refresh!
      const loc = myLocationRef.current || lastGoodGpsRef.current;
      if (loc && typeof loc.lat === 'number') {
        socket.emit('location:update', {
          rideId,
          lat: loc.lat,
          lng: loc.lng,
          accuracy: loc.accuracy || null,
          speed: currentSpeedRef.current || 0,
          heading: currentHeadingRef.current || 0,
        });
      }
    });

    // Real-time: Location Handshake Ping Request
    socket.on('request:location_ping', () => {
      const loc = myLocationRef.current || lastGoodGpsRef.current;
      if (loc && typeof loc.lat === 'number') {
        socket.emit('location:update', {
          rideId,
          lat: loc.lat,
          lng: loc.lng,
          accuracy: loc.accuracy || null,
          speed: currentSpeedRef.current || 0,
          heading: currentHeadingRef.current || 0,
        });
      }
    });

    // Real-time: Member Joined Group during active ride
    socket.on('group:member_joined', (data) => {
      console.log('Realtime Group Member Joined during active ride:', data);
      if (!data.member || !data.member.user) return;
      const u = data.member.user;
      const uId = (u._id || u.id || u).toString();

      setRide((prevRide) => {
        if (!prevRide) return prevRide;
        const currentParticipants = prevRide.participants || [];
        const exists = currentParticipants.some(
          (p) => (p._id || p.id || p).toString() === uId
        );
        if (exists) return prevRide;
        return {
          ...prevRide,
          participants: [...currentParticipants, u],
        };
      });

      setRiders((prev) => ({
        ...prev,
        [uId]: {
          ...(prev[uId] || {}),
          userId: uId,
          name: u.name || 'Rider',
          email: u.email,
          phone: u.phone,
          bloodGroup: u.bloodGroup,
          city: u.city,
          state: u.state,
          profilePic: u.profilePic,
          role: u.role || 'member',
          isActive: true,
          isOffline: false,
        },
      }));

      addToast({
        type: 'join',
        title: 'Rider Joined Group Convoy!',
        message: `${u.name || 'A rider'} joined the group and is now part of this convoy.`,
        rider: u,
      });

      // Handshake: Ping back our current coordinates so the new member sees us right away
      const currentLoc = myLocationRef.current || lastGoodGpsRef.current;
      if (currentLoc && typeof currentLoc.lat === 'number') {
        socket.emit('location:update', {
          rideId,
          lat: currentLoc.lat,
          lng: currentLoc.lng,
          accuracy: currentLoc.accuracy || null,
          speed: currentSpeedRef.current || 0,
          heading: currentHeadingRef.current || 0,
        });
      }
    });

    // Real-time: Rider Left / Disconnected (deduplicated to prevent notification flapping)
    socket.on('rider:left', (data) => {
      const now = Date.now();
      const lastLeftTime = lastDisconnectToastRef.current.get(`left:${data.userId}`) || 0;
      if (now - lastLeftTime > 30000) {
        lastDisconnectToastRef.current.set(`left:${data.userId}`, now);
        addToast({
          type: 'info',
          title: 'Rider Left',
          message: `${data.name || 'A rider'} left the convoy.`,
        });
      }
      setRiders((prev) => {
        const copy = { ...prev };
        if (copy[data.userId]) {
          copy[data.userId] = { ...copy[data.userId], isOffline: true, status: 'OFFLINE' };
        }
        return copy;
      });
    });

    socket.on('rider:disconnected', (data) => {
      const now = Date.now();
      const lastDiscTime = lastDisconnectToastRef.current.get(`disc:${data.userId}`) || 0;
      if (now - lastDiscTime > 45000) {
        lastDisconnectToastRef.current.set(`disc:${data.userId}`, now);
        addToast({
          type: 'warning',
          title: 'Rider Disconnected',
          message: `${data.name || 'A rider'} lost connection.`,
        });
      }
      setRiders((prev) => {
        const copy = { ...prev };
        if (copy[data.userId]) {
          copy[data.userId] = { ...copy[data.userId], isOffline: true, status: 'OFFLINE' };
        }
        return copy;
      });
    });

    // Real-time: Heartbeat / Status Update & Dead-Zone Detection
    socket.on('rider:status_update', (data) => {
      setRiders((prev) => {
        if (!prev[data.userId]) return prev;
        
        // Show notification toast if entered dead zone
        if (data.status === 'OFFLINE' && prev[data.userId].status !== 'OFFLINE') {
          addToast({
            type: 'warning',
            title: '📵 Rider In Dead Zone',
            message: `${prev[data.userId].name} entered a cellular dead zone. Last known location marked on map.`,
          });
        } else if (data.status === 'STALE' && prev[data.userId].status !== 'STALE') {
          addToast({
            type: 'warning',
            title: 'Stale GPS',
            message: `${prev[data.userId].name}'s location hasn't updated recently.`,
          });
        }
        
        return {
          ...prev,
          [data.userId]: {
            ...prev[data.userId],
            status: data.status,
            isOffline: data.status === 'OFFLINE',
            updatedAt: data.updatedAt,
            lastKnownLocation: data.lastKnownLocation || prev[data.userId].lastKnownLocation,
            deadZoneEnteredAt: data.deadZoneEnteredAt || prev[data.userId].deadZoneEnteredAt,
          }
        };
      });
    });

    // Stage 7: Real-time Reconnection & Batch Telemetry Synced
    socket.on('rider:batch_synced', (data) => {
      playSoundNotification('join');
      addToast({
        type: 'join',
        title: `📶 ${data.name} Reconnected!`,
        message: `Emerged from dead zone! Synced ${data.count} offline breadcrumb(s) (Peak speed: ${data.maxSpeed || 0} km/h).`,
      });

      // Update rider's state to LIVE
      if (data.latestLocation) {
        setRiders((prev) => ({
          ...prev,
          [data.userId]: {
            ...(prev[data.userId] || {}),
            ...data.latestLocation,
            status: 'LIVE',
            isOffline: false,
          },
        }));
      }

      // Reconstruct & Draw Dead-Zone Breadcrumb Replay Trail on Map
      if (mapRef.current && Array.isArray(data.breadcrumbs) && data.breadcrumbs.length > 1) {
        // Clear previous replay trail for this rider if any
        if (deadZoneReplayTrailsRef.current[data.userId] && mapRef.current.hasLayer(deadZoneReplayTrailsRef.current[data.userId])) {
          mapRef.current.removeLayer(deadZoneReplayTrailsRef.current[data.userId]);
        }

        const trail = L.polyline(data.breadcrumbs, {
          color: '#f59e0b', // Glowing amber trail
          weight: 5,
          dashArray: '6, 8',
          opacity: 0.95,
          lineJoin: 'round',
        }).addTo(mapRef.current);

        trail.bindTooltip(`📍 ${data.name} Dead-Zone Reconstructed Trail (${data.count} points)`, {
          sticky: true,
        });

        deadZoneReplayTrailsRef.current[data.userId] = trail;

        // Auto-fade and clean up after 45 seconds
        setTimeout(() => {
          if (deadZoneReplayTrailsRef.current[data.userId] && mapRef.current?.hasLayer(deadZoneReplayTrailsRef.current[data.userId])) {
            mapRef.current.removeLayer(deadZoneReplayTrailsRef.current[data.userId]);
            delete deadZoneReplayTrailsRef.current[data.userId];
          }
        }, 45000);
      }
    });

    // Socket connect / reconnect auto-sync trigger
    socket.on('connect', () => {
      if (!simulatedDeadZone) {
        setIsOnline(true);
        syncOfflineQueue();
      }
    });

    socket.on('disconnect', () => {
      if (!simulatedDeadZone) {
        setIsOnline(false);
      }
    });

    // Real-time: Group Health Update
    socket.on('ride:health_update', (data) => {
      setHealthScore(data.healthScore);
      setConvoySpread(data.maxSpreadKm);
      if (data.maxSpreadKm > 2.0) {
        speakVoiceAlert(`Convoy spread warning: Gap has reached ${data.maxSpreadKm.toFixed(1)} kilometers. Please adjust pace.`, {
          priority: 'WARNING',
          category: 'SEPARATION',
        });
      }
    });

    // Stage 6: Regroup Recommendation
    socket.on('regroup:recommendation', (data) => {
      setRegroupRecommendation(data);
    });

    // Stage 6: Active Regroup Triggered
    socket.on('regroup:active', (regroup) => {
      playSoundNotification('join');
      setActiveRegroup(regroup);
      setRegroupRecommendation(null);
      addToast({
        type: 'join',
        title: '🚩 REGROUP CALL BROADCAST',
        message: `${regroup.initiatedBy?.name || 'Convoy Leader'} requested regroup at "${regroup.haltName}"!`,
      });
      speakVoiceAlert(
        `Regroup order: ${regroup.initiatedBy?.name || 'Convoy Leader'} called a regroup halt at ${regroup.haltName || 'specified point'}. All riders please assemble.`,
        { priority: 'HIGH', category: 'REGROUP' }
      );
    });

    // Stage 6: Rider Acknowledged Regroup
    socket.on('regroup:rider_ack', (data) => {
      setActiveRegroup((prev) => {
        if (!prev || (prev.id && prev.id !== data.regroupId)) return prev;
        const acks = data.acks || (prev.acks ? [...prev.acks, data.userId] : [data.userId]);
        return { ...prev, acks };
      });
      addToast({
        type: 'info',
        title: 'Regroup Acknowledged',
        message: `${data.name} is heading to the regroup halt.`,
      });
    });

    // Stage 6: Regroup Resolved
    socket.on('regroup:resolved', ({ regroupId }) => {
      setActiveRegroup((prev) => (prev && prev.id === regroupId ? null : prev));
      addToast({
        type: 'info',
        title: 'Regroup Cleared',
        message: 'The convoy regroup call has been marked as resolved.',
      });
      speakVoiceAlert('Convoy regroup cleared. Resuming normal formation.', {
        priority: 'INFO',
        category: 'REGROUP',
      });
    });

    // Real-time: Ride Started
    socket.on('ride:started', () => {
      addToast({
        type: 'success',
        title: 'Ride Started!',
        message: 'The convoy is officially on the move! Ride safe.',
      });
      setRide((prev) => (prev ? { ...prev, status: 'ongoing' } : prev));
    });

    // Real-time: Ride Ended
    socket.on('ride:ended', () => {
      addToast({
        type: 'info',
        title: 'Ride Completed',
        message: 'The ride organizer has marked this ride as completed.',
      });
      setRide((prev) => (prev ? { ...prev, status: 'completed' } : prev));
    });

    // Real-time Chat (Convoy Broadcast or Private Direct Message)
    socket.on('chat:new_message', (msg) => {
      setMessages((prev) => [...prev, msg]);
      if (msg?.sender?.id !== user?.id) {
        playSoundNotification('join');
        if (msg?.isPrivate) {
          const senderId = msg.sender?.id;
          setUnreadPrivateCounts((prev) => ({
            ...prev,
            [senderId]: (prev[senderId] || 0) + 1,
          }));
          addToast({
            type: 'chat',
            isPrivate: true,
            senderId,
            title: `🔒 Direct Message from ${msg?.sender?.name || 'Rider'}`,
            message: msg?.text || '',
          });
        } else {
          addToast({
            type: 'chat',
            isPrivate: false,
            title: `💬 ${msg?.sender?.name || 'Rider'}`,
            message: msg?.text || '',
          });
        }
      }
    });

    // Real-time SOS Alert
    socket.on('sos:alert', (alert) => {
      playSoundNotification('sos');
      setActiveSosAlert(alert);
      const noteText = alert.note || alert.description || '';
      addToast({
        type: 'sos',
        title: '🚨 EMERGENCY SOS ALERT',
        message: `${alert.user?.name || 'A rider'} triggered an SOS!${noteText ? ` Note: "${noteText}"` : ''}`,
        alert,
      });
      speakVoiceAlert(
        `Emergency! SOS activated by ${alert.user?.name || 'convoy rider'}! ${noteText ? `Reported situation: ${noteText}. ` : ''}Location marked on map.`,
        {
          priority: 'CRITICAL',
          category: 'SOS',
        }
      );
    });

    // Stage 6: Real-time SOS Escalated
    socket.on('sos:escalated', (data) => {
      playSoundNotification('sos');
      setActiveSosAlert((prev) => ({
        ...(prev || {}),
        ...data,
        id: data.alertId,
        note: data.note || prev?.note || '',
        description: data.description || prev?.description || data.note || prev?.note || '',
      }));
      const noteText = data.note || data.description || '';
      addToast({
        type: 'sos',
        title: '🚨 SOS ALERT ESCALATED',
        message: `Alert escalated to ${
          data.escalationLevel === 'EMERGENCY_CONTACTS'
            ? 'Emergency ICE Contacts'
            : 'National Authorities / Services'
        }!${noteText ? ` Note: "${noteText}"` : ''}`,
      });
      speakVoiceAlert(
        `Emergency SOS escalated to ${
          data.escalationLevel === 'EMERGENCY_CONTACTS' ? 'emergency contacts' : 'authorities'
        }! ${noteText ? `Situation: ${noteText}.` : ''}`,
        { priority: 'CRITICAL', category: 'SOS' }
      );
    });

    socket.on('sos:resolved', ({ alertId }) => {
      setActiveSosAlert((current) => (current && current.id === alertId ? null : current));
      addToast({
        type: 'info',
        title: 'SOS Resolved',
        message: 'The emergency alert has been resolved.',
      });
      speakVoiceAlert('Emergency SOS has been resolved and cleared.', {
        priority: 'INFO',
        category: 'SOS',
      });
    });

    // Stage 4: Sweep Rider Assigned
    socket.on('sweep:assigned', (data) => {
      setSweepRider(data.sweepRider);
      addToast({
        type: 'join',
        title: '🛡️ Sweep (Tail) Rider Updated',
        message: data.sweepRider
          ? `${data.sweepRider.name} was assigned as Sweep (Tail) Rider.`
          : 'Sweep Rider position is now unassigned.',
      });
      if (data.sweepRider) {
        speakVoiceAlert(`${data.sweepRider.name} is now the appointed Sweep Rider.`, {
          priority: 'INFO',
          category: 'GENERAL',
        });
      }
    });

    // Convoy Roles Updated (Head & Tail)
    socket.on('lead:assigned', (data) => {
      setLeadRider(data.leadRider);
      addToast({
        type: 'join',
        title: '👑 Head Rider Updated',
        message: data.leadRider
          ? `${data.leadRider.name} was assigned as Head (Lead) Rider.`
          : 'Head Rider updated.',
      });
      if (data.leadRider) {
        speakVoiceAlert(`${data.leadRider.name} is now the appointed Head Rider.`, {
          priority: 'INFO',
          category: 'GENERAL',
        });
      }
    });

    socket.on('convoy_roles:updated', (data) => {
      if (data.leadRider) setLeadRider(data.leadRider);
      if (data.sweepRider !== undefined) setSweepRider(data.sweepRider);
    });

    // Stage 4: Speed Limit & Road Condition Updated
    socket.on('speed_limit:updated', (data) => {
      setRoadCondition(data.roadCondition);
      setSelectedRoadCondition(data.roadCondition);
      setSpeedLimit(data.speedLimit);
      setConditionSpeeds((prev) => ({
        ...prev,
        [data.roadCondition]: data.speedLimit,
        Custom: data.roadCondition === 'Custom' ? data.speedLimit : prev.Custom,
      }));
      addToast({
        type: 'info',
        title: '🛣️ Road Condition & Speed Updated',
        message: `Road: ${data.roadCondition} · Convoy Speed Limit: ${data.speedLimit} km/h`,
      });
      speakVoiceAlert(
        `Convoy speed limit updated to ${data.speedLimit} kilometers per hour for ${data.roadCondition} road.`,
        { priority: 'INFO', category: 'GENERAL' }
      );
    });

    // Stage 4: Overspeed & Aggressive Riding Alert
    socket.on('alert:overspeed', (data) => {
      playSoundNotification('sos');
      setOverspeedAlert(data);
      const isMe = data.userId === user?.id;
      addToast({
        type: 'sos',
        title: isMe ? '⚠️ SLOW DOWN! SPEED LIMIT EXCEEDED' : '⚠️ AGGRESSIVE RIDING ALERT',
        message: isMe
          ? `You are riding at ${data.speed} km/h (+${data.excess} km/h over ${data.speedLimit} km/h limit on ${data.roadCondition})!`
          : `${data.name} is speeding aggressively at ${data.speed} km/h (${data.speedLimit} km/h limit on ${data.roadCondition})!`,
      });
      if (isMe) {
        speakVoiceAlert(
          `Caution: Slow down! Your speed is ${data.speed} kilometers per hour. Limit is ${data.speedLimit}.`,
          { priority: 'WARNING', category: 'OVERSPEED' }
        );
      } else {
        speakVoiceAlert(
          `Warning: Convoy rider ${data.name} is speeding at ${data.speed} kilometers per hour.`,
          { priority: 'WARNING', category: 'OVERSPEED' }
        );
      }
      // Auto-clear banner after 14 seconds
      setTimeout(() => {
        setOverspeedAlert((curr) => (curr && curr.timestamp === data.timestamp ? null : curr));
      }, 14000);
    });

    // Stage 4: Rider Safety Report
    socket.on('rider:reported', (data) => {
      addToast({
        type: 'warning',
        title: '🚨 Rider Violation Reported',
        message: `${data.reportedUser?.name} was reported by ${data.reportedBy?.name} for "${data.reason}".`,
      });
    });

    // Stage 4: Rider Kicked / Removed from Convoy
    socket.on('rider:kicked', (data) => {
      if (data.userId === user?.id) {
        setKickedNotice(data);
      } else {
        // Remove from riders list
        setRiders((prev) => {
          const updated = { ...prev };
          delete updated[data.userId];
          return updated;
        });

        // Remove marker from map
        if (riderMarkersRef.current[data.userId]) {
          mapRef.current?.removeLayer(riderMarkersRef.current[data.userId]);
          delete riderMarkersRef.current[data.userId];
        }

        addToast({
          type: 'warning',
          title: '🚫 Member Removed from Convoy',
          message: `${data.name} was removed from the ride convoy: ${data.reason}`,
        });
      }
    });

    // Stage 10: Real-Time Road Hazard Crowdsourcing Events
    socket.on('hazard:new', (newHazard) => {
      setHazards((prev) => {
        const newId = (newHazard._id || newHazard.id)?.toString();
        if (prev.some((h) => (h._id || h.id)?.toString() === newId)) {
          return prev;
        }
        return [newHazard, ...prev];
      });
      playAudioChime('WARNING');
      speakVoiceAlert(
        `Caution: ${newHazard.type.toLowerCase().replace('_', ' ')} reported on road by ${newHazard.reportedBy?.name || 'convoy rider'}`,
        'WARNING'
      );
      addToast({
        type: 'warning',
        title: `⚠️ Road Hazard: ${newHazard.title || newHazard.type.replace('_', ' ')}`,
        message: `${newHazard.reportedBy?.name || 'Rider'} reported a hazard ahead. Caution advised!`,
      });
    });

    socket.on('hazard:confirmed', ({ hazardId, confirmationsCount, confirmations }) => {
      setHazards((prev) =>
        prev.map((h) => {
          if ((h._id || h.id)?.toString() === hazardId?.toString()) {
            return { ...h, confirmationsCount, confirmations };
          }
          return h;
        })
      );
    });

    socket.on('hazard:resolved', ({ hazardId, resolvedByName }) => {
      setHazards((prev) => prev.filter((h) => (h._id || h.id)?.toString() !== hazardId?.toString()));
      addToast({
        type: 'success',
        title: '✅ Hazard Cleared',
        message: `Road hazard was cleared${resolvedByName ? ` by ${resolvedByName}` : ''}.`,
      });
    });

    return () => {
      socket.emit('leave_ride', { rideId });
      socket.off('rider:location_update');
      socket.off('rider:joined');
      socket.off('group:member_joined');
      socket.off('request:location_ping');
      socket.off('rider:left');
      socket.off('rider:disconnected');
      socket.off('ride:started');
      socket.off('ride:ended');
      socket.off('chat:new_message');
      socket.off('sos:alert');
      socket.off('sos:escalated');
      socket.off('sos:resolved');
      socket.off('rider:status_update');
      socket.off('ride:health_update');
      socket.off('regroup:active');
      socket.off('regroup:rider_ack');
      socket.off('regroup:resolved');
      socket.off('regroup:recommendation');
      socket.off('sweep:assigned');
      socket.off('lead:assigned');
      socket.off('convoy_roles:updated');
      socket.off('speed_limit:updated');
      socket.off('alert:overspeed');
      socket.off('rider:reported');
      socket.off('rider:kicked');
      socket.off('rider:batch_synced');
      socket.off('hazard:new');
      socket.off('hazard:confirmed');
      socket.off('hazard:resolved');
      socket.off('connect');
      socket.off('disconnect');
    };
  }, [rideId, token, addToast, user?.id, syncOfflineQueue, simulatedDeadZone]);

  // Helper to format exact GPS coordinates and update Leaflet marker popup
  const formatPopupHtml = (riderData, isConvoyLeader, isSelf, isSweepRider, isOverspeeding) => {
    const latStr = typeof riderData.lat === 'number' ? riderData.lat.toFixed(5) : 'N/A';
    const lngStr = typeof riderData.lng === 'number' ? riderData.lng.toFixed(5) : 'N/A';
    const speedStr = typeof riderData.speed === 'number' ? `${riderData.speed} km/h` : '0 km/h';

    return `
      <div style="font-family:ui-sans-serif,system-ui,sans-serif;min-width:220px;padding:4px;color:#0f172a;">
        <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:8px;">
          <div style="width:34px;height:34px;border-radius:50%;background:#1e293b;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;overflow:hidden;flex-shrink:0;">
            ${
              riderData.profilePic
                ? `<img src="${riderData.profilePic}" style="width:100%;height:100%;object-fit:cover;" />`
                : (riderData.name || 'R').charAt(0).toUpperCase()
            }
          </div>
          <div>
            <div style="font-weight:700;font-size:13px;line-height:1.2;color:#0f172a;">
              ${riderData.name} ${isSelf ? '<span style="color:#059669;font-size:11px;">(You)</span>' : ''}
            </div>
            <div style="font-size:11px;font-weight:600;display:flex;gap:4px;flex-wrap:wrap;margin-top:2px;">
              ${isConvoyLeader ? '<span style="color:#d97706;">👑 Convoy Leader</span>' : ''}
              ${isSweepRider ? '<span style="color:#7c3aed;">🛡️ Sweep (Tail) Rider</span>' : ''}
              ${!isConvoyLeader && !isSweepRider ? '<span style="color:#2563eb;">🏍️ Convoy Rider</span>' : ''}
            </div>
          </div>
        </div>

        ${
          riderData.status === 'OFFLINE' || riderData.isOffline
            ? `<div style="background:#fffbeb;border:1px solid #f59e0b;color:#92400e;padding:5px 8px;border-radius:6px;font-weight:700;font-size:11px;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
                <span style="font-size:15px;">📵</span>
                <div>
                  <div style="font-weight:800;color:#b45309;">IN CELLULAR DEAD ZONE</div>
                  <div style="font-size:10px;font-weight:500;color:#78350f;">
                    ${riderData.deadZoneEnteredAt ? `Signal dropped ~${Math.max(1, Math.round((Date.now() - riderData.deadZoneEnteredAt)/60000))}m ago.` : 'No cell connection.'}
                    Telemetry buffering offline.
                  </div>
                </div>
              </div>`
            : ''
        }

        ${
          isOverspeeding
            ? `<div style="background:#fef2f2;border:1px solid #f87171;color:#b91c1c;padding:4px 6px;border-radius:4px;font-weight:700;font-size:11px;margin-bottom:6px;display:flex;align-items:center;gap:4px;">
                <span>⚠️</span>
                <span>OVERSPEEDING (${riderData.speed} km/h · Limit: ${speedLimit} km/h)</span>
              </div>`
            : ''
        }

        <div style="display:flex;flex-direction:column;gap:5px;font-size:11px;">
          <!-- Blood Group -->
          <div style="display:flex;align-items:center;justify-content:space-between;background:#fee2e2;padding:3px 6px;border-radius:4px;border:1px solid #fca5a5;">
            <span style="color:#991b1b;font-weight:600;">🩸 Blood Group:</span>
            <span style="color:#b91c1c;font-weight:800;font-size:12px;">${riderData.bloodGroup || 'Not Specified'}</span>
          </div>

          <!-- Phone -->
          ${
            riderData.phone
              ? `
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <span style="color:#64748b;">📞 Phone:</span>
              <a href="tel:${riderData.phone}" style="color:#2563eb;font-weight:600;text-decoration:underline;">
                ${riderData.phone}
              </a>
            </div>
          `
              : ''
          }

          <!-- Exact Location Coordinates -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;background:#f8fafc;padding:3px 6px;border-radius:4px;border:1px solid #e2e8f0;">
            <span style="color:#64748b;">📍 Exact GPS:</span>
            <span style="font-family:monospace;font-weight:600;color:#0f172a;">${latStr}, ${lngStr}</span>
          </div>

          <!-- Speed -->
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="color:#64748b;">⚡ Live Speed:</span>
            <span style="font-weight:700;color:${isOverspeeding ? '#dc2626' : '#059669'};">${speedStr}</span>
          </div>

          <!-- Connection Status -->
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="color:#64748b;">📡 Status:</span>
            <span style="font-weight:700;color:${riderData.status === 'OFFLINE' || riderData.isOffline ? '#d97706' : riderData.status === 'STALE' ? '#ef4444' : riderData.status === 'WEAK' ? '#f97316' : '#10b981'};">
              ${riderData.status === 'OFFLINE' || riderData.isOffline ? '📵 DEAD ZONE (OFFLINE)' : riderData.status || 'LIVE'}
            </span>
          </div>

          <!-- Updated time -->
          <div style="font-size:10px;color:#94a3b8;text-align:right;margin-top:2px;">
            Updated: ${riderData.updatedAt ? new Date(riderData.updatedAt).toLocaleTimeString() : 'Just now'}
          </div>

          ${
            !isSelf
              ? `<div style="margin-top:4px;border-top:1px solid #f1f5f9;padding-top:4px;display:flex;justify-content:flex-end;">
                  <button
                    onclick="window.__groupLockReportRider && window.__groupLockReportRider('${riderData.userId}')"
                    style="background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:3px 8px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:3px;"
                  >
                    <span>🚨</span>
                    <span>Report Rider</span>
                  </button>
                </div>`
              : ''
          }
        </div>
      </div>
    `;
  };

  // Helper to create or update Leaflet markers for all riders
  const updateRiderMarker = useCallback(
    (riderId, riderData, isSelf = false) => {
      if (!mapRef.current || typeof riderData.lat !== 'number' || typeof riderData.lng !== 'number') {
        return;
      }

      const leadId = (leadRider?._id || leadRider || ride?.leadRider?._id || ride?.leadRider || ride?.creator?._id || ride?.creator)?.toString();
      const isConvoyLeader = Boolean(leadId && leadId === riderId.toString());
      const sweepId = sweepRider?._id || sweepRider;
      const isSweepRider = Boolean(sweepId && sweepId.toString() === riderId.toString());
      const isOverspeeding = Boolean(overspeedAlert && overspeedAlert.userId === riderId);
      const isDeadZone = Boolean(riderData.status === 'OFFLINE' || riderData.isOffline);
      
      let badgeColor = isSelf ? '#10b981' : '#3b82f6';
      if (isSweepRider) badgeColor = '#8b5cf6'; // Violet for Sweep
      if (isConvoyLeader) badgeColor = '#f59e0b'; // Amber for Leader
      if (isOverspeeding) badgeColor = '#ef4444'; // Red for Overspeeding
      if (isDeadZone) badgeColor = '#f59e0b'; // Amber border for dead-zone ghost marker
      
      // Override color for health status if weak or stale
      if (riderData.status === 'STALE') badgeColor = '#ef4444'; // red
      else if (riderData.status === 'WEAK') badgeColor = '#f97316'; // orange

      const initials = (riderData.name || 'R')
        .split(' ')
        .map((n) => n[0])
        .join('')
        .substring(0, 2)
        .toUpperCase();

      const avatarHtml = riderData.profilePic
        ? `<img src="${riderData.profilePic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;${isDeadZone ? 'filter:grayscale(80%);opacity:0.75;' : ''}" />`
        : `<span style="color:#fff;font-weight:bold;font-size:11px;">${initials}</span>`;

      // Top Icon Badge
      let topIconHtml = '';
      if (isDeadZone) {
        topIconHtml = `<span style="position:absolute;top:-10px;font-size:15px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6));" class="animate-pulse">📵</span>`;
      } else if (isOverspeeding) {
        topIconHtml = `<span style="position:absolute;top:-10px;font-size:16px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));" class="animate-bounce">⚠️</span>`;
      } else if (isConvoyLeader) {
        topIconHtml = `<span style="position:absolute;top:-9px;font-size:14px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">👑</span>`;
      } else if (isSweepRider) {
        topIconHtml = `<span style="position:absolute;top:-10px;font-size:15px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">🛡️</span>`;
      }

      const markerHtml = `
        <div style="position:relative;display:flex;flex-direction:column;align-items:center;cursor:pointer;${isDeadZone ? 'opacity:0.85;' : ''}">
          <div style="
            width: 38px;
            height: 38px;
            border-radius: 50%;
            border: 3px solid ${badgeColor};
            background: #1e293b;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: ${isDeadZone ? '0 0 16px 3px rgba(245, 158, 11, 0.75)' : isOverspeeding ? '0 0 18px 4px rgba(239, 68, 68, 0.95)' : '0 4px 12px rgba(0,0,0,0.4)'};
            overflow: hidden;
            position: relative;
          ">
            ${avatarHtml}
          </div>
          ${topIconHtml}
          <div style="
            margin-top: 2px;
            background: ${
              isOverspeeding ? 'rgba(220, 38, 38, 0.96)' :
              isDeadZone ? 'rgba(180, 83, 9, 0.95)' : 
              riderData.status === 'STALE' ? 'rgba(220, 38, 38, 0.92)' : 
              'rgba(15, 23, 42, 0.92)'};
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            padding: 1px 6px;
            border-radius: 5px;
            white-space: nowrap;
            border: 1px solid rgba(255,255,255,0.25);
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          ">
            ${(riderData.name || 'Rider').split(' ')[0]} ${
              isDeadZone ? '· 📵 DEAD ZONE' :
              isOverspeeding ? `· ⚠️ ${riderData.speed}kph` :
              isSweepRider ? '· 🛡️ SWEEP' :
              riderData.status === 'STALE' ? '· STALE' : 
              riderData.speed ? `· ${riderData.speed}kph` : ''}
          </div>
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'rider-live-marker',
        html: markerHtml,
        iconSize: [44, 56],
        iconAnchor: [22, 19],
      });

      const popupHtml = formatPopupHtml(riderData, isConvoyLeader, isSelf, isSweepRider, isOverspeeding);

      if (riderMarkersRef.current[riderId]) {
        riderMarkersRef.current[riderId].setLatLng([riderData.lat, riderData.lng]);
        riderMarkersRef.current[riderId].setIcon(customIcon);
        riderMarkersRef.current[riderId].setPopupContent(popupHtml);
      } else {
        const marker = L.marker([riderData.lat, riderData.lng], { icon: customIcon }).addTo(
          mapRef.current
        );

        marker.bindPopup(popupHtml, { maxWidth: 280 });
        marker.bindTooltip(`${riderData.name}${isDeadZone ? ' (📵 In Dead Zone)' : isSweepRider ? ' (Sweep 🛡️)' : ''}${riderData.speed ? ` (${riderData.speed} km/h)` : ''}`, {
          direction: 'top',
          offset: [0, -25],
        });

        riderMarkersRef.current[riderId] = marker;
      }
    },
    [ride, leadRider, sweepRider, overspeedAlert, speedLimit]
  );

  // Update map markers whenever riders state changes OR map becomes ready
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const myId = (user?.id || user?._id)?.toString();
    Object.entries(riders).forEach(([rId, rData]) => {
      updateRiderMarker(rId, rData, Boolean(myId && rId.toString() === myId));
    });
  }, [riders, updateRiderMarker, user, mapReady]);

  // Initial Auto-Fit or Auto-Center on Convoy Riders / Self
  const hasAutoCenteredRef = useRef(false);
  useEffect(() => {
    if (!mapRef.current || !mapReady || hasAutoCenteredRef.current) return;
    const validCoords = Object.values(riders)
      .filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number' && r.status !== 'LEFT')
      .map((r) => [r.lat, r.lng]);

    if (validCoords.length > 1) {
      mapRef.current.fitBounds(validCoords, { padding: [50, 50], maxZoom: 16 });
      hasAutoCenteredRef.current = true;
    } else if (validCoords.length === 1) {
      mapRef.current.setView(validCoords[0], 16, { animate: true });
      hasAutoCenteredRef.current = true;
    } else if (myLocation && typeof myLocation.lat === 'number' && typeof myLocation.lng === 'number') {
      mapRef.current.setView([myLocation.lat, myLocation.lng], 16, { animate: true });
      hasAutoCenteredRef.current = true;
    }
  }, [mapReady, riders, myLocation]);

  // Stage 10: Sync Interactive Hazard Markers on Leaflet Map
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    const currentHazardIds = new Set(hazards.map((h) => (h._id || h.id)?.toString()));

    // 1. Remove markers for resolved/deleted hazards
    Object.keys(hazardMarkersRef.current).forEach((hId) => {
      if (!currentHazardIds.has(hId)) {
        if (hazardMarkersRef.current[hId]) {
          mapRef.current.removeLayer(hazardMarkersRef.current[hId]);
          delete hazardMarkersRef.current[hId];
        }
      }
    });

    // 2. Add or update markers for active hazards
    hazards.forEach((hazard) => {
      const hId = (hazard._id || hazard.id)?.toString();
      if (!hId || !hazard.location || typeof hazard.location.lat !== 'number' || typeof hazard.location.lng !== 'number') return;

      const iconData = getHazardIconData(hazard.type);
      const customIcon = L.divIcon({
        className: 'hazard-marker-pin',
        html: `
          <div style="
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: ${iconData.bg};
            border: 2px solid white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            box-shadow: 0 0 12px ${iconData.glow};
            cursor: pointer;
            transition: transform 0.2s;
          ">
            ${iconData.symbol}
          </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });

      const distKm = myLocation
        ? calculateDistanceKm(myLocation.lat, myLocation.lng, hazard.location.lat, hazard.location.lng)
        : null;
      const distText = distKm !== null ? (distKm < 1 ? `${Math.round(distKm * 1000)}m away` : `${distKm.toFixed(1)}km away`) : '';

      const popupHtml = `
        <div style="min-width: 210px; padding: 4px; font-family: ui-sans-serif, system-ui, sans-serif; user-select: none;">
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
            <span style="font-size: 20px;">${iconData.symbol}</span>
            <div>
              <strong style="color: #0f172a; font-size: 13px; display: block; line-height: 1.2;">${hazard.title || hazard.type.replace('_', ' ')}</strong>
              <span style="font-size: 9px; background: #fef3c7; color: #92400e; padding: 1px 5px; border-radius: 4px; font-weight: bold; text-transform: uppercase;">
                ${hazard.severity || 'WARNING'}
              </span>
            </div>
          </div>
          ${hazard.description ? `<p style="font-size: 11px; color: #475569; margin: 4px 0 6px 0; line-height: 1.3;">${hazard.description}</p>` : ''}
          <div style="font-size: 10px; color: #64748b; margin-bottom: 8px;">
            Reported by <strong>${hazard.reportedBy?.name || 'Convoy Rider'}</strong>
            ${distText ? ` • <strong style="color: #d97706;">${distText}</strong>` : ''}
          </div>
          <div style="display: flex; gap: 6px;">
            <button 
              type="button"
              onclick="if(window.__groupLockConfirmHazard){window.__groupLockConfirmHazard('${hId}', event);}" 
              ontouchend="if(window.__groupLockConfirmHazard){window.__groupLockConfirmHazard('${hId}', event);}"
              style="flex: 1; background: #059669; color: white; border: none; border-radius: 8px; padding: 7px 8px; font-size: 11px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 3px; touch-action: manipulation; -webkit-tap-highlight-color: transparent; box-shadow: 0 1px 3px rgba(0,0,0,0.15);"
            >
              <span>✅</span> <span>Still There (${hazard.confirmations?.length || 1})</span>
            </button>
            <button 
              type="button"
              onclick="if(window.__groupLockResolveHazard){window.__groupLockResolveHazard('${hId}', event);}" 
              ontouchend="if(window.__groupLockResolveHazard){window.__groupLockResolveHazard('${hId}', event);}"
              style="flex: 1; background: #dc2626; color: white; border: none; border-radius: 8px; padding: 7px 8px; font-size: 11px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 3px; touch-action: manipulation; -webkit-tap-highlight-color: transparent; box-shadow: 0 1px 3px rgba(0,0,0,0.15);"
            >
              <span>✕</span> <span>Cleared</span>
            </button>
          </div>
        </div>
      `;

      if (hazardMarkersRef.current[hId]) {
        hazardMarkersRef.current[hId].setLatLng([hazard.location.lat, hazard.location.lng]);
        hazardMarkersRef.current[hId].setIcon(customIcon);
        hazardMarkersRef.current[hId].setPopupContent(popupHtml);
      } else {
        const marker = L.marker([hazard.location.lat, hazard.location.lng], { icon: customIcon }).addTo(mapRef.current);
        marker.bindPopup(popupHtml, { maxWidth: 280, closeButton: true });
        marker.on('popupopen', (e) => {
          const popupEl = e.popup?.getElement?.() || document.querySelector('.leaflet-popup');
          if (popupEl && window.L?.DomEvent) {
            window.L.DomEvent.disableClickPropagation(popupEl);
            window.L.DomEvent.disableScrollPropagation(popupEl);
          }
        });
        hazardMarkersRef.current[hId] = marker;
      }
    });
  }, [hazards, myLocation, mapReady]);

  // Stage 10: Real-Time Road Hazard Proximity Alert Engine (500m proximity)
  useEffect(() => {
    if (!myLocation || !Array.isArray(hazards) || hazards.length === 0) {
      setActiveHazardAlert(null);
      return;
    }

    const now = Date.now();
    let closestHazard = null;
    let minDistanceM = Infinity;

    hazards.forEach((hazard) => {
      if (!hazard.location || typeof hazard.location.lat !== 'number' || typeof hazard.location.lng !== 'number') return;
      const distKm = calculateDistanceKm(
        myLocation.lat,
        myLocation.lng,
        hazard.location.lat,
        hazard.location.lng
      );
      if (distKm !== null) {
        const distM = Math.round(distKm * 1000);
        if (distM <= 500 && distM < minDistanceM) {
          minDistanceM = distM;
          closestHazard = { ...hazard, distanceM: distM };
        }
      }
    });

    if (closestHazard) {
      setActiveHazardAlert(closestHazard);
      const hKey = (closestHazard._id || closestHazard.id)?.toString();
      const lastAlert = lastHazardAlertTimesRef.current.get(hKey) || 0;
      // 45-second cooldown per hazard for spoken audio alert
      if (now - lastAlert > 45000) {
        lastHazardAlertTimesRef.current.set(hKey, now);
        playAudioChime('WARNING');
        speakVoiceAlert(
          `Caution! ${closestHazard.type.toLowerCase().replace('_', ' ')} ${closestHazard.distanceM} meters ahead!`,
          'WARNING'
        );
      }
    } else {
      setActiveHazardAlert(null);
    }
  }, [myLocation, hazards]);

  // Stage 10: Live Road Weather Monitoring (Open-Meteo)
  useEffect(() => {
    const targetLat = myLocation?.lat ?? ride?.startCoords?.lat;
    const targetLng = myLocation?.lng ?? ride?.startCoords?.lng;
    if (typeof targetLat !== 'number' || typeof targetLng !== 'number' || isNaN(targetLat) || isNaN(targetLng)) return;

    let isMounted = true;
    async function updateWeather() {
      const data = await fetchLiveRoadWeather(targetLat, targetLng);
      if (isMounted && data) {
        setLiveWeather(data);
      }
    }

    updateWeather();
    const interval = setInterval(updateWeather, 5 * 60 * 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [myLocation?.lat, myLocation?.lng, ride?.startCoords?.lat, ride?.startCoords?.lng]);

  // Dynamic Route Shortening (Google Maps style) & Co-Rider to Leader Routes
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    // --- A. Route Shortening as Rider Progresses (Google Maps style) ---
    const fullRoute = routeCoordinatesRef.current;
    if (fullRoute && fullRoute.length > 1 && myLocation && typeof myLocation.lat === 'number' && typeof myLocation.lng === 'number') {
      let minDistance = Infinity;
      let closestIdx = 0;

      for (let i = 0; i < fullRoute.length; i++) {
        const pt = fullRoute[i];
        const dist = calculateDistanceKm(myLocation.lat, myLocation.lng, pt[0], pt[1]);
        if (dist !== null && dist < minDistance) {
          minDistance = dist;
          closestIdx = i;
        }
      }

      // If user is within 500m of the route line, trim and shorten the blue route line ahead
      if (minDistance < 0.5) {
        const remainingRoute = [[myLocation.lat, myLocation.lng], ...fullRoute.slice(closestIdx + 1)];
        if (remainingRoute.length >= 2 && routePolylineRef.current) {
          routePolylineRef.current.setLatLngs(remainingRoute);
        }

        // Traveled route behind in subtle faded line
        const traveledRoute = [...fullRoute.slice(0, closestIdx + 1), [myLocation.lat, myLocation.lng]];
        if (traveledRoute.length >= 2) {
          if (traveledPolylineRef.current && mapRef.current.hasLayer(traveledPolylineRef.current)) {
            traveledPolylineRef.current.setLatLngs(traveledRoute);
          } else {
            traveledPolylineRef.current = L.polyline(traveledRoute, {
              color: '#94a3b8',
              weight: 4,
              opacity: 0.5,
              lineJoin: 'round',
            }).addTo(mapRef.current);
          }
        }
      }
    }

    // --- B. Co-Rider to Leader Route Preview & Live Tracking ---
    const leaderId = (ride?.creator?._id || ride?.creator)?.toString();
    const leaderData = leaderId ? riders[leaderId] : null;

    let targetLeaderCoords = null;
    if (leaderData && typeof leaderData.lat === 'number' && typeof leaderData.lng === 'number' && leaderData.status !== 'OFFLINE') {
      targetLeaderCoords = { lat: leaderData.lat, lng: leaderData.lng };
    } else if (ride?.startCoords && typeof ride.startCoords.lat === 'number' && typeof ride.startCoords.lng === 'number') {
      targetLeaderCoords = { lat: ride.startCoords.lat, lng: ride.startCoords.lng };
    } else if (fullRoute && fullRoute.length > 0) {
      targetLeaderCoords = { lat: fullRoute[0][0], lng: fullRoute[0][1] };
    }

    if (targetLeaderCoords) {
      Object.entries(riders).forEach(([rId, rData]) => {
        // Only draw feeder route for co-riders (not the leader themselves)
        if (rId === leaderId || typeof rData.lat !== 'number' || typeof rData.lng !== 'number' || rData.status === 'OFFLINE') {
          if (feederPolylinesRef.current[rId] && mapRef.current.hasLayer(feederPolylinesRef.current[rId])) {
            mapRef.current.removeLayer(feederPolylinesRef.current[rId]);
            delete feederPolylinesRef.current[rId];
          }
          return;
        }

        const distToLeader = calculateDistanceKm(rData.lat, rData.lng, targetLeaderCoords.lat, targetLeaderCoords.lng);
        if (distToLeader && distToLeader > 0.05) {
          const feederCoords = [
            [rData.lat, rData.lng],
            [targetLeaderCoords.lat, targetLeaderCoords.lng],
          ];

          if (feederPolylinesRef.current[rId] && mapRef.current.hasLayer(feederPolylinesRef.current[rId])) {
            feederPolylinesRef.current[rId].setLatLngs(feederCoords);
          } else {
            const feederLine = L.polyline(feederCoords, {
              color: '#9333ea',
              weight: 4,
              dashArray: '6, 8',
              opacity: 0.85,
              lineJoin: 'round',
            }).addTo(mapRef.current);

            feederLine.bindTooltip(`🏍️ ${rData.name || 'Co-Rider'} → Route to Leader (${distToLeader} km)`, {
              sticky: true,
            });

            feederPolylinesRef.current[rId] = feederLine;
          }
        } else {
          if (feederPolylinesRef.current[rId] && mapRef.current.hasLayer(feederPolylinesRef.current[rId])) {
            mapRef.current.removeLayer(feederPolylinesRef.current[rId]);
            delete feederPolylinesRef.current[rId];
          }
        }
      });
    }
  }, [myLocation, riders, ride, mapReady]);

  // Stage 6: Regroup Halt Marker & Guidance Line on Map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (
      activeRegroup &&
      activeRegroup.location &&
      typeof activeRegroup.location.lat === 'number' &&
      typeof activeRegroup.location.lng === 'number'
    ) {
      const { lat, lng } = activeRegroup.location;
      const regroupIcon = L.divIcon({
        className: 'regroup-live-marker',
        html: `
          <div style="position:relative;display:flex;flex-direction:column;align-items:center;cursor:pointer;">
            <div style="position:absolute;top:-10px;left:-10px;width:58px;height:58px;border-radius:50%;background:rgba(239, 68, 68, 0.4);animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;"></div>
            <div style="
              width: 40px;
              height: 40px;
              border-radius: 50%;
              background: #dc2626;
              color: white;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 22px;
              border: 3px solid #ffffff;
              box-shadow: 0 4px 18px rgba(0,0,0,0.6);
              position: relative;
              z-index: 10;
            ">
              🎯
            </div>
            <div style="
              margin-top: 3px;
              background: #991b1b;
              color: #ffffff;
              font-size: 11px;
              font-weight: 800;
              padding: 2px 8px;
              border-radius: 6px;
              white-space: nowrap;
              border: 1px solid rgba(255,255,255,0.7);
              box-shadow: 0 2px 8px rgba(0,0,0,0.4);
              z-index: 10;
            ">
              ${activeRegroup.haltName || 'REGROUP HALT'}
            </div>
          </div>
        `,
        iconSize: [48, 64],
        iconAnchor: [24, 32],
      });

      if (regroupMarkerRef.current && map.hasLayer(regroupMarkerRef.current)) {
        regroupMarkerRef.current.setLatLng([lat, lng]);
        regroupMarkerRef.current.setIcon(regroupIcon);
      } else {
        const marker = L.marker([lat, lng], { icon: regroupIcon, zIndexOffset: 2800 }).addTo(map);
        marker.bindPopup(`
          <div style="padding:6px;font-family:sans-serif;min-width:180px;">
            <div style="font-weight:800;color:#dc2626;font-size:13px;display:flex;align-items:center;gap:4px;">
              <span>🎯</span> ${activeRegroup.haltName || 'Regroup Halt'}
            </div>
            <div style="font-size:11px;color:#334155;margin-top:4px;background:#f8fafc;padding:4px 6px;border-radius:4px;border:1px solid #e2e8f0;">
              ${activeRegroup.reason || 'Convoy regroup requested by leader.'}
            </div>
            <div style="font-size:10px;color:#64748b;margin-top:6px;">
              Initiated by: <b>${activeRegroup.initiatedBy?.name || 'Leader'}</b>
            </div>
            <div style="font-size:11px;color:#16a34a;font-weight:bold;margin-top:2px;">
              ✅ ${activeRegroup.acks?.length || 0} rider(s) heading here
            </div>
          </div>
        `);
        regroupMarkerRef.current = marker;
      }

      // Draw dashed guidance line from current user position to regroup halt
      if (myLocation && typeof myLocation.lat === 'number' && typeof myLocation.lng === 'number') {
        const dist = calculateDistanceKm(myLocation.lat, myLocation.lng, lat, lng);
        const lineCoords = [
          [myLocation.lat, myLocation.lng],
          [lat, lng],
        ];

        if (regroupLineRef.current && map.hasLayer(regroupLineRef.current)) {
          regroupLineRef.current.setLatLngs(lineCoords);
        } else {
          const line = L.polyline(lineCoords, {
            color: '#ef4444',
            weight: 4,
            dashArray: '6, 8',
            opacity: 0.85,
            lineJoin: 'round',
          }).addTo(map);

          line.bindTooltip(`🎯 Regroup Guidance (${dist ? `${dist} km` : 'Halt Point'})`, {
            sticky: true,
          });

          regroupLineRef.current = line;
        }
      }
    } else {
      if (regroupMarkerRef.current && map.hasLayer(regroupMarkerRef.current)) {
        map.removeLayer(regroupMarkerRef.current);
        regroupMarkerRef.current = null;
      }
      if (regroupLineRef.current && map.hasLayer(regroupLineRef.current)) {
        map.removeLayer(regroupLineRef.current);
        regroupLineRef.current = null;
      }
    }
  }, [activeRegroup, myLocation, mapReady]);

  // Stage 6: Interactive SOS Emergency Beacon Pin on Leaflet Map
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;

    if (activeSosAlert && activeSosAlert.location?.lat && activeSosAlert.location?.lng) {
      const { lat, lng } = activeSosAlert.location;
      const riderName = activeSosAlert.user?.name || 'Convoy Rider';
      const noteText = activeSosAlert.note || activeSosAlert.description || 'Emergency assistance requested!';
      const phone = activeSosAlert.user?.phone || '';
      const icePhone = activeSosAlert.user?.emergencyContact?.phone || '';

      const sosIcon = L.divIcon({
        className: 'sos-live-beacon-marker',
        html: `
          <div style="position:relative;display:flex;align-items:center;justify-content:center;width:48px;height:48px;">
            <div style="position:absolute;width:44px;height:44px;border-radius:50%;background:rgba(239,68,68,0.45);animation:ping 1.2s cubic-bezier(0,0,0.2,1) infinite;"></div>
            <div style="position:absolute;width:34px;height:34px;border-radius:50%;background:#dc2626;box-shadow:0 0 16px rgba(220,38,38,0.9);display:flex;align-items:center;justify-content:center;border:2px solid #ffffff;color:white;font-size:16px;">
              🚨
            </div>
          </div>
        `,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });

      const popupHtml = `
        <div style="padding:6px;font-family:sans-serif;min-width:220px;">
          <div style="font-weight:900;color:#dc2626;font-size:13px;display:flex;align-items:center;gap:5px;border-bottom:1px solid #fee2e2;padding-bottom:4px;">
            <span>🚨</span> EMERGENCY SOS
          </div>
          <div style="font-size:12px;font-weight:700;color:#0f172a;margin-top:4px;">
            ${riderName}
          </div>
          <div style="background:#fef2f2;border:1px solid #f87171;border-radius:6px;padding:6px;margin:6px 0;font-size:11px;font-weight:700;color:#991b1b;word-break:break-word;">
            <span style="text-transform:uppercase;font-size:9px;color:#b91c1c;display:block;margin-bottom:2px;">Reported Situation:</span>
            "${noteText}"
          </div>
          ${phone ? `<a href="tel:${phone}" style="display:block;background:#dc2626;color:white;text-align:center;padding:5px;border-radius:5px;font-weight:700;font-size:11px;text-decoration:none;margin-top:4px;">📞 Call ${riderName}</a>` : ''}
          ${icePhone ? `<a href="tel:${icePhone}" style="display:block;background:#f59e0b;color:#0f172a;text-align:center;padding:5px;border-radius:5px;font-weight:800;font-size:11px;text-decoration:none;margin-top:4px;">🆘 Call ICE Contact</a>` : ''}
        </div>
      `;

      if (sosMarkerRef.current && map.hasLayer(sosMarkerRef.current)) {
        sosMarkerRef.current.setLatLng([lat, lng]);
        sosMarkerRef.current.setIcon(sosIcon);
        sosMarkerRef.current.setPopupContent(popupHtml);
      } else {
        const marker = L.marker([lat, lng], { icon: sosIcon, zIndexOffset: 3000 }).addTo(map);
        marker.bindPopup(popupHtml, { maxWidth: 260, closeButton: true });
        marker.bindTooltip(`🚨 SOS: ${riderName} - "${noteText}"`, { sticky: true });
        sosMarkerRef.current = marker;
      }
    } else {
      if (sosMarkerRef.current && map.hasLayer(sosMarkerRef.current)) {
        map.removeLayer(sosMarkerRef.current);
        sosMarkerRef.current = null;
      }
    }
  }, [activeSosAlert, mapReady]);

  // 5. Broadcast GPS Location via Geolocation API (or Simulator) with Stage 7 Dead-Zone Buffering
  const broadcastLocation = useCallback(
    async (lat, lng, speed = 0, heading = 0, accuracy = null) => {
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      const roundedSpeed = Math.round(speed);
      const roundedHeading = Math.round(heading);

      setMyLocation({ lat, lng, accuracy });
      setCurrentSpeed(roundedSpeed);
      currentHeadingRef.current = roundedHeading;
      myLocationRef.current = { lat, lng, accuracy };
      currentSpeedRef.current = roundedSpeed;

      const inDeadZone = !isOnline || simulatedDeadZone;

      // Update in self riders list
      const myId = (user?.id || user?._id)?.toString();
      if (myId) {
        setRiders((prev) => ({
          ...prev,
          [myId]: {
            ...(prev[myId] || {}),
            userId: myId,
            name: user.name,
            email: user.email,
            phone: user.phone,
            bloodGroup: user.bloodGroup,
            city: user.city,
            state: user.state,
            profilePic: user.profilePic,
            role: user.role,
            lat,
            lng,
            accuracy,
            speed: roundedSpeed,
            heading: roundedHeading,
            updatedAt: new Date().toISOString(),
            status: inDeadZone ? 'OFFLINE' : 'LIVE',
            isOffline: inDeadZone,
          },
        }));
      }

      // Stage 7: If in Dead-Zone or Dead-Zone Simulator is active, buffer in local IndexedDB!
      if (inDeadZone) {
        await queueLocationPing(rideId, {
          lat,
          lng,
          speed: roundedSpeed,
          heading: roundedHeading,
          timestamp: Date.now(),
        });
        const count = await getQueuedCount(rideId);
        setQueuedPingsCount(count);
        return;
      }

      // Stage 7: Low-Bandwidth Mode Throttling (saves ~80% data on 2G/3G mountain routes)
      const now = Date.now();
      if (lowBandwidthMode && lastBroadcastCoordRef.current) {
        const timeDiff = now - lastBroadcastTimeRef.current;
        const distDiff = calculateDistanceKm(
          lastBroadcastCoordRef.current.lat,
          lastBroadcastCoordRef.current.lng,
          lat,
          lng
        );
        // Only broadcast if > 4 seconds elapsed OR moved > 25 meters (0.025 km)
        if (timeDiff < 4000 && distDiff !== null && distDiff < 0.025) {
          return;
        }
      }

      const socket = getSocket();
      if (!socket || !rideId) return;

      socket.emit('location:update', {
        rideId,
        lat,
        lng,
        accuracy,
        speed: roundedSpeed,
        heading: roundedHeading,
      });

      lastBroadcastTimeRef.current = now;
      lastBroadcastCoordRef.current = { lat, lng };

      // If online and we have straggling queued pings from earlier dead zones, auto-sync them!
      if (queuedPingsCount > 0 && !isSyncingBatchRef.current) {
        syncOfflineQueue();
      }
    },
    [rideId, user, isOnline, simulatedDeadZone, lowBandwidthMode, queuedPingsCount, syncOfflineQueue]
  );

  // Stage 5/7: Internal Real-Time Auto-Heartbeat & Telemetry Synchronization
  // Keeps all connected riders' positions fresh and ensures newly joining members
  // receive accurate GPS pins even if riders are stationary at a traffic light or halt!
  useEffect(() => {
    if (!token || !rideId) return;
    const heartbeatTimer = setInterval(() => {
      const loc = myLocationRef.current || lastGoodGpsRef.current;
      const sock = getSocket();
      if (sock && sock.connected && loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
        sock.emit('location:update', {
          rideId,
          lat: loc.lat,
          lng: loc.lng,
          accuracy: loc.accuracy || null,
          speed: currentSpeedRef.current || 0,
          heading: currentHeadingRef.current || 0,
        });
      }
    }, 5000);

    return () => clearInterval(heartbeatTimer);
  }, [token, rideId]);

  // Real GPS Watcher with continuous satellite tracking and high accuracy
  const lastGoodGpsRef = useRef(null);
  const lastWatchTimeRef = useRef(Date.now());

  useEffect(() => {
    let watchId = null;
    let isCancelled = false;
    setGpsStatus('searching');

    // 1. Initial position fix
    getSmartLocation({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
      .then((loc) => {
        if (isCancelled) return;
        lastGoodGpsRef.current = { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy };
        broadcastLocation(loc.lat, loc.lng, loc.speed || 0, loc.heading || 0, loc.accuracy);
        setGpsStatus('active');
        if (loc.isApproximate) {
          addToast({
            type: 'info',
            title: 'Approximate Location',
            message: 'Location detected via network IP. Open HTTPS link on phone for satellite GPS.',
          });
        }
      })
      .catch((err) => {
        if (isCancelled) return;
        console.warn('Initial geolocation failed:', err.message);
        setGpsStatus('error');
      });

    // 2. Continuous position watch (high-accuracy GPS lock)
    let pollInterval = null;
    if ('geolocation' in navigator) {
      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (isCancelled) return;
            lastWatchTimeRef.current = Date.now();
            const { latitude, longitude, speed, heading, accuracy } = pos.coords;

            // Reject coarse readings (>500m) if we already have a high-accuracy satellite fix (<100m)
            if (typeof accuracy === 'number' && accuracy > 500 && lastGoodGpsRef.current?.accuracy && lastGoodGpsRef.current.accuracy < 100) {
              return;
            }

            lastGoodGpsRef.current = { lat: latitude, lng: longitude, accuracy };
            const kmh = speed ? Math.round(speed * 3.6) : 0;
            broadcastLocation(latitude, longitude, kmh, heading || 0, accuracy);
            setGpsStatus('active');
          },
          (err) => {
            console.warn('Geolocation watch error:', err.message);
          },
          {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 20000,
          }
        );

        // Fallback polling: ONLY triggers if watchPosition has stalled for >10 seconds
        pollInterval = setInterval(() => {
          if (isCancelled) return;
          if (Date.now() - lastWatchTimeRef.current < 10000) return; // watchPosition is active, do not interrupt GPS modem

          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (isCancelled) return;
              lastWatchTimeRef.current = Date.now();
              const { latitude, longitude, speed, heading, accuracy } = pos.coords;
              const kmh = speed ? Math.round(speed * 3.6) : 0;
              broadcastLocation(latitude, longitude, kmh, heading || 0, accuracy);
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 }
          );
        }, 8000);
      } catch (e) {
        console.warn('Error starting watchPosition:', e);
      }
    }

    return () => {
      isCancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      if (watchId !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [broadcastLocation, addToast]);

  // End Ride handler
  async function handleEndRide() {
    if (!window.confirm('Are you sure you want to end this ride for all participants?')) {
      return;
    }
    try {
      await endRide(rideId, token);
      navigate(`/groups/${ride.group}`);
    } catch (err) {
      alert('Could not end ride.');
    }
  }

  // Send Chat message (Convoy Broadcast or Private Direct Message)
  function handleSendMessage(e) {
    if (e) e.preventDefault();
    if (!newMessage.trim()) return;

    const socket = getSocket();
    if (socket) {
      const recipientId = selectedChatRecipient === 'everyone' ? null : selectedChatRecipient;
      socket.emit('chat:send', {
        rideId,
        text: newMessage.trim(),
        recipientId,
      });
      setNewMessage('');
    }
  }

  // Trigger Emergency SOS
  function handleTriggerSos() {
    const socket = getSocket();
    if (!socket) return;

    const lat = myLocation?.lat || null;
    const lng = myLocation?.lng || null;
    const noteToSend = (sosNote || '').trim();

    socket.emit('sos:trigger', { rideId, lat, lng, note: noteToSend, description: noteToSend }, (res) => {
      if (res && res.success) {
        setShowSosModal(false);
        setSosNote('');
      }
    });
  }

  // Stage 6: Escalate SOS Alert Level
  function handleEscalateSos(targetLevel) {
    const socket = getSocket();
    if (!socket || !activeSosAlert) return;

    setIsEscalatingSos(true);
    socket.emit(
      'sos:escalate',
      { alertId: activeSosAlert.id, rideId, targetLevel },
      (res) => {
        setIsEscalatingSos(false);
        if (res && res.success) {
          addToast({
            type: 'sos',
            title: 'SOS Escalated',
            message: `Alert level upgraded to ${targetLevel || 'next tier'}.`,
          });
        }
      }
    );
  }

  // Stage 6: Regroup Action Handlers
  function handleTriggerRegroup(customHalt = null) {
    const socket = getSocket();
    if (!socket) return;

    let haltLocation = customHalt?.location;
    if (!haltLocation) {
      if (pendingPin) haltLocation = pendingPin;
      else if (myLocation) haltLocation = myLocation;
    }

    const haltName = customHalt?.haltName || regroupHaltName.trim() || 'Convoy Regroup Spot';
    const reason = customHalt?.reason || regroupReason.trim() || 'Leader called for group consolidation.';

    setIsTriggeringRegroup(true);
    socket.emit(
      'regroup:trigger',
      {
        rideId,
        location: haltLocation,
        haltName,
        reason,
      },
      (res) => {
        setIsTriggeringRegroup(false);
        if (res && res.success) {
          setShowRegroupModal(false);
          setRegroupRecommendation(null);
          setRegroupHaltName('');
          setRegroupReason('');
        }
      }
    );
  }

  function handleAcknowledgeRegroup() {
    const socket = getSocket();
    if (!socket || !activeRegroup) return;

    socket.emit('regroup:ack', { rideId, regroupId: activeRegroup.id });
    setActiveRegroup((prev) => {
      if (!prev) return prev;
      const currentAcks = prev.acks || [];
      if (currentAcks.includes(user?.id)) return prev;
      return { ...prev, acks: [...currentAcks, user?.id] };
    });
    addToast({
      type: 'success',
      title: 'Regroup Acknowledged',
      message: 'Heading towards the regroup halt point!',
    });
  }

  function handleResolveRegroup() {
    const socket = getSocket();
    if (!socket || !activeRegroup) return;

    socket.emit('regroup:resolve', { rideId, regroupId: activeRegroup.id });
    setActiveRegroup(null);
  }

  // Resolve SOS
  function handleResolveSos(alertId) {
    const socket = getSocket();
    if (socket) {
      socket.emit('sos:resolve', { alertId, rideId });
      setActiveSosAlert(null);
    }
  }

  // Stage 4: Global Popup Report Trigger hook
  useEffect(() => {
    window.__groupLockReportRider = (targetId) => {
      const target = riders[targetId];
      if (target) {
        setReportingTargetUser(target);
        setShowReportModal(true);
      }
    };
    return () => {
      delete window.__groupLockReportRider;
    };
  }, [riders]);

  // Stage 4: Assign Sweep Rider Action
  async function handleAssignSweep(targetUserId) {
    setIsAssigningSweep(true);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('sweep:assign', { rideId, sweepRiderId: targetUserId });
      }
      const res = await assignSweepRider(rideId, targetUserId, token);
      if (res && res.success) {
        setSweepRider(res.sweepRider);
        addToast({
          type: 'join',
          title: '🛡️ Sweep Assigned',
          message: res.message,
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Assignment Failed',
        message: err.message || 'Could not assign sweep rider.',
      });
    } finally {
      setIsAssigningSweep(false);
    }
  }

  // Stage 4: Update Speed Limit & Road Condition Action
  async function handleUpdateSpeedLimit(newCondition, newLimit) {
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('speed_limit:update', {
          rideId,
          roadCondition: newCondition,
          speedLimit: newLimit,
        });
      }
      const res = await updateSpeedLimit(rideId, { roadCondition: newCondition, speedLimit: newLimit }, token);
      if (res && res.success) {
        setRoadCondition(res.roadCondition);
        setSelectedRoadCondition(res.roadCondition);
        setSpeedLimit(res.speedLimit);
        setConditionSpeeds((prev) => ({
          ...prev,
          [res.roadCondition]: res.speedLimit,
          Custom: res.roadCondition === 'Custom' ? res.speedLimit : prev.Custom,
        }));
        setShowSpeedLimitModal(false);
        addToast({
          type: 'success',
          title: 'Speed Limit Updated',
          message: res.message,
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Update Failed',
        message: err.message || 'Could not update speed limit.',
      });
    }
  }

  // Stage 4: Submit Rider Report Action
  async function handleSubmitReport() {
    if (!reportingTargetUser) return;
    setIsSubmittingReport(true);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('rider:report', {
          rideId,
          reportedUserId: reportingTargetUser.userId,
          reason: reportReason,
          details: reportDetails,
          speed: reportingTargetUser.speed || 0,
        });
      }
      const res = await reportRider(rideId, {
        reportedUserId: reportingTargetUser.userId,
        reason: reportReason,
        details: reportDetails,
        speed: reportingTargetUser.speed || 0,
      }, token);
      if (res && res.success) {
        setShowReportModal(false);
        setReportingTargetUser(null);
        setReportDetails('');
        addToast({
          type: 'success',
          title: 'Report Submitted',
          message: `Your report about ${reportingTargetUser.name} has been submitted.`,
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Report Failed',
        message: err.message || 'Could not submit report.',
      });
    } finally {
      setIsSubmittingReport(false);
    }
  }

  // Stage 4: Kick / Remove Rider Action
  async function handleKickRider() {
    if (!kickingTargetUser) return;
    setIsKickingRider(true);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('rider:kick', {
          rideId,
          targetUserId: kickingTargetUser.userId,
          reason: kickReason,
        });
      }
      const res = await kickRider(rideId, kickingTargetUser.userId, kickReason, token);
      if (res && res.success) {
        setShowKickModal(false);
        const kickedName = kickingTargetUser.name;
        const kickedId = kickingTargetUser.userId;
        setKickingTargetUser(null);

        // Remove from local riders state
        setRiders((prev) => {
          const updated = { ...prev };
          delete updated[kickedId];
          return updated;
        });

        // Remove from map markers
        if (riderMarkersRef.current[kickedId]) {
          mapRef.current?.removeLayer(riderMarkersRef.current[kickedId]);
          delete riderMarkersRef.current[kickedId];
        }

        addToast({
          type: 'success',
          title: 'Member Removed',
          message: `${kickedName} has been removed from the ride convoy.`,
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Failed to Remove',
        message: err.message || 'Could not remove rider from convoy.',
      });
    } finally {
      setIsKickingRider(false);
    }
  }

  // Stage 10: Road Hazard Crowdsourcing Action Handlers
  const handleReportHazardSubmit = async () => {
    const loc = myLocation || pendingPin;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      addToast({
        type: 'error',
        title: 'Location Required',
        message: 'Could not determine GPS coordinates for hazard.',
      });
      return;
    }

    try {
      setIsReportingHazard(true);
      const socket = getSocket();
      const hazardPayload = {
        rideId,
        type: selectedHazardType,
        title: `${selectedHazardType.replace('_', ' ')} reported`,
        description: hazardNote.trim(),
        location: { lat: loc.lat, lng: loc.lng },
        severity: ['OIL_SPILL', 'ROADBLOCK', 'ACCIDENT'].includes(selectedHazardType) ? 'HIGH' : 'MEDIUM',
      };

      if (socket && socket.connected) {
        socket.emit('hazard:report', hazardPayload, (res) => {
          setIsReportingHazard(false);
          setShowReportHazardModal(false);
          setHazardNote('');
          if (res?.success && res.hazard) {
            setHazards((prev) => [
              res.hazard,
              ...prev.filter((h) => (h._id || h.id)?.toString() !== (res.hazard._id || res.hazard.id)?.toString()),
            ]);
            addToast({
              type: 'success',
              title: 'Hazard Broadcasted',
              message: 'Alerted all convoy riders to the road hazard.',
            });
          }
        });
      } else {
        const newHazard = await reportRoadHazard(hazardPayload, token);
        setIsReportingHazard(false);
        setShowReportHazardModal(false);
        setHazardNote('');
        if (newHazard) {
          setHazards((prev) => [
            newHazard,
            ...prev.filter((h) => (h._id || h.id)?.toString() !== (newHazard._id || newHazard.id)?.toString()),
          ]);
          addToast({
            type: 'success',
            title: 'Hazard Broadcasted',
            message: 'Alerted all convoy riders to the road hazard.',
          });
        }
      }
    } catch (err) {
      setIsReportingHazard(false);
      addToast({
        type: 'error',
        title: 'Report Failed',
        message: err.response?.data?.error || err.message || 'Failed to broadcast hazard.',
      });
    }
  };

  const handleConfirmHazard = async (hazardId) => {
    if (!hazardId) return;
    try {
      const hIdStr = hazardId.toString();
      // Optimistic update of confirmation count
      setHazards((prev) =>
        prev.map((h) => {
          if ((h._id || h.id)?.toString() === hIdStr) {
            const myId = (user?.id || user?._id)?.toString();
            const currentConf = h.confirmations || [];
            const alreadyIn = currentConf.some(
              (c) => (c.user?._id || c.user?.id || c.user)?.toString() === myId
            );
            if (!alreadyIn) {
              const updated = [...currentConf, { user: myId, confirmedAt: new Date() }];
              return { ...h, confirmations: updated, confirmationsCount: updated.length };
            }
          }
          return h;
        })
      );

      const socket = getSocket();
      if (socket && socket.connected) {
        socket.emit('hazard:confirm', { rideId, hazardId: hIdStr });
      } else {
        await confirmRoadHazard(hIdStr, token);
      }
      addToast({
        type: 'success',
        title: 'Hazard Confirmed',
        message: 'Confirmed hazard is still present on road.',
      });
    } catch (err) {
      console.warn('Confirm hazard error:', err);
    }
  };

  const handleResolveHazard = async (hazardId) => {
    if (!hazardId) return;
    try {
      const hIdStr = hazardId.toString();
      // Optimistically clear hazard immediately so buttons give instant response
      setHazards((prev) => prev.filter((h) => (h._id || h.id)?.toString() !== hIdStr));
      setActiveHazardAlert((prev) => ((prev?._id || prev?.id)?.toString() === hIdStr ? null : prev));

      // Remove Leaflet marker from map immediately
      if (hazardMarkersRef.current[hIdStr] && mapRef.current) {
        try {
          mapRef.current.removeLayer(hazardMarkersRef.current[hIdStr]);
        } catch (_) {}
        delete hazardMarkersRef.current[hIdStr];
      }

      const socket = getSocket();
      if (socket && socket.connected) {
        socket.emit('hazard:resolve', { rideId, hazardId: hIdStr });
      } else {
        await resolveRoadHazard(hIdStr, token);
      }
      addToast({
        type: 'info',
        title: 'Hazard Cleared',
        message: 'Road marked clear for convoy.',
      });
    } catch (err) {
      console.warn('Resolve hazard error:', err);
    }
  };

  // Stage 10: Global window hooks for Leaflet Popup Hazard Actions
  useEffect(() => {
    window.__groupLockConfirmHazard = (hazardId, event) => {
      if (event) {
        if (event.stopPropagation) event.stopPropagation();
        if (event.preventDefault) event.preventDefault();
      }
      handleConfirmHazard(hazardId);
    };

    window.__groupLockResolveHazard = (hazardId, event) => {
      if (event) {
        if (event.stopPropagation) event.stopPropagation();
        if (event.preventDefault) event.preventDefault();
      }
      handleResolveHazard(hazardId);
    };

    return () => {
      delete window.__groupLockConfirmHazard;
      delete window.__groupLockResolveHazard;
    };
  }, [rideId, token, user?.id]);

  // Center Map on User
  function handleCenterOnMe() {
    if (myLocation && mapRef.current) {
      mapRef.current.setView([myLocation.lat, myLocation.lng], 16, { animate: true });
      if (user && riderMarkersRef.current[user.id]) {
        riderMarkersRef.current[user.id].openPopup();
      }
    } else {
      addToast({
        type: 'info',
        title: 'Acquiring Location',
        message: 'Locating your device, please wait...',
      });
      getSmartLocation()
        .then((loc) => {
          broadcastLocation(loc.lat, loc.lng, loc.speed || 0, loc.heading || 0);
          if (mapRef.current) {
            mapRef.current.setView([loc.lat, loc.lng], 16, { animate: true });
          }
        })
        .catch((err) => {
          addToast({
            type: 'warning',
            title: 'Location Unavailable',
            message: err.message || 'Please check device location settings or open HTTPS.',
          });
        });
    }
  }

  // Fit Map to All Convoy Riders
  function handleFitConvoy() {
    if (!mapRef.current) return;
    const allCoords = Object.values(riders)
      .filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number')
      .map((r) => [r.lat, r.lng]);

    if (allCoords.length > 0) {
      const bounds = L.latLngBounds(allCoords);
      mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    } else if (routePolylineRef.current) {
      mapRef.current.fitBounds(routePolylineRef.current.getBounds(), { padding: [40, 40] });
    }
  }

  // Interactive Live Map Pin Adjustment (Click & Drag for PC)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!isAdjustingLocation) {
      if (pendingMarkerRef.current && map.hasLayer(pendingMarkerRef.current)) {
        map.removeLayer(pendingMarkerRef.current);
        pendingMarkerRef.current = null;
      }
      map.getContainer().style.cursor = '';
      return;
    }

    map.getContainer().style.cursor = 'crosshair';

    const handleMapClick = (e) => {
      setPendingPin({ lat: e.latlng.lat, lng: e.latlng.lng });
    };

    map.on('click', handleMapClick);

    return () => {
      map.off('click', handleMapClick);
      if (map.getContainer()) {
        map.getContainer().style.cursor = '';
      }
    };
  }, [isAdjustingLocation]);

  // Update pendingMarker position when adjusting
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isAdjustingLocation) return;

    if (pendingPin && typeof pendingPin.lat === 'number' && typeof pendingPin.lng === 'number') {
      const pinIcon = L.divIcon({
        className: 'pending-live-pin',
        html: `
          <div style="position:relative;display:flex;flex-direction:column;align-items:center;cursor:grab;">
            <div style="
              width: 42px;
              height: 42px;
              border-radius: 50%;
              background: #10b981;
              color: white;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 22px;
              border: 3px solid #ffffff;
              box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            ">
              🎯
            </div>
            <div style="
              margin-top: 2px;
              background: #064e3b;
              color: #a7f3d0;
              font-size: 10px;
              font-weight: 700;
              padding: 2px 6px;
              border-radius: 4px;
              white-space: nowrap;
              border: 1px solid rgba(255,255,255,0.4);
            ">
              Drag Me or Tap Road
            </div>
          </div>
        `,
        iconSize: [44, 60],
        iconAnchor: [22, 30],
      });

      if (pendingMarkerRef.current) {
        pendingMarkerRef.current.setLatLng([pendingPin.lat, pendingPin.lng]);
      } else {
        const marker = L.marker([pendingPin.lat, pendingPin.lng], {
          icon: pinIcon,
          draggable: true,
          zIndexOffset: 3000,
        }).addTo(map);

        marker.on('dragend', (e) => {
          const pos = e.target.getLatLng();
          setPendingPin({ lat: pos.lat, lng: pos.lng });
        });

        pendingMarkerRef.current = marker;
      }
    }
  }, [isAdjustingLocation, pendingPin]);

  // Confirm and broadcast adjusted position
  async function handleConfirmAdjustedLocation() {
    if (!pendingPin) return;
    setIsSavingPin(true);
    try {
      broadcastLocation(pendingPin.lat, pendingPin.lng, 0, 0);
      await shareRiderLocation(rideId, pendingPin, token);
      if (mapRef.current) {
        mapRef.current.setView([pendingPin.lat, pendingPin.lng], 16, { animate: true });
      }
      setIsAdjustingLocation(false);
      addToast({
        type: 'success',
        title: 'Location Set',
        message: 'Your exact location was updated and broadcast to the convoy!',
      });
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Save Failed',
        message: 'Could not save exact location.',
      });
    } finally {
      setIsSavingPin(false);
    }
  }

  // Locate specific rider from Convoy drawer
  function handleLocateRider(r) {
    if (mapRef.current && typeof r.lat === 'number' && typeof r.lng === 'number') {
      mapRef.current.setView([r.lat, r.lng], 16, { animate: true });
      if (riderMarkersRef.current[r.userId]) {
        riderMarkersRef.current[r.userId].openPopup();
      }
      setIsMembersOpen(false);
    } else {
      addToast({
        type: 'info',
        title: 'No GPS Signal Yet',
        message: `${r.name} has joined the ride but has not broadcasted GPS coordinates yet.`,
      });
    }
  }

  // Calculate Straggler Distance from Convoy Leader
  const leaderRider = ride ? riders[ride.creator?._id || ride.creator] : null;
  let leaderDistanceKm = null;
  if (myLocation && leaderRider && typeof leaderRider.lat === 'number' && leaderRider.userId !== user?.id) {
    const dLat = (leaderRider.lat - myLocation.lat) * (Math.PI / 180);
    const dLng = (leaderRider.lng - myLocation.lng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(myLocation.lat * (Math.PI / 180)) *
        Math.cos(leaderRider.lat * (Math.PI / 180)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    leaderDistanceKm = Number((6371 * c).toFixed(1));
  }
  // Auto-reset dismiss when rider catches back up (≤ 2 km threshold)
  if (stragglerBannerDismissed && (leaderDistanceKm === null || leaderDistanceKm <= 2)) {
    setStragglerBannerDismissed(false);
  }

  if (error || (!loading && !ride)) {
    return (
      <div className="max-w-md mx-auto mt-12 p-6 bg-white border border-slate-200 rounded-lg shadow text-center">
        <p className="text-sm text-red-600 mb-4">{error || 'Ride not found'}</p>
        <Link
          to="/dashboard"
          className="text-xs font-medium bg-slate-900 text-white px-4 py-2 rounded hover:bg-slate-800"
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const activeRidersList = Object.values(riders);

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] flex flex-col overflow-hidden bg-slate-900">
      {/* 0. REAL-TIME NOTIFICATIONS TOAST BAR (Floating Top-Center) */}
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2.5 max-w-lg w-full px-4 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => {
              if (t.type === 'chat') {
                if (t.isPrivate && t.senderId) {
                  setSelectedChatRecipient(t.senderId);
                  setUnreadPrivateCounts((prev) => ({ ...prev, [t.senderId]: 0 }));
                }
                setIsChatOpen(true);
              }
            }}
            className={`pointer-events-auto rounded-2xl p-4 shadow-2xl flex items-start justify-between gap-3 border-2 transition-all animate-bounce ${
              t.type === 'sos'
                ? 'bg-red-700 text-white border-red-500 shadow-red-700/60'
                : t.type === 'join'
                ? 'bg-emerald-800 text-white border-emerald-500 shadow-emerald-900/60'
                : t.type === 'chat'
                ? t.isPrivate
                  ? 'bg-purple-700 text-white border-purple-400 shadow-purple-900/80 cursor-pointer ring-2 ring-purple-300/50 hover:bg-purple-600'
                  : 'bg-blue-600 text-white border-blue-400 shadow-blue-800/80 cursor-pointer ring-2 ring-blue-300/50 hover:bg-blue-500'
                : 'bg-slate-800 text-white border-slate-600 shadow-slate-900/60'
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl sm:text-3xl shrink-0 mt-0.5">
                {t.type === 'sos' ? '🚨' : t.type === 'join' ? '🎉' : t.isPrivate ? '🔒' : '💬'}
              </span>
              <div>
                <p className="text-sm sm:text-base font-bold text-white tracking-wide">{t.title}</p>
                <p className="text-base sm:text-lg font-bold text-slate-100 mt-0.5 leading-snug break-words">{t.message}</p>
                {t.type === 'chat' && (
                  <span className="inline-flex items-center gap-1 mt-1 text-xs bg-white/20 text-white px-2.5 py-0.5 rounded-full font-bold">
                    <span>{t.isPrivate ? 'Tap to open private chat' : 'Tap to view & reply'}</span>
                    <span>→</span>
                  </span>
                )}
                {t.rider && (
                  <div className="flex items-center gap-2 mt-1.5 text-xs font-semibold bg-black/25 px-2.5 py-1 rounded-lg">
                    {t.rider.bloodGroup && (
                      <span className="text-red-200">
                        🩸 Blood: {t.rider.bloodGroup}
                      </span>
                    )}
                    {t.rider.phone && (
                      <span className="text-slate-200">
                        📞 {t.rider.phone}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeToast(t.id);
              }}
              className="text-white/80 hover:text-white text-base font-bold p-1 shrink-0 rounded-lg hover:bg-white/10"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 1. TOP CONVOY CONTROL BAR */}
      <header className="z-20 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-3 sm:px-4 py-2 flex items-center justify-between text-white shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 shrink-0"
            title="Back"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <img
            src="/grouplock_logo.png"
            alt="GroupLock Mascot"
            className="w-8 h-8 object-contain shrink-0 drop-shadow hidden xs:block"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold truncate max-w-[130px] sm:max-w-xs">{ride?.title || 'Live Ride'}</h2>
              <span className="flex items-center gap-1 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded-full shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                Live Convoy
              </span>
            </div>
            {ride && (
              <p className="text-[11px] text-slate-400 truncate hidden sm:block">
                {ride.startLocation} → {ride.destination} {ride.distanceKm ? `(${ride.distanceKm} km)` : ''}
              </p>
            )}
          </div>
        </div>

        {/* Right side of top bar: End Ride button for leader so it is always accessible without scrolling */}
        <div className="flex items-center gap-2 shrink-0">
          {isLeader && (
            <button
              onClick={handleEndRide}
              className="text-xs bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-semibold px-2.5 sm:px-3 py-1.5 rounded-lg transition shadow-sm shrink-0"
            >
              End Ride
            </button>
          )}
        </div>
      </header>

      {/* 2. HORIZONTAL SLIDING ACTION RIBBON (Touch-pan carousel for all dash options on mobile & desktop) */}
      <div className="z-10 bg-slate-950/95 backdrop-blur border-b border-slate-800/80 px-2.5 sm:px-4 py-1.5 flex items-center gap-2 overflow-x-auto no-scrollbar scroll-smooth touch-pan-x whitespace-nowrap text-white shrink-0 select-none">
        {/* Stage 8: Hands-Free Walkie-Talkie (PTT) */}
        <WalkieTalkiePTT
          socket={getSocket()}
          rideId={rideId}
          isLeader={isLeader}
          isSweep={Boolean(sweepRider && (sweepRider._id || sweepRider).toString() === user?.id)}
          activeRidersCount={activeRidersList.length}
          channel={pttChannel}
          setChannel={setPttChannel}
          isMuted={isPttMuted}
          setIsMuted={setIsPttMuted}
          voiceSettings={voiceSettings}
          setVoiceSettings={setVoiceSettings}
        />

        {/* Stage 4: Road Condition & Speed Limit Chip */}
        <button
          onClick={() => setShowSpeedLimitModal(true)}
          className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 active:bg-slate-700 px-2.5 py-1 rounded-full border border-slate-700/80 text-xs text-slate-200 transition shadow-sm shrink-0"
          title={`Road: ${roadCondition} · Limit: ${speedLimit} km/h (Click to ${isLeader ? 'change' : 'view'})`}
        >
          <span>{roadCondition === 'Highway' ? '🛣️' : roadCondition === 'City' ? '🏙️' : roadCondition === 'Ghats/Hills' ? '⛰️' : roadCondition === 'Rain/Wet' ? '🌧️' : roadCondition === 'Night' ? '🌙' : '⚙️'}</span>
          <span className="font-bold text-amber-400">{speedLimit} km/h</span>
          <span className="text-slate-400 font-medium text-[11px]">({roadCondition})</span>
          {isLeader && <span className="text-[10px] text-slate-400">▾</span>}
        </button>

        {/* Stage 10: Live Road Weather Chip */}
        {liveWeather && (
          <button
            type="button"
            onClick={() => setShowWeatherModal(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold transition shadow-sm shrink-0 cursor-pointer ${
              liveWeather.isHazardous
                ? 'bg-blue-950/80 hover:bg-blue-900/80 text-blue-200 border-blue-400/80 animate-pulse'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-200 border-slate-700/80'
            }`}
            title={`Live Road Weather: ${liveWeather.description || liveWeather.condition} (${liveWeather.temperature ?? liveWeather.temp}°C, Wind ${liveWeather.windSpeed} km/h). Click for weather details.`}
          >
            <span className="text-sm">{liveWeather.icon || '☀️'}</span>
            <span className="font-mono text-slate-100">{liveWeather.temperature ?? liveWeather.temp}°C</span>
            <span className="text-[11px] font-medium text-slate-300">({liveWeather.condition || liveWeather.description})</span>
            {isLeader && liveWeather.isHazardous && (
              <span className="ml-1 bg-amber-500 text-slate-950 text-[10px] px-1.5 py-0.5 rounded font-extrabold uppercase">
                {liveWeather.suggestedSpeedLimit}kph
              </span>
            )}
          </button>
        )}

        {/* Stage 7: Low-Bandwidth Mode Toggle */}
        <button
          onClick={handleToggleLowBandwidth}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-bold transition shadow-sm shrink-0 ${
            lowBandwidthMode
              ? 'bg-amber-600/30 text-amber-300 border-amber-500/60'
              : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700/80'
          }`}
          title="Low-Bandwidth Mode: Throttles telemetry pings on 2G/3G mountain roads to save data & battery"
        >
          <span>⚡</span>
          <span>Low Data</span>
          <span className={`text-[9px] uppercase px-1 rounded font-extrabold ${lowBandwidthMode ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>
            {lowBandwidthMode ? 'ON' : 'OFF'}
          </span>
        </button>

        {/* Stage 7: Dead-Zone Simulator Toggle */}
        <button
          onClick={handleToggleSimulatedDeadZone}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold transition shadow-sm shrink-0 ${
            simulatedDeadZone
              ? 'bg-purple-900/60 text-purple-200 border-purple-400 animate-pulse'
              : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700/80'
          }`}
          title="Simulate entering a cellular dead zone (ghats/tunnels) to test offline GPS queuing & batch sync"
        >
          <span>📵</span>
          <span>Dead-Zone Sim</span>
          <span className={`text-[9px] uppercase px-1 rounded font-extrabold ${simulatedDeadZone ? 'bg-purple-400 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>
            {simulatedDeadZone ? 'ON' : 'OFF'}
          </span>
        </button>

        {/* Stage 7: Queued Offline Pings Indicator / Sync button */}
        {queuedPingsCount > 0 && (
          <button
            onClick={syncOfflineQueue}
            disabled={isSyncingBatch}
            className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold px-2.5 py-1 rounded-full text-xs shadow-md transition shrink-0 animate-bounce"
            title="Click to sync buffered offline GPS coordinates with convoy"
          >
            <span>📶</span>
            <span>{queuedPingsCount} queued</span>
            {isSyncingBatch ? <span>⏳</span> : <span>🔄 Sync</span>}
          </button>
        )}

        {/* Stage 4: Sweep Rider Header Badge */}
        {sweepRider && (sweepRider._id || sweepRider).toString() === user?.id && (
          <span className="flex items-center gap-1 text-[11px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40 px-2.5 py-1 rounded-full shrink-0" title="You are the appointed Sweep Rider maintaining the convoy rear">
            <span>🛡️</span> Sweep Rider
          </span>
        )}

        {/* Group Health UI (Fully visible on phones through sliding ribbon) */}
        <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-700/80 px-2.5 py-1 rounded-full shrink-0 text-xs">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Health:</span>
          <span className={`font-bold ${healthScore > 80 ? 'text-emerald-400' : healthScore > 50 ? 'text-amber-400' : 'text-red-400'}`}>
            {healthScore}%
          </span>
          <div className="w-12 h-1.5 bg-slate-700 rounded-full overflow-hidden flex">
            <div 
              className={`h-full ${healthScore > 80 ? 'bg-emerald-500' : healthScore > 50 ? 'bg-amber-500' : 'bg-red-500'}`} 
              style={{ width: `${healthScore}%` }}
            />
          </div>
          {convoySpread > 0 && (
            <span className={`text-[10px] font-medium ${convoySpread > 2 ? 'text-red-400' : 'text-slate-400'}`}>
              • {convoySpread} km
            </span>
          )}
        </div>

        {/* Interactive Convoy Members Button */}
        <button
          onClick={() => setIsMembersOpen(!isMembersOpen)}
          className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 active:bg-slate-700 px-3 py-1 rounded-full border border-slate-700/80 text-xs text-slate-200 transition shrink-0"
          title="View Convoy Members & Identification Details"
        >
          <span>👥</span>
          <span className="font-semibold text-white">{activeRidersList.length}</span>
          <span>Riders</span>
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
        </button>

        {/* Stage 6: Leader Regroup Button */}
        {isLeader && (
          <button
            onClick={() => setShowRegroupModal(true)}
            className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-semibold px-2.5 py-1 rounded-full transition shadow-sm flex items-center gap-1 shrink-0"
            title="Broadcast Regroup Call to Convoy"
          >
            <span>🎯</span>
            <span>Regroup</span>
          </button>
        )}
      </div>

      {/* STAGE 7: DEAD-ZONE TELEMETRY & OFFLINE QUEUE BANNER */}
      {(!isOnline || simulatedDeadZone || queuedPingsCount > 0) && (
        <div className={`z-30 px-4 py-2.5 text-white shadow-xl border-b flex flex-wrap items-center justify-between gap-3 ${
          !isOnline || simulatedDeadZone
            ? 'bg-gradient-to-r from-amber-700 via-orange-700 to-amber-800 border-amber-500 animate-pulse'
            : 'bg-slate-800 border-slate-700'
        }`}>
          <div className="flex items-center gap-3">
            <span className="text-2xl shrink-0">{!isOnline || simulatedDeadZone ? '📵' : '📶'}</span>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-extrabold uppercase tracking-wide text-xs sm:text-sm">
                  {!isOnline || simulatedDeadZone ? 'DEAD-ZONE MODE ACTIVE' : 'NETWORK RESTORED'}
                </span>
                <span className="bg-black/30 border border-white/20 text-[10px] font-bold px-2 py-0.5 rounded-full text-amber-200">
                  {queuedPingsCount} GPS Ping(s) Buffered Locally
                </span>
                {simulatedDeadZone && (
                  <span className="bg-purple-900/80 border border-purple-300 text-[10px] font-extrabold px-2 py-0.5 rounded text-purple-200">
                    TEST SIMULATOR
                  </span>
                )}
              </div>
              <p className="text-xs text-amber-100 font-medium mt-0.5">
                {!isOnline || simulatedDeadZone
                  ? 'Satellite GPS is actively buffering coordinates, speeds & timestamps in local storage. Automatic batch reconciliation will fire once cellular signal returns.'
                  : `Online connection established. ${queuedPingsCount} offline breadcrumb(s) ready to sync with the convoy.`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {simulatedDeadZone && (
              <button
                onClick={handleToggleSimulatedDeadZone}
                className="bg-white/20 hover:bg-white/30 text-white text-xs font-bold px-2.5 py-1 rounded transition"
              >
                Exit Sim
              </button>
            )}
            {isOnline && queuedPingsCount > 0 && (
              <button
                onClick={syncOfflineQueue}
                disabled={isSyncingBatch}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3 py-1 rounded shadow transition flex items-center gap-1.5"
              >
                <span>{isSyncingBatch ? '🔄 Syncing...' : '🔄 Sync Batch Now'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* STAGE 4: OVERSPEED & AGGRESSIVE RIDING ALERT BANNER */}
      {overspeedAlert && (
        <div className="z-30 bg-gradient-to-r from-red-700 via-rose-700 to-red-800 text-white px-4 py-2.5 shadow-2xl border-b border-red-500 flex flex-wrap items-center justify-between gap-3 animate-pulse">
          <div className="flex items-center gap-3">
            <span className="text-2xl animate-bounce">⚠️</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold uppercase tracking-wide text-white text-xs sm:text-sm">
                  AGGRESSIVE RIDING / SPEED VIOLATION DETECTED!
                </span>
                <span className="bg-black/40 border border-white/20 text-[10px] font-bold px-2 py-0.5 rounded-full text-red-200">
                  +{overspeedAlert.excess} km/h Over Limit
                </span>
              </div>
              <p className="text-xs text-red-100 font-medium">
                {overspeedAlert.userId === user?.id ? (
                  <strong className="text-amber-200">YOU are speeding at {overspeedAlert.speed} km/h! Convoy limit is {overspeedAlert.speedLimit} km/h on {overspeedAlert.roadCondition}. Slow down immediately!</strong>
                ) : (
                  <><strong>{overspeedAlert.name}</strong> is clocked at <strong>{overspeedAlert.speed} km/h</strong> (Convoy limit: {overspeedAlert.speedLimit} km/h on {overspeedAlert.roadCondition}).</>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {overspeedAlert.lat && overspeedAlert.lng && (
              <button
                onClick={() => {
                  if (mapRef.current) {
                    mapRef.current.setView([overspeedAlert.lat, overspeedAlert.lng], 16, { animate: true });
                    if (riderMarkersRef.current[overspeedAlert.userId]) {
                      riderMarkersRef.current[overspeedAlert.userId].openPopup();
                    }
                  }
                }}
                className="bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg transition"
              >
                Locate Rider 🎯
              </button>
            )}
            {isLeader && overspeedAlert.userId !== user?.id && (
              <button
                onClick={() => {
                  const target = riders[overspeedAlert.userId] || { userId: overspeedAlert.userId, name: overspeedAlert.name };
                  setKickingTargetUser(target);
                  setKickReason(`Excessive speeding (${overspeedAlert.speed} km/h in ${overspeedAlert.speedLimit} km/h zone) / Aggressive riding`);
                  setShowKickModal(true);
                }}
                className="bg-red-950/80 hover:bg-black text-red-200 border border-red-400/50 text-xs font-bold px-2.5 py-1.5 rounded-lg transition"
              >
                Remove from Convoy 🚫
              </button>
            )}
            <button
              onClick={() => setOverspeedAlert(null)}
              className="text-white/80 hover:text-white text-xs font-bold p-1"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Notice for mobile users accessing via insecure HTTP */}
      {!isSecureOrigin() && (
        <div className="z-30 bg-amber-600 text-white px-4 py-2 text-xs flex items-center justify-between shadow-md">
          <div className="flex items-center gap-2">
            <span className="text-base">🔒</span>
            <span>
              <strong>Mobile Notice:</strong> Continuous GPS tracking requires HTTPS on phones.
            </span>
          </div>
          <a
            href={getHttpsUrl()}
            className="bg-white text-amber-900 font-bold px-3 py-1 rounded text-xs hover:bg-amber-100 transition shadow shrink-0"
          >
            Switch to HTTPS ↗
          </a>
        </div>
      )}

      {/* 2. REGROUP ACTIVE BANNER (Stage 6 High Visibility Banner) */}
      {activeRegroup && (
        <div className="z-30 bg-gradient-to-r from-red-700 via-rose-700 to-amber-700 text-white px-4 py-2.5 shadow-xl border-b border-rose-500/50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs sm:text-sm">
            <span className="text-2xl animate-bounce">🎯</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold uppercase tracking-wide text-white">
                  REGROUP CALL: {activeRegroup.haltName || 'Halt Point'}
                </span>
                <span className="bg-black/30 border border-white/20 text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {activeRegroup.acks?.length || 0} / {activeRidersList.length} Heading Here
                </span>
              </div>
              <p className="text-xs text-rose-100 font-medium">
                {activeRegroup.reason || 'Convoy leader requested regrouping.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Acknowledge Button */}
            {activeRegroup.acks?.includes(user?.id) ? (
              <span className="bg-emerald-600/90 text-white text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1 shadow">
                <span>✅</span> <span>Heading to Halt</span>
              </span>
            ) : (
              <button
                onClick={handleAcknowledgeRegroup}
                className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow-md transition transform active:scale-95 flex items-center gap-1"
              >
                <span>📍</span> <span>I'm Heading Here</span>
              </button>
            )}

            {/* Locate Halt on Map */}
            {activeRegroup.location && (
              <button
                onClick={() => {
                  if (mapRef.current) {
                    mapRef.current.setView(
                      [activeRegroup.location.lat, activeRegroup.location.lng],
                      16,
                      { animate: true }
                    );
                    if (regroupMarkerRef.current) {
                      regroupMarkerRef.current.openPopup();
                    }
                  }
                }}
                className="bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg transition"
              >
                Locate Halt 🎯
              </button>
            )}

            {/* Leader Clear Regroup */}
            {isLeader && (
              <button
                onClick={handleResolveRegroup}
                className="bg-black/40 hover:bg-black/60 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg transition"
                title="Clear Regroup Call"
              >
                Clear ✕
              </button>
            )}
          </div>
        </div>
      )}

      {/* 2.5 REGROUP RECOMMENDATION BANNER (For Leader) */}
      {isLeader && regroupRecommendation && !activeRegroup && (
        <div className="z-30 bg-amber-600 text-white px-4 py-2 flex items-center justify-between shadow-md border-b border-amber-700 animate-pulse">
          <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold">
            <span className="text-lg">⚠️</span>
            <span>
              <strong>Regroup Recommended:</strong> {regroupRecommendation.reason}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                handleTriggerRegroup({
                  location: regroupRecommendation.recommendedHalt,
                  haltName: 'Separation Regroup Point',
                  reason: regroupRecommendation.reason,
                })
              }
              className="bg-white text-amber-900 font-bold px-3 py-1 rounded text-xs hover:bg-amber-100 transition shadow"
            >
              Broadcast Regroup 🎯
            </button>
            <button
              onClick={() => setRegroupRecommendation(null)}
              className="text-white/80 hover:text-white text-xs p-1"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 3. EMERGENCY SOS BANNER (Stage 6 Advanced Escalation) */}
      {activeSosAlert && (
        <div className="z-30 bg-red-700 text-white px-4 py-3 shadow-2xl border-b-2 border-red-500 animate-pulse flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="text-3xl shrink-0">🚨</span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-extrabold uppercase tracking-wide">
                  EMERGENCY SOS: {activeSosAlert.user?.name || 'Rider'}
                </span>
                <span
                  className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${
                    activeSosAlert.escalationLevel === 'AUTHORITIES'
                      ? 'bg-purple-950 text-purple-200 border-purple-400'
                      : activeSosAlert.escalationLevel === 'EMERGENCY_CONTACTS'
                      ? 'bg-amber-950 text-amber-200 border-amber-400'
                      : 'bg-red-950 text-red-200 border-red-400'
                  }`}
                >
                  {activeSosAlert.escalationLevel === 'AUTHORITIES'
                    ? '⚡ LEVEL 3: AUTHORITIES / POLICE'
                    : activeSosAlert.escalationLevel === 'EMERGENCY_CONTACTS'
                    ? '⚡ LEVEL 2: ESCALATED TO ICE'
                    : '⚡ LEVEL 1: CONVOY ALERT'}
                </span>
                {activeSosAlert.user?.bloodGroup && (
                  <span className="bg-red-900/90 text-red-200 text-[10px] font-bold px-2 py-0.5 rounded border border-red-600">
                    🩸 Blood: {activeSosAlert.user.bloodGroup}
                  </span>
                )}
              </div>

              {/* Prominent SOS Description Box */}
              <div className="mt-2 p-2.5 rounded-lg bg-black/60 border border-red-400/60 shadow-inner">
                <div className="text-[10px] uppercase font-black tracking-wider text-amber-400 flex items-center gap-1.5 mb-0.5">
                  <span>📝</span>
                  <span>Emergency Situation / Description:</span>
                </div>
                <div className="text-sm font-extrabold text-white leading-snug break-words">
                  {activeSosAlert.note || activeSosAlert.description || 'Emergency assistance requested by rider!'}
                </div>
              </div>

              {/* Direct Emergency Contacts Hotlinks */}
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
                {activeSosAlert.user?.phone && (
                  <a
                    href={`tel:${activeSosAlert.user.phone}`}
                    className="bg-white/20 hover:bg-white/30 text-white px-2.5 py-0.5 rounded flex items-center gap-1 font-bold underline"
                  >
                    📞 Call Rider: {activeSosAlert.user.phone}
                  </a>
                )}
                {activeSosAlert.user?.emergencyContact?.phone && (
                  <a
                    href={`tel:${activeSosAlert.user.emergencyContact.phone}`}
                    className="bg-amber-500 hover:bg-amber-600 text-slate-950 px-2.5 py-0.5 rounded flex items-center gap-1 font-extrabold shadow"
                    title={`Call ICE Contact (${activeSosAlert.user.emergencyContact.relationship || 'ICE'})`}
                  >
                    🆘 ICE: {activeSosAlert.user.emergencyContact.name} ({activeSosAlert.user.emergencyContact.phone})
                  </a>
                )}
                <a
                  href="tel:112"
                  className="bg-red-900 hover:bg-black text-red-100 px-2.5 py-0.5 rounded flex items-center gap-1 font-bold border border-red-400"
                >
                  🚑 Dial 112
                </a>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end md:self-center shrink-0">
            {activeSosAlert.location && (
              <button
                onClick={() => {
                  if (mapRef.current) {
                    mapRef.current.setView(
                      [activeSosAlert.location.lat, activeSosAlert.location.lng],
                      16,
                      { animate: true }
                    );
                    if (sosMarkerRef.current) {
                      sosMarkerRef.current.openPopup();
                    }
                  }
                }}
                className="text-xs bg-white text-red-700 font-bold px-3 py-1.5 rounded-lg shadow hover:bg-red-50 transition"
              >
                Locate Rider 🎯
              </button>
            )}

            {/* Manual Escalation Button */}
            {activeSosAlert.escalationLevel !== 'AUTHORITIES' && (
              <button
                onClick={() =>
                  handleEscalateSos(
                    activeSosAlert.escalationLevel === 'CONVOY'
                      ? 'EMERGENCY_CONTACTS'
                      : 'AUTHORITIES'
                  )
                }
                disabled={isEscalatingSos}
                className="text-xs bg-amber-500 hover:bg-amber-600 text-slate-950 font-extrabold px-3 py-1.5 rounded-lg shadow transition"
              >
                {activeSosAlert.escalationLevel === 'CONVOY' ? 'Escalate to ICE ⚡' : 'Escalate to 112 ⚡'}
              </button>
            )}

            <button
              onClick={() => handleResolveSos(activeSosAlert.id)}
              className="text-xs bg-slate-900 hover:bg-black text-white px-3 py-1.5 rounded-lg font-bold border border-slate-700 transition"
            >
              Resolve
            </button>
          </div>
        </div>
      )}

      {/* 3. STRAGGLER / SEPARATION WARNING — persistent dismissible banner */}
      {((!isLeader && leaderDistanceKm !== null && leaderDistanceKm > 2) || (isLeader && convoySpread > 2)) && !stragglerBannerDismissed && (
        <div
          className={`z-30 px-4 py-2.5 text-sm font-bold flex items-center justify-between shadow-md ${
            (leaderDistanceKm > 5 || convoySpread > 5)
              ? 'bg-red-600 text-white'
              : 'bg-amber-500 text-slate-950'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-lg shrink-0">⚠️</span>
            <span>
              {!isLeader ? (
                 <>You are <strong>{leaderDistanceKm} km</strong> behind the convoy leader. Catch up!</>
              ) : (
                 <>Convoy is scattered! Maximum spread is <strong>{convoySpread} km</strong>. Consider regrouping.</>
              )}
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setIsChatOpen(true)}
              className={`underline font-semibold text-xs hover:opacity-80 ${
                (leaderDistanceKm > 5 || convoySpread > 5) ? 'text-red-100' : 'text-slate-800'
              }`}
            >
              Open Chat
            </button>
            <button
              onClick={() => setStragglerBannerDismissed(true)}
              className={`text-xs font-bold px-2 py-0.5 rounded hover:opacity-80 ${
                (leaderDistanceKm > 5 || convoySpread > 5)
                  ? 'bg-red-800 text-white'
                  : 'bg-amber-700/30 text-slate-900'
              }`}
              title="Dismiss warning"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* STAGE 10: ACTIVE PROXIMITY ROAD HAZARD WARNING BANNER */}
      {activeHazardAlert && (
        <div className="z-30 bg-gradient-to-r from-amber-600 via-orange-600 to-red-600 text-white px-4 py-2.5 shadow-xl border-b border-orange-400 flex flex-wrap items-center justify-between gap-3 animate-pulse">
          <div className="flex items-center gap-3">
            <span className="text-2xl animate-bounce">
              {getHazardIconData(activeHazardAlert.type)?.symbol || '⚠️'}
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold uppercase tracking-wide text-xs sm:text-sm">
                  CAUTION: {activeHazardAlert.type?.replace('_', ' ')} AHEAD
                </span>
                {typeof activeHazardAlert.distanceMeters === 'number' && (
                  <span className="bg-black/40 border border-white/20 text-[10px] font-black px-2 py-0.5 rounded-full text-amber-200">
                    ~{activeHazardAlert.distanceMeters}m Away
                  </span>
                )}
                {activeHazardAlert.severity && (
                  <span className={`text-[10px] font-extrabold uppercase px-1.5 py-0.5 rounded ${
                    activeHazardAlert.severity === 'CRITICAL'
                      ? 'bg-red-950 text-red-200 border border-red-400'
                      : activeHazardAlert.severity === 'HIGH'
                      ? 'bg-amber-950 text-amber-200 border border-amber-400'
                      : 'bg-black/30 text-white'
                  }`}>
                    {activeHazardAlert.severity}
                  </span>
                )}
              </div>
              <p className="text-xs text-amber-100 font-medium">
                {activeHazardAlert.description || activeHazardAlert.title || 'Road hazard reported on route. Exercise extreme caution.'}
                {activeHazardAlert.reportedBy?.name && (
                  <span className="opacity-90 ml-1">· Reported by {activeHazardAlert.reportedBy.name}</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() => handleConfirmHazard(activeHazardAlert._id || activeHazardAlert.id)}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-2.5 py-1.5 rounded-lg shadow-md transition flex items-center gap-1 active:scale-95"
              title="Confirm hazard is still present on road"
            >
              <span>✅</span> <span>Still There</span>
            </button>
            <button
              type="button"
              onClick={() => handleResolveHazard(activeHazardAlert._id || activeHazardAlert.id)}
              className="bg-red-700 hover:bg-red-600 text-white text-xs font-bold px-2.5 py-1.5 rounded-lg shadow-md transition flex items-center gap-1 active:scale-95"
              title="Mark hazard as cleared"
            >
              <span>✕</span> <span>Cleared</span>
            </button>
            {activeHazardAlert.location && (
              <button
                type="button"
                onClick={() => {
                  if (mapRef.current && activeHazardAlert.location) {
                    mapRef.current.setView(
                      [activeHazardAlert.location.lat, activeHazardAlert.location.lng],
                      17,
                      { animate: true }
                    );
                    const hId = (activeHazardAlert._id || activeHazardAlert.id)?.toString();
                    if (hId && hazardMarkersRef.current[hId]) {
                      hazardMarkersRef.current[hId].openPopup();
                    }
                  }
                }}
                className="bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-2 py-1.5 rounded-lg transition"
              >
                Map 🎯
              </button>
            )}
            <button
              type="button"
              onClick={() => setActiveHazardAlert(null)}
              className="text-white/80 hover:text-white text-xs font-bold p-1"
              title="Dismiss warning"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 4. MAIN MAP CANVAS (Unconditionally mounted to ensure Leaflet attaches properly) */}
      <div className="relative flex-1 w-full h-full">
        <div ref={mapContainerRef} className="w-full h-full z-0" />

        {/* Loading Overlay over map */}
        {loading && (
          <div className="absolute inset-0 z-40 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-sm font-semibold text-white">Connecting to Live Convoy...</p>
            </div>
          </div>
        )}

        {/* EXPANDABLE ROUND CHEVRON BUTTON & MAP SURFACE QUICK-TOOLS / HELMET AUDIO */}
        <div className="absolute top-4 left-4 z-20 select-none">
          {/* Main Trigger Button: Exact circular blue chevron button from user request */}
          <button
            type="button"
            onClick={() => {
              const nextState = !isScrollMenuOpen;
              setIsScrollMenuOpen(nextState);
              if (!nextState) {
                setScrollMenuTab('tools');
              }
            }}
            className={`w-12 h-12 rounded-full shadow-2xl flex items-center justify-center transition-all duration-300 active:scale-90 z-30 relative border-2 ${
              isScrollMenuOpen
                ? 'bg-amber-600 hover:bg-amber-500 text-white border-amber-300 ring-4 ring-amber-500/40 shadow-amber-900/50'
                : 'bg-[#0091ff] hover:bg-[#007ee0] text-white border-white/40 shadow-blue-500/40 hover:scale-105'
            }`}
            title={isScrollMenuOpen ? 'Close tools menu' : 'Convoy Quick Tools & Helmet Audio'}
          >
            {isScrollMenuOpen ? (
              <svg
                className="w-6 h-6 text-white stroke-[3.5]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg
                className="w-6 h-6 text-white stroke-[4]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 14.5L12 7.5L19 14.5" />
              </svg>
            )}
          </button>

          {/* Transparent Backdrop to collapse when tapping outside on map */}
          {isScrollMenuOpen && (
            <div
              className="fixed inset-0 z-10 bg-black/25 backdrop-blur-[1px]"
              onClick={() => {
                setIsScrollMenuOpen(false);
                setScrollMenuTab('tools');
              }}
            />
          )}

          {/* Popped-Up Panel On Map Surface */}
          {isScrollMenuOpen && (
            <div
              ref={(el) => {
                if (el && window.L?.DomEvent) {
                  window.L.DomEvent.disableScrollPropagation(el);
                  window.L.DomEvent.disableClickPropagation(el);
                }
              }}
              onWheel={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="relative z-20 mt-2 w-72 sm:w-84 max-w-[calc(100vw-32px)] bg-slate-900/98 backdrop-blur-xl border border-slate-700/90 rounded-2xl shadow-2xl text-white animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[calc(100dvh-130px)] sm:max-h-[calc(100vh-130px)] overflow-hidden"
            >
              {/* TAB 1: CONVOY QUICK TOOLS */}
              {scrollMenuTab === 'tools' ? (
                <>
                  {/* Pinned Header */}
                  <div className="shrink-0 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-400 border-b border-slate-800 flex items-center justify-between bg-slate-900/95">
                    <span>Convoy Quick Tools</span>
                    <button
                      type="button"
                      onClick={() => setIsScrollMenuOpen(false)}
                      className="text-slate-400 hover:text-white p-0.5 rounded text-xs transition"
                      title="Close menu"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Scrollable Tools List */}
                  <div className="flex-1 overflow-y-auto overscroll-contain p-2.5 space-y-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-slate-700 [&::-webkit-scrollbar-thumb]:rounded-full">
                    {/* 1. Scroll-to-Top / Reset Convoy View */}
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                          document.documentElement.scrollTo({ top: 0, behavior: 'smooth' });
                          const ribbon = document.querySelector('.overflow-x-auto');
                          if (ribbon) ribbon.scrollTo({ left: 0, behavior: 'smooth' });
                        } catch (_) {}
                        handleFitConvoy();
                        setIsScrollMenuOpen(false);
                      }}
                      className="w-full text-left p-2 rounded-xl hover:bg-slate-800 active:bg-slate-700 border border-transparent hover:border-slate-700/70 transition flex items-center gap-2.5 group"
                      title="Scroll page to top & fit entire convoy route on map"
                    >
                      <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/40 flex items-center justify-center text-sm font-bold shrink-0 group-hover:scale-105 transition">
                        ⬆️
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span>Scroll to Top</span>
                          <span className="text-[9px] bg-blue-900/60 text-blue-200 px-1 rounded font-semibold">
                            Reset
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">Reset page & fit entire convoy view</p>
                      </div>
                    </button>

                    {/* 2. Helmet Audio & Intercom */}
                    <button
                      type="button"
                      onClick={() => setScrollMenuTab('helmet_audio')}
                      className="w-full text-left p-2 rounded-xl hover:bg-slate-800 active:bg-slate-700 border border-purple-500/30 hover:border-purple-500/60 transition flex items-center gap-2.5 group bg-purple-950/20"
                      title="Configure spoken voice warnings, volume, and walkie-talkie"
                    >
                      <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/40 flex items-center justify-center text-sm font-bold shrink-0 group-hover:scale-105 transition">
                        🎧
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span>Helmet Audio</span>
                          <span className="text-[9px] bg-purple-900/80 text-purple-200 px-1.5 py-0.2 rounded font-semibold">
                            Voice & Radio
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">TTS alerts, volume & radio settings</p>
                      </div>
                      <span className="text-purple-300 font-bold text-xs group-hover:translate-x-0.5 transition-transform">
                        →
                      </span>
                    </button>

                    {/* 3. Recenter Map on My Location */}
                    <button
                      type="button"
                      onClick={() => {
                        handleCenterOnMe();
                        setIsScrollMenuOpen(false);
                      }}
                      className="w-full text-left p-2 rounded-xl hover:bg-slate-800 active:bg-slate-700 border border-transparent hover:border-slate-700/70 transition flex items-center gap-2.5 group"
                      title="Recenter camera on my current GPS position"
                    >
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center text-sm font-bold shrink-0 group-hover:scale-105 transition">
                        🎯
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span>Recenter Map</span>
                          <span className="text-[9px] bg-emerald-900/60 text-emerald-200 px-1 rounded font-semibold">
                            GPS
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">Snap view to your current position</p>
                      </div>
                    </button>

                    {/* 4. Adjust Pin on Map */}
                    <button
                      type="button"
                      onClick={() => {
                        setIsAdjustingLocation((prev) => {
                          const nextVal = !prev;
                          if (nextVal) {
                            const initial =
                              myLocation ||
                              (user && riders[user.id] && typeof riders[user.id].lat === 'number'
                                ? { lat: riders[user.id].lat, lng: riders[user.id].lng }
                                : null);
                            if (initial) setPendingPin(initial);
                          }
                          return nextVal;
                        });
                        setIsScrollMenuOpen(false);
                      }}
                      className={`w-full text-left p-2 rounded-xl border transition flex items-center gap-2.5 group ${
                        isAdjustingLocation
                          ? 'bg-amber-950/70 text-amber-200 border-amber-500/60 ring-1 ring-amber-400/30'
                          : 'hover:bg-slate-800 active:bg-slate-700 border-transparent hover:border-slate-700/70 text-slate-100'
                      }`}
                      title="Click or drag pin to manually set spot on road"
                    >
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 transition ${
                          isAdjustingLocation
                            ? 'bg-amber-500 text-slate-950 animate-bounce'
                            : 'bg-amber-500/20 text-amber-400 border border-amber-500/40 group-hover:scale-105'
                        }`}
                      >
                        📍
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          <span>Adjust Pin</span>
                          <span
                            className={`text-[9px] px-1 rounded font-extrabold ${
                              isAdjustingLocation ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {isAdjustingLocation ? 'ACTIVE' : 'Manual'}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">Manually drop/drag your position pin</p>
                      </div>
                    </button>

                    {/* 5. Convoy Identification Details */}
                    <button
                      type="button"
                      onClick={() => {
                        setIsMembersOpen(true);
                        setIsScrollMenuOpen(false);
                      }}
                      className="w-full text-left p-2 rounded-xl hover:bg-slate-800 active:bg-slate-700 border border-transparent hover:border-slate-700/70 transition flex items-center gap-2.5 group"
                      title="View convoy roster, roles, blood groups, and emergency contacts"
                    >
                      <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/40 flex items-center justify-center text-sm font-bold shrink-0 group-hover:scale-105 transition">
                        👥
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span>Convoy ID Details</span>
                          <span className="text-[9px] bg-indigo-900/60 text-indigo-200 px-1 rounded font-semibold">
                            {activeRidersList.length} Riders
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">Roster, blood groups & ICE contacts</p>
                      </div>
                    </button>

                    {/* 6. Report Road Hazard (Stage 10) */}
                    <button
                      type="button"
                      onClick={() => {
                        setShowReportHazardModal(true);
                        setIsScrollMenuOpen(false);
                      }}
                      className="w-full text-left p-2 rounded-xl hover:bg-slate-800 active:bg-slate-700 border border-orange-500/30 hover:border-orange-500/60 transition flex items-center gap-2.5 group bg-orange-950/20"
                      title="Report pothole, oil spill, roadblock, police check, or road hazard"
                    >
                      <div className="w-8 h-8 rounded-lg bg-orange-500/20 text-orange-400 border border-orange-500/40 flex items-center justify-center text-sm font-bold shrink-0 group-hover:scale-105 transition">
                        ⚠️
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span>Report Hazard</span>
                          <span className="text-[9px] bg-orange-900/80 text-orange-200 px-1.5 py-0.2 rounded font-semibold">
                            Crowdsource
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">Pothole, oil spill, road obstruction</p>
                      </div>
                      <span className="text-orange-300 font-bold text-xs group-hover:translate-x-0.5 transition-transform">
                        +
                      </span>
                    </button>

                    {/* 7. Convoy Simulation Lab (Stage 11) */}
                    <button
                      type="button"
                      onClick={() => {
                        setShowSimulationModal(true);
                        setIsScrollMenuOpen(false);
                      }}
                      className="w-full text-left p-2 rounded-xl hover:bg-slate-800 active:bg-slate-700 border border-cyan-500/30 hover:border-cyan-500/60 transition flex items-center gap-2.5 group bg-cyan-950/20"
                      title="Multi-rider simulation test lab (Overspeed, Straggler, Dead-Zone, SOS)"
                    >
                      <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 flex items-center justify-center text-sm font-bold shrink-0 group-hover:scale-105 transition">
                        🎮
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span>Simulation Lab</span>
                          <span className="text-[9px] bg-cyan-900/80 text-cyan-200 px-1.5 py-0.2 rounded font-semibold">
                            Stage 11
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">Multi-rider test rig & scenario inject</p>
                      </div>
                      <span className="text-cyan-300 font-bold text-xs group-hover:translate-x-0.5 transition-transform">
                        →
                      </span>
                    </button>
                  </div>

                  {/* Pinned Collapse Button Footer */}
                  <div className="shrink-0 p-2 border-t border-slate-800 bg-slate-900/95 text-center">
                    <button
                      type="button"
                      onClick={() => setIsScrollMenuOpen(false)}
                      className="w-full text-center text-[11px] text-slate-300 hover:text-white font-semibold flex items-center justify-center gap-1 py-1 rounded-lg hover:bg-slate-800 transition"
                    >
                      <span>▲ Collapse Menu</span>
                    </button>
                  </div>
                </>
              ) : (
                /* TAB 2: HELMET AUDIO & INTERCOM (Shown on the map surface) */
                <>
                  {/* Pinned Sub-Header with Back Button */}
                  <div className="shrink-0 px-3 py-2 border-b border-slate-800 flex items-center justify-between bg-slate-900/95">
                    <button
                      type="button"
                      onClick={() => setScrollMenuTab('tools')}
                      className="flex items-center gap-1 text-xs font-bold text-amber-400 hover:text-amber-300 py-1 px-2 rounded-lg hover:bg-slate-800 transition"
                    >
                      <span>←</span>
                      <span>Back to Tools</span>
                    </button>
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <span>🎧</span> Helmet Audio
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setIsScrollMenuOpen(false);
                        setScrollMenuTab('tools');
                      }}
                      className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition text-xs"
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Scrollable Helmet Audio Controls */}
                  <div className="flex-1 overflow-y-auto overscroll-contain p-2.5 space-y-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-slate-700 [&::-webkit-scrollbar-thumb]:rounded-full">
                    {/* 1. Spoken Voice Alerts (TTS) */}
                    <div className="flex items-center justify-between bg-slate-800/80 p-2 rounded-xl border border-slate-700/60">
                      <div className="pr-2 min-w-0">
                        <div className="font-bold text-xs flex items-center gap-1.5 text-slate-100">
                          <span>🔊</span>
                          <span>Voice Alerts (TTS)</span>
                        </div>
                        <div className="text-[10px] text-slate-400 leading-tight truncate">
                          Spoken speed, SOS & regroup warnings
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = saveVoiceSettings({ enabled: !voiceSettings.enabled });
                          setVoiceSettings(updated);
                        }}
                        className={`w-10 h-5 flex items-center rounded-full p-0.5 transition shrink-0 ${
                          voiceSettings.enabled ? 'bg-emerald-600 justify-end' : 'bg-slate-700 justify-start'
                        }`}
                        title="Toggle Spoken Voice Alerts"
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow" />
                      </button>
                    </div>

                    {/* 2. Bluetooth Headset Wake Mode */}
                    <div className="flex items-center justify-between bg-slate-800/80 p-2 rounded-xl border border-slate-700/60">
                      <div className="pr-2 min-w-0">
                        <div className="font-bold text-xs flex items-center gap-1.5 text-slate-100">
                          <span>🎧</span>
                          <span>Bluetooth Headset</span>
                        </div>
                        <div className="text-[10px] text-slate-400 leading-tight truncate">
                          Pre-chime prevents Sena/Cardo cut-off
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = saveVoiceSettings({ helmetMode: !voiceSettings.helmetMode });
                          setVoiceSettings(updated);
                        }}
                        className={`w-10 h-5 flex items-center rounded-full p-0.5 transition shrink-0 ${
                          voiceSettings.helmetMode ? 'bg-purple-600 justify-end' : 'bg-slate-700 justify-start'
                        }`}
                        title="Toggle Bluetooth Helmet Mode"
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow" />
                      </button>
                    </div>

                    {/* 3. Voice Volume Slider with Quick Presets */}
                    <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700/60 space-y-1.5">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-xs flex items-center gap-1.5">
                          <span>🎚️</span>
                          <span>Voice Volume</span>
                        </span>
                        <span className="text-[11px] text-amber-400 font-extrabold font-mono">
                          {Math.round((voiceSettings.volume || 1.0) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="1.0"
                        step="0.05"
                        value={voiceSettings.volume || 1.0}
                        onChange={(e) => {
                          const updated = saveVoiceSettings({ volume: parseFloat(e.target.value) });
                          setVoiceSettings(updated);
                        }}
                        className="w-full accent-amber-500 cursor-pointer h-2"
                      />
                      {/* Quick Volume Preset Chips for Riders */}
                      <div className="flex items-center justify-between gap-1 pt-0.5">
                        {[
                          { label: '50%', val: 0.5 },
                          { label: '75%', val: 0.75 },
                          { label: '100% Max', val: 1.0 },
                        ].map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() => {
                              const updated = saveVoiceSettings({ volume: preset.val });
                              setVoiceSettings(updated);
                            }}
                            className={`flex-1 py-1 rounded text-[10px] font-extrabold transition border ${
                              Math.abs((voiceSettings.volume || 1.0) - preset.val) < 0.05
                                ? 'bg-amber-500 text-slate-950 border-amber-400 font-black'
                                : 'bg-slate-900/80 text-slate-300 border-slate-700 hover:bg-slate-700'
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 4. Radio Channels (Lead / Sweep) */}
                    {(isLeader || (sweepRider && (sweepRider._id || sweepRider).toString() === user?.id)) && (
                      <div className="bg-slate-800/80 p-2 rounded-xl border border-slate-700/60">
                        <div className="font-bold text-xs mb-1.5 flex items-center justify-between">
                          <span className="flex items-center gap-1">
                            <span>📻</span>
                            <span>Radio Channel</span>
                          </span>
                          <span className="text-[9px] bg-purple-900/70 text-purple-200 px-1.5 py-0.2 rounded font-extrabold uppercase">
                            Commander
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPttChannel('CONVOY')}
                            className={`py-1.5 px-2 rounded-lg border text-[11px] font-bold transition flex items-center justify-center gap-1 ${
                              pttChannel === 'CONVOY'
                                ? 'bg-emerald-600 text-white border-emerald-400 shadow-sm'
                                : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                            }`}
                          >
                            <span>📢 Convoy</span>
                            {pttChannel === 'CONVOY' && <span>✓</span>}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPttChannel('LEAD_SWEEP')}
                            className={`py-1.5 px-2 rounded-lg border text-[11px] font-bold transition flex items-center justify-center gap-1 ${
                              pttChannel === 'LEAD_SWEEP'
                                ? 'bg-purple-600 text-white border-purple-400 shadow-sm'
                                : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                            }`}
                          >
                            <span>🛡️ Lead/Sweep</span>
                            {pttChannel === 'LEAD_SWEEP' && <span>✓</span>}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 5. Mute Incoming Radio */}
                    <div className="flex items-center justify-between bg-slate-800/80 p-2 rounded-xl border border-slate-700/60">
                      <div className="pr-2 min-w-0">
                        <div className="font-bold text-xs flex items-center gap-1.5 text-slate-100">
                          <span>🔇</span>
                          <span>Mute Radio Chatter</span>
                        </div>
                        <div className="text-[10px] text-slate-400 leading-tight truncate">
                          Silence incoming chatter during calls
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsPttMuted(!isPttMuted)}
                        className={`w-10 h-5 flex items-center rounded-full p-0.5 transition shrink-0 ${
                          isPttMuted ? 'bg-red-600 justify-end' : 'bg-slate-700 justify-start'
                        }`}
                        title="Mute/Unmute Incoming Radio"
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow" />
                      </button>
                    </div>
                  </div>

                  {/* Pinned Footer Actions: ALWAYS visible without scrolling */}
                  <div className="shrink-0 p-2 sm:p-2.5 bg-slate-900/98 border-t border-slate-800 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={testVoiceAlert}
                      className="flex-1 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 border border-slate-700 py-2 rounded-xl text-xs font-bold text-amber-300 transition flex items-center justify-center gap-1 shadow-sm"
                    >
                      <span>🧪 Test Voice</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsScrollMenuOpen(false);
                        setScrollMenuTab('tools');
                      }}
                      className="flex-1 bg-[#0091ff] hover:bg-[#007ee0] active:bg-blue-600 py-2 rounded-xl text-xs font-bold text-white transition shadow-md shadow-blue-500/20"
                    >
                      Done
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Live Pin Adjustment Floating Bar (PC / Manual Mode) */}
        {isAdjustingLocation && (
          <div className="absolute top-4 left-4 right-4 sm:left-24 sm:right-24 z-30 max-w-xl mx-auto bg-slate-900/95 backdrop-blur-md border border-emerald-500 rounded-xl p-3 shadow-2xl text-white space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-lg animate-pulse">🎯</span>
                <div>
                  <p className="text-xs font-bold text-emerald-300">Set Exact Location (PC / Manual Mode)</p>
                  <p className="text-[11px] text-slate-300">
                    Click anywhere on the road or map, drag the glowing pin, or search below:
                  </p>
                </div>
              </div>
              {pendingPin && (
                <span className="font-mono text-[10px] bg-slate-800 border border-slate-700 px-2 py-0.5 rounded text-emerald-400 font-semibold shrink-0">
                  {pendingPin.lat.toFixed(5)}, {pendingPin.lng.toFixed(5)}
                </span>
              )}
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="flex-1 text-slate-900">
                <PlaceAutocompleteInput
                  value={searchPlaceText}
                  onChange={setSearchPlaceText}
                  onSelectPlace={async (place) => {
                    setSearchPlaceText(place.description || place.mainText);
                    try {
                      const coords = await geocodePlace(place.description || place.mainText);
                      if (coords && mapRef.current) {
                        const pos = { lat: coords.lat, lng: coords.lon ?? coords.lng };
                        setPendingPin(pos);
                        mapRef.current.setView([pos.lat, pos.lng], 16, { animate: true });
                      }
                    } catch (e) {
                      console.warn('Geocoding error:', e);
                    }
                  }}
                  placeholder="Search town, street, landmark to drop pin..."
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleConfirmAdjustedLocation}
                  disabled={!pendingPin || isSavingPin}
                  className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs px-3.5 py-2 rounded shadow transition flex items-center gap-1.5"
                >
                  <span>{isSavingPin ? '⏳' : '✅'}</span>
                  <span>{isSavingPin ? 'Saving...' : 'Set My Spot'}</span>
                </button>
                <button
                  onClick={() => setIsAdjustingLocation(false)}
                  className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-3 py-2 rounded transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* GPS Live Status Indicator (Top Right beneath zoom control) */}
        <div className="absolute top-20 right-4 z-10">
          <div className="bg-slate-900/90 backdrop-blur border border-slate-700 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow-lg flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                gpsStatus === 'active'
                  ? 'bg-emerald-400 animate-ping'
                  : gpsStatus === 'simulating'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400'
              }`}
            />
            <span className="text-slate-200">
              {gpsStatus === 'active' ? 'GPS Tracking Active' : 'GPS Searching...'}
            </span>
          </div>
        </div>

        {/* 5. BOTTOM RIDER HUD (Speedometer, Convoy Members, Chat, SOS) */}
        <div className="absolute bottom-4 left-4 right-4 z-10 flex flex-wrap items-end justify-between gap-3 pointer-events-none">
          {/* Speedometer & Convoy Quick Bar */}
          <div className="pointer-events-auto bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-2xl p-3.5 shadow-xl text-white flex items-center gap-4">
            <div className="text-center pr-3 border-r border-slate-700">
              <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Speed</p>
              <div className="flex items-baseline justify-center">
                <span className="text-3xl font-extrabold tracking-tight text-emerald-400 font-mono">
                  {currentSpeed}
                </span>
                <span className="text-[10px] text-slate-400 ml-1">km/h</span>
              </div>
            </div>

            {/* Active Convoy Quick Avatars - Clickable to open drawer */}
            <div
              onClick={() => setIsMembersOpen(true)}
              className="cursor-pointer group"
              title="Click to view full identification details of all riders"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider group-hover:text-emerald-400 transition">
                  Convoy ({activeRidersList.length})
                </p>
                <span className="text-[9px] text-emerald-400 opacity-80 group-hover:underline">Details →</span>
              </div>
              <div className="flex items-center -space-x-2">
                {activeRidersList.slice(0, 5).map((r) => (
                  <div
                    key={r.userId}
                    className="w-8 h-8 rounded-full border-2 border-slate-900 bg-slate-700 flex items-center justify-center text-[11px] font-bold text-white overflow-hidden shadow"
                    title={`${r.name} (${r.speed || 0} km/h) - Blood: ${r.bloodGroup || 'N/A'}`}
                  >
                    {r.profilePic ? (
                      <img src={r.profilePic} alt={r.name} className="w-full h-full object-cover" />
                    ) : (
                      (r.name || 'R')[0].toUpperCase()
                    )}
                  </div>
                ))}
                {activeRidersList.length > 5 && (
                  <div className="w-8 h-8 rounded-full border-2 border-slate-900 bg-slate-800 text-[10px] flex items-center justify-center text-slate-300 font-semibold">
                    +{activeRidersList.length - 5}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Action Buttons: Chat & Emergency SOS */}
          <div className="pointer-events-auto flex items-center gap-3">
            {/* Live Chat Toggle Button */}
            <button
              onClick={() => setIsChatOpen(!isChatOpen)}
              className="relative bg-slate-900/90 backdrop-blur-md hover:bg-slate-800 text-white p-3.5 rounded-full shadow-xl border border-slate-700 flex items-center justify-center transition"
              title="Convoy Team Chat"
            >
              <svg className="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {messages.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-slate-900">
                  {messages.length}
                </span>
              )}
            </button>

            {/* Emergency SOS Button */}
            <button
              onClick={() => setShowSosModal(true)}
              className="bg-red-600 hover:bg-red-700 active:scale-95 text-white font-extrabold px-5 py-3 rounded-full shadow-2xl flex items-center gap-2 border-2 border-red-400/50 transition tracking-wider text-sm animate-pulse"
              title="Emergency SOS"
            >
              <span className="text-base">🚨</span>
              <span>SOS</span>
            </button>
          </div>
        </div>

        {/* 6. CONVOY MEMBERS & IDENTIFICATION DETAILS DRAWER */}
        {isMembersOpen && (
          <div className="absolute top-0 right-0 bottom-0 w-full sm:w-96 bg-slate-900/98 backdrop-blur-md border-l border-slate-800 z-30 flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between text-white">
              <div className="flex items-center gap-2">
                <span className="text-lg">👥</span>
                <div>
                  <h3 className="text-sm font-bold">Convoy Members Identification</h3>
                  <p className="text-[11px] text-slate-400">
                    {activeRidersList.length} riders currently active in live convoy
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsMembersOpen(false)}
                className="text-slate-400 hover:text-white p-1 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {/* Riders List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              {activeRidersList.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">
                  No riders joined yet.
                </p>
              ) : (
                activeRidersList.map((r) => {
                  const isConvoyLead =
                    ride?.creator?._id === r.userId || ride?.creator === r.userId;
                  const sweepId = sweepRider?._id || sweepRider;
                  const isSweep = Boolean(sweepId && sweepId.toString() === r.userId.toString());
                  const isMe = r.userId === user?.id;
                  const hasLocation =
                    typeof r.lat === 'number' && typeof r.lng === 'number';

                  return (
                    <div
                      key={r.userId}
                      className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-3 text-white space-y-2 hover:border-slate-600 transition shadow"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div className="relative w-10 h-10 rounded-full border-2 border-slate-600 bg-slate-700 flex items-center justify-center font-bold text-sm overflow-hidden flex-shrink-0">
                            {r.profilePic ? (
                              <img src={r.profilePic} alt={r.name} className="w-full h-full object-cover" />
                            ) : (
                              (r.name || 'R').charAt(0).toUpperCase()
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <h4 className="text-xs font-bold text-slate-100">
                                {r.name} {isMe && <span className="text-emerald-400">(You)</span>}
                              </h4>
                              {isConvoyLead && (
                                <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded font-semibold">
                                  👑 Lead
                                </span>
                              )}
                              {isSweep && (
                                <span className="text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/40 px-1.5 py-0.2 rounded font-semibold">
                                  🛡️ Sweep Rider
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400">
                              {r.role === 'rideAdmin' ? 'Organizer' : isSweep ? 'Rear Monitor (Sweep)' : 'Convoy Rider'}
                            </p>
                          </div>
                        </div>

                        {/* Blood Group Badge */}
                        <div className="bg-red-500/20 border border-red-500/40 text-red-300 text-[10px] font-extrabold px-2 py-0.5 rounded flex items-center gap-1">
                          <span>🩸</span>
                          <span>{r.bloodGroup || 'N/A'}</span>
                        </div>
                      </div>

                      {/* Contact & Location Details */}
                      <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-slate-700/60">
                        <div>
                          <span className="text-slate-400 block text-[10px]">PHONE</span>
                          {r.phone ? (
                            <a
                              href={`tel:${r.phone}`}
                              className="text-blue-400 hover:underline font-semibold"
                            >
                              📞 {r.phone}
                            </a>
                          ) : (
                            <span className="text-slate-500">Not provided</span>
                          )}
                        </div>

                        <div>
                          <span className="text-slate-400 block text-[10px]">LIVE SPEED</span>
                          <span className="font-bold text-emerald-400">
                            ⚡ {r.speed || 0} km/h
                          </span>
                        </div>

                        <div className="col-span-2 flex justify-between items-center">
                          <div>
                            <span className="text-slate-400 block text-[10px]">CONNECTION</span>
                            <span className={`font-bold text-[11px] flex items-center gap-1 ${
                              r.status === 'OFFLINE' || r.isOffline ? 'text-amber-400' :
                              r.status === 'STALE' ? 'text-red-400' :
                              r.status === 'WEAK' ? 'text-orange-400' :
                              'text-emerald-400'
                            }`}>
                              <span>{r.status === 'OFFLINE' || r.isOffline ? '📵 IN DEAD ZONE' : r.status === 'STALE' ? '⚠️ STALE' : '📡 LIVE'}</span>
                            </span>
                            {(r.status === 'OFFLINE' || r.isOffline) && r.deadZoneEnteredAt && (
                              <span className="text-[10px] text-amber-200/80 block font-medium">
                                Dropped signal ~{Math.max(1, Math.round((Date.now() - r.deadZoneEnteredAt)/60000))} min ago
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="col-span-2">
                          <span className="text-slate-400 block text-[10px]">
                            {r.status === 'OFFLINE' || r.isOffline ? 'LAST REPORTED GPS FIX' : 'EXACT GPS COORDINATES'}
                          </span>
                          {hasLocation ? (
                            <span className="font-mono text-slate-200 text-[11px]">
                              📍 Lat: {r.lat.toFixed(5)}, Lng: {r.lng.toFixed(5)}
                            </span>
                          ) : (
                            <span className="text-amber-400/80 text-[10px]">
                              ⏳ Waiting for GPS coordinates from device...
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action Buttons: Report, Sweep Toggle, Kick, Locate */}
                      <div className="pt-2 flex flex-wrap items-center justify-end gap-1.5 border-t border-slate-700/60">
                        {/* Private DM button (Available to all riders for any other rider) */}
                        {!isMe && (
                          <button
                            onClick={() => {
                              const targetId = (r.userId || r._id || r.id)?.toString();
                              setSelectedChatRecipient(targetId);
                              setUnreadPrivateCounts((prev) => ({ ...prev, [targetId]: 0 }));
                              setIsMembersOpen(false);
                              setIsChatOpen(true);
                            }}
                            className="text-[11px] bg-purple-600/90 hover:bg-purple-600 text-white font-bold px-2.5 py-1 rounded flex items-center gap-1 border border-purple-400 shadow-sm transition active:scale-95"
                            title={`Send direct private message to ${r.name}`}
                          >
                            <span>🔒</span>
                            <span>Chat</span>
                          </button>
                        )}

                        {/* Report Rider (Available to any rider against other riders) */}
                        {!isMe && (
                          <button
                            onClick={() => {
                              setReportingTargetUser(r);
                              setShowReportModal(true);
                            }}
                            className="text-[11px] bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-700/60 font-medium px-2 py-1 rounded flex items-center gap-1 transition"
                            title="Report safety or speed violation about this rider"
                          >
                            <span>🚨</span>
                            <span>Report</span>
                          </button>
                        )}

                        {/* Assign / Remove Sweep (Available to Convoy Leader) */}
                        {isLeader && !isConvoyLead && (
                          <button
                            onClick={() => handleAssignSweep(isSweep ? null : r.userId)}
                            disabled={isAssigningSweep}
                            className={`text-[11px] font-medium px-2 py-1 rounded flex items-center gap-1 border transition ${
                              isSweep
                                ? 'bg-purple-900/60 hover:bg-purple-800 text-purple-200 border-purple-500'
                                : 'bg-slate-700 hover:bg-slate-600 text-slate-200 border-slate-600'
                            }`}
                            title={isSweep ? 'Unassign Sweep role' : 'Appoint as Convoy Sweep (Tail) Rider'}
                          >
                            <span>🛡️</span>
                            <span>{isSweep ? 'Unassign Sweep' : 'Make Sweep'}</span>
                          </button>
                        )}

                        {/* Kick / Remove Member (Available to Convoy Leader) */}
                        {isLeader && !isMe && !isConvoyLead && (
                          <button
                            onClick={() => {
                              setKickingTargetUser(r);
                              setKickReason('Aggressive riding / Safety rule violation');
                              setShowKickModal(true);
                            }}
                            className="text-[11px] bg-red-600 hover:bg-red-700 text-white font-semibold px-2 py-1 rounded flex items-center gap-1 shadow-sm transition"
                            title="Remove this member from the ride"
                          >
                            <span>🚫</span>
                            <span>Kick</span>
                          </button>
                        )}

                        {/* Locate on Map / Last Seen */}
                        <button
                          onClick={() => handleLocateRider(r)}
                          className={`text-[11px] font-medium px-2.5 py-1 rounded flex items-center gap-1 border transition ${
                            r.status === 'OFFLINE' || r.isOffline
                              ? 'bg-amber-600/30 text-amber-200 border-amber-500 hover:bg-amber-600/50'
                              : 'bg-slate-700 hover:bg-slate-600 text-white border-slate-600'
                          }`}
                          title={r.status === 'OFFLINE' || r.isOffline ? 'Jump to last known dead-zone coordinate' : 'Center on rider'}
                        >
                          <span>{r.status === 'OFFLINE' || r.isOffline ? '📵' : '🎯'}</span>
                          <span>{r.status === 'OFFLINE' || r.isOffline ? 'Last Seen' : 'Locate'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* 7. IN-RIDE CHAT DRAWER */}
        {isChatOpen && (
          <div className="absolute top-0 right-0 bottom-0 w-full sm:w-96 md:w-[460px] bg-slate-900/98 backdrop-blur-md border-l border-slate-700 z-30 flex flex-col shadow-2xl">
            {/* Header */}
            <div className="p-3.5 sm:p-4 border-b border-slate-800 flex items-center justify-between text-white shrink-0 bg-slate-950/80">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-xl shrink-0">
                  {selectedChatRecipient === 'everyone' ? '💬' : '🔒'}
                </span>
                <div className="min-w-0">
                  <h3 className="text-base sm:text-lg font-bold leading-tight truncate">
                    {selectedChatRecipient === 'everyone'
                      ? 'Convoy Chat'
                      : `Direct: ${activeChatPartner?.name || 'Rider'}`}
                  </h3>
                  <span className="text-xs text-blue-400 font-medium block truncate">
                    {selectedChatRecipient === 'everyone'
                      ? '📢 Broadcasts to all convoy riders'
                      : '🔒 Private & direct 1-on-1 chat'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {/* Font Size Selector / Toggle for rider readability */}
                <div className="flex items-center bg-slate-800 border border-slate-700 rounded-lg p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => handleSetChatFontSize('normal')}
                    className={`px-2 py-1 rounded font-bold transition ${
                      chatFontSize === 'normal'
                        ? 'bg-blue-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                    title="Normal text size"
                  >
                    A
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetChatFontSize('large')}
                    className={`px-2 py-1 rounded font-bold transition ${
                      chatFontSize === 'large'
                        ? 'bg-blue-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                    title="Large text size (Recommended for riding)"
                  >
                    A+
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetChatFontSize('xlarge')}
                    className={`px-2 py-1 rounded font-extrabold transition ${
                      chatFontSize === 'xlarge'
                        ? 'bg-blue-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                    title="Extra Large text size (High Visibility / Bike mount)"
                  >
                    A++
                  </button>
                </div>

                <button
                  onClick={() => setIsChatOpen(false)}
                  className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 text-base transition"
                  title="Close chat"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Member Channel Selector (Everyone vs Private Rider) */}
            <div className="bg-slate-950/90 border-b border-slate-800 p-2.5 shrink-0 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-400 uppercase tracking-wider px-1">
                <span>Select Chat Channel</span>
                <span className="text-[10px] text-slate-500 font-normal">
                  {convoyMembers.filter((m) => m.id !== user?.id).length} other riders
                </span>
              </div>

              {/* Scrollable member channel pill tabs */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                {/* Everyone tab */}
                <button
                  type="button"
                  onClick={() => setSelectedChatRecipient('everyone')}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-1.5 shrink-0 transition ${
                    selectedChatRecipient === 'everyone'
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-900/40'
                      : 'bg-slate-800/90 hover:bg-slate-700 text-slate-300 border border-slate-700'
                  }`}
                >
                  <span>📢</span>
                  <span>Everyone</span>
                </button>

                {/* Individual Member tabs */}
                {convoyMembers
                  .filter((m) => m.id !== user?.id)
                  .map((member) => {
                    const isSelected = selectedChatRecipient === member.id;
                    const unreadCount = unreadPrivateCounts[member.id] || 0;
                    return (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => {
                          setSelectedChatRecipient(member.id);
                          setUnreadPrivateCounts((prev) => ({ ...prev, [member.id]: 0 }));
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-1.5 shrink-0 transition relative ${
                          isSelected
                            ? 'bg-purple-600 text-white shadow-md shadow-purple-900/50 ring-1 ring-purple-400'
                            : 'bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700'
                        }`}
                      >
                        <span>{member.isLead ? '👑' : member.isSweep ? '🛡️' : '👤'}</span>
                        <span className="truncate max-w-[120px]">{member.name}</span>
                        {unreadCount > 0 && (
                          <span className="bg-red-500 text-white text-[10px] font-black px-1.5 py-0.2 rounded-full animate-pulse ml-0.5 shadow">
                            {unreadCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>

            {/* Active Private Chat Notice Banner */}
            {selectedChatRecipient !== 'everyone' && (
              <div className="bg-purple-950/80 border-b border-purple-500/40 px-3.5 py-2 flex items-center justify-between text-xs text-purple-200 shrink-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-base shrink-0">🔒</span>
                  <span className="truncate">
                    Private direct chat with <strong>{activeChatPartner?.name}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedChatRecipient('everyone')}
                  className="bg-purple-800/90 hover:bg-purple-700 text-white font-bold px-2.5 py-1 rounded-lg text-xs shrink-0 transition ml-2"
                >
                  📢 Switch to Everyone
                </button>
              </div>
            )}

            {/* Messages Scroll Area */}
            <div className="flex-1 overflow-y-auto p-3.5 sm:p-4 space-y-3.5">
              {filteredMessages.length === 0 ? (
                <div className="text-center py-12 px-4">
                  <span className="text-4xl block mb-2">
                    {selectedChatRecipient === 'everyone' ? '💬' : '🔒'}
                  </span>
                  <p className="text-base font-bold text-slate-300">
                    {selectedChatRecipient === 'everyone'
                      ? 'No convoy messages yet'
                      : `No direct messages with ${activeChatPartner?.name || 'this member'} yet`}
                  </p>
                  <p className="text-xs sm:text-sm text-slate-400 mt-1">
                    {selectedChatRecipient === 'everyone'
                      ? 'Send quick status updates to keep the entire convoy coordinated!'
                      : 'Send a private direct message below. Only you two will see it!'}
                  </p>
                </div>
              ) : (
                filteredMessages.map((m, idx) => {
                  const isMe = m.sender?.id === user?.id;
                  const senderName = isMe ? 'You' : (m.sender?.name || 'Rider');
                  const formattedTime = m.createdAt
                    ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '';

                  // Dynamic size classes
                  const sizeConfig =
                    chatFontSize === 'xlarge'
                      ? {
                          name: 'text-base font-extrabold text-slate-200',
                          text: 'text-2xl sm:text-3xl font-extrabold leading-snug tracking-wide',
                          time: 'text-xs text-slate-400',
                          padding: 'px-4.5 py-3.5',
                        }
                      : chatFontSize === 'normal'
                      ? {
                          name: 'text-xs sm:text-sm font-bold text-slate-300',
                          text: 'text-base sm:text-lg font-semibold leading-relaxed',
                          time: 'text-[11px] text-slate-400',
                          padding: 'px-3.5 py-2.5',
                        }
                      : {
                          // 'large' (default for riders)
                          name: 'text-sm sm:text-base font-bold text-slate-200',
                          text: 'text-lg sm:text-xl font-bold leading-snug tracking-wide',
                          time: 'text-xs text-slate-400',
                          padding: 'px-4 py-3',
                        };

                  return (
                    <div
                      key={m.id || idx}
                      className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                    >
                      <div className="flex items-center gap-2 mb-1 px-1">
                        <span className={sizeConfig.name}>
                          {senderName}
                        </span>
                        {m.isPrivate && (
                          <span className="text-[10px] bg-purple-900/60 text-purple-300 border border-purple-500/40 px-1.5 py-0.2 rounded font-bold">
                            🔒 Private
                          </span>
                        )}
                        {formattedTime && (
                          <span className={sizeConfig.time}>
                            {formattedTime}
                          </span>
                        )}
                      </div>
                      <div
                        className={`${sizeConfig.text} ${sizeConfig.padding} rounded-2xl max-w-[90%] break-words shadow-lg ${
                          isMe
                            ? m.isPrivate
                              ? 'bg-purple-600 text-white rounded-br-xs shadow-purple-950/50 border border-purple-500'
                              : 'bg-blue-600 text-white rounded-br-xs shadow-blue-950/50 border border-blue-500'
                            : m.isPrivate
                            ? 'bg-slate-800 text-slate-50 rounded-bl-xs border-2 border-purple-500/60 shadow-slate-950/60'
                            : 'bg-slate-800 text-slate-50 rounded-bl-xs border border-slate-600 shadow-slate-950/60'
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatMessagesEndRef} />
            </div>

            {/* Quick Broadcast Chips */}
            <div className="px-3 py-2.5 bg-slate-950/70 border-t border-slate-800 shrink-0">
              <div className="text-[11px] uppercase font-bold text-slate-400 mb-1.5 px-1 tracking-wider">
                {selectedChatRecipient === 'everyone'
                  ? '⚡ Quick Rider Broadcasts (1-Tap)'
                  : `⚡ Quick Direct Message to ${activeChatPartner?.name || 'Rider'} (1-Tap)`}
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
                {[
                  { icon: '⛽', label: 'Fuel Stop in 5km' },
                  { icon: '🛑', label: 'Slowing down' },
                  { icon: '🔄', label: 'Regroup here' },
                  { icon: '⚠️', label: 'Hazard ahead' },
                  { icon: '✅', label: 'Road clear' },
                  { icon: '👍', label: 'All good' },
                  { icon: '☕', label: 'Tea / Break stop' },
                ].map(({ icon, label }) => {
                  const quickText = `${icon} ${label}`;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        const socket = getSocket();
                        if (socket) {
                          const recipientId =
                            selectedChatRecipient === 'everyone' ? null : selectedChatRecipient;
                          socket.emit('chat:send', { rideId, text: quickText, recipientId });
                        }
                      }}
                      className="bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-100 px-3.5 py-2 rounded-xl border border-slate-700 text-xs sm:text-sm font-bold whitespace-nowrap shadow-sm transition flex items-center gap-1.5 shrink-0"
                    >
                      <span className="text-sm">{icon}</span>
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Message Input Form */}
            <form onSubmit={handleSendMessage} className="p-3 sm:p-4 bg-slate-950/95 border-t border-slate-800 flex gap-2.5 shrink-0">
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={
                  selectedChatRecipient === 'everyone'
                    ? 'Type message to all riders...'
                    : `🔒 Private message to ${activeChatPartner?.name || 'rider'}...`
                }
                className="flex-1 bg-slate-800 border border-slate-700 text-white rounded-xl px-4 py-3 text-base sm:text-lg font-medium placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
              <button
                type="submit"
                disabled={!newMessage.trim()}
                className={`${
                  selectedChatRecipient === 'everyone'
                    ? 'bg-blue-600 hover:bg-blue-500'
                    : 'bg-purple-600 hover:bg-purple-500'
                } disabled:opacity-50 disabled:cursor-not-allowed text-white text-base sm:text-lg font-bold px-5 py-3 rounded-xl shadow-lg active:scale-95 transition flex items-center justify-center gap-1.5 shrink-0`}
              >
                <span>Send</span>
                <span className="text-base">
                  {selectedChatRecipient === 'everyone' ? '🚀' : '🔒'}
                </span>
              </button>
            </form>
          </div>
        )}
      </div>

      {/* 8. EMERGENCY SOS MODAL */}
      {showSosModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-red-500/50 rounded-2xl max-w-sm w-full p-6 text-white shadow-2xl space-y-4">
            <div className="text-center">
              <div className="w-14 h-14 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center mx-auto text-2xl mb-3 border border-red-500/40">
                🚨
              </div>
              <h3 className="text-lg font-bold text-red-400">Trigger Emergency SOS?</h3>
              <p className="text-xs text-slate-300 mt-1">
                This will immediately broadcast an urgent emergency alert with your current GPS coordinates to all members in this ride.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Emergency Situation / Description Note:
              </label>
              <textarea
                rows={2}
                value={sosNote}
                onChange={(e) => setSosNote(e.target.value)}
                placeholder="e.g. Bike crashed, puncture, severe injury, engine breakdown..."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
              />
              <p className="text-[11px] text-amber-400 font-medium mt-1">
                ⚠️ This description will be broadcasted live to all convoy riders and pinned on the map.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowSosModal(false)}
                className="flex-1 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTriggerSos}
                className="flex-1 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg shadow-red-600/30"
              >
                CONFIRM SOS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 9. TRIGGER REGROUP MODAL (For Convoy Leader) */}
      {showRegroupModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-amber-500/50 rounded-2xl max-w-sm w-full p-6 text-white shadow-2xl space-y-4">
            <div className="text-center">
              <div className="w-14 h-14 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center mx-auto text-2xl mb-3 border border-amber-500/40">
                🎯
              </div>
              <h3 className="text-lg font-bold text-amber-400">Initiate Convoy Regroup</h3>
              <p className="text-xs text-slate-300 mt-1">
                Broadcast an urgent regroup call to all riders in the convoy. A marker and guidance line will be drawn on everyone's screen.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1 font-semibold">
                  Halt Spot / Landmark Name:
                </label>
                <input
                  type="text"
                  value={regroupHaltName}
                  onChange={(e) => setRegroupHaltName(e.target.value)}
                  placeholder="e.g. HP Petrol Pump / Coffee Shop / Toll Gate"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-semibold">
                  Reason for Regroup:
                </label>
                <input
                  type="text"
                  value={regroupReason}
                  onChange={(e) => setRegroupReason(e.target.value)}
                  placeholder="e.g. Stragglers catchup, refuel, rain break"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div className="bg-slate-800/80 p-2.5 rounded-lg text-[11px] text-slate-300 border border-slate-700">
                <span className="font-bold text-amber-400">📍 Halt Coordinates:</span>{' '}
                {pendingPin ? (
                  <span>Custom Dropped Pin ({pendingPin.lat.toFixed(4)}, {pendingPin.lng.toFixed(4)})</span>
                ) : myLocation ? (
                  <span>Your Live GPS Position ({myLocation.lat.toFixed(4)}, {myLocation.lng.toFixed(4)})</span>
                ) : (
                  <span>Route Start Point</span>
                )}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowRegroupModal(false)}
                className="flex-1 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isTriggeringRegroup}
                onClick={() => handleTriggerRegroup()}
                className="flex-1 py-2 text-xs font-bold bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg shadow-lg shadow-amber-600/30 flex items-center justify-center gap-1.5"
              >
                <span>{isTriggeringRegroup ? '⏳' : '🚩'}</span>
                <span>{isTriggeringRegroup ? 'Broadcasting...' : 'Broadcast Regroup'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 10. STAGE 4: ROAD CONDITION & SPEED LIMIT MODAL */}
      {showSpeedLimitModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-5 text-white shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-xl">🛣️</span>
                <div>
                  <h3 className="text-sm font-bold text-white">Road Condition & Speed Limit</h3>
                  <p className="text-[11px] text-slate-400">
                    {isLeader ? 'Set speed limits to alert riders if they ride aggressively' : 'Current convoy speed rules'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSpeedLimitModal(false)}
                className="text-slate-400 hover:text-white text-sm p-1"
              >
                ✕
              </button>
            </div>

            {/* Presets Grid */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">Select Road Condition Preset:</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { name: 'Highway', icon: '🛣️', defaultSpeed: 80, desc: 'Expressways & Open Highways' },
                  { name: 'City', icon: '🏙️', defaultSpeed: 45, desc: 'Urban streets & dense traffic' },
                  { name: 'Ghats/Hills', icon: '⛰️', defaultSpeed: 40, desc: 'Hairpin bends & mountain roads' },
                  { name: 'Rain/Wet', icon: '🌧️', defaultSpeed: 50, desc: 'Slippery surfaces & low traction' },
                  { name: 'Night', icon: '🌙', defaultSpeed: 60, desc: 'Low visibility darkness' },
                  { name: 'Custom', icon: '⚙️', defaultSpeed: 80, desc: 'User-specified speed limit' },
                ].map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    disabled={!isLeader}
                    onClick={() => {
                      setSelectedRoadCondition(item.name);
                    }}
                    className={`p-2.5 rounded-xl border text-left flex flex-col justify-between transition ${
                      selectedRoadCondition === item.name
                        ? 'bg-amber-500/20 border-amber-500 text-white shadow'
                        : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-base">{item.icon}</span>
                      <span className="font-mono font-bold text-xs bg-slate-900/80 px-1.5 py-0.5 rounded text-amber-300">
                        {conditionSpeeds[item.name] ?? item.defaultSpeed}kph
                      </span>
                    </div>
                    <div className="mt-1">
                      <div className="font-bold text-xs text-slate-100">{item.name}</div>
                      <div className="text-[10px] text-slate-400 leading-tight">{item.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Speed Limit Editor for ALL Road Conditions */}
            {isLeader && (
              <div className="bg-slate-800/70 p-3 rounded-xl border border-slate-700/80 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <span>⚡</span>
                    <span>Speed Limit for <strong>{selectedRoadCondition}</strong>:</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleUpdateModalSpeed(customSpeedLimit - 5)}
                      className="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs"
                    >
                      -
                    </button>
                    <span className="font-mono font-extrabold text-sm text-amber-400 px-2 py-0.5 rounded bg-slate-900 border border-slate-700">
                      {customSpeedLimit} km/h
                    </span>
                    <button
                      type="button"
                      onClick={() => handleUpdateModalSpeed(customSpeedLimit + 5)}
                      className="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs"
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
                  value={customSpeedLimit}
                  onChange={(e) => {
                    handleUpdateModalSpeed(Number(e.target.value));
                  }}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span>20 km/h (Slow)</span>
                  <span>80 km/h (Standard)</span>
                  <span>140 km/h (Fast)</span>
                </div>
              </div>
            )}

            {isLeader ? (
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowSpeedLimitModal(false)}
                  className="flex-1 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleUpdateSpeedLimit(selectedRoadCondition, customSpeedLimit)}
                  className="flex-1 py-2 text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white rounded-lg shadow-lg shadow-amber-600/30"
                >
                  Apply & Broadcast Limit
                </button>
              </div>
            ) : (
              <p className="text-center text-[11px] text-slate-400 italic">
                Only the ride leader can adjust speed limits and road conditions.
              </p>
            )}
          </div>
        </div>
      )}

      {/* STAGE 10: LIVE ROAD WEATHER MODAL */}
      {showWeatherModal && liveWeather && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-5 text-white shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{liveWeather.icon || '🌤️'}</span>
                <div>
                  <h3 className="text-sm font-bold text-white">Live Road Weather & Atmosphere</h3>
                  <p className="text-[11px] text-slate-400">Real-time telemetry along active route via Open-Meteo</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWeatherModal(false)}
                className="text-slate-400 hover:text-white text-base p-1 rounded transition"
              >
                ✕
              </button>
            </div>

            {/* Weather Hero Card */}
            <div className={`p-4 rounded-xl border flex items-center justify-between ${
              liveWeather.isHazardous
                ? 'bg-gradient-to-r from-blue-950/80 to-slate-900 border-blue-500/50'
                : 'bg-gradient-to-r from-slate-800/80 to-slate-900 border-slate-700/80'
            }`}>
              <div className="flex items-center gap-3">
                <span className="text-4xl">{liveWeather.icon || '☀️'}</span>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold text-white font-mono">
                      {liveWeather.temperature ?? liveWeather.temp ?? '--'}
                    </span>
                    <span className="text-lg text-slate-300 font-bold">°C</span>
                  </div>
                  <div className="text-sm font-bold text-amber-400">
                    {liveWeather.condition || liveWeather.description || 'Fair'}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${
                  liveWeather.isHazardous ? 'bg-red-500/30 text-red-300 border border-red-500/50' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                }`}>
                  {liveWeather.isHazardous ? 'Hazard Alert' : 'Road Optimal'}
                </span>
                <div className="text-[10px] text-slate-400 mt-1 font-mono">
                  {liveWeather.isDay ? 'Day Conditions' : 'Night Riding'}
                </div>
              </div>
            </div>

            {/* Environmental 4-Grid */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-slate-800/70 border border-slate-700/60 p-2.5 rounded-xl">
                <div className="text-slate-400 text-[10px] uppercase font-bold flex items-center gap-1">
                  <span>💨</span> Wind Speed
                </div>
                <div className="text-base font-extrabold text-slate-100 mt-0.5 font-mono">
                  {liveWeather.windSpeed ?? '--'} <span className="text-xs font-normal text-slate-400">km/h</span>
                </div>
              </div>

              <div className="bg-slate-800/70 border border-slate-700/60 p-2.5 rounded-xl">
                <div className="text-slate-400 text-[10px] uppercase font-bold flex items-center gap-1">
                  <span>🌧️</span> Rain Probability
                </div>
                <div className="text-base font-extrabold text-slate-100 mt-0.5 font-mono">
                  {liveWeather.precipProb ?? 0} <span className="text-xs font-normal text-slate-400">%</span>
                </div>
              </div>

              <div className="bg-slate-800/70 border border-slate-700/60 p-2.5 rounded-xl">
                <div className="text-slate-400 text-[10px] uppercase font-bold flex items-center gap-1">
                  <span>🛣️</span> Recommended Surface
                </div>
                <div className="text-sm font-bold text-amber-300 mt-0.5">
                  {liveWeather.suggestedCondition || liveWeather.roadCondition || 'Highway'}
                </div>
              </div>

              <div className="bg-slate-800/70 border border-slate-700/60 p-2.5 rounded-xl">
                <div className="text-slate-400 text-[10px] uppercase font-bold flex items-center gap-1">
                  <span>⚡</span> Suggested Speed
                </div>
                <div className="text-base font-extrabold text-emerald-400 mt-0.5 font-mono">
                  {liveWeather.suggestedSpeedLimit || 80} <span className="text-xs font-normal text-slate-400">km/h</span>
                </div>
              </div>
            </div>

            {/* Caution Warning Box */}
            {(liveWeather.caution || liveWeather.warning || liveWeather.isHazardous) && (
              <div className="p-3 rounded-xl bg-amber-500/15 border border-amber-500/40 text-xs text-amber-200 flex items-start gap-2.5">
                <span className="text-base shrink-0">⚠️</span>
                <p className="leading-snug">
                  {liveWeather.caution || liveWeather.warning || 'Adverse weather on route. Reduce speed and keep extended following distance.'}
                </p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowWeatherModal(false)}
                className="flex-1 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition"
              >
                Close
              </button>
              {isLeader && (
                <button
                  type="button"
                  onClick={() => {
                    const targetCondition = liveWeather.suggestedCondition || liveWeather.roadCondition || 'Highway';
                    const targetLimit = liveWeather.suggestedSpeedLimit || 80;
                    handleUpdateSpeedLimit(targetCondition, targetLimit);
                    setShowWeatherModal(false);
                  }}
                  className="flex-1 py-2 text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white rounded-lg shadow-lg shadow-amber-600/30 transition flex items-center justify-center gap-1.5"
                >
                  <span>⚡</span>
                  <span>Apply {liveWeather.suggestedSpeedLimit || 80} km/h to Convoy</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 11. STAGE 4: REPORT RIDER MODAL */}
      {showReportModal && reportingTargetUser && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-red-500/50 rounded-2xl max-w-sm w-full p-5 text-white shadow-2xl space-y-4">
            <div className="text-center">
              <div className="w-12 h-12 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center mx-auto text-xl mb-2 border border-red-500/40">
                🚨
              </div>
              <h3 className="text-sm font-bold text-red-400">Report Rider Violation</h3>
              <p className="text-xs text-slate-300 mt-1">
                Report unsafe behavior or rule violations for <strong>{reportingTargetUser.name}</strong>.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1 font-semibold">Violation Reason:</label>
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-red-500"
                >
                  <option value="Rash Riding / Overspeeding">Rash Riding / Overspeeding</option>
                  <option value="Reckless Overtaking">Reckless Overtaking</option>
                  <option value="Stunts / Unsafe Maneuvers">Stunts / Unsafe Maneuvers</option>
                  <option value="Ignoring Convoy Signals">Ignoring Convoy Signals</option>
                  <option value="Rule Violation">Rule Violation</option>
                  <option value="Other">Other Safety Issue</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-semibold">Details / Comments (Optional):</label>
                <textarea
                  rows="2"
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  placeholder="Describe what happened (location, maneuver, etc.)..."
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-red-500 resize-none"
                />
              </div>

              {reportingTargetUser.speed > 0 && (
                <div className="bg-slate-800/80 p-2 rounded text-[11px] text-slate-300 flex justify-between">
                  <span>Current Rider Speed:</span>
                  <span className="font-bold text-amber-400">{reportingTargetUser.speed} km/h</span>
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowReportModal(false);
                  setReportingTargetUser(null);
                }}
                className="flex-1 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmittingReport}
                onClick={handleSubmitReport}
                className="flex-1 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg shadow-lg shadow-red-600/30 flex items-center justify-center gap-1"
              >
                <span>{isSubmittingReport ? '⏳' : '🚨'}</span>
                <span>{isSubmittingReport ? 'Submitting...' : 'Submit Report'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 12. STAGE 4: KICK RIDER MODAL (For Convoy Leader) */}
      {showKickModal && kickingTargetUser && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-red-600 rounded-2xl max-w-sm w-full p-5 text-white shadow-2xl space-y-4">
            <div className="text-center">
              <div className="w-12 h-12 bg-red-600/20 text-red-500 rounded-full flex items-center justify-center mx-auto text-2xl mb-2 border border-red-500/40">
                🚫
              </div>
              <h3 className="text-base font-bold text-red-400">Remove Rider from Convoy?</h3>
              <p className="text-xs text-slate-300 mt-1">
                Are you sure you want to remove <strong>{kickingTargetUser.name}</strong> from this live ride? They will be dropped from tracking and notified immediately.
              </p>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-semibold">Removal Reason:</label>
              <input
                type="text"
                value={kickReason}
                onChange={(e) => setKickReason(e.target.value)}
                placeholder="e.g. Repeated overspeeding, rash stunts, safety violations"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowKickModal(false);
                  setKickingTargetUser(null);
                }}
                className="flex-1 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isKickingRider}
                onClick={handleKickRider}
                className="flex-1 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg shadow-lg shadow-red-600/30 flex items-center justify-center gap-1"
              >
                <span>{isKickingRider ? '⏳' : '🚫'}</span>
                <span>{isKickingRider ? 'Removing...' : 'Confirm Remove'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 13. STAGE 4: KICKED NOTIFICATION MODAL (For Kicked User) */}
      {kickedNotice && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-red-500 rounded-2xl max-w-sm w-full p-6 text-white text-center shadow-2xl space-y-4">
            <div className="w-16 h-16 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center mx-auto text-3xl border-2 border-red-500/40 animate-pulse">
              🚫
            </div>
            <div>
              <h3 className="text-lg font-bold text-red-400">Removed from Convoy</h3>
              <p className="text-xs text-slate-300 mt-2">
                You have been removed from this ride by the ride organizer.
              </p>
            </div>

            <div className="bg-slate-800/90 border border-slate-700 p-3 rounded-xl text-left space-y-1 text-xs">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Reason given:</span>
              <p className="text-red-300 font-semibold">{kickedNotice.reason || 'Violated convoy safety rules / Aggressive riding'}</p>
            </div>

            <button
              onClick={() => navigate(`/groups/${ride.group}`)}
              className="w-full py-2.5 text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg shadow-red-600/30 transition"
            >
              Return to Group Rides
            </button>
          </div>
        </div>
      )}

      {/* 14. STAGE 10: REPORT ROAD HAZARD MODAL (Glove-Friendly Crowdsourcing) */}
      {showReportHazardModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-orange-500/80 rounded-2xl max-w-md w-full p-5 text-white shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">⚠️</span>
                <div>
                  <h3 className="text-base font-bold text-orange-400">Report Road Hazard</h3>
                  <p className="text-[11px] text-slate-400">Alert your convoy and nearby riders in real-time</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowReportHazardModal(false);
                  setHazardNote('');
                }}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 text-sm transition"
              >
                ✕
              </button>
            </div>

            {/* Quick 1-Tap Hazard Category Picker */}
            <div>
              <label className="block text-xs text-slate-300 mb-2 font-bold uppercase tracking-wider">
                Select Hazard Type:
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { type: 'POTHOLE', label: 'Pothole', icon: '⚠️', desc: 'Deep crater/trench' },
                  { type: 'OIL_SPILL', label: 'Oil Spill', icon: '🛢️', desc: 'Slick / diesel patch' },
                  { type: 'ROADBLOCK', label: 'Roadblock', icon: '🚧', desc: 'Barricade/work' },
                  { type: 'CATTLE_DEBRIS', label: 'Cattle/Debris', icon: '🐄', desc: 'Animals/cargo' },
                  { type: 'POLICE_CHECK', label: 'Police / RTO', icon: '🚔', desc: 'Diversion/check' },
                  { type: 'LOW_VISIBILITY', label: 'Fog / Low Vis', icon: '🌫️', desc: 'Smoke / dense fog' },
                  { type: 'ACCIDENT', label: 'Accident', icon: '💥', desc: 'Crash ahead' },
                  { type: 'OTHER', label: 'Other Hazard', icon: '⚠️', desc: 'General road issue' },
                ].map((item) => {
                  const isSelected = selectedHazardType === item.type;
                  return (
                    <button
                      key={item.type}
                      type="button"
                      onClick={() => setSelectedHazardType(item.type)}
                      className={`p-2.5 rounded-xl border text-left transition flex flex-col items-start gap-1 ${
                        isSelected
                          ? 'bg-orange-600/30 border-orange-400 ring-2 ring-orange-500/40 text-white'
                          : 'bg-slate-800/80 border-slate-700 hover:bg-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 w-full">
                        <span className="text-lg">{item.icon}</span>
                        <span className="text-xs font-bold leading-tight truncate">{item.label}</span>
                      </div>
                      <span className="text-[9px] text-slate-400 line-clamp-1">{item.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Optional Hazard Note */}
            <div>
              <label className="block text-xs text-slate-400 mb-1 font-semibold">
                Additional Details / Lane (Optional):
              </label>
              <input
                type="text"
                value={hazardNote}
                onChange={(e) => setHazardNote(e.target.value)}
                placeholder="e.g. Left lane near curve, slow down"
                maxLength={100}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>

            {/* GPS Location confirmation readout */}
            <div className="bg-slate-800/50 border border-slate-800 rounded-xl px-3 py-2 text-[11px] text-slate-400 flex items-center justify-between">
              <span>📍 Hazard Location:</span>
              <span className="font-mono text-slate-200 font-bold">
                {myLocation
                  ? `${myLocation.lat.toFixed(4)}, ${myLocation.lng.toFixed(4)} (Current GPS)`
                  : pendingPin
                  ? `${pendingPin.lat.toFixed(4)}, ${pendingPin.lng.toFixed(4)} (Dropped Pin)`
                  : 'Acquiring GPS...'}
              </span>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowReportHazardModal(false);
                  setHazardNote('');
                }}
                className="flex-1 py-2.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isReportingHazard}
                onClick={handleReportHazardSubmit}
                className="flex-1 py-2.5 text-xs font-bold bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-xl shadow-lg shadow-orange-600/30 flex items-center justify-center gap-1.5 transition active:scale-95"
              >
                <span>{isReportingHazard ? '⏳' : '📢'}</span>
                <span>{isReportingHazard ? 'Broadcasting...' : 'Broadcast Hazard'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 15. STAGE 11: CONVOY SIMULATION LAB MODAL */}
      <ConvoySimulationModal
        isOpen={showSimulationModal}
        onClose={() => setShowSimulationModal(false)}
        rideId={rideId}
        token={token}
        addToast={addToast}
      />
      {/* PRIMUS TACTICAL AI RIDE COMPANION */}
      <PrimusAssistant
        rideId={rideId}
        currentUserId={user?.id}
        isLeader={isLeader}
        socket={getSocket()}
        currentLocation={myLocation}
      />
    </div>
  );
}

export default LiveRidePage;
