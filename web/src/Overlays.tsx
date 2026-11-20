import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AlbumSummary, type Photo } from './api';
import type { LensItem } from './Lightbox';
import { photoItem } from './items';
import {
  fmtBytes, fmtDate, fmtInt, fmtMonthCN, HeartButton, Icon, LoadedImg, useToast,
} from './ui';

/* ------------------------------------------------------------- boot screen */

export function BootScreen({
  progress, thumbs, error,
}: {
  progress: { phase: string; message?: string; done?: number; total?: number };
  thumbs: { done: number; total: number; complete: boolean };
  error: string | null;
}) {
  const phaseLabel: Record<string, string> = {
    boot: '正在唤醒暗房',
    scan: '扫描照片目录',
    probe: '读取拍摄时间与尺寸',
    ready: '准备就绪',
    error: '出错了',
  };
  let pct = 0;
  if (progress.phase === 'probe' && progress.total) pct = Math.min(96, (progress.done || 0) / progress.total * 96);
  else if (progress.phase === 'ready') pct = 100;
  else if (progress.phase === 'scan') pct = 8;

  const detail =
    progress.phase === 'probe' && progress.total
      ? `${fmtInt(progress.done || 0)} / ${fmtInt(progress.total)} 个文件`
      : thumbs.total
        ? `缩略图 ${fmtInt(thumbs.done)} / ${fmtInt(thumbs.total)}`
        : progress.message || '';

  return (
    <div className="boot">
      <div className="boot-glow" />
      <div className="boot-inner">
        <h1 className="boot-title">光影志</h1>
        <div className="boot-sub">Private Archive · Local</div>
        <div className="boot-bar">
          <div className="boot-bar-fill" style={{ width: `${Math.max(pct, 4)}%` }} />
        </div>
        <div className="boot-status">{phaseLabel[progress.phase] || '准备中'} · {detail}</div>
        {error ? <div className="boot-err">{error}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ search sheet */

export function SearchSheet({
  onClose, onOpenAlbum, onOpenLightbox, selected, onToggleSelect,
}: {
  onClose: () => void;
  onOpenAlbum: (id: string) => void;
  onOpenLightbox: (items: LensItem[], index: number) => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim()) {
      setAlbums([]);
      setPhotos([]);
      return;
    }
    setBusy(true);
    timer.current = window.setTimeout(() => {
      api
        .search(q.trim())
        .then((res) => {
          setAlbums(res.albums);
          setPhotos(res.photos);
        })
        .finally(() => setBusy(false));
    }, 220);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  return (
    <div className="sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2 className="sheet-title">搜索</h2>
          <button className="btn icon sheet-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="search-box">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索相册名、地点、文件名…"
            spellCheck={false}
          />
          {busy ? <span className="spinner" style={{ width: 16, height: 16 }} /> : null}
        </div>

        {!q.trim() ? (
          <div className="search-empty">试试「秦皇岛」「国庆」「DSC」…</div>
        ) : (
          <>
            {albums.length ? (
              <div className="search-group">
                <h5>相册 · {albums.length}</h5>
                <div className="result-albums">
                  {albums.map((a) => (
                    <button key={a.id} className="result-album" onClick={() => onOpenAlbum(a.id)}>
                      <span className="thumb">
                        {a.covers[0] ? <img src={`/thumb/${a.covers[0].thumb}`} alt="" loading="lazy" /> : null}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="t" style={{ display: 'block' }}>
                          {a.title}
                        </span>
                        <span className="s">
                          {a.dateLabel} · {fmtInt(a.photoCount)} 张
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {photos.length ? (
              <div className="search-group">
                <h5>照片 · {photos.length}</h5>
                <div className="grid">
                  {photos.slice(0, 60).map((p, i) => (
                    <figure
                      key={p.id}
                      className="tile square"
                      onClick={() => onOpenLightbox(photos.map((x) => photoItem(x, x.albumTitle, x.albumId)), i)}
                    >
                      <span className="tile-ph" style={{ backgroundImage: `url(/blur/${p.thumb})` }} />
                      <LoadedImg className="main" src={`/thumb/${p.thumb}`} alt={p.name} />
                      <span className="tile-veil" />
                      <span className="tile-label">
                        <span className="fn">{p.albumTitle}</span>
                        <span>{fmtDate(p.date)}</span>
                      </span>
                      <HeartButton className="tile-heart" on={selected.has(p.id)} onClick={() => onToggleSelect(p.id)} />
                    </figure>
                  ))}
                </div>
              </div>
            ) : null}

            {!albums.length && !photos.length && !busy ? <div className="search-empty">没有找到「{q}」</div> : null}
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- all-photos view */

export function AllPhotosView({
  years, onOpenLightbox, selected, onToggleSelect,
}: {
  years: { year: number }[];
  onOpenLightbox: (items: LensItem[], index: number) => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const [year, setYear] = useState<number | null>(null);
  const [onlyCurated, setOnlyCurated] = useState(false);
  const [items, setItems] = useState<Photo[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<{ all: number; curated: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  /** Bumped on every filter change so in-flight pages from the old filter are dropped. */
  const genRef = useRef(0);
  const PAGE = 150;

  const load = useCallback(
    async (offset: number, replace: boolean) => {
      if (loadingRef.current) return;
      const gen = genRef.current;
      loadingRef.current = true;
      setLoading(true);
      setFailed(false);
      try {
        const res = await api.photos(offset, PAGE, year, onlyCurated);
        if (gen !== genRef.current) return;
        setTotal(res.total);
        if (res.counts) setCounts(res.counts);
        setItems((prev) => (replace ? res.photos : [...prev, ...res.photos]));
        setDone(offset + res.photos.length >= res.total);
      } catch {
        if (gen === genRef.current) setFailed(true);
      } finally {
        if (gen === genRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [year, onlyCurated],
  );

  useEffect(() => {
    genRef.current += 1;
    loadingRef.current = false;
    setItems([]);
    setTotal(0);
    setDone(false);
    void load(0, true);
  }, [load]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !done) void load(items.length, false);
      },
      { rootMargin: '1000px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, done, load]);

  const grouped = useMemo(() => {
    const out: { month: string; photos: Photo[] }[] = [];
    let current: { month: string; photos: Photo[] } | null = null;
    for (const p of items) {
      const key = `${new Date(p.date).getFullYear()}-${new Date(p.date).getMonth()}`;
      if (!current || current.month !== key) {
        current = { month: key, photos: [] };
        out.push(current);
      }
      current.photos.push(p);
    }
    return out;
  }, [items]);

  let runningIndex = -1;
  const empty = done && !loading && !failed && total === 0;

  return (
    <div className="wrap" style={{ paddingTop: 'calc(var(--nav-h) + 40px)' }}>
      <div className="detail-title-row" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Chronological stream</div>
          <h1 className="detail-title" style={{ marginBottom: 10 }}>全部照片</h1>
          <div className="detail-meta">
            <span>
              <span className="k">Total</span>
              {fmtInt(total)} 张
            </span>
            <span>
              <span className="k">Order</span>
              最新在前
            </span>
            {onlyCurated ? (
              <span>
                <span className="k">Filter</span>
                只看精选
              </span>
            ) : null}
          </div>
        </div>
        <div className="all-filters">
          <div className="year-pills">
            <button className={`year-pill${year === null ? ' active' : ''}`} onClick={() => setYear(null)}>
              全部
            </button>
            {[...years].sort((a, b) => b.year - a.year).map((y) => (
              <button
                key={y.year}
                className={`year-pill${year === y.year ? ' active' : ''}`}
                onClick={() => setYear(y.year)}
              >
                {y.year}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`curated-pill${onlyCurated ? ' active' : ''}`}
            aria-pressed={onlyCurated}
            onClick={() => setOnlyCurated((v) => !v)}
            title={onlyCurated ? '取消筛选，显示所有照片' : '只显示精选照片'}
          >
            <Icon name={onlyCurated ? 'check' : 'sparkle'} className="icon sm" />
            只看精选
            {counts ? <span className="c">{fmtInt(counts.curated)}</span> : null}
          </button>
        </div>
      </div>

      {empty ? (
        <div className="empty">
          <Icon name={onlyCurated ? 'sparkle' : 'image'} className="icon" />
          <span className="big">{onlyCurated ? '这里还没有精选' : '还没有照片'}</span>
          <p>
            {onlyCurated
              ? year
                ? `${year} 年没有精选照片，切回「全部照片」看看完整的一组。`
                : '照片库里还没有精选照片，去相册里挑几张吧。'
              : '照片目录还是空的。'}
          </p>
        </div>
      ) : null}

      {grouped.map((group) => (
        <section key={group.month}>
          <div className="month-head">
            <span className="m">{fmtMonthCN(group.photos[0].date)}</span>
            <span className="c">{group.photos.length} 张</span>
            <span className="rule" />
          </div>
          <div className="grid">
            {group.photos.map((p) => {
              runningIndex += 1;
              const idx = runningIndex;
              return (
                <figure
                  key={p.id}
                  className="tile square"
                  onClick={() => onOpenLightbox(items.map((x) => photoItem(x, x.albumTitle, x.albumId)), idx)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="tile-ph" style={{ backgroundImage: `url(/blur/${p.thumb})` }} />
                  <LoadedImg className="main" src={`/thumb/${p.thumb}`} alt={p.name} eager={idx < 24} />
                  <span className="tile-veil" />
                  <span className="tile-label">
                    <span className="fn">{p.albumTitle}</span>
                    <span>{fmtDate(p.date)}</span>
                  </span>
                  <HeartButton className="tile-heart" on={selected.has(p.id)} onClick={() => onToggleSelect(p.id)} />
                </figure>
              );
            })}
          </div>
        </section>
      ))}

      <div ref={sentinel} className="load-more">
        {failed ? (
          <button
            type="button"
            className="load-retry"
            onClick={() => void load(items.length, items.length === 0)}
          >
            加载失败 · 点击重试
          </button>
        ) : loading ? (
          <>
            <span className="spinner" /> 加载中
          </>
        ) : done && total ? (
          <span>到底了 · 共 {fmtInt(total)} 张</span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ favourites */

export function FavoritesView({
  ids, onOpenLightbox, onToggleSelect, onOpenAlbum,
}: {
  ids: string[];
  onOpenLightbox: (items: LensItem[], index: number, autoplay?: boolean) => void;
  onToggleSelect: (id: string) => void;
  onOpenAlbum: (id: string) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const key = ids.join('|');

  useEffect(() => {
    let alive = true;
    if (!ids.length) {
      setPhotos([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .resolve(ids)
      .then((res) => alive && setPhotos(res.photos))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [key]);

  const totalBytes = photos.reduce((s, p) => s + p.bytes, 0);

  const copyList = async () => {
    const text = photos.map((p) => p.id).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${photos.length} 个文件路径`);
    } catch {
      toast('浏览器不允许写剪贴板', 'close');
    }
  };

  return (
    <div className="wrap" style={{ paddingTop: 'calc(var(--nav-h) + 40px)' }}>
      <div className="detail-title-row" style={{ alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Your picks</div>
          <h1 className="detail-title" style={{ marginBottom: 10 }}>收藏夹</h1>
          <div className="detail-meta">
            <span>
              <span className="k">Picked</span>
              {fmtInt(ids.length)} 张
            </span>
            {photos.length ? (
              <span>
                <span className="k">Size</span>
                {fmtBytes(totalBytes)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="detail-actions">
          <button className="btn" onClick={copyList} disabled={!photos.length}>
            <Icon name="copy" className="icon sm" />
            复制清单
          </button>
          <button
            className="btn"
            disabled={!photos.length}
            onClick={() => onOpenLightbox(photos.map((p) => photoItem(p, p.albumTitle, p.albumId)), 0, true)}
          >
            <Icon name="slideshow" className="icon sm" />
            幻灯片
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div className="skeleton-tile" key={i} />
          ))}
        </div>
      ) : photos.length ? (
        <div className="grid">
          {photos.map((p, i) => (
            <figure
              key={p.id}
              className="tile square"
              onClick={() => onOpenLightbox(photos.map((x) => photoItem(x, x.albumTitle, x.albumId)), i)}
              role="button"
              tabIndex={0}
            >
              <span className="tile-ph" style={{ backgroundImage: `url(/blur/${p.thumb})` }} />
              <LoadedImg className="main" src={`/thumb/${p.thumb}`} alt={p.name} />
              <span className="tile-veil" />
              <span className="tile-label">
                <button
                  className="fn"
                  style={{ pointerEvents: 'auto', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.albumId) onOpenAlbum(p.albumId);
                  }}
                >
                  {p.albumTitle}
                </button>
                <span>{fmtDate(p.date)}</span>
              </span>
              <HeartButton className="tile-heart on" on onClick={() => onToggleSelect(p.id)} />
            </figure>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Icon name="heart" className="icon" />
          <span className="big">还没有收藏</span>
          <p>在时间轴或相册里把喜欢的照片点一下右上角的心，它们就会集中到这里，方便你最后统一导出。</p>
        </div>
      )}
    </div>
  );
}
