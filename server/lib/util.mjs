import crypto from 'node:crypto';
import path from 'node:path';

/** Convert a library-relative path to the internal photo id (forward slashes). */
export function toRel(...parts) {
  return path.join(...parts).split(path.sep).join('/');
}

export function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

/** Stable thumbnail key: changes if the file changes, so edits regenerate cleanly. */
export function thumbKey(rel, size, mtimeMs) {
  return sha1(`${rel}|${size}|${Math.round(mtimeMs)}`).slice(0, 24);
}

/** base64url for ids passed through URLs (keeps unicode + slashes safe). */
export function encodeId(rel) {
  return Buffer.from(rel, 'utf8').toString('base64url');
}

export function decodeId(token) {
  try {
    return Buffer.from(String(token), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Resolve an id/relative path against the library root, refusing escapes. */
export function safeJoin(root, rel) {
  if (!rel || typeof rel !== 'string') return null;
  if (rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  const normalizedRoot = path.resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) return null;
  return abs;
}

/** Ordinal path-prefix date parsing, e.g. 0623滨河森林公园 -> 06-23. */
const CHINESE_MONTH = /^(\d{1,2})月/;

export function parseFolderDate(name, fallbackYear) {
  let m;
  // 2024-06-23 / 2024.06.23 / 2024_06_23
  m = name.match(/^(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/);
  if (m) {
    const d = buildDate(+m[1], +m[2], +m[3]);
    if (d) return { date: d, precision: 'day', rest: name.slice(m[0].length) };
  }
  // 20240623
  m = name.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const d = buildDate(+m[1], +m[2], +m[3]);
    if (d) return { date: d, precision: 'day', rest: name.slice(8) };
  }
  // 0623 (MMDD) - only when the month/day are plausible
  m = name.match(/^(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const mm = +m[1], dd = +m[2];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const d = buildDate(fallbackYear, mm, dd);
      if (d) return { date: d, precision: 'day', rest: name.slice(4) };
    }
  }
  // 6月...
  m = name.match(CHINESE_MONTH);
  if (m) {
    const d = buildDate(fallbackYear, +m[1], 1);
    if (d) return { date: d, precision: 'month', rest: name.slice(m[0].length) };
  }
  // 2024年6月
  m = name.match(/^(\d{4})年(?:(\d{1,2})月)?/);
  if (m) {
    const d = buildDate(+m[1], m[2] ? +m[2] : 1, 1);
    if (d) return { date: d, precision: m[2] ? 'month' : 'year', rest: name.slice(m[0].length) };
  }
  // 2024 (leading year duplicating the parent folder)
  m = name.match(/^(\d{4})(?!\d)/);
  if (m) {
    const d = buildDate(+m[1], 1, 1);
    if (d) return { date: d, precision: 'year', rest: name.slice(4) };
  }
  return { date: null, precision: null, rest: name };
}

function buildDate(year, month, day) {
  if (!Number.isFinite(year) || year < 1990 || year > 2100) return null;
  const mm = Math.min(Math.max(month, 1), 12);
  const dd = Math.min(Math.max(day, 1), 31);
  return new Date(year, mm - 1, dd, 12, 0, 0);
}

/** Human title for an album, derived from its folder name. */
export function albumTitle(folderName, prefixRest) {
  const rest = (prefixRest || '').trim().replace(/^[-_·.\s]+/, '');
  const base = rest || folderName;
  return base;
}

/** ISO date (YYYY-MM-DD) or month/year string, for display and ordering. */
export function dateParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDateLabel(iso, precision) {
  const p = dateParts(iso);
  if (!p) return '';
  if (precision === 'year') return `${p.y}`;
  if (precision === 'month') return `${p.y}.${pad2(p.m)}`;
  return `${p.y}.${pad2(p.m)}.${pad2(p.d)}`;
}

export function formatDateTime(iso) {
  const p = dateParts(iso);
  if (!p) return '';
  const d = new Date(iso);
  return `${p.y}.${pad2(p.m)}.${pad2(p.d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 3600 * 1000],
  ['month', 30 * 24 * 3600 * 1000],
  ['day', 24 * 3600 * 1000],
  ['hour', 3600 * 1000],
  ['minute', 60 * 1000],
];

export function relativeTime(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (diff >= ms) {
      const n = Math.floor(diff / ms);
      const label = unit === 'year' ? '年前' : unit === 'month' ? '个月前' : unit === 'day' ? '天前' : unit === 'hour' ? '小时前' : '分钟前';
      return `${n}${label}`;
    }
  }
  return '刚刚';
}

/** bytes -> "12.4 MB" */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
