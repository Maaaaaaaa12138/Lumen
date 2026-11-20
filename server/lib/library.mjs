import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  META_CACHE_FILE, PROBE_CONCURRENCY, AUTO_RECOMMENDED_COUNT, INDEX_FILE,
} from '../config.mjs';
import { scanLibrary } from './scanner.mjs';
import {
  readExifDates, exifStringToIso, dateFromFilename, normalizeStem,
  loadMetaCache, saveMetaCache,
} from './exif.mjs';
import { formatDateLabel } from './util.mjs';

/**
 * Full index build:
 *   scan -> probe (EXIF + dimensions, cached) -> date resolution -> curated set
 *   -> chronological sorting -> summary records.
 */
export async function buildLibrary(root, { onProgress = () => {} } = {}) {
  const t0 = Date.now();
  onProgress({ phase: 'scan', message: '扫描照片目录' });
  const scan = scanLibrary(root);

  const records = scan.records;
  const cache = loadMetaCache(META_CACHE_FILE);
  let cacheDirty = false;

  // ---- collect everything that needs a header probe -------------------------
  const targets = new Map(); // rel -> {bytes, mtimeMs}
  for (const rec of records) {
    for (const p of rec.photos) targets.set(p.rel, { bytes: p.bytes, mtimeMs: p.mtimeMs });
    for (const v of rec.videos) {
      if (v.poster) targets.set(v.poster.rel, { bytes: v.poster.bytes, mtimeMs: v.poster.mtimeMs });
    }
  }

  const todo = [];
  for (const [rel, info] of targets) {
    const cached = cache[rel];
    if (cached && cached.s === info.bytes && cached.m === Math.round(info.mtimeMs)) continue;
    todo.push(rel);
  }

  onProgress({ phase: 'probe', total: todo.length, done: 0, message: '读取拍摄信息' });

  let done = 0;
  let cursor = 0;
  const failed = new Set();
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, todo.length)) }, async () => {
    while (cursor < todo.length) {
      const rel = todo[cursor++];
      const info = targets.get(rel);
      const abs = path.join(root, rel);
      let entry = null;
      try {
        const md = await sharp(abs, { failOn: 'none', limitInputPixels: false }).metadata();
        const swap = (md.orientation || 1) >= 5;
        const dates = readExifDates(md.exif);
        const date = exifStringToIso(dates.original) || exifStringToIso(dates.digitized) || exifStringToIso(dates.modified);
        entry = {
          s: info.bytes,
          m: Math.round(info.mtimeMs),
          w: swap ? md.height : md.width,
          h: swap ? md.width : md.height,
          d: date,
        };
      } catch {
        failed.add(rel);
        entry = { s: info.bytes, m: Math.round(info.mtimeMs), w: null, h: null, d: null };
      }
      cache[rel] = entry;
      cacheDirty = true;
      done++;
      if (done % 60 === 0 || done === todo.length) {
        onProgress({ phase: 'probe', total: todo.length, done, message: '读取拍摄信息' });
      }
    }
  });
  await Promise.all(workers);

  if (cacheDirty) {
    // prune entries that no longer belong to the library
    const pruned = {};
    for (const rel of targets.keys()) if (cache[rel]) pruned[rel] = cache[rel];
    saveMetaCache(META_CACHE_FILE, pruned);
  }

  // ---- apply metadata + resolve photo dates --------------------------------
  const photoIndex = new Map(); // rel -> { photo, recordId }
  const videoIndex = new Map(); // rel -> video
  let totalPhotoBytes = 0;
  let totalVideoBytes = 0;

  for (const rec of records) {
    for (const p of rec.photos) {
      const meta = cache[p.rel];
      p.width = meta?.w || null;
      p.height = meta?.h || null;
      const exifDate = meta?.d || null;
      const fileDate = dateFromFilename(p.name);
      p.date = exifDate || fileDate || new Date(p.mtimeMs).toISOString();
      p.dateSource = exifDate ? 'exif' : fileDate ? 'filename' : 'mtime';
      // copy-time mtimes must not drag an album's capture window into the wrong year
      p.dateStrong = Boolean(exifDate || fileDate);
      p.broken = failed.has(p.rel);
      totalPhotoBytes += p.bytes;
      rec.photoBytes = (rec.photoBytes || 0) + p.bytes;
      photoIndex.set(p.rel, { photo: p, recordId: rec.id });
    }
    for (const v of rec.videos) {
      const posterMeta = v.poster ? cache[v.poster.rel] : null;
      v.date = posterMeta?.d || dateFromFilename(v.name) || new Date(v.mtimeMs).toISOString();
      v.dateStrong = Boolean(posterMeta?.d || dateFromFilename(v.name));
      v.width = posterMeta?.w || null;
      v.height = posterMeta?.h || null;
      totalVideoBytes += v.bytes;
      rec.videoBytes = (rec.videoBytes || 0) + v.bytes;
      v.recordId = rec.id;
      videoIndex.set(v.rel, v);
    }
  }

  // ---- per-album capture window -------------------------------------------
  for (const rec of records) {
    const std = rec.photos.filter((p) => p.tier !== 'curated');
    const curated = rec.photos.filter((p) => p.tier === 'curated');
    const basis = std.length ? std : curated.length ? curated : rec.videos;
    const strong = basis.filter((item) => item.dateStrong);
    const pick = strong.length ? strong : basis;
    let start = null;
    let end = null;
    for (const item of pick) {
      const t = new Date(item.date).getTime();
      if (!Number.isFinite(t)) continue;
      if (start === null || t < start) start = t;
      if (end === null || t > end) end = t;
    }
    if (start !== null && strong.length) {
      rec.startDate = new Date(start).toISOString();
      rec.endDate = new Date(end).toISOString();
      rec.datePrecision = 'day';
      rec.hasOwnDate = true;
      rec.dateTrust = 'capture';
    } else if (rec.folderDate) {
      rec.startDate = rec.folderDate;
      rec.endDate = rec.folderDate;
      rec.datePrecision = rec.folderPrecision || 'year';
      rec.hasOwnDate = true;
      rec.dateTrust = 'folder';
    } else if (start !== null && rec.depth >= 1) {
      // Only copy-time mtimes are available. A 2023 folder should read as "2023",
      // not as the day the files happened to be copied onto this disk.
      const mid = new Date(rec.year, 6, 1).toISOString();
      rec.startDate = mid;
      rec.endDate = mid;
      rec.datePrecision = 'year';
      rec.hasOwnDate = true;
      rec.dateTrust = 'year';
    } else if (start !== null) {
      rec.startDate = new Date(start).toISOString();
      rec.endDate = new Date(end).toISOString();
      rec.datePrecision = 'day';
      rec.hasOwnDate = true;
      rec.dateTrust = 'copy';
    } else {
      rec.startDate = null;
      rec.endDate = null;
      rec.datePrecision = 'year';
      rec.hasOwnDate = false;
      rec.dateTrust = 'none';
    }
  }

  // ---- copy-time-only files follow the album's capture window --------------
  // A file with no EXIF and no date in its name only has its copy mtime; using
  // it would drop a 2023 archive photo into whatever year it was copied.
  // Albums with a trustworthy window (real captures or a folder date) lend that
  // date to such files; mtime-only albums keep their own (possibly correct) times.
  for (const rec of records) {
    if (rec.dateTrust !== 'capture' && rec.dateTrust !== 'folder') continue;
    const fallback = rec.folderDate || rec.startDate;
    if (!fallback) continue;
    for (const p of rec.photos) {
      if (p.dateStrong) continue;
      p.date = fallback;
      p.dateSource = 'album';
    }
  }

  // ---- curated selection ---------------------------------------------------
  for (const rec of records) {
    resolveCurated(rec);
  }

  // ---- collections inherit their children's window -------------------------
  const byId = new Map(records.map((r) => [r.id, r]));
  const childMap = new Map();
  for (const rec of records) {
    if (!rec.parentId) continue;
    if (!childMap.has(rec.parentId)) childMap.set(rec.parentId, []);
    childMap.get(rec.parentId).push(rec.id);
  }
  for (const rec of records) {
    rec.childIds = childMap.get(rec.id) || [];
    rec.isCollection = rec.childIds.length > 0;
  }
  const depthOrder = [...records].sort((a, b) => b.depth - a.depth);
  for (const rec of depthOrder) {
    if (!rec.childIds.length) continue;
    const children = rec.childIds.map((id) => byId.get(id)).filter(Boolean);
    // a child dated only by file copy time must not stretch a collection into another year
    const reliable = children.filter((c) => c.dateTrust && c.dateTrust !== 'copy' && c.startDate);
    const basis = reliable.length ? reliable : children;
    let start = rec.hasOwnDate && rec.dateTrust !== 'copy' ? new Date(rec.startDate).getTime() : null;
    let end = rec.hasOwnDate && rec.dateTrust !== 'copy' ? new Date(rec.endDate).getTime() : null;
    for (const c of basis) {
      const s = new Date(c.startDate || 0).getTime();
      const e = new Date(c.endDate || 0).getTime();
      if (Number.isFinite(s) && s > 0 && (start === null || s < start)) start = s;
      if (Number.isFinite(e) && e > 0 && (end === null || e > end)) end = e;
    }
    if (start !== null && Number.isFinite(start)) {
      rec.startDate = new Date(start).toISOString();
      const e = end && Number.isFinite(end) ? end : start;
      rec.endDate = new Date(e).toISOString();
      if (!rec.datePrecision || rec.datePrecision === 'year') rec.datePrecision = 'day';
      rec.dateTrust = 'collection';
    }
  }

  // ---- sort photos inside each album --------------------------------------
  for (const rec of records) {
    const byDate = (a, b) => {
      const ta = new Date(a.date).getTime() || 0;
      const tb = new Date(b.date).getTime() || 0;
      return ta - tb || a.name.localeCompare(b.name, 'zh');
    };
    rec.photos.sort(byDate);
    rec.videos.sort(byDate);
    rec.curatedPhotos.sort(byDate);
    rec.recommendedPhotos.sort(byDate);
  }

  // ---- summaries + covers --------------------------------------------------
  for (const rec of records) {
    rec.sensitive = /证件照|身份证|护照/.test(`${rec.title}/${rec.id}`);
    rec.coverIds = pickCovers(rec);
    rec.covers = resolveCovers(rec);
    rec.dateLabel = formatDateLabel(rec.startDate, rec.datePrecision);
    rec.title = rec.title || rec.folderName;
  }

  // ---- featured photos for the landing hero -------------------------------
  const featured = buildFeatured(records);

  // chronological records (newest first) for the timeline
  const timeline = records
    .filter((r) => !r.parentId)
    .sort((a, b) => {
      const ta = new Date(a.startDate || 0).getTime() || 0;
      const tb = new Date(b.startDate || 0).getTime() || 0;
      return tb - ta;
    })
    .map((r) => r.id);

  const library = {
    root,
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - t0,
    years: scan.years,
    records,
    recordById: byId,
    photoIndex,
    videoIndex,
    timeline,
    featured,
    stats: {
      albums: records.filter((r) => !r.isCollection || r.photoCount > 0 || r.videoCount > 0).length,
      collections: records.filter((r) => r.isCollection).length,
      photos: records.reduce((s, r) => s + r.photoCount, 0),
      curated: records.reduce((s, r) => s + r.curatedPhotos.length, 0),
      recommended: records.reduce((s, r) => s + r.recommendedPhotos.length, 0),
      videos: records.reduce((s, r) => s + r.videoCount, 0),
      bytes: totalPhotoBytes + totalVideoBytes,
      photoBytes: totalPhotoBytes,
      videoBytes: totalVideoBytes,
      days: countDistinctDays(records),
      years: scan.years.length,
    },
  };

  // expose abs paths only internally
  for (const rec of records) {
    rec.abs = path.join(root, rec.id);
    for (const p of rec.photos) p.abs = path.join(root, p.rel);
    for (const v of rec.videos) {
      v.abs = path.join(root, v.rel);
      if (v.poster) v.poster.abs = path.join(root, v.poster.rel);
    }
  }

  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(`${INDEX_FILE}.tmp`, JSON.stringify(buildSnapshot(library)));
    fs.renameSync(`${INDEX_FILE}.tmp`, INDEX_FILE);
  } catch {
    /* the index file is only a debugging aid */
  }

  return library;
}

