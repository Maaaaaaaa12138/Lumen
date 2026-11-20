import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import chokidar from 'chokidar';
import sharp from 'sharp';
import {
  LIBRARY_ROOT, PORT, HOST, WEB_DIST, SELECTION_FILE, THUMB_DIR,
  IMAGE_EXT, VIDEO_EXT, IGNORE_DIR_NAMES, IGNORED_ROOT_NAMES, CACHE_DIR, POSTER_DIR,
  BACKDROP_DIR,
} from './config.mjs';
import { buildLibrary, summaryOf, detailOf, publicPhoto, resolveCovers, pickCovers } from './lib/library.mjs';
import { ThumbService } from './lib/thumbs.mjs';
import { decodeId, safeJoin, thumbKey } from './lib/util.mjs';
import {
  loadConfig as loadBackdropConfig, saveConfig as saveBackdropConfig, resolveBackdrop,
  pickCandidates, storeUpload, pruneUploads, uploadFileFor, readUploadMeta,
} from './lib/backdrop.mjs';

const app = express();
app.use(express.json({ limit: '2mb' }));

const thumbs = new ThumbService();
const sseClients = new Set();

/** Mutable server state. */
const state = {
  phase: 'booting', // booting | indexing | ready | error
  progress: { phase: 'boot', message: '启动中' },
  library: null,
  buildPromise: null,
  error: null,
  watcher: null,
  rebuildTimer: null,
  rebuildQueued: false,
  thumbJobs: new Map(), // key -> { abs, thumb, rel }
  selections: new Set(loadSelections()),
  lastLibraryEvent: 0,
};

function loadSelections() {
  try {
    const raw = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'));
    if (Array.isArray(raw?.ids)) return raw.ids;
  } catch {
    /* none yet */
  }
  return [];
}

