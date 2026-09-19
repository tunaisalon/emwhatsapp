import express from 'express';
import multer from 'multer';
import fs from 'fs';
import QRCode from 'qrcode';
import { getQR, getStatus } from './qr-state.js';
import { loadConfig, saveConfig } from './rules.js';
import { loadFlows, saveFlows, loadLeads, saveLeads } from './flow.js';
import { loadCatalog, saveCatalog, ensureCatalog, UPLOAD_DIR, newPhotoId, photoPath } from './catalog.js';

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

function auth(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-pw'] || req.body?.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

export function startServer() {
  ensureCatalog();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static('public'));
  app.use('/photos', express.static(UPLOAD_DIR));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_r, _f, cb) => cb(null, UPLOAD_DIR),
      filename: (_r, file, cb) => cb(null, newPhotoId(file.originalname)),
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 20 },
    fileFilter: (_r, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  app.get('/', (_req, res) => res.send(
    `<body style="font-family:system-ui;padding:40px;background:#FAF6F0;color:#2E2B29">
     <h2>EM Bridal bot</h2><p>Status: <b>${getStatus()}</b></p>
     <p><a href="/qr">Link WhatsApp</a> &middot; <a href="/admin">Admin</a></p></body>`));

  app.get('/qr', async (_req, res) => {
    const qr = getQR();
    if (!qr) return res.send(`<body style="font-family:system-ui;text-align:center;padding:60px">
      <h2>Status: ${getStatus()}</h2>
      <p>${getStatus() === 'connected' ? 'Already linked. Nothing to scan.' : 'Waiting for QR...'}</p>
      <script>setTimeout(function(){location.reload()},5000)</script></body>`);
    const png = await QRCode.toDataURL(qr, { width: 320 });
    res.send(`<body style="font-family:system-ui;text-align:center;padding:40px">
      <h2>Scan with WhatsApp &rarr; Linked devices</h2>
      <img src="${png}"><p>Refreshes automatically</p>
      <script>setTimeout(function(){location.reload()},20000)</script></body>`);
  });

  // ---- replies config ----
  app.get('/api/config', auth, (_req, res) => res.json(loadConfig()));
  app.post('/api/config', auth, (req, res) => {
    try {
      const cfg = req.body.config;
      if (!cfg || !Array.isArray(cfg.rules)) throw new Error('Invalid config');
      saveConfig(cfg); res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- flows ----
  app.get('/api/flows', auth, (_req, res) => res.json(loadFlows()));
  app.post('/api/flows', auth, (req, res) => {
    try {
      const flows = req.body.flows;
      if (!flows || typeof flows !== 'object') throw new Error('Invalid flows');
      for (const f of Object.values(flows)) {
        if (!Array.isArray(f.steps) || !f.steps.length) throw new Error(`Flow "${f.id}" needs at least one step`);
        for (const s of f.steps) {
          if (!s.key || !/^[a-zA-Z][\w]*$/.test(s.key)) throw new Error(`Bad step key "${s.key}" - letters/numbers only, no spaces`);
          if (!s.ask && s.type !== 'gallery') throw new Error(`Step "${s.key}" needs a question`);
          if (s.type === 'choice' && !(s.options || []).length) throw new Error(`Step "${s.key}" is a choice but has no options`);
          if (s.type === 'combo') {
            if (!(s.fields || []).length) throw new Error(`Step "${s.key}" needs at least one detail to collect`);
            for (const fl of s.fields) {
              if (!fl.key || !/^[a-zA-Z][\w]*$/.test(fl.key)) throw new Error(`Bad field key "${fl.key}" in step "${s.key}"`);
              if (!['date', 'size'].includes(fl.extract)) throw new Error(`Field "${fl.key}" must look for a date or a size`);
            }
          }
        }
      }
      saveFlows(flows); res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- leads ----
  app.get('/api/leads', auth, (_req, res) => res.json(loadLeads()));
  app.post('/api/leads/status', auth, (req, res) => {
    const { id, status } = req.body;
    const leads = loadLeads();
    const l = leads.find(x => x.id === id);
    if (l) { l.status = status; saveLeads(leads); }
    res.json({ ok: true });
  });
  app.get('/api/leads.csv', auth, (_req, res) => {
    const leads = loadLeads();
    const keys = ['createdAt','status','phone','name','style','eventDate','size','notes'];
    const esc = v => '"' + String(v ?? '').replace(/"/g,'""') + '"';
    const csv = [keys.join(','), ...leads.map(l => keys.map(k => esc(l[k])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="embridal-leads.csv"');
    res.send(csv);
  });

  // ---- brand images (greeting banner, flow intro banner) ----
  app.post('/api/brand/upload', auth, upload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    res.json({ ok: true, file: req.file.filename });
  });

  // ---- gown catalog ----
  app.get('/api/catalog', auth, (_req, res) => res.json(loadCatalog()));
  app.post('/api/catalog', auth, (req, res) => {
    try {
      const c = req.body.catalog;
      if (!c || !Array.isArray(c.styles)) throw new Error('Invalid catalog');
      for (const s of c.styles) {
        if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) throw new Error(`Bad style id "${s.id}" - lowercase letters, numbers and dashes only`);
        if (!s.name) throw new Error(`Style "${s.id}" needs a name`);
      }
      const ids = c.styles.map(s => s.id);
      if (new Set(ids).size !== ids.length) throw new Error('Two styles share the same id');
      saveCatalog(c); res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/catalog/:id/photos', auth, upload.array('photos', 20), (req, res) => {
    try {
      const c = loadCatalog();
      const style = c.styles.find(s => s.id === req.params.id);
      if (!style) throw new Error('Style not found');
      style.photos = [...(style.photos || []), ...req.files.map(f => f.filename)];
      saveCatalog(c);
      res.json({ ok: true, photos: style.photos });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/catalog/:id/photos/delete', auth, (req, res) => {
    try {
      const { file } = req.body;
      const c = loadCatalog();
      const style = c.styles.find(s => s.id === req.params.id);
      if (!style) throw new Error('Style not found');
      style.photos = (style.photos || []).filter(f => f !== file);
      saveCatalog(c);
      const inUse = c.styles.some(s => (s.photos || []).includes(file));
      if (!inUse) { try { fs.unlinkSync(photoPath(file)); } catch {} }
      res.json({ ok: true, photos: style.photos });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/catalog/:id/photos/reorder', auth, (req, res) => {
    try {
      const c = loadCatalog();
      const style = c.styles.find(s => s.id === req.params.id);
      if (!style) throw new Error('Style not found');
      style.photos = req.body.photos;
      saveCatalog(c); res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/admin', (_req, res) => res.sendFile('admin.html', { root: 'public' }));
  app.get('/leads', (_req, res) => res.sendFile('leads.html', { root: 'public' }));

  app.listen(PORT, () => console.log(`Web on :${PORT}`));
}