function resolveCurated(rec) {
  const curated = rec.photos.filter((p) => p.tier === 'curated');
  const std = rec.photos.filter((p) => p.tier !== 'curated');

  // 精选 is only what was actually kept: out/ (and 官方返图/精修/精选/finals)
  // plus anything under 精品放这里. Nothing is ever auto-promoted into it.
  rec.curatedPhotos = curated;
  rec.recommendedPhotos = [];
  rec.recommendedOnly = false;

  if (curated.length) {
    // inherit capture time from the matching original when we can
    const byStem = new Map();
    for (const p of std) byStem.set(normalizeStem(p.name).toUpperCase(), p);
    for (const p of curated) {
      const hit = byStem.get(normalizeStem(p.name).toUpperCase());
      if (hit) p.date = hit.date;
    }
    return;
  }

  // No kept files: show an evenly spread preview, clearly under 推荐 only.
  if (std.length) {
    const k = Math.min(
      AUTO_RECOMMENDED_COUNT,
      Math.max(8, Math.round(Math.sqrt(std.length) * 1.25)),
      std.length,
    );
    const picked = [];
    if (std.length <= k) {
      picked.push(...std);
    } else {
      const used = new Set();
      for (let i = 0; i < k; i++) {
        let idx = Math.round((i * (std.length - 1)) / (k - 1));
        // nudge off duplicates created by rounding
        while (used.has(idx) && idx < std.length - 1) idx++;
        used.add(idx);
        picked.push(std[idx]);
      }
    }
    rec.recommendedPhotos = picked;
    rec.recommendedOnly = true;
  }
}

