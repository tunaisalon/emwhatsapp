import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const CONFIG_PATH = path.join(DATA_DIR, 'replies.json');
const SEED_PATH = './replies.json';

export function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(SEED_PATH, CONFIG_PATH);
  }
}

export function loadConfig() {
  ensureConfig();
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// --- normalisation: lowercase, strip punctuation/emoji, collapse spaces ---
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Word-boundary match for latin keywords; substring match for CJK (no spaces).
function keywordHit(haystack, keyword) {
  const k = normalise(keyword);
  if (!k) return false;
  const isCJK = /[\u4e00-\u9fff]/.test(k);
  if (isCJK) return haystack.includes(k);
  if (/^\d+$/.test(k)) return haystack === k; // menu numbers must be the whole message
  const re = new RegExp(`(^|\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return re.test(haystack);
}

export function matchRule(cfg, text) {
  const hay = normalise(text);
  if (!hay) return null;
  let best = null;
  for (const rule of cfg.rules || []) {
    for (const kw of rule.keywords || []) {
      if (keywordHit(hay, kw)) {
        const score = normalise(kw).length;
        if (!best || score > best.score) best = { rule, score };
        break;
      }
    }
  }
  return best ? best.rule : null;
}

// --- business hours ---
export function isOpen(cfg, now = new Date()) {
  const bh = cfg.businessHours;
  if (!bh || bh.enabled === false) return true;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: bh.timezone || 'Asia/Kuala_Lumpur',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts.weekday];
  if (!(bh.days || []).includes(day)) return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const toMins = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  return mins >= toMins(bh.open) && mins < toMins(bh.close);
}

/* ---------- contact filters ---------- */
// Entries may carry a note: "60123456789 Liwen" -> matches on the digits only.
const digitsOf = (s) => String(s || '').replace(/\D/g, '');

function sameNumber(a, b) {
  const x = digitsOf(a), y = digitsOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 0123456789 vs 60123456789 vs +60 12-345 6789
  const min = Math.min(x.length, y.length);
  if (min < 7) return false;
  return x.endsWith(y) || y.endsWith(x);
}

function listNumbers(list) {
  return (list || [])
    // a trailing note starts at the first letter: "+60 17-888 1234 Liwen"
    .map(e => digitsOf(String(e).replace(/[A-Za-z\u4e00-\u9fff].*$/, '')))
    .filter(n => n.length >= 7);
}

/**
 * true when the bot should stay completely silent with this contact.
 * `phones` may be one identifier or several — WhatsApp now hands us a LID
 * (e.g. 19283746501@lid) alongside the real number, so we test them all.
 */
export function isBlocked(cfg, phones) {
  const list = (Array.isArray(phones) ? phones : [phones]).filter(Boolean);
  const matchesAny = (entries) => entries.some(n => list.some(p => sameNumber(n, p)));

  if (matchesAny(listNumbers(cfg.blocklist))) return true;

  // optional test mode: reply ONLY to these numbers
  if (cfg.allowlistOnly) {
    const allowed = listNumbers(cfg.allowlist);
    if (!allowed.length) return false;          // empty list = don't lock yourself out
    return !matchesAny(allowed);
  }
  return false;
}

/** true when this contact is on the test list — always gets the bot. */
export function isTestNumber(cfg, phones) {
  const list = (Array.isArray(phones) ? phones : [phones]).filter(Boolean);
  return listNumbers(cfg.allowlist).some(n => list.some(p => sameNumber(n, p)));
}
