import fs from 'fs';
import path from 'path';
import { activeStyles, findStyle, styleMessages } from './catalog.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const FLOWS_PATH = path.join(DATA_DIR, 'flows.json');
const LEADS_PATH = path.join(DATA_DIR, 'leads.json');

export function ensureFlows() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FLOWS_PATH)) fs.copyFileSync('./flows.json', FLOWS_PATH);
}
export function loadFlows() { ensureFlows(); return JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8')); }
export function saveFlows(f) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FLOWS_PATH, JSON.stringify(f, null, 2)); }
export function loadLeads() { try { return JSON.parse(fs.readFileSync(LEADS_PATH, 'utf8')); } catch { return []; } }
export function saveLeads(l) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LEADS_PATH, JSON.stringify(l, null, 2)); }

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const inList = (text, list) => (list || []).some(w => {
  const n = norm(w);
  if (!n) return false;
  return /[\u4e00-\u9fff]/.test(n) ? norm(text).includes(n) : norm(text) === n;
});

function fill(t, a) {
  return String(t || '')
    .replace(/\{(\w+)\}/g, (_, k) => a[k] || '')
    .replace(/[^\S\n]{2,}/g, ' ')   // collapse double spaces left by an empty {name}
    .replace(/[^\S\n]+\n/g, '\n');
}

/* ---------- extractors for combo steps ---------- */
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const EXTRACT = {
  date(text) {
    const t = String(text);
    let m = t.match(/\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})\b/);      // 5/12/2026
    if (m) return m[0].replace(/\s/g, '');
    m = t.match(new RegExp(`\\b\\d{1,2}\\s*(st|nd|rd|th)?\\s*(${MONTHS})[a-z]*\\.?\\s*\\d{2,4}\\b`, 'i'));  // 15 Mar 2027
    if (m) return m[0];
    m = t.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s*\\d{1,2},?\\s*\\d{2,4}\\b`, 'i'));                 // Mar 15 2027
    if (m) return m[0];
    m = t.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s*\\d{4}\\b`, 'i'));                                 // Dec 2026
    if (m) return m[0];
    m = t.match(/\b\d{4}\s*年\s*\d{1,2}\s*月(\s*\d{1,2}\s*日)?/);                                          // 2026年12月5日
    if (m) return m[0];
    return null;
  },
  size(text) {
    const t = String(text);
    let m = t.match(/\b(uk|eu|us)\s*\d{1,2}\b/i);                            // UK 10
    if (m) return m[0].toUpperCase();
    m = t.match(/\b(xs|s|m|l|xl|xxl|xxxl)\s*(or|\/|-|to|、|或)\s*(xs|s|m|l|xl|xxl|xxxl)\b/i); // M or L
    if (m) return m[0].toUpperCase().replace(/\s+/g, ' ');
    m = t.match(/\bsize\s*(\d{1,2})\b/i);
    if (m) return m[0];
    m = t.match(/(^|[\s,.(])(xs|s|m|l|xl|xxl|xxxl)($|[\s,.)])/i);            // bare M / L
    if (m) return m[2].toUpperCase();
    m = t.match(/\b\d{2,3}\s*(kg|cm)\b/i);                                   // 55kg
    if (m) return m[0];
    if (/不确定|不知道|唔知|not sure|dunno|no idea|tak tahu/i.test(t)) return 'Not sure';
    return null;
  },
};

/* ---------- step rendering ---------- */
function optionsFor(step, catalog) {
  if (step.type === 'gallery') return activeStyles(catalog || {}).map(s => s.name);
  return step.options || [];
}

function askStep(flow, idx, catalog, answers = {}) {
  const step = flow.steps[idx];
  if (!step) return [];
  const out = [];
  if (step.type === 'choice' || step.type === 'gallery') {
    const opts = optionsFor(step, catalog);
    const list = step.hideNumbers ? '' : '\n\n' + opts.map((o, i) => `${i + 1}\u20e3 ${o}`).join('\n');
    out.push(fill(step.ask, answers) + list);
  } else {
    out.push(fill(step.ask, answers));
  }
  if (step.image) out.push({ image: { url: brandImage(step.image) }, caption: undefined });
  return out.filter(Boolean);
}

function brandImage(file) {
  return path.join(DATA_DIR, 'uploads', file);
}

/* ---------- engine ---------- */
export function startFlow(flow, catalog, seed = {}) {
  const answers = { ...seed };
  const msgs = [];
  if (flow.introImage) msgs.push({ image: { url: brandImage(flow.introImage) } });
  if (flow.intro) msgs.push(fill(flow.intro, answers));
  msgs.push(...askStep(flow, 0, catalog, answers));
  return { messages: msgs, state: { phase: 'ask', idx: 0, answers, partial: {}, updatedAt: Date.now() } };
}