let selectionSaveTimer = null;
function saveSelections() {
  clearTimeout(selectionSaveTimer);
  selectionSaveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const tmp = `${SELECTION_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), ids: [...state.selections] }, null, 0));
      await fsp.rename(tmp, SELECTION_FILE);
    } catch (err) {
      console.error('failed to persist selections', err);
    }
  }, 300);
}

// ---------------------------------------------------------------- backdrop --
/** Resolving a backdrop can decode a large original for its LQIP, so keep it. */
let backdropMemo = { key: null, value: null };
const backdropInflight = new Map();
const convertedViews = new Map();
const fillViews = new Map();

function backdropKey(config) {
  return [
    state.library?.generatedAt || 'none',
    config.updatedAt || '',
    config.source?.kind || 'auto',
    config.source?.photoId || config.source?.token || '',
    JSON.stringify(config.settings || {}),
  ].join('|');
}

async function currentBackdrop() {
  const config = loadBackdropConfig();
  const key = backdropKey(config);
  if (backdropMemo.key === key && backdropMemo.value) return backdropMemo.value;
  const running = backdropInflight.get(key);
  if (running) return running;
  const promise = resolveBackdrop({ library: state.library, config, thumbs })
    .then((value) => {
      backdropMemo = { key, value };
      return value;
    })
    .finally(() => backdropInflight.delete(key));
  backdropInflight.set(key, promise);
  return promise;
}

function invalidateBackdrop() {
  backdropMemo = { key: null, value: null };
}

/** Never leak server paths to the browser. */
function publicBackdrop(resolved) {
  if (!resolved) {
    return { image: null, title: '', date: '', place: '', source: null, customized: false };
  }
  return {
    image: resolved.image,
    title: resolved.title,
    date: resolved.date,
    place: resolved.place,
    source: resolved.source,
    customized: resolved.customized,
  };
}

/** Formats a browser cannot paint (HEIC/TIFF) get one cached, high-quality copy. */
async function ensureConvertedView(resolved) {
  const file = path.join(BACKDROP_DIR, `view-${resolved.version}.webp`);
  if (fs.existsSync(file)) return file;
  const running = convertedViews.get(file);
  if (running) return running;
  const promise = (async () => {
    const buf = await sharp(resolved.abs, { failOn: 'none', limitInputPixels: false })
      .rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 })
      .toBuffer();
    await fsp.mkdir(BACKDROP_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    return file;
  })().finally(() => convertedViews.delete(file));
  convertedViews.set(file, promise);
  return promise;
}

/**
 * The blurred underlay used around a contained photo. 720px is enough once it
 * is blurred and sits behind the image, and it is generated only once.
 */
async function ensureFillView(resolved) {
  const file = path.join(BACKDROP_DIR, `fill-${resolved.version}.webp`);
  if (fs.existsSync(file)) return file;
  const running = fillViews.get(file);
  if (running) return running;
  const promise = (async () => {
    const buf = await sharp(resolved.abs, { failOn: 'none', limitInputPixels: false })
      .rotate()
      .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 55, effort: 3 })
      .toBuffer();
    await fsp.mkdir(BACKDROP_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    return file;
  })().finally(() => fillViews.delete(file));
  fillViews.set(file, promise);
  return promise;
}

// ---------------------------------------------------------------- indexing --
function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function reindex(reason = 'startup') {
  if (state.buildPromise) {
    state.rebuildQueued = true;
    return state.buildPromise;
  }
  state.phase = state.library ? 'ready' : 'indexing';
  state.progress = { phase: 'scan', message: '扫描照片目录' };
  broadcast('progress', { phase: state.phase, progress: state.progress });

  state.buildPromise = (async () => {
    try {
      const library = await buildLibrary(LIBRARY_ROOT, {
        onProgress: (p) => {
          state.progress = p;
          broadcast('progress', { phase: p.phase, progress: p });
        },
      });
      const previous = state.library;
      state.library = library;
      state.phase = 'ready';
      state.error = null;

      // Queue missing thumbnails, most visible first.
      state.thumbJobs.clear();
      const jobs = [];
      const ordered = [...library.records].sort(
        (a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0),
      );
      const coverSet = new Set();
      for (const rec of ordered) for (const id of rec.coverIds) coverSet.add(id);

      for (const rec of ordered) {
        for (const p of rec.photos) {
          state.thumbJobs.set(p.thumb, p);
          const priority = coverSet.has(p.rel) ? 3 : p.tier === 'curated' ? 2 : 1;
          jobs.push({ job: p, priority });
        }
        for (const v of rec.videos) {
          if (v.poster) {
            state.thumbJobs.set(v.thumb, v.poster);
            jobs.push({ job: { abs: v.poster.abs, thumb: v.thumb, rel: v.poster.rel }, priority: coverSet.has(v.rel) ? 3 : 2 });
          }
        }
      }
      thumbs.enqueueAll(jobs);

      const changed = !previous || previous.generatedAt !== library.generatedAt;
      console.log(
        `[index] ${reason}: ${library.records.length} records, ${library.stats.photos} photos, ` +
        `${library.stats.videos} videos in ${library.buildMs}ms`,
      );
      if (changed) {
        broadcast('library', { generatedAt: library.generatedAt, stats: library.stats });
        void probeVideoPosters(library);
      }
    } catch (err) {
      state.phase = 'error';
      state.error = String(err?.stack || err);
      console.error('[index] failed', err);
      broadcast('error', { message: String(err?.message || err) });
    } finally {
      state.buildPromise = null;
      if (state.rebuildQueued) {
        state.rebuildQueued = false;
        setTimeout(() => void reindex('watch-queued'), 500);
      }
    }
  })();

  return state.buildPromise;
}

/**
 * Video-only albums have no photos to build a cover from at index time, because
 * posters are extracted afterwards. Recompute their mosaic once a poster lands.
 */
function refreshCovers(rec) {
  if (!rec) return;
  if (!rec.coverIds || rec.coverIds.length === 0) rec.coverIds = pickCovers(rec);
  rec.covers = resolveCovers(rec);
}

/**
 * Videos without a camera thumbnail get a frame extracted by ffmpeg.
 * The poster file name is derived from the video's identity, so the work is
 * done once and simply reused on later starts.
 */
async function probeVideoPosters(library) {
  const missing = [];
  for (const rec of library.records) {
    for (const v of rec.videos) {
      if (!v.poster) missing.push(v);
    }
  }
  if (!missing.length) return;

  const touched = new Set();
  const adopt = (v, key, file, bytes) => {
    v.thumb = key;
    v.poster = { abs: file, rel: `${v.rel}#poster`, bytes, mtimeMs: 1 };
    state.thumbJobs.set(key, { abs: file, thumb: key, rel: v.rel });
    thumbs.enqueue({ abs: file, thumb: key, rel: v.rel }, 2);
    touched.add(v.recordId);
  };

  // reuse anything extracted in an earlier session
  const pending = [];
  for (const v of missing) {
    const key = thumbKey(`${v.rel}#poster`, v.bytes, v.mtimeMs);
    const file = path.join(POSTER_DIR, `${key}.jpg`);
    if (fs.existsSync(file)) {
      try {
        adopt(v, key, file, fs.statSync(file).size);
        continue;
      } catch {
        /* fall through to re-extract */
      }
    }
    pending.push({ v, key, file });
  }
  if (!pending.length) {
    for (const id of touched) refreshCovers(library.recordById.get(id));
    if (touched.size) broadcast('library', { generatedAt: library.generatedAt, stats: library.stats, posters: 'cached' });
    return;
  }

  const ffmpeg = await thumbs.resolveFfmpeg();
  if (!ffmpeg) {
    console.log(`[video] ${pending.length} clips without posters (ffmpeg not available)`);
    return;
  }
  console.log(`[video] extracting poster frames for ${pending.length} clips`);
  let done = 0;
  for (const { v, key, file } of pending) {
    if (!fs.existsSync(v.abs)) continue;
    const frame = await thumbs.makeVideoPoster(v, file);
    done++;
    if (!frame) continue;
    try {
      adopt(v, key, frame, fs.statSync(frame).size);
    } catch {
      continue;
    }
    if (done % 10 === 0) {
      for (const id of touched) refreshCovers(library.recordById.get(id));
      touched.clear();
      broadcast('library', { generatedAt: library.generatedAt, stats: library.stats, posters: done });
    }
  }
  for (const id of touched) refreshCovers(library.recordById.get(id));
  console.log(`[video] poster extraction finished (${done} clips)`);
  broadcast('library', { generatedAt: library.generatedAt, stats: library.stats, posters: done });
}

