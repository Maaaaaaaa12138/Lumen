import fs from 'node:fs';
import path from 'node:path';

/** Bump when the probe result shape changes so stale caches are discarded. */
const META_CACHE_VERSION = 2;

/**
 * Minimal EXIF date reader.
 *
 * Pulling DateTimeOriginal out of a raw TIFF/IFD walk is more reliable than
 * regex-scanning the APP1 blob, because edited exports carry many date-looking
 * strings (edit history, software tags) before the original capture date.
 *
 * Note: every offset stored inside EXIF is relative to the TIFF header, which
 * sits 6 bytes into the APP1 segment ("Exif\0\0"), so `base` is added back.
 */
export function readExifDates(buffer) {
  const out = { original: null, digitized: null, modified: null };
  if (!buffer || buffer.length < 12) return out;
  try {
    let base = 0;
    if (buffer.length > 6 && buffer[0] === 0x45 && buffer[1] === 0x78 && buffer[2] === 0x69 && buffer[3] === 0x66) {
      base = 6; // "Exif\0\0"
    }
    const le = buffer[base] === 0x49 && buffer[base + 1] === 0x49; // II
    const be = buffer[base] === 0x4d && buffer[base + 1] === 0x4d; // MM
    if (!le && !be) return out;
    const u16 = (o) => (le ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
    const u32 = (o) => (le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
    if (u16(base + 2) !== 42) return out;

    const ifd0 = base + u32(base + 4);
    if (!ifd0 || ifd0 + 2 > buffer.length) return out;

    const readAscii = (entry) => {
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      if (type !== 2 || count === 0 || count > 128) return null;
      const valueOffset = count <= 4 ? entry + 8 : base + u32(entry + 8);
      if (!valueOffset || valueOffset + count > buffer.length) return null;
      return buffer.toString('latin1', valueOffset, valueOffset + count).replace(/\0.*$/, '').trim() || null;
    };

    const seen = new Set();
    const walkIfd = (offset, wanted) => {
      if (!offset || seen.has(offset) || offset + 2 > buffer.length) return;
      seen.add(offset);
      const count = u16(offset);
      if (count > 512) return;
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        if (entry + 12 > buffer.length) return;
        const tag = u16(entry);
        const name = wanted.get(tag);
        if (name && !out[name]) {
          const value = readAscii(entry);
          if (value) out[name] = value;
        }
        if (tag === 0x8769) {
          // Exif sub-IFD: DateTimeOriginal / DateTimeDigitized live here
          walkIfd(base + u32(entry + 8), new Map([[0x9003, 'original'], [0x9004, 'digitized']]));
        }
      }
    };

    walkIfd(ifd0, new Map([[0x0132, 'modified']]));
  } catch {
    /* malformed EXIF is not fatal */
  }
  return out;
}

/** EXIF "YYYY:MM:DD HH:MM:SS" (local wall clock) -> ISO string, no timezone skew. */
export function exifStringToIso(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

/** Fallback: many cameras/phones stamp the capture time into the filename. */
export function dateFromFilename(name) {
  const base = String(name);
  let m = base.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d, h, mi, s).toISOString();
  }
  m = base.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d, 12, 0, 0).toISOString();
  }
  return null;
}

/**
 * Photoshop/Night-sky edit suffixes that break the jpg <-> out pairing.
 * CJK characters are not \w, so no \b here: match the suffix to end of string.
 */
export function normalizeStem(stem) {
  return String(stem)
    .replace(/\.(jpe?g|tiff?|png)$/i, '')
    .replace(/[-_\s]*(编辑|已增强|降噪|色彩增强|导出|精修|去噪|锐化|hdr|全景|拼接|合成|final|edit|edited|topaz|denoise|sharpen|lightroom|acr).*$/i, '')
    // Copy suffixes are short (`name_1`, `name (2)`); camera sequences such as
    // DSC_3790 are four digits and must stay intact, or every photo of a card
    // collapses onto the same stem and inherits another photo's capture date.
    .replace(/[-_\s(（]+\d{1,2}[)）]?$/g, '')
    .trim();
}

/** Read the metadata cache (rel -> {s,m,w,h,d}) so restarts do not re-probe 17k files. */
export function loadMetaCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === META_CACHE_VERSION && raw.entries && typeof raw.entries === 'object') return raw.entries;
  } catch {
    /* first run */
  }
  return {};
}

export function saveMetaCache(file, entries) {
  const payload = JSON.stringify({ version: META_CACHE_VERSION, updatedAt: new Date().toISOString(), entries });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file);
}
