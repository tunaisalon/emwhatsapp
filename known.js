import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const KNOWN_PATH = path.join(DATA_DIR, 'knownchats.json');

const digitsOf = (s) => String(s || '').split('@')[0].replace(/\D/g, '');

export function loadKnown() {
  try { return JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')); }
  catch { return { capturedAt: null, ids: [] }; }
}

export function saveKnown(k) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KNOWN_PATH, JSON.stringify(k));
}

/** Add chat ids from a history sync. Returns how many are stored now. */
export function addKnown(rawIds = []) {
  const k = loadKnown();
  const set = new Set(k.ids);
  for (const raw of rawIds) {
    const id = String(raw || '');
    if (!id || id.endsWith('@g.us') || id.endsWith('@newsletter') || id === 'status@broadcast') continue;
    const d = digitsOf(id);
    if (d.length >= 7) set.add(d);
  }
  k.ids = [...set];
  k.capturedAt = k.capturedAt || new Date().toISOString();
  saveKnown(k);
  return k.ids.length;
}

export function clearKnown() {
  saveKnown({ capturedAt: null, ids: [] });
}

/** true when any of these identifiers belongs to a chat that existed before. */
export function isExistingChat(ids = []) {
  const k = loadKnown();
  if (!k.ids.length) return false;          // nothing captured — treat everyone as new
  const set = new Set(k.ids);
  return ids.map(digitsOf).some(d => d.length >= 7 && set.has(d));
}