export function stepFlow(flow, state, text, catalog) {
  const out = { messages: [], state, lead: null };

  if (inList(text, flow.cancelWords)) { out.messages.push(flow.cancel); out.state = null; return out; }
  if (inList(text, flow.humanWords)) { out.state = null; out.handoff = true; return out; }

  if (state.phase === 'confirm') {
    if (inList(text, flow.confirmYes)) return finish(flow, state, out, catalog);
    if (inList(text, flow.confirmNo)) {
      out.messages.push(flow.restart);
      out.state = { phase: 'ask', idx: 0, answers: {}, partial: {}, updatedAt: Date.now() };
      out.messages.push(...askStep(flow, 0, catalog, {}));
      return out;
    }
    out.messages.push(fill(flow.confirm, state.answers));
    return out;
  }

  const step = flow.steps[state.idx];
  let answers = { ...state.answers };
  let partial = { ...(state.partial || {}) };

  /* --- combo: pull several fields out of free text, across messages --- */
  if (step.type === 'combo') {
    for (const f of step.fields || []) {
      if (partial[f.key]) continue;
      const got = EXTRACT[f.extract] ? EXTRACT[f.extract](text) : String(text).trim();
      if (got) partial[f.key] = got;
    }
    const missing = (step.fields || []).filter(f => !partial[f.key]);
    if (missing.length) {
      // only nudge if she actually gave us something new, otherwise repeat once
      const asked = missing[0];
      out.messages.push(fill(asked.missingAsk || step.error || 'Could you send that again?', { ...answers, ...partial }));
      out.state = { ...state, answers, partial, updatedAt: Date.now() };
      return out;
    }
    answers = { ...answers, ...partial };
    partial = {};
  } else {
    let value = String(text).trim();
    if (step.type === 'choice' || step.type === 'gallery') {
      const opts = optionsFor(step, catalog);
      const n = Number(value);
      if (n >= 1 && n <= opts.length) value = opts[n - 1];
      else {
        const hit = opts.find(o => norm(o) === norm(value))
          || opts.find(o => norm(text).includes(norm(o)))
          || (step.type === 'gallery' && (activeStyles(catalog || {})
               .find(s => (s.keywords || []).some(k => {
                 const kn = norm(k);
                 return /[\u4e00-\u9fff]/.test(kn) ? norm(text).includes(kn)
                   : new RegExp(`(^|\\s)${kn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(norm(text));
               })) || {}).name);
        if (hit) value = hit;
        else { out.messages.push(fill(step.error || 'Please pick one of the options.', answers)); return out; }
      }
      if (step.type === 'gallery' && !step.deferPhotos) {
        const style = findStyle(catalog || {}, value);
        if (style) out.messages.push(...styleMessages(catalog, style));
        if (step.afterPhotos) out.messages.push(fill(step.afterPhotos, { ...answers, [step.key]: value }));
      }
    } else {
      if (step.optional && inList(value, step.skipWords)) value = '';
      else if (value.length < (step.minLength || 1)) {
        out.messages.push(fill(step.error || 'Could you send that again?', answers));
        return out;
      }
    }
    answers[step.key] = value;
  }

  const nextIdx = state.idx + 1;
  if (nextIdx < flow.steps.length) {
    out.state = { phase: 'ask', idx: nextIdx, answers, partial: {}, updatedAt: Date.now() };
    out.messages.push(...askStep(flow, nextIdx, catalog, answers));
    return out;
  }
  if (flow.skipConfirm) return finish(flow, { ...state, answers }, out, catalog);
  out.state = { phase: 'confirm', idx: nextIdx, answers, partial: {}, updatedAt: Date.now() };
  out.messages.push(fill(flow.confirm, answers));
  return out;
}

function finish(flow, state, out, catalog) {
  const a = state.answers;
  const ps = flow.photoSend;
  if (ps && a[ps.styleKey]) {
    if (ps.before) out.messages.push(fill(ps.before, a));
    const style = findStyle(catalog || {}, a[ps.styleKey]);
    if (style) out.messages.push(...styleMessages(catalog, style, { caption: false }));
    if (ps.after) out.messages.push(fill(ps.after, a));
  }
  if (flow.success) out.messages.push(fill(flow.success, a));
  out.lead = { ...a, createdAt: new Date().toISOString() };
  out.state = null;
  return out;
}

export function isExpired(flow, state) {
  return Date.now() - (state.updatedAt || 0) > (flow.timeoutMinutes || 60) * 60 * 1000;
}
