// 레이아웃 + 영역별 파일 → 실행 가능한 단일 HTML
// 각 영역의 CSS 는 @scope 로 감싸서 다른 영역에 새지 않게 하고,
// JS 는 (root, app) 을 받는 함수로 감싸서 자기 영역 DOM 만 다루게 한다.

import { flatten, sorted, isContainer, getScreens } from '../public/tree.js';
import { isOverlayHtml } from './features.js';

// 서로 다른 영역이 통신할 때 쓰는 공용 런타임.
// 가져온 앱이 전역 app 을 이미 쓰고 있을 수 있어 내부 이름은 __ideApp, window.app 은 비어 있을 때만 연결
export const RUNTIME = `window.__ideApp = (() => {
  const handlers = {};
  const state = {};
  let currentScreen = '';
  return {
    state,
    regions: {},
    screens: [],
    on(evt, fn) { (handlers[evt] ||= []).push(fn); return () => this.off(evt, fn); },
    off(evt, fn) { handlers[evt] = (handlers[evt] || []).filter((f) => f !== fn); },
    emit(evt, data) { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
    set(key, value) { state[key] = value; this.emit('state:' + key, value); },
    get(key) { return state[key]; },
    getScreen() { return currentScreen; },
    navigate(screenId, opts) {
      const nodes = [...document.querySelectorAll('#app > .ide-screen[data-screen]')];
      if (!nodes.length) return false;
      const target = nodes.find((el) => el.dataset.screen === screenId) || nodes[0];
      currentScreen = target.dataset.screen;
      nodes.forEach((el) => {
        const on = el === target;
        el.hidden = !on;
        el.classList.toggle('active', on);
      });
      if (!opts?.silentHash) {
        try { if (location.hash !== '#' + currentScreen) history.replaceState(null, '', '#' + currentScreen); } catch {}
      }
      this.set('screen', currentScreen);
      this.emit('screen:change', currentScreen);
      return true;
    },
    // 나눠진 여러 영역을 한 root 처럼 다루는 객체 (형제로 나눈 영역의 기존 script.js 용)
    multiRoot(ids) {
      const els = () => ids.map((id) => this.regions[id]).filter(Boolean);
      return {
        get elements() { return els(); },
        get firstElement() { return els()[0]; },
        querySelector(s) { for (const e of els()) { const m = e.querySelector(s); if (m) return m; } return null; },
        querySelectorAll(s) { return els().flatMap((e) => [...e.querySelectorAll(s)]); },
        getElementsByClassName(c) { return els().flatMap((e) => [...e.getElementsByClassName(c)]); },
        addEventListener(...a) { els().forEach((e) => e.addEventListener(...a)); },
        removeEventListener(...a) { els().forEach((e) => e.removeEventListener(...a)); },
        contains(n) { return els().some((e) => e.contains(n)); },
        get classList() { return els()[0].classList; },
        get style() { return els()[0].style; },
        get dataset() { return els()[0].dataset; },
      };
    },
  };
})();
if (!window.app || window.app instanceof Element) window.app = window.__ideApp; // <div id="app"> 도 window.app 으로 잡히므로`;

