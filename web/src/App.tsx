import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type LibraryPayload, type ThumbStats } from './api';
import { AlbumView } from './Album';
import { Hero } from './Hero';
import { Lightbox, type LensItem } from './Lightbox';
import { AllPhotosView, BootScreen, FavoritesView, SearchSheet } from './Overlays';
import { Timeline } from './Timeline';
import { Icon, fmtInt, ToastProvider, useActiveSection, useToast } from './ui';

type Route =
  | { name: 'home' }
  | { name: 'album'; id: string }
  | { name: 'all' }
  | { name: 'favorites' };

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { name: 'home' };
  const [head, ...rest] = raw.split('/');
  if (head === 'album' && rest.length) return { name: 'album', id: decodeURIComponent(rest.join('/')) };
  if (head === 'all') return { name: 'all' };
  if (head === 'favorites') return { name: 'favorites' };
  return { name: 'home' };
}

/** Stable identity for a view, used as the scroll-memory key. */
function routeKey(r: Route): string {
  return r.name === 'album' ? `album:${r.id}` : r.name;
}

function navigate(path: string) {
  if (window.location.hash === path) return;
  window.location.hash = path;
}

const EMPTY_THUMBS: ThumbStats = {
  total: 0, done: 0, failed: 0, pending: 0, active: 0, rate: 0, etaSec: null, bytes: 0, complete: true,
};

