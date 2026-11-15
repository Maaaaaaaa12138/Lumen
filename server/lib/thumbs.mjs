import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import {
  THUMB_DIR, THUMB_LONG_EDGE, THUMB_QUALITY, BLUR_LONG_EDGE, BLUR_QUALITY,
  THUMB_CONCURRENCY, CACHE_DIR,
} from '../config.mjs';

const PREVIEW_DIR = path.join(CACHE_DIR, 'previews');
const POSTER_DIR = path.join(CACHE_DIR, 'posters');
const PREVIEW_LONG_EDGE = 1920;
const PREVIEW_QUALITY = 82;

/**
 * libvips defaults to one thread per core, which is catastrophically slow when
 * several decodes run at once: 6 workers x 28 threads thrash instead of
 * parallelising (measured 500ms/img vs 46ms/img). One thread per decode, a few
 * decodes in flight, and no operation cache is the fast shape here.
 */
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY || 1));
sharp.cache(false);

/**
 * Generates and caches every derivative the site needs:
 *   - <key>_t.webp  800px grid thumbnail
 *   - <key>_b.webp   24px LQIP for blur-up
 *   - <key>_p.webp 1920px preview, only on demand for the lightbox
 *
 * Work happens in the background with a small worker pool. Files are written
 * atomically so a half-written thumbnail can never be served.
 */
export class ThumbService extends EventEmitter {
  constructor({ concurrency = THUMB_CONCURRENCY } = {}) {
    super();
    this.concurrency = concurrency;
    this.queues = { 4: [], 3: [], 2: [], 1: [] };
    this.queued = new Set();
    this.active = 0;
    this.total = 0;
    this.done = 0;
    this.failed = [];
    this.startedAt = Date.now();
    this.lastEmit = 0;
    this.stopped = false;
    this.ffmpeg = null;
    this.ffmpegChecked = false;
    this.previewQueue = new Map(); // key -> promise (dedupe in-flight previews)
    this.waiters = new Map(); // key -> resolve fn, for on-demand requests
    this.boosted = new Set(); // keys promoted to the front by an interactive request
    this.bytesWritten = 0;
    this.paused = 0; // >0 while a user-facing request (preview/original) is streaming
    this.pauseUntil = 0;
    this.userPaused = false; // explicit "pause while I browse" from the UI

    // Safety net: if a stream never reports close, the queue must still resume.
    this.tick = setInterval(() => {
      if (this.paused > 0 && Date.now() >= this.pauseUntil) this.paused = 0;
      if (!this.stopped) this.pump();
    }, 5000);
    this.tick.unref?.();
  }

  get isPaused() {
    return this.paused > 0 && Date.now() < this.pauseUntil;
  }

  setUserPaused(value) {
    this.userPaused = Boolean(value);
    if (!this.userPaused) this.pump();
    this.emitProgress(true);
  }

  /** Temporarily stop feeding the worker pool so interactive requests win the disk. */
  pause(ttl = 20000) {
    this.paused++;
    this.pauseUntil = Date.now() + ttl;
  }

  resume() {
    this.paused = Math.max(0, this.paused - 1);
    if (!this.isPaused) this.pump();
  }

  async init() {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    await fsp.mkdir(POSTER_DIR, { recursive: true });
  }

  thumbPath(key, kind = 't') {
    return path.join(THUMB_DIR, key.slice(0, 2), key.slice(2, 4), `${key}_${kind}.webp`);
  }

  previewPath(key) {
    return path.join(PREVIEW_DIR, key.slice(0, 2), key.slice(2, 4), `${key}_p.webp`);
  }

  has(key) {
    return fs.existsSync(this.thumbPath(key, 't')) && fs.existsSync(this.thumbPath(key, 'b'));
  }

  /** Queue a photo (or a video poster, which is just a jpeg on disk). */
  enqueue(job, priority = 1) {
    if (!job || !job.thumb) return;
    if (this.queued.has(job.thumb)) return;
    if (this.has(job.thumb)) return;
    this.queued.add(job.thumb);
    this.queues[priority].push(job);
    this.total++;
    this.pump();
  }

  enqueueAll(jobs) {
    for (const { job, priority } of jobs) this.enqueue(job, priority);
    this.emitProgress(true);
  }

  /**
   * Used by the HTTP layer: jump the queue, then wait for *this* key.
   * Everything still runs inside the worker pool, so a page full of missing
   * thumbnails cannot spawn hundreds of simultaneous decodes.
   */
  ensure(job) {
    if (!job || !job.thumb) return Promise.resolve(false);
    if (this.has(job.thumb)) return Promise.resolve(true);
    let waiter = this.waiters.get(job.thumb);
    if (!waiter) {
      waiter = {};
      waiter.promise = new Promise((resolve) => {
        waiter.resolve = resolve;
      });
      this.waiters.set(job.thumb, waiter);
    }
    const key = job.thumb;
    if (!this.queued.has(key)) {
      this.queued.add(key);
      this.total++;
    } else {
      // a background copy sits further down the queue: mark it stale
      this.boosted.add(key);
    }
    if (!this.queues[4].some((j) => j.thumb === key)) this.queues[4].unshift(job);
    this.pump();
    return waiter.promise;
  }

  settle(key, ok) {
    const waiter = this.waiters.get(key);
    if (waiter) {
      waiter.resolve(ok);
      this.waiters.delete(key);
    }
  }

  get pending() {
    return this.queues[4].length + this.queues[3].length + this.queues[2].length + this.queues[1].length;
  }