// 동작 테스트 실행기: 미리보기 페이지 안에서 단계를 실행하고 결과를 부모(편집기)에 알린다.
// 단계: navigate / click / type / wait / expectText / expectValue / expectVisible / expectCount
export function testRunnerScript(test, index) {
  return `<script>
(() => {
  const test = ${JSON.stringify(test).replace(/</g, '\\u003c')};
  const errors = [];
  const prevHook = window.__ideRegionError;
  window.__ideRegionError = (id, e) => { errors.push('[' + id + '] ' + e.message); prevHook && prevHook(id, e); };
  window.addEventListener('error', (e) => errors.push(e.message));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ensureScreen = async (el) => {
    const sc = el?.closest?.('.ide-screen[data-screen]');
    if (sc && sc.hidden && window.__ideApp?.navigate) {
      window.__ideApp.navigate(sc.dataset.screen, { silentHash: true });
      await sleep(80);
    }
  };
  const find = async (sel) => {
    for (let i = 0; i < 30; i++) { const el = document.querySelector(sel); if (el) return el; await sleep(100); }
    throw new Error('요소를 찾지 못함: ' + sel);
  };
  // 보이는지: display:none·닫힌 details/dialog·visibility:hidden 이 아니면 보임 (창이 가려져 크기가 0 으로 재지는 경우에도 정확하게)
  const visible = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const run = async (s) => {
    const v = s.value ?? '';
    switch (s.action) {
      case 'navigate': {
        if (!window.__ideApp?.navigate) throw new Error('화면 전환 런타임이 없습니다');
        window.__ideApp.navigate(v, { silentHash: true });
        await sleep(120);
        return '화면 이동: ' + v;
      }
      case 'click': { const el = await find(s.selector); await ensureScreen(el); el.click(); await sleep(150); return '클릭'; }
      case 'type': { const el = await find(s.selector); await ensureScreen(el); el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(100); return '입력 "' + v + '"'; }
      case 'wait': await sleep(Number(v) || 300); return v + 'ms 기다림';
      case 'expectText': { const el = await find(s.selector); await ensureScreen(el); let t = ''; for (let i = 0; i < 20; i++) { t = el.textContent.replace(/\\s+/g, ' ').trim(); if (t.includes(v)) return '글자 확인'; await sleep(100); } throw new Error('"' + v + '" 가 없음 (실제: "' + t.slice(0, 80) + '")'); }
      case 'expectValue': { const el = await find(s.selector); await ensureScreen(el); if (String(el.value) === v) return '값 확인'; throw new Error('값이 "' + v + '" 이 아님 (실제: "' + el.value + '")'); }
      case 'expectVisible': { const el = await find(s.selector); await ensureScreen(el); for (let i = 0; i < 20; i++) { if (visible(el)) return '보임'; await sleep(100); } throw new Error('보이지 않음'); }
      case 'expectCount': { const n = document.querySelectorAll(s.selector).length; if (n === Number(v)) return n + '개'; throw new Error(v + '개가 아니라 ' + n + '개'); }
      default: throw new Error('모르는 단계: ' + s.action);
    }
  };
  window.addEventListener('load', async () => {
    await sleep(300);
    const results = [];
    for (const s of test.steps || []) {
      try { results.push({ ok: true, msg: await run(s) }); }
      catch (e) { results.push({ ok: false, msg: e.message }); break; }
    }
    await sleep(100);
    parent.postMessage({ type: 'test-result', index: ${index}, results, errors }, '*');
  });
})();
</script>`;
}

