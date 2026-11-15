import { useMemo } from 'react';
import type { LibraryPayload, Photo } from './api';
import { fmtBytes, fmtDate, fmtInt, LoadedImg, useCountUp } from './ui';

/** A slow, cinematic wall of memories behind the title. */
function HeroWall({ photos }: { photos: Photo[] }) {
  const rows = useMemo(() => {
    const usable = photos.filter((p) => p.thumb);
    const half = Math.ceil(usable.length / 2);
    return [usable.slice(0, half), usable.slice(half)];
  }, [photos]);

  return (
    <div className="hero-wall" aria-hidden="true">
      {rows.map((row, ri) => (
        <div className={`hero-row ${ri === 0 ? 'up' : 'down'}`} key={ri}>
          {[...row, ...row, ...row, ...row].map((p, i) => (
            <span
              className="hero-cell"
              key={`${ri}-${i}-${p.id}`}
              style={{ aspectRatio: `${p.w || 3} / ${p.h || 2}` }}
            >
              <LoadedImg
                src={`/thumb/${p.thumb}`}
                alt=""
                className=""
                eager
              />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Stat({ value, suffix, label }: { value: number; suffix?: string; label: string }) {
  const n = useCountUp(value, 1600);
  return (
    <div className="hero-stat">
      <span className="v">
        {fmtInt(n)}
        {suffix ? <span style={{ fontSize: '0.5em', marginLeft: 4, opacity: 0.6 }}>{suffix}</span> : null}
      </span>
      <span className="k">{label}</span>
    </div>
  );
}

export function Hero({ library }: { library: LibraryPayload }) {
  const years = library.years.map((y) => y.year);
  const span = years.length ? `${Math.min(...years)} — ${Math.max(...years)}` : '';
  const oldest = useMemo(() => {
    const dates = library.records
      .filter((r) => r.startDate && !r.isCollection)
      .map((r) => new Date(r.startDate as string).getTime())
      .filter((n) => Number.isFinite(n));
    return dates.length ? fmtDate(new Date(Math.min(...dates)).toISOString()) : '';
  }, [library.records]);

  return (
    <header className="hero">
      <HeroWall photos={library.featured} />
      <div className="hero-scrim" />
      <div className="hero-content">
        <div className="hero-eyebrow">
          <span className="line" />
          <span className="eyebrow">Private archive · {span}</span>
        </div>
        <h1 className="hero-title">光影志</h1>
        <p className="hero-blurb">
          从 <em>{oldest}</em> 至今，<em>{fmtInt(library.stats.albums)}</em> 个故事被收进这间暗房。
          按时间倒序铺开，先看每段日子里的精选，再往下翻，就是全部。
        </p>
        <div className="hero-stats">
          <Stat value={library.stats.photos} label="Photos 照片" />
          <Stat value={library.stats.curated} label="Selected 精选" />
          <Stat value={library.stats.videos} label="Videos 视频" />
          <Stat value={library.stats.days} label="Days 拍摄日" />
          <Stat value={Math.round(library.stats.bytes / 1073741824)} suffix="GB" label="Library 容量" />
        </div>
      </div>
      <div className="hero-scroll">
        <span>Scroll</span>
        <span className="track" />
      </div>
    </header>
  );
}
