// 화면 크기별 점검: 노트북·데스크톱·태블릿(세로·가로) 크기에서 모든 탭을 열어 보고 배치 문제를 찾는다.
// 찾는 것: 가로 스크롤, 칸 밖으로 넘치거나 잘리는 내용, 안 그려지는 그림(canvas·이미지),
// 경계가 안 보이는 영역, 지금 탭 표시가 없는 탭 버튼, 손가락으로 누르기 작은 버튼·입력칸, 큰 화면에서 많이 비는 칸.
// 크기마다 탭마다 화면 그림(PNG)도 찍어 둔다 (shotsDir 를 줄 때).
//
// 방식: 작은 서버가 "/" 에 점검 페이지, "/app" 에 만든 앱을 준다. 점검 페이지가 크기마다 그 크기의 iframe 을 열어
// (iframe 너비가 곧 앱의 화면 너비라 @media 도 그대로 적용됨) 탭을 바꿔 가며 재고, 결과를 DOM 에 적는다.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './build.js';
import { SANDBOX_ARGS } from './shot.js';

export const VIEWPORTS = [
  { id: 'laptop', label: '노트북', width: 1366, height: 768 },
  { id: 'desktop', label: '데스크톱', width: 1920, height: 1080 },
  { id: 'tablet-portrait', label: '태블릿 세로', width: 768, height: 1024, touch: true },
  { id: 'tablet-landscape', label: '태블릿 가로', width: 1024, height: 768, touch: true },
];

// 기준값 (바꾸기 쉽게 한곳에)
export const VIEWPORT_LIMITS = {
  minTouch: 32, // 터치 화면에서 버튼·입력칸 최소 높이·너비 (WCAG 2.5.8 최소 24px 보다 넉넉하게, 교실 태블릿용)
  minFont: 12, // 이보다 작은 글자
  emptyRatio: 0.4, // 큰 화면에서 칸 높이 중 내용이 이 비율보다 적고
  emptyPx: 360, // 빈 높이가 이보다 크면 "많이 빔"
  scrollRatio: 1.5, // 내용이 칸 높이의 이 배수를 넘으면 "칸 안에서 많이 스크롤"
};

