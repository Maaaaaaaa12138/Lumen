import fs from 'node:fs';
import path from 'node:path';
import {
  IMAGE_EXT, VIDEO_EXT, IGNORE_DIR_NAMES, CURATED_DIR_NAMES, PLAIN_DIR_NAMES,
  IGNORED_ROOT_NAMES, MAX_ALBUM_DEPTH,
} from '../config.mjs';
import { parseFolderDate, albumTitle, thumbKey } from './util.mjs';

/**
 * Walk E:\share\image and turn it into a tree of album records.
 *
 * The layout is mostly `year/<event>/{jpg,out,raw,M4ROOT}` but 2023 nests deeper
 * (旧存储/<event>, 旧存储/精品放这里/<event>, ...). Instead of hard-coding those
 * exceptions we classify every folder by what it actually contains:
 *
 *   - a folder with media of its own          -> album
 *   - a folder with only media-bearing children -> collection (group header)
 *   - a folder with both                      -> collection that also owns media
 *
 * Folders deeper than MAX_ALBUM_DEPTH are flattened into their parent so that
 * 精品放这里/百望山 & friends stay inside one "精品放这里" album.
 */
export function scanLibrary(root) {
  const t0 = Date.now();
  const yearDirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name) && !IGNORED_ROOT_NAMES.has(e.name))
    .map((e) => e.name)
    .sort();

  const records = [];
  const years = [];
  let fileCount = 0;

  for (const yearName of yearDirs) {
    const year = Number(yearName);
    const yearAbs = path.join(root, yearName);
    const yearNode = buildNode({
      abs: yearAbs,
      rel: yearName,
      depth: 0,
      year,
      parentRel: null,
      forceCurated: false,
    });
    fileCount += yearNode.fileCount;

    // Emit every media-bearing node below the year as a record.
    const yearRecords = [];
    const emit = (node) => {
      const hasMedia = node.photos.length > 0 || node.videos.length > 0;
      const hasChildren = node.children.length > 0;
      if (!hasMedia && !hasChildren) return null;
      if (node.depth === 0 && !hasMedia) {
        // pure year container: only children matter
        for (const child of node.children) emit(child);
        return null;
      }
      const record = finalizeRecord(node, year);
      records.push(record);
      yearRecords.push(record);
      for (const child of node.children) emit(child);
      return record;
    };
    for (const child of yearNode.children) emit(child);

    years.push({
      year,
      label: `${year}`,
      recordCount: yearRecords.filter((r) => !r.parentId).length,
    });
  }

  return { records, years, fileCount, scanMs: Date.now() - t0 };
}

function buildNode({ abs, rel, depth, year, parentRel, forceCurated }) {
  const node = {
    abs, rel, depth, year, parentRel, forceCurated,
    name: path.basename(abs),
    photos: [],
    videos: [],
    children: [],
    fileCount: 0,
  };

  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return node;
  }

  const curatedHere = forceCurated || rel.split('/').some((part) => part === '精品放这里');

  for (const entry of entries) {
    const name = entry.name;
    if (!name || name.startsWith('.') || name.startsWith('_')) continue; // ._APPLE / Thumbs
    const lower = name.toLowerCase();

    if (entry.isDirectory()) {
      if (IGNORE_DIR_NAMES.has(lower)) continue;
      if (lower === 'm4root' || lower === 'private' || lower === 'sony') {
        collectCamcorder(node, path.join(abs, name), `${rel}/${name}`);
        continue;
      }
      if (CURATED_DIR_NAMES.has(name) || lower === 'out') {
        walkMedia(node, path.join(abs, name), `${rel}/${name}`, 'curated', true);
        continue;
      }
      if (PLAIN_DIR_NAMES.has(lower)) {
        walkMedia(node, path.join(abs, name), `${rel}/${name}`, curatedHere ? 'curated' : 'std', true);
        continue;
      }
      if (depth + 1 <= MAX_ALBUM_DEPTH) {
        const child = buildNode({
          abs: path.join(abs, name),
          rel: `${rel}/${name}`,
          depth: depth + 1,
          year,
          parentRel: rel,
          forceCurated: curatedHere,
        });
        node.fileCount += child.fileCount;
        const childHasMedia = child.photos.length > 0 || child.videos.length > 0;
        if (childHasMedia || child.children.length > 0) node.children.push(child);
        continue;
      }
      // too deep to be its own album: fold its media into this one
      walkMedia(node, path.join(abs, name), `${rel}/${name}`, curatedHere ? 'curated' : 'std', true);
      continue;
    }

    const ext = path.extname(name).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      const stat = safeStat(path.join(abs, name));
      if (!stat) continue;
      node.fileCount++;
      pushPhoto(node, {
        rel: `${rel}/${name}`,
        name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        tier: curatedHere ? 'curated' : 'std',
      });
    } else if (VIDEO_EXT.has(ext)) {
      const stat = safeStat(path.join(abs, name));
      if (!stat) continue;
      node.fileCount++;
      pushVideo(node, {
        rel: `${rel}/${name}`,
        name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        durationSec: null,
        poster: null,
      });
    }
  }

  return node;
}