function Shell() {
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [booting, setBooting] = useState(true);
  const [progress, setProgress] = useState<{ phase: string; message?: string; done?: number; total?: number }>({
    phase: 'boot',
  });
  const [thumbs, setThumbs] = useState<ThumbStats>(EMPTY_THUMBS);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parseHash);
  const [selections, setSelections] = useState<Set<string>>(new Set());
  const selectionsRef = useRef<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<{ items: LensItem[]; index: number; autoplay?: boolean } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('lumen-theme') || 'dark');
  const [scrolled, setScrolled] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const toast = useToast();
  const firstLoad = useRef(true);

  const applySelections = useCallback((ids: string[]) => {
    const next = new Set(ids);
    selectionsRef.current = next;
    setSelections(next);
  }, []);

  /* ------------------------------------------------------------- library */
  const loadLibrary = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/library', { cache: 'no-store' });
      if (res.status === 202) {
        const st = await res.json();
        setProgress(st.progress || { phase: 'indexing' });
        if (st.error) setError(st.error);
        return false;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as LibraryPayload;
      setLibrary(data);
      setThumbs(data.thumbs || EMPTY_THUMBS);
      setProgress({ phase: 'ready' });
      if (firstLoad.current) {
        applySelections(data.selections || []);
        firstLoad.current = false;
      }
      setError(null);
      setBooting(false);
      return true;
    } catch (err) {
      setError(String((err as Error).message || err));
      return false;
    }
  }, [applySelections]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const ok = await loadLibrary();
      if (!alive) return;
      if (!ok) timer = window.setTimeout(poll, 900);
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [loadLibrary]);

  /* --------------------------------------------------------------- stream */
  useEffect(() => {
    if (booting) return;
    let source: EventSource | null = null;
    let refreshTimer: number | undefined;
    try {
      source = new EventSource('/api/stream');
      source.addEventListener('thumbs', (e) => {
        try {
          setThumbs(JSON.parse((e as MessageEvent).data));
        } catch {
          /* ignore */
        }
      });
      source.addEventListener('progress', () => setReindexing(true));
      source.addEventListener('library', () => {
        setReindexing(false);
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => void loadLibrary(), 700);
      });
      source.addEventListener('error', () => {
        source?.close();
        source = null;
      });
    } catch {
      /* SSE unavailable: polling already covers us */
    }
    return () => {
      window.clearTimeout(refreshTimer);
      source?.close();
    };
  }, [booting, loadLibrary]);

  /* --------------------------------------------------------------- routes */
  // Remember where you were in each view, so coming back from an album lands you
  // on the same card instead of the top of a very long timeline.
  const scrollMemory = useRef<Map<string, number>>(new Map());
  const currentKey = useRef<string>(routeKey(parseHash()));
  const previousKey = useRef<string | null>(null);

  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

    const scrollToY = (top: number) => {
      // two frames: the new view has to paint (and reserve its real height) first
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo({ top: Math.min(top, max), behavior: 'instant' as ScrollBehavior });
        });
      });
    };

    const onHash = () => {
      const leaving = currentKey.current;
      if (leaving) scrollMemory.current.set(leaving, window.scrollY);
      const next = parseHash();
      const nextKey = routeKey(next);
      previousKey.current = leaving;
      currentKey.current = nextKey;
      setRoute(next);
      setLightbox(null);
      setSearchOpen(false);
      scrollToY(scrollMemory.current.get(nextKey) ?? 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('lumen-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ----------------------------------------------------------- selections */
  const toggleSelect = useCallback((id: string) => {
    const has = selectionsRef.current.has(id);
    const next = new Set(selectionsRef.current);
    if (has) next.delete(id);
    else next.add(id);
    selectionsRef.current = next;
    setSelections(next);
    void api.select(id, !has);
  }, []);

  const selectMany = useCallback((ids: string[], on: boolean) => {
    const next = new Set(selectionsRef.current);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    selectionsRef.current = next;
    setSelections(next);
    void api.selectMany(ids, on);
    toast(on ? `已收藏 ${ids.length} 张` : `已取消 ${ids.length} 张`);
  }, [toast]);

  const clearAll = useCallback(() => {
    selectionsRef.current = new Set();
    setSelections(new Set());
    void api.clearSelections();
  }, []);

  const [thumbPaused, setThumbPaused] = useState(false);
  const toggleThumbPaused = useCallback(async () => {
    const next = !thumbPaused;
    setThumbPaused(next);
    try {
      const res = await api.setThumbPaused(next);
      setThumbs(res.stats);
      toast(next ? '已暂停后台生成，浏览更流畅' : '继续生成缩略图', next ? 'pause' : 'play');
    } catch {
      setThumbPaused(!next);
      toast('操作失败', 'close');
    }
  }, [thumbPaused, toast]);

  const [showSensitive, setShowSensitive] = useState<boolean>(() => localStorage.getItem('lumen-sensitive') === '1');
  const toggleSensitive = useCallback(() => {
    setShowSensitive((prev) => {
      const next = !prev;
      localStorage.setItem('lumen-sensitive', next ? '1' : '0');
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- views */
  const yearIds = useMemo(
    () => (library ? [...library.years].sort((a, b) => b.year - a.year).map((y) => `year-${y.year}`) : []),
    [library],
  );
  const activeYearId = useActiveSection(yearIds, 140);
  const activeYear = activeYearId ? activeYearId.replace('year-', '') : null;

  const openLightbox = useCallback((items: LensItem[], index: number, autoplay = false) => {
    setLightbox({ items, index, autoplay });
  }, []);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  if (booting || !library) {
    return <BootScreen progress={progress} thumbs={thumbs} error={error} />;
  }

  const selectedCount = selections.size;
  const thumbPct = thumbs.total ? Math.round((thumbs.done / Math.max(1, thumbs.total)) * 100) : 100;
  const showThumbBar = !thumbs.complete && thumbs.total > 0;

  return (
    <>
      <div className="grain" />
      {showThumbBar ? (
        <button
          type="button"
          className={`nav-progress${thumbPaused ? ' paused' : ''}`}
          style={{ width: `${thumbPct}%` }}
          onClick={toggleThumbPaused}
          title={
            thumbPaused
              ? '缩略图生成已暂停 · 点击继续'
              : `正在生成缩略图 ${fmtInt(thumbs.done)}/${fmtInt(thumbs.total)} · 点击暂停`
          }
          aria-label={thumbPaused ? '继续生成缩略图' : '暂停生成缩略图'}
        />
      ) : null}

      <nav className={`topbar${scrolled ? ' scrolled' : ''}`}>
        <button className="brand" onClick={() => navigate('#/')} aria-label="回到时间轴">
          <span className="brand-mark" />
          <span className="brand-name">光影志</span>
          <span className="brand-sub">Lumen</span>
        </button>

        {route.name === 'home' ? (
          <div className="year-pills">
            {[...library.years]
              .sort((a, b) => b.year - a.year)
              .map((y) => (
                <button
                  key={y.year}
                  className={`year-pill${activeYear === String(y.year) ? ' active' : ''}`}
                  onClick={() => document.getElementById(`year-${y.year}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  {y.year}
                </button>
              ))}
          </div>
        ) : null}

        <div className="nav-links">
          <button
            className={`nav-link${route.name === 'home' ? ' active' : ''}`}
            onClick={() => navigate('#/')}
          >
            <Icon name="film" className="icon sm" />
            <span className="label">时间轴</span>
            <span className="dot" />
          </button>
          <button
            className={`nav-link${route.name === 'all' ? ' active' : ''}`}
            onClick={() => navigate('#/all')}
          >
            <Icon name="layers" className="icon sm" />
            <span className="label">全部照片</span>
            <span className="dot" />
          </button>
          <button
            className={`nav-link${route.name === 'favorites' ? ' active' : ''}`}
            onClick={() => navigate('#/favorites')}
          >
            <Icon name="heart" className="icon sm" filled={selectedCount > 0} />
            <span className="label">收藏夹</span>
            {selectedCount > 0 ? (
              <span
                style={{
                  fontSize: 10.5,
                  fontVariantNumeric: 'tabular-nums',
                  padding: '1px 6px',
                  borderRadius: 99,
                  background: 'var(--accent)',
                  color: 'var(--accent-ink)',
                  fontWeight: 700,
                }}
              >
                {selectedCount > 999 ? '999+' : selectedCount}
              </span>
            ) : null}
            <span className="dot" />
          </button>
          <button className="nav-link" onClick={() => setSearchOpen(true)} aria-label="搜索">
            <Icon name="search" className="icon sm" />
          </button>
          <button
            className="nav-link"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="切换主题"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="icon sm" />
          </button>
        </div>
      </nav>

      {route.name === 'home' ? (
        <main>
          <Hero library={library} />
          <Timeline
            library={library}
            onOpenAlbum={(id) => navigate(`#/album/${encodeURIComponent(id)}`)}
            onOpenAll={() => navigate('#/all')}
            onOpenFavorites={() => navigate('#/favorites')}
            selectedCount={selectedCount}
            showSensitive={showSensitive}
            onToggleSensitive={toggleSensitive}
          />
        </main>
      ) : null}

      {route.name === 'album' ? (
        <main style={{ paddingBottom: 60 }}>
          <AlbumView
            key={route.id}
            id={route.id}
            allAlbums={library.records}
            localClient={Boolean(library.localClient)}
            selected={selections}
            onToggleSelect={toggleSelect}
            onSelectMany={selectMany}
            onOpenAlbum={(id) => navigate(`#/album/${encodeURIComponent(id)}`)}
            onOpenLightbox={openLightbox}
            onBack={() => (previousKey.current ? window.history.back() : navigate('#/'))}
          />
        </main>
      ) : null}

      {route.name === 'all' ? (
        <main style={{ paddingBottom: 60 }}>
          <AllPhotosView
            years={library.years}
            onOpenLightbox={openLightbox}
            selected={selections}
            onToggleSelect={toggleSelect}
          />
        </main>
      ) : null}

      {route.name === 'favorites' ? (
        <main style={{ paddingBottom: 60 }}>
          <FavoritesView
            ids={[...selections]}
            onOpenLightbox={openLightbox}
            onToggleSelect={toggleSelect}
            onOpenAlbum={(id) => navigate(`#/album/${encodeURIComponent(id)}`)}
          />
          {selectedCount > 0 ? (
            <div className="wrap" style={{ marginTop: 8 }}>
              <button className="btn ghost" onClick={clearAll} style={{ fontSize: 12, color: 'var(--ink-4)' }}>
                <Icon name="trash" className="icon sm" />
                清空收藏夹
              </button>
            </div>
          ) : null}
        </main>
      ) : null}

      {reindexing ? (
        <div className="toast-wrap" style={{ bottom: 84 }}>
          <div className="toast">
            <span className="spinner" style={{ width: 14, height: 14 }} />
            照片有变动，正在重新索引…
          </div>
        </div>
      ) : null}

      {searchOpen ? (
        <SearchSheet
          onClose={() => setSearchOpen(false)}
          onOpenAlbum={(id) => {
            setSearchOpen(false);
            navigate(`#/album/${encodeURIComponent(id)}`);
          }}
          onOpenLightbox={(items, index) => {
            setSearchOpen(false);
            openLightbox(items, index);
          }}
          selected={selections}
          onToggleSelect={toggleSelect}
        />
      ) : null}

      {lightbox ? (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          autoplay={Boolean(lightbox.autoplay)}
          showReveal={Boolean(library.localClient)}
          onIndex={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : prev))}
          onClose={closeLightbox}
          isSelected={(id) => selections.has(id)}
          onToggleSelect={toggleSelect}
        />
      ) : null}
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
