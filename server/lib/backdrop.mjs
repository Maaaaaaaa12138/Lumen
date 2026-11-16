import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  BACKDROP_FILE, BACKDROP_UPLOAD_DIR, LIBRARY_ROOT,
} from '../config.mjs';
import { formatDateLabel, safeJoin, thumbKey } from './util.mjs';
import { exifStringToIso, readExifDates } from './exif.mjs';

/**
 * The site-wide backdrop.
 *
 * One image becomes the full-bleed background behind every page. It comes from
 * three places, in order of priority:
 *   1. a photo the user picked from the library      (source.kind = 'photo')
 *   2. a file the user uploaded from their device    (source.kind = 'upload')
 *   3. an automatic pick from the newest albums      (source = null)
 *
 * The hero always renders the *original* file so it stays sharp on a 4K screen,
 * but it paints a 24px LQIP first, which is what makes the first impression
 * instant even when the original is a 40 MB JPEG.
 */

const BROWSER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const BROWSER_FORMAT = new Map([
  ['jpeg', 'jpg'], ['png', 'png'], ['webp', 'webp'], ['avif', 'avif'], ['gif', 'gif'],
]);
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const MAX_UPLOAD_AGE = 6 * 3600 * 1000;

const EMPTY_CONFIG = () => ({ version: 1, source: null, settings: {}, updatedAt: null });

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(BACKDROP_FILE, 'utf8'));
    return normalizeConfig(raw);
  } catch {
    return EMPTY_CONFIG();
  }
}

function normalizeConfig(raw) {
  const config = EMPTY_CONFIG();
  const source = raw?.source;
  if (source?.kind === 'photo' && typeof source.photoId === 'string' && source.photoId.length < 512) {
    config.source = { kind: 'photo', photoId: source.photoId };
  } else if (source?.kind === 'upload' && /^[a-f0-9]{16,64}$/.test(String(source.token || ''))) {
    config.source = { kind: 'upload', token: source.token };
  }
  for (const key of ['title', 'date', 'place']) {
    const value = raw?.settings?.[key];
    if (typeof value === 'string' && value.trim()) config.settings[key] = value.trim().slice(0, 80);
  }
  config.updatedAt = typeof raw?.updatedAt === 'string' ? raw.updatedAt : null;
  return config;
}