export function pickCovers(rec) {
  const pool = rec.curatedPhotos.length
    ? rec.curatedPhotos
    : rec.recommendedPhotos.length
      ? rec.recommendedPhotos
      : rec.photos;
  if (!pool.length) {
    return rec.videos.filter((v) => v.thumb).slice(0, 4).map((v) => v.rel);
  }
  const want = Math.min(5, pool.length);
  const picked = [];
  const stride = pool.length / want;
  for (let i = 0; i < want; i++) {
    picked.push(pool[Math.min(pool.length - 1, Math.floor(i * stride + stride / 2))]);
  }
  return [...new Set(picked.map((p) => p.rel))];
}

/** Turn cover ids into everything the timeline mosaic needs, in one payload. */
export function resolveCovers(rec) {
  const photoById = new Map(rec.photos.map((p) => [p.rel, p]));
  const videoById = new Map(rec.videos.map((v) => [v.rel, v]));
  const out = [];
  for (const id of rec.coverIds) {
    const p = photoById.get(id);
    if (p) {
      out.push({ id, thumb: p.thumb, w: p.width || 1500, h: p.height || 1000, isVideo: false });
      continue;
    }
    const v = videoById.get(id);
    if (v && v.thumb) {
      out.push({ id, thumb: v.thumb, w: v.width || 1600, h: v.height || 900, isVideo: true });
    }
  }
  return out;
}