/** Recursively collect images/videos below a known media folder (jpg/, out/, ...). */
function walkMedia(node, abs, rel, tier, includeVideos) {
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (!name || name.startsWith('.') || name.startsWith('_')) continue;
    const lower = name.toLowerCase();
    if (entry.isDirectory()) {
      if (IGNORE_DIR_NAMES.has(lower)) continue;
      if (lower === 'm4root') {
        collectCamcorder(node, path.join(abs, name), `${rel}/${name}`);
        continue;
      }
      walkMedia(node, path.join(abs, name), `${rel}/${name}`, tier, includeVideos);
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    const stat = safeStat(path.join(abs, name));
    if (!stat) continue;
    if (IMAGE_EXT.has(ext)) {
      node.fileCount++;
      pushPhoto(node, { rel: `${rel}/${name}`, name, bytes: stat.size, mtimeMs: stat.mtimeMs, tier });
    } else if (includeVideos && VIDEO_EXT.has(ext)) {
      node.fileCount++;
      pushVideo(node, { rel: `${rel}/${name}`, name, bytes: stat.size, mtimeMs: stat.mtimeMs, durationSec: null, poster: null });
    }
  }
}

/**
 * Sony XAVC S cards: M4ROOT/CLIP/*.MP4 (or .XML sidecars) with matching
 * M4ROOT/THMBNL/<clip>T01.JPG thumbnails that make perfect video posters.
 *
 * Windows paths are case-insensitive, so the folder list is resolved from a
 * single readdir instead of probing name variants (which used to double count).
 */
function collectCamcorder(node, m4Abs, m4Rel) {
  let m4Entries = [];
  try {
    m4Entries = fs.readdirSync(m4Abs, { withFileTypes: true });
  } catch {
    return;
  }
  const findDir = (wanted) => {
    const hit = m4Entries.find((e) => e.isDirectory() && e.name.toLowerCase() === wanted);
    return hit ? hit.name : null;
  };
  const clipDirName = findDir('clip');
  const thumbDirName = findDir('thmbnl');
  const mediaProEntry = m4Entries.find((e) => e.isFile() && e.name.toLowerCase() === 'mediapro.xml');
  const durations = readMediaPro(mediaProEntry ? path.join(m4Abs, mediaProEntry.name) : path.join(m4Abs, 'MEDIAPRO.XML'));

  const posters = new Map();
  if (thumbDirName) {
    for (const f of safeReaddir(path.join(m4Abs, thumbDirName))) {
      if (/\.(jpe?g)$/i.test(f.name) && !f.name.startsWith('.')) posters.set(f.name.toUpperCase(), f);
    }
  }

  if (!clipDirName) return;
  for (const f of safeReaddir(path.join(m4Abs, clipDirName))) {
    const ext = path.extname(f.name).toLowerCase();
    if (!VIDEO_EXT.has(ext) || f.name.startsWith('.')) continue;
    const base = f.name.replace(/\.[^.]+$/, '').toUpperCase();
    let poster = null;
    for (const suffix of ['T01.JPG', '.JPG']) {
      const cand = posters.get(base + suffix);
      if (cand) {
        poster = { rel: `${m4Rel}/${thumbDirName}/${cand.name}`, name: cand.name, bytes: cand.size, mtimeMs: cand.mtimeMs };
        break;
      }
    }
    node.fileCount++;
    pushVideo(node, {
      rel: `${m4Rel}/${clipDirName}/${f.name}`,
      name: f.name,
      bytes: f.size,
      mtimeMs: f.mtimeMs,
      durationSec: durations.get(f.name.toUpperCase()) ?? null,
      poster,
    });
  }
}

function readMediaPro(file) {
  const out = new Map();
  try {
    const xml = fs.readFileSync(file, 'utf8');
    const re = /<Material\b([^>]*)>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const uri = /uri="([^"]+)"/.exec(attrs)?.[1];
      if (!uri) continue;
      const dur = Number(/dur="(\d+(?:\.\d+)?)"/.exec(attrs)?.[1]);
      const fps = Number(/(?:^|\s)fps="([\d.]+)p?"/.exec(attrs)?.[1]);
      if (!Number.isFinite(dur) || !Number.isFinite(fps) || fps <= 0) continue;
      out.set(path.basename(uri).toUpperCase(), dur / fps);
    }
  } catch {
    /* no metadata is fine */
  }
  return out;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dir, e.name);
        const stat = safeStat(full);
        return stat ? { name: e.name, path: full, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeStat(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function pushPhoto(node, photo) {
  photo.thumb = thumbKey(photo.rel, photo.bytes, photo.mtimeMs);
  photo.width = null;
  photo.height = null;
  photo.date = null;
  node.photos.push(photo);
}

function pushVideo(node, video) {
  video.thumb = video.poster ? thumbKey(video.poster.rel, video.poster.bytes, video.poster.mtimeMs) : null;
  video.date = null;
  node.videos.push(video);
}

/** Turn a scanned node into the record the API exposes. */
function finalizeRecord(node, year) {
  const folderName = node.name;
  const parsed = parseFolderDate(folderName, year);
  const title = albumTitle(folderName, parsed.rest) || folderName;

  const photos = node.photos;
  const curatedPhotos = photos.filter((p) => p.tier === 'curated');
  const plainPhotos = photos.filter((p) => p.tier !== 'curated');

  // Chronological order is resolved later (after EXIF probing); keep folder order for now.
  return {
    id: node.rel,
    // depth 1 lives directly under the year folder, so it has no album parent
    parentId: node.depth <= 1 ? null : node.parentRel,
    year,
    folderName,
    title,
    depth: node.depth,
    folderDate: parsed.date ? parsed.date.toISOString() : null,
    folderPrecision: parsed.precision,
    // date fields are filled in by the indexer once probes are in
    startDate: null,
    endDate: null,
    datePrecision: null,
    photoCount: photos.length,
    curatedCount: curatedPhotos.length,
    derivedCurated: false,
    plainCount: plainPhotos.length,
    videoCount: node.videos.length,
    childrenCount: node.children.length,
    photos,
    videos: node.videos,
    fileCount: node.fileCount,
  };
}

export { finalizeRecord };