// 브라우저 안에서 도는 점검 코드. 바깥 변수를 쓰지 않는다 (문자열로 넣음)
function inBrowser(VIEWPORTS, L) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { issues: [], sizes: [] };
  const add = (vp, screen, region, level, kind, message) => {
    const key = [vp ? vp.id : '', screen, region, kind, message].join('|');
    if (!out.issues.some((i) => i.key === key)) out.issues.push({ key, viewport: vp ? vp.id : '', size: vp ? vp.label + ' ' + vp.width + '×' + vp.height : '', screen, region, level, kind, message });
  };
  const px = (v) => parseFloat(v) || 0;
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

  const measure = (vp, W, D, screen, opts) => {
    const vis = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight));
    const leaves = [...D.querySelectorAll('#app section[data-region]')].filter((s) => !s.querySelector('section[data-region]') && vis(s));
    // 1) 페이지 전체 가로 스크롤
    const docW = D.documentElement.scrollWidth;
    if (docW > W.innerWidth + 1) {
      const wide = leaves.filter((s) => s.getBoundingClientRect().right > W.innerWidth + 1).map((s) => s.dataset.region);
      add(vp, screen, wide[0] || '', 'error', 'hscroll', '화면이 ' + (docW - W.innerWidth) + 'px 넓어 가로 스크롤이 생깁니다' + (wide.length ? ' (넘치는 영역: ' + wide.join(', ') + ')' : ''));
    }
    for (const sec of leaves) {
      const id = sec.dataset.region;
      const cs = W.getComputedStyle(sec);
      const r = sec.getBoundingClientRect();
      // 2) 칸 밖으로 넘치는 내용
      if (sec.scrollWidth > sec.clientWidth + 2) {
        const clipped = /hidden|clip/.test(cs.overflowX);
        add(vp, screen, id, clipped ? 'error' : 'warn', 'overflow-x', clipped
          ? '내용이 칸보다 ' + (sec.scrollWidth - sec.clientWidth) + 'px 넓어 오른쪽이 잘립니다'
          : '내용이 칸보다 ' + (sec.scrollWidth - sec.clientWidth) + 'px 넓어 칸 안에서 옆으로 밀어야 보입니다');
      }
      if (sec.scrollHeight > sec.clientHeight + 2) {
        if (/hidden|clip/.test(cs.overflowY)) add(vp, screen, id, 'error', 'clip-y', '내용이 칸보다 ' + (sec.scrollHeight - sec.clientHeight) + 'px 길어 아래가 잘립니다 (스크롤도 안 됨)');
        else if (sec.scrollHeight > sec.clientHeight * L.scrollRatio) add(vp, screen, id, 'warn', 'scroll-y', '내용이 칸 높이의 ' + (sec.scrollHeight / sec.clientHeight).toFixed(1) + '배라 칸 안에서 많이 내려야 합니다');
      }
      // 3) 안 그려지는 그림
      for (const cv of sec.querySelectorAll('canvas')) {
        if (vis(cv) && cv.clientWidth > 4 && cv.clientHeight > 4 && (!cv.width || !cv.height)) add(vp, screen, id, 'error', 'canvas', '그림판(canvas)이 ' + cv.clientWidth + '×' + cv.clientHeight + ' 자리를 차지하지만 실제 크기가 ' + cv.width + '×' + cv.height + ' 이라 아무것도 안 보입니다');
      }
      for (const im of sec.querySelectorAll('img')) {
        if (vis(im) && im.complete && !im.naturalWidth && im.getAttribute('src')) add(vp, screen, id, 'error', 'image', '그림을 불러오지 못했습니다: ' + im.getAttribute('src').slice(0, 60));
      }
      for (const svg of sec.querySelectorAll('svg')) {
        const b = svg.getBoundingClientRect();
        if (vis(svg) && svg.closest('section') === sec && svg.childElementCount && (b.width < 2 || b.height < 2)) add(vp, screen, id, 'warn', 'svg', 'SVG 그림 크기가 ' + Math.round(b.width) + '×' + Math.round(b.height) + ' 이라 거의 안 보입니다');
      }
      // 4) 누르기 작은 버튼·입력칸 (터치 화면), 너무 작은 글자
      if (vp.touch) {
        const small = [...sec.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=button]')].filter((el) => {
          if (!vis(el)) return false;
          const b = el.getBoundingClientRect();
          if (el.type === 'checkbox' || el.type === 'radio') return b.width < 16 || b.height < 16;
          return b.height < L.minTouch || b.width < L.minTouch;
        });
        if (small.length) add(vp, screen, id, 'warn', 'small-control', '손가락으로 누르기 작은 버튼·입력칸 ' + small.length + '개 (높이나 너비 ' + L.minTouch + 'px 미만: ' + small.slice(0, 3).map((el) => (el.innerText || el.value || el.placeholder || el.tagName.toLowerCase()).trim().slice(0, 12)).join(', ') + ')');
      }
      const tiny = [...sec.querySelectorAll('*')].filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()) && vis(el) && px(W.getComputedStyle(el).fontSize) < L.minFont);
      if (tiny.length) add(vp, screen, id, 'warn', 'small-text', L.minFont + 'px 보다 작은 글자 ' + tiny.length + '곳');
      // 5) 큰 화면에서 칸이 내용보다 훨씬 큼
      if (opts.biggest && r.height > 200) {
        let bottom = r.top + px(cs.paddingTop);
        for (const el of sec.querySelectorAll('*')) { if (!vis(el)) continue; const b = el.getBoundingClientRect(); if (b.height && b.bottom > bottom) bottom = b.bottom; }
        const used = Math.min(r.height, bottom - r.top + px(cs.paddingBottom));
        if (used / r.height < L.emptyRatio && r.height - used > L.emptyPx) opts.empty.push(id + ' ' + Math.round(used / r.height * 100) + '%');
      }
    }
    // 6) 영역 경계가 안 보임: 붙어 있는 두 영역이 둘 다 테두리·그림자·배경색 없이 페이지 배경과 같을 때
    if (opts.first) {
      const pageBg = (() => { for (const el of [D.querySelector('#app'), D.body, D.documentElement]) { const c = el && W.getComputedStyle(el).backgroundColor; if (!transparent(c)) return c; } return 'rgb(255, 255, 255)'; })();
      const plain = (s) => {
        const c = W.getComputedStyle(s);
        const border = ['Top', 'Right', 'Bottom', 'Left'].some((k) => px(c['border' + k + 'Width']) > 0 && c['border' + k + 'Style'] !== 'none' && !transparent(c['border' + k + 'Color']) && c['border' + k + 'Color'] !== pageBg);
        const bg = !transparent(c.backgroundColor) && c.backgroundColor !== pageBg;
        return !border && !bg && c.boxShadow === 'none' && (s.textContent || '').trim() !== '';
      };
      const flat = leaves.filter(plain);
      const near = (a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); const gapX = Math.max(0, Math.max(x.left, y.left) - Math.min(x.right, y.right)); const gapY = Math.max(0, Math.max(x.top, y.top) - Math.min(x.bottom, y.bottom)); return gapX <= 24 && gapY <= 24; };
      const pairs = [];
      for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) if (near(flat[i], flat[j])) pairs.push(flat[i].dataset.region + '·' + flat[j].dataset.region);
      if (pairs.length) add(null, screen, flat[0].dataset.region, 'warn', 'boundary', '붙어 있는 영역 사이에 테두리·배경색·그림자가 없어 어디까지가 한 칸인지 알기 어렵습니다 (' + pairs.slice(0, 4).join(', ') + ')');
    }
  };

  // 7) 지금 탭 표시: 탭 이름과 같은 글자의 버튼이 2개 이상 보이는데, 지금 탭 버튼의 모양이 다른 탭 버튼과 똑같을 때
  const checkActiveTab = (W, D, screens, cur) => {
    const vis = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight));
    const titles = new Map(screens.map((s) => [String(s.title || s.id).trim(), s.id]));
    const tabs = [...D.querySelectorAll('#app button, #app a, #app [role=tab], #app [role=button]')].filter((el) => vis(el) && titles.has((el.innerText || el.textContent || '').trim()));
    if (new Set(tabs.map((t) => titles.get((t.innerText || t.textContent).trim()))).size < 2) return null;
    const look = (el) => { const c = W.getComputedStyle(el); return [c.backgroundColor, c.color, c.borderTopColor, c.borderBottomColor, c.borderBottomWidth, c.fontWeight, c.textDecorationLine, c.boxShadow, c.opacity, el.getAttribute('aria-current') || '', el.getAttribute('aria-selected') || ''].join('|'); };
    const mine = tabs.filter((t) => titles.get((t.innerText || t.textContent).trim()) === cur);
    const others = tabs.filter((t) => titles.get((t.innerText || t.textContent).trim()) !== cur);
    if (!mine.length || !others.length) return null;
    return mine.every((m) => others.some((o) => look(o) === look(m))) ? tabs[0].closest('section[data-region]')?.dataset.region || '' : null;
  };

  (async () => {
    const box = document.getElementById('box');
    for (let n = 0; n < VIEWPORTS.length; n++) {
      const vp = VIEWPORTS[n];
      const f = document.createElement('iframe');
      f.style.cssText = 'border:0;width:' + vp.width + 'px;height:' + vp.height + 'px';
      box.replaceChildren(f);
      await new Promise((r) => { f.addEventListener('load', r, { once: true }); f.src = '/app'; });
      await sleep(250);
      const W = f.contentWindow, D = f.contentDocument;
      const app = W.__ideApp;
      const screens = app && app.screens && app.screens.length ? app.screens : [{ id: '', title: '' }];
      for (const sc of screens) {
        if (sc.id && app.navigate) { app.navigate(sc.id, { silentHash: true }); await sleep(150); }
        const empty = [];
        measure(vp, W, D, sc.title || sc.id, { first: n === 0, biggest: vp.width === Math.max(...VIEWPORTS.map((v) => v.width)), empty });
        // 큰 화면에서 칸이 내용보다 훨씬 큰 영역은 탭마다 한 줄로 모은다
        if (empty.length) add(vp, sc.title || sc.id, empty[0].split(' ')[0], 'warn', 'empty', '큰 화면에서 칸이 내용보다 훨씬 커서 아래가 많이 빕니다 (칸 높이 중 내용 비율: ' + empty.join(', ') + '). 칸 높이를 줄이거나, 레이아웃을 "페이지형"(내용 높이에 맞춤)으로 바꾸거나, 내용을 키우세요');
        if (n === 0 && screens.length > 1) {
          const region = checkActiveTab(W, D, screens, sc.id);
          if (region != null) add(null, sc.title || sc.id, region, 'warn', 'active-tab', '"' + (sc.title || sc.id) + '" 탭을 보고 있는데 탭 버튼 모양이 다른 탭과 똑같아 지금 어느 탭인지 알 수 없습니다 (색·굵기·밑줄 또는 aria-current 로 표시)');
        }
      }
      out.sizes.push(vp.id);
    }
    const node = document.createElement('script');
    node.id = '__ideViewportResult';
    node.type = 'application/json';
    node.textContent = JSON.stringify(out);
    document.body.appendChild(node);
  })();
}

