import { useEffect, useRef, useState } from 'react';
import {
  api, blurUrl, previewUrl,
  type Backdrop as BackdropData, type BackdropCandidate, type BackdropUpload,
} from './api';
import { Icon } from './ui';

/**
 * The fixed, full-viewport photograph behind the whole site.
 *
 * Two layers: an inline 24px LQIP that paints immediately, then the untouched
 * original which fades in whenever it finishes downloading. Nothing here ever
 * blocks the first paint.
 */
export function Backdrop({ image, mode }: { image: BackdropData['image'] | null; mode: 'boot' | 'home' | 'page' }) {
  const veil = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [fillLoaded, setFillLoaded] = useState<string | null>(null);

  useEffect(() => {
    const el = veil.current;
    if (!el) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (mode !== 'home') {
        // A CSS variable lets each theme decide how heavy the paper veil is.
        el.style.setProperty('--veil', mode === 'boot' ? '0' : '1');
        return;
      }
      const vh = window.innerHeight || 1;
      const p = Math.min(1, Math.max(0, window.scrollY / (vh * 0.8)));
      el.style.setProperty('--veil', p.toFixed(3));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [mode]);

  return (
    <div
      className={`backdrop mode-${mode}${image && loaded === image.url ? ' loaded' : ''}`}
      style={image?.color ? { backgroundColor: image.color } : undefined}
      aria-hidden="true"
    >
      {image ? (
        <>
          <span
            className="backdrop-ph"
            style={image.placeholder ? { backgroundImage: `url("${image.placeholder}")` } : undefined}
          />
          {image.fill ? (
            <img
              key={`fill:${image.fill}`}
              className={`backdrop-fill${fillLoaded === image.fill ? ' loaded' : ''}`}
              src={image.fill}
              alt=""
              decoding="async"
              ref={(el) => {
                if (el && el.complete && el.naturalWidth > 0) setFillLoaded(image.fill);
              }}
              onLoad={() => setFillLoaded(image.fill)}
            />
          ) : null}
          <img
            key={image.url}
            className="backdrop-img"
            src={image.url}
            alt=""
            decoding="async"
            fetchPriority="high"
            ref={(el) => {
              // A cached original can finish before React attaches onLoad.
              if (el && el.complete && el.naturalWidth > 0) setLoaded(image.url);
            }}
            onLoad={() => setLoaded(image.url)}
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden';
            }}
          />
        </>
      ) : null}
      <div className="backdrop-top" />
      <div className="backdrop-veil" ref={veil} />
    </div>
  );
}

/* --------------------------------------------------------------- customizer */

type Pending =
  | { kind: 'photo'; photoId: string; thumb: string; label: string }
  | { kind: 'upload'; upload: BackdropUpload };

