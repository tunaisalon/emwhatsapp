import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

export function ensureCatalog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(CATALOG_PATH)) fs.copyFileSync('./catalog.json', CATALOG_PATH);
}

export function loadCatalog() {
  ensureCatalog();
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

export function saveCatalog(c) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(c, null, 2));
}

export function activeStyles(catalog) {
  return (catalog.styles || []).filter(s => s.enabled !== false);
}

export function findStyle(catalog, idOrName) {
  const n = String(idOrName || '').toLowerCase().trim();
  return activeStyles(catalog).find(s =>
    s.id.toLowerCase() === n || String(s.name).toLowerCase() === n);
}

export function newPhotoId(originalName) {
  const ext = (path.extname(originalName) || '.jpg').toLowerCase();
  return crypto.randomBytes(8).toString('hex') + ext;
}

export function photoPath(file) {
  return path.join(UPLOAD_DIR, file);
}

/** Build the WhatsApp messages for one style: blurb + photos. */
export function styleMessages(catalog, style, opts = {}) {
  const out = [];
  const withCaption = opts.caption !== false;
  const limit = catalog.photosPerSend || 5;
  const photos = (style.photos || []).filter(f => fs.existsSync(photoPath(f))).slice(0, limit);

  photos.forEach((f, i) => {
    out.push({
      image: { url: photoPath(f) },
      caption: (withCaption && i === 0 && style.blurb) ? style.blurb : undefined,
    });
  });

  if (!photos.length && withCaption && style.blurb) out.push(style.blurb);
  return out;
}
