import { useState } from 'react';
import type { AlbumSummary, LibraryPayload } from './api';
import { fmtDate, fmtInt, fmtRange, fmtWeekday, Icon, LoadedImg, Reveal } from './ui';

function CellImage({ thumb, alt, eager }: { thumb: string; alt: string; eager?: boolean }) {
  // Mosaic cells live inside a horizontally scrollable, grid-positioned box where
  // Chrome's lazy-loading heuristics sometimes never fire; only ~4 per card, so eager.
  return <LoadedImg src={`/thumb/${thumb}`} alt={alt} className="" eager />;
}

function Mosaic({ covers }: { covers: AlbumSummary['covers'] }) {
  const list = covers.slice(0, 3);
  if (!list.length) {
    return (
      <div className="album-mosaic" data-n={1}>
        <span className="cell tile-fallback">
          <Icon name="image" />
        </span>
      </div>
    );
  }
  return (
    <div className="album-mosaic" data-n={list.length}>
      {list.map((c, i) => (
        <span
          key={c.id}
          className="cell"
          style={{ backgroundImage: `url(/blur/${c.thumb})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
        >
          <CellImage thumb={c.thumb} alt="" eager={i === 0} />
          {c.isVideo ? (
            <span className="tile-play">
              <span className="ring">
                <Icon name="play" className="icon sm" filled />
              </span>
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function AlbumCard({ album, onOpen, index }: { album: AlbumSummary; onOpen: (id: string) => void; index: number }) {
  const start = album.startDate ? new Date(album.startDate) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const yearOnly = album.datePrecision === 'year';
  const dateMain = yearOnly ? String(album.year) : start ? `${pad(start.getMonth() + 1)}.${pad(start.getDate())}` : '——';
  const dateSub = yearOnly
    ? '全年'
    : album.datePrecision === 'day'
      ? fmtWeekday(album.startDate)
      : album.datePrecision === 'month'
        ? '当月'
        : '当年';
  const total = album.photoCount + album.videoCount;

  return (
    <Reveal delay={(index % 2) * 90}>
      <article
        className="album-card"
        role="link"
        tabIndex={0}
        onClick={() => onOpen(album.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onOpen(album.id);
        }}
        aria-label={`打开 ${album.title}`}
      >
        <div className="album-media">
          <Mosaic covers={album.covers} />
          <div className="album-badge">
            {album.curatedCount > 0 ? (
              <span className="chip accent">
                <Icon name="sparkle" className="icon sm" />
                {album.derivedCurated ? '推荐' : '精选'} {album.curatedCount}
              </span>
            ) : null}
            {album.videoCount > 0 ? (
              <span className="chip">
                <Icon name="video" className="icon sm" />
                {album.videoCount}
              </span>
            ) : null}
          </div>
          <div className="album-count">
            <span className="n num">{fmtInt(total)}</span>
            <span className="u">frames</span>
          </div>
          <span className="album-open">
            查看 {album.curatedCount > 0 ? '精选' : '照片'}
            <Icon name="right" className="icon sm" />
          </span>
        </div>
        <div className="album-body">
          <div className="album-title-wrap">
            <h3 className="album-title" title={album.folderName}>
              {album.title}
            </h3>
            <div className="album-meta">
              <span>{fmtInt(album.photoCount)} 张照片</span>
              {album.curatedCount > 0 ? (
                <>
                  <i className="dotsep" />
                  <span>{album.curatedCount} 张精选</span>
                </>
              ) : null}
              {album.videoCount > 0 ? (
                <>
                  <i className="dotsep" />
                  <span>{album.videoCount} 段视频</span>
                </>
              ) : null}
              {album.isCollection ? (
                <>
                  <i className="dotsep" />
                  <span>{album.childIds.length} 组</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="album-date" aria-hidden="true">
            <span className="d num">{dateMain}</span>
            <span className="y">{dateSub}</span>
          </div>
        </div>
      </article>
    </Reveal>
  );
}

export function MiniCard({ album, onOpen }: { album: AlbumSummary; onOpen: (id: string) => void }) {
  return (
    <button className="album-card" style={{ transform: 'none' }} onClick={() => onOpen(album.id)}>
      <div className="album-media" style={{ aspectRatio: '4 / 3', borderRadius: 14 }}>
        <Mosaic covers={album.covers} />
        <div className="album-count" style={{ right: 10, bottom: 8 }}>
          <span className="n num" style={{ fontSize: 16 }}>
            {fmtInt(album.photoCount + album.videoCount)}
          </span>
        </div>
      </div>
      <div style={{ padding: '10px 2px 0' }}>
        <div
          className="album-title"
          style={{ fontSize: 15, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {album.title}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-4)', display: 'flex', gap: 8 }}>
          <span className="num">{album.dateLabel || fmtDate(album.startDate)}</span>
          {album.curatedCount > 0 ? <span>{album.curatedCount} 精选</span> : null}
        </div>
      </div>
    </button>
  );
}

function CollectionBlock({
  album, children, onOpen,
}: {
  album: AlbumSummary; children: AlbumSummary[]; onOpen: (id: string) => void;
}) {
  const photos = children.reduce((s, c) => s + c.photoCount, album.photoCount);
  const videos = children.reduce((s, c) => s + c.videoCount, album.videoCount);
  return (
    <Reveal className="collection">
      <div className="collection-head">
        <div>
          <h3 className="collection-title">{album.title}</h3>
          <div className="collection-sub">
            {fmtRange(album.startDate, album.endDate)} · {children.length} 个相册 · {fmtInt(photos)} 张
            {videos ? ` · ${videos} 段视频` : ''}
          </div>
        </div>
        <button className="btn" onClick={() => onOpen(album.id)}>
          查看合集
          <Icon name="right" className="icon sm" />
        </button>
      </div>
      <div className="collection-scroll">
        {children.map((c) => (
          <MiniCard key={c.id} album={c} onOpen={onOpen} />
        ))}
      </div>
    </Reveal>
  );
}

export function Timeline({
  library, onOpenAlbum, onOpenAll, onOpenFavorites, selectedCount, showSensitive, onToggleSensitive,
}: {
  library: LibraryPayload;
  onOpenAlbum: (id: string) => void;
  onOpenAll: () => void;
  onOpenFavorites: () => void;
  selectedCount: number;
  showSensitive: boolean;
  onToggleSensitive: () => void;
}) {
  const byParent = new Map<string | null, AlbumSummary[]>();
  for (const r of library.records) {
    const key = r.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }
  const years = [...library.years].sort((a, b) => b.year - a.year);
  const hiddenCount = library.records.filter((r) => r.sensitive && !r.isCollection).length;
  const visible = (r: AlbumSummary) => showSensitive || !r.sensitive;

  return (
    <div className="wrap" id="timeline">
      {years.map((y, yi) => {
        const top = (byParent.get(null) || [])
          .filter((r) => r.year === y.year)
          .filter(visible)
          // newest first inside the year too, so the whole page reads backwards in time
          .sort((a, b) => new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime());
        if (!top.length) return null;
        const all = library.records.filter((r) => r.year === y.year);
        const photos = all.reduce((s, r) => s + r.photoCount, 0);
        const curated = all.reduce((s, r) => s + r.curatedCount, 0);
        const videos = all.reduce((s, r) => s + r.videoCount, 0);
        return (
          <section className="year-block" id={`year-${y.year}`} key={y.year}>
            <div className="year-head">
              <div className="year-num">{y.year}</div>
              <div className="year-meta">
                <span className="t">{fmtInt(photos)} 张照片 · {fmtInt(curated)} 张精选</span>
                <span className="s">
                  {top.length} stories{videos ? ` · ${videos} clips` : ''}
                </span>
              </div>
            </div>
            <div className="album-grid">
              {top.map((album, i) => {
                const kids = album.isCollection
                  ? (byParent.get(album.id) || [])
                      .filter(visible)
                      .sort((a, b) => new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime())
                  : [];
                if (album.isCollection) {
                  return <CollectionBlock key={album.id} album={album} children={kids} onOpen={onOpenAlbum} />;
                }
                return <AlbumCard key={album.id} album={album} onOpen={onOpenAlbum} index={i} />;
              })}
              {yi === 0 ? (
                <Reveal className="collection" delay={120}>
                  <div className="collection-head" style={{ marginBottom: 0, alignItems: 'center' }}>
                    <div>
                      <h3 className="collection-title">不想按故事看？</h3>
                      <div className="collection-sub">按拍摄时间铺开全部照片，或者直接进收藏夹</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={onOpenAll}>
                        <Icon name="layers" className="icon sm" />
                        全部照片
                      </button>
                      <button className="btn solid" onClick={onOpenFavorites}>
                        <Icon name="heart" className="icon sm" filled={selectedCount > 0} />
                        收藏夹 {selectedCount > 0 ? selectedCount : ''}
                      </button>
                    </div>
                  </div>
                </Reveal>
              ) : null}
            </div>
          </section>
        );
      })}

      <footer className="footer">
        <span>光影志 · 本地私人影像档案</span>
        {hiddenCount > 0 ? (
          <button className="btn ghost" onClick={onToggleSensitive} style={{ fontSize: 11.5, height: 28 }}>
            <Icon name={showSensitive ? 'check' : 'pin'} className="icon sm" />
            {showSensitive ? '隐藏隐私相册' : `显示隐私相册（${hiddenCount}）`}
          </button>
        ) : null}
        <span className="mono">{library.root}</span>
        <span className="mono">更新于 {fmtDate(library.generatedAt, true)}</span>
      </footer>
    </div>
  );
}
