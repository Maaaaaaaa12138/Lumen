import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { api, mediaUrl, previewUrl } from './api';
import { fmtBytes, fmtDate, Icon, useToast } from './ui';

export type LensItem = {
  key: string;
  kind: 'photo' | 'video';
  id: string;
  thumb: string | null;
  name: string;
  date: string;
  bytes: number;
  w: number | null;
  h: number | null;
  duration?: number | null;
  albumTitle?: string;
  albumId?: string;
};

/** 100% is the current fit-to-window size; 800% is the ceiling, like Windows Photos. */
const MIN_SCALE = 1;
const MAX_SCALE = 8;

const clampScale = (n: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

type Point = { x: number; y: number };
type Size = { w: number; h: number };
type View = { scale: number; pan: Point };

type Gesture =
  | {
      kind: 'pan';
      id: number;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      moved: boolean;
    }
  | {
      kind: 'swipe';
      id: number;
      sx: number;
      sy: number;
      horizontal: boolean | null;
      lastX: number;
      lastT: number;
      vx: number;
    }
  | {
      kind: 'pinch';
      ids: [number, number];
      startDist: number;
      startScale: number;
      startPan: Point;
      startMid: Point;
    };

/** Largest box with the given aspect ratio that fits inside `box`. */
function containedSize(box: Size, aspect: number): Size {
  if (!box.w || !box.h) return { w: 0, h: 0 };
  const boxAspect = box.w / box.h;
  return aspect > boxAspect ? { w: box.w, h: box.w / aspect } : { w: box.h * aspect, h: box.h };
}

export function Lightbox({
  items, index, onIndex, onClose, isSelected, onToggleSelect, autoplay = false, showReveal = true,
  backdropPhotoId = null, onSetBackdrop,
}: {
  items: LensItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  isSelected: (id: string) => boolean;
  onToggleSelect: (id: string) => void;
  autoplay?: boolean;
  /** Explorer integration only makes sense on the machine running the server. */
  showReveal?: boolean;
  /** Which photo is currently used as the site-wide background, if any. */
  backdropPhotoId?: string | null;
  /** Make this photo the site-wide background; the caller reports success. */
  onSetBackdrop: (photoId: string) => Promise<void>;
}) {
  const item = items[index];
  const toast = useToast();
  const [info, setInfo] = useState(false);
  const [playing, setPlaying] = useState(autoplay);
  const [original, setOriginal] = useState(false);
  const [origSrc, setOrigSrc] = useState<{ id: string; url: string } | null>(null);
  const [origLoading, setOrigLoading] = useState(false);
  const [imgReady, setImgReady] = useState(false);
  const [settingBg, setSettingBg] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const [topH, setTopH] = useState(0);

  /* --------------------------------------------------------- zoom & pan */
  const [view, setView] = useState<View>({ scale: 1, pan: { x: 0, y: 0 } });
  const viewRef = useRef<View>(view);
  /** Fit box of the photo, in CSS pixels, measured from the stage's content box. */
  const [box, setBox] = useState<Size | null>(null);
  const boxRef = useRef<Size>({ w: 0, h: 0 });
  /** Natural pixel size of the bitmap currently on screen; corrects EXIF-rotated previews. */
  const [natural, setNatural] = useState<Size | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // pointer bookkeeping: one map for every contact, one active gesture
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const gestureRef = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const [swipeSnap, setSwipeSnap] = useState(false);
  const [enterDir, setEnterDir] = useState<0 | 1 | -1>(0);

  const ratio = item?.w && item?.h ? item.w / item.h : 1.5;
  const isVideo = item?.kind === 'video';

  const measureViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) {
      const w = typeof window === 'undefined' ? 0 : window.innerWidth;
      const h = typeof window === 'undefined' ? 0 : window.innerHeight;
      return { w, h, cx: w / 2, cy: h / 2 };
    }
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, []);

  const contentSize = useMemo(() => {
    if (!box) return { w: 0, h: 0 };
    const aspect = natural && natural.h > 0 ? natural.w / natural.h : ratio;
    // Never upscale the bitmap itself: small photos keep their natural size at
    // 100%, exactly like the old max-width/max-height <img> did.
    const limit = natural
      ? { w: Math.min(box.w, natural.w), h: Math.min(box.h, natural.h) }
      : box;
    return containedSize(limit, aspect);
  }, [box, natural, ratio]);

  const clampPan = useCallback((pan: Point, scale: number): Point => {
    const vp = measureViewport();
    const maxX = Math.max(0, (contentSize.w * scale - vp.w) / 2);
    const maxY = Math.max(0, (contentSize.h * scale - vp.h) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, pan.x)),
      y: Math.max(-maxY, Math.min(maxY, pan.y)),
    };
  }, [contentSize, measureViewport]);

  const applyView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  /** Zoom around a screen point, keeping the same pixel under the cursor (Windows-style). */
  const zoomTo = useCallback((nextScale: number, anchor?: Point) => {
    const cur = viewRef.current;
    const scale = clampScale(nextScale);
    if (Math.abs(scale - cur.scale) < 0.0005) return;
    const vp = measureViewport();
    const ax = anchor ? anchor.x : vp.cx;
    const ay = anchor ? anchor.y : vp.cy;
    const ux = (ax - vp.cx - cur.pan.x) / cur.scale;
    const uy = (ay - vp.cy - cur.pan.y) / cur.scale;
    applyView({
      scale,
      pan: clampPan({ x: ax - vp.cx - ux * scale, y: ay - vp.cy - uy * scale }, scale),
    });
  }, [applyView, clampPan, measureViewport]);

  const stepZoom = useCallback((dir: 1 | -1) => {
    const pct = Math.round(viewRef.current.scale * 100);
    const stepped = Math.round((pct + dir * 25) / 25) * 25;
    zoomTo(Math.min(800, Math.max(100, stepped)) / 100);
  }, [zoomTo]);

  const resetView = useCallback(() => {
    setSwipe(0);
    setSwipeSnap(false);
    applyView({ scale: 1, pan: { x: 0, y: 0 } });
  }, [applyView]);

  /** Fit the photo inside the padded stage, with the same visual margins as before. */
  const measureBox = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let w = ratio >= 1
      ? Math.min(vw * 0.88, vh * 0.78 * ratio)
      : Math.min(vh * 0.78 * ratio, vw * 0.78);
    w = Math.min(w, r.width);
    let h = w / ratio;
    if (h > r.height) {
      h = r.height;
      w = h * ratio;
    }
    if (Math.abs(w - boxRef.current.w) > 0.5 || Math.abs(h - boxRef.current.h) > 0.5) {
      boxRef.current = { w, h };
      setBox({ w, h });
    }
  }, [ratio]);

  // New slide: back to 100%, no pan, no half-finished swipe.
  useLayoutEffect(() => {
    const next = { scale: 1, pan: { x: 0, y: 0 } };
    viewRef.current = next;
    setView(next);
    setSwipe(0);
    setSwipeSnap(false);
    setDragging(false);
    // A cached photo can be complete before this effect runs; keep it visible
    // instead of waiting for a load event that already fired.
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setImgReady(true);
    } else {
      setNatural(null);
      setImgReady(false);
    }
    pointersRef.current.clear();
    gestureRef.current = null;
  }, [index, item?.key]);

  useLayoutEffect(() => {
    if (isVideo) return;
    const el = canvasRef.current;
    if (!el) return;
    measureBox();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measureBox()) : null;
    ro?.observe(el);
    window.addEventListener('resize', measureBox);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measureBox);
    };
  }, [isVideo, measureBox, item?.key]);

  // A wrapped title can make the header taller; the zoom bar follows it so the
  // two never overlap on narrow phones.
  useLayoutEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const measure = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      setTopH((prev) => (prev === h ? prev : h));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Keep the pan legal after the box or the bitmap's real aspect ratio changes.
  useEffect(() => {
    if (!box) return;
    const cur = viewRef.current;
    if (cur.scale <= 1) return;
    const pan = clampPan(cur.pan, cur.scale);
    if (pan.x !== cur.pan.x || pan.y !== cur.pan.y) applyView({ scale: cur.scale, pan });
  }, [box, natural, clampPan, applyView]);

  // Mouse wheel: native listener so preventDefault is allowed (React's onWheel is passive).
  useEffect(() => {
    if (isVideo) return;
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.cancelable) e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dy = e.deltaY * unit;
      if (!dy) return;
      const factor = Math.exp(-dy * 0.0018);
      zoomTo(viewRef.current.scale * factor, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isVideo, item?.key, zoomTo]);

  // Stop the browser from turning a horizontal drag into history navigation (mobile
  // back gesture) and from page-zooming while we handle a pinch ourselves.
  useEffect(() => {
    if (isVideo) return;
    const el = canvasRef.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    };
    const onMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
    };
  }, [isVideo, item?.key]);

  // The lightbox lives outside the hash router. A same-URL history entry absorbs
  // back/edge-swipe while it is open, then is removed again on close.
  useEffect(() => {
    const marker = '__lumenLightbox';
    const current = window.history.state;
    const base = current && typeof current === 'object' ? current : {};
    const guard = { ...base, [marker]: true } as Record<string, unknown>;
    window.history.pushState(guard, '', window.location.href);
    const onPop = () => {
      const state = window.history.state as Record<string, unknown> | null;
      if (!state || !state[marker]) window.history.pushState(guard, '', window.location.href);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      const state = window.history.state as Record<string, unknown> | null;
      if (state && state[marker]) window.history.back();
    };
  }, []);

  const go = useCallback(
    (delta: number, opts?: { dir?: 1 | -1 }) => {
      const next = index + delta;
      if (next < 0 || next >= items.length) return;
      setEnterDir(opts?.dir ?? 0);
      onIndex(next);
    },
    [index, items.length, onIndex],
  );

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= items.length || next === index) return;
      setEnterDir(0);
      onIndex(next);
    },
    [index, items.length, onIndex],
  );

  /** One click: use this photo as the background, with its album's own date/place. */
  const applyBackdrop = useCallback(async () => {
    if (!item || item.kind !== 'photo' || settingBg) return;
    setSettingBg(true);
    try {
      await onSetBackdrop(item.id);
    } catch {
      /* the caller shows the error toast */
    } finally {
      setSettingBg(false);
    }
  }, [item, settingBg, onSetBackdrop]);

  // load the untouched original on demand (preview stays on screen meanwhile)
  useEffect(() => {
    if (!item || item.kind !== 'photo' || !original) {
      setOrigSrc(null);
      setOrigLoading(false);
      return;
    }
    let alive = true;
    const url = mediaUrl(item.id);
    setOrigLoading(true);
    const probe = new Image();
    probe.decoding = 'async';
    probe.onload = () => {
      if (!alive) return;
      setOrigSrc({ id: item.id, url });
      setOrigLoading(false);
    };
    probe.onerror = () => {
      if (!alive) return;
      setOrigLoading(false);
      toast('原图加载失败，已保留预览图', 'close');
      setOriginal(false);
    };
    probe.src = url;
    return () => {
      alive = false;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [original, item?.id, item?.kind, toast]);

  // neighbour preloading keeps the whole experience feeling instant
  useEffect(() => {
    const urls: string[] = [];
    for (const d of [1, -1, 2]) {
      const n = items[index + d];
      if (n && n.kind === 'photo') urls.push(previewUrl(n.id));
    }
    const imgs = urls.map((u) => {
      const img = new Image();
      img.src = u;
      return img;
    });
    return () => {
      for (const img of imgs) img.src = '';
    };
  }, [index, items]);

  // autoplay
  useEffect(() => {
    if (!playing) return;
    const t = window.setTimeout(() => {
      if (index >= items.length - 1) {
        setEnterDir(0);
        onIndex(0);
      } else go(1);
    }, 3200);
    return () => window.clearTimeout(t);
  }, [playing, index, items.length, go, onIndex]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      );
      if (typing && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        if (viewRef.current.scale > 1.001) resetView();
        else onClose();
      } else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'f' || e.key === 'F') {
        if (item) onToggleSelect(item.id);
      } else if (e.key === 'i' || e.key === 'I') setInfo((v) => !v);
      else if (e.key === 'o' || e.key === 'O') {
        if (item?.kind === 'photo') setOriginal((v) => !v);
      } else if (e.key === 'b' || e.key === 'B') {
        void applyBackdrop();
      } else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        stepZoom(1);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        stepZoom(-1);
      } else if (e.key === '0') {
        e.preventDefault();
        resetView();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose, onToggleSelect, item, applyBackdrop, resetView, stepZoom]);

  // lock body scroll + centre the active filmstrip cell
  useEffect(() => {
    document.body.classList.add('no-scroll');
    return () => document.body.classList.remove('no-scroll');
  }, []);
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [index]);

  const selected = item ? isSelected(item.id) : false;
  const title = item?.albumTitle || '—';

  const thumbStrip = useMemo(() => items.slice(Math.max(0, index - 40), index + 41), [items, index]);

  /* -------------------------------------------------------- gestures */

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (pointersRef.current.size >= 2) return;

    if (pointersRef.current.size === 1) {
      // second contact: become a pinch, keeping whatever the first finger was doing
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [[idA, a], [idB, b]] = [...pointersRef.current.entries()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      gestureRef.current = {
        kind: 'pinch',
        ids: [idA, idB],
        startDist: dist,
        startScale: viewRef.current.scale,
        startPan: { ...viewRef.current.pan },
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      setSwipe(0);
      setSwipeSnap(false);
      setDragging(false);
    } else {
      const zoomed = viewRef.current.scale > 1.001;
      if (!zoomed && e.pointerType === 'mouse') return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (zoomed) {
        gestureRef.current = {
          kind: 'pan',
          id: e.pointerId,
          sx: e.clientX,
          sy: e.clientY,
          ox: viewRef.current.pan.x,
          oy: viewRef.current.pan.y,
          moved: false,
        };
        setDragging(true);
      } else {
        // at fit, a horizontal touch drag is a photo swipe, not a history gesture
        gestureRef.current = {
          kind: 'swipe',
          id: e.pointerId,
          sx: e.clientX,
          sy: e.clientY,
          horizontal: null,
          lastX: e.clientX,
          lastT: performance.now(),
          vx: 0,
        };
        setSwipeSnap(false);
        setSwipe(0);
      }
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers (tests) have no capture target */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gestureRef.current;
    if (!g) return;

    if (g.kind === 'pinch') {
      const a = pointersRef.current.get(g.ids[0]);
      const b = pointersRef.current.get(g.ids[1]);
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = clampScale(g.startScale * (dist / g.startDist));
      const vp = measureViewport();
      const ux = (g.startMid.x - vp.cx - g.startPan.x) / g.startScale;
      const uy = (g.startMid.y - vp.cy - g.startPan.y) / g.startScale;
      applyView({
        scale,
        pan: clampPan({ x: mid.x - vp.cx - ux * scale, y: mid.y - vp.cy - uy * scale }, scale),
      });
      return;
    }

    if (g.kind === 'pan') {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) > 3) g.moved = true;
      const cur = viewRef.current;
      applyView({ scale: cur.scale, pan: clampPan({ x: g.ox + dx, y: g.oy + dy }, cur.scale) });
      return;
    }

    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.horizontal === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      g.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!g.horizontal) {
        gestureRef.current = null;
        return;
      }
      setSwipeSnap(false);
    }
    if (!g.horizontal) return;
    const now = performance.now();
    const dt = now - g.lastT;
    if (dt > 0) {
      const inst = (e.clientX - g.lastX) / dt;
      g.vx = g.vx * 0.6 + inst * 0.4;
      g.lastX = e.clientX;
      g.lastT = now;
    }
    setSwipe(dx);
  };

  const finishGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.delete(e.pointerId)) return;
    const g = gestureRef.current;
    if (!g) return;

    if (g.kind === 'pinch') {
      if (pointersRef.current.size < 2) {
        gestureRef.current = null;
        setDragging(false);
      }
      return;
    }
    if (g.kind === 'pan') {
      gestureRef.current = null;
      setDragging(false);
      return;
    }

    gestureRef.current = null;
    if (g.horizontal) {
      const dx = e.clientX - g.sx;
      const vp = measureViewport();
      const far = Math.abs(dx) > Math.min(110, vp.w * 0.16);
      const flick = Math.abs(dx) > 26 && Math.abs(g.vx) > 0.45;
      const canNext = index < items.length - 1;
      const canPrev = index > 0;
      if ((far || flick) && dx < 0 && canNext) {
        setSwipe(0);
        setSwipeSnap(false);
        go(1, { dir: 1 });
        return;
      }
      if ((far || flick) && dx > 0 && canPrev) {
        setSwipe(0);
        setSwipeSnap(false);
        go(-1, { dir: -1 });
        return;
      }
    }
    // snap back
    setSwipeSnap(true);
    setSwipe(0);
  };

  const onPointerCancel = () => {
    pointersRef.current.clear();
    gestureRef.current = null;
    setDragging(false);
    setSwipeSnap(true);
    setSwipe(0);
  };

  /** Double-click toggles like Windows Photos: fit <-> zoomed in. */
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (viewRef.current.scale > 1.001) resetView();
    else zoomTo(2, { x: e.clientX, y: e.clientY });
  };

  const markLoaded = useCallback((el: HTMLImageElement | null) => {
    imgRef.current = el;
    if (!el || !el.complete || !el.naturalWidth) return;
    setNatural((prev) => (
      prev && prev.w === el.naturalWidth && prev.h === el.naturalHeight
        ? prev
        : { w: el.naturalWidth, h: el.naturalHeight }
    ));
    setImgReady(true);
  }, []);

  const onImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    if (el.naturalWidth && el.naturalHeight) {
      setNatural((prev) => (
        prev && prev.w === el.naturalWidth && prev.h === el.naturalHeight
          ? prev
          : { w: el.naturalWidth, h: el.naturalHeight }
      ));
    }
    setImgReady(true);
  }, []);

  if (!item) return null;

  const zoomed = view.scale > 1.001;
  const zoomPercent = Math.round(view.scale * 100);
  const sliderFill = Math.min(100, Math.max(0, ((zoomPercent - 100) / 700) * 100));
  const contentW = contentSize.w ? contentSize.w * view.scale : 0;
  const contentH = contentSize.h ? contentSize.h * view.scale : 0;
  const atStart = index === 0;
  const atEnd = index === items.length - 1;
  const swipeOffset =
    (swipe > 0 && atStart) || (swipe < 0 && atEnd) ? swipe * 0.35 : swipe;
  const imageSrc = origSrc && origSrc.id === item.id ? origSrc.url : previewUrl(item.id);
  const sliderStyle = { '--lb-fill': `${sliderFill}%` } as CSSProperties;
  const shellStyle = (topH > 0 ? { '--lb-top-h': `${topH}px` } : {}) as CSSProperties;

  return (
    <div className="lb" role="dialog" aria-modal="true" aria-label="照片查看器" style={shellStyle}>
      <div className="lb-top" ref={topRef}>
        <button className="lb-btn" onClick={onClose} aria-label="关闭">
          <Icon name="close" />
        </button>
        <div className="lb-info-title">
          <div className="t">{title}</div>
          <div className="s">
            {index + 1} / {items.length} · {fmtDate(item.date, true)}
          </div>
        </div>
        <div className="lb-tools">
          <button
            className={`lb-btn${playing ? ' on' : ''}`}
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? '暂停幻灯片' : '自动播放'}
            title="自动播放 (空格)"
          >
            <Icon name={playing ? 'pause' : 'play'} filled={!playing} />
          </button>
          <button
            className={`lb-btn${info ? ' on' : ''}`}
            onClick={() => setInfo((v) => !v)}
            aria-label="详细信息"
            title="详细信息 (I)"
          >
            <Icon name="info" />
          </button>
          <button
            className={`lb-btn heart${selected ? ' on' : ''}`}
            onClick={() => onToggleSelect(item.id)}
            aria-label={selected ? '取消收藏' : '收藏'}
            title="收藏 (F)"
          >
            <Icon name="heart" filled={selected} />
          </button>
          {!isVideo ? (
            <button
              className={`lb-btn text lb-bg${backdropPhotoId === item.id ? ' on' : ''}`}
              onClick={() => void applyBackdrop()}
              disabled={settingBg}
              aria-pressed={backdropPhotoId === item.id}
              title={backdropPhotoId === item.id ? '当前已是全站背景' : '设为全站背景 (B)'}
            >
              {settingBg ? (
                <span className="spinner" style={{ width: 13, height: 13, borderWidth: 1.4 }} />
              ) : (
                <Icon name="image" className="icon sm" />
              )}
              <span className="lb-bg-label">{backdropPhotoId === item.id ? '当前背景' : '设为背景'}</span>
            </button>
          ) : null}
          {!isVideo ? (
            <button
              className={`lb-btn text${original ? ' on' : ''}`}
              onClick={() => setOriginal((v) => !v)}
              title={original ? '改回预览图 (O)' : '查看未压缩原图 (O)'}
              aria-pressed={original}
            >
              {origLoading ? (
                <span className="spinner" style={{ width: 13, height: 13, borderWidth: 1.4 }} />
              ) : (
                <Icon name="zoom" className="icon sm" />
              )}
              原图
            </button>
          ) : null}
          <a className="lb-btn text" href={mediaUrl(item.id)} download={item.name} title="下载原图">
            <Icon name="down" className="icon sm" />
            下载
          </a>
          {!isVideo && showReveal ? (
            <button
              className="lb-btn"
              title="在资源管理器中显示"
              aria-label="在资源管理器中显示"
              onClick={() => {
                api.reveal(item.id).then(
                  () => toast('已在资源管理器中打开'),
                  (err: Error) => toast(err.message || '打开失败', 'close'),
                );
              }}
            >
              <Icon name="folder" />
            </button>
          ) : null}
        </div>
      </div>

      {!isVideo && !info ? (
        <div className="lb-zoombar" role="toolbar" aria-label="缩放">
          <button
            type="button"
            className="lb-zbtn"
            onClick={() => stepZoom(-1)}
            disabled={!zoomed}
            aria-label="缩小"
            title="缩小 (-)"
          >
            <Icon name="minus" />
          </button>
          <input
            className="lb-zslider"
            type="range"
            min={100}
            max={800}
            step={1}
            value={zoomPercent}
            onChange={(e) => zoomTo(Number(e.currentTarget.value) / 100)}
            onPointerUp={(e) => e.currentTarget.blur()}
            style={sliderStyle}
            aria-label="缩放比例"
            aria-valuetext={`${zoomPercent}%`}
          />
          <button
            type="button"
            className="lb-zbtn"
            onClick={() => stepZoom(1)}
            disabled={zoomPercent >= 800}
            aria-label="放大"
            title="放大 (+)"
          >
            <Icon name="plus" />
          </button>
          <span className="lb-zpct">{zoomPercent}%</span>
          <button
            type="button"
            className="lb-zfit"
            onClick={resetView}
            disabled={!zoomed && view.pan.x === 0 && view.pan.y === 0}
            aria-label="适应窗口"
            title="适应窗口 (0)"
          >
            <Icon name="fit" />
            <span className="lb-zfit-label">适应</span>
          </button>
        </div>
      ) : null}

      <div className={`lb-stage${isVideo ? '' : ' has-zoom'}`}>
        {!imgReady ? <div className="lb-ph">LOADING</div> : null}
        {isVideo ? (
          <div
            className="lb-frame"
            style={{ aspectRatio: String(ratio), width: `min(90vw, ${ratio >= 1 ? `calc(80vh * ${ratio})` : '80vw'})` }}
          >
            <video
              key={item.id}
              className="lb-video"
              style={{ width: '100%', height: '100%', maxHeight: 'none' }}
              src={mediaUrl(item.id)}
              poster={item.thumb ? `/thumb/${item.thumb}` : undefined}
              controls
              autoPlay
              playsInline
              onLoadedData={() => setImgReady(true)}
              onError={() => setImgReady(true)}
            />
          </div>
        ) : (
          <div
            ref={canvasRef}
            className={`lb-canvas${zoomed ? ' zoomed' : ''}${dragging ? ' dragging' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishGesture}
            onPointerCancel={onPointerCancel}
            onDoubleClick={onDoubleClick}
          >
            <div
              key={item.key}
              className={`lb-frame${enterDir === 1 ? ' from-right' : enterDir === -1 ? ' from-left' : ''}`}
              style={{
                width: box ? box.w : `min(${ratio >= 1 ? '88vw' : `calc(78vh * ${ratio})`}, ${ratio >= 1 ? `calc(78vh * ${ratio})` : '78vw'})`,
                height: box ? box.h : undefined,
                aspectRatio: box ? undefined : String(ratio),
                transform: swipe !== 0 ? `translate3d(${swipeOffset}px, 0, 0)` : undefined,
                transition: swipeSnap ? 'transform .28s cubic-bezier(.22,.61,.36,1)' : 'none',
              }}
            >
              {item.thumb ? (
                <img
                  src={`/thumb/${item.thumb}`}
                  alt=""
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    filter: 'blur(3px)',
                    transform: 'scale(1.02)',
                    opacity: imgReady ? 0 : 1,
                    transition: 'opacity .5s ease',
                    borderRadius: 6,
                  }}
                />
              ) : null}
              <img
                key={item.id}
                ref={markLoaded}
                className="lb-img"
                src={imageSrc}
                alt={item.name}
                style={{
                  opacity: imgReady ? 1 : 0,
                  transition: 'opacity .4s ease',
                  // Zoom by growing the layout box, not by transform: this makes
                  // Chrome sample the full-resolution bitmap instead of stretching
                  // a layer rasterized at the fit size (which looked soft at 400%+).
                  width: contentW || undefined,
                  height: contentH || undefined,
                  maxWidth: contentW ? 'none' : undefined,
                  maxHeight: contentH ? 'none' : undefined,
                  flex: 'none',
                  transform: `translate3d(${view.pan.x}px, ${view.pan.y}px, 0)`,
                  userSelect: 'none',
                  boxShadow: zoomed ? 'none' : undefined,
                }}
                draggable={false}
                onLoad={onImgLoad}
                onError={(e) => {
                  const el = e.currentTarget as HTMLImageElement;
                  if (item.thumb && !el.src.includes('/thumb/')) el.src = `/thumb/${item.thumb}`;
                  setImgReady(true);
                }}
              />
            </div>
          </div>
        )}
      </div>

      <button className="lb-nav prev" onClick={() => go(-1)} disabled={atStart} aria-label="上一张">
        <Icon name="left" />
      </button>
      <button className="lb-nav next" onClick={() => go(1)} disabled={atEnd} aria-label="下一张">
        <Icon name="right" />
      </button>

      <div className="lb-film">
        <div className="lb-film-strip" ref={stripRef}>
          {thumbStrip.map((it, i) => {
            const realIndex = Math.max(0, index - 40) + i;
            const active = realIndex === index;
            return (
              <button
                key={it.key}
                ref={active ? activeThumbRef : undefined}
                className={`lb-thumb${active ? ' active' : ''}`}
                onClick={() => goTo(realIndex)}
                aria-label={it.name}
              >
                {it.thumb ? <img src={`/thumb/${it.thumb}`} alt="" loading="lazy" /> : null}
              </button>
            );
          })}
        </div>
        <div className="lb-hint">
          <span>
            <kbd>←</kbd>
            <kbd>→</kbd> 切换
          </span>
          {!isVideo ? (
            <span>
              <kbd>滚轮</kbd> 缩放
            </span>
          ) : null}
          {!isVideo ? (
            <span>
              <kbd>双击</kbd> 放大
            </span>
          ) : null}
          <span>
            <kbd>F</kbd> 收藏
          </span>
          <span>
            <kbd>O</kbd> 原图
          </span>
          {!isVideo ? (
            <span>
              <kbd>B</kbd> 背景
            </span>
          ) : null}
          <span>
            <kbd>I</kbd> 信息
          </span>
          <span>
            <kbd>空格</kbd> 幻灯片
          </span>
          <span>
            <kbd>Esc</kbd> 复位/关闭
          </span>
        </div>
      </div>

      {info ? (
        <aside className="lb-drawer">
          <h4>Details</h4>
          <div className="lb-kv">
            <span className="k">文件名</span>
            <span className="v">{item.name}</span>
          </div>
          <div className="lb-kv">
            <span className="k">拍摄时间</span>
            <span className="v">{fmtDate(item.date, true)}</span>
          </div>
          {item.w && item.h ? (
            <div className="lb-kv">
              <span className="k">尺寸</span>
              <span className="v">
                {item.w} × {item.h}
              </span>
            </div>
          ) : null}
          <div className="lb-kv">
            <span className="k">大小</span>
            <span className="v">{fmtBytes(item.bytes)}</span>
          </div>
          {item.duration ? (
            <div className="lb-kv">
              <span className="k">时长</span>
              <span className="v">{Math.round(item.duration)}s</span>
            </div>
          ) : null}
          <div className="lb-kv">
            <span className="k">相册</span>
            <span className="v">{item.albumTitle || '—'}</span>
          </div>
          <div className="lb-kv">
            <span className="k">收藏</span>
            <span className="v">{selected ? '已收藏' : '未收藏'}</span>
          </div>
          <h4 style={{ marginTop: 26 }}>Actions</h4>
          <div style={{ display: 'grid', gap: 8 }}>
            {!isVideo ? (
              <button
                className="btn"
                onClick={() => void applyBackdrop()}
                disabled={settingBg}
                style={{ justifyContent: 'center' }}
              >
                {settingBg ? (
                  <span className="spinner" style={{ width: 14, height: 14 }} />
                ) : (
                  <Icon name="image" className="icon sm" />
                )}
                {backdropPhotoId === item.id ? '当前已是全站背景' : '设为全站背景'}
              </button>
            ) : null}
            {!isVideo ? (
              <button
                className="btn"
                onClick={() => setOriginal((v) => !v)}
                style={{ justifyContent: 'center' }}
              >
                <Icon name="zoom" className="icon sm" />
                {original ? '改回预览图' : '查看原图（原始像素）'}
              </button>
            ) : null}
            <a className="btn" href={mediaUrl(item.id)} target="_blank" rel="noreferrer" style={{ justifyContent: 'center' }}>
              <Icon name="external" className="icon sm" />
              新标签打开原图
            </a>
            <a className="btn" href={mediaUrl(item.id)} download={item.name} style={{ justifyContent: 'center' }}>
              <Icon name="down" className="icon sm" />
              下载原图
            </a>
            {showReveal ? (
              <button
                className="btn"
                onClick={() =>
                  api.reveal(item.id).then(
                    () => toast('已在资源管理器打开'),
                    (err: Error) => toast(err.message || '打开失败', 'close'),
                  )
                }
                style={{ justifyContent: 'center' }}
              >
                <Icon name="folder" className="icon sm" />
                在资源管理器中显示
              </button>
            ) : null}
          </div>
          <h4 style={{ marginTop: 26 }}>Path</h4>
          <div className="path">{item.id}</div>
        </aside>
      ) : null}
    </div>
  );
}