  pump() {
    if (this.stopped || this.isPaused) return;
    while (this.active < this.concurrency && this.pending > 0) {
      const job = this.next();
      if (!job) break;
      this.active++;
      this.process(job).finally(() => {
        this.active--;
        this.queued.delete(job.thumb);
        this.boosted.delete(job.thumb);
        this.pump();
        this.emitProgress();
      });
    }
    this.emitProgress();
  }

  /** Interactive queue first; when paused, only interactive work continues. */
  next() {
    if (this.queues[4].length) return this.queues[4].shift();
    if (this.userPaused) return null;
    for (const priority of [3, 2, 1]) {
      const queue = this.queues[priority];
      while (queue.length) {
        const candidate = queue.shift();
        if (priority === 3) return candidate;
        if (!this.boosted.has(candidate.thumb)) return candidate;
      }
    }
    return null;
  }

  async process(job) {
    if (this.has(job.thumb)) return; // another path (queue vs on-demand) got here first
    try {
      // One decode per image: the 24px LQIP and the average colour are derived
      // from the already-encoded 800px webp instead of re-reading the original.
      const big = await sharp(job.abs, { failOn: 'none', limitInputPixels: false, sequentialRead: true })
        .rotate()
        .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      const small = await sharp(big.data)
        .resize({ width: BLUR_LONG_EDGE, height: BLUR_LONG_EDGE, fit: 'inside' })
        .blur(0.6)
        .webp({ quality: BLUR_QUALITY, effort: 2 })
        .toBuffer();
      let color = null;
      try {
        const raw = await sharp(big.data).resize(1, 1, { fit: 'inside' }).removeAlpha().raw().toBuffer();
        if (raw.length >= 3) {
          color = `#${raw[0].toString(16).padStart(2, '0')}${raw[1].toString(16).padStart(2, '0')}${raw[2].toString(16).padStart(2, '0')}`;
        }
      } catch {
        /* colour is a nicety */
      }
      await writeAtomic(this.thumbPath(job.thumb, 't'), big.data);
      await writeAtomic(this.thumbPath(job.thumb, 'b'), small);
      this.bytesWritten += big.data.length + small.length;
      job.onDone?.({ width: big.info.width, height: big.info.height, color, bytes: big.data.length });
      this.done++;
      this.settle(job.thumb, true);
    } catch (err) {
      this.failed.push({ id: job.rel, error: String(err?.message || err) });
      this.emit('failed', { job, error: err });
      this.settle(job.thumb, false);
    }
  }

  async ensurePreview(photo) {
    const key = photo.thumb;
    const file = this.previewPath(key);
    if (fs.existsSync(file)) return file;
    if (this.previewQueue.has(key)) return this.previewQueue.get(key);
    const promise = (async () => {
      const img = sharp(photo.abs, { failOn: 'none', limitInputPixels: false }).rotate();
      const buf = await img
        .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: PREVIEW_QUALITY, effort: 4 })
        .toBuffer();
      await writeAtomic(file, buf);
      return file;
    })().finally(() => this.previewQueue.delete(key));
    this.previewQueue.set(key, promise);
    return promise;
  }

  /** ffmpeg is optional: Sony clips ship their own posters, others fall back. */
  async resolveFfmpeg() {
    if (this.ffmpegChecked) return this.ffmpeg;
    this.ffmpegChecked = true;
    const candidates = [];
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    try {
      const mod = await import('ffmpeg-static');
      if (mod?.default) candidates.push(mod.default);
    } catch {
      /* not installed */
    }
    candidates.push('ffmpeg');
    for (const cand of candidates) {
      if (await commandWorks(cand)) {
        this.ffmpeg = cand;
        break;
      }
    }
    return this.ffmpeg;
  }

  /** Extract a poster frame for a video that has none into `out`. */
  async makeVideoPoster(video, out) {
    const ffmpeg = await this.resolveFfmpeg();
    if (!ffmpeg) return null;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '1', '-i', video.abs,
      '-frames:v', '1', '-vf', 'scale=800:-2:flags=lanczos',
      '-q:v', '3', out,
    ];
    try {
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await run(ffmpeg, args, 90000);
      return fs.existsSync(out) ? out : null;
    } catch {
      return null;
    }
  }

  stats() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.done / Math.max(elapsed, 0.001);
    const remaining = Math.max(0, this.total - this.done - this.failed.length);
    return {
      total: this.total,
      done: this.done,
      failed: this.failed.length,
      pending: this.pending,
      active: this.active,
      rate: Number(rate.toFixed(2)),
      etaSec: rate > 0.2 ? Math.round(remaining / rate) : null,
      bytes: this.bytesWritten,
      paused: this.userPaused,
      complete: this.pending === 0 && this.active === 0,
    };
  }

  emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 400) return;
    this.lastEmit = now;
    this.emit('progress', this.stats());
  }

  stop() {
    this.stopped = true;
    this.queues = { 4: [], 3: [], 2: [], 1: [] };
  }
}

async function writeAtomic(file, buf) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

function commandWorks(command) {
  return new Promise((resolve) => {
    if (!command) return resolve(false);
    if (command.includes(path.sep) || command.includes('/')) {
      try {
        fs.accessSync(command, fs.constants.X_OK);
        return resolve(true);
      } catch {
        return resolve(false);
      }
    }
    execFile('where', [command], { windowsHide: true }, (err, stdout) => {
      resolve(!err && Boolean(stdout.trim()));
    });
  });
}