// ------------------------------------------------------------------ watch --
function startWatcher() {
  const watchRoots = fs
    .readdirSync(LIBRARY_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name) && !IGNORED_ROOT_NAMES.has(e.name))
    .map((e) => path.join(LIBRARY_ROOT, e.name));

  const ignored = (p) => {
    const base = path.basename(p).toLowerCase();
    if (!base) return false;
    if (base.startsWith('._') || base === 'thumbs.db' || base === 'desktop.ini') return true;
    if (IGNORE_DIR_NAMES.has(base)) return true;
    const ext = path.extname(base);
    if (!ext) return false;
    return !IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext);
  };

  state.watcher = chokidar.watch(watchRoots, {
    ignored,
    ignoreInitial: true,
    depth: 5,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 900, pollInterval: 150 },
  });

  const schedule = (event, file) => {
    const ext = path.extname(file).toLowerCase();
    if (ext && !IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) return;
    console.log(`[watch] ${event} ${path.relative(LIBRARY_ROOT, file)}`);
    clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(() => void reindex('watch'), 2500);
  };

  state.watcher
    .on('add', (f) => schedule('add', f))
    .on('unlink', (f) => schedule('unlink', f))
    .on('change', (f) => schedule('change', f))
    .on('addDir', (f) => schedule('addDir', f))
    .on('unlinkDir', (f) => schedule('unlinkDir', f))
    .on('error', (err) => console.error('[watch] error', err));
}

