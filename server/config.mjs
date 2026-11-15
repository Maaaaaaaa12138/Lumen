import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the project root (the folder that holds server/ and web/). */
export const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Where the photo library lives. Override with GALLERY_ROOT. */
export const LIBRARY_ROOT = path.resolve(process.env.GALLERY_ROOT || 'E:/share/image');

/** Generated artefacts (thumbnails, caches). Git-ignored, never inside the library. */
export const CACHE_DIR = path.join(PROJECT_ROOT, '.cache');
export const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
export const META_CACHE_FILE = path.join(CACHE_DIR, 'meta-cache.json');
export const SELECTION_FILE = path.join(CACHE_DIR, 'selections.json');
export const INDEX_FILE = path.join(CACHE_DIR, 'library.json');
export const POSTER_DIR = path.join(CACHE_DIR, 'posters');

export const WEB_DIST = path.join(PROJECT_ROOT, 'dist');

/** HTTP server. Binds all interfaces so the gallery is reachable from a phone. */
export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '0.0.0.0';

/** Thumbnail ladder. */
export const THUMB_LONG_EDGE = 800;   // grid / lightbox placeholder
export const THUMB_QUALITY = 80;
export const BLUR_LONG_EDGE = 24;     // LQIP
export const BLUR_QUALITY = 40;

/** How many images we decode at once. libvips already parallelises, so 6 is plenty. */
export const THUMB_CONCURRENCY = Number(process.env.THUMB_CONCURRENCY || 10);
/** Header-only probe concurrency (EXIF + dimensions). Cheap, so run wide. */
export const PROBE_CONCURRENCY = 24;

/** Album nesting: year/<album> is depth 1, year/<album>/<album> is depth 2. */
export const MAX_ALBUM_DEPTH = 2;
/** Auto "精选" size when an album has no hand-edited out/ folder. */
export const AUTO_CURATED_COUNT = 12;

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.avif', '.heic', '.heif']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.mts', '.m2ts']);
export const RAW_EXT = new Set(['.arw', '.nef', '.cr3', '.cr2', '.dng', '.orf', '.rw2', '.raf', '.srw', '.pef', '.psd', '.psb', '.xmp', '.acr', '.xml', '.thm']);

/** Folders that never contain gallery media we care about. */
export const IGNORE_DIR_NAMES = new Set(['raw', 'psd', 'thmbnl', 'take', 'sub', 'lut', 'general', 'clips']);
/** Folders holding the hand-edited keepers. */
export const CURATED_DIR_NAMES = new Set(['out', '官方返图', '精选', '精修', 'finals']);
/** Folders that are just a container for the ordinary JPEGs. */
export const PLAIN_DIR_NAMES = new Set(['jpg', 'jpeg', 'photos', 'images', 'dcim']);

/** Folder names that are skipped entirely at the library root. */
export const IGNORED_ROOT_NAMES = new Set(['延迟']);