// overrides: { 영역ID: { html, css, js } } — 검토 중인 AI 결과를 저장하지 않고 미리보기할 때
// inject: <head> 끝에 덧붙일 내용 (동작 테스트 실행기 등)
export async function buildApp(project, { preview = false, overrides = {}, inject = '' } = {}) {
  const layout = await project.getLayout();
  const { grid } = layout;
  const flow = layout.mode === 'flow';
  const [globalCss, headHtml, appJs] = await Promise.all([
    project.readShared('css'),
    project.readShared('head'),
    project.readShared('js'),
  ]);
  const all = flatten(layout);
  const files = {};
  for (const { region } of all) files[region.id] = { ...(await project.readRegion(region.id)), ...overrides[region.id] };
  const regions = all.map(({ region }) => ({ ...region, files: files[region.id] }));

  const placement = [];
  // 안쪽 레이아웃이 있는 영역은 자기 마크업 대신 하위 그리드를 그린다 (자기 CSS/JS 는 그대로 적용)
  const render = (container, root) =>
    sorted(container.regions) // flow 모드는 위→아래 순서가 곧 문서 순서
      .map((r) => {
        // 대화상자만 있는 영역은 칸을 차지하지 않게 문서 흐름에 그대로 둔다
        const overlay = !isContainer(r) && isOverlayHtml(files[r.id].html);
        const contents = (root && flow) || overlay;
        const area = `${r.y + 1} / ${r.x + 1} / span ${r.h} / span ${r.w}`;
        const style = contents ? 'display:contents' : `grid-area:${area}`;
        // 칸 위치는 스타일시트에도 !important 로 넣는다: 영역 스크립트가 root.style.gridColumn 등을 건드려도 칸이 바뀌지 않게
        if (!contents) placement.push(`section[data-region="${r.id}"] { grid-area: ${area} !important; }`);
        const body = isContainer(r) ? innerGrid(r, root && flow, render(r, false)) : files[r.id].html;
        return `<section data-region="${r.id}" style="${style}">\n${body}\n</section>`;
      })
      .join('\n');
  const css = regions.map((r) => scopeCss(r.id, r.files.css)).join('\n');
  const screensList = getScreens(layout);
  const multiScreen = Array.isArray(layout.screens) && layout.screens.length > 1;
  const sections = multiScreen
    ? screensList.map((sc, i) => `<div class="ide-screen${i === 0 ? ' active' : ''}" data-screen="${escapeHtml(sc.id)}"${i === 0 ? '' : ' hidden'}>\n${render(sc, true)}\n</div>`).join('\n')
    : render(screensList[0], true);
  const scripts = regions
    .filter((r) => r.files.js.trim())
    .map(
      // 한 영역 스크립트의 오류가 어느 영역에서 났는지 알 수 있게 영역 이름을 붙여 알린다
      (r) => `<script>/* region: ${r.id} */
(function (root, app) {
try {
${r.files.js}
} catch (e) { (window.__ideRegionError || console.error)(${JSON.stringify(r.id)}, e); }
})(${r.jsRoots?.length > 1 ? `__ideApp.multiRoot(${JSON.stringify(r.jsRoots)})` : `__ideApp.regions[${JSON.stringify(r.id)}]`}, __ideApp);
</script>`,
    )
    .join('\n');

  // 가져온 앱은 원래 모습 그대로 보이도록 IDE 기본 스타일을 넣지 않는다
  const overlayIds = new Set(all.filter(({ region: r }) => !isContainer(r) && isOverlayHtml(files[r.id].html)).map(({ region: r }) => r.id));
  const bps = flow ? {} : layout.breakpoints || {};
  const screenCss = multiScreen
    ? `*, *::before, *::after { box-sizing: border-box; }\nhtml, body { margin: 0; height: 100%; }\nbody { font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }\n#app { min-height: 100vh; height: 100%; }\n.ide-screen[hidden] { display: none !important; }\n${screensList.map((sc) => {
        const g = sc.grid || grid;
        const rows = g.fill ? `repeat(${g.rows}, minmax(0, 1fr))` : `repeat(${g.rows}, minmax(${g.rowHeight || 60}px, auto))`;
        return `.ide-screen[data-screen="${sc.id}"] { display: grid; grid-template-columns: repeat(${g.cols}, minmax(0, 1fr)); grid-template-rows: ${rows}; gap: ${g.gap ?? 8}px; ${g.fill ? 'height: 100vh;' : 'min-height: 100vh;'} padding: ${g.gap ?? 8}px; }\n.ide-screen[data-screen="${sc.id}"] section[data-region] { min-width: 0; min-height: 0; overflow: auto; position: relative; }`;
      }).join('\n')}`
    : '';
  const baseCss = flow
    ? `#app { display: contents; }\n${placement.join('\n')}`
    : multiScreen
      ? `${screenCss}\n/* 칸 위치 (영역 코드가 바꾸지 못하게) */\n${placement.join('\n')}`
      : `${gridCss(grid, { hasMobile: Boolean(bps.mobile) })}\n/* 칸 위치 (영역 코드가 바꾸지 못하게) */\n${placement.join('\n')}${breakpointCss(bps, overlayIds)}`;

  const screenInit = multiScreen
    ? `\n__ideApp.screens = ${JSON.stringify(screensList.map((s) => ({ id: s.id, title: s.title || s.id })))};
(() => {
  const q = new URLSearchParams(location.search).get('screen') || location.hash.replace(/^#/, '');
  __ideApp.navigate(q || ${JSON.stringify(layout.activeScreen || screensList[0].id)}, { silentHash: true });
  window.addEventListener('hashchange', () => { const h = location.hash.replace(/^#/, ''); if (h) __ideApp.navigate(h, { silentHash: true }); });
  window.addEventListener('message', (e) => { if (e.data?.type === 'switch-screen' && e.data.screen) __ideApp.navigate(e.data.screen, { silentHash: true }); });
})();`
    : '';

  return `<!doctype html>
<html lang="${escapeHtml(layout.lang || 'ko')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(layout.name)}</title>
${headHtml}
<style>
${baseCss}
</style>
<style>
${globalCss}
</style>
<style>
${css}
</style>
${preview ? PREVIEW_HELPER : ''}
${inject}
</head>
<body${(layout.bodyAttrs || []).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('')}>
<div id="app">
${sections}
</div>
<script>
${RUNTIME}
document.querySelectorAll('#app section[data-region]').forEach((el) => { __ideApp.regions[el.dataset.region] = el; });${screenInit}
</script>
${appJs.trim() ? `<script${layout.appJsModule ? ' type="module"' : ''}>\n${appJs}\n</script>` : ''}
${scripts}
</body>
</html>
`;
}