export async function saveConfig(config) {
  const next = { ...normalizeConfig(config), updatedAt: new Date().toISOString() };
  await fsp.mkdir(path.dirname(BACKDROP_FILE), { recursive: true });
  const tmp = `${BACKDROP_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, BACKDROP_FILE);
  return next;
}

/* ------------------------------------------------------------------ resolve */

/** Build the payload the client needs: URLs, LQIP, and the text shown on the hero. */
export async function resolveBackdrop({ library, config, thumbs }) {
  const settings = config.settings || {};
  let source = null;

  if (config.source?.kind === 'upload') {
    const file = uploadFileFor(config.source.token);
    if (file) {
      const meta = readUploadMeta(config.source.token) || {};
      source = {
        kind: 'upload',
        token: config.source.token,
        abs: file.abs,
        version: config.source.token,
        width: meta.width || null,
        height: meta.height || null,
        bytes: file.bytes,
        defaults: {
          title: '',
          date: meta.date ? formatDateLabel(meta.date, 'day') : '',
          place: '',
        },
      };
    }
  } else if (config.source?.kind === 'photo') {
    if (library) {
      const hit = library.photoIndex.get(config.source.photoId);
      if (hit) source = photoSource(hit, library);
    } else {
      // Boot can render a saved choice before the index is ready.
      source = photoSourceFromDisk(config.source.photoId);
    }
  }

  // No explicit (or no longer valid) choice: fall back to the latest albums.
  if (!source) source = autoSource(library);

  if (!source) {
    return emptyView(config);
  }

  const lqip = await lqipFor(source, thumbs);
  return {
    image: {
      url: `/backdrop/orig?v=${encodeURIComponent(source.version)}`,
      // A small blurred copy for the letterbox area when the photo is contained.
      fill: `/backdrop/fill?v=${encodeURIComponent(source.version)}`,
      placeholder: lqip.placeholder,
      color: lqip.color,
      width: source.width || null,
      height: source.height || null,
      bytes: source.bytes || lqip.bytes || 0,
    },
    title: pick(settings.title, source.defaults.title),
    date: pick(settings.date, source.defaults.date),
    place: pick(settings.place, source.defaults.place),
    source: {
      kind: source.kind,
      photoId: source.photoId || null,
      albumId: source.albumId || null,
    },
    customized: isCustomized(config),
    // private fields used by the HTTP layer, stripped before sending
    abs: source.abs,
    direct: isBrowserImage(source.abs),
    version: source.version,
  };
}

function emptyView(config) {
  return {
    image: null,
    title: pick(config.settings?.title, ''),
    date: pick(config.settings?.date, ''),
    place: pick(config.settings?.place, ''),
    source: null,
    customized: isCustomized(config),
    abs: null,
    direct: false,
    version: null,
  };
}

function isCustomized(config) {
  return Boolean(config.source || Object.keys(config.settings || {}).length);
}

function pick(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback || '';
}

function isBrowserImage(abs) {
  return BROWSER_EXT.has(path.extname(String(abs || '')).toLowerCase());
}

function photoSource(hit, library) {
  const rec = library.recordById.get(hit.recordId);
  return {
    kind: 'photo',
    photoId: hit.photo.rel,
    albumId: hit.recordId,
    abs: hit.photo.abs,
    thumb: hit.photo.thumb,
    version: hit.photo.thumb,
    width: hit.photo.width,
    height: hit.photo.height,
    bytes: hit.photo.bytes,
    defaults: defaultsFor(rec, library, hit.photo),
  };
}

/** Before the index exists we still know the path, so the saved photo can load. */
function photoSourceFromDisk(photoId) {
  const abs = safeJoin(LIBRARY_ROOT, photoId);
  if (!abs) return null;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const version = thumbKey(photoId, stat.size, stat.mtimeMs);
  return {
    kind: 'photo',
    photoId,
    albumId: null,
    abs,
    thumb: version,
    version,
    width: null,
    height: null,
    bytes: stat.size,
    defaults: { title: '', date: '', place: '' },
  };
}

/** Album title + the photo's own capture date, with a "parent · child" headline. */
function defaultsFor(rec, library, photo = null) {
  if (!rec) return { title: '', date: '', place: '' };
  const parent = rec.parentId && library ? library.recordById.get(rec.parentId) : null;
  const place = rec.title || rec.folderName || '';
  const title = parent?.title && parent.title !== place ? `${parent.title} · ${place}` : place;
  const date = photo?.date ? formatDateLabel(photo.date, 'day') : rec.dateLabel || '';
  return { title, date, place };
}

/* ---------------------------------------------------------------- auto pick */

/** Score covers that will actually look good full-screen: wide, rich, not huge. */
function scorePhoto(photo, rec) {
  let score = 0;
  const ratio = photo.width && photo.height ? photo.width / photo.height : 0;
  if (ratio >= 1.3) score += 4;
  else if (ratio >= 1.05) score += 2;
  else score -= 3;
  if (photo.bytes >= 1_500_000 && photo.bytes <= 12_000_000) score += 3;
  else if (photo.bytes > 25_000_000) score -= 3;
  if (rec.parentId) score += 2;
  if (photo.tier === 'curated') score += 1;
  return score;
}

function autoSource(library) {
  if (!library?.photoIndex?.size) return null;

  let best = null;
  for (const id of library.featured || []) {
    const hit = library.photoIndex.get(id);
    if (!hit?.photo || hit.photo.broken) continue;
    const rec = library.recordById.get(hit.recordId);
    if (!rec || rec.sensitive || !isBrowserImage(hit.photo.abs)) continue;
    const score = scorePhoto(hit.photo, rec);
    if (!best || score > best.score) best = { hit, score };
  }
  if (best) return photoSource(best.hit, library);

  const landscape = [];
  const any = [];
  for (const hit of library.photoIndex.values()) {
    if (!hit.photo || hit.photo.broken) continue;
    const rec = library.recordById.get(hit.recordId);
    if (!rec || rec.sensitive || !isBrowserImage(hit.photo.abs)) continue;
    any.push(hit);
    if (hit.photo.width && hit.photo.height && hit.photo.width / hit.photo.height >= 1.2) {
      landscape.push(hit);
    }
  }
  const fallback = landscape.sort((a, b) => scorePhoto(b.photo, library.recordById.get(b.recordId)) - scorePhoto(a.photo, library.recordById.get(a.recordId)))[0]
    || any[0];
  return fallback ? photoSource(fallback, library) : null;
}

/* ------------------------------------------------------------------- LQIP */

const lqipCache = new Map();

async function lqipFor(source, thumbs) {
  const key = `${source.kind}:${source.version}`;
  const hit = lqipCache.get(key);
  if (hit) return hit;

  let buf = null;
  try {
    if (source.kind === 'photo' && thumbs) {
      const small = thumbs.thumbPath(source.thumb, 'b');
      if (fs.existsSync(small)) {
        buf = await fsp.readFile(small);
      } else {
        const large = thumbs.thumbPath(source.thumb, 't');
        if (fs.existsSync(large)) buf = await shrink(await fsp.readFile(large));
      }
    } else if (source.kind === 'upload') {
      const small = path.join(BACKDROP_UPLOAD_DIR, `${source.token}_b.webp`);
      if (fs.existsSync(small)) buf = await fsp.readFile(small);
    }
    if (!buf) buf = await shrink(await fsp.readFile(source.abs));
  } catch {
    return { placeholder: null, color: null, width: source.width || null, height: source.height || null, bytes: source.bytes || 0 };
  }

  const value = {
    placeholder: `data:image/webp;base64,${buf.toString('base64')}`,
    color: await averageColor(buf),
    width: source.width || null,
    height: source.height || null,
    bytes: source.bytes || 0,
  };
  if (lqipCache.size > 32) lqipCache.clear();
  lqipCache.set(key, value);
  return value;
}

async function shrink(buf) {
  return sharp(buf, { failOn: 'none', limitInputPixels: false })
    .rotate()
    .resize({ width: 32, height: 32, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 46, effort: 2 })
    .toBuffer();
}

async function averageColor(buf) {
  try {
    const raw = await sharp(buf).resize(1, 1, { fit: 'inside' }).removeAlpha().raw().toBuffer();
    if (raw.length >= 3) {
      return `#${raw[0].toString(16).padStart(2, '0')}${raw[1].toString(16).padStart(2, '0')}${raw[2].toString(16).padStart(2, '0')}`;
    }
  } catch {
    /* colour is a nicety */
  }
  return null;
}

