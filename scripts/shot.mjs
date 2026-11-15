import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal CDP driver: launch headless Chrome, drive a page, capture screenshots.
 * Usage: node scripts/shot.mjs <outPrefix> [--width=1600] [--height=1000]
 * Each scenario below navigates / scrolls / clicks, then writes a PNG.
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT_DIR = path.resolve('scripts/shots');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const width = Number(args.width || 1600);
const height = Number(args.height || 1000);

fs.mkdirSync(OUT_DIR, { recursive: true });

const userDataDir = path.join(process.env.TEMP || '/tmp', `cdp-shot-${Date.now()}`);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('chrome did not expose a page target');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 60000);
    });
  }
  async navigate(url) {
    await this.send('Page.navigate', { url });
    await sleep(1200);
  }
  async eval(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    return res.result?.value;
  }
  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    const size = fs.statSync(file).size;
    console.log(`  → ${path.relative(process.cwd(), file)} (${(size / 1024).toFixed(0)} KB)`);
  }
  async waitFor(expression, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(expression)) return true;
      await sleep(250);
    }
    return false;
  }
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: false,
});

const scenarios = {
  async home() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.hero-title')`);
    await sleep(4000);
    await cdp.shot(path.join(OUT_DIR, 'home-hero.png'));
  },
  async timeline() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.album-card')`);
    await cdp.eval(`document.getElementById('timeline')?.scrollIntoView()`);
    await sleep(2500);
    await cdp.shot(path.join(OUT_DIR, 'home-timeline.png'));
    await cdp.eval(`window.scrollBy(0, ${height})`);
    await sleep(2200);
    await cdp.shot(path.join(OUT_DIR, 'home-timeline-2.png'));
    await cdp.eval(`window.scrollBy(0, ${height * 3})`);
    await sleep(2200);
    await cdp.shot(path.join(OUT_DIR, 'home-timeline-3.png'));
  },
  async album() {
    const id = String(args.album || '2026/1101慕田峪');
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent(id)}`);
    await cdp.waitFor(`!!document.querySelector('.detail-title')`);
    await sleep(3500);
    await cdp.shot(path.join(OUT_DIR, 'album-curated.png'));
    const clicked = await cdp.eval(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('全部'));
      if (tab) { tab.click(); return tab.textContent; }
      return null;
    })()`);
    console.log('  tab:', clicked);
    await sleep(3000);
    await cdp.shot(path.join(OUT_DIR, 'album-all.png'));
  },
  async albumOut() {
    const id = String(args.albumOut || '2024/2024清明天津游');
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent(id)}`);
    await cdp.waitFor(`!!document.querySelector('.masonry')`);
    await sleep(3500);
    await cdp.shot(path.join(OUT_DIR, 'album-out.png'));
  },
  async collection() {
    const id = String(args.collection || '2026/国庆');
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent(id)}`);
    await cdp.waitFor(`!!document.querySelector('.detail-title')`);
    await sleep(3000);
    await cdp.shot(path.join(OUT_DIR, 'album-collection.png'));
  },
  async lightbox() {
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent(String(args.albumOut || '2024/2024清明天津游'))}`);
    await cdp.waitFor(`!!document.querySelector('.masonry .tile')`);
    await sleep(3000);
    await cdp.eval(`document.querySelector('.masonry .tile')?.click()`);
    await sleep(3000);
    await cdp.shot(path.join(OUT_DIR, 'lightbox.png'));
    await cdp.eval(`document.querySelectorAll('.lb-tools .lb-btn')[1]?.click()`);
    await sleep(900);
    await cdp.shot(path.join(OUT_DIR, 'lightbox-info.png'));
    await cdp.eval(`document.querySelector('.lb-btn')?.click()`);
    await sleep(600);
  },
  async favorites() {
    await cdp.navigate(`${BASE}/#/favorites`);
    await sleep(2200);
    await cdp.shot(path.join(OUT_DIR, 'favorites.png'));
  },
  async all() {
    await cdp.navigate(`${BASE}/#/all`);
    await cdp.waitFor(`!!document.querySelector('.month-head')`);
    await sleep(3200);
    await cdp.shot(path.join(OUT_DIR, 'all-photos.png'));
  },
  async search() {
    await cdp.navigate(`${BASE}/#/`);
    await sleep(1800);
    await cdp.eval(`document.querySelector('.nav-link[aria-label="搜索"]')?.click()`);
    await sleep(700);
    await cdp.eval(`(() => {
      const input = document.querySelector('.search-box input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '秦皇岛');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2500);
    await cdp.shot(path.join(OUT_DIR, 'search.png'));
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
    await sleep(500);
  },
  async y2023() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.album-card')`);
    await sleep(3000);
    await cdp.eval(`document.getElementById('year-2023')?.scrollIntoView()`);
    await sleep(2500);
    await cdp.shot(path.join(OUT_DIR, 'year-2023.png'));
    await cdp.eval(`window.scrollBy(0, ${height})`);
    await sleep(2200);
    await cdp.shot(path.join(OUT_DIR, 'year-2023b.png'));
  },
  async videos() {
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent(String(args.videos || '2024/0626野生动物园'))}`);
    await cdp.waitFor(`!!document.querySelector('.tab')`);
    await sleep(2500);
    await cdp.eval(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('视频'));
      tab?.click();
    })()`);
    await sleep(3000);
    await cdp.shot(path.join(OUT_DIR, 'album-videos.png'));
    await cdp.eval(`document.querySelector('.tile.video')?.click()`);
    await sleep(4000);
    await cdp.shot(path.join(OUT_DIR, 'video-player.png'));
    await cdp.eval(`document.querySelector('.lb-btn')?.click()`);
    await sleep(500);
  },
  async diag() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.hero-title')`);
    await sleep(1500);
    const dump = await cdp.eval(`(() => {
      const out = {};
      const cs = getComputedStyle(document.documentElement);
      out.theme = document.documentElement.dataset.theme;
      out.stored = localStorage.getItem('lumen-theme');
      out.vars = {
        bg: cs.getPropertyValue('--bg').trim(),
        ink: cs.getPropertyValue('--ink').trim(),
        ink2: cs.getPropertyValue('--ink-2').trim(),
      };
      const body = getComputedStyle(document.body);
      out.body = { bg: body.backgroundColor, color: body.color, fontFamily: body.fontFamily.slice(0, 40) };
      const pick = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        const o = {};
        for (const p of props) o[p] = s.getPropertyValue(p).slice(0, 120);
        return o;
      };
      out.brand = pick('.brand-name', ['color', 'font-family']);
      out.title = pick('.hero-title', ['background-image', 'color', '-webkit-text-fill-color']);
      out.scrim = pick('.hero-scrim', ['background-image']);
      out.blurb = pick('.hero-blurb', ['color']);
      out.statK = pick('.hero-stat .k', ['color']);
      return out;
    })()`);
    console.log(JSON.stringify(dump, null, 2));
    await cdp.eval(`document.documentElement.dataset.theme='light'; localStorage.setItem('lumen-theme','light');`);
    await sleep(600);
    const light = await cdp.eval(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const pick = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        const o = {};
        for (const p of props) o[p] = s.getPropertyValue(p).slice(0, 120);
        return o;
      };
      return {
        theme: document.documentElement.dataset.theme,
        vars: { bg: cs.getPropertyValue('--bg').trim(), ink: cs.getPropertyValue('--ink').trim() },
        body: { bg: body.backgroundColor, color: body.color },
        brand: pick('.brand-name', ['color']),
        title: pick('.hero-title', ['background-image', '-webkit-text-fill-color']),
        scrim: pick('.hero-scrim', ['background-image']),
        blurb: pick('.hero-blurb', ['color']),
        statK: pick('.hero-stat .k', ['color']),
      };
    })()`);
    console.log('--- after switching to light ---');
    console.log(JSON.stringify(light, null, 2));
    await cdp.eval(`document.documentElement.dataset.theme='dark'; localStorage.setItem('lumen-theme','dark');`);
  },
  async backNav() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.album-card')`);
    await sleep(2500);
    const order = await cdp.eval(`(() => {
      const year = document.querySelector('.year-block');
      return [...year.querySelectorAll('.album-title')].slice(0, 6).map((t) => t.textContent);
    })()`);
    console.log('  2026 first albums:', JSON.stringify(order));
    const dates = await cdp.eval(`(() => {
      const year = document.querySelector('.year-block');
      return [...year.querySelectorAll('.album-date .d')].slice(0, 6).map((t) => t.textContent);
    })()`);
    console.log('  their dates:', JSON.stringify(dates));
    await cdp.eval(`window.scrollTo({ top: 2600, behavior: 'instant' })`);
    await sleep(900);
    const before = await cdp.eval(`Math.round(window.scrollY)`);
    const clicked = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.album-card')];
      const target = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return r.top > 80 && r.top < 520;
      });
      if (!target) return null;
      const t = target.querySelector('.album-title')?.textContent;
      target.click();
      return t;
    })()`);
    await sleep(3200);
    const hash = await cdp.eval(`location.hash`);
    await cdp.shot(path.join(OUT_DIR, 'backnav-album.png'));
    await cdp.eval(`document.querySelector('.backlink')?.click()`);
    await sleep(2600);
    const after = await cdp.eval(`Math.round(window.scrollY)`);
    console.log(`  scrolled ${before} → clicked "${clicked}" → ${hash} → back → ${after} (${Math.abs(after - before) < 80 ? 'RESTORED' : 'LOST'})`);
    await cdp.shot(path.join(OUT_DIR, 'backnav-restored.png'));
  },
  async lightHero() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.hero-title')`);
    await sleep(2500);
    await cdp.eval(`document.documentElement.dataset.theme='light'; localStorage.setItem('lumen-theme','light');`);
    await sleep(1500);
    await cdp.shot(path.join(OUT_DIR, 'light-hero.png'));
    await cdp.eval(`window.scrollBy(0, ${Math.round(height * 0.55)})`);
    await sleep(1200);
    await cdp.shot(path.join(OUT_DIR, 'light-hero-mid.png'));
    await cdp.eval(`document.documentElement.dataset.theme='dark'; localStorage.setItem('lumen-theme','dark');`);
  },
  async lightSearch() {
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.hero-title')`);
    await cdp.eval(`document.documentElement.dataset.theme='light'; localStorage.setItem('lumen-theme','light');`);
    await sleep(800);
    await cdp.eval(`document.querySelector('.nav-link[aria-label="搜索"]')?.click()`);
    await sleep(700);
    await cdp.eval(`(() => {
      const input = document.querySelector('.search-box input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '秦皇岛');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2500);
    await cdp.shot(path.join(OUT_DIR, 'light-search.png'));
    await cdp.eval(`document.documentElement.dataset.theme='dark'; localStorage.setItem('lumen-theme','dark');`);
  },
  async lightAlbum() {
    await cdp.navigate(`${BASE}/#/`);
    await sleep(1200);
    await cdp.eval(`document.documentElement.dataset.theme='light'; localStorage.setItem('lumen-theme','light');`);
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent('2024/2024清明天津游')}`);
    await cdp.waitFor(`!!document.querySelector('.masonry .tile')`);
    await sleep(3000);
    await cdp.shot(path.join(OUT_DIR, 'light-album.png'));
    await cdp.eval(`document.documentElement.dataset.theme='dark'; localStorage.setItem('lumen-theme','dark');`);
  },
  async darkHero() {
    await cdp.navigate(`${BASE}/#/favorites`);
    await sleep(800);
    await cdp.navigate(`${BASE}/#/`);
    await cdp.waitFor(`!!document.querySelector('.hero-title')`);
    await cdp.eval(`document.documentElement.dataset.theme='dark'; localStorage.setItem('lumen-theme','dark');`);
    await sleep(3500);
    await cdp.shot(path.join(OUT_DIR, 'dark-hero.png'));
  },
  async original() {
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent('2024/2024清明天津游')}`);
    await cdp.waitFor(`!!document.querySelector('.masonry .tile')`);
    await sleep(3000);
    await cdp.eval(`document.querySelector('.masonry .tile')?.click()`);
    await sleep(2500);
    await cdp.shot(path.join(OUT_DIR, 'lb-preview.png'));
    const clicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.lb-tools .lb-btn')].find((x) => x.textContent.includes('原图'));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    console.log('  原图 button clicked:', clicked);
    await sleep(7000);
    await cdp.shot(path.join(OUT_DIR, 'lb-original.png'));
    await cdp.eval(`document.querySelector('.lb-img')?.click()`);
    await sleep(1300);
    await cdp.shot(path.join(OUT_DIR, 'lb-original-zoom.png'));
    const dragged = await cdp.eval(`(() => {
      const frame = document.querySelector('.lb-frame');
      if (!frame) return false;
      const opts = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      frame.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 800, clientY: 520 }));
      frame.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 620, clientY: 400 }));
      frame.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 620, clientY: 400 }));
      return true;
    })()`);
    console.log('  drag dispatched:', dragged);
    await sleep(900);
    await cdp.shot(path.join(OUT_DIR, 'lb-pan.png'));
    await cdp.eval(`document.querySelectorAll('.lb-tools .lb-btn')[1]?.click()`);
    await sleep(1000);
    await cdp.shot(path.join(OUT_DIR, 'lb-drawer.png'));
  },
  async light() {
    await cdp.navigate(`${BASE}/#/`);
    await sleep(2500);
    await cdp.eval(`document.documentElement.dataset.theme='light'; localStorage.setItem('lumen-theme','light');`);
    await sleep(800);
    await cdp.eval(`document.getElementById('timeline')?.scrollIntoView()`);
    await sleep(2500);
    await cdp.shot(path.join(OUT_DIR, 'light-timeline.png'));
    await cdp.eval(`document.documentElement.dataset.theme='dark'; localStorage.setItem('lumen-theme','dark');`);
  },
  async mobile() {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
    await cdp.navigate(`${BASE}/#/`);
    await sleep(3500);
    await cdp.shot(path.join(OUT_DIR, 'mobile-home.png'));
    await cdp.eval(`document.getElementById('timeline')?.scrollIntoView()`);
    await sleep(2200);
    await cdp.shot(path.join(OUT_DIR, 'mobile-timeline.png'));
    await cdp.navigate(`${BASE}/#/album/${encodeURIComponent('2026/1101慕田峪')}`);
    await sleep(3000);
    await cdp.shot(path.join(OUT_DIR, 'mobile-album.png'));
  },
};

const which = args.only ? String(args.only).split(',') : Object.keys(scenarios);
const problems = [];
try {
  for (const name of which) {
    if (!scenarios[name]) continue;
    console.log(`▶ ${name}`);
    await scenarios[name]();
  }
} finally {
  for (const ev of cdp.events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${ev.params?.exceptionDetails?.exception?.description || ev.params?.exceptionDetails?.text}`);
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(ev.params?.type)) {
      problems.push(`console.${ev.params.type}: ${(ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
  }
  if (problems.length) {
    console.log(`\n⚠ ${problems.length} browser problems:`);
    for (const p of [...new Set(problems)].slice(0, 20)) console.log('   ', p.slice(0, 300));
  } else {
    console.log('\n✓ no console errors or uncaught exceptions');
  }
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  await sleep(500);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
