import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl, type Video } from './api';

/**
 * Browsers can decode a frame far cheaper than a server-side ffmpeg pass, and
 * the local server supports range requests, so missing video posters are
 * captured client-side and pushed back into the thumbnail cache.
 *
 * Capture is strictly sequential: loading metadata for dozens of multi-GB DJI
 * clips at once would thrash the disk.
 */
async function capturePoster(videoId: string): Promise<string | null> {
  const el = document.createElement('video');
  el.preload = 'metadata';
  el.muted = true;
  el.playsInline = true;
  el.crossOrigin = 'anonymous';
  el.src = mediaUrl(videoId);

  const data = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      el.removeAttribute('src');
      el.load();
      resolve(value);
    };
    const draw = () => {
      try {
        const vw = el.videoWidth || 1280;
        const vh = el.videoHeight || 720;
        const w = 720;
        const h = Math.max(1, Math.round((vw ? w * (vh / vw) : 405)));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(el, 0, 0, w, h);
        finish(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        finish(null);
      }
    };
    el.addEventListener('loadeddata', () => {
      try {
        el.currentTime = Math.min(1.5, Math.max(0.1, (el.duration || 2) * 0.15));
      } catch {
        draw();
      }
    });
    el.addEventListener('seeked', draw);
    el.addEventListener('error', () => finish(null));
    window.setTimeout(() => {
      if (el.readyState >= 2) draw();
      else finish(null);
    }, 12000);
  });

  if (!data) return null;
  try {
    const res = await api.poster(videoId, data);
    return res?.thumb || null;
  } catch {
    return null;
  }
}

export function useVideoPosters(videos: Video[], limit = 48) {
  const [posters, setPosters] = useState<Record<string, string>>({});
  const busy = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const missing = videos.filter((v) => !v.thumb).slice(0, limit);
    if (!missing.length) return;
    const already = new Set(Object.keys(posters));
    const queue = missing.filter((v) => !already.has(v.id));
    if (!queue.length || busy.current) return;

    busy.current = true;
    (async () => {
      for (const v of queue) {
        if (cancelled.current) break;
        const key = await capturePoster(v.id);
        if (key) setPosters((prev) => ({ ...prev, [v.id]: key }));
        await new Promise((r) => setTimeout(r, 120));
      }
      busy.current = false;
    })();

    return () => {
      cancelled.current = true;
    };
  }, [videos, limit]);

  return posters;
}