// 높이가 정해진 그리드 칸 안에서는 행을 균등 분배, 문서 흐름 안에서는 내용 높이를 따른다
function innerGrid(r, inFlow, children) {
  const g = r.grid;
  const rows = inFlow ? `repeat(${g.rows}, auto)` : `repeat(${g.rows}, minmax(0, 1fr))`;
  return `<div class="ide-grid" style="display:grid;grid-template-columns:repeat(${g.cols}, minmax(0, 1fr));grid-template-rows:${rows};gap:${g.gap ?? 8}px;${inFlow ? '' : 'height:100%;'}">
${children}
</div>`;
}

// 화면 크기별 배치 (최상위 영역만). 데스크톱이 기본이고 좁아질수록 덮어쓴다
export const BREAKPOINTS = { tablet: 1024, mobile: 600 };

function breakpointCss(bps, overlayIds) {
  let out = '';
  for (const [name, maxWidth] of Object.entries(BREAKPOINTS)) {
    const bp = bps[name];
    if (!bp?.regions) continue;
    const g = bp.grid;
    const rows = g.fill ? `repeat(${g.rows}, minmax(0, 1fr))` : `repeat(${g.rows}, minmax(${g.rowHeight || 48}px, auto))`;
    const areas = Object.entries(bp.regions)
      .filter(([id]) => !overlayIds.has(id))
      .map(([id, p]) => `  #app > section[data-region="${id}"] { grid-area: ${p.y + 1} / ${p.x + 1} / span ${p.h} / span ${p.w} !important; }`)
      .join('\n');
    out += `
/* ${name} (≤ ${maxWidth}px) */
@media (max-width: ${maxWidth}px) {
  html, body { height: ${g.fill ? '100%' : 'auto'}; }
  #app { display: grid !important; grid-template-columns: repeat(${g.cols}, minmax(0, 1fr)); grid-template-rows: ${rows}; height: ${g.fill ? '100vh' : 'auto'} !important; min-height: 100vh; }
${areas}
}`;
  }
  return out;
}

function gridCss(grid, { hasMobile = false } = {}) {
  const rows = grid.fill
    ? `repeat(${grid.rows}, minmax(0, 1fr))`
    : `repeat(${grid.rows}, minmax(${grid.rowHeight}px, auto))`;
  return `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; ${grid.fill ? 'height: 100%;' : ''} }
body { font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
#app {
  display: grid;
  grid-template-columns: repeat(${grid.cols}, minmax(0, 1fr));
  grid-template-rows: ${rows};
  gap: ${grid.gap}px;
  ${grid.fill ? 'height: 100vh;' : 'min-height: 100vh;'}
  padding: ${grid.gap}px;
}
#app section[data-region] { min-width: 0; min-height: 0; overflow: auto; position: relative; }
${hasMobile
    // 모바일 배치를 따로 정했으면 안쪽 레이아웃만 세로로 쌓는다
    ? `@media (max-width: 600px) {
  #app .ide-grid { display: flex !important; flex-direction: column; height: auto !important; }
}`
    // 정하지 않았으면 좁은 화면에서는 전부 세로로 쌓는다
    : `@media (max-width: 560px) {
  #app, #app .ide-grid { display: flex !important; flex-direction: column; height: auto !important; }
  #app section[data-region] { min-height: 120px; }
}`}`;
}

