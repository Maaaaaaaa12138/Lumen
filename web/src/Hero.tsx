import type { Backdrop } from './api';
import { Icon } from './ui';

/**
 * The landing view: one photograph, the place it was taken, the day it was
 * taken, and three quiet things to do next. No carousel, no stat wall.
 */
export function Hero({ backdrop, onCustomize }: { backdrop: Backdrop | null; onCustomize: () => void }) {
  const title = backdrop?.title?.trim() || '光影志';
  const date = backdrop?.date?.trim() || '';
  const place = backdrop?.place?.trim() || '';
  const meta = [date, place && place !== title ? place : ''].filter(Boolean);
  const albumId = backdrop?.source?.albumId || '';
  // Long custom titles get a smaller scale instead of pushing the buttons off-screen.
  const titleClass = title.length > 20 ? ' long' : title.length > 12 ? ' mid' : '';

  const goTimeline = () => {
    document.getElementById('timeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <header className="hero">
      <div className="hero-scrim" />
      <div className="hero-inner">
        {meta.length ? (
          <div className="hero-meta">
            {meta.map((item, i) => (
              <span className="hero-meta-item" key={`${item}-${i}`}>
                {i ? <i className="hero-sep" /> : null}
                {item}
              </span>
            ))}
          </div>
        ) : null}

        <h1 className={`hero-title${titleClass}`}>{title}</h1>

        <div className="hero-actions">
          <button type="button" className="hero-btn primary" onClick={goTimeline}>
            浏览照片
            <Icon name="down" className="icon sm" />
          </button>
          <a className="hero-btn" href={albumId ? `#/album/${encodeURIComponent(albumId)}` : '#/all'}>
            {albumId ? '打开相册' : '全部照片'}
            <Icon name="external" className="icon sm" />
          </a>
          <button type="button" className="hero-btn text" onClick={onCustomize}>
            <Icon name="image" className="icon sm" />
            更换背景
          </button>
        </div>
      </div>
    </header>
  );
}
