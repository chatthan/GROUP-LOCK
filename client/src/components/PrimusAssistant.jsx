import { useState, useEffect, useRef, useCallback } from 'react';
import { apiRequest, ApiError } from '../services/api';
import { playJarvisWakeChime } from '../utils/audioAlerts';
import {
  WAKE_REGEX,
  TRAILING_FILLER,
  afterWake,
  buildTranscript,
  parseDeviceIntent,
  findContact,
  normalizePhone,
  whatsappLink,
  appInfo,
} from '../utils/primusIntents';

/**
 * PRIMUS - hands-free voice companion for GROUP-LOCK
 *
 * Voice Interaction State Machine:
 *  STANDBY   -> STARTING  (icon tap)
 *  STARTING  -> LISTENING_FOR_WAKE  (mic granted)
 *  LISTENING_FOR_WAKE -> AWAKE  (wake phrase detected)
 *  AWAKE -> PROCESSING  (command heard after silence)
 *  AWAKE -> LISTENING_FOR_WAKE  (window timeout 12s with no command)
 *  PROCESSING -> SPEAKING  (response received)
 *  SPEAKING -> LISTENING_FOR_WAKE  (utterance end, stays active for follow-ups)
 *  SPEAKING -> INTERRUPTED -> PROCESSING  (new speech detected mid-playback)
 *  Any -> STANDBY  (OFF button or deactivate command)
 *  Any -> ERROR (fatal mic failure) -> LISTENING_FOR_WAKE or STANDBY
 *
 * Key design principles:
 *  1. Recognizer created ONCE per mount — never recreated on re-renders.
 *  2. In STANDBY / idle mode, audio is completely ignored (no ambient commands).
 *  3. Wake phrase is required to enter AWAKE mode; after that follow-ups work.
 *  4. Silence-based command capture (not fixed timer only).
 *  5. Carry-over text prevents recognizer restarts from cutting sentences in half.
 *  6. Back-off delay prevents infinite rapid-restart loops.
 *  7. Wake lock keeps screen on; GPS position is tracked for accurate ETA/nearby.
 *  8. Proactive events are collected silently and only reported on request.
 *  9. Conversation history (last 6 turns) is sent to backend for follow-up context.
 * 10. Phone actions (call, WhatsApp, navigate) show ONE tap button — browser cannot
 *     press Send for you.
 */

// ── Tuning ──────────────────────────────────────────────────────────────────
const SILENCE_MS = 2000;           // pause that means "I'm done talking"
const SILENCE_AFTER_FILLER_MS = 3000; // longer wait when sentence ends mid-thought
const WAKE_ONLY_MS = 1000;         // "Hey Primus" + nothing else -> open active window
const WINDOW_MS = 12000;           // after the greeting, how long it waits for command
const POST_SPEECH_IGNORE_MS = 150; // brief buffer to absorb speaker tail without cutting words
const MONITOR_MS = 20000;          // quiet background supervision interval
const CONTACTS_KEY = 'primus_contacts_v1';

const GREETINGS = ['Yes sir?', 'At your service, sir.', 'Listening, sir.', 'Go ahead, sir.'];

const nowStamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function loadSavedContacts() {
  try {
    return JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]');
  } catch {
    return [];
  }
}