// ------------------------------------------------------------------ routes --
app.get('/api/status', (req, res) => {
  res.json({
    phase: state.phase,
    progress: state.progress,
    error: state.error,
    library: state.library ? { generatedAt: state.library.generatedAt, stats: state.library.stats } : null,
    thumbs: thumbs.stats(),
  });
});

app.get('/api/library', (req, res) => {
  if (!state.library) {
    return res.status(202).json({ phase: state.phase, progress: state.progress, error: state.error });
  }
  const lib = state.library;
  res.set('Cache-Control', 'no-cache');
  res.json({
    phase: state.phase === 'ready' ? 'ready' : 'indexing',
    root: lib.root,
    localClient: isLocalClient(req),
    generatedAt: lib.generatedAt,
    stats: lib.stats,
    years: lib.years,
    timeline: lib.timeline,
    featured: lib.featured.map((id) => {
      const hit = lib.photoIndex.get(id);
      return hit ? { ...publicPhoto(hit.photo), albumId: hit.recordId } : null;
    }).filter(Boolean),
    records: lib.records.map(summaryOf),
    selections: [...state.selections],
    thumbs: thumbs.stats(),
  });
});

app.get('/api/album', (req, res) => {
  const lib = state.library;
  if (!lib) return res.status(202).json({ phase: state.phase, progress: state.progress });
  const id = String(req.query.id || '');
  const rec = lib.recordById.get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json({ album: detailOf(rec), thumbs: thumbs.stats() });
});

/* ------------------------------------------------------------- backdrop API */

