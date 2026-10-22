// GroupLock - Stage 8: Hands-Free Audio Voice Alerts & Sound Effects Engine
// Optimized for motorcycle riders wearing helmets with Bluetooth intercoms (Sena, Cardo, FreedConn, etc.)

const SETTINGS_KEY = 'grouplock_voice_settings';

// Default voice settings
const defaultSettings = {
  enabled: true,
  volume: 1.0, // 0.0 to 1.0
  helmetMode: true, // Plays wake-up chirp before speech to prevent Bluetooth headset cut-off
  speechRate: 1.05, // Slightly brisk for riding clarity
  leadSweepOnly: false, // If true, only announce Lead and Sweep commands
  muteIncomingRadio: false, // Walkie-talkie radio mute toggle
  selectedVoice: null, // Voice URI or null for system default
};

export function getVoiceSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch (e) {
    return { ...defaultSettings };
  }
}

export function saveVoiceSettings(newSettings) {
  try {
    const current = getVoiceSettings();
    const updated = { ...current, ...newSettings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    return updated;
  } catch (e) {
    return defaultSettings;
  }
}

// In-memory cooldowns to prevent spamming riders while riding
const lastAlertTimes = {
  OVERSPEED: 0,
  SEPARATION: 0,
  REGROUP: 0,
  NETWORK: 0,
  GENERAL: 0,
};

const COOLDOWN_MS = {
  OVERSPEED: 20000, // 20s between overspeed voice warnings
  SEPARATION: 30000, // 30s between separation warnings
  REGROUP: 10000, // 10s
  NETWORK: 15000, // 15s between dead-zone status warnings
  GENERAL: 5000,
};

// Web Audio Context for zero-latency walkie-talkie beeps & helmet wake-up chimes
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Plays radio mic click sound (PTT press/release)
 */
export function playMicClick(isStart = true) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    if (isStart) {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
    } else {
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.07);
    }

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (isStart ? 0.05 : 0.07));
  } catch (e) {}
}

/**
 * Plays authentic radio "Roger Beep" when incoming PTT transmission finishes
 */
export function playRogerBeep() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1209, ctx.currentTime);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(697, ctx.currentTime);

    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.12);
    osc2.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

/**
 * Plays authentic Stark Industries / JARVIS helmet HUD activation chime
 */
export function playJarvisWakeChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Tone 1: C5 (523.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, now);
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.12);

    // Tone 2: G5 (783.99 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(783.99, now + 0.07);
    gain2.gain.setValueAtTime(0.18, now + 0.07);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.07);
    osc2.stop(now + 0.22);

    // Tone 3: High C6 harmonic shimmer (1046.50 Hz)
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(1046.50, now + 0.14);
    gain3.gain.setValueAtTime(0.14, now + 0.14);
    gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(now + 0.14);
    osc3.stop(now + 0.32);
  } catch (e) {}
}

/**
 * Plays a short pre-speech chime to wake up Bluetooth helmet intercom DAC before TTS begins
 */
export function playBluetoothWakeChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 tone
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch (e) {}
}

/**
 * Play alert chimes
 */
export function playAudioChime(type = 'info') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (type === 'sos') {
      // Rapid dual siren
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(950, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(450, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } else if (type === 'warning') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    }
  } catch (e) {}
}

/**
 * High-Priority Spoken Voice Alert Engine (Web Speech Synthesis API)
 * @param {string} text Speech text to pronounce
 * @param {object} options { priority: 'CRITICAL'|'HIGH'|'WARNING'|'INFO', category: string, force: boolean }
 */
export function speakVoiceAlert(text, options = {}) {
  const {
    priority = 'INFO',
    category = 'GENERAL',
    force = false,
  } = options;

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return;
  }

  const settings = getVoiceSettings();
  if (!settings.enabled && !force && priority !== 'CRITICAL') {
    return;
  }

  // Check cooldown unless forced or CRITICAL
  const now = Date.now();
  if (!force && priority !== 'CRITICAL' && category && COOLDOWN_MS[category]) {
    const lastTime = lastAlertTimes[category] || 0;
    if (now - lastTime < COOLDOWN_MS[category]) {
      return; // Throttled
    }
    lastAlertTimes[category] = now;
  }

  try {
    // If critical SOS alert, cancel pending lower-priority speech immediately
    if (priority === 'CRITICAL') {
      window.speechSynthesis.cancel();
    }

    // Bluetooth helmet mode: play a tiny wake chime 50ms before speech
    if (settings.helmetMode) {
      playBluetoothWakeChime();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = Math.max(0.1, Math.min(1.0, settings.volume || 1.0));
    utterance.rate = priority === 'CRITICAL' ? 1.15 : (settings.speechRate || 1.05);
    utterance.pitch = priority === 'CRITICAL' ? 1.1 : 1.0;

    // Pick best English voice if available
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      if (settings.selectedVoice) {
        const found = voices.find((v) => v.voiceURI === settings.selectedVoice);
        if (found) utterance.voice = found;
      }
      if (!utterance.voice) {
        // Prefer natural / google / english voice
        const enVoice =
          voices.find((v) => (v.name.includes('Google') || v.name.includes('Natural')) && v.lang.startsWith('en')) ||
          voices.find((v) => v.lang.startsWith('en'));
        if (enVoice) utterance.voice = enVoice;
      }
    }

    // Small timeout ensures Bluetooth chime plays smoothly
    setTimeout(() => {
      window.speechSynthesis.speak(utterance);
    }, settings.helmetMode ? 80 : 0);
  } catch (err) {
    console.warn('[VoiceAlert] Failed to speak alert:', err);
  }
}

/**
 * Test Helmet Voice Alert
 */
export function testVoiceAlert() {
  playAudioChime('warning');
  speakVoiceAlert(
    'GroupLock Helmet Audio Online. Voice alerts and Walkie-Talkie radio active.',
    { priority: 'HIGH', category: 'GENERAL', force: true }
  );
}