function PrimusAssistant({ rideId, currentUserId = null, isLeader = false, socket = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [isAwake, setIsAwake] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [inputCommand, setInputCommand] = useState('');
  const [loading, setLoading] = useState(false);
  const [permissionError, setPermissionError] = useState(null);
  const [action, setAction] = useState(null); // pending phone action card
  const [showContacts, setShowContacts] = useState(false);
  const [savedContacts, setSavedContacts] = useState(loadSavedContacts);
  const [rideContacts, setRideContacts] = useState([]);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [history, setHistory] = useState([
    { sender: 'primus', text: 'Tap the icon to activate me, then say "Hey Primus".', time: nowStamp() },
  ]);

  // ── Refs (voice engine lives in refs so re-renders never touch the mic) ─────
  const recognizerRef = useRef(null);
  const chatScrollRef = useRef(null);
  const voiceRef = useRef(null);
  const isActiveRef = useRef(false);
  const voiceEnabledRef = useRef(true);
  const isSpeakingRef = useRef(false);
  const busyRef = useRef(false);
  const modeRef = useRef('idle'); // 'idle' | 'wake' | 'window'
  const captureTextRef = useRef('');
  const carryRef = useRef(''); // text captured before the recognizer restarted mid-sentence
  const consumedLenRef = useRef(0);
  const fullLenRef = useRef(0);
  const ignoreUntilRef = useRef(0);
  const silenceTimerRef = useRef(null);
  const windowTimerRef = useRef(null);
  const restartTimerRef = useRef(null);
  const lastStartRef = useRef(0);
  const quickEndsRef = useRef(0);
  const posRef = useRef(null);
  const watchIdRef = useRef(null);
  const wakeLockRef = useRef(null);
  const eventsRef = useRef([]); // quiet background log
  const historyRef = useRef([]);
  const contactsRef = useRef([]);
  const processRef = useRef(() => {});
  const speakRef = useRef(() => {});
  const deactivateRef = useRef(() => {});

  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => {
    contactsRef.current = [...savedContacts, ...rideContacts];
  }, [savedContacts, rideContacts]);
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [history, action]);

  const addMsg = useCallback((sender, text, extra = {}) => {
    setHistory((prev) => [...prev.slice(-60), { sender, text, time: nowStamp(), ...extra }]);
  }, []);

  // ── Voice selection ───────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      voiceRef.current =
        voices.find((v) => /en[-_]GB/i.test(v.lang) && /male|daniel|arthur|oliver|george/i.test(v.name)) ||
        voices.find((v) => /en[-_]IN/i.test(v.lang)) ||
        voices.find((v) => /en[-_]GB/i.test(v.lang)) ||
        voices.find((v) => v.lang.startsWith('en')) ||
        voices[0];
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
  }, []);

  // ── Speaking (sentence-by-sentence; Chrome cuts long utterances) ──────────
  const speak = useCallback((text, onDone) => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    const finish = () => {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      ignoreUntilRef.current = Date.now() + POST_SPEECH_IGNORE_MS;
      consumedLenRef.current = fullLenRef.current; // discard whatever mic heard of our own voice
      if (onDone) onDone();
    };
    if (!voiceEnabledRef.current || !synth || !text) {
      if (onDone) onDone();
      return;
    }
    synth.cancel();
    const parts = text.match(/[^.!?]+[.!?]*/g)?.map((p) => p.trim()).filter(Boolean) || [text];
    isSpeakingRef.current = true;
    setIsSpeaking(true);
    let i = 0;
    const next = () => {
      if (i >= parts.length) return finish();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voiceRef.current) {
        u.voice = voiceRef.current;
        u.lang = voiceRef.current.lang;
      }
      u.rate = 1.02;
      u.pitch = 0.97;
      u.onend = next;
      u.onerror = finish;
      synth.speak(u);
    };
    next();
  }, []);
  useEffect(() => { speakRef.current = speak; }, [speak]);

  const reply = useCallback(
    (text, extra = {}) => {
      addMsg('primus', text, extra);
      speakRef.current(text);
    },
    [addMsg]
  );

  // ── Contacts ──────────────────────────────────────────────────────────────
  const saveContacts = useCallback((list) => {
    setSavedContacts(list);
    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
  }, []);

  const addContact = useCallback(
    (name, phone) => {
      const num = normalizePhone(phone);
      if (!name || !num) return null;
      const entry = { name: name.trim(), phone: num };
      saveContacts([entry, ...savedContacts.filter((c) => c.name.toLowerCase() !== entry.name.toLowerCase())]);
      return entry;
    },
    [saveContacts, savedContacts]
  );

  const loadRideContacts = useCallback(async () => {
    if (!rideId) return;
    try {
      const res = await apiRequest(`/primus/contacts/${rideId}`);
      if (res?.success) setRideContacts(res.contacts.map((c) => ({ name: c.name, phone: c.phone, from: 'group' })));
    } catch { /* optional */ }
  }, [rideId]);

  const importPhoneContacts = useCallback(async () => {
    // Contact Picker API: Chrome on Android over HTTPS. Must be triggered by a tap.
    try {
      if (!('contacts' in navigator) || !('ContactsManager' in window)) {
        addMsg('primus-err', 'This browser cannot open the phone contact picker. Add the number manually below.');
        return null;
      }
      const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
      const entries = picked
        .map((p) => ({ name: p.name?.[0] || '', phone: normalizePhone(p.tel?.[0] || '') }))
        .filter((e) => e.name && e.phone);
      if (entries.length) {
        const merged = [...entries, ...savedContacts.filter((c) => !entries.some((e) => e.name.toLowerCase() === c.name.toLowerCase()))];
        saveContacts(merged);
        addMsg('primus', `Imported ${entries.length} contact${entries.length > 1 ? 's' : ''}, sir.`);
      }
      return entries;
    } catch {
      return null; // picker dismissed
    }
  }, [addMsg, saveContacts, savedContacts]);

  // ── Phone actions (prepare, then ONE tap) ─────────────────────────────────
  const handleDeviceIntent = useCallback(
    (intent) => {
      const contacts = contactsRef.current;

      if (intent.type === 'message' || intent.type === 'call') {
        const c = findContact(intent.name, contacts);
        const body = intent.type === 'message' ? capFirst(intent.body) : '';
        if (!c) {
          setAction({ kind: 'need_contact', name: intent.name, body, intentType: intent.type });
          reply(`I can't find ${intent.name} in your contacts, sir. Tap the button to pick them, or type the number.`);
          return;
        }
        const phone = normalizePhone(c.phone);
        if (!phone) {
          reply(`${c.name} has no valid phone number saved, sir.`);
          return;
        }
        if (intent.type === 'call') {
          setAction({ kind: 'call', title: `Call ${c.name}`, href: `tel:+${phone}` });
          reply(`Ready to call ${c.name}, sir. Tap Call.`);
        } else {
          setAction({
            kind: 'whatsapp',
            title: `WhatsApp ${c.name}`,
            detail: `"${body}"`,
            href: whatsappLink(phone, body),
            contactName: c.name,
            body,
            inGroup: c.from === 'group',
          });
          reply(`Message to ${c.name} is ready, sir: "${body}". Tap Send on WhatsApp.`);
        }
        return;
      }

      if (intent.type === 'navigate') {
        setAction({
          kind: 'navigate',
          title: `Navigate to ${capFirst(intent.place)}`,
          href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(intent.place)}&travelmode=driving`,
        });
        reply(`Navigation to ${intent.place} is ready, sir. Tap Start.`);
        return;
      }

      if (intent.type === 'youtube_search') {
        setAction({
          kind: 'open',
          title: `YouTube: ${intent.query}`,
          href: `https://www.youtube.com/results?search_query=${encodeURIComponent(intent.query)}`,
        });
        reply(`Search for ${intent.query} is ready, sir. Tap Open.`);
        return;
      }

      if (intent.type === 'open_app') {
        const info = appInfo(intent.app);
        setAction({ kind: 'open', title: `Open ${info.label}`, href: info.href });
        reply(`${info.label} is ready, sir. Tap Open.`);
      }
    },
    [reply]
  );

  // ── Server command ─────────────────────────────────────────────────────────
  const sendToServer = useCallback(
    async (text, actionOverride = null, parameters = undefined) => {
      const turns = historyRef.current
        .filter((m) => m.sender === 'user' || m.sender === 'primus')
        .slice(-6)
        .map((m) => ({ role: m.sender === 'user' ? 'user' : 'assistant', text: m.text }));
      try {
        const res = await apiRequest('/primus/command', {
          method: 'POST',
          body: { rideId, command: text, action: actionOverride, parameters, location: posRef.current, history: turns },
        });
        if (res?.success) {
          const spoken = res.spokenResponse || 'Done, sir.';
          if (res.action === 'deactivate_primus') {
            addMsg('primus', spoken);
            speakRef.current(spoken, () => deactivateRef.current());
            return;
          }
          if (res.action === 'open_chat' || res.action === 'send_group_message') {
            window.dispatchEvent(new CustomEvent('primus:toggle_chat', { detail: { open: true } }));
          } else if (res.action === 'close_chat') {
            window.dispatchEvent(new CustomEvent('primus:toggle_chat', { detail: { open: false } }));
          } else if (res.action === 'open_contacts') {
            setShowContacts(true);
          } else if (res.action === 'close_contacts') {
            setShowContacts(false);
          }
          reply(spoken, { data: res.data });
        } else {
          reply(res?.spokenResponse || res?.error || "I couldn't do that, sir.");
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'I lost connection to the server, sir.';
        addMsg('primus-err', msg);
        speakRef.current('Connection problem, sir. Please try again.');
      }
    },
    [rideId, addMsg, reply]
  );

  // ── One utterance in, one answer out ──────────────────────────────────────
  const processUtterance = useCallback(
    async (rawText, actionOverride = null) => {
      const text = (rawText || '').replace(/^[\s,.]+/, '').trim();
      if (!text && !actionOverride) return;
      if (busyRef.current) return;
      busyRef.current = true;
      setLoading(true);
      setLiveTranscript('');
      setInputCommand('');
      addMsg('user', text || actionOverride.replace(/_/g, ' '));
      try {
        const lower = text.toLowerCase();

        if (!actionOverride) {
          // Quiet background log: only read out when the rider asks
          if (/\b(any|what).*(update|alert|hazard|happen|miss|news)\b|\bstatus report\b/.test(lower) && !/weather/.test(lower)) {
            const evs = eventsRef.current.splice(0);
            reply(evs.length ? `${evs.length} update${evs.length > 1 ? 's' : ''}, sir. ${evs.slice(0, 3).join(' ')}` : 'All quiet, sir. Nothing to report.');
            return;
          }
          if (/\b(stop listening|go to sleep|standby|go offline)\b/.test(lower)) {
            const msg = 'Going on standby, sir. Safe riding.';
            addMsg('primus', msg);
            speakRef.current(msg, () => deactivateRef.current());
            return;
          }

          // Direct local UI commands:
          if (/\b(close\s+contact|close\s+contacts|hide\s+contact|hide\s+contacts|dismiss\s+contact)\b/i.test(lower)) {
            setShowContacts(false);
            reply('Closing contacts panel, sir.');
            return;
          }
          if (/\b(open\s+contact|open\s+contacts|show\s+contact|show\s+contacts)\b/i.test(lower) || /^contacts?$/i.test(lower.trim())) {
            setShowContacts(true);
            reply('Opening contacts panel, sir.');
            return;
          }
          if (
            (/\b(open\s+(?:the\s+)?chat(?:\s+box)?|show\s+chat|view\s+chat)\b/i.test(lower) ||
             /^(?:the\s+)?chat(?:\s+box)?$/i.test(lower.trim())) &&
            !/\b(send|tell|message|post|write|say)\b/i.test(lower)
          ) {
            window.dispatchEvent(new CustomEvent('primus:toggle_chat', { detail: { open: true } }));
            reply('Opening the in-ride chat drawer, sir.');
            return;
          }
          if (/\b(close\s+(?:the\s+)?chat(?:\s+box)?|hide\s+chat|dismiss\s+chat)\b/i.test(lower)) {
            window.dispatchEvent(new CustomEvent('primus:toggle_chat', { detail: { open: false } }));
            reply('Closing the chat drawer, sir.');
            return;
          }
          if (/\b(close\s+(?:hud|assistant|primus)|minimize\s+(?:hud|assistant|primus)|hide\s+(?:hud|assistant|primus))\b/i.test(lower)) {
            setIsOpen(false);
            reply('Minimizing assistant HUD, sir.');
            return;
          }
          if (/\b(open\s+(?:hud|assistant|primus)|expand\s+(?:hud|assistant|primus)|show\s+(?:hud|assistant|primus))\b/i.test(lower)) {
            setIsOpen(true);
            reply('Expanding assistant HUD, sir.');
            return;
          }

          const intent = parseDeviceIntent(text, contactsRef.current);
          if (intent) {
            handleDeviceIntent(intent);
            return;
          }
        }
        await sendToServer(text, actionOverride);
      } finally {
        setLoading(false);
        busyRef.current = false;
      }
    },
    [addMsg, reply, handleDeviceIntent, sendToServer]
  );
  useEffect(() => { processRef.current = processUtterance; }, [processUtterance]);

  // ── Voice engine ──────────────────────────────────────────────────────────
  const clearTimers = () => {
    clearTimeout(silenceTimerRef.current);
    clearTimeout(windowTimerRef.current);
  };

  const endCapture = useCallback(() => {
    clearTimers();
    modeRef.current = 'idle';
    captureTextRef.current = '';
    carryRef.current = '';
    consumedLenRef.current = fullLenRef.current;
    setIsAwake(false);
    setLiveTranscript('');
  }, []);

  const openWindow = useCallback(() => {
    // Wake word with no command: chime, acknowledge visually, and open active window
    clearTimers();
    modeRef.current = 'window';
    captureTextRef.current = '';
    carryRef.current = '';
    setIsAwake(true);
    setLiveTranscript('Listening, sir...');
    playJarvisWakeChime();
    windowTimerRef.current = setTimeout(() => {
      if (modeRef.current === 'window' && !captureTextRef.current) endCapture();
    }, WINDOW_MS);
  }, [endCapture]);

  const finalizeCapture = useCallback(() => {
    const text = captureTextRef.current.trim();
    if (text.length >= 2) {
      endCapture();
      processRef.current(text);
    } else {
      openWindow();
    }
  }, [endCapture, openWindow]);

  const armSilenceTimer = useCallback(
    (text) => {
      clearTimeout(silenceTimerRef.current);
      clearTimeout(windowTimerRef.current);
      const ms = text ? (TRAILING_FILLER.test(text.trim()) ? SILENCE_AFTER_FILLER_MS : SILENCE_MS) : WAKE_ONLY_MS;
      silenceTimerRef.current = setTimeout(finalizeCapture, ms);
    },
    [finalizeCapture]
  );

  const startRecognizer = useCallback(() => {
    const r = recognizerRef.current;
    if (!r || !isActiveRef.current) return;
    try {
      lastStartRef.current = Date.now();
      r.start();
    } catch { /* already started */ }
  }, []);

  // Create the recognizer ONCE per mount.
  // (The old version rebuilt it whenever handleSendCommand changed, which stopped
  //  the mic mid-sentence — that was the main cause of audio cut-offs.)
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setPermissionError('This browser has no speech recognition. Use Chrome on Android.');
      return undefined;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-IN';
    r.maxAlternatives = 1;

    r.onstart = () => {
      consumedLenRef.current = 0;
      fullLenRef.current = 0;
    };

    r.onresult = (event) => {
      const full = buildTranscript(event.results);
      fullLenRef.current = full.length;
      if (isSpeakingRef.current || busyRef.current || Date.now() < ignoreUntilRef.current) {
        consumedLenRef.current = full.length;
        return;
      }
      if (consumedLenRef.current > full.length) consumedLenRef.current = 0;
      const heard = full.slice(consumedLenRef.current).trim();
      if (!heard) return;

      if (modeRef.current === 'idle') {
        if (!WAKE_REGEX.test(heard)) return; // ambient talk: ignore completely
        modeRef.current = 'wake';
        setIsAwake(true);
        playJarvisWakeChime();
      }

      const directive = modeRef.current === 'wake' ? afterWake(heard) : WAKE_REGEX.test(heard) ? afterWake(heard) : heard;
      const combined = `${carryRef.current} ${directive}`.trim();
      captureTextRef.current = combined;
      setLiveTranscript(combined || 'Listening...');
      armSilenceTimer(combined);
    };

    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setPermissionError('Microphone permission is blocked. Allow it in the browser settings, then tap the icon.');
        isActiveRef.current = false;
        setIsActive(false);
      } else if (e.error === 'audio-capture') {
        setPermissionError('No microphone found, or another app is using it.');
      }
      // 'no-speech' / 'aborted' / 'network' are normal; onend restarts
    };

    r.onend = () => {
      // keep whatever was captured so a restart doesn't cut a sentence in half
      if (modeRef.current !== 'idle' && captureTextRef.current) carryRef.current = captureTextRef.current;
      if (!isActiveRef.current) return;
      const ranFor = Date.now() - lastStartRef.current;
      quickEndsRef.current = ranFor < 1500 ? quickEndsRef.current + 1 : 0;
      const delay = Math.min(300 * 2 ** Math.min(quickEndsRef.current, 4), 4000); // back-off if it keeps dying
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(startRecognizer, delay);
    };

    recognizerRef.current = r;
    return () => {
      isActiveRef.current = false;
      clearTimers();
      clearTimeout(restartTimerRef.current);
      try { r.abort(); } catch { /* noop */ }
    };
  }, [armSilenceTimer, startRecognizer]);

  // ── Background services while active: GPS, wake lock, quiet supervision ────
  useEffect(() => {
    if (!isActive) return undefined;

    if (navigator.geolocation) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (p) => {
          posRef.current = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            speed: p.coords.speed != null ? Math.round(p.coords.speed * 3.6) : null,
          };
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      );
    }

    const lockScreen = async () => {
      try {
        if ('wakeLock' in navigator && !wakeLockRef.current) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          wakeLockRef.current.addEventListener('release', () => { wakeLockRef.current = null; });
        }
      } catch { /* not allowed (battery saver) */ }
    };
    lockScreen();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        lockScreen();
        startRecognizer();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    loadRideContacts();

    const monitor = async () => {
      if (!rideId) return;
      try {
        const res = await apiRequest(`/primus/proactive/${rideId}`);
        (res?.insights || []).forEach((i) => {
          if (!eventsRef.current.includes(i.message)) eventsRef.current.push(i.message);
        });
        eventsRef.current = eventsRef.current.slice(-15);
      } catch { /* silent */ }
    };
    monitor();
    const iv = setInterval(monitor, MONITOR_MS);

    const onLeader = (p) => eventsRef.current.push(`${p.fromName} says: ${p.reason}.`);
    const onRegroup = (p) => eventsRef.current.push(`${p.proposedBy} proposed a regroup at ${p.name}.`);
    socket?.on?.('primus:leader_alert', onLeader);
    socket?.on?.('primus:regroup_proposed', onRegroup);

    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      try { wakeLockRef.current?.release(); } catch { /* noop */ }
      wakeLockRef.current = null;
      socket?.off?.('primus:leader_alert', onLeader);
      socket?.off?.('primus:regroup_proposed', onRegroup);
    };
  }, [isActive, rideId, socket, loadRideContacts, startRecognizer]);

  // ── Activate / deactivate ─────────────────────────────────────────────────
  async function activate() {
    setPermissionError(null);
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop()); // just asking permission
      }
    } catch {
      setPermissionError('Microphone access is needed. Allow it in the browser settings.');
      return;
    }
    playJarvisWakeChime();
    isActiveRef.current = true;
    setIsActive(true);
    quickEndsRef.current = 0;
    startRecognizer();
    addMsg('primus', 'Online. I am listening in the background. Say "Hey Primus" when you need me.');
  }

  const deactivate = useCallback(() => {
    isActiveRef.current = false;
    setIsActive(false);
    setIsOpen(false);
    clearTimers();
    clearTimeout(restartTimerRef.current);
    modeRef.current = 'idle';
    captureTextRef.current = '';
    carryRef.current = '';
    setIsAwake(false);
    setLiveTranscript('');
    window.speechSynthesis?.cancel();
    try { recognizerRef.current?.abort(); } catch { /* noop */ }
  }, []);
  useEffect(() => { deactivateRef.current = deactivate; }, [deactivate]);

  function handleIconClick() {
    if (!isActive) activate();
    else setIsOpen((o) => !o);
  }

  function restartMic() {
    setPermissionError(null);
    try { recognizerRef.current?.abort(); } catch { /* noop */ }
    isActiveRef.current = true;
    setIsActive(true);
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(startRecognizer, 250);
  }

  // ── Action-card handlers ──────────────────────────────────────────────────
  async function pickContactForAction() {
    const picked = await importPhoneContacts();
    if (!picked) return;
    const c = findContact(action.name, [...picked, ...contactsRef.current]);
    if (!c) {
      reply(`I still can't match ${action.name}, sir. Try saying the contact's saved name.`);
      return;
    }
    handleDeviceIntent({ type: action.intentType, name: c.name, body: action.body });
  }

  function saveManualForAction() {
    const entry = addContact(action.name, manualPhone);
    if (!entry) {
      addMsg('primus-err', 'That number does not look valid.');
      return;
    }
    setManualPhone('');
    handleDeviceIntent({ type: action.intentType, name: entry.name, body: action.body });
  }

  async function sendInRideChat() {
    const text = `@${action.contactName} ${action.body}`;
    setAction(null);
    addMsg('user', `(ride chat) ${text}`);
    await sendToServer(text, 'send_group_message', { message: text });
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const stateLabel = isAwake
    ? 'Listening to you…'
    : isSpeaking
    ? 'Speaking…'
    : loading
    ? 'Thinking…'
    : 'Standing by — say "Hey Primus"';

  const ringClass = !isActive
    ? 'bg-slate-800/90 border border-slate-700 opacity-80'
    : isAwake
    ? 'bg-gradient-to-r from-amber-400 via-orange-500 to-red-500 ring-2 ring-amber-300'
    : isSpeaking
    ? 'bg-gradient-to-r from-purple-500 via-indigo-500 to-cyan-500'
    : 'bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600';

  const actionCard = action && (
    <div className="rounded-2xl border border-cyan-400/60 bg-slate-900/95 p-3 text-xs shadow-xl">
      {action.kind === 'need_contact' ? (
        <>
          <p className="font-bold text-cyan-300">Who is "{action.name}"?</p>
          <p className="text-slate-300 mt-0.5">Pick them from your phone contacts or type their number.</p>
          <div className="mt-2 flex flex-wrap gap-2 items-center">
            <button type="button" onClick={pickContactForAction} className="px-3 py-1.5 rounded-lg bg-cyan-600 text-slate-950 font-bold">
              Pick from contacts
            </button>
            <input
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              inputMode="tel"
              placeholder="or type number"
              className="flex-1 min-w-[110px] bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-white"
            />
            <button type="button" onClick={saveManualForAction} disabled={!manualPhone.trim()} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white disabled:opacity-40">
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="font-bold text-cyan-300">{action.title}</p>
          {action.detail && <p className="text-slate-200 mt-0.5">{action.detail}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setTimeout(() => setAction(null), 400)}
              className="px-4 py-2 rounded-xl bg-emerald-500 text-slate-950 font-extrabold text-sm"
            >
              {action.kind === 'whatsapp' ? 'Open WhatsApp & Send' : action.kind === 'call' ? 'Call' : action.kind === 'navigate' ? 'Start' : 'Open'}
            </a>
            {action.kind === 'whatsapp' && action.inGroup && (
              <button type="button" onClick={sendInRideChat} className="px-3 py-2 rounded-xl bg-cyan-700 text-white font-bold">
                Send in ride chat instead
              </button>
            )}
            <button type="button" onClick={() => setAction(null)} className="px-3 py-2 rounded-xl bg-slate-800 text-slate-300">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      {/* Floating icon: tap once to activate, tap again to open/close the panel */}
      <div className="fixed top-20 right-4 z-40 flex flex-col items-end gap-2 select-none">
        <button
          type="button"
          onClick={handleIconClick}
          title={isActive ? 'PRIMUS is listening (tap for panel)' : 'Tap to activate PRIMUS'}
          className={`relative w-14 h-14 sm:w-16 sm:h-16 rounded-full p-0.5 shadow-2xl transition active:scale-95 flex items-center justify-center ${ringClass}`}
        >
          {isActive && <span className={`absolute -inset-1.5 rounded-full pointer-events-none ${isAwake ? 'bg-amber-400/40 animate-ping' : 'bg-cyan-400/15 animate-pulse'}`} />}
          <div className="w-full h-full rounded-full bg-slate-950 overflow-hidden p-0.5 border border-cyan-400/40">
            <img src="/primus_icon.png" alt="PRIMUS" className={`w-full h-full object-cover rounded-full ${isActive ? '' : 'grayscale-[40%]'}`} />
          </div>
          <span
            className={`absolute bottom-0 right-0 w-4 h-4 rounded-full border-2 border-slate-950 flex items-center justify-center text-[8px] font-bold text-white shadow ${
              isAwake
                ? 'bg-amber-400 animate-bounce'
                : isSpeaking
                ? 'bg-purple-500 animate-pulse'
                : isActive
                ? 'bg-emerald-500 animate-pulse'
                : 'bg-slate-500'
            }`}
          >
            {isAwake ? '⚡' : isSpeaking ? '🔊' : isActive ? '🎙️' : '•'}
          </span>
        </button>

        {/* While you're talking to it: show what it hears */}
        {isActive && !isOpen && (isAwake || isSpeaking || loading) && (
          <div className="max-w-[16rem] rounded-xl bg-slate-950/95 border border-cyan-500/50 px-3 py-1.5 text-[11px] font-mono text-cyan-200 shadow-lg">
            {liveTranscript ? `"${liveTranscript}"` : stateLabel}
          </div>
        )}
      </div>

      {/* Pending phone action stays visible even with the panel closed */}
      {action && !isOpen && <div className="fixed top-40 right-4 left-4 sm:left-auto sm:w-80 z-50">{actionCard}</div>}

      {isOpen && (
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-50 sm:max-w-md bg-slate-950/95 border border-cyan-500/50 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col overflow-hidden text-slate-100">
          {/* Header */}
          <div className="bg-gradient-to-r from-slate-900 to-cyan-950/60 px-4 py-3 border-b border-cyan-500/30 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full border border-cyan-400 overflow-hidden bg-slate-900 p-0.5">
                <img src="/primus_icon.png" alt="PRIMUS" className="w-full h-full object-cover rounded-full" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-bold tracking-wider text-cyan-400 font-mono">P.R.I.M.U.S</h3>
                  <span className="text-[10px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 px-1.5 rounded font-mono">AI</span>
                </div>
                <p className="text-[10px] text-slate-400 font-mono">{stateLabel}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={restartMic} title="Restart microphone" className="p-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/60 text-cyan-300 hover:bg-cyan-900 text-xs transition">🔄</button>
              <button type="button" onClick={() => setVoiceEnabled((v) => !v)} title="Mute / unmute voice" className={`p-1.5 rounded-lg border text-xs transition ${voiceEnabled ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                {voiceEnabled ? '🔊' : '🔇'}
              </button>
              <button type="button" onClick={deactivate} className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:text-red-400 text-xs font-mono transition">OFF</button>
              <button type="button" onClick={() => setIsOpen(false)} className="p-1.5 text-slate-400 hover:text-white text-sm" title="Hide (keeps listening)">✕</button>
            </div>
          </div>

          {/* Quick action chips */}
          <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-800 flex items-center gap-1.5 overflow-x-auto no-scrollbar text-[11px] font-mono">
            {[
              ['⏱️ ETA', 'get_eta'],
              ['🌦️ Weather', 'get_weather_road_conditions'],
              ['👥 Group', 'get_group_status'],
              ['🏍️ Trailing', 'get_rider_status'],
              ['⚠️ Alerts', 'get_active_alerts'],
              ['📊 Trip', 'get_ride_summary'],
            ].map(([label, act]) => (
              <button key={act} type="button" onClick={() => processUtterance('', act)}
                className="px-2.5 py-1 rounded-full bg-slate-800/80 hover:bg-cyan-950 border border-slate-700 hover:border-cyan-500 text-slate-300 hover:text-cyan-300 whitespace-nowrap transition">
                {label}
              </button>
            ))}
            <button type="button" onClick={() => setShowContacts((s) => !s)}
              className="px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-slate-200 whitespace-nowrap">
              📇 Contacts
            </button>
          </div>

          {/* Contact management (collapsible) */}
          {showContacts && (
            <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-800 text-[11px] space-y-1.5">
              <button type="button" onClick={importPhoneContacts} className="px-2.5 py-1 rounded-lg bg-cyan-700 text-white font-bold">Import from phone contacts</button>
              <div className="flex gap-1.5">
                <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Name" className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white" />
                <input value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} inputMode="tel" placeholder="Number" className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white" />
                <button
                  type="button"
                  onClick={() => { if (addContact(manualName, manualPhone)) { setManualName(''); setManualPhone(''); } }}
                  className="px-2.5 py-1 rounded-lg bg-slate-700 text-white"
                >
                  Add
                </button>
              </div>
              <p className="text-slate-500">
                {savedContacts.length} saved · {rideContacts.length} from your group (found automatically)
              </p>
            </div>
          )}

          {/* Live transcript banner */}
          {isActive && (
            <div className="px-3.5 py-2 bg-slate-900/80 border-b border-cyan-500/20 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 truncate">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping shrink-0" />
                <span className="text-[11px] font-mono text-cyan-300 truncate">
                  {liveTranscript ? `Hearing: "${liveTranscript}"` : '🎙️ Say "Hey Primus …" to command'}
                </span>
              </div>
            </div>
          )}

          {/* Chat / Interaction history */}
          <div ref={chatScrollRef} className="p-3.5 space-y-2.5 overflow-y-auto max-h-60 min-h-[120px] text-xs font-sans">
            {permissionError && (
              <div className="bg-red-950/80 border border-red-500/50 rounded-xl p-2.5 text-red-200 text-xs flex flex-col gap-1.5">
                <p>⚠️ {permissionError}</p>
                <button type="button" onClick={restartMic} className="bg-red-600 hover:bg-red-500 text-white font-bold py-1 px-2 rounded text-[11px] self-start">
                  Retry Microphone Permission
                </button>
              </div>
            )}
            {history.map((m, i) => {
              const user = m.sender === 'user';
              return (
                <div key={i} className={`flex flex-col ${user ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[88%] rounded-2xl px-3.5 py-2 leading-relaxed shadow ${
                    user
                      ? 'bg-cyan-600 text-white rounded-br-none'
                      : m.sender === 'primus-err'
                      ? 'bg-red-950/70 border border-red-500/40 text-red-200 rounded-bl-none'
                      : 'bg-slate-900 border border-cyan-500/20 text-slate-200 rounded-bl-none'
                  }`}>
                    {!user && m.sender !== 'primus-err' && (
                      <span className="text-[10px] font-mono text-cyan-400 font-bold block mb-0.5">P.R.I.M.U.S</span>
                    )}
                    <p>{m.text}</p>
                  </div>
                  <span className="text-[9px] text-slate-500 font-mono mt-0.5 px-1">{m.time}</span>
                </div>
              );
            })}
            {liveTranscript && <div className="text-cyan-300 font-mono text-[11px]">🎙️ "{liveTranscript}"</div>}
            {loading && <div className="text-slate-400 text-xs italic flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" /><span>Processing tactical directive, sir…</span></div>}
            {actionCard}
          </div>

          {/* Text input form */}
          <form
            onSubmit={(e) => { e.preventDefault(); processUtterance(inputCommand); }}
            className="p-2.5 bg-slate-900/90 border-t border-cyan-500/20 flex items-center gap-2"
          >
            <input
              type="text"
              value={inputCommand}
              onChange={(e) => setInputCommand(e.target.value)}
              placeholder='Say "Hey Primus …" or type here'
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 font-sans"
            />
            <button type="submit" disabled={loading || !inputCommand.trim()} className="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 font-bold px-3.5 py-2 rounded-xl text-xs transition">
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}

export default PrimusAssistant;