app.get('/api/backdrop', async (req, res) => {
  try {
    const resolved = await currentBackdrop();
    res.set('Cache-Control', 'no-store');
    res.json(publicBackdrop(resolved));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** Wide photos from recent albums, for the "选择一张照片" grid. */
app.get('/api/backdrop/candidates', (req, res) => {
  if (!state.library) return res.status(202).json({ phase: state.phase, photos: [] });
  res.set('Cache-Control', 'no-store');
  res.json({ photos: pickCandidates(state.library, 120) });
});

/**
 * Switch the background, or just edit the text shown on top of it.
 * Everything is optional: { photoId } | { uploadToken } | { title, date, place }.
 */
app.post('/api/backdrop', async (req, res) => {
  const body = req.body || {};
  try {
    if (body.reset) {
      await saveBackdropConfig({ version: 1, source: null, settings: {} });
      invalidateBackdrop();
      await pruneUploads();
      return res.json(publicBackdrop(await currentBackdrop()));
    }

    const current = loadBackdropConfig();
    let source = current.source;
    if (typeof body.photoId === 'string') {
      if (!state.library?.photoIndex.has(body.photoId)) {
        return res.status(404).json({ error: '这张照片不在照片库里了' });
      }
      source = { kind: 'photo', photoId: body.photoId };
    } else if (typeof body.uploadToken === 'string') {
      if (!readUploadMeta(body.uploadToken) || !uploadFileFor(body.uploadToken)) {
        return res.status(400).json({ error: '上传已失效，请重新选择图片' });
      }
      source = { kind: 'upload', token: body.uploadToken };
    }

    const settings = { ...current.settings };
    for (const key of ['title', 'date', 'place']) {
      if (typeof body[key] !== 'string') continue;
      const value = body[key].trim().slice(0, 80);
      if (value) settings[key] = value;
      else delete settings[key];
    }

    await saveBackdropConfig({ version: 1, source, settings });
    invalidateBackdrop();
    await pruneUploads(source?.kind === 'upload' ? source.token : null);
    res.json(publicBackdrop(await currentBackdrop()));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** Upload an original from the device (raw body, not multipart: no new deps). */
app.post('/api/backdrop/upload', express.raw({ type: () => true, limit: '80mb' }), async (req, res) => {
  try {
    const info = await storeUpload(req.body, String(req.query.name || ''));
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

/** The untouched original bytes (or one cached copy for formats browsers can't read). */
app.get('/backdrop/orig', async (req, res) => {
  let resolved;
  try {
    resolved = await currentBackdrop();
  } catch {
    return res.status(500).end();
  }
  if (!resolved?.abs || !fs.existsSync(resolved.abs)) return res.status(404).end();
  // An immutable URL must not serve a different source if the backdrop changed
  // while this request was in flight.
  if (req.query.v && String(req.query.v) !== resolved.version) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).end();
  }

  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  // A 30 MB original should win the disk over the thumbnail queue.
  thumbs.pause();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    thumbs.resume();
  };
  res.on('close', release);
  res.on('finish', release);

  try {
    if (resolved.direct) {
      res.type(mimeFor(resolved.abs));
      const stream = fs.createReadStream(resolved.abs);
      stream.on('error', release);
      stream.pipe(res);
      return;
    }
    const view = await ensureConvertedView(resolved);
    res.type('image/webp');
    const stream = fs.createReadStream(view);
    stream.on('error', release);
    stream.pipe(res);
  } catch (err) {
    release();
    console.warn('[backdrop] failed to serve', String(err?.message || err).slice(0, 120));
    res.status(500).end();
  }
});

/** Preview an upload that has not been saved as the background yet. */
app.get('/backdrop/upload/:token', (req, res) => {
  const file = uploadFileFor(String(req.params.token || ''));
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(mimeFor(file.abs));
  fs.createReadStream(file.abs).pipe(res);
});

/** The soft blurred underlay around the contained photo. */
app.get('/backdrop/fill', async (req, res) => {
  let resolved;
  try {
    resolved = await currentBackdrop();
  } catch {
    return res.status(500).end();
  }
  if (!resolved?.abs) return res.status(404).end();
  if (req.query.v && String(req.query.v) !== resolved.version) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).end();
  }

  thumbs.pause();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    thumbs.resume();
  };
  res.on('close', release);
  res.on('finish', release);

  try {
    const file = await ensureFillView(resolved);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/webp');
    const stream = fs.createReadStream(file);
    stream.on('error', release);
    stream.pipe(res);
  } catch (err) {
    release();
    console.warn('[backdrop] failed to build fill', String(err?.message || err).slice(0, 120));
    res.status(500).end();
  }
});

/** Flat chronological stream used by the "全部照片" view. */
app.get('/api/photos', (req, res) => {
  const lib = state.library;
  if (!lib) return res.status(202).json({ phase: state.phase, progress: state.progress });
  // The plain stream omits the out/ exports: every one duplicates a jpg/ frame.
  // Collection records may still hold their own media (depth folding), so they
  // are included too; skipping them silently dropped real photos like 卧龙堂.
  if (!lib.flatPhotos) {
    const flat = [];
    for (const rec of lib.records) {
      if (rec.sensitive) continue;
      for (const p of rec.photos) {
        if (p.tier === 'curated') continue;
        flat.push({ p, recordId: rec.id });
      }
    }
    flat.sort((a, b) => new Date(b.p.date) - new Date(a.p.date));
    lib.flatPhotos = flat;
  }
  // Only the files the user kept (out/, 官方返图/, 精品放这里, …); the automatic
  // 推荐 previews are deliberately never part of the 精选 stream.
  if (!lib.flatCurated) {
    const flat = [];
    for (const rec of lib.records) {
      if (rec.sensitive) continue;
      for (const p of rec.curatedPhotos) flat.push({ p, recordId: rec.id });
    }
    flat.sort((a, b) => new Date(b.p.date) - new Date(a.p.date));
    lib.flatCurated = flat;
  }
  const year = req.query.year ? Number(req.query.year) : null;
  const curatedOnly = req.query.curated === '1' || req.query.curated === 'true';
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 120));
  const inYear = (x) => !year || Number(x.p.date.slice(0, 4)) === year;
  const allPool = year ? lib.flatPhotos.filter(inYear) : lib.flatPhotos;
  const curatedPool = year ? lib.flatCurated.filter(inYear) : lib.flatCurated;
  const pool = curatedOnly ? curatedPool : allPool;

  const page = pool.slice(offset, offset + limit).map(({ p, recordId }) => {
    const rec = lib.recordById.get(recordId);
    return { ...publicPhoto(p), albumId: recordId, albumTitle: rec?.title || '' };
  });
  res.json({
    total: pool.length,
    offset,
    limit,
    photos: page,
    counts: { all: allPool.length, curated: curatedPool.length },
  });
});

app.get('/api/search', (req, res) => {
  const lib = state.library;
  if (!lib) return res.status(202).json({ phase: state.phase });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 1) return res.json({ albums: [], photos: [] });
  const albums = lib.records
    .filter((r) => {
      const hay = `${r.title} ${r.folderName} ${r.id} ${r.dateLabel || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, 24)
    .map(summaryOf);
  const photos = [];
  for (const [rel, hit] of lib.photoIndex) {
    if (photos.length >= 300) break;
    if (rel.toLowerCase().includes(q)) photos.push({ ...publicPhoto(hit.photo), albumId: hit.recordId });
  }
  photos.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ albums, photos: photos.slice(0, 120) });
});

app.get('/api/selections', (req, res) => {
  res.json({ ids: [...state.selections] });
});

/** Let the UI pause background thumbnail generation while browsing. */
app.post('/api/thumbs/pause', (req, res) => {
  const paused = req.body?.paused;
  thumbs.setUserPaused(typeof paused === 'boolean' ? paused : !thumbs.userPaused);
  const stats = thumbs.stats();
  broadcast('thumbs', stats);
  res.json({ ok: true, paused: stats.paused, stats });
});

/** Resolve a list of photo ids (used by the favourites view and exports). */
app.post('/api/photos/resolve', (req, res) => {
  const lib = state.library;
  if (!lib) return res.status(202).json({ phase: state.phase });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 4000) : [];
  const photos = [];
  const missing = [];
  for (const id of ids) {
    const hit = lib.photoIndex.get(id);
    if (!hit) {
      missing.push(id);
      continue;
    }
    const rec = lib.recordById.get(hit.recordId);
    photos.push({ ...publicPhoto(hit.photo), albumId: hit.recordId, albumTitle: rec?.title || '' });
  }
  photos.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ photos, missing });
});

app.post('/api/selections', (req, res) => {
  const body = req.body || {};
  if (body.clear) {
    state.selections.clear();
  } else if (Array.isArray(body.ids)) {
    const on = body.on !== false;
    for (const id of body.ids) {
      if (typeof id !== 'string') continue;
      if (on) state.selections.add(id);
      else state.selections.delete(id);
    }
  } else if (typeof body.id === 'string') {
    if (body.on === false) state.selections.delete(body.id);
    else state.selections.add(body.id);
  } else {
    return res.status(400).json({ error: 'bad request' });
  }
  saveSelections();
  res.json({ ok: true, count: state.selections.size, ids: [...state.selections] });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ phase: state.phase, thumbs: thumbs.stats() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/thumb/:key', async (req, res) => {
  const key = String(req.params.key || '').replace(/[^a-f0-9]/gi, '');
  if (key.length !== 24) return res.status(400).end();
  const file = path.join(THUMB_DIR, key.slice(0, 2), key.slice(2, 4), `${key}_t.webp`);
  if (!fs.existsSync(file)) {
    const job = state.thumbJobs.get(key);
    if (!job) return res.status(404).end();
    const ok = await thumbs.ensure({ ...job, thumb: key });
    if (!ok || !fs.existsSync(file)) return res.status(404).end();
  }
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/webp');
  fs.createReadStream(file).pipe(res);
});

app.get('/blur/:key', async (req, res) => {
  const key = String(req.params.key || '').replace(/[^a-f0-9]/gi, '');
  if (key.length !== 24) return res.status(400).end();
  const big = path.join(THUMB_DIR, key.slice(0, 2), key.slice(2, 4), `${key}_t.webp`);
  const file = path.join(THUMB_DIR, key.slice(0, 2), key.slice(2, 4), `${key}_b.webp`);
  if (!fs.existsSync(file)) {
    if (!fs.existsSync(big)) {
      const job = state.thumbJobs.get(key);
      if (!job) return res.status(404).end();
      const ok = await thumbs.ensure({ ...job, thumb: key });
      if (!ok) return res.status(404).end();
    }
  }
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/webp');
  fs.createReadStream(file).pipe(res);
});

/** 1920px preview generated on first view (interactive: pauses background thumbs). */
app.get('/preview', async (req, res) => {
  const lib = state.library;
  if (!lib) return res.status(202).end();
  const rel = decodeId(req.query.id || '');
  const hit = rel ? lib.photoIndex.get(rel) : null;
  if (!hit) return res.status(404).end();
  thumbs.pause();
  try {
    const file = await thumbs.ensurePreview(hit.photo);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/webp');
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    stream.on('close', () => thumbs.resume());
    stream.on('error', () => {
      thumbs.resume();
      res.destroy();
    });
    return;
  } catch {
    thumbs.resume();
    res.status(500).end();
  }
});

/** Original bytes (photos) or a range-enabled video stream. */
app.get('/media', (req, res) => {
  const rel = decodeId(req.query.id || '');
  const abs = rel ? safeJoin(LIBRARY_ROOT, rel) : null;
  if (!abs) return res.status(400).end();
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return res.status(404).end();
  }
  if (!stat.isFile()) return res.status(404).end();

  const type = mimeFor(abs);
  const range = req.headers.range;
  res.set('Accept-Ranges', 'bytes');
  res.type(type);

  // streaming an original from the same disk should not fight the thumbnail queue
  thumbs.pause();
  let resumed = false;
  const release = () => {
    if (resumed) return;
    resumed = true;
    thumbs.resume();
  };
  res.on('close', release);
  res.on('finish', release);

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start >= stat.size) {
        res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      const realEnd = Math.min(end, stat.size - 1);
      res.status(206).set({
        'Content-Range': `bytes ${start}-${realEnd}/${stat.size}`,
        'Content-Length': String(realEnd - start + 1),
      });
      const stream = fs.createReadStream(abs, { start, end: realEnd });
      stream.on('error', release);
      stream.pipe(res);
      return;
    }
  }
  res.set('Content-Length', String(stat.size));
  res.set('Cache-Control', 'private, max-age=300');
  const stream = fs.createReadStream(abs);
  stream.on('error', release);
  stream.pipe(res);
});

/** Browser-captured poster frame for a clip that ships without one. */
let lastLibBroadcast = 0;
app.post('/api/poster', async (req, res) => {
  const lib = state.library;
  if (!lib) return res.status(202).json({ ok: false });
  const id = typeof req.body?.id === 'string' ? req.body.id : null;
  const data = typeof req.body?.data === 'string' ? req.body.data : null;
  if (!id || !data) return res.status(400).json({ ok: false });
  const video = lib.videoIndex?.get(id);
  if (!video) return res.status(404).json({ ok: false });
  if (video.thumb) return res.json({ ok: true, thumb: video.thumb });
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return res.status(400).json({ ok: false });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 1500 || buf.length > 5_000_000) return res.status(400).json({ ok: false });
  const key = thumbKey(`${id}#poster`, buf.length, 1);
  const file = path.join(POSTER_DIR, `${key}.jpg`);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);
  } catch {
    return res.status(500).json({ ok: false });
  }
  video.thumb = key;
  video.poster = { abs: file, rel: `${id}#poster`, bytes: buf.length, mtimeMs: 1 };
  state.thumbJobs.set(key, { abs: file, thumb: key, rel: id });
  thumbs.enqueue({ abs: file, thumb: key, rel: id }, 3);
  const rec = lib.recordById.get(video.recordId);
  if (rec) refreshCovers(rec);
  const now = Date.now();
  if (now - lastLibBroadcast > 6000) {
    lastLibBroadcast = now;
    broadcast('library', { generatedAt: lib.generatedAt, stats: lib.stats, poster: key });
  }
  res.json({ ok: true, thumb: key });
});

