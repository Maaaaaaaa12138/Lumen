import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export function Lightbox({
  items, index, onIndex, onClose, isSelected, onToggleSelect, autoplay = false, showReveal = true,
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
}) {
  const item = items[index];
  const toast = useToast();
  const [zoom, setZoom] = useState(false);
  const [info, setInfo] = useState(false);
  const [playing, setPlaying] = useState(autoplay);
  const [original, setOriginal] = useState(false);
  const [origSrc, setOrigSrc] = useState<string | null>(null);
  const [origLoading, setOrigLoading] = useState(false);
  const [imgReady, setImgReady] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);

  // zoom + drag-to-pan, so "查看原图" is actually usable for checking detail
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= items.length) return;
      onIndex(next);
    },
    [index, items.length, onIndex],
  );

  // reset per-slide state
  useEffect(() => {
    setZoom(false);
    setImgReady(false);
    setPan({ x: 0, y: 0 });
  }, [index, item?.key]);

  useEffect(() => {
    if (!zoom) setPan({ x: 0, y: 0 });
  }, [zoom]);

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
      setOrigSrc(url);
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
      if (index >= items.length - 1) onIndex(0);
      else go(1);
    }, 3200);
    return () => window.clearTimeout(t);
  }, [playing, index, items.length, go, onIndex]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoom) setZoom(false);
        else onClose();
      } else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'f' || e.key === 'F') {
        if (item) onToggleSelect(item.kind === 'photo' ? item.id : item.id);
      } else if (e.key === 'i' || e.key === 'I') setInfo((v) => !v);
      else if (e.key === 'o' || e.key === 'O') {
        if (item?.kind === 'photo') setOriginal((v) => !v);
      } else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose, onToggleSelect, item, zoom]);

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

  if (!item) return null;

  const ratio = item.w && item.h ? item.w / item.h : 1.5;
  const isVideo = item.kind === 'video';

  return (
    <div className="lb" role="dialog" aria-modal="true" aria-label="照片查看器">
      <div className="lb-top">
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
                  () => toast('已在资源管理器打开'),
                  (err: Error) => toast(err.message || '打开失败', 'close'),
                );
              }}
            >
              <Icon name="folder" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="lb-stage">
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
            className={`lb-frame${zoom ? ' zoomed' : ''}`}
            style={{ aspectRatio: String(ratio), width: `min(${ratio >= 1 ? '88vw' : `calc(78vh * ${ratio})`}, ${ratio >= 1 ? `calc(78vh * ${ratio})` : '78vw'})` }}
            onPointerDown={(e) => {
              if (!zoom) return;
              suppressClick.current = false;
              dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, moved: false };
              try {
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              } catch {
                /* synthetic pointers (tests) have no capture target */
              }
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              const dx = e.clientX - d.sx;
              const dy = e.clientY - d.sy;
              if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
              setPan({
                x: Math.max(-700, Math.min(700, d.ox + dx)),
                y: Math.max(-500, Math.min(500, d.oy + dy)),
              });
            }}
            onPointerUp={() => {
              if (dragRef.current?.moved) suppressClick.current = true;
              dragRef.current = null;
            }}
            onPointerCancel={() => {
              dragRef.current = null;
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
              className="lb-img"
              src={origSrc || previewUrl(item.id)}
              alt={item.name}
              style={{
                opacity: imgReady ? 1 : 0,
                transition: 'opacity .4s ease',
                transform: zoom ? `scale(2.2) translate(${pan.x / 2.2}px, ${pan.y / 2.2}px)` : undefined,
                cursor: zoom ? 'grab' : 'zoom-in',
                userSelect: 'none',
              }}
              draggable={false}
              onLoad={() => setImgReady(true)}
              onError={(e) => {
                const el = e.currentTarget as HTMLImageElement;
                if (item.thumb && !el.src.includes('/thumb/')) el.src = `/thumb/${item.thumb}`;
                setImgReady(true);
              }}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                setZoom((v) => !v);
              }}
            />
          </div>
        )}
      </div>

      <button className="lb-nav prev" onClick={() => go(-1)} disabled={index === 0} aria-label="上一张">
        <Icon name="left" />
      </button>
      <button className="lb-nav next" onClick={() => go(1)} disabled={index === items.length - 1} aria-label="下一张">
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
                onClick={() => onIndex(realIndex)}
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
          <span>
            <kbd>F</kbd> 收藏
          </span>
          <span>
            <kbd>O</kbd> 原图
          </span>
          <span>
            <kbd>I</kbd> 信息
          </span>
          <span>
            <kbd>空格</kbd> 幻灯片
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
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
