// Phone-side intent parsing for PRIMUS: "message Abhin where are you",
// "open whatsapp take abhins chat and send message where are you",
// "call Abhin", "navigate to Munnar", "open youtube" ...
// Pure functions - no React, no DOM - so they are easy to test.

export const DEFAULT_COUNTRY_CODE = '91'; // India. Change if riders use other numbers.

const STOP_NAMES = new Set(['a', 'an', 'the', 'to', 'message', 'msg', 'text', 'whatsapp', 'whats', 'app', 'send', 'sent', 'on', 'in', 'my', 'me', 'chat', 'where', 'what', 'when', 'how', 'why', 'who', 'i', 'we', 'you', 'hello', 'hi', 'hey', 'please']);
const GROUP_WORDS = /\b(everyone|everybody|group|all riders|convoy|leader)\b/;

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

export function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\D/g, '');
  if (!digits) return null;
  if (hadPlus) return digits;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10) return DEFAULT_COUNTRY_CODE + digits;
  return digits.length >= 11 ? digits : null;
}

/** Find the best contact for a spoken name (tolerates "abhins", "abin", "Abhin Raj"). */
export function findContact(spoken, contacts) {
  const raw = clean(spoken).replace(/'s$/, '');
  if (!raw) return null;
  const candidates = [...new Set([raw, raw.replace(/s$/, '')])].filter((c) => c.length >= 2);
  let best = null;
  let bestScore = 0;
  for (const c of contacts) {
    const full = clean(c.name);
    const tokens = full.split(' ');
    for (const cand of candidates) {
      let score = 0;
      const candTokens = cand.split(' ');
      if (candTokens.length > 1) {
        // multi-word spoken name: whole-token match only ("abhin raj"), never prefix/fuzzy
        if (full === cand) score = 100;
        else if (candTokens.every((ct) => tokens.includes(ct))) score = 80;
        if (score > bestScore) { bestScore = score; best = c; }
        continue;
      }
      if (full === cand) score = 100;
      else if (tokens.includes(cand)) score = 90;
      else if (tokens.some((t) => t.startsWith(cand) || cand.startsWith(t)) && cand.length >= 3) score = 70;
      else if (cand.length >= 4 && tokens.some((t) => t.length >= 4 && lev(t, cand) <= 1)) score = 60;
      else if (cand.length >= 5 && tokens.some((t) => t.length >= 5 && lev(t, cand) <= 2)) score = 45;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  return best;
}

const APPS = {
  whatsapp: { label: 'WhatsApp', pkg: 'com.whatsapp' },
  youtube: { label: 'YouTube', pkg: 'com.google.android.youtube' },
  'google maps': { label: 'Google Maps', pkg: 'com.google.android.apps.maps' },
  maps: { label: 'Google Maps', pkg: 'com.google.android.apps.maps' },
  instagram: { label: 'Instagram', pkg: 'com.instagram.android' },
  spotify: { label: 'Spotify', pkg: 'com.spotify.music' },
  gmail: { label: 'Gmail', pkg: 'com.google.android.gm' },
  camera: { label: 'Camera', pkg: 'com.android.camera' },
  phone: { label: 'Phone', pkg: 'com.google.android.dialer' },
  dialer: { label: 'Phone', pkg: 'com.google.android.dialer' },
};

const intentUrl = (pkg) =>
  `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${pkg};end`;

export function whatsappLink(phone, body) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(body)}`;
}

function stripLead(body) {
  return (body || '')
    .replace(/^(?:and\s+)?(?:saying|say|that|as|write|type|tell\s+(?:him|her|them))\s+/i, '')
    .replace(/^(?:message|msg|text)\s+/i, '')
    .trim();
}

/**
 * Returns null if this is not a phone action, otherwise one of:
 *  { type:'message', name, body }
 *  { type:'call', name }
 *  { type:'navigate', place }
 *  { type:'open_app', app }
 *  { type:'youtube_search', query }
 */
export function parseDeviceIntent(rawText, contacts = []) {
  const text = (rawText || '').trim();
  const t = text.toLowerCase().replace(/[,.!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // ── Messaging ──────────────────────────────────────────────────────────
  // "open whatsapp take abhins chat ..." -> drop the app-opening preamble first
  const tm = t.replace(/^(?:please\s+)?(?:open|launch|start)\s+whats\s?app\s*(?:and\s+)?/, '');
  if (/\b(whats\s?app|message|msg|text|send|sent|tell|ask)\b/.test(tm) && !GROUP_WORDS.test(tm)) {
    // 1. "take/open Abhin's chat and send message where are you"
    let m = tm.match(/(?:take|open|go to|get)\s+([a-z' ]+?)\s+chat\b.*?(?:send|sent|type|write|say)\s+(?:a\s+)?(?:message|msg|text)?\s*(.+)$/);
    if (m) return { type: 'message', name: m[1].replace(/'s$/, '').trim(), body: stripLead(m[2]) };

    // 2. known contact name anywhere + message marker
    const mk = tm.match(/\b(?:send|sent|message|msg|text|whatsapp|tell|ask)\b\s+(?:a\s+)?(?:message|msg|text)?\s*(?:to\s+)?(.+)$/);
    if (mk) {
      const rest = mk[1];
      const words = rest.split(' ');
      for (let take = Math.min(3, words.length - 1); take >= 1; take--) {
        const nm = words.slice(0, take).join(' ');
        if (STOP_NAMES.has(nm)) continue;
        if (findContact(nm, contacts)) {
          const body = stripLead(words.slice(take).join(' ').replace(/^(?:to|that)\s+/, ''));
          if (body) return { type: 'message', name: nm, body };
        }
      }
      // 3. unknown name: first non-stop word is the name, rest is the body
      const first = words.find((w) => !STOP_NAMES.has(w));
      if (first && words.length > words.indexOf(first) + 1) {
        const idx = words.indexOf(first);
        const body = stripLead(words.slice(idx + 1).join(' ').replace(/^(?:to|that)\s+/, ''));
        if (body && /\b(?:send|sent|message|msg|text|whatsapp|tell|ask)\b/.test(tm)) {
          return { type: 'message', name: first.replace(/'s$/, ''), body };
        }
      }
    }
  }

  // ── Calling ────────────────────────────────────────────────────────────
  let m = t.match(/^(?:please\s+)?(?:call|phone|ring|dial)\s+(?:to\s+)?([a-z' ]+)$/);
  if (m && !GROUP_WORDS.test(t)) return { type: 'call', name: m[1].trim() };

  // ── Navigation ─────────────────────────────────────────────────────────
  m = t.match(/^(?:please\s+)?(?:navigate|directions?|route|take me|drive me|guide me)\s+(?:to\s+)?(.+)$/);
  if (m && !/\b(destination|there)\b$/.test(m[1])) return { type: 'navigate', place: m[1].trim() };

  // ── Media ──────────────────────────────────────────────────────────────
  m = t.match(/^(?:play|search)\s+(.+?)\s+on\s+youtube$/) || t.match(/^youtube\s+(?:search\s+)?(.+)$/);
  if (m) return { type: 'youtube_search', query: m[1].trim() };

  // ── Open an app ────────────────────────────────────────────────────────
  m = t.match(/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([a-z ]+?)(?:\s+app)?$/);
  if (m) {
    const key = Object.keys(APPS).find((k) => m[1].trim() === k);
    if (key) return { type: 'open_app', app: key };
  }
  return null;
}

export function appInfo(key) {
  const a = APPS[key];
  return a ? { ...a, href: intentUrl(a.pkg) } : null;
}

// ── Wake word ──────────────────────────────────────────────────────────────
// Strong variants work on their own; weak (very common English words) need "hey/ok".
export const WAKE_REGEX =
  /\b(?:(?:hey|hi|ok|okay|hello)\s+(?:primus|pramus|premus|prymus|primis|primos|prime\s?us|pyramus|promise|premise|famous|jarvis)|primus|pramus|premus|prymus|primis|primos|prime\s?us|jarvis)\b/i;

export function afterWake(text) {
  const m = text.match(WAKE_REGEX);
  if (!m) return text.trim();
  return text.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '').trim();
}

/** Join SpeechRecognition results, collapsing Android's cumulative-duplicate interims. */
export function buildTranscript(results) {
  const pieces = [];
  for (let i = 0; i < results.length; i++) {
    const piece = (results[i][0]?.transcript || '').trim();
    if (!piece) continue;
    const last = pieces[pieces.length - 1];
    if (last && piece.toLowerCase().startsWith(last.toLowerCase())) pieces[pieces.length - 1] = piece;
    else pieces.push(piece);
  }
  return pieces.join(' ');
}

// Sentence ends in a word that usually means "I'm not done yet".
export const TRAILING_FILLER = /\b(?:to|and|that|the|a|an|for|my|where|what|when|how|is|are|if|or|but|with|about|of|in|on|at|from|tell|saying|say|send|message)$/i;
