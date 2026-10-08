import fs from 'fs';
import path from 'path';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { loadConfig, matchRule, isOpen, ensureConfig, isBlocked, isTestNumber } from './rules.js';
import { loadFlows, ensureFlows, stepFlow, startFlow, isExpired, loadLeads, saveLeads } from './flow.js';
import { loadCatalog, ensureCatalog, activeStyles, findStyle, styleMessages, photoPath, blockMessages } from './catalog.js';
import { setQR, setStatus } from './qr-state.js';
import { registerUnlink } from './session.js';
import { addKnown, isExistingChat, loadKnown } from './known.js';
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
let sock = null;
let unlinking = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['EM Bridal', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    // ask the phone for a full history sync so the "existing chats" snapshot
    // covers more than the last few weeks
    syncFullHistory: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { setQR(qr); setStatus('waiting for QR scan'); }
    if (connection === 'open') { setQR(null); setStatus('connected'); console.log('WhatsApp connected'); }
    if (connection === 'close') {
      if (unlinking) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      setStatus('disconnected');
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000);
      else {
        console.log('Logged out on the phone - clearing session, scan a new QR.');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        setQR(null);
        setTimeout(start, 2000);
      }
    }
  });

  // WhatsApp sends existing chats right after linking — snapshot them so the
  // bot can tell an old conversation from a brand-new one.
  sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], isLatest, syncType }) => {
    const ids = chats.map(c => c?.id).filter(Boolean);
    const total = ids.length ? addKnown(ids) : loadKnown().ids.length;
    console.log(`[history] batch: ${chats.length} chats, ${contacts.length} contacts` +
      ` | stored ${total}${isLatest ? ' | SYNC COMPLETE' : ''}${syncType != null ? ` | type ${syncType}` : ''}`);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handle(sock, msg); } catch (e) { console.error(e); }
    }
  });
}

/**
 * Every identifier WhatsApp gives us for the sender. Modern WhatsApp may put a
 * LID in remoteJid and the real phone number in an alt field, so we collect all
 * of them and let the contact filters match on whichever fits.
 */
function phoneCandidates(msg) {
  const k = msg.key || {};
  return [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participant, k.participantAlt, k.participantPn, msg.participant]
    .filter(Boolean)
    .map(j => String(j).split('@')[0])
    .filter(Boolean);
}

/** The best guess at a real phone number, for the leads list. */
function bestPhone(msg) {
  const k = msg.key || {};
  const alt = [k.senderPn, k.remoteJidAlt, k.participantPn].find(Boolean);
  return String(alt || k.remoteJid || '').split('@')[0];
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
  const ids = phoneCandidates(msg);
  if (cfg.logIds) console.log('[ids]', jid, '->', ids.join(' | '));
  // never engage with muted contacts — in either direction
  if (isBlocked(cfg, ids)) return;

  // optionally stay out of conversations that already existed before the bot.
  // Test numbers are exempt, so you can keep testing on your own chat.
  if (cfg.newChatsOnly && !msg.key.fromMe && !isTestNumber(cfg, ids) && isExistingChat(ids)) {
    if (cfg.logIds) console.log('[skip] existing chat:', ids.join(' | '));
    return;
  }
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
    if (body === '/reset' || body === '/restart') {
      delete chatState[jid];
      saveState(chatState);
      await send(sock, jid, [cfg.resetMessage || 'Chat reset — the bot will greet from the top on the next message.']);
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

  const body = textOf(msg);
  if (!body.trim()) return;

  // reset command: wipes this chat's state and replays the opening immediately
  const resetWords = cfg.resetWords || ['/reset', '/restart'];
  if (resetWords.some(w => body.trim().toLowerCase() === String(w).toLowerCase())) {
    delete chatState[jid];
    saveState(chatState);
    const fresh = {};
    const seedName = (msg.pushName || '').split(' ')[0] || '';
    const outs = [];
    if (cfg.resetMessage) outs.push(cfg.resetMessage);
    if ((cfg.greetingSequence || []).length) {
      outs.push(...blockMessages(cfg.greetingSequence, (x) => x.replace(/\{name\}/g, seedName).replace(/[^\S\n]{2,}/g, ' ')));
    } else {
      if (cfg.greetingImage) outs.push({ image: { url: photoPath(cfg.greetingImage) } });
      outs.push(cfg.greeting);
    }
    fresh.lastGreet = now;
    const autoId = cfg.startFlowOnGreeting;
    const autoFlow = autoId && flows[autoId]?.enabled ? flows[autoId] : null;
    if (autoFlow) {
      const s2 = startFlow(autoFlow, catalog, { name: seedName });
      fresh.flow = { ...s2.state, flowId: autoFlow.id };
      outs.push(...s2.messages);
    }
    chatState[jid] = fresh;
    saveState(chatState);
    await send(sock, jid, outs.filter(Boolean));
    return;
  }

  if (st.pausedUntil && now < st.pausedUntil) return;

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
      leads.unshift({ id: String(now), jid, phone: bestPhone(msg) || jid.split('@')[0], flow: flow.id, status: 'new', ...r.lead });
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
    if (!isOpen(cfg)) {
      outs.push(cfg.awayMessage);
    } else if ((cfg.greetingSequence || []).length) {
      outs.push(...blockMessages(cfg.greetingSequence, (x) => x.replace(/\{name\}/g, seed.name || '').replace(/[^\S\n]{2,}/g, ' ')));
    } else {
      if (cfg.greetingImage) outs.push({ image: { url: photoPath(cfg.greetingImage) } });
      outs.push(cfg.greeting);
    }
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

// Unlink the current number so a new one can be scanned.
registerUnlink(async () => {
  unlinking = true;
  setStatus('unlinking');
  setQR(null);
  try { await sock?.logout(); } catch { /* phone may already be gone */ }
  try { sock?.end?.(); } catch {}
  sock = null;
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  // forget per-chat greeting/flow state too, so the new number starts clean
  chatState = {};
  saveState(chatState);
  await new Promise(r => setTimeout(r, 1200));
  unlinking = false;
  start().catch(e => console.error('restart after unlink failed:', e));
  return true;
});

// web server boots once; the WhatsApp socket reconnects independently
ensureConfig();
ensureFlows();
ensureCatalog();
startServer();
start().catch(e => { console.error('WhatsApp start failed:', e); setTimeout(start, 5000); });
