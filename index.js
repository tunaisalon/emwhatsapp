import fs from 'fs';
import path from 'path';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { loadConfig, matchRule, isOpen, ensureConfig } from './rules.js';
import { loadFlows, ensureFlows, stepFlow, startFlow, isExpired, loadLeads, saveLeads } from './flow.js';
import { loadCatalog, ensureCatalog, activeStyles, findStyle, styleMessages, photoPath } from './catalog.js';
import { setQR, setStatus } from './qr-state.js';
import { startServer } from './server.js';

const AUTH_DIR = process.env.AUTH_DIR || './auth';
const DATA_DIR = process.env.DATA_DIR || './data';
const STATE_PATH = path.join(DATA_DIR, 'chatstate.json');
const HOUR = 3600 * 1000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s));
}
let chatState = loadState();

async function start() {
  ensureConfig();
  ensureFlows();
  ensureCatalog();
  startServer();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['EM Bridal', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { setQR(qr); setStatus('waiting for QR scan'); }
    if (connection === 'open') { setQR(null); setStatus('connected'); console.log('WhatsApp connected'); }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      setStatus('disconnected');
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000);
      else console.log('Logged out - delete auth folder and rescan QR.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handle(sock, msg); } catch (e) { console.error(e); }
    }
  });
}

function textOf(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

async function send(sock, jid, outs) {
  if (!outs.length) return;
  await sock.sendPresenceUpdate('composing', jid);
  for (const out of outs) {
    await new Promise(r => setTimeout(r, 900));
    await sock.sendMessage(jid, typeof out === 'string' ? { text: out } : out);
  }
  await sock.sendPresenceUpdate('paused', jid);
}

async function handle(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

  const cfg = loadConfig();
  const flows = loadFlows();
  const catalog = loadCatalog();
  const now = Date.now();
  const st = chatState[jid] || {};

  // --- your own outgoing messages ---
  if (msg.key.fromMe) {
    const body = textOf(msg).trim().toLowerCase();
    if (body === '/resume' || body === '/on') {
      st.pausedUntil = 0;
      chatState[jid] = st; saveState(chatState);
      await send(sock, jid, [cfg.resumeMessage]);
      return;
    }
    if (body === '/pause' || body === '/off') {
      st.pausedUntil = now + (cfg.handoffPauseHours || 24) * HOUR;
      chatState[jid] = st; saveState(chatState);
      return;
    }
    // manual reply = you took over
    st.pausedUntil = now + (cfg.handoffPauseHours || 24) * HOUR;
    st.flow = null;
    chatState[jid] = st; saveState(chatState);
    return;
  }

  if (st.pausedUntil && now < st.pausedUntil) return;

  const body = textOf(msg);
  if (!body.trim()) return;

  // --- mid-flow? ---
  if (st.flow && flows[st.flow.flowId]?.enabled) {
    const flow = flows[st.flow.flowId];
    if (isExpired(flow, st.flow)) {
      st.flow = null;
      chatState[jid] = st; saveState(chatState);
      await send(sock, jid, [flow.timeoutMessage].filter(Boolean));
      return;
    }
    const r = stepFlow(flow, st.flow, body, catalog);
    if (r.handoff) {
      st.flow = null;
      st.pausedUntil = now + (cfg.handoffPauseHours || 24) * HOUR;
      chatState[jid] = st; saveState(chatState);
      await send(sock, jid, [cfg.handoffMessage]);
      return;
    }
    if (r.lead) {
      const leads = loadLeads();
      leads.unshift({ id: String(now), jid, phone: jid.split('@')[0], flow: flow.id, status: 'new', ...r.lead });
      saveLeads(leads);
    }
    st.flow = r.state ? { ...r.state, flowId: flow.id } : null;
    chatState[jid] = st; saveState(chatState);
    await send(sock, jid, r.messages.filter(Boolean));
    return;
  }

  // --- normal keyword handling ---
  const outs = [];
  const seed = { name: (msg.pushName || '').split(' ')[0] || '' };
  const cooldown = (cfg.greetCooldownHours ?? 12) * HOUR;
  const firstTouch = !st.lastGreet || now - st.lastGreet > cooldown;

  if (firstTouch) {
    if (cfg.greetingImage) outs.push({ image: { url: photoPath(cfg.greetingImage) } });
    outs.push(isOpen(cfg) ? cfg.greeting : cfg.awayMessage);
    st.lastGreet = now;

    // first contact goes straight into the standard enquiry flow
    const autoId = cfg.startFlowOnGreeting;
    const autoFlow = autoId && flows[autoId]?.enabled ? flows[autoId] : null;
    if (autoFlow && isOpen(cfg)) {
      const s = startFlow(autoFlow, catalog, seed);
      st.flow = { ...s.state, flowId: autoFlow.id };
      outs.push(...s.messages);
      chatState[jid] = st; saveState(chatState);
      await send(sock, jid, outs.filter(Boolean));
      return;
    }
  }

  // direct style mention ("do you have long sleeve?") -> send those photos immediately
  const directStyle = activeStyles(catalog).find(s =>
    (s.keywords || []).some(k => {
      const n = String(k).toLowerCase();
      const hay = body.toLowerCase();
      return /[\u4e00-\u9fff]/.test(n) ? hay.includes(n) : new RegExp(`(^|\\W)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(hay);
    }));
  if (directStyle) {
    outs.push(...styleMessages(catalog, directStyle));
    if (catalog.afterDirectSend) outs.push(catalog.afterDirectSend);
    chatState[jid] = st; saveState(chatState);
    await send(sock, jid, outs.filter(Boolean));
    return;
  }

  const rule = matchRule(cfg, body);

  // does a flow trigger off this rule?
  const flow = rule ? Object.values(flows).find(f => f.enabled && f.triggerRuleId === rule.id) : null;

  if (flow) {
    const s = startFlow(flow, catalog, seed);
    st.flow = { ...s.state, flowId: flow.id };
    outs.push(...s.messages);
  } else if (rule?.handoff) {
    outs.push(cfg.handoffMessage);
    st.pausedUntil = now + (cfg.handoffPauseHours || 24) * HOUR;
  } else if (rule?.reply) {
    outs.push(rule.reply);
    for (const img of (rule.images || []).slice(0, 6)) outs.push({ image: { url: img } });
  } else if (!firstTouch) {
    outs.push(cfg.fallback);
  }

  chatState[jid] = st; saveState(chatState);
  await send(sock, jid, outs.filter(Boolean));
}

start();