// 미리보기에서 영역 경계 표시 + 요소 직접 선택(Inspect-to-Edit) + 에러를 부모 창에 전달
const PREVIEW_HELPER = `<style>
body.show-regions [data-region] { outline: 1px dashed rgba(99,102,241,.6); outline-offset: -1px; }
body.ide-inspect-on, body.ide-inspect-on * { cursor: crosshair !important; }
@keyframes __ideBusyPulse {
  0%, 100% { box-shadow: inset 0 0 0 2px #5b5bd6, 0 0 0 0 rgba(91,91,214,.35); }
  50% { box-shadow: inset 0 0 0 2px #7c3aed, 0 0 0 6px rgba(91,91,214,.15); }
}
section[data-region].ide-busy {
  outline: 2px dashed #5b5bd6 !important;
  outline-offset: -2px;
  animation: __ideBusyPulse 1.3s ease-in-out infinite;
}
section[data-region].ide-busy::after {
  content: "⚡ 작업 중…";
  position: sticky; top: 6px; float: right; margin: 6px 6px 0 0; z-index: 2147483640;
  background: #5b5bd6; color: #fff; font: 700 11px/1.3 system-ui, "Malgun Gothic", sans-serif;
  padding: 3px 8px; border-radius: 999px; pointer-events: none;
  box-shadow: 0 2px 8px rgba(91,91,214,.4);
}
#__ideInspectBox {
  position: fixed; pointer-events: none; z-index: 2147483646; display: none;
  border: 2px solid #5b5bd6; background: rgba(91,91,214,.14); border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7);
}
#__ideInspectTip {
  position: fixed; pointer-events: none; z-index: 2147483647; display: none;
  background: #1f2430; color: #fff; font: 11px/1.4 ui-monospace, Consolas, monospace;
  padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 80vw; overflow: hidden; text-overflow: ellipsis;
}
</style>
<script>
window.addEventListener('error', (e) => {
  if (/ResizeObserver loop/.test(e.message)) return; // 브라우저가 내는 무해한 경고
  parent.postMessage({ type: 'preview-error', message: e.message, line: e.lineno }, '*');
});
window.__ideRegionError = (id, e) => { console.error('[' + id + ']', e); parent.postMessage({ type: 'preview-error', region: id, message: e.message }, '*'); };
window.addEventListener('message', (e) => {
  if (e.data?.type === 'toggle-regions') document.body.classList.toggle('show-regions', e.data.on);
  if (e.data?.type === 'busy-regions') {
    const set = new Set(Array.isArray(e.data.regions) ? e.data.regions : []);
    document.querySelectorAll('#app section[data-region]').forEach((el) => {
      el.classList.toggle('ide-busy', set.has(el.dataset.region));
    });
  }
});
// 편집기에서 기능을 고르면 해당 요소로 스크롤하고 깜빡여 보여 준다
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d?.type !== 'highlight') return;
  let el = document.querySelector('section[data-region="' + CSS.escape(d.region) + '"]');
  for (let i = 0; i < d.depth && el; i++) el = el.firstElementChild;
  const t = el?.children[d.index];
  if (!t) return;
  if (t.tagName === 'DIALOG' && !t.open) { t.show(); setTimeout(() => t.close(), 1800); }
  t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  t.animate([{ outline: '3px solid #5b5bd6', outlineOffset: '2px' }, { outline: '3px solid transparent', outlineOffset: '2px' }], { duration: 1800 });
});
// Inspect-to-Edit: 미리보기 요소 직접 선택 & 실시간 스타일 프리뷰
(() => {
  let active = false;
  let box, tip;
  const ensureUi = () => {
    if (!box) {
      box = document.createElement('div');
      box.id = '__ideInspectBox';
      tip = document.createElement('div');
      tip.id = '__ideInspectTip';
      document.body.append(box, tip);
    }
  };
  const hideUi = () => { if (box) box.style.display = 'none'; if (tip) tip.style.display = 'none'; };
  const escSel = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\\w-])/g, '\\\\$1'));
  const selectorIn = (el, root) => {
    if (el === root) return ':scope';
    if (el.id) return '#' + escSel(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== root && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + escSel(cur.id)); break; }
      const cls = [...cur.classList].filter((c) => c && !c.startsWith('__ide')).slice(0, 2);
      if (cls.length) part += '.' + cls.map(escSel).join('.');
      const parent = cur.parentElement;
      if (parent && parent !== root) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      const test = parts.join(' > ');
      try { if (root.querySelectorAll(test).length === 1) return test; } catch {}
      cur = parent;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const regionOf = (el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === 'SECTION' && cur.dataset?.region && !cur.querySelector(':scope > .ide-grid')) return cur;
      cur = cur.parentElement;
    }
    return el?.closest?.('section[data-region]') || null;
  };
  const showBox = (el, reg) => {
    ensureUi();
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    const sel = selectorIn(el, reg);
    tip.textContent = reg.dataset.region + ' · ' + sel + ' (' + Math.round(r.width) + '×' + Math.round(r.height) + ')';
    tip.style.display = 'block';
    tip.style.left = Math.max(4, Math.min(window.innerWidth - 260, r.left)) + 'px';
    tip.style.top = (r.top > 24 ? r.top - 22 : Math.min(window.innerHeight - 24, r.bottom + 4)) + 'px';
  };
  document.addEventListener('mousemove', (ev) => {
    if (!active) return;
    const t = ev.target;
    if (!t || t === box || t === tip) return;
    const reg = regionOf(t);
    if (!reg) return hideUi();
    showBox(t, reg);
  }, true);
  document.addEventListener('click', (ev) => {
    if (!active) return;
    const t = ev.target;
    const reg = regionOf(t);
    if (!reg) return;
    ev.preventDefault();
    ev.stopPropagation();
    const cs = getComputedStyle(t);
    const r = t.getBoundingClientRect();
    const sel = selectorIn(t, reg);
    const info = {
      region: reg.dataset.region,
      selector: sel,
      tag: t.tagName.toLowerCase(),
      id: t.id || '',
      classes: [...t.classList].slice(0, 5),
      text: (t.innerText || t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      html: (t.outerHTML || '').slice(0, 500),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      styles: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        padding: cs.padding,
        borderRadius: cs.borderRadius,
      },
    };
    showBox(t, reg);
    parent.postMessage({ type: 'inspect-pick', info }, '*');
  }, true);
  window.addEventListener('keydown', (ev) => {
    if (active && ev.key === 'Escape') {
      active = false;
      document.body.classList.remove('ide-inspect-on');
      hideUi();
      parent.postMessage({ type: 'inspect-cancel' }, '*');
    }
  });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d?.type === 'toggle-inspect') {
      active = Boolean(d.on);
      document.body.classList.toggle('ide-inspect-on', active);
      if (!active) hideUi();
    } else if (d?.type === 'inspect-live-style') {
      const reg = document.querySelector('section[data-region="' + escSel(d.region) + '"]');
      if (!reg) return;
      const target = d.selector === ':scope' ? reg : reg.querySelector(d.selector);
      if (!target) return;
      for (const [k, v] of Object.entries(d.styles || {})) {
        if (v !== '' && v != null) target.style.setProperty(k, String(v));
      }
    }
  });
})();
</script>`;

// @keyframes, @font-face, @import 는 @scope 안에 둘 수 없으므로 바깥으로 꺼낸다
export function scopeCss(id, src) {
  if (!src.trim()) return '';
  const hoisted = [];
  const scoped = [];
  for (const block of splitTopLevel(src)) {
    if (/^\s*@(keyframes|-webkit-keyframes|font-face|import|property)\b/.test(block)) hoisted.push(block);
    else scoped.push(block);
  }
  return `/* region: ${id} */\n${hoisted.join('\n')}\n@scope ([data-region="${id}"]) {\n${scoped.join('\n')}\n}`;
}

function splitTopLevel(src) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        blocks.push(src.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      blocks.push(src.slice(start, i + 1));
      start = i + 1;
    }
  }
  const rest = src.slice(start);
  if (rest.trim()) blocks.push(rest);
  return blocks;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
