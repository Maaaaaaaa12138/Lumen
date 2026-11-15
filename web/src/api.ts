export type Cover = { id: string; thumb: string; w: number; h: number; isVideo: boolean };

export type Photo = {
  id: string;
  thumb: string;
  w: number;
  h: number;
  date: string;
  bytes: number;
  name: string;
  tier: 0 | 1;
  color: string | null;
  broken: boolean;
  albumId?: string;
  albumTitle?: string;
};

export type Video = {
  id: string;
  name: string;
  thumb: string | null;
  w: number | null;
  h: number | null;
  date: string;
  bytes: number;
  duration: number | null;
  posterId: string | null;
};

export type AlbumSummary = {
  id: string;
  parentId: string | null;
  year: number;
  title: string;
  folderName: string;
  startDate: string | null;
  endDate: string | null;
  dateLabel: string;
  datePrecision: string;
  photoCount: number;
  curatedCount: number;
  derivedCurated: boolean;
  videoCount: number;
  childIds: string[];
  isCollection: boolean;
  covers: Cover[];
  coverIds: string[];
  depth: number;
  sensitive: boolean;
  bytes: number;
};

export type AlbumDetail = AlbumSummary & {
  photos: Photo[];
  curated: string[];
  videos: Video[];
};

export type Stats = {
  albums: number;
  collections: number;
  photos: number;
  curated: number;
  videos: number;
  bytes: number;
  photoBytes: number;
  videoBytes: number;
  days: number;
  years: number;
};

export type ThumbStats = {
  total: number;
  done: number;
  failed: number;
  pending: number;
  active: number;
  rate: number;
  etaSec: number | null;
  bytes: number;
  paused?: boolean;
  complete: boolean;
};

export type LibraryPayload = {
  phase: 'ready' | 'indexing';
  root: string;
  /** True when the page is opened on the machine that runs the server. */
  localClient?: boolean;
  generatedAt: string;
  stats: Stats;
  years: { year: number; label: string; recordCount: number }[];
  timeline: string[];
  featured: Photo[];
  records: AlbumSummary[];
  selections: string[];
  thumbs: ThumbStats;
};

export type StatusPayload = {
  phase: 'booting' | 'indexing' | 'ready' | 'error';
  progress: { phase: string; message?: string; done?: number; total?: number };
  error: string | null;
  library: { generatedAt: string; stats: Stats } | null;
  thumbs: ThumbStats;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  library: () => fetch('/api/library').then((r) => json<LibraryPayload>(r)),
  album: (id: string) => fetch(`/api/album?id=${encodeURIComponent(id)}`).then((r) => json<{ album: AlbumDetail }>(r)),
  photos: (offset: number, limit: number, year?: number | null) =>
    fetch(`/api/photos?offset=${offset}&limit=${limit}${year ? `&year=${year}` : ''}`).then((r) =>
      json<{ total: number; offset: number; limit: number; photos: Photo[] }>(r),
    ),
  search: (q: string) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => json<{ albums: AlbumSummary[]; photos: Photo[] }>(r)),
  resolve: (ids: string[]) =>
    fetch('/api/photos/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).then((r) => json<{ photos: Photo[]; missing: string[] }>(r)),
  status: () => fetch('/api/status').then((r) => json<StatusPayload>(r)),
  select: (id: string, on: boolean) =>
    fetch('/api/selections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, on }),
    }).then((r) => json<{ ok: boolean; count: number; ids: string[] }>(r)),
  selectMany: (ids: string[], on: boolean) =>
    fetch('/api/selections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, on }),
    }).then((r) => json<{ ok: boolean; count: number; ids: string[] }>(r)),
  clearSelections: () =>
    fetch('/api/selections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }).then((r) => json<{ ok: boolean; count: number; ids: string[] }>(r)),
  reveal: async (id: string) => {
    const res = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) throw new Error(body.error || `打开失败（${res.status}）`);
    return body as { ok: boolean };
  },
  poster: (id: string, data: string) =>
    fetch('/api/poster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, data }),
    }).then((r) => json<{ ok: boolean; thumb: string }>(r)),
  setThumbPaused: (paused: boolean) =>
    fetch('/api/thumbs/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused }),
    }).then((r) => json<{ ok: boolean; paused: boolean; stats: ThumbStats }>(r)),
};

/** UTF-8 safe base64url, mirroring the server's decodeId(). */
export function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const mediaUrl = (id: string) => `/media?id=${toBase64Url(id)}`;
export const previewUrl = (id: string) => `/preview?id=${toBase64Url(id)}`;
export const thumbUrl = (key: string) => `/thumb/${key}`;
export const blurUrl = (key: string) => `/blur/${key}`;

/** Warm the 1920px preview so the lightbox opens instantly. */
const prefetched = new Set<string>();
export function prefetchPreview(id: string) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  const img = new Image();
  img.decoding = 'async';
  img.src = previewUrl(id);
}