export function BackdropSheet({
  current, onClose, onSaved,
}: {
  current: BackdropData;
  onClose: () => void;
  onSaved: (next: BackdropData) => void;
}) {
  const [base, setBase] = useState(current);
  const [pending, setPending] = useState<Pending | null>(null);
  const [title, setTitle] = useState(current.title);
  const [date, setDate] = useState(current.date);
  const [place, setPlace] = useState(current.place);
  const [candidates, setCandidates] = useState<BackdropCandidate[] | null>(null);
  const [busy, setBusy] = useState<'load' | 'upload' | 'save' | 'reset' | null>('load');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    api.backdropCandidates()
      .then((res) => alive && setCandidates(res.photos))
      .catch(() => alive && setCandidates([]))
      .finally(() => alive && setBusy((b) => (b === 'load' ? null : b)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = (() => {
    if (pending?.kind === 'photo') {
      return { src: previewUrl(pending.photoId), ph: blurUrl(pending.thumb), tag: pending.label };
    }
    if (pending?.kind === 'upload') {
      return { src: pending.upload.url, ph: pending.upload.placeholder, tag: pending.upload.name };
    }
    if (!base.image) return { src: null, ph: null, tag: null };
    const fromLibrary = base.source?.kind === 'photo' && base.source.photoId;
    return {
      src: fromLibrary ? previewUrl(base.source!.photoId!) : base.image.url,
      ph: base.image.placeholder,
      tag: fromLibrary ? '来自照片库' : '已上传',
    };
  })();

  const pickPhoto = (candidate: BackdropCandidate) => {
    setError(null);
    setPending({ kind: 'photo', photoId: candidate.id, thumb: candidate.thumb, label: candidate.albumTitle });
    setTitle(candidate.title);
    setDate(candidate.date);
    setPlace(candidate.place);
  };

  const uploadFile = async (file: File) => {
    setError(null);
    if (file.size > 80 * 1024 * 1024) {
      setError('图片太大了，最大 80 MB');
      return;
    }
    setBusy('upload');
    try {
      const upload = await api.uploadBackdrop(file);
      setPending({ kind: 'upload', upload });
      setTitle('');
      setDate(upload.date);
      setPlace('');
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setError(null);
    setBusy('save');
    try {
      const patch: Record<string, string> = { title, date, place };
      if (pending?.kind === 'photo') patch.photoId = pending.photoId;
      else if (pending?.kind === 'upload') patch.uploadToken = pending.upload.token;
      const next = await api.setBackdrop(patch);
      onSaved(next);
      onClose();
    } catch (err) {
      setError(String((err as Error).message || err));
      setBusy(null);
    }
  };

  const reset = async () => {
    setError(null);
    setBusy('reset');
    try {
      const next = await api.setBackdrop({ reset: true });
      setBase(next);
      setPending(null);
      setTitle(next.title);
      setDate(next.date);
      setPlace(next.place);
      onSaved(next);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sheet bg-sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-inner">
        <div className="sheet-head">
          <div>
            <h2 className="sheet-title">全站背景</h2>
            <p className="bg-sub">全屏展示原图 · 先出缩略图再异步换清晰大图</p>
          </div>
          <button className="btn icon sheet-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>

        <div className="bg-layout">
          <div>
            <Preview src={preview.src} placeholder={preview.ph} tag={preview.tag} />
            <div className="bg-hint">
              <Icon name="info" className="icon sm" />
              主页大图直接使用原文件（不压缩）；顶部文字可留空，留空时自动用相册名和拍摄日期。
            </div>
          </div>

          <div className="bg-form">
            <label className="bg-field">
              <span>标题</span>
              <input
                value={title}
                maxLength={40}
                placeholder="例如 国庆 · 国家植物园"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="bg-field-row">
              <label className="bg-field">
                <span>时间</span>
                <input value={date} maxLength={24} placeholder="2026.10.06" onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="bg-field">
                <span>地点</span>
                <input value={place} maxLength={40} placeholder="国家植物园" onChange={(e) => setPlace(e.target.value)} />
              </label>
            </div>

            <div className="bg-actions">
              <button className="btn solid" disabled={Boolean(busy)} onClick={() => void save()}>
                {busy === 'save' ? <span className="spinner" /> : <Icon name="check" className="icon sm" />}
                保存
              </button>
              <button className="btn" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
                {busy === 'upload' ? <span className="spinner" /> : <Icon name="plus" className="icon sm" />}
                上传图片
              </button>
              <button className="btn ghost" disabled={Boolean(busy)} onClick={() => void reset()}>
                恢复自动
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void uploadFile(file);
                }}
              />
            </div>
            {error ? <div className="bg-error">{error}</div> : null}
            <p className="bg-note">
              支持 JPG / PNG / WebP / AVIF，最大 80 MB。上传的照片原样保存到 .cache/backdrop/，不会改动任何原图。
            </p>
          </div>
        </div>

        <div className="bg-section">
          <div className="bg-section-head">
            <h5>从照片库里挑一张</h5>
            <span className="bg-note">横构图优先 · 最近日期在前</span>
          </div>
          {candidates === null ? (
            <div className="bg-loading">
              <span className="spinner" />
              正在整理候选照片…
            </div>
          ) : candidates.length === 0 ? (
            <div className="bg-note">照片库里还没有可用的横图，可以直接上传一张。</div>
          ) : (
            <div className="bg-grid">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`bg-thumb${pending?.kind === 'photo' && pending.photoId === c.id ? ' active' : ''}`}
                  title={`${c.title}${c.date ? ` · ${c.date}` : ''}`}
                  onClick={() => pickPhoto(c)}
                >
                  <img src={`/thumb/${c.thumb}`} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Preview({ src, placeholder, tag }: { src: string | null; placeholder: string | null; tag: string | null }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <div className="bg-preview">
      {placeholder ? (
        <span className="bg-preview-ph" style={{ backgroundImage: `url("${placeholder}")` }} />
      ) : null}
      {src ? (
        <img
          key={src}
          className={loaded === src ? 'loaded' : ''}
          src={src}
          alt=""
          decoding="async"
          ref={(el) => {
            if (el && el.complete && el.naturalWidth > 0) setLoaded(src);
          }}
          onLoad={() => setLoaded(src)}
        />
      ) : (
        <span className="bg-preview-empty">还没有设置背景图</span>
      )}
      {tag ? <span className="bg-preview-tag">{tag}</span> : null}
    </div>
  );
}