/**
 * Reveal a photo (or open an album folder) in Explorer.
 * Allowed for this machine only: a phone on the LAN must not pop windows here.
 */
app.post('/api/reveal', (req, res) => {
  if (!isLocalClient(req)) {
    return res.status(403).json({ ok: false, error: '只能在本机打开（远程设备请用「下载原图」）' });
  }
  const rel = typeof req.body?.id === 'string' ? req.body.id : null;
  const abs = rel ? safeJoin(LIBRARY_ROOT, rel) : null;
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ ok: false, error: '文件不存在' });
  try {
    const stat = fs.statSync(abs);
    // /select, opens the parent with the file highlighted; a folder is opened directly.
    // windowsVerbatimArguments keeps Explorer's odd /select,<path> syntax intact,
    // including paths that contain spaces (e.g. "...\8寸\不带字\8cun .JPG").
    const arg = stat.isDirectory() ? `"${abs}"` : `/select,"${abs}"`;
    spawn('explorer.exe', [arg], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    }).unref();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, phase: state.phase, records: state.library?.records.length ?? 0 });
});

// static frontend
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api|thumb|blur|media|preview|backdrop).*/, (req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>my-gallery</title>` +
      `<body style="font-family:system-ui;background:#111;color:#eee;padding:40px">` +
      `<h1>前端尚未构建</h1><p>运行 <code>npm run build</code> 后再刷新，或使用 <code>npm run dev</code> 开发模式。</p>` +
      `<p>当前状态: ${state.phase} / ${state.progress?.phase ?? ''}</p></body>`,
    );
  });
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  };
  return map[ext] || 'application/octet-stream';
}

// --------------------------------------------------------------- lifecycle --
thumbs.on('progress', (stats) => {
  if (stats.done % 3 !== 0 && !stats.complete) return;
  broadcast('thumbs', stats);
});
thumbs.on('failed', ({ job, error }) => {
  console.warn('[thumb] failed', job?.rel, String(error?.message || error).slice(0, 120));
});

/** Every non-loopback IPv4 address, so the console can show real LAN URLs. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

/** Addresses that belong to this machine: loopback plus every local interface. */
const SELF_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', ...lanAddresses().map((a) => a.address)]);
for (const addr of [...SELF_ADDRESSES]) {
  if (addr.includes('.') && !addr.startsWith('::')) SELF_ADDRESSES.add(`::ffff:${addr}`);
}

/**
 * True when the request comes from this computer. Opening the site at
 * http://192.168.x.x:8787 on the desktop is still "local" - the remote address
 * is one of our own interface addresses, not the phone's.
 */
function isLocalClient(req) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!remote) return false;
  if (remote === '127.0.0.1' || remote === '::1') return true;
  return SELF_ADDRESSES.has(remote);
}

function printBanner() {
  const lines = ['', `  ▸ my-gallery   http://127.0.0.1:${PORT}`];
  if (HOST === '0.0.0.0') {
    for (const { name, address } of lanAddresses()) {
      lines.push(`  ▸ LAN (${name})  http://${address}:${PORT}`);
    }
  }
  lines.push(`  ▸ library      ${LIBRARY_ROOT}`);
  lines.push(`  ▸ bind         ${HOST}:${PORT}`, '');
  console.log(lines.join('\n'));
}

async function main() {
  await thumbs.init();
  // Clean up uploads that were previewed but never saved as the background.
  try {
    const config = loadBackdropConfig();
    await pruneUploads(config.source?.kind === 'upload' ? config.source.token : null);
  } catch {
    /* cache housekeeping is best-effort */
  }
  const server = app.listen(PORT, HOST, printBanner);
  server.on('error', (err) => {
    console.error('[server] listen failed', err);
    process.exitCode = 1;
  });

  await reindex('startup');
  startWatcher();

  if (process.env.OPEN_BROWSER === '1') {
    const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
    setTimeout(() => {
      try {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch {
        /* the browser is a convenience */
      }
    }, 1500);
  }

  const shutdown = async () => {
    console.log('\n[server] shutting down');
    thumbs.stop();
    clearTimeout(state.rebuildTimer);
    try {
      await state.watcher?.close();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
