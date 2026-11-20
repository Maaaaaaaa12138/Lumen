import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, prefetchPreview, type AlbumDetail, type AlbumSummary, type Photo, type Video } from './api';
import type { LensItem } from './Lightbox';
import { photoItem, videoItem } from './items';
import {
  BlurImage, fmtBytes, fmtDate, fmtDuration, fmtInt, fmtRange, HeartButton, Icon, LoadedImg, Reveal, useToast,
} from './ui';
import { MiniCard } from './Timeline';
import { useVideoPosters } from './videoPoster';

type Tab = 'curated' | 'recommended' | 'all' | 'videos';

function useMasonryColumns(min = 340, max = 5) {
  const [cols, setCols] = useState(3);
  const ro = useRef<ResizeObserver | null>(null);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth || 0;
      if (!w) return;
      const n = w < 640 ? 2 : Math.max(2, Math.min(max, Math.round(w / min)));
      setCols(n);
    };
    compute();
    ro.current = new ResizeObserver(compute);
    ro.current.observe(el);
  }, [min, max]);
  useEffect(() => () => ro.current?.disconnect(), []);
  return { cols, setRef };
}

function useChunk(total: number, size = 150) {
  const [count, setCount] = useState(size);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => setCount(size), [total, size]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setCount((c) => Math.min(total, c + size));
        }
      },
      { rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [total, size]);
  return { count, sentinel, hasMore: count < total };
}