function buildFeatured(records) {
  // Passport / ID photos are part of the archive but should not greet you.
  const isIntimate = (r) => /证件照/.test(r.title || '') || /证件照/.test(r.folderName || '');
  const withCovers = records
    .filter((r) => !r.isCollection && (r.curatedPhotos.length > 0 || r.recommendedPhotos.length > 0) && !isIntimate(r))
    .sort((a, b) => (new Date(b.startDate || 0)) - (new Date(a.startDate || 0)));
  const ids = [];
  for (let round = 0; round < 3; round++) {
    for (const rec of withCovers) {
      // The hero is imagery, not the 精选 archive: a 推荐 fallback keeps
      // albums without curated files in the rotation.
      const pool = rec.curatedPhotos.length ? rec.curatedPhotos : rec.recommendedPhotos;
      const p = pool[round * 2 + 1] || pool[round] || pool[0];
      if (p && !ids.includes(p.rel)) ids.push(p.rel);
      if (ids.length >= 22) return ids;
    }
  }
  return ids;
}

function countDistinctDays(records) {
  const days = new Set();
  for (const rec of records) {
    if (rec.isCollection) continue;
    for (const p of rec.photos) {
      if (p.tier === 'curated') continue;
      const d = new Date(p.date);
      if (!Number.isNaN(d.getTime())) days.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
    }
  }
  return days.size;
}

function buildSnapshot(library) {
  return {
    generatedAt: library.generatedAt,
    stats: library.stats,
    timeline: library.timeline,
    records: library.records.map((r) => summaryOf(r)),
  };
}

/** Small payload for the timeline grid. */
export function summaryOf(rec) {
  return {
    id: rec.id,
    parentId: rec.parentId,
    year: rec.year,
    title: rec.title,
    folderName: rec.folderName,
    startDate: rec.startDate,
    endDate: rec.endDate,
    dateLabel: rec.dateLabel,
    datePrecision: rec.datePrecision,
    photoCount: rec.photoCount,
    curatedCount: rec.curatedPhotos.length,
    recommendedCount: rec.recommendedPhotos.length,
    recommendedOnly: Boolean(rec.recommendedOnly),
    videoCount: rec.videoCount,
    childIds: rec.childIds,
    isCollection: rec.isCollection,
    coverIds: rec.coverIds,
    covers: rec.covers || [],
    depth: rec.depth,
    sensitive: Boolean(rec.sensitive),
    bytes: (rec.photoBytes || 0) + (rec.videoBytes || 0),
  };
}

/** Full payload for an opened album. */
export function detailOf(rec) {
  return {
    ...summaryOf(rec),
    photos: rec.photos.map(publicPhoto),
    curated: rec.curatedPhotos.map((p) => p.rel),
    recommended: rec.recommendedPhotos.map((p) => p.rel),
    videos: rec.videos.map(publicVideo),
  };
}

export function publicPhoto(p) {
  return {
    id: p.rel,
    thumb: p.thumb,
    w: p.width || 1500,
    h: p.height || 1000,
    date: p.date,
    bytes: p.bytes,
    name: p.name,
    tier: p.tier === 'curated' ? 1 : 0,
    color: p.color || null,
    broken: p.broken || false,
  };
}

export function publicVideo(v) {
  return {
    id: v.rel,
    name: v.name,
    thumb: v.thumb,
    w: v.width || null,
    h: v.height || null,
    date: v.date,
    bytes: v.bytes,
    duration: v.durationSec,
    posterId: v.poster ? v.poster.rel : null,
  };
}