/* -------------------------------------------------------------- candidates */

/** A hand-picked-looking set of wide photos for the "选择一张照片" grid. */
export function pickCandidates(library, limit = 120) {
  if (!library?.records?.length) return [];
  const records = [...library.records]
    .filter((r) => !r.isCollection && !r.sensitive)
    .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));

  const out = [];
  const used = new Set();

  const add = (rec, photo, requireWide) => {
    if (!photo || used.has(photo.rel) || photo.broken) return false;
    if (!isBrowserImage(photo.abs)) return false;
    const ratio = photo.width && photo.height ? photo.width / photo.height : 0;
    if (requireWide && ratio > 0 && ratio < 1.05) return false;
    const defaults = defaultsFor(rec, library, photo);
    used.add(photo.rel);
    out.push({
      id: photo.rel,
      thumb: photo.thumb,
      w: photo.width || null,
      h: photo.height || null,
      date: rec.dateLabel || '',
      bytes: photo.bytes,
      title: defaults.title,
      place: defaults.place,
      albumId: rec.id,
      albumTitle: rec.title,
      curated: photo.tier === 'curated',
    });
    return true;
  };

  for (const rec of records) {
    const pool = rec.curatedPhotos?.length ? rec.curatedPhotos : rec.photos;
    let taken = 0;
    for (const photo of pool) {
      if (taken >= 3) break;
      if (add(rec, photo, true)) taken++;
    }
    if (out.length >= limit) break;
  }

  // Some albums only have vertical shots — make sure the grid is never empty.
  if (out.length < 24) {
    for (const rec of records) {
      let taken = 0;
      for (const photo of rec.photos) {
        if (taken >= 2) break;
        if (used.has(photo.rel)) continue;
        if (add(rec, photo, false)) taken++;
      }
      if (out.length >= 60) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ upload */

export function readUploadMeta(token) {
  if (!/^[a-f0-9]{16,64}$/.test(String(token || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(BACKDROP_UPLOAD_DIR, `${token}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function uploadFileFor(token) {
  if (!/^[a-f0-9]{16,64}$/.test(String(token || ''))) return null;
  let entries;
  try {
    entries = fs.readdirSync(BACKDROP_UPLOAD_DIR);
  } catch {
    return null;
  }
  const name = entries.find((n) => n.startsWith(`${token}.`) && !n.endsWith('.json') && !n.includes('_b.'));
  if (!name) return null;
  const abs = path.join(BACKDROP_UPLOAD_DIR, name);
  try {
    const stat = fs.statSync(abs);
    return stat.isFile() ? { abs, bytes: stat.size, name } : null;
  } catch {
    return null;
  }
}

/**
 * Store an uploaded original untouched. Only formats browsers can paint are
 * accepted, so "show the original" also means "show it without conversion".
 */
export async function storeUpload(buffer, originalName = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('没有收到图片数据');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('图片太大了，最大 80 MB');

  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'none', limitInputPixels: false }).metadata();
  } catch {
    throw new Error('无法识别这张图片，请换一张 JPG / PNG / WebP');
  }
  const ext = BROWSER_FORMAT.get(meta.format);
  if (!ext) throw new Error('暂不支持这个格式，请用 JPG / PNG / WebP / AVIF');
  if (!meta.width || !meta.height) throw new Error('读不出图片尺寸');

  const token = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 32);
  await fsp.mkdir(BACKDROP_UPLOAD_DIR, { recursive: true });
  const file = path.join(BACKDROP_UPLOAD_DIR, `${token}.${ext}`);
  if (!fs.existsSync(file)) await writeAtomic(file, buffer);

  const small = path.join(BACKDROP_UPLOAD_DIR, `${token}_b.webp`);
  if (!fs.existsSync(small)) await writeAtomic(small, await shrink(buffer));

  const dates = readExifDates(meta.exif);
  const iso = exifStringToIso(dates.original) || exifStringToIso(dates.digitized) || exifStringToIso(dates.modified);
  const metaFile = {
    token,
    name: path.basename(String(originalName || 'image')).slice(0, 160),
    format: meta.format,
    ext,
    width: meta.width,
    height: meta.height,
    bytes: buffer.length,
    date: iso,
    uploadedAt: new Date().toISOString(),
  };
  await writeAtomic(path.join(BACKDROP_UPLOAD_DIR, `${token}.json`), Buffer.from(JSON.stringify(metaFile)));

  const lqip = await lqipFor(
    { kind: 'upload', token, version: token, abs: file, width: meta.width, height: meta.height, bytes: buffer.length },
    null,
  );
  return {
    token,
    url: `/backdrop/upload/${token}`,
    placeholder: lqip.placeholder,
    width: meta.width,
    height: meta.height,
    bytes: buffer.length,
    name: metaFile.name,
    date: metaFile.date ? formatDateLabel(metaFile.date, 'day') : '',
  };
}

/** Drop uploads that were previewed but never saved (and old replaced ones). */
export async function pruneUploads(keepToken = null) {
  let entries;
  try {
    entries = await fsp.readdir(BACKDROP_UPLOAD_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (keepToken && name.startsWith(keepToken)) continue;
    const abs = path.join(BACKDROP_UPLOAD_DIR, name);
    try {
      const stat = await fsp.stat(abs);
      if (now - stat.mtimeMs > MAX_UPLOAD_AGE) await fsp.unlink(abs);
    } catch {
      /* already gone */
    }
  }
}

/* ----------------------------------------------------------------- helpers */

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
