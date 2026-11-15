import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

/* ------------------------------------------------------------------ icons */

const ICONS: Record<string, string> = {
  heart: 'M12 20.4s-7.2-4.5-9-9.1C1.7 7.6 3.4 4.5 6.6 4.5c2 0 3.4 1.1 4.2 2.3h2.4c.8-1.2 2.2-2.3 4.2-2.3 3.2 0 4.9 3.1 3.6 6.8-1.8 4.6-9 9.1-9 9.1Z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  close: 'M18 6 6 18M6 6l12 12',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  down: 'M12 5v14M5 12l7 7 7-7',
  play: 'M8 5.5v13l11-6.5-11-6.5Z',
  pause: 'M9 5v14M15 5v14',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.6v.2',
  folder: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5Z',
  image: 'M3.5 5.5h17v13h-17v-13ZM3.5 15l4.5-4.5 4 4 2.5-2.5 5.5 5.5M15.5 9.2a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z',
  video: 'M3.5 7.5h11v9h-11v-9ZM14.5 11l6-3v8l-6-3',
  grid: 'M4 4h7v7H4V4ZM13 4h7v7h-7V4ZM4 13h7v7H4v-7ZM13 13h7v7h-7v-7Z',
  layers: 'M12 3 3 7.5 12 12l9-4.5L12 3ZM3 12.5 12 17l9-4.5M3 17 12 21.5 21 17',
  film: 'M3.5 4.5h17v15h-17v-15ZM8 4.5v15M16 4.5v15M3.5 9.5h4.5M3.5 14.5h4.5M16 9.5h4.5M16 14.5h4.5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',
  sparkle: 'M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6L4.5 10.8 10.2 9 12 3.5ZM18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  plus: 'M12 5v14M5 12h14',
  zoom: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM16 16l4.5 4.5M8.5 11h5M11 8.5v5',
  trash: 'M4 7h16M9.5 7V5h5v2M6 7l1 13h10l1-13',
  copy: 'M9 9h10v11H9V9ZM5 15V4h10',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 14v5.5H4.5V6H10',
  slideshow: 'M4 5.5h16v11H4v-11ZM9.5 20.5h5M12 16.5v4M9.5 9l5 2.5-5 2.5V9Z',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  calendar: 'M4 6.5h16v14H4v-14ZM4 10.5h16M8.5 3.5v4M15.5 3.5v4',
  pin: 'M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
};

export function Icon({ name, className = 'icon', filled }: { name: string; className?: string; filled?: boolean }) {
  const d = ICONS[name] || '';
  return (
    <svg className={`${className}${filled ? ' fill' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/* ---------------------------------------------------------------- formats */

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

const MONTHS_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

export function fmtDate(iso: string | null, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  return withTime ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
}

export function fmtWeekday(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

export function fmtMonthCN(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${MONTHS_CN[d.getMonth()]} 月`;
}

export function fmtRange(start: string | null, end: string | null): string {
  if (!start) return '时间未知';
  if (!end) return fmtDate(start);
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return fmtDate(start);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay) return `${fmtDate(start)} ${fmtWeekday(start)}`;
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${fmtDate(start)} – ${String(b.getMonth() + 1).padStart(2, '0')}.${String(b.getDate()).padStart(2, '0')}`;
  }
  if (a.getFullYear() === b.getFullYear()) {
    return `${fmtDate(start)} – ${fmtDate(end)}`;
  }
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

export function fmtDuration(sec: number | null): string {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/* ------------------------------------------------------------------ hooks */

/** Adds .in when the element scrolls into view (once). */
export function useReveal<T extends HTMLElement>(delay = 0) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('in');
            io.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.02 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const style = useMemo(() => ({ '--d': `${delay}ms` } as React.CSSProperties), [delay]);
  return { ref, style };
}

export function Reveal({
  children, delay = 0, className = '',
}: {
  children: React.ReactNode; delay?: number; className?: string;
}) {
  const { ref, style } = useReveal<HTMLDivElement>(delay);
  return (
    <div ref={ref} className={`reveal ${className}`} style={style}>
      {children}
    </div>
  );
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function useCountUp(target: number, duration = 1200): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target) || target <= 0) {
      setValue(target || 0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/** Tracks which element id is currently in view (for the year pills). */
export function useActiveSection(ids: string[], offset = 120): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (!ids.length) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        let current = ids[0];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= offset) current = id;
        }
        setActive(current);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ids.join('|'), offset]);
  return active;
}

/* ------------------------------------------------------------------ toast */

type ToastItem = { id: number; msg: string; icon?: string };
const ToastCtx = createContext<(msg: string, icon?: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((msg: string, icon = 'check') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div className="toast" key={t.id}>
            <Icon name={t.icon || 'check'} className="icon sm" />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------- image tile */

/**
 * Images served from cache can finish loading before React attaches onLoad,
 * which left tiles stuck on their blur placeholder. The ref callback checks
 * `complete` on mount so already-cached images reveal immediately.
 */
export function LoadedImg({
  src, alt, className = 'main', eager, ratio, style, onError,
}: {
  src: string; alt: string; className?: string; eager?: boolean;
  ratio?: string; style?: React.CSSProperties; onError?: () => void;
}) {
  const mark = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) el.classList.add('loaded');
  }, []);
  return (
    <img
      ref={mark}
      className={className}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      style={ratio ? { ...style, aspectRatio: ratio } : style}
      onLoad={(e) => e.currentTarget.classList.add('loaded')}
      onError={(e) => {
        e.currentTarget.classList.add('loaded');
        onError?.();
      }}
    />
  );
}

export function BlurImage({
  thumb, alt, className, phClassName, ratio, priority, onLoad,
}: {
  thumb: string; alt: string; className?: string; phClassName?: string;
  ratio?: string; priority?: boolean; onLoad?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <span
        className={`${phClassName}${loaded ? ' hide' : ''}`}
        style={{ backgroundImage: `url(/blur/${thumb})` }}
        aria-hidden="true"
      />
      <LoadedImg
        src={`/thumb/${thumb}`}
        alt={alt}
        className={`${className}${loaded ? ' loaded' : ''}`}
        eager={priority}
        ratio={ratio}
        onError={() => setLoaded(true)}
      />
    </>
  );
}

/* ------------------------------------------------------------ heart button */

export function HeartButton({
  on, onClick, className = '', size = 'sm',
}: {
  on: boolean; onClick: (e: React.MouseEvent) => void; className?: string; size?: 'sm' | 'md';
}) {
  const [pop, setPop] = useState(false);
  return (
    <button
      type="button"
      className={`${className}${on ? ' on' : ''}${pop ? ' pop' : ''}`}
      aria-label={on ? '取消收藏' : '收藏'}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setPop(true);
        window.setTimeout(() => setPop(false), 440);
        onClick(e);
      }}
    >
      <Icon name="heart" className={size === 'sm' ? 'icon sm' : 'icon'} filled={on} />
    </button>
  );
}
