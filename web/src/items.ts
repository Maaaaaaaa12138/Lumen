import type { Photo, Video } from './api';
import type { LensItem } from './Lightbox';

export function photoItem(p: Photo, albumTitle?: string, albumId?: string): LensItem {
  return {
    key: p.id,
    kind: 'photo',
    id: p.id,
    thumb: p.thumb,
    name: p.name,
    date: p.date,
    bytes: p.bytes,
    w: p.w,
    h: p.h,
    albumTitle,
    albumId,
  };
}

export function videoItem(v: Video, albumTitle?: string, albumId?: string, posterOverride?: string): LensItem {
  return {
    key: v.id,
    kind: 'video',
    id: v.id,
    thumb: posterOverride || v.thumb,
    name: v.name,
    date: v.date,
    bytes: v.bytes,
    w: v.w,
    h: v.h,
    duration: v.duration,
    albumTitle,
    albumId,
  };
}