function PhotoTile({
  photo, square, selected, onOpen, onToggle, index,
}: {
  photo: Photo; square?: boolean; selected: boolean;
  onOpen: () => void; onToggle: () => void; index: number;
}) {
  const ratio = `${photo.w || 3} / ${photo.h || 2}`;
  return (
    <figure
      className={`tile${square ? ' square' : ''}`}
      style={square ? undefined : { aspectRatio: ratio }}
      onClick={onOpen}
      onMouseEnter={() => prefetchPreview(photo.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <span className="tile-ph" style={{ backgroundImage: `url(/blur/${photo.thumb})` }} aria-hidden="true" />
      <LoadedImg
        className="main"
        src={`/thumb/${photo.thumb}`}
        alt={photo.name}
        eager={index < 12}
      />
      <span className="tile-veil" />
      {photo.tier === 1 ? (
        <span className="tile-badge">
          <Icon name="sparkle" className="icon sm" />
          精选
        </span>
      ) : null}
      <span className="tile-label">
        <span className="fn">{photo.name}</span>
        <span>{fmtBytes(photo.bytes)}</span>
      </span>
      <HeartButton className="tile-heart" on={selected} onClick={onToggle} />
    </figure>
  );
}

function VideoTile({
  video, poster, selected, onOpen, onToggle,
}: {
  video: Video; poster?: string; selected: boolean; onOpen: () => void; onToggle: () => void;
}) {
  const thumb = poster || video.thumb;
  return (
    <figure className="tile video" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      {thumb ? (
        <>
          <span className="tile-ph" style={{ backgroundImage: `url(/blur/${thumb})` }} aria-hidden="true" />
          <LoadedImg className="main" src={`/thumb/${thumb}`} alt={video.name} />
        </>
      ) : (
        <span className="tile-fallback">
          <Icon name="film" />
        </span>
      )}
      <span className="tile-veil" />
      <span className="tile-play">
        <span className="ring">
          <Icon name="play" className="icon sm" filled />
        </span>
      </span>
      <span className="tile-dur">{video.duration ? fmtDuration(video.duration) : fmtBytes(video.bytes)}</span>
      <span className="tile-label">
        <span className="fn">{video.name}</span>
        <span>{fmtBytes(video.bytes)}</span>
      </span>
      <HeartButton className="tile-heart" on={selected} onClick={onToggle} />
    </figure>
  );
}

export function AlbumView({
  id, allAlbums, selected, onToggleSelect, onSelectMany, onOpenAlbum, onOpenLightbox, onBack, localClient = true,
}: {
  id: string;
  allAlbums: AlbumSummary[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectMany: (ids: string[], on: boolean) => void;
  onOpenAlbum: (id: string) => void;
  onOpenLightbox: (items: LensItem[], index: number, autoplay?: boolean) => void;
  onBack: () => void;
  localClient?: boolean;
}) {
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('curated');
  const { cols, setRef: setMasonryRef } = useMasonryColumns();
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setAlbum(null);
    setError(null);
    api
      .album(id)
      .then((res) => {
        if (!alive) return;
        setAlbum(res.album);
        setTab(
          res.album.curated.length
            ? 'curated'
            : res.album.recommended?.length
              ? 'recommended'
              : res.album.videoCount && !res.album.photoCount
                ? 'videos'
                : 'all',
        );
      })
      .catch((e) => alive && setError(String(e.message || e)));
    return () => {
      alive = false;
    };
  }, [id]);

  const curatedPhotos = useMemo(() => {
    if (!album) return [] as Photo[];
    const byId = new Map(album.photos.map((p) => [p.id, p]));
    return album.curated.map((pid) => byId.get(pid)).filter(Boolean) as Photo[];
  }, [album]);

  const recommendedPhotos = useMemo(() => {
    if (!album) return [] as Photo[];
    const byId = new Map(album.photos.map((p) => [p.id, p]));
    return (album.recommended || []).map((pid) => byId.get(pid)).filter(Boolean) as Photo[];
  }, [album]);

  const plainPhotos = useMemo(() => (album ? album.photos.filter((p) => p.tier === 0) : []), [album]);
  const posters = useVideoPosters(album?.videos || []);
  const children = useMemo(
    () => allAlbums
      .filter((a) => a.parentId === id)
      .sort((a, b) => new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime()),
    [allAlbums, id],
  );

  const previewPhotos = curatedPhotos.length ? curatedPhotos : recommendedPhotos;

  // warm the first previews of the featured set so opening one is instant
  useEffect(() => {
    if (!previewPhotos.length) return;
    const t = window.setTimeout(() => {
      for (const p of previewPhotos.slice(0, 4)) prefetchPreview(p.id);
    }, 700);
    return () => window.clearTimeout(t);
  }, [previewPhotos]);

  const tabPhotos = tab === 'curated' ? curatedPhotos : tab === 'recommended' ? recommendedPhotos : plainPhotos;
  const { count, sentinel, hasMore } = useChunk(tabPhotos.length, 150);

  const bucket = useMemo(() => {
    if (tab !== 'curated' && tab !== 'recommended') return [];
    const buckets: Photo[][] = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0);
    for (const p of tabPhotos) {
      const ar = (p.w || 3) / (p.h || 2);
      let target = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[target]) target = i;
      buckets[target].push(p);
      heights[target] += 1 / ar + 0.04;
    }
    return buckets;
  }, [tabPhotos, cols, tab]);

  if (error) {
    return (
      <div className="wrap" style={{ paddingTop: 140 }}>
        <div className="empty">
          <span className="big">相册打不开</span>
          <p>{error}</p>
          <button className="btn" onClick={onBack}>
            <Icon name="left" className="icon sm" /> 返回时间轴
          </button>
        </div>
      </div>
    );
  }

  if (!album) {
    return (
      <div className="wrap" style={{ paddingTop: 140 }}>
        <div className="grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div className="skeleton-tile" key={i} />
          ))}
        </div>
      </div>
    );
  }

  const title = album.title;
  const total = album.photoCount + album.videoCount;
  const aggregated = album.isCollection
    ? children.reduce(
        (acc, c) => ({
          frames: acc.frames + c.photoCount + c.videoCount,
          curated: acc.curated + c.curatedCount,
          recommended: acc.recommended + c.recommendedCount,
        }),
        { frames: total, curated: curatedPhotos.length, recommended: recommendedPhotos.length },
      )
    : { frames: total, curated: curatedPhotos.length, recommended: recommendedPhotos.length };
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'curated', label: '精选', count: curatedPhotos.length },
    { key: 'recommended', label: '推荐', count: recommendedPhotos.length },
    { key: 'all', label: '全部照片', count: plainPhotos.length },
    { key: 'videos', label: '视频', count: album.videos.length },
  ].filter((t) => t.count > 0) as { key: Tab; label: string; count: number }[];
  const hasOwnMedia = tabs.length > 0;

  const openCurated = (index: number) =>
    onOpenLightbox(curatedPhotos.map((p) => photoItem(p, title, album.id)), index);
  const openRecommended = (index: number) =>
    onOpenLightbox(recommendedPhotos.map((p) => photoItem(p, title, album.id)), index);
  const openAll = (index: number) =>
    onOpenLightbox(plainPhotos.map((p) => photoItem(p, title, album.id)), index);
  const openVideo = (index: number) =>
    onOpenLightbox(
      album.videos.map((v) => videoItem(v, title, album.id, posters[v.id])),
      index,
    );

  return (
    <div className="wrap">
      <div className="detail-head">
        <button className="backlink" onClick={onBack}>
          <Icon name="left" className="icon sm" />
          返回时间轴
        </button>

        <div className="detail-title-row">
          <div style={{ minWidth: 0 }}>
            <h1 className="detail-title">{title}</h1>
            <div className="detail-meta">
              <span>
                <span className="k">When</span>
                {fmtRange(album.startDate, album.endDate)}
              </span>
              <span>
                <span className="k">Frames</span>
                {fmtInt(aggregated.frames)}
              </span>
              {aggregated.curated > 0 ? (
                <span>
                  <span className="k">Selected</span>
                  {aggregated.curated}
                </span>
              ) : null}
              {aggregated.recommended > 0 ? (
                <span>
                  <span className="k">Preview</span>
                  {aggregated.recommended} 张推荐
                </span>
              ) : null}
              <span>
                <span className="k">Size</span>
                {fmtBytes(album.bytes)}
              </span>
              {album.isCollection ? (
                <span>
                  <span className="k">Group</span>
                  {children.length + 1} 组
                </span>
              ) : null}
            </div>
          </div>
          <div className="detail-actions">
            <button
              className="btn"
              onClick={() =>
                onOpenLightbox(
                  (curatedPhotos.length
                    ? curatedPhotos
                    : recommendedPhotos.length
                      ? recommendedPhotos
                      : plainPhotos
                  ).map((p) => photoItem(p, title, album.id)),
                  0,
                  true,
                )
              }
            >
              <Icon name="slideshow" className="icon sm" />
              幻灯片
            </button>
            <button
              className="btn"
              onClick={() => {
                const ids = (tab === 'videos' ? album.videos.map((v) => v.id) : tabPhotos.map((p) => p.id));
                const allOn = ids.length > 0 && ids.every((x) => selected.has(x));
                onSelectMany(ids, !allOn);
              }}
            >
              <Icon name="heart" className="icon sm" />
              全选
            </button>
            {localClient ? (
              <button
                className="btn"
                onClick={() =>
                  api.reveal(album.id).then(
                    () => toast('已在资源管理器打开'),
                    (err: Error) => toast(err.message || '打开失败', 'close'),
                  )
                }
                title="在资源管理器中打开这个相册文件夹"
              >
                <Icon name="folder" className="icon sm" />
                文件夹
              </button>
            ) : null}
          </div>
        </div>

        {children.length ? (
          <div className="collection" style={{ margin: '8px 0 30px' }}>
            <div className="collection-head">
              <div>
                <h3 className="collection-title">这一组里的故事</h3>
                <div className="collection-sub">{children.length} 个相册</div>
              </div>
            </div>
            <div className="collection-scroll">
              {children.map((c) => (
                <MiniCard key={c.id} album={c} onOpen={onOpenAlbum} />
              ))}
            </div>
          </div>
        ) : null}

        {hasOwnMedia ? (
          <div className="detail-tabs">
            <div className="tabs">
              {tabs.map((t) => (
                <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
                  {t.label}
                  <span className="c">{fmtInt(t.count)}</span>
                </button>
              ))}
            </div>
            <div className="tab-aux">
              <span>{album.id}</span>
            </div>
          </div>
        ) : null}
      </div>

      {tab === 'curated' || tab === 'recommended' ? (
        (tab === 'curated' ? curatedPhotos : recommendedPhotos).length ? (
          <>
            {tab === 'recommended' ? (
              <p style={{ color: 'var(--ink-4)', fontSize: 12.5, margin: '0 0 18px', letterSpacing: '0.03em' }}>
                这个相册没有 out/、官方返图之类的精修文件，以下是按时间均匀抽取的推荐片段，不计入精选 —— 切到「全部照片」查看完整一组。
              </p>
            ) : null}
            <div className="masonry" ref={setMasonryRef}>
              {bucket.map((col, ci) => (
                <div className="masonry-col" key={ci}>
                  {col.map((p) => {
                    const index = tabPhotos.indexOf(p);
                    return (
                      <PhotoTile
                        key={p.id}
                        photo={p}
                        selected={selected.has(p.id)}
                        index={index}
                        onOpen={() => (tab === 'curated' ? openCurated(index) : openRecommended(index))}
                        onToggle={() => onToggleSelect(p.id)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            <span className="big">还没有精选</span>
            <p>这个相册里没有 out/ 精修目录，去「全部照片」里慢慢挑吧。</p>
          </div>
        )
      ) : null}

      {tab === 'all' ? (
        <>
          <div className="grid">
            {plainPhotos.slice(0, count).map((p, i) => (
              <PhotoTile
                key={p.id}
                photo={p}
                square
                index={i}
                selected={selected.has(p.id)}
                onOpen={() => openAll(i)}
                onToggle={() => onToggleSelect(p.id)}
              />
            ))}
          </div>
          <div ref={sentinel} className="load-more">
            {hasMore ? (
              <>
                <span className="spinner" />
                正在加载 {fmtInt(plainPhotos.length - count)} 张
              </>
            ) : (
              <span>已经到底了 · 共 {fmtInt(plainPhotos.length)} 张</span>
            )}
          </div>
        </>
      ) : null}

      {tab === 'videos' ? (
        <div className="grid">
          {album.videos.map((v, i) => (
            <VideoTile
              key={v.id}
              video={v}
              poster={posters[v.id]}
              selected={selected.has(v.id)}
              onOpen={() => openVideo(i)}
              onToggle={() => onToggleSelect(v.id)}
            />
          ))}
        </div>
      ) : null}

      <footer className="footer">
        <span>共 {fmtInt(total)} 个瞬间 · {fmtDate(album.startDate)}</span>
        <span className="mono">{album.id}</span>
      </footer>
    </div>
  );
}