function run(browser, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(browser, ['--headless=new', ...SANDBOX_ARGS, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', ...args],
      { timeout, maxBuffer: 15 * 1024 * 1024 }, (err, stdout) => (err && !stdout && !args.some((a) => a.startsWith('--screenshot')) ? reject(err) : resolve(String(stdout || ''))));
  });
}

export function summarizeViewport(raw, shots = []) {
  const issues = (raw?.issues || []).map(({ key, ...i }) => i);
  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warnCount = issues.length - errorCount;
  return { sizes: VIEWPORTS.filter((v) => (raw?.sizes || []).includes(v.id)), issues, errorCount, warnCount, ok: errorCount === 0, shots };
}

// shotsDir: 주면 크기마다·탭마다 화면 그림을 <shotsDir>/<크기>_<탭>.png 로 저장한다
export async function checkViewports(project, browser, { shotsDir = '', timeoutMs = 60000 } = {}) {
  const appHtml = await buildApp(project, { preview: false, noFieldErrors: true });
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="box"></div><script>(${inBrowser.toString()})(${JSON.stringify(VIEWPORTS)}, ${JSON.stringify(VIEWPORT_LIMITS)});</script></body></html>`;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/app') ? appHtml : page);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const big = Math.max(...VIEWPORTS.map((v) => v.width)) + 40;
    const dom = await run(browser, [`--window-size=${big},1200`, '--virtual-time-budget=20000', '--dump-dom', `http://127.0.0.1:${port}/`], timeoutMs);
    const m = dom.match(/<script id="__ideViewportResult" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { error: '화면 크기별 점검 결과를 받지 못했습니다 (시간 초과)' };
    const raw = JSON.parse(m[1]);
    const shots = shotsDir ? await takeShots(browser, port, project, shotsDir) : [];
    return summarizeViewport(raw, shots);
  } finally {
    srv.close();
  }
}

async function takeShots(browser, port, project, dir) {
  const layout = await project.getLayout();
  const screens = Array.isArray(layout.screens) && layout.screens.length ? layout.screens : [{ id: '', title: '' }];
  await fs.mkdir(dir, { recursive: true });
  for (const f of await fs.readdir(dir)) if (f.endsWith('.png')) await fs.rm(path.join(dir, f), { force: true });
  const shots = [];
  for (const vp of VIEWPORTS) {
    for (const sc of screens) {
      const file = `${vp.id}${sc.id ? '_' + sc.id : ''}.png`;
      const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-vp-'));
      try {
        await run(browser, [`--user-data-dir=${profile}`, `--window-size=${vp.width},${vp.height}`, '--virtual-time-budget=3000', `--screenshot=${path.join(dir, file)}`,
          `http://127.0.0.1:${port}/app${sc.id ? '?screen=' + encodeURIComponent(sc.id) : ''}`], 30000);
        await fs.access(path.join(dir, file));
        shots.push({ viewport: vp.id, size: `${vp.label} ${vp.width}×${vp.height}`, screen: sc.title || sc.id, file });
      } catch {} finally {
        fs.rm(profile, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  return shots;
}
