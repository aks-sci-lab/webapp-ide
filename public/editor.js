// 웹앱 IDE 편집기: 레이아웃 캔버스 + 영역 인스펙터 + 바이브 코딩
import { flatten, find, ancestors, containerAt, isContainer, fits, unionRect, sorted, DEFAULT_INNER_GRID, getScreens, activeScreenOf } from './tree.js';
import { readTokens, setToken, addDarkFromLight, isColor, toHex6 } from './tokens.js';
import { pickGeminiModel, pickOpenAiModel } from './model-picker.js';
import { APP_TEMPLATES, THEME_PRESETS, FREE_STYLE_KITS, upsertStyleKitHead, detectStyleKit, applyThemeTokens, buildThemeBaseCss } from './templates.js';
import { addImageFiles, extractClipboardImages, renderImageStrip, toPayloadImages } from './image-attach.js';
import { buildElementPrompt, upsertElementStyleRule, renderInspectCard } from './inspect-edit.js';
import { renderVerifyReport, buildVerifyFixPrompt, buildVerifyFailureBriefing, countVerifyIssues } from './app-verifier.js';
import { extractFailingRegions, renderSessionBar, renderVerifySessionPanel } from './session-panel.js';
import { renderWorkflowPanel, WORKLOAD_EXAMPLES } from './workflow-panel.js';
import { renderProjectHub } from './project-hub.js';
import { LAYOUT_PRESETS, applyLayoutPreset, findSwapTarget, swapRegionGeometry, findSplitters, applySplitterMove } from './layout-magic.js';
import { classifySmartRequest } from './smart-router.js';
import { $, api, esc, toast, clientLog, setToastContext, dialog, confirmBox, promptBox } from './ui-core.js';
import { initHistoryPanels } from './history-panels.js';
import { initSkillsPanel } from './skills-panel.js';
import { initFieldErrorsPanel, refreshFieldErrorBadge } from './field-errors-panel.js';

// 미리보기 주소. localhost 와 127.0.0.1 은 브라우저에서 서로 다른 출처라 저장소(IndexedDB·localStorage)가 따로다.
// 미리보기를 반대쪽 주소로 열어 미리보기 속 앱의 데이터가 IDE 와 섞이지 않게 한다 (⚙️ 설정에서 끌 수 있음)
let PREVIEW_BASE = '';
let previewLoaded = false;
// 실행 검사·동작 테스트용 숨은 미리보기는 IDE 와 같은 주소에서 연다:
// 사용자가 보는 미리보기(분리된 저장소)의 데이터를 테스트 클릭이 건드리지 않고, 화면에 안 보여도 레이아웃이 계산된다
function setPreviewBase(isolate) {
  const other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  PREVIEW_BASE = isolate && !window.__WEB_STANDALONE__ ? `${location.protocol}//${other}:${location.port}` : '';
  const link = document.querySelector('#previewNewTab');
  if (link) link.href = `${PREVIEW_BASE}/preview`;
}
async function previewUrl(pathAndQuery, useBase = false) {
  if (window.__resolvePreviewUrl) return window.__resolvePreviewUrl(pathAndQuery);
  return `${useBase ? PREVIEW_BASE : ''}${pathAndQuery}`;
}
const COLORS = ['#5b5bd6', '#e5484d', '#12a594', '#f76b15', '#8e4ec6', '#0090ff', '#d6409f', '#46a758'];
const FILE_TABS = [
  { key: 'features', label: '기능' },
  { key: 'prompt', label: '프롬프트' },
  { key: 'html', label: 'HTML' },
  { key: 'css', label: 'CSS' },
  { key: 'js', label: 'JS' },
  { key: 'history', label: '기록' },
];

const state = {
  layout: null,
  selected: null, // 선택된 영역 id
  multi: new Set(), // Shift/Ctrl+클릭으로 함께 고른 영역 (합치기용)
  path: [], // 지금 캔버스에 보이는 레벨: 앱 → 안쪽 레이아웃을 가진 영역 id 들
  splitDir: 'h',
  splitCount: 2,
  device: 'desktop', // 캔버스가 보여 주는 화면 크기: desktop | tablet | mobile
  bpView: null, // 태블릿·모바일 배치를 편집할 때의 가상 컨테이너
  files: {}, // id → { html, css, js, prompt } (서버에 저장된 값)
  drafts: {}, // id → { key: 편집 중인 값 }
  history: {},
  pending: {}, // id → { files, current, updated, checked } 검토 대기 중인 AI 결과
  reviewMode: (() => { try { return localStorage.getItem('ide-review') !== '0'; } catch { return true; } })(),
  features: {}, // id → { blocks, wrappers, hasJs, hasCss } (영역 마크업의 기능 목록)
  deps: {}, // `영역/기능ID` → 함께 움직이는 CSS·JS (펼친 카드만)
  lastMove: null, // { snapshot, text } 방금 한 기능 이동 (되돌리기용)
  memoSuggest: {}, // 영역 → AI 가 제안한 결정 메모 줄들
  tab: 'features',
  busy: new Set(), // 생성 중인 영역 id
  logs: {}, // id → 생성 로그 텍스트
  images: {}, // id → 첨부 참고 이미지 목록
  inspectOn: false, // 미리보기 요소 직접 선택 모드
  inspected: null, // 미리보기에서 선택한 요소 정보
  sessionMode: 'integrated', // 'integrated' | 'region' | 'verify'
  activeSessionKey: '', // 현재 보고 있는 영역 세션 키 (예: region:header 또는 region:header:s1234)
  sessionsMap: {}, // /api/sessions 결과 캐시
  parallelMode: true, // 통합 세션 계획 실행 시 영역별 세션을 병렬로 동시 실행
  verify: { report: null, running: false, healing: false, healLog: '', history: [] },
  drag: null,
};

// ───────────── 서버 통신 ─────────────

let saveTimer;
function saveLayout(immediate = false) {
  clearTimeout(saveTimer);
  syncBreakpoint();
  const run = () => api('PUT', '/api/layout', state.layout).then(() => reloadPreview()).catch((e) => toast(e.message, true));
  if (immediate) return run();
  saveTimer = setTimeout(run, 400);
}

async function loadRegion(id, force = false) {
  if (state.files[id] && !force) return;
  const { files, history } = await api('GET', `/api/regions/${id}`);
  state.files[id] = files;
  state.history[id] = history;
  state.features[id] = await api('GET', `/api/regions/${id}/features`);
  const { pending } = await api('GET', `/api/regions/${id}/pending`);
  if (pending) state.pending[id] = { ...state.pending[id], files: pending.files, current: { html: files.html, css: files.css, js: files.js } };
  else delete state.pending[id];
}

const featureName = (b) => b.note?.name || b.label;

// ───────────── 유틸 ─────────────
const region = (id) => find(state.layout, id)?.region;
const allRegions = () => flatten(state.layout).map((e) => e.region);
const currentScreen = () => {
  if (Array.isArray(state.layout?.screens) && state.layout.screens.length) {
    return activeScreenOf(state.layout, state.activeScreenId);
  }
  return state.layout;
};
const rootContainer = () => currentScreen();
// 지금 편집 중인 컨테이너 (현재 화면 또는 안쪽 레이아웃을 가진 영역)
const atRoot = () => state.path.length === 0;
// 태블릿·모바일 배치를 편집 중인지 (최상위 그리드에서만)
const bpActive = () => state.device !== 'desktop' && atRoot() && state.layout.mode !== 'flow';
const cur = () => (bpActive() ? bpContainer() : containerAt(rootContainer(), state.path));

const DEVICES = {
  desktop: { label: '🖥', title: '데스크톱 (기본 배치)' },
  tablet: { label: '태블릿', title: '태블릿 (≤ 1024px)', frame: 820 },
  mobile: { label: '모바일', title: '모바일 (≤ 600px)', frame: 390 },
};

// 화면 크기별 배치는 최상위 영역의 좌표만 따로 가진다. 편집은 복사본(가상 컨테이너)에서 하고 저장할 때 되쓴다
function bpContainer() {
  const v = state.bpView;
  if (v && v.device === state.device && v.layout === state.layout && v.count === state.layout.regions.length) return v;
  const saved = state.layout.breakpoints?.[state.device];
  const base = saved?.regions ? null : defaultBreakpoint(state.device);
  const grid = { ...(saved?.grid || base.grid) };
  const regions = state.layout.regions.map((r) => {
    const p = saved?.regions?.[r.id] || base?.regions[r.id] || { x: 0, y: 0, w: grid.cols, h: 1 };
    return { ...r, x: p.x, y: p.y, w: p.w, h: p.h };
  });
  state.bpView = { device: state.device, layout: state.layout, count: regions.length, grid, regions, saved: Boolean(saved) };
  return state.bpView;
}

// 처음 열 때의 기본값: 태블릿은 데스크톱 그대로, 모바일은 위에서부터 한 줄씩 세로로 쌓기
function defaultBreakpoint(device) {
  const g = state.layout.grid;
  if (device === 'tablet') {
    return { grid: { cols: g.cols, rows: g.rows, gap: g.gap, fill: g.fill }, regions: Object.fromEntries(state.layout.regions.map((r) => [r.id, { x: r.x, y: r.y, w: r.w, h: r.h }])) };
  }
  let y = 0;
  const regions = {};
  for (const r of sorted(state.layout.regions)) {
    const h = Math.max(2, Math.min(r.h, 6));
    regions[r.id] = { x: 0, y, w: 12, h };
    y += h;
  }
  return { grid: { cols: 12, rows: Math.max(y, 1), gap: g.gap, fill: false, rowHeight: 48 }, regions };
}

// 가상 컨테이너의 좌표를 layout.breakpoints 에 되쓴다 (저장 직전)
function syncBreakpoint() {
  if (!bpActive() || !state.bpView) return;
  const v = state.bpView;
  state.layout.breakpoints ||= {};
  state.layout.breakpoints[state.device] = { grid: { ...v.grid }, regions: Object.fromEntries(v.regions.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h }])) };
  v.saved = true;
}


function isValid(rect, ignoreId) {
  const ignore = cur().regions.filter((r) => isOverlay(r)).map((r) => r.id);
  return fits(cur(), rect, ignoreId ? [ignoreId, ...ignore] : ignore);
}

// 대화상자만 담은 영역은 화면 칸을 차지하지 않는다 (캔버스 아래에 따로 표시)
function isOverlay(r) {
  const blocks = state.features[r.id]?.blocks;
  return !isContainer(r) && Boolean(blocks?.length) && blocks.every((b) => b.tag === 'dialog');
}

function nextId() {
  const base = atRoot() ? 'region' : state.path.at(-1);
  let n = cur().regions.length + 1;
  while (region(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// 안쪽 레이아웃으로 들어간다 (코드가 있는 영역은 내용을 잃지 않게 "안쪽으로 나누기"를 쓰게 한다)
function enter(id) {
  const r = region(id);
  if (!r) return;
  if (!isContainer(r) && hasCode(id)) {
    return toast('이미 구현된 영역입니다. 인스펙터의 "안쪽으로 나누기"로 내용을 보존하며 나누세요', true);
  }
  r.grid ||= { ...DEFAULT_INNER_GRID };
  r.regions ||= [];
  state.path = [...ancestors(state.layout, id), id];
  state.multi.clear();
  state.selected = null;
  renderAll();
  fitCanvas();
}

function goTo(depth) {
  state.path = state.path.slice(0, depth);
  state.multi.clear();
  renderAll();
  fitCanvas();
}

function hasCode(id) {
  const f = state.files[id];
  return f && (f.html.trim() || f.js.trim());
}

// ───────────── 캔버스 ─────────────
const canvas = $('#canvas');

function cellAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const { cols, rows } = cur().grid;
  const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
  return {
    col: clamp(Math.floor(((ev.clientX - rect.left) / rect.width) * cols), cols),
    row: clamp(Math.floor(((ev.clientY - rect.top) / rect.height) * rows), rows),
  };
}

function placeStyle(r, grid = cur().grid, pad = 3) {
  const { cols, rows } = grid;
  return `left:calc(${(r.x / cols) * 100}% + ${pad}px);top:calc(${(r.y / rows) * 100}% + ${pad}px);` +
    `width:calc(${(r.w / cols) * 100}% - ${pad * 2}px);height:calc(${(r.h / rows) * 100}% - ${pad * 2}px);`;
}

// 안쪽 레이아웃의 축소판 (영역 상자 안에 하위 영역 배치를 그려 보여 줌)
function miniature(r) {
  if (!isContainer(r)) return '';
  const boxes = r.regions
    .map((c) => `<div class="mini" style="--c:${c.color};${placeStyle(c, r.grid, 1)}">${isContainer(c) ? miniature(c) : `<span>${esc(c.title || c.id)}</span>`}</div>`)
    .join('');
  return `<div class="minis">${boxes}</div>`;
}

// 캔버스 상자 안에 그 영역의 기능 이름을 칩으로
function featureChips(id) {
  const blocks = state.features[id]?.blocks || [];
  if (!blocks.length) return '';
  const max = 6;
  return `<div class="chips">${blocks.slice(0, max).map((b) => `<span class="chip"${b.fid ? ` draggable="true" data-drag-fid="${b.fid}" data-drag-from="${esc(id)}" title="끌어서 다른 영역에 놓으면 기능을 옮깁니다"` : ''}>${esc(featureName(b))}</span>`).join('')}${
    blocks.length > max ? `<span class="chip more">+${blocks.length - max}</span>` : ''}</div>`;
}

function renderCrumbs() {
  const names = ['앱', ...state.path.map((id) => region(id)?.title || id)];
  $('#crumbs').innerHTML = names
    .map((n, i) => (i === names.length - 1 ? `<b>${esc(n)}</b>` : `<a href="#" data-depth="${i}">${esc(n)}</a>`))
    .join(' <span class="muted">›</span> ') +
    (atRoot() ? '' : ` <span class="muted">· 안쪽 레이아웃 ${cur().grid.cols}×${cur().grid.rows}</span>`) +
    (bpActive() ? ` <span class="badge-soft">${DEVICES[state.device].title}</span> ${cur().saved ? '<a href="#" data-bp-reset>기본값으로</a>' : '<span class="muted">(기본값 — 옮기면 저장)</span>'}` : '') +
    '<span class="spacer"></span><span class="muted">더블클릭: 안쪽 레이아웃 · Shift+클릭: 여러 개 선택</span>';
}

function renderCanvas() {
  const { cols, rows } = cur().grid;
  const lines = `<div class="gridlines" style="background-image:
    linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
    background-size: calc(100% / ${cols}) calc(100% / ${rows});"></div>`;

  const flowRoot = atRoot() && state.layout.mode === 'flow';
  const overlays = flowRoot ? [] : cur().regions.filter(isOverlay);
  $('#overlayBar').innerHTML = overlays.length
    ? `<span class="muted">오버레이 (칸을 차지하지 않음):</span> ${overlays.map((r) => `<button class="chip overlay-chip${state.selected === r.id ? ' on' : ''}" data-overlay="${r.id}" style="--c:${r.color}">${esc(r.title || r.id)} · 기능 ${state.features[r.id].blocks.length}개</button>`).join('')}`
    : '';
  const visibleRegs = cur().regions.filter((r) => !overlays.includes(r));
  const multiScreens = getScreens(state.layout).length > 1;
  const items = visibleRegs.map((r) => {
    const d = state.drag;
    const live = d && d.id === r.id && d.rect ? { ...r, ...d.rect } : r;
    const isSwapTarget = d?.mode === 'move' && d.swapId === r.id;
    const invalid = d && d.id === r.id && d.rect && !d.swapId && !isValid(d.rect, r.id);
    const prompt = state.files[r.id]?.prompt || '';
    const container = isContainer(r);
    const sel = state.selected === r.id ? ' selected' : state.multi.has(r.id) ? ' multi' : '';
    const toolbar = state.selected === r.id && !d && !bpActive() && state.layout.mode !== 'flow' ? `
      <div class="r-toolbar" data-rbar="${r.id}">
        ${container ? '' : `<button type="button" data-rcmd="split-h" title="좌우로 2등분">⫴</button><button type="button" data-rcmd="split-v" title="상하로 2등분">☰</button>`}
        ${multiScreens && atRoot() ? `<button type="button" data-rcmd="move-screen" title="다른 화면(페이지)으로 이동">↗</button>` : ''}
        <button type="button" class="del" data-rcmd="delete" title="영역 삭제">🗑</button>
      </div>` : '';
    return `<div class="region${sel}${isSwapTarget ? ' swap-target' : ''}${container ? ' container' : ''}${invalid ? ' invalid' : ''}${state.busy.has(r.id) ? ' busy' : ''}"
        data-id="${r.id}" style="--c:${r.color};${placeStyle(live)}">
      ${toolbar}
      ${state.busy.has(r.id) ? '<span class="busy-pill r-busy-tag">⚡ 작업 중</span>' : ''}
      <div class="r-title" data-rtitle="${r.id}" title="더블클릭해 이름 변경">${esc(r.title || r.id)}</div>
      <div class="r-id">#${esc(r.id)}${container ? ` · ▦ 안쪽 ${r.regions.length}개` : hasCode(r.id) ? ' · ✓ 구현됨' : ''}${isSwapTarget ? ' · 🔄 놓으면 자리 바꿈' : ''}</div>
      ${container ? miniature(r) : featureChips(r.id) || `<div class="r-prompt">${esc(prompt)}</div>`}
      <div class="r-size">${live.w}×${live.h}</div>
      <div class="handle" data-handle="1"></div>
    </div>`;
  });

  // 맞닿은 영역 사이 경계선 드래그 핸들 (스플리터)
  state.splitters = (!flowRoot && state.drag?.mode !== 'draw') ? findSplitters(visibleRegs) : [];
  const gutters = state.splitters.map((sp, idx) => {
    const active = state.drag?.mode === 'splitter' && state.drag.splitterIndex === idx ? ' active' : '';
    const style = sp.axis === 'v'
      ? `left:${(sp.line / cols) * 100}%;top:${(sp.start / rows) * 100}%;height:${((sp.end - sp.start) / rows) * 100}%`
      : `top:${(sp.line / rows) * 100}%;left:${(sp.start / cols) * 100}%;width:${((sp.end - sp.start) / cols) * 100}%`;
    return `<div class="gutter gutter-${sp.axis}${active}" data-splitter="${idx}" style="${style}" title="드래그해서 양쪽 영역 크기 동시 조절"></div>`;
  }).join('');

  let ghost = '';
  if (state.drag?.mode === 'draw' && state.drag.rect) {
    const ok = isValid(state.drag.rect);
    ghost = `<div class="region ghost${ok ? '' : ' invalid'}" style="--c:${COLORS[cur().regions.length % COLORS.length]};${placeStyle(state.drag.rect)}">
      <div class="r-size">${state.drag.rect.w}×${state.drag.rect.h}</div></div>`;
  }
  canvas.innerHTML = lines + items.join('') + gutters + ghost;
  renderCrumbs();
}

$('#crumbs').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-bp-reset]')) {
    ev.preventDefault();
    return resetBreakpoint();
  }
  const a = ev.target.closest('a[data-depth]');
  if (!a) return;
  ev.preventDefault();
  goTo(Number(a.dataset.depth));
});

$('#overlayBar').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-overlay]');
  if (!b) return;
  state.multi.clear();
  select(b.dataset.overlay);
});

canvas.addEventListener('dblclick', async (ev) => {
  const titleEl = ev.target.closest('[data-rtitle]');
  if (titleEl) {
    ev.stopPropagation();
    const r = region(titleEl.dataset.rtitle);
    if (!r) return;
    const next = await promptBox('영역 이름 변경', r.title || r.id);
    if (!next?.trim() || next.trim() === r.title) return;
    r.title = next.trim();
    saveLayout();
    return renderAll();
  }
  const el = ev.target.closest('.region');
  if (el) enter(el.dataset.id);
});

canvas.addEventListener('click', async (ev) => {
  const cmdBtn = ev.target.closest('[data-rcmd]');
  if (!cmdBtn) return;
  ev.stopPropagation();
  const id = cmdBtn.closest('[data-rbar]')?.dataset.rbar;
  if (!id) return;
  const cmd = cmdBtn.dataset.rcmd;
  if (cmd === 'delete') return deleteRegion(id);
  if (cmd === 'split-h' || cmd === 'split-v') {
    const dir = cmd === 'split-h' ? 'h' : 'v';
    return layoutOp('POST', `/api/regions/${id}/split`, { dir, count: 2, inner: false }, `${dir === 'h' ? '좌우' : '상하'}로 나누었습니다`);
  }
  if (cmd === 'move-screen') {
    const scrs = getScreens(state.layout);
    const curId = activeScreenOf(state.layout, state.activeScreenId).id;
    const others = scrs.filter((s) => s.id !== curId);
    if (!others.length) return;
    const dlg = await dialog('다른 화면으로 이동', `<div class="pick-list">${others.map((s, i) => `<label><input type="radio" name="pickScr" value="${esc(s.id)}" ${i ? '' : 'checked'}> 📄 ${esc(s.title || s.id)}</label>`).join('')}</div>`, '이동');
    const dstId = dlg?.querySelector('input[name=pickScr]:checked')?.value;
    if (!dstId) return;
    const srcScr = scrs.find((s) => s.id === curId);
    const dstScr = scrs.find((s) => s.id === dstId);
    const idx = srcScr.regions.findIndex((x) => x.id === id);
    if (idx < 0 || !dstScr) return;
    const [moved] = srcScr.regions.splice(idx, 1);
    const maxY = dstScr.regions.reduce((m, x) => Math.max(m, x.y + x.h), 0);
    const g = dstScr.grid || { cols: 12, rows: 12 };
    if (maxY + moved.h > g.rows) g.rows = maxY + Math.max(2, moved.h);
    Object.assign(moved, { x: 0, y: maxY, w: g.cols, h: Math.max(2, Math.min(4, moved.h)) });
    dstScr.regions.push(moved);
    state.selected = null;
    saveLayout(true);
    renderAll();
    toast(`"${moved.title || moved.id}" 영역을 "${dstScr.title}" 화면으로 옮겼습니다`);
  }
});

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (ev.target.closest('[data-drag-fid], [data-rcmd], .r-toolbar')) return;
  const gut = ev.target.closest('[data-splitter]');
  if (gut) {
    const idx = Number(gut.dataset.splitter);
    const sp = state.splitters?.[idx];
    if (!sp) return;
    canvas.setPointerCapture(ev.pointerId);
    state.drag = { mode: 'splitter', splitterIndex: idx, splitter: { ...sp }, moved: false };
    return renderCanvas();
  }
  const el = ev.target.closest('.region');
  const cell = cellAt(ev);
  canvas.setPointerCapture(ev.pointerId);
  if (!el) {
    if (bpActive()) {
      select(null);
      return toast('영역 추가·나누기는 🖥 데스크톱에서 합니다. 여기서는 위치·크기만 바꿉니다');
    }
    state.drag = { mode: 'draw', start: cell, rect: null }; // 움직여야 그려짐 (단순 클릭은 선택 해제)
  } else {
    const r = geoOf(el.dataset.id);
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      toggleMulti(r.id);
      return;
    }
    state.multi.clear();
    select(r.id);
    state.drag = { mode: ev.target.dataset.handle ? 'resize' : 'move', id: r.id, start: cell, orig: { ...r }, rect: null, swapId: null };
  }
  renderCanvas();
});

canvas.addEventListener('pointermove', (ev) => {
  const d = state.drag;
  if (!d) return;
  const { cols, rows } = cur().grid;
  if (d.mode === 'splitter') {
    const rect = canvas.getBoundingClientRect();
    const target = d.splitter.axis === 'v'
      ? Math.round(((ev.clientX - rect.left) / rect.width) * cols)
      : Math.round(((ev.clientY - rect.top) / rect.height) * rows);
    if (applySplitterMove(cur().regions, d.splitter, target)) {
      d.moved = true;
      renderCanvas();
    }
    return;
  }
  const c = cellAt(ev);
  if (d.mode === 'draw') {
    d.rect = {
      x: Math.min(d.start.col, c.col),
      y: Math.min(d.start.row, c.row),
      w: Math.abs(c.col - d.start.col) + 1,
      h: Math.abs(c.row - d.start.row) + 1,
    };
  } else if (d.mode === 'move') {
    const o = d.orig;
    d.rect = {
      x: Math.max(0, Math.min(cols - o.w, o.x + c.col - d.start.col)),
      y: Math.max(0, Math.min(rows - o.h, o.y + c.row - d.start.row)),
      w: o.w,
      h: o.h,
    };
    const swapTarget = !isValid(d.rect, d.id) ? findSwapTarget(cur().regions, d.id, c) : null;
    d.swapId = swapTarget?.id || null;
  } else {
    const o = d.orig;
    d.rect = { x: o.x, y: o.y, w: Math.max(1, c.col - o.x + 1), h: Math.max(1, c.row - o.y + 1) };
  }
  renderCanvas();
});

canvas.addEventListener('pointerup', () => {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.mode === 'splitter') {
    if (d.moved) saveLayout();
    return renderAll();
  }
  if (d.mode === 'draw') {
    if (d.rect && isValid(d.rect)) {
      const id = nextId();
      const list = cur().regions;
      const parentTitle = atRoot() ? '영역' : `${region(state.path.at(-1)).title || state.path.at(-1)} -`;
      list.push({
        id,
        title: `${parentTitle} ${list.length + 1}`,
        color: COLORS[(allRegions().length + list.length) % COLORS.length],
        ...d.rect,
      });
      state.files[id] = { html: '', css: '', js: '', prompt: '' };
      state.history[id] = [];
      saveLayout(true);
      select(id, 'prompt');
      return;
    }
    if (!d.rect) return select(null);
    toast('다른 영역과 겹칩니다', true);
  } else if (d.mode === 'move' && d.swapId) {
    const a = geoOf(d.id);
    const b = geoOf(d.swapId);
    if (a && b) {
      swapRegionGeometry(a, b);
      saveLayout();
      toast(`"${a.title || a.id}" ↔ "${b.title || b.id}" 자리를 바꿨습니다`);
    }
  } else if (d.rect && isValid(d.rect, d.id)) {
    const r = geoOf(d.id);
    const changed = r.x !== d.rect.x || r.y !== d.rect.y || r.w !== d.rect.w || r.h !== d.rect.h;
    Object.assign(r, d.rect);
    if (changed) saveLayout();
  } else if (d.rect) {
    toast('다른 영역과 겹치거나 그리드를 벗어납니다', true);
  }
  renderAll();
});

// 원클릭 배치 프리셋 바
const presetBar = $('#layoutPresetBar');
if (presetBar) {
  presetBar.innerHTML = `<span class="muted">⚡ 빠른 배치:</span>` +
    LAYOUT_PRESETS.map((p) => `<button type="button" class="btn ghost small" data-layout-preset="${p.id}" title="${esc(p.title)}">${esc(p.label)}</button>`).join('');
  presetBar.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-layout-preset]');
    if (!b) return;
    const container = cur();
    if (!container.regions?.length) return toast('먼저 영역을 추가해 주세요', true);
    const { cols, rows } = container.grid;
    const arranged = applyLayoutPreset(container.regions, b.dataset.layoutPreset, cols, rows);
    container.regions.forEach((r, i) => Object.assign(r, { x: arranged[i].x, y: arranged[i].y, w: arranged[i].w, h: arranged[i].h }));
    saveLayout(true);
    renderAll();
    fitCanvas();
    toast(`"${b.textContent}" 배치로 정리했습니다 (원하는 대로 경계선·자리를 미세 조정하세요)`);
  });
}

// 캔버스 하단 "말로 배치 고치기"
async function runCanvasAiAdjust() {
  const inp = $('#canvasAiInput');
  const btn = $('#btnCanvasAiAdjust');
  const instruction = (inp?.value || '').trim();
  if (!instruction) return toast('어떻게 배치를 바꿀지 한 줄로 적어 주세요', true);
  btn.disabled = true;
  btn.textContent = '배치 조정 중…';
  try {
    const screenId = activeScreenOf(state.layout, state.activeScreenId).id;
    const r = await api('POST', '/api/layout/ai-adjust', { instruction, screenId });
    state.layout = r.layout;
    inp.value = '';
    toast(`✨ ${r.summary}`);
    reloadPreview();
    renderAll();
    fitCanvas();
  } catch (e) {
    toast(e.message, true);
  }
  btn.disabled = false;
  btn.textContent = '✨ 배치 적용';
}
$('#btnCanvasAiAdjust')?.addEventListener('click', runCanvasAiAdjust);
$('#canvasAiInput')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); runCanvasAiAdjust(); }
});

new ResizeObserver(() => fitCanvas()).observe($('#canvasWrap'));

// ───────────── 화면 크기 (데스크톱 / 태블릿 / 모바일) ─────────────
function renderDeviceSeg() {
  const seg = $('#deviceSeg');
  seg.hidden = state.layout.mode === 'flow';
  seg.innerHTML = Object.entries(DEVICES)
    .map(([k, d]) => {
      const has = k !== 'desktop' && state.layout.breakpoints?.[k];
      return `<button data-device="${k}" class="${state.device === k ? 'on' : ''}" title="${d.title}${k === 'desktop' ? '' : has ? ' — 따로 정한 배치 있음' : ' — 아직 따로 정하지 않음'}">${d.label}${has ? ' •' : ''}</button>`;
    })
    .join('');
  // 미리보기도 그 기기 폭으로
  const frame = DEVICES[state.device].frame;
  $('#preview').style.width = frame ? `${frame}px` : '';
  $('#preview').style.margin = frame ? '0 auto' : '';
}

$('#deviceSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-device]');
  if (!b) return;
  state.device = b.dataset.device;
  state.bpView = null;
  state.path = [];
  state.multi.clear();
  if (state.device !== 'desktop' && $('#stage').dataset.view === 'design') setView('split');
  renderAll();
  fitCanvas();
  if (state.device !== 'desktop' && !state.layout.breakpoints?.[state.device]) {
    toast(`${DEVICES[state.device].title} 배치를 처음 엽니다. 영역을 옮기면 이 화면용으로 저장됩니다`);
  }
});

// 이 화면 크기의 배치를 지우고 기본값(태블릿=데스크톱 그대로, 모바일=세로로 쌓기)으로
function resetBreakpoint() {
  if (state.layout.breakpoints) delete state.layout.breakpoints[state.device];
  state.bpView = null;
  api('PUT', '/api/layout', state.layout).then(() => reloadPreview());
  renderAll();
  fitCanvas();
  toast('기본 배치로 되돌렸습니다');
}

// 위치·크기를 읽고 쓰는 대상: 태블릿·모바일 편집 중이면 그 화면용 좌표, 아니면 영역 자신
const geoOf = (id) => (bpActive() ? cur().regions.find((c) => c.id === id) : null) || region(id);

const atRootFill = () => state.layout.mode !== 'flow' && state.layout.grid.fill;

// 캔버스 비율을 실제 앱 화면 비율에 맞춘다
function fitCanvas() {
  if (!state.layout) return;
  const wrap = $('#canvasWrap');
  const { grid } = state.layout;
  const W = wrap.clientWidth - 32;
  const H = wrap.clientHeight - 32;
  if (bpActive()) {
    // 태블릿·모바일: 기기 비율의 캔버스 (화면 채우기면 세로로 긴 화면, 아니면 행 수만큼)
    const g = cur().grid;
    const fw = Math.min(W, state.device === 'mobile' ? 300 : 520);
    canvas.style.flex = '0 0 auto';
    canvas.style.width = `${fw}px`;
    canvas.style.height = `${g.fill ? Math.min(H, fw * (state.device === 'mobile' ? 2 : 1.35)) : Math.max(g.rows * 34, 120)}px`;
  } else if (!atRoot()) {
    // 안쪽 레이아웃: 그 영역의 실제 가로세로 비율에 가깝게
    const r = region(state.path.at(-1));
    const parentGrid = find(state.layout, r.id).parent.grid;
    const ratio = (r.h / parentGrid.rows) / (r.w / parentGrid.cols) * (atRootFill() ? H / W : 0.6);
    canvas.style.flex = '0 0 auto';
    canvas.style.width = `${W}px`;
    canvas.style.height = `${Math.max(cur().grid.rows * 22, Math.min(H, W * ratio))}px`;
  } else if (state.layout.mode === 'flow') {
    // 가져온 앱: 영역을 위에서 아래로 쌓은 목록처럼 보여 준다
    canvas.style.flex = '0 0 auto';
    canvas.style.width = `${W}px`;
    canvas.style.height = `${grid.rows * 64}px`;
  } else if (grid.fill) {
    canvas.style.flex = '1';
    canvas.style.height = canvas.style.width = '';
  } else {
    const h = Math.min(H, (W / grid.cols) * grid.rows * 0.5);
    canvas.style.flex = '0 0 auto';
    canvas.style.width = `${W}px`;
    canvas.style.height = `${Math.max(h, grid.rows * 24)}px`;
  }
}

// ───────────── 화면(페이지) & 영역 목록 ─────────────
function ensureScreensArray() {
  if (!Array.isArray(state.layout.screens) || !state.layout.screens.length) {
    state.layout.screens = [{
      id: 'main',
      title: '메인 화면',
      grid: { ...(state.layout.grid || { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 }) },
      regions: state.layout.regions || [],
    }];
    state.activeScreenId = 'main';
    state.layout.activeScreen = 'main';
  }
  return state.layout.screens;
}

// 계층(상위 → 하위 트리) 순서로 화면 목록을 정렬해 반환한다
function orderedScreens(screens) {
  const byId = new Map(screens.map((s) => [s.id, s]));
  const roots = screens.filter((s) => !s.parentScreen || !byId.has(s.parentScreen) || s.parentScreen === s.id);
  const out = [];
  const visit = (sc, depth) => {
    if (out.some((x) => x.sc.id === sc.id)) return;
    out.push({ sc, depth });
    for (const child of screens.filter((c) => c.parentScreen === sc.id && c.id !== sc.id)) {
      visit(child, Math.min(2, depth + 1));
    }
  };
  for (const r of roots) visit(r, 0);
  for (const sc of screens) visit(sc, 0);
  return out;
}

// 빈칸이 없으면 기존 레이아웃을 왼쪽(2/3)으로 모으고, 병합할 페이지 영역을 오른쪽(1/3)에 겹침 없이 배치한다
function mergeScreensSideBySide(targetSc, sourceSc) {
  const g = (targetSc.grid ||= { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 });
  const cols = Math.max(12, Number(g.cols) || 12);
  const rows = Math.max(12, Number(g.rows) || 12);
  g.cols = cols;
  g.rows = rows;
  const srcCols = Math.max(1, Number(sourceSc.grid?.cols) || 12);
  const srcRows = Math.max(1, Number(sourceSc.grid?.rows) || 12);
  const existing = targetSc.regions || [];
  const incoming = (sourceSc.regions || []).map((r) => ({ ...r }));
  if (!incoming.length) return;

  // 기존 영역이 오른쪽 1/3 공간을 이미 차지하고 있으면 겹치지 않도록 왼쪽 2/3로 자동 축소
  const leftCols = Math.max(4, Math.floor((cols * 2) / 3));
  const rightCols = cols - leftCols;
  const overlapsRight = existing.some((r) => (r.x + r.w) > leftCols);
  if (overlapsRight && existing.length) {
    for (const r of existing) {
      const nx = Math.floor((r.x / cols) * leftCols);
      const nx2 = Math.max(nx + 1, Math.min(leftCols, Math.round(((r.x + r.w) / cols) * leftCols)));
      r.x = nx;
      r.w = Math.max(1, nx2 - nx);
    }
  }
  for (const r of incoming) {
    const rx = Math.floor((r.x / srcCols) * rightCols);
    const rx2 = Math.max(rx + 1, Math.min(rightCols, Math.round(((r.x + r.w) / srcCols) * rightCols)));
    const ry = Math.floor((r.y / srcRows) * rows);
    const ry2 = Math.max(ry + 1, Math.min(rows, Math.round(((r.y + r.h) / srcRows) * rows)));
    r.x = leftCols + rx;
    r.w = Math.max(1, rx2 - rx);
    r.y = ry;
    r.h = Math.max(1, ry2 - ry);
    existing.push(r);
  }
  targetSc.regions = existing;
}

function renderCompanionPane() {
  const pane = $('#companionPane');
  const wrap = $('#canvasWrap');
  if (!pane || !wrap) return;
  const screens = getScreens(state.layout);
  const curSc = activeScreenOf(state.layout, state.activeScreenId);
  const compId = state.companionScreenId && state.companionScreenId !== curSc.id ? state.companionScreenId : '';
  const comp = compId ? screens.find((s) => s.id === compId) : null;
  if (!comp) {
    pane.hidden = true;
    wrap.classList.remove('has-companion');
    return;
  }
  pane.hidden = false;
  wrap.classList.add('has-companion');
  const cols = comp.grid?.cols || 12;
  const rows = comp.grid?.rows || 12;
  const isChild = comp.parentScreen === curSc.id;
  pane.innerHTML = `
    <div class="companion-head">
      <span>${isChild ? '📂 하위 페이지' : '📄 나란히 보기'}</span>
      <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(comp.title || comp.id)}</b>
      <button type="button" class="btn tiny" id="btnCompFocus" title="이 페이지를 메인 캔버스에서 편집">편집</button>
      <button type="button" class="btn tiny ghost" id="btnCompClose" title="나란히 보기 닫기">✕</button>
    </div>
    <p class="muted small-note" style="margin:0">기존 페이지 옆에서 구성을 함께 보며 정리할 수 있습니다. 영역을 누르면 바로 해당 페이지 편집으로 전환됩니다.</p>
    <div class="companion-grid">
      ${(comp.regions || []).map((r) => `
        <div class="companion-reg" data-comp-reg="${esc(r.id)}" style="--c:${r.color || '#5b5bd6'};left:${(r.x / cols) * 100}%;top:${(r.y / rows) * 100}%;width:${(r.w / cols) * 100}%;height:${(r.h / rows) * 100}%" title="${esc(r.title || r.id)}">
          ${esc(r.title || r.id)}
        </div>`).join('') || '<span class="muted small-note" style="padding:10px;display:block">영역이 없습니다</span>'}
    </div>`;
  $('#btnCompClose')?.addEventListener('click', () => { state.companionScreenId = ''; renderCompanionPane(); fitCanvas(); });
  $('#btnCompFocus')?.addEventListener('click', () => {
    const prevId = curSc.id;
    state.activeScreenId = comp.id;
    state.layout.activeScreen = comp.id;
    state.companionScreenId = prevId;
    state.path = [];
    renderAll();
    fitCanvas();
  });
  pane.querySelectorAll('[data-comp-reg]').forEach((el) => {
    el.addEventListener('click', () => {
      const prevId = curSc.id;
      state.activeScreenId = comp.id;
      state.layout.activeScreen = comp.id;
      state.companionScreenId = prevId;
      state.selected = el.dataset.compReg;
      state.path = [];
      renderAll();
      fitCanvas();
    });
  });
}

function renderScreenBar() {
  const bar = $('#screenBar');
  const pBar = $('#previewScreenBar');
  if (!state.layout) return;
  const screens = getScreens(state.layout);
  const ordered = orderedScreens(screens);
  const curId = activeScreenOf(state.layout, state.activeScreenId).id;
  if (bar) {
    bar.innerHTML = ordered.map(({ sc, depth }, idx) => {
      const scBusy = flatten(sc).some((e) => state.busy.has(e.region.id));
      return `
      <div class="screen-tab ${sc.id === curId ? 'on' : ''} ${depth > 0 ? 'is-child' : ''} ${scBusy ? 'is-busy' : ''}" data-screen-id="${esc(sc.id)}" draggable="true" title="드래그해서 다른 페이지 위에 놓으면 합치기/하위 연결, 위아래 경계에 놓으면 순서를 바꿉니다">
        <span>${depth > 0 ? '↳' : '📄'}</span>
        <span class="sc-name" title="${esc(sc.title || sc.id)}">${esc(sc.title || sc.id)}</span>
        ${scBusy ? '<span class="busy-pill">⚡ 작업 중</span>' : idx === 0 && screens.length > 1 ? '<span class="sc-main-badge">메인</span>' : ''}
        <span class="muted" style="font-size:10px">${(sc.regions || []).length}</span>
        ${depth > 0 ? `<button type="button" class="sc-del" data-detach-screen="${esc(sc.id)}" title="하위 연결 해제 (독립 페이지로)">↗</button>` : ''}
        ${screens.length > 1 ? `<button type="button" class="sc-del" data-del-screen="${esc(sc.id)}" title="이 화면 삭제">✕</button>` : ''}
      </div>`;
    }).join('');
  }
  if (pBar) {
    pBar.hidden = screens.length <= 1;
    pBar.innerHTML = screens.length > 1
      ? `<span class="muted small-note" style="flex:none">화면:</span>` +
        ordered.map(({ sc, depth }) => `<button type="button" class="ps-btn ${sc.id === curId ? 'on' : ''}" data-preview-screen="${esc(sc.id)}">${depth > 0 ? '↳ ' : '📄 '}${esc(sc.title || sc.id)}</button>`).join('')
      : '';
  }
  renderCompanionPane();
}

$('#previewScreenBar')?.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-preview-screen]');
  if (!b) return;
  const sid = b.dataset.previewScreen;
  state.activeScreenId = sid;
  state.layout.activeScreen = sid;
  state.path = [];
  state.multi.clear();
  renderScreenBar();
  renderList();
  renderCanvas();
  const link = $('#previewNewTab');
  if (link && !window.__WEB_STANDALONE__) link.href = `${PREVIEW_BASE}/preview?screen=${encodeURIComponent(sid)}`;
  preview.contentWindow?.postMessage({ type: 'switch-screen', screen: sid }, '*');
});

// 12×12 ↔ 24×24 격자 밀도 원클릭 전환 (기존 영역 좌표 자동 스케일링)
$('#btnDenseGrid')?.addEventListener('click', () => {
  const c = cur();
  if (!c?.grid) return;
  const isDense = c.grid.cols >= 24;
  if (!isDense) {
    const scaleX = 24 / c.grid.cols;
    const scaleY = 24 / c.grid.rows;
    c.grid.cols = 24;
    c.grid.rows = 24;
    for (const r of c.regions || []) {
      r.x = Math.round(r.x * scaleX);
      r.y = Math.round(r.y * scaleY);
      r.w = Math.max(1, Math.round(r.w * scaleX));
      r.h = Math.max(1, Math.round(r.h * scaleY));
    }
    toast('격자를 24×24로 2배 촘촘하게 전환했습니다');
  } else {
    c.grid.cols = 12;
    c.grid.rows = 12;
    for (const r of c.regions || []) {
      r.x = Math.min(11, Math.floor(r.x / 2));
      r.y = Math.min(11, Math.floor(r.y / 2));
      r.w = Math.max(1, Math.min(12 - r.x, Math.round(r.w / 2)));
      r.h = Math.max(1, Math.min(12 - r.y, Math.round(r.h / 2)));
    }
    toast('격자를 기본 12×12로 되돌렸습니다');
  }
  saveLayout(true);
  renderAll();
  fitCanvas();
});

$('#screenBar')?.addEventListener('click', async (ev) => {
  const detach = ev.target.closest('[data-detach-screen]');
  if (detach) {
    const id = detach.dataset.detachScreen;
    const sc = ensureScreensArray().find((s) => s.id === id);
    if (sc) {
      delete sc.parentScreen;
      if (state.companionScreenId === id) state.companionScreenId = '';
      saveLayout(true);
      renderAll();
      toast(`"${sc.title || id}" 페이지를 독립 페이지로 분리했습니다`);
    }
    return;
  }
  const del = ev.target.closest('[data-del-screen]');
  if (del) {
    const id = del.dataset.delScreen;
    const screens = ensureScreensArray();
    if (screens.length <= 1) return;
    const target = screens.find((s) => s.id === id);
    if (!(await confirmBox(`"${target?.title || id}" 화면을 삭제할까요?\n화면 안의 영역은 안전하게 백업됩니다.`, '삭제'))) return;
    for (const s of screens) if (s.parentScreen === id) delete s.parentScreen;
    state.layout.screens = screens.filter((s) => s.id !== id);
    if (state.activeScreenId === id) state.activeScreenId = state.layout.screens[0].id;
    if (state.companionScreenId === id) state.companionScreenId = '';
    state.layout.activeScreen = state.activeScreenId;
    state.layout.regions = state.layout.screens[0].regions;
    state.selected = null;
    state.path = [];
    saveLayout(true);
    return renderAll();
  }
  const tab = ev.target.closest('[data-screen-id]');
  if (!tab) return;
  state.activeScreenId = tab.dataset.screenId;
  state.layout.activeScreen = state.activeScreenId;
  state.path = [];
  state.multi.clear();
  preview.contentWindow?.postMessage({ type: 'switch-screen', screen: state.activeScreenId }, '*');
  renderAll();
  fitCanvas();
});

// 화면(페이지) 드래그 앤 드롭: 다른 페이지 위에 놓으면 합치기/하위 연결 선택 → 레이아웃 편집창으로 이동
let dragScreenId = '';
const clearScreenDropMarks = () => $('#screenBar')?.querySelectorAll('.screen-tab').forEach((el) => el.classList.remove('drop-onto', 'drop-before', 'drop-after'));

$('#screenBar')?.addEventListener('dragstart', (ev) => {
  const tab = ev.target.closest('.screen-tab[data-screen-id]');
  if (!tab) return;
  dragScreenId = tab.dataset.screenId;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', dragScreenId);
});
$('#screenBar')?.addEventListener('dragend', () => {
  dragScreenId = '';
  clearScreenDropMarks();
});
$('#screenBar')?.addEventListener('dragover', (ev) => {
  if (!dragScreenId) return;
  const tab = ev.target.closest('.screen-tab[data-screen-id]');
  if (!tab || tab.dataset.screenId === dragScreenId) return;
  ev.preventDefault();
  clearScreenDropMarks();
  const rect = tab.getBoundingClientRect();
  const ratio = (ev.clientY - rect.top) / Math.max(1, rect.height);
  if (ratio < 0.25) tab.classList.add('drop-before');
  else if (ratio > 0.75) tab.classList.add('drop-after');
  else tab.classList.add('drop-onto');
});
$('#screenBar')?.addEventListener('drop', async (ev) => {
  const tab = ev.target.closest('.screen-tab[data-screen-id]');
  const srcId = dragScreenId || ev.dataTransfer.getData('text/plain');
  dragScreenId = '';
  const mode = tab?.classList.contains('drop-before') ? 'before' : tab?.classList.contains('drop-after') ? 'after' : 'onto';
  clearScreenDropMarks();
  if (!tab || !srcId || tab.dataset.screenId === srcId) return;
  ev.preventDefault();
  const dstId = tab.dataset.screenId;
  const screens = ensureScreensArray();
  const src = screens.find((s) => s.id === srcId);
  const dst = screens.find((s) => s.id === dstId);
  if (!src || !dst) return;

  // 위·아래 경계에 놓으면 순서 변경 (맨 위가 자동으로 메인페이지)
  if (mode === 'before' || mode === 'after') {
    const rest = screens.filter((s) => s.id !== srcId);
    let idx = rest.findIndex((s) => s.id === dstId);
    if (mode === 'after') idx++;
    rest.splice(idx, 0, src);
    state.layout.screens = rest;
    state.layout.regions = rest[0].regions;
    saveLayout(true);
    renderAll();
    toast(idx === 0 ? `"${src.title || src.id}" 페이지를 메인페이지(첫 화면)로 올렸습니다` : `페이지 순서를 변경했습니다`);
    return;
  }

  // 다른 페이지 위에 놓으면 합치기 vs 하위 페이지 연결 선택 + AI에게 전달할 이유·작업 내용 입력
  const pending = dialog('페이지 연결 · AI 작업 요청', `
    <p style="margin:0 0 8px"><b>"${esc(src.title || src.id)}"</b> 페이지를 <b>"${esc(dst.title || dst.id)}"</b> 페이지에 어떻게 연결할까요?</p>
    <label style="display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--line);border-radius:8px;cursor:pointer">
      <input type="radio" name="scDropMode" value="merge" checked>
      <span><b>🔗 이 페이지에 합치기 (병합)</b><br><span class="muted small-note">두 페이지의 영역을 한 화면으로 합칩니다. 빈칸이 없으면 기존 레이아웃 오른쪽 옆에 나란히 배치되어 겹치지 않습니다.</span></span>
    </label>
    <label style="display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--line);border-radius:8px;cursor:pointer">
      <input type="radio" name="scDropMode" value="child">
      <span><b>📂 하위(종속) 페이지로 연결</b><br><span class="muted small-note">페이지 목록에서 하위 트리로 묶고, 레이아웃 설정창에서 기존 페이지 옆에 나란히 띄워 함께 편집합니다.</span></span>
    </label>
    <label style="display:grid;gap:4px;margin-top:8px">
      <span><b>🤖 AI에게 전달할 합치는 이유 · 작업 내용</b> <span class="muted small-note">(선택 — 적으면 배치 적용 후 바로 AI와 이어서 작업합니다)</span></span>
      <textarea id="scDropPrompt" rows="3" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:13px" placeholder="예: AI 도우미를 수행평가 화면 오른쪽에 붙이고, 접기/펼치기 버튼으로 열고 닫을 수 있게 연결해 줘"></textarea>
    </label>`, '적용하고 계속');
  const ok = await pending;
  if (!ok) return;
  const choice = document.querySelector('input[name="scDropMode"]:checked')?.value || 'merge';
  const aiReason = ($('#scDropPrompt')?.value || '').trim();
  const srcTitle = src.title || src.id;
  const dstTitle = dst.title || dst.id;
  const movedNames = (src.regions || []).map((r) => `${r.title || r.id}(${r.id})`).join(', ');

  if (choice === 'merge') {
    await api('POST', '/api/snapshots', { label: `페이지 병합 전 (${srcTitle} → ${dstTitle})`, auto: true }).catch(() => {});
    mergeScreensSideBySide(dst, src);
    for (const s of screens) if (s.parentScreen === src.id) s.parentScreen = dst.id;
    state.layout.screens = screens.filter((s) => s.id !== src.id);
    state.activeScreenId = dst.id;
    state.layout.activeScreen = dst.id;
    state.layout.regions = state.layout.screens[0].regions;
    state.companionScreenId = '';
    state.path = [];
    state.selected = null;
    saveLayout(true);
    renderAll();
    fitCanvas();
    reloadPreview();
    toast(`"${srcTitle}" 영역을 "${dstTitle}" 오른쪽 옆에 합쳤습니다.`);
  } else {
    if (dst.parentScreen === src.id) delete dst.parentScreen;
    src.parentScreen = dst.id;
    state.activeScreenId = dst.id;
    state.layout.activeScreen = dst.id;
    state.companionScreenId = src.id;
    state.path = [];
    state.selected = null;
    saveLayout(true);
    renderAll();
    fitCanvas();
    toast(`"${srcTitle}"을(를) "${dstTitle}"의 하위 페이지로 연결했습니다.`);
  }

  if (aiReason) {
    setView('preview');
    const fullAiMsg = `"${srcTitle}" 페이지(${movedNames || src.id})를 "${dstTitle}" 페이지에 ${choice === 'merge' ? '오른쪽 옆으로 병합' : '하위 페이지로 연결'}했습니다.\n이유 및 작업 요청: ${aiReason}`;
    runPreviewPrompt({ overrideText: fullAiMsg, overrideMode: 'auto' });
  } else {
    setView('design');
    fitCanvas();
  }
});

$('#btnAddScreen')?.addEventListener('click', async () => {
  const title = await promptBox('새 화면 이름 (예: 교사 화면, 결과 화면)', '새 화면');
  if (!title?.trim()) return;
  const screens = ensureScreensArray();
  const base = title.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `screen-${screens.length + 1}`;
  let id = base;
  for (let k = 2; screens.some((s) => s.id === id); k++) id = `${base}-${k}`;
  screens.push({
    id,
    title: title.trim(),
    grid: { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
    regions: [],
  });
  state.activeScreenId = id;
  state.layout.activeScreen = id;
  state.path = [];
  state.selected = null;
  saveLayout(true);
  renderAll();
  fitCanvas();
  toast(`"${title.trim()}" 화면을 추가했습니다 (코드에서 app.navigate('${id}') 로 전환 가능)`);
});

function renderList() {
  renderScreenBar();
  const sc = currentScreen();
  const all = flatten(sc);
  $('#regionCount').textContent = `(${all.length})`;
  $('#regionList').innerHTML = all
    .map(({ region: r, depth }) => {
      const busy = state.busy.has(r.id);
      return `<li data-id="${r.id}" class="${state.selected === r.id ? 'on' : state.multi.has(r.id) ? 'multi' : ''}${busy ? ' is-busy' : ''}" style="padding-left:${8 + depth * 14}px">
      <span class="dot" style="background:${r.color}"></span>
      <span class="name" title="${esc(r.id)}">${isContainer(r) ? '▦ ' : ''}${esc(r.title || r.id)}</span>
      ${busy ? '<span class="busy-pill">⚡ 작업 중</span>' : hasCode(r.id) ? '<span class="badge">✓</span>' : ''}
    </li>`;
    })
    .join('') || '<li class="muted">아직 영역이 없습니다</li>';
}
$('#regionList').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  // 그 영역이 들어 있는 레벨로 캔버스를 옮긴다
  const path = ancestors(state.layout, id);
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
    if (path.join('/') !== state.path.join('/')) return toast('같은 레이아웃 안의 영역끼리만 함께 고를 수 있습니다', true);
    return toggleMulti(id);
  }
  state.multi.clear();
  if (path.join('/') !== state.path.join('/')) {
    state.path = path;
    fitCanvas();
  }
  select(id);
});
$('#regionList').addEventListener('dblclick', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (li) enter(li.dataset.id);
});

// 여러 개 선택: 지금 선택된 영역도 함께 묶는다
function toggleMulti(id) {
  if (state.selected && !state.multi.size) state.multi.add(state.selected);
  if (state.multi.has(id)) state.multi.delete(id);
  else state.multi.add(id);
  state.selected = state.multi.size === 1 ? [...state.multi][0] : null;
  if (state.multi.size <= 1) state.multi.clear();
  renderAll();
}

// ───────────── 인스펙터 ─────────────
async function refreshSessions() {
  try {
    const { sessions } = await api('GET', '/api/sessions');
    state.sessionsMap = sessions || {};
  } catch {}
}

async function select(id, tab, sessionKey = '') {
  flushAllPromptSaves(false);
  state.selected = id;
  state.sessionMode = id ? 'region' : 'integrated';
  state.activeSessionKey = id ? (sessionKey || `region:${id}`) : '';
  if (tab) state.tab = tab;
  if (id) await Promise.all([loadRegion(id).catch((e) => toast(e.message, true)), refreshSessions()]);
  renderAll();
}

function sessionBarHtml() {
  const leafRegions = allRegions().filter((r) => !isContainer(r));
  const regionSessions = Object.values(state.sessionsMap || {}).filter((s) => s.key?.startsWith('region:'));
  return renderSessionBar({
    mode: state.sessionMode,
    selectedRegion: state.selected,
    activeSessionKey: state.activeSessionKey,
    regionSessions,
    regions: leafRegions,
    busySet: state.busy,
    verifyRunning: state.verify.running,
    verifyReport: state.verify.report,
    esc,
  });
}

async function switchSessionMode(mode) {
  flushAllPromptSaves(false);
  state.sessionMode = mode;
  state.multi.clear();
  if (mode === 'integrated') {
    state.selected = null;
  } else if (mode === 'region') {
    if (!state.selected || !region(state.selected)) {
      const first = allRegions().find((r) => !isContainer(r)) || allRegions()[0];
      if (first) {
        state.selected = first.id;
        await loadRegion(first.id).catch(() => {});
      }
    }
  } else if (mode === 'verify') {
    state.selected = null;
    api('GET', '/api/sessions/verify').then((s) => {
      state.verify.history = s.entries || [];
      if (state.sessionMode === 'verify') renderInspector();
    }).catch(() => {});
    if (!state.verify.report && !state.verify.running) runVerifySession();
  }
  renderAll();
}

async function runVerifySession() {
  if (state.verify.running) return state.verify.report;
  state.verify.running = true;
  renderInspector();
  try {
    state.verify.report = await api('POST', '/api/verify', { runBrowser: true });
    const s = await api('GET', '/api/sessions/verify').catch(() => ({ entries: [] }));
    state.verify.history = s.entries || [];
  } catch (e) {
    toast(e.message, true);
  }
  state.verify.running = false;
  renderInspector();
  return state.verify.report;
}

async function runAutoHealLoop() {
  if (state.verify.healing || !state.verify.report) return;
  const leafIds = allRegions().filter((r) => !isContainer(r)).map((r) => r.id);
  const failing = extractFailingRegions(state.verify.report, leafIds, state.files);
  if (!failing.size) {
    // 특정 영역에 매핑되지 않는 문제는 통합 세션 요청으로 넘긴다
    if (!proj.loaded) await loadProject();
    state.sessionMode = 'integrated';
    state.selected = null;
    proj.tab = 'request';
    proj.request = buildVerifyFixPrompt(state.verify.report);
    saveProjectDraft();
    renderAll();
    return toast('발견된 문제를 통합 세션 요청에 채웠습니다. "🧭 계획 세우기"를 눌러 수정하세요');
  }
  state.verify.healing = true;
  state.verify.healLog = `🩺 실패 영역 ${failing.size}개(${[...failing.keys()].join(', ')})에 대해 자동 수정 루프를 시작합니다…\n`;
  renderInspector();
  try {
    await api('POST', '/api/snapshots', { label: `검증 세션 자동 수정 전 (${[...failing.keys()].join(', ')})`, auto: true });
    state.verify.healLog += '🕘 수정 전 스냅샷 저장 완료\n⚡ 실패한 영역 세션들을 병렬로 호출합니다…\n';
    renderInspector();
    const tasks = [...failing.entries()].map(async ([rid, issues]) => {
      const fixReq = `검증 세션에서 이 영역(${rid})에 다음 문제가 발견되었습니다. 기존 기능을 유지하면서 아래 문제를 정확히 수정하세요:\n${issues.map((x) => `- ${x}`).join('\n')}`;
      const res = await generateRegion(rid, fixReq, '검증 세션 자동 복구 루프', { review: false });
      state.verify.healLog += res.ok
        ? `<span class="ok">✓ [${esc(rid)}] 수정 완료</span>\n`
        : `<span class="err">✗ [${esc(rid)}] 수정 실패: ${esc(res.error)}</span>\n`;
      if (state.sessionMode === 'verify') renderInspector();
      return res;
    });
    await Promise.all(tasks);
    state.verify.healLog += '\n🔍 수정 후 재검증을 실행합니다…\n';
    renderInspector();
    const after = await runVerifySession();
    const vc = after ? countVerifyIssues(after) : null;
    state.verify.healLog += vc && vc.totalErrors === 0
      ? '<span class="ok">✅ 재검증 완료: 모든 핵심 검증을 통과했습니다!</span>\n'
      : `<span class="err">⚠ 재검증 후 남은 문제: ${vc?.totalErrors ?? '?'}건</span>\n`;
  } catch (e) {
    state.verify.healLog += `<span class="err">✗ 자동 수정 오류: ${esc(e.message)}</span>\n`;
  }
  state.verify.healing = false;
  reloadPreview();
  renderAll();
}

function draft(id, key) {
  return state.drafts[id]?.[key] ?? state.files[id]?.[key] ?? '';
}
function isDirty(id, key) {
  return state.drafts[id]?.[key] !== undefined && state.drafts[id][key] !== state.files[id]?.[key];
}

function renderInspector() {
  const box = $('#inspector');
  if (state.multi.size >= 2) {
    const picked = sorted([...state.multi].map(region).filter(Boolean));
    const ok = unionRect(picked) && !picked.some(isContainer);
    box.innerHTML = `${sessionBarHtml()}<div class="insp-empty">
      <p><b>${picked.length}개 영역 선택됨</b></p>
      <ul class="pick-list">${picked.map((p) => `<li><span class="dot" style="background:${p.color}"></span>${esc(p.title || p.id)} <span class="muted mono">#${esc(p.id)}</span></li>`).join('')}</ul>
      <div class="actions"><button class="btn primary" id="btnMerge" ${ok ? '' : 'disabled'}>⧉ 하나로 합치기</button>
        <button class="btn ghost" id="btnClearMulti">선택 해제</button></div>
      <p class="muted">${ok
        ? `합치면 <b>${esc(picked[0].title || picked[0].id)}</b> 의 ID 가 남고, 나머지 영역의 HTML·CSS·JS 는 뒤에 이어 붙습니다. 빠지는 폴더는 .trash 로 옮겨집니다.`
        : picked.some(isContainer)
          ? '안쪽 레이아웃이 있는 영역은 먼저 "안쪽 레이아웃 풀기"를 하세요.'
          : '합친 모양이 빈틈없는 직사각형이 되어야 합칠 수 있습니다.'}</p>
    </div>`;
    return;
  }
  if (state.sessionMode === 'verify') {
    box.innerHTML = `${sessionBarHtml()}${renderVerifySessionPanel({
      report: state.verify.report,
      running: state.verify.running,
      healing: state.verify.healing,
      healLog: state.verify.healLog,
      history: state.verify.history,
      esc,
      chip,
    })}`;
    const log = $('#verifyHealLog');
    if (log) log.scrollTop = log.scrollHeight;
    return;
  }
  const r = state.selected && region(state.selected);
  if (!r || state.sessionMode === 'integrated') return renderProjectPanel(box);
  const busy = state.busy.has(r.id);
  const tabs = FILE_TABS.map((t) => `<button data-tab="${t.key}" class="${state.tab === t.key ? 'on' : ''}">${t.label}${isDirty(r.id, t.key) ? '<span class="dirty"> •</span>' : ''}</button>`).join('');

  const container = isContainer(r);
  let body = '';
  if (state.tab === 'features') {
    body = container ? containerFeaturesHtml(r) : featuresHtml(r);
  } else if (container && ['prompt', 'html'].includes(state.tab)) {
    body = `<div class="insp-empty"><p><b>▦ 안쪽 레이아웃이 있는 영역입니다.</b></p>
      <p>화면에는 안쪽 영역들이 그려지고, 이 영역 자신의 HTML 은 쓰이지 않습니다.
      안쪽 각 영역을 선택해서 프롬프트로 구현하세요. (이 영역의 CSS·JS 는 그대로 적용됩니다)</p>
      <div class="actions"><button class="btn primary" id="btnEnter">▸ 안쪽 레이아웃 열기</button></div></div>`;
  } else if (state.tab === 'prompt') {
    const imgs = state.images[r.id] || [];
    body = `${state.inspected?.region === r.id ? renderInspectCard(state.inspected, busy, esc) : ''}
      <textarea class="prompt" id="promptInput" placeholder="이 영역에 구현할 내용을 적으세요. (스크린샷 붙여넣기 Ctrl+V · 드래그 첨부 가능)&#10;예) 로고와 메뉴(홈, 소개, 문의)가 있는 상단 내비게이션. 메뉴를 누르면 'nav:select' 이벤트를 보낸다.">${esc(draft(r.id, 'prompt'))}</textarea>
      ${renderImageStrip(imgs, r.id, esc)}
      <div class="actions">
        <button class="btn primary" id="btnGenerate" ${busy ? 'disabled' : ''}>${busy ? '구현 중…' : '⚡ 바이브 코딩'}</button>
        <button class="btn ghost" id="btnRegionImg" title="디자인 참고 스크린샷·와이어프레임 첨부 (최대 4장)">🖼 이미지${imgs.length ? ` (${imgs.length})` : ''}</button>
        <input type="file" id="regionImgInput" accept="image/*" multiple hidden>
        <button class="btn ghost" id="btnCopyPrompt" title="Claude Code 등 다른 도구에 붙여넣을 전체 프롬프트">📋 프롬프트 복사</button>
        <span class="spacer"></span>
        <label class="muted" title="켜면 AI 결과를 바로 저장하지 않고 바뀐 부분을 보여 준 뒤 적용합니다"><input type="checkbox" id="reviewMode" ${state.reviewMode ? 'checked' : ''}> 검토 후 적용</label>
        <span class="muted small-note" id="regionPromptStatus"></span>
        <span class="muted">Ctrl+Enter 실행</span>
      </div>
      <pre class="log" id="genLog">${state.logs[r.id] || '<span>기존 코드가 있으면 그 위에 이어서 수정합니다.</span>'}</pre>
      ${state.pending[r.id] ? reviewHtml(r.id) : ''}`;
  } else if (state.tab === 'history') {
    const list = state.history[r.id] || [];
    body = list.length
      ? `<ul class="history-list">${list.map((v) => `<li><span class="mono">${esc(fmtVersion(v))}</span><button class="btn small" data-restore="${esc(v)}">이 버전으로 되돌리기</button></li>`).join('')}</ul>`
      : '<p class="muted">덮어쓰기 전 버전이 여기에 자동으로 백업됩니다.</p>';
  } else {
    body = `<textarea class="code" id="codeInput" spellcheck="false">${esc(draft(r.id, state.tab))}</textarea>
      <div class="lint-status" id="lintStatus"></div>
      <div class="actions">
        <button class="btn primary" id="btnSaveFile">저장 (Ctrl+S)</button>
        <button class="btn ghost" id="btnRevert" ${isDirty(r.id, state.tab) ? '' : 'disabled'}>변경 취소</button>
        <span class="spacer"></span>
        <span class="muted mono">regions/${esc(r.id)}/${{ html: 'view.html', css: 'style.css', js: 'script.js' }[state.tab]}</span>
      </div>`;
  }

  box.innerHTML = `${sessionBarHtml()}
    <div class="insp-head">
      <label class="field"><span>이름</span><input type="text" id="fTitle" value="${esc(r.title)}"></label>
      <label class="field"><span>ID</span>
        <div class="row"><input type="text" class="mono" id="fId" value="${esc(r.id)}" title="영문 소문자/숫자/하이픈. 폴더 이름으로 쓰입니다">
        <input type="color" id="fColor" value="${r.color}" title="색상"></div></label>
      <div class="field"><span>위치</span>
        <div class="row">
          ${bpActive() ? `<span class="badge-soft">${DEVICES[state.device].label}</span>` : ''}
          열 <input type="number" min="1" data-pos="x" value="${geoOf(r.id).x + 1}">
          행 <input type="number" min="1" data-pos="y" value="${geoOf(r.id).y + 1}">
          너비 <input type="number" min="1" data-pos="w" value="${geoOf(r.id).w}">
          높이 <input type="number" min="1" data-pos="h" value="${geoOf(r.id).h}">
        </div></div>
      <div class="field"><span>레이아웃</span>
        <div class="row">
          ${container
            ? `<button class="btn small" id="btnEnter">▸ 안쪽 열기</button>
               <button class="btn small" id="btnUnwrap" title="안쪽 영역들의 파일을 이 영역 하나로 다시 합칩니다">⧉ 안쪽 레이아웃 풀기</button>`
            : `<select id="splitDir"><option value="h" ${state.splitDir === 'h' ? 'selected' : ''}>좌우 ⫴</option><option value="v" ${state.splitDir === 'v' ? 'selected' : ''}>상하 ☰</option></select>
               <input type="number" id="splitCount" min="2" max="12" value="${state.splitCount}" title="몇 개로">개
               <button class="btn small" id="btnSplit" title="이 영역 자리를 같은 레벨의 영역 여러 개로 나눕니다 (기존 내용은 첫 번째에 남음)">나누기</button>
               <button class="btn small" id="btnSplitInner" title="이 영역 안에 레이아웃을 만들고 그 안에서 나눕니다 (기존 내용은 안쪽 첫 번째로 이동)">안쪽으로 나누기</button>`}
        </div></div>
      <div class="actions"><span class="muted">Shift+클릭으로 여러 영역을 골라 합칠 수 있습니다</span><span class="spacer"></span><button class="btn small danger" id="btnDelete">영역 삭제</button></div>
    </div>
    <nav class="tabs">${tabs}</nav>
    <div class="tab-body">${body}</div>`;

  const log = $('#genLog');
  if (log) log.scrollTop = log.scrollHeight;
  const code = $('#codeInput');
  if (code) {
    const key = state.tab;
    const cm = mountCode(code, key, (value) => onDraftInput(r.id, key, value));
    lintInto($('#lintStatus'), key, draft(r.id, key));
    cm?.focus();
  }
}

// ───────────── 코드 편집기 (CodeMirror) ─────────────
const CM_MODES = { html: 'htmlmixed', css: 'css', js: 'javascript' };

// textarea 를 코드 편집기로 바꾼다. onChange(값) 은 글자가 바뀔 때마다
function mountCode(textarea, lang, onChange) {
  if (!window.CodeMirror) return null; // 편집기 파일을 못 불러오면 일반 입력칸 그대로
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cm = window.CodeMirror.fromTextArea(textarea, {
    mode: CM_MODES[lang],
    theme: dark ? 'material-darker' : 'default',
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    autoCloseBrackets: true,
    autoCloseTags: lang === 'html',
    styleActiveLine: true,
    extraKeys: {
      'Ctrl-Space': 'autocomplete',
      'Ctrl-/': 'toggleComment',
      'Cmd-/': 'toggleComment',
      'Ctrl-F': 'findPersistent',
      'Ctrl-H': 'replace',
      'Alt-G': 'jumpToLine',
      Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')),
      'Shift-Tab': (c) => c.indentSelection('subtract'),
    },
  });
  cm.on('change', () => {
    textarea.value = cm.getValue();
    onChange(cm.getValue());
  });
  // HTML 태그·CSS 속성은 입력하는 대로 자동완성 후보를 띄운다 (JS 는 Ctrl+Space)
  cm.on('inputRead', (c, change) => {
    if (lang === 'js' || c.state.completionActive) return;
    if (/^[a-zA-Z<-]$/.test(change.text[0])) c.showHint({ completeSingle: false });
  });
  return cm;
}

// 실행하지 않고 문법만 검사 (서버의 저장 전 검사와 같은 기준)
function syntaxProblem(lang, src) {
  if (!src.trim()) return '';
  if (lang === 'js') {
    try {
      new Function('root', 'app', src); // 함수로 만들기만 하고 호출하지 않는다
      return '';
    } catch (e) {
      return `script.js 문법 오류: ${e.message}`;
    }
  }
  if (lang === 'css') {
    let depth = 0;
    for (const c of src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')) {
      if (c === '{') depth++;
      else if (c === '}' && --depth < 0) return 'style.css: 닫는 } 가 더 많습니다';
    }
    return depth ? `style.css: 여는 { 가 ${depth}개 닫히지 않았습니다` : '';
  }
  return '';
}

let lintTimer;
function lintInto(el, lang, src) {
  if (!el) return;
  clearTimeout(lintTimer);
  lintTimer = setTimeout(() => {
    const p = syntaxProblem(lang, src);
    el.className = `lint-status ${p ? 'bad' : 'good'}`;
    el.textContent = p ? `⚠ ${p}` : lang === 'html' ? '' : '✓ 문법 이상 없음';
  }, 300);
}

// 프롬프트 자동 저장 상태 표시 · 오류 알림 (연속 알림 방지)
let lastSaveErrAt = 0;
function showPromptSaveError(err) {
  const now = Date.now();
  if (now - lastSaveErrAt < 4000) return;
  lastSaveErrAt = now;
  const msg = err?.message || String(err);
  toast(`프롬프트 저장 실패: ${msg} (로컬 서버를 최신 버전으로 재시작했는지 확인하세요)`, true);
}
function setSaveHint(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

const regionPromptTimers = {};
function flushRegionPromptSave(id, keepalive = false) {
  if (!id || !regionPromptTimers[id]) return;
  clearTimeout(regionPromptTimers[id]);
  delete regionPromptTimers[id];
  const value = state.drafts[id]?.prompt;
  if (typeof value !== 'string' || value === state.files[id]?.prompt) return;
  if (keepalive) {
    try { fetch(`/api/regions/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: value }), keepalive: true }); } catch {}
    return;
  }
  setSaveHint('#regionPromptStatus', '저장 중…');
  api('PUT', `/api/regions/${id}`, { prompt: value })
    .then(() => {
      if (state.files[id]) state.files[id].prompt = value;
      if (state.drafts[id]?.prompt === value) delete state.drafts[id].prompt;
      const tabBtn = inspector.querySelector('.tabs [data-tab="prompt"]');
      if (tabBtn && state.selected === id) tabBtn.innerHTML = FILE_TABS.find((x) => x.key === 'prompt').label + (isDirty(id, 'prompt') ? '<span class="dirty"> •</span>' : '');
      setSaveHint('#regionPromptStatus', '✓ 자동 저장됨');
    })
    .catch((e) => {
      setSaveHint('#regionPromptStatus', '⚠ 저장 실패');
      showPromptSaveError(e);
    });
}
function scheduleRegionPromptSave(id) {
  setSaveHint('#regionPromptStatus', '저장 중…');
  clearTimeout(regionPromptTimers[id]);
  regionPromptTimers[id] = setTimeout(() => flushRegionPromptSave(id), 450);
}

// 프롬프트·코드 입력이 바뀌었을 때: 초안 저장, 탭의 • 표시, 변경 취소 버튼, 문법 검사
function onDraftInput(id, key, value) {
  (state.drafts[id] ||= {})[key] = value;
  const tabBtn = inspector.querySelector(`.tabs [data-tab="${key}"]`);
  if (tabBtn) tabBtn.innerHTML = FILE_TABS.find((x) => x.key === key).label + (isDirty(id, key) ? '<span class="dirty"> •</span>' : '');
  const revert = $('#btnRevert');
  if (revert) revert.disabled = !isDirty(id, key);
  if (key === 'prompt') scheduleRegionPromptSave(id);
  else lintInto($('#lintStatus'), key, value);
}

const inspector = $('#inspector');

// ───────────── 프로젝트 전체 프롬프트 ─────────────
// 영역을 선택하지 않았을 때 인스펙터에 보이는 패널: 요청 → AI 계획(영역별 지시) → 단계별 실행
const proj = {
  loaded: false,
  tab: 'workflow',
  request: '',
  appPrompt: '',
  plan: null,
  log: '',
  planning: false,
  running: false,
  status: {}, // 단계 번호 → 'running' | 'done' | 'error'
  runLog: '',
  images: [], // 프로젝트 계획 참고 이미지
  wf: { step: 1, workload: '', proposed: null, distributed: [], checklist: [], deployReady: false },
  wfBusy: false,
  wfBuildLog: '',
};
const PROJ_TABS = [
  { key: 'workflow', label: '🚀 7단계 제작' },
  { key: 'request', label: '자유 요청' },
  { key: 'app', label: '앱 설명' },
  { key: 'memo', label: '결정 메모' },
  { key: 'log', label: '기록' },
];

async function loadProject() {
  const [p, { list }, wf, headRes] = await Promise.all([
    api('GET', '/api/project'),
    api('GET', '/api/layout/backups'),
    api('GET', '/api/workflow').catch(() => proj.wf),
    api('GET', '/api/shared/head').catch(() => ({ text: '' })),
  ]);
  Object.assign(proj, { loaded: true, request: p.request, appPrompt: p.appPrompt, decisions: p.decisions || '', plan: p.plan, log: p.log, status: {}, runLog: '', layoutBackups: list.length, wf: wf || proj.wf, styleKit: detectStyleKit(headRes?.text || '') });
}

// 계획의 새 배치를 축소 그림으로
function layoutPreview(lp, newRegions = []) {
  const boxes = lp.regions
    .map((p) => {
      const r = region(p.id);
      const n = newRegions.find((x) => x.id === p.id);
      return `<div class="mini${n ? ' new' : ''}" style="--c:${r?.color || '#888'};${placeStyle(p, { cols: lp.cols, rows: lp.rows }, 1)}"><span>${esc(r?.title || n?.title || p.id)}${n ? ' ✚' : ''}</span></div>`;
    })
    .join('');
  return `<div class="layout-preview" style="aspect-ratio:${lp.fill ? '16 / 10' : `${lp.cols} / ${Math.max(lp.rows, 4)}`}"><div class="minis">${boxes}</div></div>`;
}

// 계획의 화면 재구성 항목 (새 영역 · 기능 옮기기 · 빈 영역 지우기)
function reorgItems(plan) {
  return [
    ...(plan.newRegions || []).map((n, i) => ({ key: `new:${i}`, on: n.enabled, valid: true, html: `✚ 새 영역 <b>${esc(n.title)}</b> <span class="mono muted">#${esc(n.id)}</span>${n.purpose ? ` — <span class="muted">${esc(n.purpose)}</span>` : ''}` })),
    ...(plan.featureMoves || []).map((m, i) => ({
      key: `move:${i}`, on: m.enabled && m.valid, valid: m.valid, warn: m.warn,
      html: `↗ 기능 <b>${esc(m.name)}</b>: ${esc(region(m.from)?.title || m.from || '?')} → ${esc(region(m.to)?.title || plan.newRegions?.find((n) => n.id === m.to)?.title || m.to)}`,
    })),
    ...(plan.removeRegions || []).map((r, i) => ({ key: `remove:${i}`, on: r.enabled && r.valid, valid: r.valid, warn: r.warn, html: `🗑 빈 영역 지우기 <b>${esc(region(r.id)?.title || r.id)}</b>` })),
  ];
}

function reorgHtml(plan, icon) {
  const items = reorgItems(plan);
  if (!items.length) return '';
  return `<div class="step layout-step reorg ${proj.status.layout || ''}">
      <div class="step-head"><b>🧩 화면 재구성</b><span class="muted">AI 없이 코드를 그대로 옮깁니다</span><span class="spacer"></span>${icon[proj.status.layout] || ''}</div>
      <ul class="reorg-list">${items.map((x) => `<li class="${x.valid ? '' : 'invalid'}"><label><input type="checkbox" data-reorg="${x.key}" ${x.on ? 'checked' : ''} ${x.valid && !proj.running ? '' : 'disabled'}> <span>${x.html}</span></label>${x.warn ? `<span class="small-note err">${esc(x.warn)}</span>` : ''}</li>`).join('')}</ul>
      <span class="muted small-note">새 영역은 앱 맨 위 레벨에 만들어지고 아래 배치로 자리를 잡습니다. 남는 기능이나 스크립트가 있으면 영역을 지우지 않습니다. 실행 전 스냅샷이 자동 저장됩니다.</span>
    </div>`;
}

async function applyLayoutStep(lp) {
  const res = await api('POST', '/api/layout/restructure', { layout: lp });
  state.layout = res.layout;
  state.path = [];
  proj.layoutBackups = (proj.layoutBackups || 0) + 1;
  renderAll();
  fitCanvas();
}

async function undoLayout() {
  if (!(await confirmBox('레이아웃(영역 배치)을 바꾸기 전 상태로 되돌릴까요?\n영역 코드는 그대로이고 배치만 되돌아갑니다.', '되돌리기'))) return;
  try {
    const res = await api('POST', '/api/layout/undo');
    state.layout = res.layout;
    state.path = [];
    proj.layoutBackups = Math.max(0, (proj.layoutBackups || 1) - 1);
    toast('레이아웃을 되돌렸습니다');
    reloadPreview();
    renderAll();
    fitCanvas();
  } catch (e) {
    toast(e.message, true);
  }
}

let projSaveTimer;
let wfSaveTimer;
let metaSaveTimer;
let wfPendingPatch = null;
let projPendingSave = false;
let metaPendingSave = false;

function flushProjectDraft(keepalive = false) {
  if (!projPendingSave) return;
  clearTimeout(projSaveTimer);
  projPendingSave = false;
  const payload = { request: proj.request, plan: proj.plan };
  if (keepalive) {
    try { fetch('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }); } catch {}
    return;
  }
  setSaveHint('#projSaveStatus', '저장 중…');
  api('PUT', '/api/project', payload)
    .then(() => setSaveHint('#projSaveStatus', '✓ 자동 저장됨'))
    .catch((e) => { setSaveHint('#projSaveStatus', '⚠ 저장 실패'); showPromptSaveError(e); });
}
function saveProjectDraft() {
  projPendingSave = true;
  setSaveHint('#projSaveStatus', '저장 중…');
  clearTimeout(projSaveTimer);
  projSaveTimer = setTimeout(() => flushProjectDraft(false), 450);
}

function flushWorkflowDraft(keepalive = false) {
  if (!wfPendingPatch) return;
  clearTimeout(wfSaveTimer);
  const patch = wfPendingPatch;
  wfPendingPatch = null;
  if (keepalive) {
    try { fetch('/api/workflow', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), keepalive: true }); } catch {}
    return;
  }
  setSaveHint('#wfSaveStatus', '저장 중…');
  api('PUT', '/api/workflow', patch)
    .then(() => setSaveHint('#wfSaveStatus', '✓ 자동 저장됨'))
    .catch((e) => { setSaveHint('#wfSaveStatus', '⚠ 저장 실패'); showPromptSaveError(e); });
}
function saveWorkflowDraft(patch) {
  wfPendingPatch = { ...(wfPendingPatch || {}), ...patch };
  setSaveHint('#wfSaveStatus', '저장 중…');
  clearTimeout(wfSaveTimer);
  wfSaveTimer = setTimeout(() => flushWorkflowDraft(false), 450);
}

function flushMetaDraft(keepalive = false) {
  if (!metaPendingSave) return;
  clearTimeout(metaSaveTimer);
  metaPendingSave = false;
  const payload = { appPrompt: proj.appPrompt, decisions: proj.decisions };
  if (keepalive) {
    try { fetch('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }); } catch {}
    return;
  }
  api('PUT', '/api/project', payload).catch(showPromptSaveError);
}
function saveMetaDraft() {
  metaPendingSave = true;
  clearTimeout(metaSaveTimer);
  metaSaveTimer = setTimeout(() => flushMetaDraft(false), 600);
}

function flushAllPromptSaves(keepalive = false) {
  flushProjectDraft(keepalive);
  flushWorkflowDraft(keepalive);
  flushMetaDraft(keepalive);
  for (const id of Object.keys(regionPromptTimers)) flushRegionPromptSave(id, keepalive);
}
window.addEventListener('beforeunload', () => flushAllPromptSaves(true));

function stepTarget(s) {
  if (s.target === 'shared:css') return '🎨 공통 CSS';
  const r = region(s.target);
  const n = proj.plan?.newRegions?.find((x) => x.id === s.target);
  return r ? `${r.title || r.id}` : n ? `${n.title} (새 영역)` : `${s.target} (없는 영역)`;
}

function renderProjectPanel(box) {
  if (!proj.loaded) {
    box.innerHTML = '<div class="insp-empty">불러오는 중…</div>';
    loadProject().then(() => !state.selected && renderInspector()).catch((e) => toast(e.message, true));
    return;
  }
  const leafCount = allRegions().filter((r) => !isContainer(r)).length;
  const tabs = PROJ_TABS.map((t) => `<button data-proj-tab="${t.key}" class="${proj.tab === t.key ? 'on' : ''}">${t.label}</button>`).join('');
  let body = '';
  if (proj.tab === 'workflow') {
    body = renderWorkflowPanel({
      wf: proj.wf,
      regions: allRegions().filter((r) => !isContainer(r)),
      screens: getScreens(state.layout),
      styleKit: proj.styleKit || 'builtin',
      verifyDataMode: proj.verifyDataMode || 'mock',
      verifyUpload: proj.verifyUpload || null,
      busy: proj.wfBusy,
      progress: proj.wfProgress,
      buildLog: proj.wfBuildLog,
      verifyBriefing: proj.wfVerifyBriefing,
      layoutPreviewFn: layoutPreview,
      esc,
    });
  } else if (proj.tab === 'request') {
    const plan = proj.plan;
    const lp = plan?.layout;
    const enabledCount = plan ? plan.steps.filter((s) => s.enabled && s.valid).length + (lp?.enabled && lp.valid ? 1 : 0) + reorgItems(plan).filter((x) => x.on).length : 0;
    const icon = { running: '⏳', done: '✅', error: '❌' };
    body = `<textarea class="prompt" id="projRequest" placeholder="앱 전체에 대한 요청을 적으세요. (와이어프레임·스크린샷 붙여넣기 Ctrl+V 가능)&#10;예) 다크 모드를 추가하고, 상단 메뉴에서 켜고 끌 수 있게 해 줘.&#10;예) 채점 결과를 학생별로 볼 수 있는 화면을 만들어 줘.">${esc(proj.request)}</textarea>
      ${renderImageStrip(proj.images, '__proj__', esc)}
      <div class="actions">
        <button class="btn primary" id="btnPlan" ${proj.planning || proj.running ? 'disabled' : ''}>${proj.planning ? '🧭 계획 세우는 중…' : '🧭 계획 세우기'}</button>
        <button class="btn ghost" id="btnProjImg" title="앱 전체 와이어프레임·참고 화면 첨부 (최대 4장)">🖼 이미지${proj.images.length ? ` (${proj.images.length})` : ''}</button>
        <input type="file" id="projImgInput" accept="image/*" multiple hidden>
        <span class="muted">AI 가 영역 ${leafCount}개의 기능을 보고 영역별 작업으로 나눕니다</span>
        <span class="spacer"></span>
        <span class="muted small-note" id="projSaveStatus"></span>
      </div>
      ${plan ? `<div class="plan">
        <p class="plan-summary">${esc(plan.summary || '')}</p>
        ${reorgHtml(plan, icon)}
        ${lp ? `<div class="step layout-step ${proj.status.layout || ''}${lp.valid ? '' : ' invalid'}">
            <label class="step-head"><input type="checkbox" data-layout-on ${lp.enabled && lp.valid ? 'checked' : ''} ${lp.valid && !proj.running ? '' : 'disabled'}>
              <b>📐 레이아웃 재배치</b> <span class="mono muted">${lp.cols}×${lp.rows}${lp.fill ? ' · 화면 채우기' : ''}</span><span class="spacer"></span>${icon[proj.status.layout] || ''}</label>
            ${lp.valid ? layoutPreview(lp, plan.newRegions?.filter((n) => n.enabled) || []) : `<span class="err small-note">AI 가 준 배치를 쓸 수 없습니다: ${esc(lp.error)}</span>`}
            ${lp.autoAdded?.length ? `<span class="small-note">⚠ AI 가 빠뜨린 영역을 맨 아래에 붙였습니다: ${lp.autoAdded.map((id) => esc(region(id)?.title || id)).join(', ')} — 적용 후 캔버스에서 옮기세요</span>` : ''}
            <span class="muted small-note">영역 코드는 그대로 두고 IDE 레이아웃(영역 위치·크기)만 바꿉니다. 캔버스에도 바로 반영되고, 아래 "레이아웃 되돌리기"로 되돌릴 수 있습니다.</span>
          </div>` : ''}
        <ol class="plan-steps">${plan.steps.map((s, i) => `<li class="step ${proj.status[i] || ''}${s.valid ? '' : ' invalid'}">
            <label class="step-head"><input type="checkbox" data-step-on="${i}" ${s.enabled && s.valid ? 'checked' : ''} ${s.valid && !proj.running ? '' : 'disabled'}>
              <b>${esc(stepTarget(s))}</b> <span class="mono muted">${esc(s.target)}</span><span class="spacer"></span>${icon[proj.status[i]] || ''}</label>
            <textarea data-step-prompt="${i}" rows="3" ${proj.running ? 'disabled' : ''}>${esc(s.prompt)}</textarea>
            ${s.valid ? '' : '<span class="err small-note">이 대상은 지금 레이아웃에 없거나 안쪽 레이아웃이 있는 영역이라 실행할 수 없습니다</span>'}
            ${s.warn ? `<span class="small-note">⚠ ${esc(s.warn)}</span>` : ''}
          </li>`).join('')}</ol>
        <div class="actions">
          <button class="btn primary" id="btnRunPlan" ${enabledCount && !proj.running && !proj.planning ? '' : 'disabled'}>${proj.running ? '▶ 실행 중…' : `▶ 선택한 ${enabledCount}단계 실행`}</button>
          <label class="muted" title="켜면 독립된 영역 세션들을 동시에 병렬 실행해 속도를 크게 높입니다"><input type="checkbox" id="chkParallelRun" ${state.parallelMode ? 'checked' : ''} ${proj.running ? 'disabled' : ''}> ⚡ 영역 병렬 실행</label>
          <button class="btn ghost" id="btnClearPlan" ${proj.running ? 'disabled' : ''}>계획 지우기</button>
        </div>
      </div>` : ''}
      ${proj.layoutBackups ? `<div class="actions"><button class="btn ghost small" id="btnUndoLayout" ${proj.running ? 'disabled' : ''}>↩ 레이아웃 되돌리기 (${proj.layoutBackups})</button><span class="muted small-note">계획으로 바꾼 영역 배치를 이전으로</span></div>` : ''}
      ${proj.runLog ? `<pre class="log" id="projLog">${proj.runLog}</pre>` : ''}`;
  } else if (proj.tab === 'app') {
    body = `<p class="muted small-note">앱 전체의 목적·대상·분위기·색감·데이터 흐름. 모든 영역 구현과 프로젝트 계획에 함께 전달됩니다.</p>
      <textarea class="prompt grow" id="projAppPrompt" placeholder="예) 학생 서술형 답안을 붙여넣으면 채점 기준에 따라 점수와 피드백을 보여주는 교사용 도구. 차분한 남색 계열.">${esc(proj.appPrompt)}</textarea>
      <div class="actions"><button class="btn primary" id="btnSaveAppPrompt">저장</button></div>`;
  } else if (proj.tab === 'memo') {
    body = `<p class="muted small-note">앱 전체에서 늘 지킬 규칙을 한 줄에 하나씩 적으세요. 영역 구현·프로젝트 계획·공통 CSS 등 모든 AI 작업에 함께 전달됩니다.
      AI 가 요청에서 새 규칙을 발견하면 구현 기록 아래에 "📌 메모에 추가" 버튼으로 제안합니다.</p>
      <textarea class="prompt grow" id="projDecisions" placeholder="- 점수는 소수점 없이 정수로 표시&#10;- 삭제 버튼은 항상 확인 창을 띄울 것&#10;- 색은 남색 계열, 글꼴은 Pretendard">${esc(proj.decisions)}</textarea>
      <div class="actions"><button class="btn primary" id="btnSaveDecisions">저장</button><span class="muted small-note">짧고 구체적일수록 잘 지켜집니다. 길어지면 매번 보내는 토큰도 늘어납니다.</span></div>`;
  } else {
    body = proj.log.trim() ? `<pre class="log md">${esc(proj.log.trim())}</pre>` : '<p class="muted">아직 프로젝트 요청 기록이 없습니다.</p>';
  }
  box.innerHTML = `${sessionBarHtml()}<div class="insp-head proj-head">
      <div class="features-head"><b>🧭 통합 개발 세션</b><span class="muted">${esc(state.layout.name)}</span><span class="spacer"></span><span class="muted">영역 ${leafCount}개</span></div>
      <p class="muted small-note">전체 구조·레이아웃·이벤트 규약을 설계하고, 하위 영역 세션들에 작업을 병렬 분배합니다.</p>
    </div>
    <nav class="tabs">${tabs}</nav>
    <div class="tab-body">${body}</div>`;
  const log = $('#projLog');
  if (log) log.scrollTop = log.scrollHeight;
}

function projLog(html) {
  proj.runLog += html;
  const el = !state.selected && $('#projLog');
  if (el) {
    el.innerHTML = proj.runLog;
    el.scrollTop = el.scrollHeight;
  } else if (!state.selected) renderInspector();
}

async function makePlan() {
  const request = proj.request.trim();
  if (!request) return toast('프로젝트 요청을 적어 주세요', true);
  proj.planning = true;
  proj.status = {};
  proj.runLog = '';
  renderInspector();
  try {
    clearTimeout(saveTimer);
    await api('PUT', '/api/layout', state.layout);
    proj.plan = await api('POST', '/api/project/plan', { request, images: toPayloadImages(proj.images) });
    proj.log = (await api('GET', '/api/project')).log;
    toast(`${proj.plan.steps.length}단계 계획을 세웠습니다. 확인 후 실행하세요`);
  } catch (e) {
    toast(e.message, true);
  }
  proj.planning = false;
  renderInspector();
}

async function runPlan() {
  const plan = proj.plan;
  const projectRequest = plan.request || proj.request;
  proj.running = true;
  proj.status = {};
  proj.runLog = '';
  renderInspector();
  let ok = 0;
  // 여러 영역을 한꺼번에 바꾸므로 실행 전 프로젝트 전체를 스냅샷으로 남긴다 (🕘 스냅샷에서 통째로 되돌리기)
  try {
    await api('POST', '/api/snapshots', { label: `계획 실행 전: ${projectRequest.slice(0, 60)}`, auto: true });
    projLog('🕘 실행 전 스냅샷 저장 (🕘 스냅샷에서 통째로 되돌릴 수 있습니다)\n');
  } catch (e) {
    projLog(`<span class="err">✗ 스냅샷 저장 실패: ${esc(e.message)} — 실행을 멈춥니다</span>\n`);
    proj.running = false;
    return renderInspector();
  }
  // 화면 재구성(새 영역 → 기능 옮기기 → 빈 영역 지우기 → 배치)을 먼저: 이후 영역 작업이 새 구조·칸 크기를 알고 진행한다
  const reorg = {
    newRegions: (plan.newRegions || []).filter((n) => n.enabled),
    featureMoves: (plan.featureMoves || []).filter((m) => m.enabled && m.valid),
    removeRegions: (plan.removeRegions || []).filter((r) => r.enabled && r.valid).map((r) => r.id),
    layout: plan.layout?.enabled && plan.layout.valid ? plan.layout : null,
  };
  if (reorg.newRegions.length || reorg.featureMoves.length || reorg.removeRegions.length || reorg.layout) {
    proj.status.layout = 'running';
    projLog('⏳ 🧩 화면 재구성 (AI 없이 코드 이동) …\n');
    try {
      clearTimeout(saveTimer);
      await api('PUT', '/api/layout', state.layout);
      const res = await api('POST', '/api/project/reorganize', reorg);
      for (const l of res.log) projLog(l.ok ? `<span class="ok">  ✓ ${esc(l.text)}</span>\n` : `<span class="err">  ✗ ${esc(l.text)}</span>\n`);
      state.layout = res.layout;
      state.path = [];
      state.files = {};
      state.drafts = {};
      state.history = {};
      state.deps = {};
      await Promise.all([...allRegions().map((r) => loadRegion(r.id)), refreshSessions()]);
      proj.layoutBackups = (proj.layoutBackups || 0) + 1;
      proj.status.layout = res.log.some((l) => !l.ok) ? 'error' : 'done';
      ok++;
      renderAll();
      fitCanvas();
    } catch (e) {
      proj.status.layout = 'error';
      projLog(`<span class="err">✗ 화면 재구성: ${esc(e.message)}</span>\n`);
    }
  }
  // 1) 공통 CSS 단계는 먼저 순차 적용
  const activeSteps = plan.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.enabled && s.valid);
  const cssSteps = activeSteps.filter(({ s }) => s.target === 'shared:css');
  const regionSteps = activeSteps.filter(({ s }) => s.target !== 'shared:css');

  for (const { s, i } of cssSteps) {
    proj.status[i] = 'running';
    projLog(`⏳ ${esc(stepTarget(s))} …\n`);
    let res;
    try {
      await api('POST', '/api/shared/css/generate', { request: s.prompt, projectRequest });
      res = { ok: true };
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    proj.status[i] = res.ok ? 'done' : 'error';
    if (res.ok) ok++;
    projLog(res.ok ? `<span class="ok">✓ ${esc(stepTarget(s))} 완료</span>\n` : `<span class="err">✗ ${esc(stepTarget(s))}: ${esc(res.error)}</span>\n`);
  }

  // 2) 영역별 세션 실행 (병렬 실행 모드면 모든 독립 영역 세션을 동시에 실행!)
  const runOneRegionStep = async ({ s, i }) => {
    if (!region(s.target)) {
      projLog(`<span class="err">✗ ${esc(stepTarget(s))}: 영역이 없어 건너뜀</span>\n`);
      return;
    }
    proj.status[i] = 'running';
    projLog(`⏳ [영역 세션] ${esc(stepTarget(s))} …\n`);
    const res = await generateRegion(s.target, s.prompt, projectRequest);
    proj.status[i] = res.ok ? 'done' : 'error';
    if (res.ok) ok++;
    projLog(res.ok ? `<span class="ok">✓ [영역 세션] ${esc(stepTarget(s))} 완료</span>\n` : `<span class="err">✗ [영역 세션] ${esc(stepTarget(s))}: ${esc(res.error)}</span>\n`);
  };

  if (state.parallelMode && regionSteps.length > 1) {
    projLog(`\n⚡ 영역별 세션 ${regionSteps.length}개를 병렬로 동시 실행합니다…\n`);
    await Promise.all(regionSteps.map(runOneRegionStep));
  } else {
    for (const item of regionSteps) await runOneRegionStep(item);
  }

  proj.running = false;
  clientLog('plan-run', {
    request: projectRequest,
    parallel: state.parallelMode,
    layout: plan.layout?.enabled ? proj.status.layout : 'skipped',
    steps: plan.steps.map((s, i) => ({ target: s.target, result: proj.status[i] || 'skipped' })),
  });
  projLog(`\n${ok}단계 완료. 🧪 검증 세션으로 바통을 넘겨 통합 검증을 실행합니다…\n`);
  try {
    const vr = await runVerifySession();
    const vc = vr ? countVerifyIssues(vr) : null;
    if (vc && vc.totalErrors === 0) {
      projLog(`<span class="ok">✅ 검증 세션 통과 (문법·연결·런타임 오류 0건, 테스트 ${vc.testPass}/${vc.testsTotal} 통과)</span>\n`);
    } else if (vc) {
      projLog(`<span class="err">⚠ 검증 세션에서 문제 ${vc.totalErrors}건 발견 — 상단 "🧪 검증 세션"에서 🩺 자동 수정을 실행할 수 있습니다</span>\n`);
    }
  } catch {}
  reloadPreview();
  renderAll();
}

let wfProgTimer = null;
function startWfProgress(label, total = 0) {
  stopWfProgress();
  proj.wfAborted = false;
  proj.wfAbortCtrl = new AbortController();
  const startedAt = Date.now();
  proj.wfProgress = { label, current: 0, total, elapsedSec: 0 };
  wfProgTimer = setInterval(() => {
    if (!proj.wfProgress) return;
    proj.wfProgress.elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const head = inspector.querySelector('.wf-prog-head .muted');
    if (head) head.textContent = `${proj.wfProgress.total ? `${proj.wfProgress.current}/${proj.wfProgress.total}` : ''} · ${proj.wfProgress.elapsedSec}초 경과`;
  }, 1000);
}
function tickWfProgress(current, label) {
  if (!proj.wfProgress) return;
  proj.wfProgress.current = current;
  if (label) proj.wfProgress.label = label;
}
function stopWfProgress() {
  clearInterval(wfProgTimer);
  wfProgTimer = null;
  proj.wfProgress = null;
  proj.wfAbortCtrl = null;
}

async function quickUndoLatest() {
  try {
    const { list } = await api('GET', '/api/snapshots');
    if (!list?.length) return toast('되돌릴 백업 기록이 아직 없습니다', true);
    const latest = list[0];
    if (!(await confirmBox(`가장 최근 백업으로 되돌릴까요?\n\n• ${latest.label || latest.id}\n• 시각: ${new Date(latest.createdAt).toLocaleString('ko-KR')}`, '되돌리기'))) return;
    await api('POST', `/api/snapshots/${encodeURIComponent(latest.id)}/restore`);
    toast('이전 백업 상태로 되돌렸습니다');
    setTimeout(() => location.reload(), 400);
  } catch (e) {
    toast(e.message, true);
  }
}
$('#btnQuickUndo')?.addEventListener('click', quickUndoLatest);

function verifyDataContextNote() {
  if (proj.verifyDataMode === 'upload' && proj.verifyUpload) {
    return `\n\n[검증용 업로드 자료: ${proj.verifyUpload.name}]\n${proj.verifyUpload.preview || '(파일 첨부됨)'}`;
  }
  return '\n\n[가상 검증 자료] 테스트·검증에 필요한 샘플 데이터는 가상(목업) 데이터로 자동 생성해 정상 동작하게 구성하세요.';
}

const VERIFY_MAX_ROUNDS = 5;

// 2단 가상 AI 검증 루프: [1단계] 빠른 검증(문법·연결·로컬호환·스모크) → [2단계] 심층 시나리오 검증(최대 5회 자동 수정)
async function runTwoRoundVerify({ forceRegenTests = false, onLog = () => {} } = {}) {
  proj.wfVerifyBriefing = null;
  const leafIds = allRegions().filter((r) => !isContainer(r)).map((r) => r.id);
  const dataNote = verifyDataContextNote();
  let vr = null;
  let ranRounds = 0;

  // 1단계: 빠른 검증 (기본 스모크 + 문법·연결·로컬 호환성)
  if (!forceRegenTests) {
    startWfProgress('⚡ [1단계/2] 빠른 검증 (문법 · 연결 · 로컬호환 · 기본 스모크)…');
    onLog('⚡ [1단계: 빠른 검증] 문법·연결·로컬 호환성·기본 렌더링 스모크를 점검합니다…\n');
    renderInspector();
    await api('POST', '/api/tests/auto', { append: false }).catch(() => {});
    for (let q = 1; q <= 2; q++) {
      if (proj.wfAborted) break;
      vr = await api('POST', '/api/workflow/verify-features', { runBrowser: true });
      proj.wf = vr.workflow;
      state.verify.report = vr.report;
      if (vr.report.ok || q >= 2 || proj.wfAborted) break;
      const failing = extractFailingRegions(vr.report, leafIds, state.files);
      if (!failing.size) break;
      onLog(`🩺 [1단계 빠른 수정] ${failing.size}개 영역 기본 오류를 먼저 수정합니다…\n`);
      for (const [rid, issues] of failing.entries()) {
        if (proj.wfAborted) break;
        const fixReq = `1단계 빠른 검증에서 이 영역(${rid})에 기본 오류가 발견되었습니다. 로컬 단독 실행이 가능하도록 수정하세요:\n${issues.map((x) => `- ${x}`).join('\n')}${dataNote}`;
        await generateRegion(rid, fixReq, '1단계 빠른 검증 자동 수정', { review: false });
      }
    }
  }

  // 2단계: 심층 시나리오 검증 (요구사항 기반 AI 시나리오 6~10개 + 최대 5회 자동 수정)
  startWfProgress('🔬 [2단계/2] 심층 사용자 시나리오 생성 중…');
  onLog('🔬 [2단계: 심층 시나리오 검증] 요구사항과 전체 화면 코드를 분석해 심층 시나리오를 생성합니다…\n');
  renderInspector();
  try {
    const gen = await api('POST', '/api/tests/generate', { depth: 'deep' });
    onLog(`✓ 심층 시나리오 ${gen.tests?.length || 0}개 생성 완료\n`);
  } catch {
    await api('POST', '/api/tests/auto', { append: false }).catch(() => {});
  }

  for (let round = 1; round <= VERIFY_MAX_ROUNDS; round++) {
    if (proj.wfAborted) break;
    ranRounds = round;
    startWfProgress(`🔬 [2단계] ${round}/${VERIFY_MAX_ROUNDS}차 심층 시나리오 검증 실행 중…`);
    renderInspector();
    vr = await api('POST', '/api/workflow/verify-features', { runBrowser: true });
    proj.wf = vr.workflow;
    state.verify.report = vr.report;
    if (proj.wf.deployReady || round >= VERIFY_MAX_ROUNDS || proj.wfAborted) break;

    const failing = extractFailingRegions(vr.report, leafIds, state.files);
    if (!failing.size) break;
    startWfProgress(`🩺 [2단계] ${round}차 미통과 → ${failing.size}개 영역 자동 수정 중…`);
    onLog(`🩺 [2단계 ${round}차] ${failing.size}개 영역 문제 발견 → 자동 수정 후 ${round + 1}차 검증을 실행합니다…\n`);
    renderInspector();
    for (const [rid, issues] of failing.entries()) {
      if (proj.wfAborted) break;
      const fixReq = `2단계 심층 검증(${round}/${VERIFY_MAX_ROUNDS}차)에서 이 영역(${rid})에 다음 문제가 발견되었습니다. 기존 기능을 유지하며 정확히 수정하세요:\n${issues.map((x) => `- ${x}`).join('\n')}${dataNote}`;
      const fr = await generateRegion(rid, fixReq, `심층 검증 ${round}차 자가치유`, { review: false });
      onLog(fr.ok
        ? `<span class="ok">✓ [${esc(region(rid)?.title || rid)}] 자동 수정 완료</span>\n`
        : `<span class="err">✗ [${esc(rid)}] 자동 수정 실패: ${esc(fr.error)}</span>\n`);
    }
  }

  proj.wf.step = 6;
  if (proj.wf.deployReady) {
    proj.wfVerifyBriefing = null;
    onLog(`<span class="ok">\n✅ ${ranRounds}차 가상 AI 검증을 통과했습니다! 바로 배포할지, 더 검증할지 선택하세요.</span>\n`);
    toast(`✅ ${ranRounds}차 검증 통과! 바로 배포할지 더 검증할지 선택하세요`);
  } else if (vr) {
    proj.wfVerifyBriefing = buildVerifyFailureBriefing(vr.report, proj.wf.checklist, ranRounds);
    onLog(`\n📋 ${esc(proj.wfVerifyBriefing.summary)}\n` +
      proj.wfVerifyBriefing.reasons.map((r) => `  - [${esc(r.kind)}] ${esc(r.text)}`).join('\n') + '\n');
    toast(`${ranRounds}회 가상 AI 검증 후 미통과 원인을 브리핑했습니다`, true);
  }
  return vr;
}

async function runWfAutopilot({ skipDistribute = false, resumeOnly = false } = {}) {
  if (proj.wfBusy) return;
  proj.wfBusy = true;
  proj.wf.step = 5;
  proj.wfBuildLog = resumeOnly
    ? '▶ 멈춘 곳부터 미완료 영역만 이어서 자동 제작합니다…\n'
    : '🚀 원클릭 자동 제작을 시작합니다 (백업 → 지시 분배 → 전체 제작 → 자동 점검 → 오류 자동 수정)…\n';
  startWfProgress('1/4 안전 백업 및 레이아웃 저장 중…');
  renderInspector();
  try {
    clearTimeout(saveTimer);
    await api('PUT', '/api/layout', state.layout);
    await api('POST', '/api/snapshots', { label: resumeOnly ? '이어서 제작 전 백업' : '원클릭 자동 제작 전 백업', auto: true });

    if ((!skipDistribute && !resumeOnly) || !(proj.wf.distributed || []).length) {
      if (proj.wfAborted) throw Object.assign(new Error('중단됨'), { name: 'AbortError' });
      tickWfProgress(0, '2/4 영역별 구현 지시 자동 분배 중…');
      proj.wfBuildLog += '🧭 각 영역에 구현 지시를 자동 분배하는 중…\n';
      renderInspector();
      const dr = await api('POST', '/api/workflow/distribute', { workload: proj.wf.workload }, proj.wfAbortCtrl?.signal);
      proj.wf = dr.workflow;
      state.layout = dr.layout;
      proj.wf.step = 5;
      await Promise.all(allRegions().map((x) => loadRegion(x.id, true)));
      proj.wfBuildLog += `<span class="ok">✓ ${(proj.wf.distributed || []).length}개 영역 지시 분배 완료</span>\n`;
    }

    const fullList = proj.wf.distributed || [];
    const list = resumeOnly ? fullList.filter((d) => !hasCode(d.region)) : fullList;
    if (!fullList.length) throw new Error('제작할 영역이 없습니다');
    if (resumeOnly && !list.length) {
      proj.wfBuildLog += '<span class="ok">✓ 모든 영역이 이미 제작되어 있어 바로 자동 점검으로 넘어갑니다.</span>\n';
    }

    let doneCount = 0;
    startWfProgress(`3/4 앱 제작 중 (0/${list.length})`, list.length);
    const runOne = async (d) => {
      if (proj.wfAborted) return;
      const title = region(d.region)?.title || d.region;
      tickWfProgress(doneCount, `3/4 제작 중 · ${title}`);
      proj.wfBuildLog += `⏳ [${esc(title)}] 구현 중…\n`;
      if (proj.tab === 'workflow' && !state.selected) renderInspector();
      const res = await generateRegion(d.region, d.prompt, proj.wf.workload, { review: false });
      doneCount++;
      tickWfProgress(doneCount, `3/4 제작 중 (${doneCount}/${list.length})`);
      proj.wfBuildLog += res.ok
        ? `<span class="ok">✓ [${esc(title)}] 제작 완료</span>\n`
        : `<span class="err">✗ [${esc(title)}] 실패: ${esc(res.error)}</span>\n`;
      if (res.ok) {
        for (const f of proj.wf.checklist || []) if (f.region === d.region) f.implemented = true;
      }
      if (proj.tab === 'workflow' && !state.selected) renderInspector();
    };
    if (state.parallelMode && list.length > 1) await Promise.all(list.map(runOne));
    else for (const d of list) { if (proj.wfAborted) break; await runOne(d); }

    if (!proj.wfAborted) {
      await runTwoRoundVerify({ forceRegenTests: false, onLog: (msg) => { proj.wfBuildLog += msg; } });
      setView('split');
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      proj.wfBuildLog += `<span class="err">✗ 오류: ${esc(e.message)}</span>\n`;
      toast(e.message, true);
    }
  }
  stopWfProgress();
  proj.wfBusy = false;
  reloadPreview();
  renderAll();
}

async function runSmartEdit() {
  const inp = $('#smartEditInput');
  const text = (inp?.value || '').trim();
  if (!text) return toast('수정할 내용을 한 줄로 적어 주세요', true);
  const route = classifySmartRequest(text, { hasInspected: Boolean(state.inspected) });
  if (route.kind === 'inspect' && state.inspected?.region) {
    const rid = state.inspected.region;
    const fullReq = buildElementPrompt(state.inspected, text);
    inp.value = '';
    toast(`🎯 ${route.label} 실행 중…`);
    await generateRegion(rid, fullReq, '', { review: false });
    state.inspected = null;
    reloadPreview();
    return renderAll();
  }
  if (route.kind === 'layout') {
    proj.wfBusy = true;
    startWfProgress('📐 AI가 화면 배치를 자동 조정하는 중…');
    renderInspector();
    try {
      const screenId = activeScreenOf(state.layout, state.activeScreenId).id;
      const r = await api('POST', '/api/layout/ai-adjust', { instruction: text, screenId });
      state.layout = r.layout;
      inp.value = '';
      toast(`✨ ${r.summary}`);
      reloadPreview();
    } catch (e) { toast(e.message, true); }
    stopWfProgress();
    proj.wfBusy = false;
    return renderAll();
  }
  // 일반 기능 추가·디자인 수정: 자동 계획 → 즉시 실행 → 미리보기 갱신
  proj.wfBusy = true;
  startWfProgress('✨ 요청을 분석해 자동으로 수정하는 중…');
  renderInspector();
  try {
    proj.request = text;
    proj.plan = await api('POST', '/api/project/plan', { request: text, images: toPayloadImages(proj.images) });
    inp.value = '';
    stopWfProgress();
    proj.wfBusy = false;
    await runPlan();
    proj.wfBusy = true;
    await runTwoRoundVerify({ forceRegenTests: false });
    stopWfProgress();
    proj.wfBusy = false;
    setView('split');
    reloadPreview();
    renderAll();
    return;
  } catch (e) {
    toast(e.message, true);
  }
  stopWfProgress();
  proj.wfBusy = false;
  renderAll();
}

inspector.addEventListener('click', async (ev) => {
  const sessBtn = ev.target.closest('[data-session-mode], [data-pick-region], [data-del-session], #btnAddRegionSession');
  if (sessBtn) {
    if (sessBtn.dataset.sessionMode) return switchSessionMode(sessBtn.dataset.sessionMode);
    if (sessBtn.id === 'btnAddRegionSession' && state.selected) {
      const title = await promptBox('새 영역 세션 이름', '추가 작업');
      if (!title?.trim()) return;
      try {
        const created = await api('POST', '/api/sessions/region', { regionId: state.selected, title: title.trim() });
        await refreshSessions();
        return select(state.selected, state.tab, created.key);
      } catch (e) { return toast(e.message, true); }
    }
    if (sessBtn.dataset.delSession) {
      const key = sessBtn.dataset.delSession;
      try {
        await api('DELETE', `/api/sessions/${encodeURIComponent(key)}`);
        await refreshSessions();
        if (state.activeSessionKey === key) state.activeSessionKey = state.selected ? `region:${state.selected}` : '';
        return renderInspector();
      } catch (e) { return toast(e.message, true); }
    }
    if (sessBtn.dataset.pickRegion) return select(sessBtn.dataset.pickRegion, undefined, sessBtn.dataset.pickSession || '');
  }
  if (state.sessionMode === 'verify') {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'btnSessVerifyRun' || b.id === 'btnVerifyRerun') return runVerifySession();
    if (b.id === 'btnSessAutoHeal') return runAutoHealLoop();
    if (b.id === 'btnSessQuality') return $('#btnQuality')?.click();
    if (b.id === 'btnSessAutoTests' || b.id === 'btnVerifyAutoTests') {
      b.disabled = true;
      try {
        const r = await api('POST', '/api/tests/auto', { append: true });
        toast(`기본 테스트 ${r.added}개를 추가하고 다시 검증합니다`);
        await runVerifySession();
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (b.id === 'btnSessAiTests' || b.id === 'btnVerifyAiTests') {
      b.disabled = true;
      try {
        const r = await api('POST', '/api/tests/generate');
        toast(`AI 시나리오 테스트 ${r.tests.length}개를 생성하고 다시 검증합니다`);
        await runVerifySession();
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (b.id === 'btnVerifyFix' && state.verify.report) {
      if (!proj.loaded) await loadProject();
      state.sessionMode = 'integrated';
      state.selected = null;
      proj.tab = 'request';
      proj.request = buildVerifyFixPrompt(state.verify.report);
      saveProjectDraft();
      renderAll();
      return toast('발견된 문제 목록을 통합 세션 요청에 채웠습니다');
    }
    return;
  }
  if (state.selected || state.multi.size) return;
  const t = ev.target.closest('button');
  if (!t) return;
  if (t.dataset.projTab) {
    proj.tab = t.dataset.projTab;
    return renderInspector();
  }
  if (t.dataset.wfStep) {
    proj.wf.step = Number(t.dataset.wfStep);
    api('PUT', '/api/workflow', { step: proj.wf.step }).catch(() => {});
    if (proj.wf.step === 3) setView('design');
    else if (proj.wf.step === 1 || proj.wf.step === 2 || proj.wf.step === 4) {
      if ($('#workspace')?.dataset.mode === 'design') setView('prompt');
    }
    return renderInspector();
  }
  if (t.dataset.styleKit) {
    const kitId = t.dataset.styleKit;
    const kit = FREE_STYLE_KITS.find((k) => k.id === kitId);
    if (!kit) return;
    try {
      const { text: curHead } = await api('GET', '/api/shared/head');
      const nextHead = upsertStyleKitHead(curHead, kitId);
      await api('PUT', '/api/shared/head', { text: nextHead });
      // 결정 메모에 스타일 킷 규칙 갱신 (기존 스타일 킷 줄 교체)
      const prevDec = (proj.decisions || '').split('\n').filter((l) => !/\[스타일 킷\]/.test(l)).join('\n').trim();
      const nextDec = `${prevDec ? `${prevDec}\n` : ''}- [스타일 킷] ${kit.decision}\n`;
      await api('PUT', '/api/project', { decisions: nextDec });
      proj.decisions = nextDec;
      proj.styleKit = kitId;
      reloadPreview();
      toast(`🎨 "${kit.name}" 무료 스타일을 적용했습니다 (head.html · AI 규칙 자동 반영)`);
      return renderInspector();
    } catch (e) { return toast(e.message, true); }
  }
  if (t.dataset.wfExample) {
    const ex = WORKLOAD_EXAMPLES.find((x) => x.id === t.dataset.wfExample);
    if (!ex) return;
    proj.wf.workload = ex.text;
    saveWorkflowDraft({ workload: ex.text });
    toast(`"${ex.label}" 예시를 채웠습니다. 필요에 맞게 수정해 보세요`);
    return renderInspector();
  }
  if (t.id === 'btnWfAbort') {
    proj.wfAborted = true;
    try { proj.wfAbortCtrl?.abort(); } catch {}
    stopWfProgress();
    proj.wfBusy = false;
    toast('진행 중인 AI 작업을 중단했습니다');
    return renderInspector();
  }
  if (t.id === 'btnWfRefine') {
    const workload = ($('#wfWorkload')?.value ?? proj.wf.workload ?? '').trim();
    if (!workload) return toast('먼저 만들고 싶은 앱을 한두 줄이라도 적어 주세요', true);
    proj.wfBusy = true;
    startWfProgress('AI가 요구사항을 구체적으로 다듬는 중…');
    renderInspector();
    try {
      const r = await api('POST', '/api/workflow/refine-workload', { workload }, proj.wfAbortCtrl?.signal);
      proj.wf.workload = r.refined;
      toast('설명을 구체화했습니다. 확인 후 ② 레이아웃 추천을 눌러 주세요');
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message, true);
    }
    stopWfProgress();
    proj.wfBusy = false;
    return renderInspector();
  }
  if (t.id === 'btnWfOpenLayout') {
    setView('design');
    return toast('레이아웃 캔버스를 펼쳤습니다. 편집 후 상단 "✕ 레이아웃 접기"로 돌아올 수 있습니다');
  }
  if (t.id === 'btnWfOpenPreview') {
    setView('split');
    return;
  }
  if (t.id === 'btnWfQuickUndo') return quickUndoLatest();
  if (t.id === 'btnWfOpenFolder') {
    return api('POST', '/api/open-folder', { target: 'dist' }).then(() => toast('저장 폴더(dist)를 열었습니다')).catch((e) => toast(e.message, true));
  }
  if (t.id === 'btnWfPropose') {
    const workload = ($('#wfWorkload')?.value ?? proj.wf.workload ?? '').trim();
    if (!workload) return toast('먼저 만들고 싶은 앱 설명을 입력하세요', true);
    proj.wf.workload = workload;
    proj.wfBusy = true;
    startWfProgress('AI가 레이아웃과 기능 목록을 설계하는 중…');
    renderInspector();
    try {
      proj.wf = await api('POST', '/api/workflow/propose-layout', { workload }, proj.wfAbortCtrl?.signal);
      toast('레이아웃과 기능 목록을 추천했습니다. 직접 수정하거나 캔버스에 반영하세요');
    } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    stopWfProgress();
    proj.wfBusy = false;
    return renderInspector();
  }
  if (t.id === 'btnWfApplyAndAuto') {
    proj.wfBusy = true;
    startWfProgress('추천 화면을 캔버스에 반영하는 중…');
    renderInspector();
    try {
      flushWorkflowDraft(false);
      const r = await api('POST', '/api/workflow/apply-layout', { proposed: proj.wf.proposed });
      state.layout = r.layout;
      state.activeScreenId = activeScreenOf(state.layout).id;
      proj.wf = r.workflow;
      state.path = [];
      await Promise.all([...allRegions().map((x) => loadRegion(x.id, true)), refreshSessions()]);
    } catch (e) {
      stopWfProgress();
      proj.wfBusy = false;
      toast(e.message, true);
      return renderAll();
    }
    stopWfProgress();
    proj.wfBusy = false;
    return runWfAutopilot({ skipDistribute: false });
  }
  if (t.id === 'btnWfAutopilot') return runWfAutopilot({ skipDistribute: false });
  if (t.id === 'btnWfAutopilotFrom4') return runWfAutopilot({ skipDistribute: true });
  if (t.id === 'btnWfResumeBuild') return runWfAutopilot({ skipDistribute: true, resumeOnly: true });
  if (t.id === 'btnSmartEdit') return runSmartEdit();
  if (t.id === 'btnWfApplyLayout') {
    proj.wfBusy = true;
    renderInspector();
    try {
      flushWorkflowDraft(false);
      const r = await api('POST', '/api/workflow/apply-layout', { proposed: proj.wf.proposed });
      state.layout = r.layout;
      state.activeScreenId = activeScreenOf(state.layout).id;
      proj.wf = r.workflow;
      state.path = [];
      await Promise.all([...allRegions().map((x) => loadRegion(x.id, true)), refreshSessions()]);
      setView('design');
      toast('선택한 화면별 레이아웃을 캔버스에 반영했습니다. ③ 좌측 화면 탭을 눌러 각 화면을 편집하세요');
    } catch (e) { toast(e.message, true); }
    proj.wfBusy = false;
    renderAll();
    return fitCanvas();
  }
  if (t.id === 'btnWfSkipProposal') {
    proj.wf.step = 3;
    api('PUT', '/api/workflow', { step: 3 }).catch(showPromptSaveError);
    toast('AI 제안을 적용하지 않고 현재 캔버스 레이아웃을 유지합니다');
    return renderInspector();
  }
  if (t.id === 'btnWfDiscardProposal') {
    if (!(await confirmBox('AI 추천안을 버리고 ① 워크로드 단계로 돌아갈까요?', '제안 버리기'))) return;
    proj.wf.proposed = null;
    proj.wf.step = 1;
    api('PUT', '/api/workflow', { step: 1, proposed: null }).catch(showPromptSaveError);
    toast('AI 제안을 취소했습니다');
    return renderInspector();
  }
  if (t.id === 'btnWfRevise') {
    const feedback = ($('#wfReviseFeedback')?.value || '').trim();
    if (!feedback) return toast('AI에게 요청할 수정 내용을 입력하세요', true);
    proj.wfBusy = true;
    renderInspector();
    try {
      proj.wf = await api('POST', '/api/workflow/propose-layout', {
        workload: proj.wf.workload,
        feedback,
        currentProposed: proj.wf.proposed,
      });
      toast('수정 요청을 반영해 레이아웃과 기능 목록을 다시 추천했습니다');
    } catch (e) { toast(e.message, true); }
    proj.wfBusy = false;
    return renderInspector();
  }
  if (t.id === 'btnWfAddPropScreen' && proj.wf.proposed) {
    const title = await promptBox('추가할 화면 이름 (예: 교사 화면, 결과 화면)', '새 화면');
    if (!title?.trim()) return;
    const scrs = (proj.wf.proposed.screens ||= [{ id: 'main', title: '메인 화면', enabled: true, layout: proj.wf.proposed.layout }]);
    const base = title.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `screen-${scrs.length + 1}`;
    let sid = base;
    for (let k = 2; scrs.some((s) => s.id === sid); k++) sid = `${base}-${k}`;
    scrs.push({ id: sid, title: title.trim(), enabled: true, layout: { cols: 12, rows: 12, fill: true, regions: [] } });
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    return renderInspector();
  }
  if (t.id === 'btnWfAddReg' && proj.wf.proposed) {
    const title = await promptBox('추가할 영역 이름', '새 영역');
    if (!title?.trim()) return;
    const taken = new Set((proj.wf.proposed.regions || []).map((r) => r.id));
    let n = taken.size + 1;
    while (taken.has(`region-${n}`)) n++;
    const id = `region-${n}`;
    const firstScr = proj.wf.proposed.screens?.[0]?.id || 'main';
    (proj.wf.proposed.regions ||= []).push({ id, screen: firstScr, title: title.trim(), purpose: '', color: COLORS[(n - 1) % COLORS.length], enabled: true });
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    return renderInspector();
  }
  if (t.id === 'btnWfAddPropFeat' && proj.wf.proposed) {
    const regs = proj.wf.proposed.regions || [];
    const firstId = regs.find((r) => r.enabled !== false)?.id || regs[0]?.id || 'region-1';
    (proj.wf.proposed.features ||= []).push({ id: `feat-${Date.now().toString(36)}`, region: firstId, name: '', desc: '', enabled: true, implemented: false, verified: false, note: '' });
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    return renderInspector();
  }
  if (t.dataset.wfPropFdel !== undefined && proj.wf.proposed?.features) {
    proj.wf.proposed.features.splice(Number(t.dataset.wfPropFdel), 1);
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    return renderInspector();
  }
  if (t.id === 'btnWfDistribute') {
    proj.wfBusy = true;
    renderInspector();
    try {
      clearTimeout(saveTimer);
      await api('PUT', '/api/layout', state.layout);
      const r = await api('POST', '/api/workflow/distribute', { workload: proj.wf.workload });
      proj.wf = r.workflow;
      state.layout = r.layout;
      await Promise.all(allRegions().map((x) => loadRegion(x.id, true)));
      toast('편집된 레이아웃에 맞춰 각 영역별 프롬프트와 기능 목록을 분배했습니다');
    } catch (e) { toast(e.message, true); }
    proj.wfBusy = false;
    return renderAll();
  }
  if (t.id === 'btnWfBuildAll') {
    const list = proj.wf.distributed || [];
    if (!list.length) return;
    proj.wfBusy = true;
    proj.wf.step = 5;
    let doneCount = 0;
    startWfProgress('앱 제작 준비 중…', list.length);
    proj.wfBuildLog = `⚡ ${list.length}개 영역 제작을 시작합니다 (${state.parallelMode ? '병렬' : '순차/CLI 안전 모드'})…\n`;
    renderInspector();
    const runOne = async (d) => {
      if (proj.wfAborted) return;
      const title = region(d.region)?.title || d.region;
      tickWfProgress(doneCount, `제작 중 · ${title}`);
      proj.wfBuildLog += `⏳ [${esc(title)}] 구현 중…\n`;
      if (proj.tab === 'workflow' && !state.selected) renderInspector();
      const res = await generateRegion(d.region, d.prompt, proj.wf.workload, { review: false });
      doneCount++;
      tickWfProgress(doneCount, doneCount < list.length ? `제작 중 (${doneCount}/${list.length})` : '마무리 중…');
      proj.wfBuildLog += res.ok
        ? `<span class="ok">✓ [${esc(title)}] 완료</span>\n`
        : `<span class="err">✗ [${esc(title)}] 실패: ${esc(res.error)}</span>\n`;
      if (res.ok) {
        for (const f of proj.wf.checklist || []) if (f.region === d.region) f.implemented = true;
      }
      if (proj.tab === 'workflow' && !state.selected) renderInspector();
    };
    try {
      await api('POST', '/api/snapshots', { label: '앱 제작 전 자동 백업', auto: true });
      if (state.parallelMode && list.length > 1) await Promise.all(list.map(runOne));
      else for (const d of list) { if (proj.wfAborted) break; await runOne(d); }
      await api('PUT', '/api/workflow', { step: 5, checklist: proj.wf.checklist });
      if (!proj.wfAborted) {
        await runTwoRoundVerify({ forceRegenTests: false, onLog: (msg) => { proj.wfBuildLog += msg; } });
        setView('split');
      }
    } catch (e) { toast(e.message, true); }
    stopWfProgress();
    proj.wfBusy = false;
    reloadPreview();
    return renderAll();
  }
  if (t.id === 'btnWfAddFeat') {
    const name = await promptBox('추가할 기능 이름');
    if (!name?.trim()) return;
    const firstReg = allRegions().find((r) => !isContainer(r))?.id || '';
    proj.wf.checklist = [...(proj.wf.checklist || []), { id: `feat-${Date.now()}`, region: firstReg, name: name.trim(), desc: '', implemented: false, verified: false, note: '' }];
    await api('PUT', '/api/workflow', { checklist: proj.wf.checklist });
    return renderInspector();
  }
  if (t.dataset.wfFdel !== undefined) {
    proj.wf.checklist.splice(Number(t.dataset.wfFdel), 1);
    await api('PUT', '/api/workflow', { checklist: proj.wf.checklist });
    return renderInspector();
  }
  if (t.dataset.verifyData) {
    proj.verifyDataMode = t.dataset.verifyData;
    if (proj.verifyDataMode === 'upload') {
      $('#verifyDataInput')?.click();
    } else {
      toast('검증 시 필요한 자료를 가상(목업) 데이터로 자동 생성해 점검합니다');
    }
    return renderInspector();
  }
  if (t.id === 'btnWfBriefToSmart' && proj.wfVerifyBriefing?.fixText) {
    const inp = $('#smartEditInput');
    const extra = proj.verifyDataMode === 'upload' && proj.verifyUpload
      ? `\n\n[검증용 업로드 자료: ${proj.verifyUpload.name}]\n${proj.verifyUpload.preview || '(바이너리 파일 첨부됨)'}`
      : '\n\n[검증용 자료 옵션] 필요한 샘플·테스트 데이터는 가상(목업) 데이터로 자동 생성해 검증이 통과하도록 구성해 줘.';
    if (inp) {
      inp.value = proj.wfVerifyBriefing.fixText + extra;
      inp.focus();
    }
    return runSmartEdit();
  }
  if (t.id === 'btnWfVerify' || t.id === 'btnWfVerifyMore') {
    proj.wfBusy = true;
    proj.wf.step = 6;
    renderInspector();
    try {
      await runTwoRoundVerify({ forceRegenTests: t.id === 'btnWfVerifyMore' });
    } catch (e) { toast(e.message, true); }
    stopWfProgress();
    proj.wfBusy = false;
    reloadPreview();
    return renderInspector();
  }
  if (t.id === 'btnWfOpenVerifySess') return switchSessionMode('verify');
  if (t.id === 'btnWfAutoHeal') {
    await switchSessionMode('verify');
    return runAutoHealLoop();
  }
  if (t.id === 'btnWfExportHtml' || t.id === 'btnWfExportOffline') {
    const offline = t.id === 'btnWfExportOffline';
    try {
      if (offline) toast('오프라인 파일 생성 중…');
      const r = await api('POST', '/api/export', { offline });
      toast(`배포 파일 생성 완료: ${r.path}`);
    } catch (e) { toast(e.message, true); }
    return;
  }
  if (t.id === 'btnPlan') return makePlan();
  if (t.id === 'btnProjImg') return $('#projImgInput')?.click();
  if (t.dataset.imgDel?.startsWith('__proj__:')) {
    proj.images.splice(Number(t.dataset.imgDel.split(':')[1]), 1);
    return renderInspector();
  }
  if (t.id === 'btnRunPlan') return runPlan();
  if (t.id === 'btnUndoLayout') return undoLayout();
  if (t.id === 'btnClearPlan') {
    proj.plan = null;
    proj.status = {};
    proj.runLog = '';
    saveProjectDraft();
    return renderInspector();
  }
  if (t.id === 'btnSaveDecisions') {
    proj.decisions = $('#projDecisions').value;
    return api('PUT', '/api/project', { decisions: proj.decisions }).then(() => toast('결정 메모를 저장했습니다')).catch((e) => toast(e.message, true));
  }
  if (t.id === 'btnSaveAppPrompt') {
    proj.appPrompt = $('#projAppPrompt').value;
    state.layout.appPrompt = proj.appPrompt;
    return api('PUT', '/api/project', { appPrompt: proj.appPrompt }).then(() => toast('앱 설명을 저장했습니다')).catch((e) => toast(e.message, true));
  }
});

inspector.addEventListener('input', (ev) => {
  if (ev.target.id === 'chkParallelRun') {
    state.parallelMode = ev.target.checked;
    return;
  }
  if (state.selected || state.multi.size) return;
  const t = ev.target;
  if (t.id === 'wfWorkload') {
    proj.wf.workload = t.value;
    saveWorkflowDraft({ workload: proj.wf.workload });
  } else if (t.dataset.wfScrOn !== undefined && proj.wf.proposed) {
    const scrs = (proj.wf.proposed.screens ||= [{ id: 'main', title: '메인 화면', enabled: true, layout: proj.wf.proposed.layout }]);
    scrs[Number(t.dataset.wfScrOn)].enabled = t.checked;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    renderInspector();
  } else if (t.dataset.wfScrTitle !== undefined && proj.wf.proposed) {
    const scrs = (proj.wf.proposed.screens ||= [{ id: 'main', title: '메인 화면', enabled: true, layout: proj.wf.proposed.layout }]);
    scrs[Number(t.dataset.wfScrTitle)].title = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
  } else if (t.dataset.wfRegScr !== undefined && proj.wf.proposed?.regions) {
    proj.wf.proposed.regions[Number(t.dataset.wfRegScr)].screen = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    renderInspector();
  } else if (t.dataset.wfRegOn !== undefined && proj.wf.proposed?.regions) {
    proj.wf.proposed.regions[Number(t.dataset.wfRegOn)].enabled = t.checked;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    renderInspector();
  } else if (t.dataset.wfRegTitle !== undefined && proj.wf.proposed?.regions) {
    proj.wf.proposed.regions[Number(t.dataset.wfRegTitle)].title = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
  } else if (t.dataset.wfRegPurpose !== undefined && proj.wf.proposed?.regions) {
    proj.wf.proposed.regions[Number(t.dataset.wfRegPurpose)].purpose = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
  } else if (t.dataset.wfFeatOn !== undefined && proj.wf.proposed?.features) {
    proj.wf.proposed.features[Number(t.dataset.wfFeatOn)].enabled = t.checked;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
    renderInspector();
  } else if (t.dataset.wfFeatReg !== undefined && proj.wf.proposed?.features) {
    proj.wf.proposed.features[Number(t.dataset.wfFeatReg)].region = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
  } else if (t.dataset.wfFeatName !== undefined && proj.wf.proposed?.features) {
    proj.wf.proposed.features[Number(t.dataset.wfFeatName)].name = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
  } else if (t.dataset.wfFeatDesc !== undefined && proj.wf.proposed?.features) {
    proj.wf.proposed.features[Number(t.dataset.wfFeatDesc)].desc = t.value;
    saveWorkflowDraft({ proposed: proj.wf.proposed });
  } else if (t.dataset.wfDist !== undefined) {
    proj.wf.distributed[Number(t.dataset.wfDist)].prompt = t.value;
    saveWorkflowDraft({ distributed: proj.wf.distributed });
  } else if (t.id === 'projRequest') {
    proj.request = t.value;
    saveProjectDraft();
  } else if (t.dataset.stepPrompt) {
    proj.plan.steps[Number(t.dataset.stepPrompt)].prompt = t.value;
    saveProjectDraft();
  } else if (t.dataset.stepOn) {
    proj.plan.steps[Number(t.dataset.stepOn)].enabled = t.checked;
    saveProjectDraft();
    renderInspector();
  } else if (t.dataset.reorg) {
    const [kind, i] = t.dataset.reorg.split(':');
    const list = { new: proj.plan.newRegions, move: proj.plan.featureMoves, remove: proj.plan.removeRegions }[kind];
    list[Number(i)].enabled = t.checked;
    saveProjectDraft();
    renderInspector();
  } else if (t.dataset.layoutOn !== undefined) {
    proj.plan.layout.enabled = t.checked;
    saveProjectDraft();
    renderInspector();
  } else if (t.id === 'projAppPrompt') {
    proj.appPrompt = t.value;
    state.layout.appPrompt = t.value;
    saveMetaDraft();
  } else if (t.id === 'projDecisions') {
    proj.decisions = t.value;
    saveMetaDraft();
  }
});

inspector.addEventListener('focusout', (ev) => {
  const t = ev.target;
  if (!t) return;
  if (t.id === 'promptInput' && state.selected) flushRegionPromptSave(state.selected, false);
  else if (t.id === 'wfWorkload' || t.dataset?.wfDist !== undefined || t.dataset?.wfRegTitle !== undefined || t.dataset?.wfRegPurpose !== undefined || t.dataset?.wfFeatName !== undefined || t.dataset?.wfFeatDesc !== undefined) flushWorkflowDraft(false);
  else if (t.id === 'projRequest' || t.dataset?.stepPrompt !== undefined) flushProjectDraft(false);
  else if (t.id === 'projAppPrompt' || t.id === 'projDecisions') flushMetaDraft(false);
});

inspector.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'smartEditInput' && ev.key === 'Enter') {
    ev.preventDefault();
    runSmartEdit();
  }
  if (ev.target.id === 'projRequest' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    makePlan();
  }
});

// ───────────── 나눌 때 기능 배치 ─────────────
// 기능(블록)마다 보낼 조각을 고르는 대화상자. 확인하면 { assign, titles } 를, 취소하면 null 을 돌려준다
async function placementDialog(r, inner, blocks) {
  let count = state.splitCount;
  let dir = state.splitDir;
  const even = (n) => blocks.map((_, i) => Math.min(n - 1, Math.floor((i * n) / blocks.length)));
  let assign = even(count);
  let titles = Array.from({ length: 12 }, (_, k) => `${r.title || r.id} ${k + 1}`);
  const f = state.features[r.id];

  const pending = dialog(`기능 배치 — ${r.title || r.id} ${inner ? '안쪽으로 ' : ''}나누기`, `<div id="placeBody"></div>`, '이대로 나누기');
  $('#dlg').classList.add('wide');
  const draw = () => {
    const pieces = Array.from({ length: count }, (_, k) => {
      const mine = blocks.filter((b, i) => assign[i] === k);
      return `<div class="piece" style="--c:${COLORS[k % COLORS.length]}">
        <input class="piece-title" data-piece="${k}" value="${esc(titles[k])}">
        <div class="piece-items">${mine.map((b) => `<span class="chip">${esc(featureName(b))}</span>`).join('') || '<span class="muted">(비어 있음)</span>'}</div>
      </div>`;
    }).join('');
    $('#placeBody').innerHTML = `
      <div class="place-ctrl">
        <label>방향 <select id="pDir"><option value="h" ${dir === 'h' ? 'selected' : ''}>좌우 ⫴</option><option value="v" ${dir === 'v' ? 'selected' : ''}>상하 ☰</option></select></label>
        <label>개수 <input type="number" id="pCount" min="2" max="12" value="${count}"></label>
        <span class="spacer"></span>
        <button type="button" class="btn small" id="pEven">순서대로 고르게</button>
        <button type="button" class="btn small" id="pAllFirst">모두 1번에</button>
      </div>
      <div class="pieces ${dir === 'h' ? 'row' : 'col'}">${pieces}</div>
      <table class="place-table">
        <thead><tr><th>기능</th><th>보낼 조각</th></tr></thead>
        <tbody>${blocks.map((b, i) => `<tr>
          <td><b>${esc(featureName(b))}</b> <span class="mono muted">${esc(b.tag === '#text' ? '텍스트' : b.tag + (b.id ? '#' + b.id : ''))}</span></td>
          <td><div class="seg-pick">${Array.from({ length: count }, (_, k) =>
            `<button type="button" data-assign="${i}:${k}" class="${assign[i] === k ? 'on' : ''}" style="--c:${COLORS[k % COLORS.length]}">${k + 1}</button>`).join('')}</div></td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="muted small-note">${inner
        ? '안쪽으로 나누면 이 영역의 CSS·JS 는 바깥 영역에 그대로 남아 안쪽 조각 모두에 적용됩니다.'
        : `같은 레벨로 나누면 CSS 는 내용을 받은 조각마다 복사되고${f?.hasJs ? ', JS 는 원래 영역에 남아 모든 조각의 요소를 함께 다룹니다' : ''}.`}
        ${f?.wrappers.length ? ` 감싸는 요소(${esc(f.wrappers.join(' › '))})는 조각마다 복제됩니다 (id 는 첫 조각에만).` : ''}</p>`;
  };
  draw();

  const body = $('#placeBody');
  body.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.assign) {
      const [i, k] = b.dataset.assign.split(':').map(Number);
      assign[i] = k;
    } else if (b.id === 'pEven') assign = even(count);
    else if (b.id === 'pAllFirst') assign = assign.map(() => 0);
    draw();
  });
  body.addEventListener('change', (ev) => {
    if (ev.target.id === 'pDir') dir = ev.target.value;
    if (ev.target.id === 'pCount') {
      count = Math.max(2, Math.min(12, Number(ev.target.value) || 2));
      assign = even(count);
    }
    draw();
  });
  body.addEventListener('input', (ev) => {
    if (ev.target.dataset.piece) titles[Number(ev.target.dataset.piece)] = ev.target.value;
  });

  const ok = await pending;
  $('#dlg').classList.remove('wide');
  if (!ok) return null;
  state.splitDir = dir;
  state.splitCount = count;
  return { assign, titles: titles.slice(0, count) };
}

// ───────────── 기능 목록 ─────────────
function featureCard(regionId, b, depth) {
  const counts = Object.entries(b.counts || {}).map(([k, v]) => `<span class="badge-soft">${k} ${v}</span>`).join('');
  const where = b.tag === '#text' ? '텍스트' : `${b.tag}${b.id ? '#' + b.id : ''}${b.cls ? '.' + b.cls : ''}`;
  const canShow = b.elementIndex !== undefined;
  const deps = b.fid && state.deps[`${regionId}/${b.fid}`];
  return `<li class="feature${canShow ? ' clickable' : ''}" ${canShow ? `data-hl-region="${esc(regionId)}" data-hl-depth="${depth}" data-hl-index="${b.elementIndex}"` : ''}${b.fid ? ` draggable="true" data-drag-fid="${b.fid}" data-drag-from="${esc(regionId)}"` : ''} title="${canShow ? '눌러서 미리보기에서 위치 보기 · 캔버스의 다른 영역으로 끌어 옮기기' : ''}">
    <div class="f-head"><b>${esc(featureName(b))}</b><span class="mono muted">${esc(where)}</span></div>
    ${b.note?.desc ? `<div class="f-desc">${esc(b.note.desc)}</div>` : b.text && b.text !== b.label ? `<div class="f-desc muted">${esc(b.text)}</div>` : ''}
    ${counts || b.fns?.length ? `<div class="f-meta">${counts}${b.fns?.length ? `<span class="mono muted">${esc(b.fns.join(', '))}()</span>` : ''}</div>` : ''}
    ${b.fid ? `<div class="f-actions"><button class="btn tiny" data-deps="${b.fid}" data-from="${esc(regionId)}">${deps ? '▾' : '▸'} 함께 움직이는 것</button><button class="btn tiny" data-move-feature="${b.fid}" data-from="${esc(regionId)}">↗ 다른 영역으로</button></div>` : ''}
    ${deps ? depsHtml(deps) : ''}
  </li>`;
}

function featuresHtml(r) {
  const f = state.features[r.id];
  if (!f || !f.blocks.length) {
    return `<div class="insp-empty"><p><b>아직 구현된 기능이 없습니다.</b></p><p>"프롬프트" 탭에서 구현할 내용을 적고 ⚡ 바이브 코딩을 실행하세요.</p></div>`;
  }
  const notes = f.blocks.filter((b) => b.note).length;
  const links = [];
  if (r.jsRoots?.length > 1) links.push(`🔗 이 영역의 script.js 는 ${r.jsRoots.filter((x) => x !== r.id).map((x) => `<b>${esc(region(x)?.title || x)}</b>`).join(', ')} 의 요소도 함께 다룹니다.`);
  for (const o of allRegions()) {
    if (o.id !== r.id && o.jsRoots?.includes(r.id)) links.push(`🔗 이 영역의 요소는 <b>${esc(o.title || o.id)}</b> 의 script.js 가 함께 다룹니다.`);
  }
  return `<div class="features-head">
      <span><b>${f.blocks.length}개 기능</b>${f.wrappers.length ? ` <span class="muted">(${esc(f.wrappers.join(' › '))} 안)</span>` : ''}</span>
      <span class="spacer"></span>
      <button class="btn small" id="btnDescribe" title="AI 가 기능마다 이름과 설명을 붙입니다">🤖 ${notes ? 'AI 설명 다시' : 'AI로 기능 설명'}</button>
    </div>
    ${links.length ? `<p class="muted small-note">${links.join('<br>')}</p>` : ''}
    ${undoMoveHtml()}
    <ul class="feature-list">${f.blocks.map((b) => featureCard(r.id, b, f.wrappers.length)).join('')}</ul>
    <p class="muted small-note">기능 = 이 영역 HTML 의 최상위 블록입니다. 캔버스의 기능 칩이나 이 카드를 캔버스의 다른 영역으로 끌면 CSS·JS 와 함께 옮겨집니다 (AI 사용 안 함).</p>`;
}

function containerFeaturesHtml(r) {
  const groups = flatten(r)
    .filter((e) => !isContainer(e.region))
    .map(({ region: c }) => {
      const f = state.features[c.id];
      const list = f?.blocks.length ? f.blocks.map((b) => featureCard(c.id, b, f.wrappers.length)).join('') : '<li class="muted">구현된 기능 없음</li>';
      return `<li class="feature-group"><div class="f-group-head"><span class="dot" style="background:${c.color}"></span><b>${esc(c.title || c.id)}</b> <span class="mono muted">#${esc(c.id)}</span></div><ul class="feature-list">${list}</ul></li>`;
    })
    .join('');
  return `<div class="features-head"><b>안쪽 영역별 기능</b></div>${undoMoveHtml()}<ul class="feature-groups">${groups}</ul>`;
}

// ── 기능 옮기기 ──
function depsHtml(d) {
  const list = (title, items, cls = '') => (items.length ? `<div class="dep-row"><span class="muted">${title}</span> ${items.map((x) => `<code class="${cls}">${esc(x)}</code>`).join(' ')}</div>` : '');
  const body = [
    list('CSS 함께 옮김', d.css.move),
    list('CSS 복사 (다른 기능과 같이 씀)', d.css.copy),
    list('JS 함께 옮김', d.js.move),
    list('JS 남김 + 연결', d.js.bridge, 'warn'),
    list('보내는 이벤트', d.events.emits),
    list('받는 이벤트', d.events.listens),
    list('전역 app.js 가 쓰는 id', d.global || []),
  ].join('');
  return `<div class="deps">${body || '<span class="muted">이 기능만의 CSS·JS 가 없습니다. 마크업만 옮겨집니다.</span>'}${d.js.error ? `<div class="muted">JS 분석 실패: ${esc(d.js.error)}</div>` : ''}</div>`;
}

function undoMoveHtml() {
  const m = state.lastMove;
  return m ? `<div class="undo-move"><span>↗ ${esc(m.text)}</span><button class="btn tiny" data-undo-move="1">↶ 이동 취소</button></div>` : '';
}

async function featureButton(b) {
  try {
    if (b.dataset.undoMove) return await undoMove();
    const key = `${b.dataset.from}/${b.dataset.deps || b.dataset.moveFeature}`;
    if (b.dataset.deps) {
      if (state.deps[key]) delete state.deps[key];
      else state.deps[key] = await api('GET', `/api/regions/${b.dataset.from}/features/${b.dataset.deps}/deps`);
      return renderInspector();
    }
    const to = await pickTargetRegion(b.dataset.from);
    if (to) await moveFeature(b.dataset.moveFeature, b.dataset.from, to);
  } catch (e) {
    toast(e.message, true);
  }
}

// 옮겨 갈 영역 고르기 (안쪽 레이아웃 속 영역도 포함)
async function pickTargetRegion(from) {
  const leaves = allRegions().filter((r) => !isContainer(r) && r.id !== from);
  if (!leaves.length) return toast('옮겨 갈 다른 영역이 없습니다. 먼저 영역을 만드세요', true);
  const dlg = await dialog('기능을 옮길 영역', `<div class="pick-list">${leaves.map((r, i) => `<label><input type="radio" name="pickTo" value="${esc(r.id)}" ${i ? '' : 'checked'}> <span class="dot" style="background:${r.color}"></span> ${esc(r.title || r.id)} <span class="mono muted">#${esc(r.id)}</span></label>`).join('')}</div>`, '다음');
  return dlg && dlg.querySelector('input[name=pickTo]:checked')?.value;
}

async function moveFeature(fid, from, to) {
  const name = (id) => region(id)?.title || id;
  const dry = await api('POST', '/api/features/move', { fid, from, to, dryRun: true });
  const s = dry.summary;
  const lines = [
    `"${s.feature}" 을(를) ${name(from)} → ${name(to)} 로 옮깁니다.`,
    s.css.move.length && `· CSS 옮김: ${s.css.move.join(', ')}`,
    s.css.copy.length && `· CSS 복사: ${s.css.copy.join(', ')}`,
    s.js.move && `· JS 문장 ${s.js.move}개 옮김`,
    dry.bridge && `· JS 문장 ${s.js.bridge}개는 ${name(from)} 에 남기고, 옮긴 요소도 다룰 수 있게 연결합니다`,
    s.events.length && `· 이벤트(${s.events.join(', ')}) 는 그대로 이어집니다`,
    s.sourceEmpty && `· 옮기고 나면 ${name(from)} 은(는) 비게 됩니다`,
  ].filter(Boolean);
  lines.push('', 'AI 를 쓰지 않고 코드를 그대로 옮깁니다. 옮기기 전에 스냅샷을 자동 저장하고, 옮긴 뒤 오류·테스트를 확인합니다.');
  if (!(await confirmBox(lines.join('\n'), '옮기기'))) return;
  clearTimeout(saveTimer);
  await api('PUT', '/api/layout', state.layout);
  const res = await api('POST', '/api/features/move', { fid, from, to });
  state.lastMove = { snapshot: res.snapshot, text: `"${s.feature}" ${name(from)} → ${name(to)}` };
  state.layout = await api('GET', '/api/layout');
  await Promise.all([loadRegion(from, true), loadRegion(to, true)]);
  for (const k of Object.keys(state.deps)) if (k.startsWith(`${from}/`) || k.startsWith(`${to}/`)) delete state.deps[k];
  state.selected = to;
  state.path = ancestors(state.layout, to);
  state.tab = 'features';
  reloadPreview();
  renderAll();
  toast('옮겼습니다. 동작을 확인하는 중…');

  // 옮긴 뒤 확인: 두 영역의 실행 오류 + 저장된 동작 테스트
  const err = await runtimeCheck([from, to]);
  const tests = err ? [] : await runAllTests();
  const failed = tests.filter((t) => !t.ok);
  if (!err && !failed.length) return toast(`옮겼습니다 · ${tests.length ? testSummary(tests) : '실행 오류 없음'}`);
  const why = err ? `실행 오류 — ${err}` : testSummary(tests);
  if (await confirmBox(`옮긴 뒤 문제가 있습니다.\n${why}\n\n옮기기 전으로 되돌릴까요?`, '되돌리기')) await undoMove();
}

async function undoMove() {
  const m = state.lastMove;
  if (!m) return;
  await api('POST', `/api/snapshots/${m.snapshot}/restore`);
  state.lastMove = null;
  toast('기능 이동을 되돌렸습니다');
  setTimeout(() => location.reload(), 600);
}

// 끌어서 옮기기: 캔버스의 기능 칩이나 기능 카드를 캔버스의 다른 영역 상자에 놓는다
let featureDrag = null;
document.addEventListener('dragstart', (ev) => {
  const el = ev.target.closest?.('[data-drag-fid]');
  if (!el) return;
  featureDrag = { fid: el.dataset.dragFid, from: el.dataset.dragFrom };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', featureDrag.fid);
  canvas.classList.add('feature-dragging');
});
document.addEventListener('dragend', () => {
  featureDrag = null;
  canvas.classList.remove('feature-dragging');
  canvas.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
});
const dropRegion = (ev) => {
  const el = ev.target.closest?.('.region[data-id]');
  const r = el && region(el.dataset.id);
  return r && !isContainer(r) && featureDrag && r.id !== featureDrag.from ? el : null;
};
canvas.addEventListener('dragover', (ev) => {
  const el = dropRegion(ev);
  canvas.querySelectorAll('.drop-target').forEach((x) => x !== el && x.classList.remove('drop-target'));
  if (!el) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  el.classList.add('drop-target');
});
canvas.addEventListener('drop', async (ev) => {
  const el = dropRegion(ev);
  if (!el) return;
  ev.preventDefault();
  const { fid, from } = featureDrag;
  el.classList.remove('drop-target');
  try {
    await moveFeature(fid, from, el.dataset.id);
  } catch (e) {
    toast(e.message, true);
  }
});

function highlightFeature(el) {
  if ($('#stage').dataset.view === 'design') setView('split');
  const msg = { type: 'highlight', region: el.dataset.hlRegion, depth: Number(el.dataset.hlDepth), index: Number(el.dataset.hlIndex) };
  // 방금 미리보기를 연 경우 로드가 끝난 뒤 보낸다
  const send = () => $('#preview').contentWindow?.postMessage(msg, '*');
  if ($('#preview').src && previewLoaded) send(); // 미리보기는 다른 출처라 문서에 직접 접근하지 않는다
  else $('#preview').addEventListener('load', () => setTimeout(send, 100), { once: true });
}

async function describeFeatures(id) {
  const btn = $('#btnDescribe');
  btn.disabled = true;
  btn.textContent = '🤖 분석 중…';
  try {
    state.features[id] = await api('POST', `/api/regions/${id}/describe`);
    toast('기능 설명을 붙였습니다');
  } catch (e) {
    toast(e.message, true);
  }
  renderAll();
}

function fmtVersion(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : v;
}


inspector.addEventListener('click', async (ev) => {
  const am = ev.target.closest('[data-add-memo]');
  if (am) {
    const lines = state.memoSuggest[am.dataset.addMemo] || [];
    try {
      const res = await api('POST', '/api/project/decisions/add', { lines });
      proj.decisions = res.decisions;
      delete state.memoSuggest[am.dataset.addMemo];
      am.disabled = true;
      am.textContent = res.added ? `✓ ${res.added}줄 추가됨` : '이미 메모에 있음';
      toast(res.added ? '결정 메모에 추가했습니다 (프로젝트 패널 › 결정 메모)' : '이미 메모에 있는 규칙입니다');
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  const fb = ev.target.closest('[data-deps], [data-move-feature], [data-undo-move]');
  if (fb) return featureButton(fb);
  const card = ev.target.closest('[data-hl-region]');
  if (card) return highlightFeature(card);
  const t = ev.target.closest('button');
  if (!t) return;
  if (t.id === 'btnDescribe') return describeFeatures(state.selected);
  if (t.id === 'btnMerge') return layoutOp('POST', '/api/regions/merge', { ids: [...state.multi] }, '합쳤습니다');
  if (t.id === 'btnClearMulti') {
    state.multi.clear();
    return renderAll();
  }
  const r = region(state.selected);
  if (!r) return;
  if (t.id === 'btnEnter') return enter(r.id);
  if (t.id === 'btnUnwrap') {
    if (!(await confirmBox('안쪽 영역들의 HTML·CSS·JS 를 이 영역 하나로 합칠까요?\n안쪽 영역 폴더는 .trash 로 옮겨집니다.', '풀기'))) return;
    return layoutOp('POST', `/api/regions/${r.id}/unwrap`, {}, '안쪽 레이아웃을 풀었습니다');
  }
  if (t.id === 'btnSplit' || t.id === 'btnSplitInner') {
    state.splitDir = $('#splitDir').value;
    state.splitCount = Number($('#splitCount').value) || 2;
    const inner = t.id === 'btnSplitInner';
    const blocks = state.features[r.id]?.blocks || [];
    let extra = {};
    if (blocks.length >= 2) {
      extra = await placementDialog(r, inner, blocks);
      if (!extra) return;
    }
    return layoutOp('POST', `/api/regions/${r.id}/split`, { dir: state.splitDir, count: state.splitCount, inner, ...extra },
      inner ? '안쪽 레이아웃을 만들었습니다. 상단 경로(앱 › …)로 바깥으로 나갈 수 있습니다' : '나눴습니다');
  }
  if (t.dataset.imgDel && !t.dataset.imgDel.startsWith('__proj__:')) {
    const [rid, idx] = t.dataset.imgDel.split(':');
    state.images[rid]?.splice(Number(idx), 1);
    return renderInspector();
  }
  if (t.dataset.tab) {
    state.tab = t.dataset.tab;
    if (state.tab === 'history') await loadRegion(r.id, true);
    return renderInspector();
  }
  if (t.dataset.restore) {
    if (!(await confirmBox('이 버전으로 되돌릴까요? 현재 버전도 기록에 백업됩니다.', '되돌리기'))) return;
    const { files } = await api('POST', `/api/regions/${r.id}/restore`, { version: t.dataset.restore });
    state.files[r.id] = files;
    delete state.drafts[r.id];
    await loadRegion(r.id, true);
    toast('되돌렸습니다');
    reloadPreview();
    return renderAll();
  }
  switch (t.id) {
    case 'btnGenerate': return runGenerate(r.id);
    case 'btnRegionImg': return $('#regionImgInput')?.click();
    case 'btnClearInspect':
      state.inspected = null;
      return renderInspector();
    case 'btnInspectAi': return runInspectGenerate(r.id);
    case 'btnApplyQuickStyle': return applyInspectQuickStyle(r.id);
    case 'btnApplyPending': return applyPending(r.id);
    case 'btnDiscardPending': return discardPending(r.id);
    case 'btnPreviewPending':
      if ($('#stage').dataset.view === 'design') setView('split');
      setTimeout(async () => ($('#preview').src = await previewUrl(`/preview?candidate=${encodeURIComponent(r.id)}&t=${Date.now()}`, true)), 250);
      return toast('저장하지 않은 결과로 미리보기 중입니다 (새로고침하면 저장된 상태로)');
    case 'btnCopyPrompt': return copyPrompt(r.id);
    case 'btnSaveFile': return saveFile(r.id, state.tab);
    case 'btnRevert':
      delete state.drafts[r.id][state.tab];
      return renderInspector();
    case 'btnDelete': return deleteRegion(r.id);
  }
});

inspector.addEventListener('input', (ev) => {
  const r = region(state.selected);
  if (!r) return;
  const t = ev.target;
  if (t.id === 'promptInput' || t.id === 'codeInput') {
    onDraftInput(r.id, t.id === 'promptInput' ? 'prompt' : state.tab, t.value);
  } else if (['iqColor', 'iqBg', 'iqSize', 'iqRadius', 'iqPad'].includes(t.id) && state.inspected?.region === r.id) {
    const styles = collectQuickStyles();
    preview.contentWindow?.postMessage({ type: 'inspect-live-style', region: r.id, selector: state.inspected.selector, styles }, '*');
  } else if (t.id === 'fTitle') {
    r.title = t.value;
    renderList();
    renderCanvas();
    saveLayout();
  } else if (t.id === 'fColor') {
    r.color = t.value;
    renderList();
    renderCanvas();
    saveLayout();
  }
});

inspector.addEventListener('change', async (ev) => {
  if (ev.target.id === 'verifyDataInput') {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    let previewText = '';
    if (/^(text\/|application\/(json|xml|csv))|\.(txt|json|csv|md|html)$/i.test(file.type || file.name)) {
      previewText = (await file.text()).slice(0, 3500);
    } else {
      previewText = `(${file.type || '파일'}, ${Math.round(file.size / 1024)}KB)`;
    }
    proj.verifyDataMode = 'upload';
    proj.verifyUpload = { name: file.name, size: file.size, preview: previewText };
    toast(`📎 검증용 자료 "${file.name}" 을(를) 불러왔습니다`);
    return renderInspector();
  }
  if (ev.target.id === 'projImgInput') {
    const ok = await addImageFiles(proj.images, ev.target.files, toast);
    ev.target.value = '';
    if (ok) renderInspector();
    return;
  }
  if (ev.target.id === 'regionImgInput' && state.selected) {
    const list = (state.images[state.selected] ||= []);
    const ok = await addImageFiles(list, ev.target.files, toast);
    ev.target.value = '';
    if (ok) renderInspector();
    return;
  }
  if (ev.target.id === 'reviewMode') {
    state.reviewMode = ev.target.checked;
    try { localStorage.setItem('ide-review', state.reviewMode ? '1' : '0'); } catch {}
    return;
  }
  const r = region(state.selected);
  if (!r) return;
  const t = ev.target;
  if (t.dataset.pos) {
    const key = t.dataset.pos;
    const val = Number(t.value) - (key === 'x' || key === 'y' ? 1 : 0);
    const g = geoOf(r.id);
    const rect = { x: g.x, y: g.y, w: g.w, h: g.h, [key]: val };
    if (!isValid(rect, r.id)) {
      toast('다른 영역과 겹치거나 그리드를 벗어납니다', true);
      return renderInspector();
    }
    Object.assign(g, rect);
    saveLayout();
    renderAll();
  } else if (t.id === 'fId') {
    const newId = t.value.trim();
    if (newId === r.id) return;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(newId)) {
      toast('ID 는 영문 소문자로 시작하고 소문자/숫자/하이픈만 쓸 수 있습니다', true);
      return renderInspector();
    }
    try {
      clearTimeout(saveTimer);
      await api('PUT', '/api/layout', state.layout);
      state.layout = await api('POST', `/api/regions/${r.id}/rename`, { newId });
      for (const bag of [state.files, state.drafts, state.history, state.logs]) {
        if (bag[r.id] !== undefined) { bag[newId] = bag[r.id]; delete bag[r.id]; }
      }
      state.selected = newId;
      state.path = ancestors(state.layout, newId);
      await loadRegion(newId, true);
      toast(`폴더 이름도 regions/${newId} 로 바뀌었습니다`);
      reloadPreview();
    } catch (e) {
      toast(e.message, true);
    }
    renderAll();
  }
});

inspector.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'TEXTAREA' && ev.key === 'Tab') {
    ev.preventDefault();
    ev.target.setRangeText('  ', ev.target.selectionStart, ev.target.selectionEnd, 'end');
    ev.target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (ev.target.id === 'promptInput' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    runGenerate(state.selected);
  }
  if (ev.target.id === 'inspectPrompt' && ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    runInspectGenerate(state.selected);
  }
});

// 참고 이미지 붙여넣기(Ctrl+V) 및 드래그&드롭 첨부 (영역 프롬프트 · 프로젝트 요청 공용)
inspector.addEventListener('paste', async (ev) => {
  const id = ev.target.id;
  if (id !== 'promptInput' && id !== 'projRequest') return;
  const files = extractClipboardImages(ev);
  if (!files.length) return;
  ev.preventDefault();
  const list = id === 'projRequest' ? proj.images : (state.images[state.selected] ||= []);
  if (await addImageFiles(list, files, toast)) {
    toast(`참고 이미지 ${files.length}장을 첨부했습니다`);
    renderInspector();
  }
});
inspector.addEventListener('dragover', (ev) => {
  if (!['promptInput', 'projRequest'].includes(ev.target.id)) return;
  if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
  ev.preventDefault();
  ev.target.classList.add('drop-active');
});
inspector.addEventListener('dragleave', (ev) => {
  if (['promptInput', 'projRequest'].includes(ev.target.id)) ev.target.classList.remove('drop-active');
});
inspector.addEventListener('drop', async (ev) => {
  const id = ev.target.id;
  if (id !== 'promptInput' && id !== 'projRequest') return;
  ev.target.classList.remove('drop-active');
  const files = [...(ev.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  ev.preventDefault();
  const list = id === 'projRequest' ? proj.images : (state.images[state.selected] ||= []);
  if (await addImageFiles(list, files, toast)) {
    toast(`참고 이미지 ${files.length}장을 첨부했습니다`);
    renderInspector();
  }
});

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    if (state.selected && ['html', 'css', 'js'].includes(state.tab)) saveFile(state.selected, state.tab);
    else if (state.selected && state.tab === 'prompt') saveFile(state.selected, 'prompt');
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!typing && state.selected && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    ev.preventDefault();
    deleteRegion(state.selected);
  }
  // Esc: 여러 개 선택 → 선택 → 한 레벨 위로 순서로 해제
  if (!typing && ev.key === 'Escape') {
    if (state.multi.size) {
      state.multi.clear();
      renderAll();
    } else if (state.selected) select(null);
    else if (state.path.length) goTo(state.path.length - 1);
  }
});

async function saveFile(id, key) {
  const value = draft(id, key);
  try {
    await api('PUT', `/api/regions/${id}`, { [key]: value });
    state.files[id][key] = value;
    if (state.drafts[id]) delete state.drafts[id][key];
    if (key !== 'prompt') await loadRegion(id, true);
    toast('저장했습니다');
    reloadPreview();
    renderAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// 분할·합치기는 서버가 레이아웃과 파일을 함께 바꾸므로, 결과 레이아웃을 받아 화면을 새로 그린다
async function layoutOp(method, url, body, okMsg) {
  try {
    clearTimeout(saveTimer);
    await api('PUT', '/api/layout', state.layout);
    const res = await api(method, url, body);
    state.layout = res.layout;
    state.files = {};
    state.drafts = {};
    state.history = {};
    await Promise.all([...allRegions().map((r) => loadRegion(r.id)), refreshSessions()]);
    state.multi.clear();
    state.path = res.focus ? ancestors(state.layout, res.focus) : [];
    state.selected = res.focus || null;
    toast(okMsg);
    reloadPreview();
    renderAll();
    fitCanvas();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteRegion(id) {
  const { region: r, parent } = find(state.layout, id);
  const inner = isContainer(r) ? `\n안쪽 영역 ${flatten(r).length}개도 함께 삭제됩니다.` : '';
  if (!(await confirmBox(`'${r.title || id}' 영역을 삭제할까요?${inner}\n파일은 프로젝트의 .trash 폴더로 옮겨집니다.`, '삭제'))) return;
  parent.regions = parent.regions.filter((x) => x.id !== id);
  state.selected = null;
  saveLayout(true);
  renderAll();
}

// ───────────── 바이브 코딩 ─────────────
async function runGenerate(id) {
  const request = draft(id, 'prompt').trim();
  if (!request) return toast('구현할 내용을 프롬프트에 적어 주세요', true);
  // 영역 탭에서 직접 실행할 때는 기본으로 "검토 후 적용" (설정은 체크박스로)
  await generateRegion(id, request, '', { review: state.reviewMode, images: toPayloadImages(state.images[id]) });
}

async function runInspectGenerate(id) {
  const info = state.inspected;
  if (!info || info.region !== id) return;
  const req = ($('#inspectPrompt')?.value || '').trim();
  if (!req) return toast('선택한 요소를 어떻게 수정할지 적어 주세요', true);
  const fullReq = buildElementPrompt(info, req);
  await generateRegion(id, fullReq, '', { review: state.reviewMode, images: toPayloadImages(state.images[id]) });
}

function collectQuickStyles() {
  const styles = {};
  const color = $('#iqColor')?.value;
  const bg = $('#iqBg')?.value;
  const size = $('#iqSize')?.value;
  const radius = $('#iqRadius')?.value;
  const pad = ($('#iqPad')?.value || '').trim();
  if (color) styles.color = color;
  if (bg) styles['background-color'] = bg;
  if (size !== '' && Number(size) > 0) styles['font-size'] = `${Math.round(Number(size))}px`;
  if (radius !== '' && Number(radius) >= 0) styles['border-radius'] = `${Math.round(Number(radius))}px`;
  if (pad) styles.padding = pad;
  return styles;
}

async function applyInspectQuickStyle(id) {
  const info = state.inspected;
  if (!info || info.region !== id) return;
  const styles = collectQuickStyles();
  if (!Object.keys(styles).length) return toast('적용할 스타일 값이 없습니다', true);
  const curCss = draft(id, 'css');
  const nextCss = upsertElementStyleRule(curCss, info.selector, styles);
  try {
    await api('PUT', `/api/regions/${id}`, { css: nextCss });
    state.files[id].css = nextCss;
    if (state.drafts[id]) delete state.drafts[id].css;
    await loadRegion(id, true);
    toast(`${info.selector} 스타일을 style.css 에 반영했습니다`);
    reloadPreview();
    renderInspector();
  } catch (e) {
    toast(e.message, true);
  }
}

// 영역 하나를 AI 로 구현한다 (영역 프롬프트 탭과 프로젝트 계획 실행이 함께 씀). 결과: { ok, error, pending, runtimeError }
// opts.review: 저장하지 않고 검토 대기로 / opts.runtimeError: 실행 검사 오류로 다시 고치기 / opts.fromPending: 검토 중 결과를 바탕으로
async function generateRegion(id, request, projectRequest = '', opts = {}) {
  if (state.busy.has(id)) return { ok: false, error: '이미 구현 중입니다' };
  let result = { ok: false, error: '응답이 끝나지 않았습니다' };
  const r = region(id);
  r.summary = request.split('\n')[0].slice(0, 100);
  clearTimeout(saveTimer);
  await api('PUT', '/api/layout', state.layout);

  state.busy.add(id);
  if (!opts.runtimeError) state.logs[id] = '';
  state.files[id].prompt = request; // 서버가 prompt.md 에 바로 저장함
  if (state.drafts[id]) delete state.drafts[id].prompt;
  renderAll();
  const appendLog = (html) => {
    state.logs[id] = (state.logs[id] || '') + html;
    const log = state.selected === id && $('#genLog');
    if (log) {
      log.innerHTML = state.logs[id];
      log.scrollTop = log.scrollHeight;
    }
  };

  try {
    // 이미 내용이 있는 영역이면 지금 화면 상태를 재서 글로 함께 보낸다 (칸에 안 맞는 문제를 AI 가 알 수 있게)
    let measured = { text: '' };
    if (hasCode(id) && !opts.fromPending) {
      appendLog('<span class="muted">📏 지금 화면에서 칸 크기를 재는 중…</span>\n');
      measured = await measureRegion(id);
    }
    const res = await fetch(`/api/regions/${id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, projectRequest, sessionKey: opts.sessionKey || (state.selected === id && state.activeSessionKey) || `region:${id}`, review: Boolean(opts.review), runtimeError: opts.runtimeError || '', fromPending: Boolean(opts.fromPending), measured: measured.text, cell: measured.cell, images: opts.images || [] }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'delta') appendLog(esc(ev.text));
        else if (ev.type === 'error') {
          appendLog(`\n<span class="err">✗ ${esc(ev.message)}</span>`);
          result = { ok: false, error: ev.message };
        } else if (ev.type === 'done') {
          result = { ok: true, pending: Boolean(ev.pending) };
          if (ev.memo?.length) {
            state.memoSuggest[id] = ev.memo;
            appendLog(`\n<div class="memo-suggest">📌 AI 가 결정 메모에 넣을 규칙을 제안했습니다:<ul>${ev.memo.map((m) => `<li>${esc(m)}</li>`).join('')}</ul><button class="btn tiny" data-add-memo="${esc(id)}">결정 메모에 추가</button></div>`);
          }
          const tokens = ev.usage ? ` · 입력 ${ev.usage.input_tokens} / 출력 ${ev.usage.output_tokens} 토큰` : '';
          const tries = ev.attempt > 1 ? ` · 자동 검사 후 ${ev.attempt}번째 시도에 통과` : '';
          if (ev.pending) {
            state.pending[id] = { files: ev.files, current: ev.current, updated: ev.updated };
            appendLog(`\n<span class="ok">✓ 생성 완료 — 아래에서 변경을 확인하고 적용하세요 (${ev.updated.join(', ') || '변경 없음'})${tokens}${tries}</span>`);
          } else {
            state.files[id] = ev.files;
            if (state.drafts[id]) state.drafts[id] = {};
            await loadRegion(id, true);
            appendLog(`\n<span class="ok">✓ 저장됨: ${ev.updated.join(', ') || '변경 없음'}${tokens}${tries}</span>`);
            reloadPreview();
          }
        }
      }
    }
  } catch (e) {
    appendLog(`\n<span class="err">✗ ${esc(e.message)}</span>`);
    result = { ok: false, error: e.message };
  } finally {
    state.busy.delete(id);
    refreshQuotaBadge();
    renderAll();
  }

  // 실행 검사: 숨은 미리보기에서 이 영역 스크립트가 오류를 내는지 보고, 나면 한 번 더 고치게 한다
  if (result.ok) {
    appendLog('\n🔎 미리보기 실행 검사 중…');
    const err = await runtimeCheck(id, result.pending);
    if (!err) {
      appendLog(' <span class="ok">통과</span>');
      if (state.pending[id]) state.pending[id].checked = 'ok';
      // 저장해 둔 동작 테스트가 있으면 이어서 실행 (검토 중이면 검토 중인 결과로)
      const tr = await runAllTests(result.pending ? id : null).catch(() => []);
      if (tr.length) {
        const summary = testSummary(tr);
        appendLog(`\n🧪 ${tr.every((t) => t.ok) ? `<span class="ok">${esc(summary)}</span>` : `<span class="err">${esc(summary)}</span>`}`);
        result.tests = summary;
        if (state.pending[id]) state.pending[id].tests = { ok: tr.every((t) => t.ok), summary };
      }
    } else if (!opts.runtimeError) {
      appendLog(` <span class="err">오류: ${esc(err)}</span>\n🔁 오류 내용을 알려 주고 자동으로 한 번 더 고칩니다…\n`);
      return generateRegion(id, request, projectRequest, { ...opts, runtimeError: err, fromPending: result.pending });
    } else {
      appendLog(` <span class="err">오류가 남아 있습니다: ${esc(err)}</span>`);
      result.runtimeError = err;
      if (state.pending[id]) state.pending[id].checked = err;
    }
    renderInspector();
  }
  return result;
}

// 숨은 iframe 으로 미리보기를 열어 2.5초 동안 이 영역에서 난 스크립트 오류를 모은다
function runtimeCheck(id, candidate) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px;opacity:0;pointer-events:none;z-index:-1;border:0';
    let error = '';
    const onMsg = (ev) => {
      if (ev.source === frame.contentWindow && ev.data?.type === 'preview-error' && [].concat(id).includes(ev.data.region) && !error) error = Array.isArray(id) ? `${ev.data.region}: ${ev.data.message}` : ev.data.message;
    };
    window.addEventListener('message', onMsg);
    const done = () => {
      window.removeEventListener('message', onMsg);
      frame.remove();
      resolve(error);
    };
    frame.addEventListener('load', () => setTimeout(done, 2500), { once: true });
    setTimeout(done, 10000); // 로드가 안 끝나도 멈추지 않게
    previewUrl(`/preview?check=1${candidate ? `&candidate=${encodeURIComponent(id)}` : ''}&t=${Date.now()}`).then((u) => {
      frame.src = u;
      document.body.append(frame);
    });
  });
}

// ───────────── 변경 검토 (AI 결과를 적용하기 전에 비교) ─────────────
// 줄 단위 비교 (LCS). 결과: [{ op: ' ' | '+' | '-', text }]
function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ op: '-', text: t })), ...y.map((t) => ({ op: '+', text: t }))];
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ op: ' ', text: x[i++], j: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}

// 바뀐 줄 주변 2줄만 보여 주고 나머지 같은 줄은 접는다
function diffHtml(a, b) {
  const d = lineDiff(a, b);
  const keep = d.map((l, k) => l.op !== ' ' || d.slice(Math.max(0, k - 2), k + 3).some((z) => z.op !== ' '));
  let out = '';
  let skipped = 0;
  d.forEach((l, k) => {
    if (!keep[k]) return skipped++;
    if (skipped) out += `<div class="d-skip">… 같은 줄 ${skipped}개 …</div>`;
    skipped = 0;
    out += `<div class="d-line d-${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx'}"><span class="d-op">${l.op}</span>${esc(l.text) || ' '}</div>`;
  });
  if (skipped) out += `<div class="d-skip">… 같은 줄 ${skipped}개 …</div>`;
  const added = d.filter((l) => l.op === '+').length;
  const removed = d.filter((l) => l.op === '-').length;
  return { html: out || '<div class="d-skip">변경 없음</div>', added, removed };
}

function reviewHtml(id) {
  const p = state.pending[id];
  const names = { html: 'view.html', css: 'style.css', js: 'script.js' };
  const parts = ['html', 'css', 'js']
    .filter((k) => p.files[k] !== p.current[k])
    .map((k) => {
      const d = diffHtml(p.current[k] || '', p.files[k] || '');
      return `<details class="diff" open><summary><b>${names[k]}</b> <span class="d-add-c">+${d.added}</span> <span class="d-del-c">−${d.removed}</span></summary><div class="d-body">${d.html}</div></details>`;
    })
    .join('');
  const check = p.checked === 'ok' ? '<span class="ok">실행 검사 통과</span>' : p.checked ? `<span class="err">실행 검사 오류: ${esc(p.checked)}</span>` : '<span class="muted">실행 검사 중…</span>';
  const tests = p.tests ? ` · ${p.tests.ok ? `<span class="ok">🧪 ${esc(p.tests.summary)}</span>` : `<span class="err">🧪 ${esc(p.tests.summary)}</span>`}` : '';
  return `<div class="review">
      <div class="review-head"><b>🔍 변경 검토</b> <span class="muted">아직 저장되지 않았습니다</span> · ${check}${tests}</div>
      ${parts || '<p class="muted">바뀐 파일이 없습니다.</p>'}
      <div class="actions">
        <button class="btn primary" id="btnApplyPending">✅ 적용</button>
        <button class="btn ghost" id="btnPreviewPending" title="저장하지 않고 이 결과로 미리보기">👁 결과 미리보기</button>
        <button class="btn ghost danger" id="btnDiscardPending">✖ 버리기</button>
      </div>
    </div>`;
}

async function applyPending(id) {
  try {
    const { files } = await api('POST', `/api/regions/${id}/pending/apply`);
    state.files[id] = files;
    delete state.pending[id];
    await loadRegion(id, true);
    toast('적용했습니다 (이전 버전은 "기록" 탭에)');
    reloadPreview();
    renderAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function discardPending(id) {
  await api('POST', `/api/regions/${id}/pending/discard`).catch(() => {});
  delete state.pending[id];
  toast('변경을 버렸습니다');
  reloadPreview();
  renderAll();
}

async function copyPrompt(id) {
  try {
    const { text } = await api('POST', `/api/regions/${id}/prompt`, { request: draft(id, 'prompt') });
    await navigator.clipboard.writeText(text);
    toast('전체 프롬프트를 복사했습니다');
  } catch (e) {
    toast(e.message, true);
  }
}

// ───────────── 미리보기 ─────────────
const preview = $('#preview');
let previewTimer;
function reloadPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    $('#previewError').textContent = '';
    const v = $('#stage').dataset.view;
    if (v === 'split' || v === 'preview') {
      const sid = state.activeScreenId ? `&screen=${encodeURIComponent(state.activeScreenId)}` : '';
      const url = await previewUrl(`/preview?t=${Date.now()}${sid}`, true);
      preview.src = url;
      const link = $('#previewNewTab');
      if (link) link.href = window.__WEB_STANDALONE__ ? url : `${PREVIEW_BASE}/preview${state.activeScreenId ? `?screen=${encodeURIComponent(state.activeScreenId)}` : ''}`;
    }
  }, 150);
}
function setInspectMode(on) {
  state.inspectOn = Boolean(on);
  $('#btnInspect')?.classList.toggle('active-toggle', state.inspectOn);
  $('#btnInspect')?.classList.toggle('on', state.inspectOn);
  preview.contentWindow?.postMessage({ type: 'toggle-inspect', on: state.inspectOn }, '*');
}
$('#btnInspect')?.addEventListener('click', () => {
  const v = $('#stage').dataset.view;
  if (v === 'design' || v === 'prompt') setView('split');
  setInspectMode(!state.inspectOn);
  if (state.inspectOn) toast('미리보기에서 수정할 요소를 클릭하세요 (Esc 종료)');
});
preview.addEventListener('load', () => {
  previewLoaded = true;
  preview.contentWindow?.postMessage({ type: 'toggle-regions', on: $('#showBounds').checked }, '*');
  if (state.activeScreenId) preview.contentWindow?.postMessage({ type: 'switch-screen', screen: state.activeScreenId }, '*');
  if (state.inspectOn) preview.contentWindow?.postMessage({ type: 'toggle-inspect', on: true }, '*');
});
$('#showBounds').addEventListener('change', (ev) => {
  preview.contentWindow?.postMessage({ type: 'toggle-regions', on: ev.target.checked }, '*');
});
window.addEventListener('message', async (ev) => {
  if (ev.data?.type === 'preview-error') {
    const where = ev.data.region ? `[${region(ev.data.region)?.title || ev.data.region}] ` : '';
    $('#previewError').textContent = `⚠ ${where}${ev.data.message}`;
    clientLog('preview-error', { region: ev.data.region, message: ev.data.message, line: ev.data.line });
  } else if (ev.data?.type === 'inspect-pick' && ev.data.info?.region) {
    state.inspected = ev.data.info;
    setInspectMode(false);
    const info = ev.data.info;
    if (!document.body.classList.contains('pro-mode')) {
      renderPreviewTarget();
      select(info.region);
      $('#previewPromptInput')?.focus();
      pushLiveActivity('info', `🎯 요소 선택됨: ${region(info.region)?.title || info.region} · ${info.selector}`);
      toast(`🎯 ${info.selector} 선택됨 — 아래 프롬프트에 수정 내용을 적거나 📋 에이전트용 복사를 누르세요`);
    } else {
      await select(info.region, 'prompt');
      setTimeout(() => $('#inspectPrompt')?.focus(), 50);
      toast(`🎯 ${info.selector} 선택됨 — 바로 수정 요청하거나 스타일을 조정하세요`);
    }
  } else if (ev.data?.type === 'inspect-cancel') {
    setInspectMode(false);
  }
});
$('#btnReload').addEventListener('click', () => reloadPreview());

$('#viewSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  setView(b.dataset.view);
});
function setView(view) {
  const v = ['prompt', 'design', 'split', 'preview'].includes(view) ? view : 'prompt';
  $('#stage').dataset.view = v;
  const ws = $('#workspace');
  if (ws) ws.dataset.mode = v;
  document.querySelectorAll('#viewSeg button').forEach((x) => x.classList.toggle('on', x.dataset.view === v));
  try { localStorage.setItem('ide-view', v); } catch {}
  reloadPreview();
  if (v === 'design') fitCanvas();
}
$('#btnCollapseLayout')?.addEventListener('click', () => setView('prompt'));
$('#toolsMenu')?.addEventListener('click', (ev) => {
  if (ev.target.closest('.tools-pop button')) $('#toolsMenu').open = false;
});
document.addEventListener('click', (ev) => {
  const m = $('#toolsMenu');
  if (m?.open && !m.contains(ev.target)) m.open = false;
});

// ───────────── 상단 바 ─────────────
// 열·행·간격은 지금 보고 있는 레벨(앱 또는 안쪽 레이아웃)의 그리드에 적용된다
function renderTopbar() {
  const { grid } = cur();
  $('#appName').value = state.layout.name;
  $('#gridCols').value = grid.cols;
  $('#gridRows').value = grid.rows;
  $('#gridGap').value = grid.gap ?? 8;
  $('#gridFill').checked = bpActive() ? Boolean(cur().grid.fill) : state.layout.grid.fill;
  $('#gridFill').parentElement.hidden = !atRoot();
  const denseBtn = $('#btnDenseGrid');
  if (denseBtn) {
    const isDense = grid.cols >= 24;
    denseBtn.textContent = isDense ? '▦ 24×24 사용 중 (12×12로)' : '▦ 24×24 촘촘하게';
    denseBtn.classList.toggle('primary', isDense);
    denseBtn.classList.toggle('ghost', !isDense);
  }
  const flow = state.layout.mode === 'flow';
  $('#flowBadge').hidden = !flow;
  $('#gridCtrl').hidden = flow && atRoot();
}

$('#appName').addEventListener('input', (ev) => {
  state.layout.name = ev.target.value;
  saveLayout();
});

for (const [sel, key] of [['#gridCols', 'cols'], ['#gridRows', 'rows'], ['#gridGap', 'gap']]) {
  $(sel).addEventListener('change', (ev) => {
    const v = Math.max(key === 'gap' ? 0 : 1, Number(ev.target.value) || 0);
    const c = cur();
    const next = { ...c.grid, [key]: v };
    const outside = c.regions.filter((r) => r.x + r.w > next.cols || r.y + r.h > next.rows);
    if (outside.length) {
      toast(`그리드 밖으로 나가는 영역이 있습니다: ${outside.map((r) => r.title || r.id).join(', ')}`, true);
      return renderTopbar();
    }
    c.grid = next;
    saveLayout();
    renderAll();
    fitCanvas();
  });
}
$('#gridFill').addEventListener('change', (ev) => {
  if (bpActive()) cur().grid.fill = ev.target.checked;
  else state.layout.grid.fill = ev.target.checked;
  saveLayout();
  fitCanvas();
});


// ───────────── 접근성·성능 점검 ─────────────
// 숨은 미리보기(같은 출처라 문서를 직접 읽을 수 있음)를 열어 규칙별로 검사한다
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const parseColor = (c) => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return { rgb: [r, g, b], a };
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// AI 에게 보낼 "지금 화면에서 잰 이 영역" (그림 대신 글: 몇십 토큰)
// 숨은 미리보기를 열어 칸 크기·내용 크기·넘침·sticky/fixed·칸 밖으로 나간 요소·실행 오류를 잰다
async function measureRegion(id) {
  const frame = document.createElement('iframe');
  const W = DEVICES[state.device]?.frame || 1280;
  frame.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:900px;opacity:0;pointer-events:none;z-index:-1;border:0`;
  const errors = [];
  const onMsg = (ev) => {
    if (ev.source === frame.contentWindow && ev.data?.type === 'preview-error' && ev.data.region === id) errors.push(ev.data.message);
  };
  window.addEventListener('message', onMsg);
  try {
    await Promise.race([
      new Promise(async (r) => {
        frame.addEventListener('load', r, { once: true });
        frame.src = await previewUrl(`/preview?check=1&t=${Date.now()}`);
        document.body.append(frame);
      }),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    const d = frame.contentDocument;
    const w = frame.contentWindow;
    const s = d?.querySelector(`section[data-region="${CSS.escape(id)}"]`);
    if (!s) return { text: '' };
    const px = (n) => `${Math.round(n)}px`;
    const sel = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '');
    let cell = null;
    const lines = [`- 미리보기 화면 너비 ${W}px (${DEVICES[state.device]?.title || '데스크톱'})`];
    if (w.getComputedStyle(s).display === 'contents') {
      lines.push('- 이 영역은 칸 없이 문서 흐름으로 표시됩니다');
    } else {
      const r = s.getBoundingClientRect();
      cell = { w: Math.round(r.width), h: Math.round(r.height) };
      lines.push(`- 칸 크기: ${px(r.width)} × ${px(r.height)}`);
      const overY = s.scrollHeight - s.clientHeight;
      const overX = s.scrollWidth - s.clientWidth;
      lines.push(`- 내용 크기: ${px(s.scrollWidth)} × ${px(s.scrollHeight)}${overY > 8 ? ` → 세로로 ${px(overY)} 넘쳐 칸 안에서 스크롤됨` : ''}${overX > 8 ? ` → 가로로 ${px(overX)} 넘침` : ''}${overY <= 8 && overX <= 8 ? ' (칸 안에 맞음)' : ''}`);
      const outside = [];
      const pinned = [];
      for (const el of s.querySelectorAll('*')) {
        if (el.closest('dialog')) continue;
        const cs = w.getComputedStyle(el);
        if ((cs.position === 'sticky' || cs.position === 'fixed') && pinned.length < 3) pinned.push(`${sel(el)} (position:${cs.position}${cs.position === 'sticky' ? `; top:${cs.top}` : ''})`);
        const e = el.getBoundingClientRect();
        if (e.width && outside.length < 3 && (e.right > r.right + 4 || e.left < r.left - 4)) outside.push(`${sel(el)} 너비 ${px(e.width)}`);
      }
      if (pinned.length) lines.push(`- 칸 안의 sticky/fixed 요소: ${pinned.join(', ')}`);
      if (outside.length) lines.push(`- 칸 가로 밖으로 나간 요소: ${outside.join(', ')}`);
      const first = s.firstElementChild;
      if (first) {
        // 제목의 기본 margin 같은 자기 바깥 여백은 빼고 본다
        const gap = first.getBoundingClientRect().top - (r.top + parseFloat(w.getComputedStyle(s).paddingTop)) - Math.max(0, parseFloat(w.getComputedStyle(first).marginTop) || 0);
        if (gap > 12) lines.push(`- 첫 요소(${sel(first)})가 칸 위에서 ${px(gap)} 떨어져 있음`);
      }
      const hidden = [...s.children].filter((c) => c.checkVisibility && !c.checkVisibility()).length;
      if (hidden) lines.push(`- 지금 숨겨진 최상위 요소 ${hidden}개`);
    }
    if (errors.length) lines.push(`- 실행 오류: ${errors.slice(0, 2).join(' / ')}`);
    return { text: lines.join('\n'), cell };
  } catch {
    return { text: '' };
  } finally {
    window.removeEventListener('message', onMsg);
    frame.remove();
  }
}

async function qualityCheck() {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:900px;opacity:0;pointer-events:none;z-index:-1;border:0';
  const started = performance.now();
  await new Promise(async (r) => {
    frame.addEventListener('load', r, { once: true });
    frame.src = await previewUrl(`/preview?check=1&t=${Date.now()}`);
    document.body.append(frame);
  });
  const loadMs = Math.round(performance.now() - started);
  await new Promise((r) => setTimeout(r, 1200)); // 앱 스크립트가 화면을 그릴 시간
  const d = frame.contentDocument;
  const w = frame.contentWindow;
  const issues = [];
  const where = (el) => el.closest?.('section[data-region]')?.dataset.region || '';
  const snip = (el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 140);
  const add = (level, rule, el, extra = '') => issues.push({ level, rule, region: el ? where(el) : '', snippet: el ? snip(el) : '', extra });
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ') || el.value || '').trim();

  if (!d.documentElement.lang) add('error', '문서 언어(lang) 없음', null, '<html lang="ko"> 를 넣으면 화면 낭독기가 한국어로 읽습니다');
  for (const img of d.querySelectorAll('img:not([alt])')) add('error', '이미지 대체 텍스트(alt) 없음', img);
  for (const el of d.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea')) {
    if (el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) continue;
    add(el.placeholder ? 'warn' : 'error', el.placeholder ? '입력칸 이름표 없음 (placeholder 만 있음)' : '입력칸 이름표 없음', el);
  }
  for (const el of d.querySelectorAll('button, [role=button], a[href]')) {
    if (!nameOf(el)) add('error', el.tagName === 'A' ? '이름 없는 링크' : '이름 없는 버튼', el);
  }
  const ids = new Map();
  for (const el of d.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) add('error', '중복된 id', d.getElementById(id), `#${id} 가 ${n}개`);
  let prev = 0;
  for (const h of d.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const lv = Number(h.tagName[1]);
    if (prev && lv > prev + 1) add('warn', '제목 단계 건너뜀', h, `h${prev} 다음에 h${lv}`);
    prev = lv;
  }
  // 글자 대비 (보이는 글자만, 같은 색 조합은 한 번만)
  const seen = new Set();
  let checked = 0;
  for (const el of d.body.querySelectorAll('*')) {
    if (checked > 2000) break;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
    checked++;
    const cs = w.getComputedStyle(el);
    const fg = parseColor(cs.color);
    let bg = null;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const c = parseColor(w.getComputedStyle(p).backgroundColor);
      if (c && c.a > 0.5) {
        bg = c;
        break;
      }
      if (w.getComputedStyle(p).backgroundImage !== 'none') break; // 배경 그림 위 글자는 판단하지 않는다
    }
    if (!fg || !bg) continue;
    const ratio = contrast(fg.rgb, bg.rgb);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const key = `${cs.color}|${bg.rgb}|${large}`;
    if (ratio < need && !seen.has(key)) {
      seen.add(key);
      add('warn', '글자 대비 부족', el, `${ratio.toFixed(2)} : 1 (기준 ${need} : 1) — ${cs.color} / rgb(${bg.rgb.join(', ')})`);
    }
  }

  // 칸(프레임) 맞춤: 그리드 칸에 놓인 영역의 내용이 칸보다 크거나, 칸 안에 sticky/fixed 요소가 남아 위치가 어긋나는지
  for (const s of d.querySelectorAll('#app section[data-region]')) {
    if (w.getComputedStyle(s).display === 'contents') continue;
    const id = s.dataset.region;
    const over = s.scrollHeight - s.clientHeight;
    if (over > 8) {
      issues.push({ level: 'warn', rule: '영역 내용이 칸보다 큼', region: id, snippet: '', extra: `내용 ${s.scrollHeight}px > 칸 ${s.clientHeight}px — 칸을 키우거나 내용을 줄이세요 (지금은 칸 안에서 스크롤됨)` });
    }
    if (s.scrollWidth - s.clientWidth > 8) {
      issues.push({ level: 'warn', rule: '영역 내용이 칸보다 넓음', region: id, snippet: '', extra: `내용 ${s.scrollWidth}px > 칸 ${s.clientWidth}px` });
    }
    for (const el of s.querySelectorAll('*')) {
      const pos = w.getComputedStyle(el).position;
      if (pos === 'sticky' || pos === 'fixed') {
        if (el.closest('dialog')) continue;
        add('warn', '칸 안의 sticky/fixed 위치', el, `position:${pos}${pos === 'sticky' ? ` top:${w.getComputedStyle(el).top}` : ''} — 원래 한 페이지용 규칙이면 칸 안에서 위치가 어긋납니다`);
        break;
      }
    }
    // 첫 요소가 칸 위쪽(안쪽 여백 제외)에서 떨어져 있으면 위치가 어긋난 것 (sticky top, 바깥 margin 등)
    const sr = s.getBoundingClientRect();
    const scs = w.getComputedStyle(s);
    const first = s.firstElementChild;
    if (first && w.getComputedStyle(first).position !== 'absolute') {
      const gap = first.getBoundingClientRect().top - (sr.top + parseFloat(scs.paddingTop) + parseFloat(scs.borderTopWidth));
      if (gap > 12) add('warn', '영역 내용이 칸 위쪽에서 떨어져 있음', first, `칸 위에서 ${Math.round(gap)}px 아래에 놓임 — 전역 CSS 의 top·margin 이 남아 있는지 확인`);
    }
  }

  // 성능
  const res = w.performance.getEntriesByType('resource').map((e) => ({ name: e.name, bytes: e.encodedBodySize || e.transferSize || 0, ms: Math.round(e.duration) }));
  const htmlBytes = new Blob([d.documentElement.outerHTML]).size;
  const nav = w.performance.getEntriesByType('navigation')[0];
  const perf = {
    loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration) : loadMs,
    htmlBytes,
    resources: res.length,
    resourceBytes: res.reduce((s, r) => s + r.bytes, 0),
    heaviest: res.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    domNodes: d.getElementsByTagName('*').length,
    regionJs: allRegions().map((r) => ({ id: r.id, bytes: (state.files[r.id]?.js || '').length })).filter((x) => x.bytes).sort((a, b) => b.bytes - a.bytes).slice(0, 5),
  };
  if (perf.domNodes > 3000) issues.push({ level: 'warn', rule: '요소가 너무 많음', region: '', snippet: '', extra: `DOM 요소 ${perf.domNodes}개 (1500개 이하 권장)` });
  if (htmlBytes + perf.resourceBytes > 3 * 1024 * 1024) issues.push({ level: 'warn', rule: '페이지가 무거움', region: '', snippet: '', extra: `${((htmlBytes + perf.resourceBytes) / 1048576).toFixed(1)}MB` });
  frame.remove();
  return { issues, perf, contrastChecked: checked };
}

$('#btnQuality').addEventListener('click', async () => {
  const pending = dialog('♿ 접근성·성능 점검', `<div id="qBody"><p class="muted">미리보기를 열어 점검하는 중…</p></div>`, '닫기');
  $('#dlg').classList.add('wide');
  try {
    const q = await qualityCheck();
    clientLog('quality-check', { errors: q.issues.filter((i) => i.level === 'error').length, warns: q.issues.filter((i) => i.level === 'warn').length });
    const groups = {};
    for (const i of q.issues) (groups[i.rule] ||= []).push(i);
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
    $('#qBody').innerHTML = `
      <div class="usage-total">
        <div><b class="${q.issues.some((i) => i.level === 'error') ? 'err' : 'ok'}">${q.issues.filter((i) => i.level === 'error').length}</b><span>꼭 고칠 것</span></div>
        <div><b>${q.issues.filter((i) => i.level === 'warn').length}</b><span>권장</span></div>
        <div><b>${(q.perf.loadMs / 1000).toFixed(1)}초</b><span>로딩</span></div>
        <div><b>${kb(q.perf.htmlBytes + q.perf.resourceBytes)}</b><span>페이지 무게</span></div>
        <div><b>${q.perf.domNodes.toLocaleString()}</b><span>DOM 요소</span></div>
      </div>
      ${Object.entries(groups).map(([rule, list]) => `<details class="q-group ${list[0].level}" ${list[0].level === 'error' ? 'open' : ''}>
          <summary>${list[0].level === 'error' ? '❌' : '⚠'} <b>${esc(rule)}</b> <span class="muted">${list.length}건</span></summary>
          ${list.slice(0, 40).map((i) => `<div class="q-item">${i.region ? chip(i.region) : ''}<span class="mono">${esc(i.snippet)}</span>${i.extra ? `<span class="muted">${esc(i.extra)}</span>` : ''}</div>`).join('')}
          ${list.length > 40 ? `<div class="muted small-note">… 외 ${list.length - 40}건</div>` : ''}
        </details>`).join('') || '<p class="ok">✓ 발견된 문제가 없습니다</p>'}
      <h4>무거운 파일</h4>${q.perf.heaviest.map((r) => `<div class="q-item"><span class="mono">${esc(r.name.split('/').slice(-2).join('/'))}</span><span class="muted">${kb(r.bytes)} · ${r.ms}ms</span></div>`).join('') || '<p class="muted">외부 파일 없음</p>'}
      <p class="muted small-note">글자 대비는 보이는 글자 ${q.contrastChecked}곳을 검사했습니다 (닫힌 대화상자 안은 제외). 고칠 때는 해당 영역을 선택해 프롬프트로 "이름표를 달아 줘", "대비를 높여 줘"처럼 요청하면 됩니다.</p>`;
  } catch (e) {
    $('#qBody').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
  await pending;
  $('#dlg').classList.remove('wide');
});

// ───────────── 동작 테스트 ─────────────
const TEST_ACTIONS = {
  navigate: '화면 이동',
  click: '클릭',
  type: '입력',
  wait: '기다리기(ms)',
  expectText: '글자 포함 확인',
  expectValue: '값 확인',
  expectVisible: '보이는지 확인',
  expectCount: '개수 확인',
};

// 숨은 미리보기에서 테스트 하나 실행 (candidate: 검토 중인 AI 결과로 실행할 영역 ID)
function runTest(index, candidate) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px;opacity:0;pointer-events:none;z-index:-1;border:0';
    let timer;
    const onMsg = (ev) => {
      if (ev.source !== frame.contentWindow || ev.data?.type !== 'test-result' || ev.data.index !== index) return;
      finish({ results: ev.data.results, errors: ev.data.errors });
    };
    const finish = (r) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      frame.remove();
      const ok = r.results.length > 0 && r.results.every((x) => x.ok) && !r.errors?.length;
      resolve({ ...r, ok });
    };
    window.addEventListener('message', onMsg);
    timer = setTimeout(() => finish({ results: [{ ok: false, msg: '시간 초과 (20초)' }], errors: [] }), 20000);
    previewUrl(`/preview?test=${index}${candidate ? `&candidate=${encodeURIComponent(candidate)}` : ''}&t=${Date.now()}`).then((u) => {
      frame.src = u;
      document.body.append(frame);
    });
  });
}

async function runAllTests(candidate) {
  const { tests } = await api('GET', '/api/tests');
  const out = [];
  for (const [i, t] of tests.entries()) if (t.steps.length) out.push({ name: t.name, index: i, ...(await runTest(i, candidate)) });
  return out;
}

const testSummary = (rs) => {
  const failed = rs.filter((r) => !r.ok);
  return failed.length
    ? `테스트 ${rs.length}개 중 ${failed.length}개 실패: ${failed.map((f) => `${f.name} — ${(f.results.find((x) => !x.ok)?.msg || f.errors[0] || '')}`).join(' / ')}`
    : `테스트 ${rs.length}개 모두 통과`;
};

$('#btnTests').addEventListener('click', async () => {
  let { tests } = await api('GET', '/api/tests');
  const results = {};
  let saveT;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => (tests = (await api('PUT', '/api/tests', { tests })).tests), 400);
  };
  const pending = dialog('🧪 동작 테스트', `<div id="testBody"></div>`, '닫기');
  $('#dlg').classList.add('wide');
  const draw = () => {
    $('#testBody').innerHTML = `
      <p class="muted small-note">시나리오를 저장해 두면 미리보기에서 자동으로 확인합니다. 선택자는 CSS 선택자(#id, .class, button 등)입니다.
        AI 가 영역 코드를 바꿀 때마다 자동으로 실행되어 결과가 영역 로그(와 변경 검토)에 표시됩니다.</p>
      <div class="actions"><button type="button" class="btn small" id="tAdd">+ 테스트 추가</button><button type="button" class="btn small" id="tAuto" title="AI 없이 현재 HTML 요소로 기본 렌더링·표시 테스트를 즉시 생성합니다">⚡ 기본 테스트 자동 추가</button><button type="button" class="btn small" id="tAiGen" title="AI 가 앱 코드를 분석해 클릭·입력 시나리오 테스트를 생성합니다">🤖 AI로 테스트 생성</button><button type="button" class="btn primary small" id="tRunAll" ${tests.length ? '' : 'disabled'}>▶ 모두 실행</button></div>
      ${tests.map((t, i) => `<div class="test-card ${results[i] ? (results[i].ok ? 'pass' : 'fail') : ''}">
          <div class="test-head"><input data-t="${i}" data-f="name" value="${esc(t.name)}"><span class="spacer"></span>
            <button type="button" class="btn small" data-run="${i}">▶ 실행</button><button type="button" class="btn small ghost danger" data-del="${i}">✕</button></div>
          ${t.steps.map((s, k) => `<div class="test-step">
              <select data-t="${i}" data-s="${k}" data-f="action">${Object.entries(TEST_ACTIONS).map(([a, l]) => `<option value="${a}" ${a === s.action ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <input class="mono" data-t="${i}" data-s="${k}" data-f="selector" value="${esc(s.selector)}" placeholder="${s.action === 'wait' || s.action === 'navigate' ? '(필요 없음)' : '#id 또는 .class'}">
              <input data-t="${i}" data-s="${k}" data-f="value" value="${esc(s.value)}" placeholder="${{ navigate: '화면 ID', type: '입력할 글자', expectText: '포함돼야 할 글자', expectValue: '값', expectCount: '개수', wait: '300' }[s.action] || ''}">
              <span class="step-res">${results[i]?.results[k] ? (results[i].results[k].ok ? `<span class="ok">✓ ${esc(results[i].results[k].msg)}</span>` : `<span class="err">✗ ${esc(results[i].results[k].msg)}</span>`) : ''}</span>
              <button type="button" class="btn small ghost" data-sdel="${i}:${k}">✕</button>
            </div>`).join('')}
          <button type="button" class="btn small ghost" data-sadd="${i}">+ 단계</button>
          ${results[i]?.errors?.length ? `<div class="err small-note">스크립트 오류: ${esc(results[i].errors.join(' / '))}</div>` : ''}
        </div>`).join('') || '<p class="muted">아직 테스트가 없습니다.</p>'}`;
  };
  $('#testBody').addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.t === undefined) return;
    const t = tests[Number(el.dataset.t)];
    if (el.dataset.s === undefined) t[el.dataset.f] = el.value;
    else t.steps[Number(el.dataset.s)][el.dataset.f] = el.value;
    save();
  });
  $('#testBody').addEventListener('change', (ev) => {
    if (ev.target.dataset.f === 'action') draw();
  });
  $('#testBody').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'tAdd') tests.push({ name: `테스트 ${tests.length + 1}`, steps: [{ action: 'click', selector: '', value: '' }, { action: 'expectText', selector: '', value: '' }] });
    else if (b.id === 'tAuto') {
      b.disabled = true;
      b.textContent = '생성 중…';
      try {
        clearTimeout(saveT);
        await api('PUT', '/api/tests', { tests });
        const r = await api('POST', '/api/tests/auto', { append: true });
        tests = r.tests;
        toast(`기본 스모크 테스트 ${r.added}개를 추가했습니다`);
      } catch (e) {
        toast(e.message, true);
      }
      return draw();
    } else if (b.id === 'tAiGen') {
      b.disabled = true;
      b.textContent = 'AI 생성 중…';
      try {
        const r = await api('POST', '/api/tests/generate');
        tests = r.tests;
        for (const k of Object.keys(results)) delete results[k];
        toast(`AI 가 시나리오 테스트 ${tests.length}개를 생성했습니다`);
      } catch (e) {
        toast(e.message, true);
      }
      return draw();
    } else if (b.dataset.del) {
      tests.splice(Number(b.dataset.del), 1);
      for (const k of Object.keys(results)) delete results[k];
    } else if (b.dataset.sadd) tests[Number(b.dataset.sadd)].steps.push({ action: 'click', selector: '', value: '' });
    else if (b.dataset.sdel) {
      const [i, k] = b.dataset.sdel.split(':').map(Number);
      tests[i].steps.splice(k, 1);
    } else if (b.dataset.run !== undefined || b.id === 'tRunAll') {
      clearTimeout(saveT);
      tests = (await api('PUT', '/api/tests', { tests })).tests;
      const which = b.id === 'tRunAll' ? tests.map((_, i) => i) : [Number(b.dataset.run)];
      b.disabled = true;
      b.textContent = '실행 중…';
      for (const i of which) results[i] = await runTest(i);
      return draw();
    } else return;
    save();
    draw();
  });
  draw();
  await pending;
  clearTimeout(saveT);
  await api('PUT', '/api/tests', { tests }).catch(() => {});
  $('#dlg').classList.remove('wide');
});

// ───────────── 앱 통합 검증 (문법 · 연결 · 실제 브라우저 런타임 · 시나리오 테스트) ─────────────
async function openVerifyDialog() {
  const pending = dialog('✅ 앱 통합 검증', `<div id="verifyBody"><p class="muted">문법·영역 연결·실제 브라우저 런타임 및 시나리오 테스트를 실행하는 중…</p></div>`, '닫기');
  $('#dlg').classList.add('wide');
  let latestReport = null;

  const runVerify = async () => {
    const box = $('#verifyBody');
    if (!box) return;
    box.innerHTML = `<p class="muted">🔍 문법·영역 연결·실제 브라우저 런타임 및 시나리오 테스트를 실행하는 중…</p>`;
    try {
      latestReport = await api('POST', '/api/verify', { runBrowser: true });
      if ($('#verifyBody')) $('#verifyBody').innerHTML = renderVerifyReport(latestReport, esc, chip);
    } catch (e) {
      if ($('#verifyBody')) $('#verifyBody').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  };

  $('#verifyBody').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'btnVerifyRerun') {
      await runVerify();
    } else if (b.id === 'btnVerifyAutoTests') {
      b.disabled = true;
      b.textContent = '생성 중…';
      try {
        const r = await api('POST', '/api/tests/auto', { append: true });
        toast(`기본 테스트 ${r.added}개를 추가하고 다시 검증합니다`);
        await runVerify();
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    } else if (b.id === 'btnVerifyAiTests') {
      b.disabled = true;
      b.textContent = 'AI 생성 중…';
      try {
        const r = await api('POST', '/api/tests/generate');
        toast(`AI 시나리오 테스트 ${r.tests.length}개를 생성하고 다시 검증합니다`);
        await runVerify();
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
        b.textContent = '🤖 AI 테스트 생성';
      }
    } else if (b.id === 'btnVerifyFix' && latestReport) {
      $('#dlg').close();
      state.selected = null;
      state.multi.clear();
      if (!proj.loaded) await loadProject();
      proj.tab = 'request';
      proj.request = buildVerifyFixPrompt(latestReport);
      saveProjectDraft();
      renderAll();
      toast('발견된 문제 목록을 프로젝트 요청에 채웠습니다. "🧭 계획 세우기"를 눌러 한 번에 수정하세요');
    }
  });

  runVerify();
  await pending;
  $('#dlg').classList.remove('wide');
}

$('#btnVerify')?.addEventListener('click', () => {
  switchSessionMode('verify');
  runVerifySession();
});

// ───────────── 분석: 연결 지도 / app.js 나누기 ─────────────
const regionName = (id) => (id === 'app.js' ? '전역 app.js' : region(id)?.title || id);
const chip = (id) => `<span class="chip" style="--c:${region(id)?.color || '#888'}">${esc(regionName(id))}</span>`;

$('#btnAnalysis').addEventListener('click', async () => {
  const view = { tab: 'map', filter: 'ok', pick: new Set() };
  const pending = dialog('🔗 분석', `<div class="shared-tabs"><button type="button" class="btn small" data-an="map">연결 지도</button><button type="button" class="btn small" data-an="appjs">app.js 나누기</button></div><div id="anBody"></div>`, '닫기');
  $('#dlg').classList.add('wide');

  const drawMap = async () => {
    const c = await api('GET', '/api/analysis/connections');
    const row = (x, kind) => `<div class="conn-row ${!x.from.length || !x.to.length ? 'broken' : ''}">
        <span class="conn-side">${x.from.map(chip).join('') || '<span class="err">(보내는 곳 없음)</span>'}</span>
        <span class="conn-name mono">${kind === 'state' ? '⟨상태⟩ ' : ''}${esc(x.name)} →</span>
        <span class="conn-side">${x.to.map(chip).join('') || '<span class="muted">(받는 곳 없음)</span>'}</span>
      </div>`;
    $('#anBody').innerHTML = `
      <p class="muted small-note">영역 script.js 의 <span class="mono">app.emit / app.on / app.set / app.get</span> 을 찾아 누가 보내고 누가 받는지 보여 줍니다. 이름이 어긋나면 기능이 조용히 동작하지 않습니다.</p>
      ${c.issues.length ? `<div class="issues">${c.issues.map((i) => `<div class="issue ${i.level}">${i.level === 'error' ? '❌' : '⚠'} ${esc(i.text)}${i.similar.length ? ` <span class="muted">— 혹시: ${i.similar.map((s) => `<b class="mono">${esc(s)}</b>`).join(', ')}</span>` : ''}</div>`).join('')}</div>` : '<p class="ok">✓ 어긋난 연결이 없습니다</p>'}
      <h4>이벤트</h4>${c.events.map((e) => row(e, 'event')).join('') || '<p class="muted">없음</p>'}
      <h4>공유 상태</h4>${c.states.map((s) => row(s, 'state')).join('') || '<p class="muted">없음</p>'}`;
  };

  const drawAppJs = async () => {
    const a = await api('GET', '/api/analysis/appjs');
    if (a.empty) {
      $('#anBody').innerHTML = '<p class="muted">이 프로젝트에는 전역 app.js 가 없습니다 (가져온 앱에서 쓰는 기능).</p>';
      return;
    }
    const fns = a.functions;
    const ok = fns.filter((f) => f.status.ok);
    const list = view.filter === 'ok' ? ok : fns;
    $('#anBody').innerHTML = `
      <p class="muted small-note">app.js (${Math.round(a.size / 1024)}KB) 의 최상위 함수 ${fns.length}개를 분석했습니다. 한 영역만 쓰고 앱 시작 때 실행되지 않는 함수는
        그 영역 script.js 로 옮길 수 있습니다. 전역 이름은 그대로라 onclick 과 다른 함수 호출은 계속 동작합니다. 옮기기 전에 스냅샷이 자동 저장됩니다.</p>
      <div class="place-ctrl">
        <label>보기 <select id="anFilter"><option value="ok" ${view.filter === 'ok' ? 'selected' : ''}>옮길 수 있는 것 (${ok.length})</option><option value="all" ${view.filter === 'all' ? 'selected' : ''}>전체 (${fns.length})</option></select></label>
        <span class="spacer"></span>
        <button type="button" class="btn small" id="anPickAll">옮길 수 있는 것 모두 선택</button>
        <button type="button" class="btn primary small" id="anMove" ${view.pick.size ? '' : 'disabled'}>선택한 ${view.pick.size}개 옮기기</button>
      </div>
      <div class="log-list">${list.map((f) => `<div class="log-row fn-row ${f.status.ok ? '' : 'muted-row'}">
          <input type="checkbox" data-fn="${esc(f.name)}" ${view.pick.has(f.name) ? 'checked' : ''} ${f.status.ok ? '' : 'disabled'}>
          <span class="mono"><b>${esc(f.name)}</b> <span class="muted">${f.lines}줄</span></span>
          <span>${f.regions.map(chip).join('') || '<span class="muted">-</span>'}</span>
          <span class="small-note ${f.status.ok ? 'ok' : 'muted'}">${f.status.ok ? `→ ${esc(regionName(f.target))}` : esc(f.status.why)}</span>
        </div>`).join('')}</div>`;
  };

  const draw = () => {
    document.querySelectorAll('[data-an]').forEach((b) => b.classList.toggle('on', b.dataset.an === view.tab));
    return (view.tab === 'map' ? drawMap() : drawAppJs()).catch((e) => ($('#anBody').innerHTML = `<p class="err">${esc(e.message)}</p>`));
  };
  $('#dlgContent').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (b?.dataset.an) {
      view.tab = b.dataset.an;
      return draw();
    }
    if (b?.id === 'anPickAll') {
      const a = await api('GET', '/api/analysis/appjs');
      a.functions.filter((f) => f.status.ok).forEach((f) => view.pick.add(f.name));
      return draw();
    }
    if (b?.id === 'anMove') {
      try {
        const res = await api('POST', '/api/analysis/appjs/move', { names: [...view.pick] });
        toast(`${res.moved}개 함수를 영역 ${res.regions.length}곳으로 옮겼습니다 (실행 전 스냅샷 저장됨)`);
        view.pick.clear();
        state.files = {};
        await Promise.all([...allRegions().map((r) => loadRegion(r.id)), refreshSessions()]);
        reloadPreview();
        renderAll();
        return draw();
      } catch (e) {
        return toast(e.message, true);
      }
    }
  });
  $('#dlgContent').addEventListener('change', (ev) => {
    if (ev.target.id === 'anFilter') {
      view.filter = ev.target.value;
      return draw();
    }
    if (ev.target.dataset.fn) {
      if (ev.target.checked) view.pick.add(ev.target.dataset.fn);
      else view.pick.delete(ev.target.dataset.fn);
      const mv = $('#anMove');
      mv.disabled = !view.pick.size;
      mv.textContent = `선택한 ${view.pick.size}개 옮기기`;
    }
  });
  await draw();
  await pending;
  $('#dlg').classList.remove('wide');
});

// 프로젝트 패널 열기 (선택을 풀면 인스펙터가 프로젝트 패널이 된다)
$('#btnAppPrompt').addEventListener('click', () => {
  state.multi.clear();
  state.selected = null;
  renderAll();
});

const SHARED_TABS = [
  { key: 'css', label: 'global.css', hint: '모든 영역에 스코프 없이 적용되는 스타일' },
  { key: 'js', label: 'app.js', hint: '영역 마크업 뒤에 실행되는 전역 스크립트 (가져온 앱의 기존 로직)' },
  { key: 'head', label: 'head.html', hint: '<head> 에 들어가는 CDN 라이브러리·폰트 링크' },
];

$('#btnShared').addEventListener('click', async () => {
  const texts = {};
  await Promise.all(SHARED_TABS.map(async (t) => (texts[t.key] = (await api('GET', `/api/shared/${t.key}`)).text)));
  const edited = { ...texts };
  let cur = 'css';
  const pending = dialog('공통 파일 (shared/)', `
    <div class="shared-tabs"><button type="button" class="btn small" data-shared="tokens">🎨 디자인 토큰</button>${SHARED_TABS.map((t) => `<button type="button" class="btn small" data-shared="${t.key}">${t.label}</button>`).join('')}</div>
    <p class="muted" id="sharedHint" style="margin:0"></p>
    <textarea id="sharedText" class="code" spellcheck="false"></textarea>
    <div id="tokenPane" class="token-pane" hidden></div>
    <div class="lint-status" id="sharedLint"></div>`);
  $('#dlg').classList.add('wide');
  $('#sharedText').value = edited.css;
  // 공통 파일도 코드 편집기로 (탭을 바꾸면 모드와 내용을 바꿔 끼운다)
  const langOf = { css: 'css', js: 'js', head: 'html' };
  const cm = mountCode($('#sharedText'), 'css', (v) => {
    edited[cur] = v;
    lintInto($('#sharedLint'), langOf[cur], v);
  });
  const codeEl = () => cm?.getWrapperElement() || $('#sharedText');
  const show = (key) => {
    if (cur !== 'tokens') edited[cur] = cm ? cm.getValue() : $('#sharedText').value;
    cur = key;
    const tokens = key === 'tokens';
    codeEl().hidden = tokens;
    $('#tokenPane').hidden = !tokens;
    $('#sharedLint').hidden = tokens;
    if (tokens) {
      drawTokens();
      $('#sharedHint').textContent = 'global.css 의 :root 변수(색·글꼴·간격)를 바꿉니다. 영역 CSS 에서 var(--이름) 으로 쓰면 앱 전체가 함께 바뀝니다.';
    } else {
      if (cm) {
        cm.setOption('mode', CM_MODES[langOf[key]]);
        cm.setValue(edited[key]);
        cm.clearHistory();
        setTimeout(() => cm.refresh(), 0);
      } else $('#sharedText').value = edited[key];
      lintInto($('#sharedLint'), langOf[key], edited[key]);
      $('#sharedHint').textContent = SHARED_TABS.find((t) => t.key === key).hint;
    }
    document.querySelectorAll('[data-shared]').forEach((b) => b.classList.toggle('on', b.dataset.shared === key));
  };

  // 디자인 토큰 표: 라이트 값 / (있으면) 다크 값. 색이면 색 선택기도 함께
  const valueCell = (t, kind) => {
    const v = t[kind];
    return `<span class="tok-val">${isColor(v) ? `<input type="color" data-tok="${esc(t.name)}" data-kind="${kind}" value="${esc(toHex6(v))}">` : ''}<input type="text" class="mono" data-tok="${esc(t.name)}" data-kind="${kind}" value="${esc(v)}" placeholder="${kind === 'dark' ? '(라이트와 같음)' : ''}"></span>`;
  };
  const drawTokens = () => {
    const { tokens, hasDark } = readTokens(edited.css);
    $('#tokenPane').innerHTML = `
      <div class="theme-row"><span class="muted small-note">테마 프리셋:</span>${THEME_PRESETS.map((th) => `<button type="button" class="theme-pill" data-theme="${esc(th.id)}"><span class="swatches">${th.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${esc(th.name)}</button>`).join('')}</div>
      <div class="tok-row tok-head"><span>이름</span><span>값${hasDark ? ' (라이트)' : ''}</span>${hasDark ? '<span>다크 모드</span>' : ''}<span></span></div>
      ${tokens.map((t) => `<div class="tok-row"><span class="mono">${esc(t.name)}</span>${valueCell(t, 'light')}${hasDark ? valueCell(t, 'dark') : ''}<button type="button" class="btn small ghost" data-tok-del="${esc(t.name)}" title="지우기">✕</button></div>`).join('') || '<p class="muted">아직 토큰이 없습니다. 위 테마 프리셋을 누르거나 아래에서 추가하세요.</p>'}
      <div class="tok-row tok-add"><input id="tokNewName" class="mono" placeholder="--brand"><input id="tokNewVal" class="mono" placeholder="#5b5bd6"><button type="button" class="btn small" id="tokAdd">추가</button></div>
      <div class="actions">${hasDark ? '' : '<button type="button" class="btn small" id="tokDark">🌙 다크 모드 값 만들기</button>'}<span class="muted small-note">저장을 누르면 global.css 에 반영됩니다 (이전 내용은 자동 백업)</span></div>`;
  };
  $('#tokenPane').addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.dataset.tok) return;
    edited.css = setToken(edited.css, el.dataset.kind, el.dataset.tok, el.value.trim());
    // 색 선택기와 글자 입력칸을 서로 맞춘다
    const twin = [...$('#tokenPane').querySelectorAll(`[data-tok="${CSS.escape(el.dataset.tok)}"][data-kind="${el.dataset.kind}"]`)].find((x) => x !== el);
    if (twin && (twin.type !== 'color' || isColor(el.value))) twin.value = twin.type === 'color' ? toHex6(el.value) : el.value;
  });
  $('#tokenPane').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.theme) {
      const th = THEME_PRESETS.find((x) => x.id === b.dataset.theme);
      if (th) {
        edited.css = applyThemeTokens(edited.css, th);
        toast(`"${th.name}" 디자인 토큰을 적용했습니다 (저장 시 반영)`);
      }
    } else if (b.dataset.tokDel) {
      edited.css = setToken(setToken(edited.css, 'light', b.dataset.tokDel, ''), 'dark', b.dataset.tokDel, '');
    } else if (b.id === 'tokAdd') {
      let name = $('#tokNewName').value.trim();
      const val = $('#tokNewVal').value.trim();
      if (!name || !val) return toast('이름과 값을 적어 주세요', true);
      if (!name.startsWith('--')) name = `--${name}`;
      edited.css = setToken(edited.css, 'light', name, val);
    } else if (b.id === 'tokDark') {
      edited.css = addDarkFromLight(edited.css);
    }
    drawTokens();
  });
  show('tokens');
  setTimeout(() => cm?.refresh(), 50); // 대화상자가 열린 뒤 크기 다시 계산
  $('#dlgContent').addEventListener('click', (ev) => ev.target.dataset.shared && show(ev.target.dataset.shared));
  const ok = await pending;
  $('#dlg').classList.remove('wide');
  if (!ok) return;
  if (cur !== 'tokens') edited[cur] = cm ? cm.getValue() : $('#sharedText').value;
  const changed = SHARED_TABS.filter((t) => edited[t.key] !== texts[t.key]);
  await Promise.all(changed.map((t) => api('PUT', `/api/shared/${t.key}`, { text: edited[t.key] })));
  toast(changed.length ? `저장했습니다: ${changed.map((t) => t.label).join(', ')}` : '바뀐 내용이 없습니다');
  reloadPreview();
});

// ───────────── 프로젝트 / 가져오기 ─────────────
async function renderProjects() {
  const { current, list, details } = await api('GET', '/api/projects');
  const byName = new Map((details || []).map((d) => [d.name, d]));
  $('#projectSel').innerHTML = list.map((n) => {
    const d = byName.get(n);
    const label = d && d.title && d.title !== n ? `${n} · ${d.title} (${d.regionsCount})` : `${n}${d ? ` (${d.regionsCount})` : ''}`;
    return `<option value="${esc(n)}" ${n === current ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

$('#btnProjectHub')?.addEventListener('click', async () => {
  let data = await api('GET', '/api/projects');
  let query = '';
  const pending = dialog(`🗂 프로젝트 목록 (${data.list.length}개)`, `<div id="hubBody"></div>`, '닫기');
  $('#dlg').classList.add('wide');

  const draw = () => {
    const box = $('#hubBody');
    if (!box) return;
    const details = data.details?.length ? data.details : (data.list || []).map((name) => ({ name, title: name, regionsCount: 0, grid: { cols: 12, rows: 12 }, regions: [], workflowStep: 1 }));
    box.innerHTML = renderProjectHub({ current: data.current, details, query, esc });
  };

  $('#hubBody').addEventListener('input', (ev) => {
    if (ev.target.id === 'hubSearch') {
      query = ev.target.value;
      const pos = ev.target.selectionStart;
      draw();
      const inp = $('#hubSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    }
  });

  $('#hubBody').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'hubNewProj') {
      $('#dlg').close();
      return $('#btnNewProject')?.click();
    }
    if (b.dataset.hubOpen) {
      flushAllPromptSaves(false);
      await api('POST', '/api/projects/open', { name: b.dataset.hubOpen });
      return location.reload();
    }
    if (b.dataset.hubClone) {
      const src = b.dataset.hubClone;
      $('#dlg').close();
      const next = await promptBox(`"${src}" 복제할 새 프로젝트 이름`, `${src}-copy`);
      if (!next?.trim()) return;
      try {
        if (src !== data.current) await api('POST', '/api/projects/open', { name: src });
        await api('POST', '/api/projects/clone', { newName: next.trim() });
        location.reload();
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (b.dataset.hubDel) {
      const target = b.dataset.hubDel;
      $('#dlg').close();
      if (!(await confirmBox(`"${target}" 프로젝트를 삭제할까요?\n폴더는 영구 삭제되지 않고 projects/.trash 로 옮겨집니다.`, '삭제'))) return;
      try {
        await api('DELETE', `/api/projects/${encodeURIComponent(target)}`);
        location.reload();
      } catch (e) { toast(e.message, true); }
    }
  });

  draw();
  await pending;
  $('#dlg').classList.remove('wide');
});

$('#projectSel').addEventListener('change', async (ev) => {
  flushAllPromptSaves(false);
  await api('POST', '/api/projects/open', { name: ev.target.value });
  location.reload();
});

$('#btnManageProject')?.addEventListener('click', async () => {
  const curName = $('#projectSel').value;
  const pending = dialog(`프로젝트 관리 — ${curName}`, `
    <p class="muted small-note">현재 열려 있는 프로젝트(<b>${esc(curName)}</b>)를 저장·초기화하거나 이름을 바꾸고 복제·삭제할 수 있습니다.</p>
    <div class="actions" style="flex-wrap:wrap">
      <button type="button" class="btn primary" id="pmSaveNow">💾 지금 전체 저장</button>
      <button type="button" class="btn" id="pmRename">✏️ 이름 변경</button>
      <button type="button" class="btn" id="pmClone">📄 프로젝트 복제</button>
      <button type="button" class="btn" id="pmReset">🧹 프로젝트 초기화</button>
      <button type="button" class="btn danger" id="pmDelete">🗑 프로젝트 삭제 (.trash 이동)</button>
    </div>`, '닫기');
  $('#pmSaveNow')?.addEventListener('click', async () => {
    try {
      flushAllPromptSaves(false);
      await api('PUT', '/api/layout', state.layout);
      await api('PUT', '/api/project', { request: proj.request, plan: proj.plan, appPrompt: proj.appPrompt, decisions: proj.decisions });
      await api('PUT', '/api/workflow', { step: proj.wf.step, workload: proj.wf.workload, distributed: proj.wf.distributed });
      $('#dlg').close();
      toast(`"${curName}" 프로젝트를 저장했습니다`);
    } catch (e) { toast(e.message, true); }
  });
  $('#pmReset')?.addEventListener('click', async () => {
    $('#dlg').close();
    if (!(await confirmBox(`"${curName}" 프로젝트의 레이아웃과 프롬프트를 초기화할까요?\n(초기화 전 상태는 🕘 스냅샷에 자동 백업됩니다)`, '초기화'))) return;
    try {
      await api('POST', '/api/projects/reset');
      location.reload();
    } catch (e) { toast(e.message, true); }
  });
  $('#pmRename')?.addEventListener('click', async () => {
    $('#dlg').close();
    const next = await promptBox('새 프로젝트 이름', curName);
    if (!next?.trim() || next.trim() === curName) return;
    try {
      await api('POST', '/api/projects/rename', { newName: next.trim() });
      location.reload();
    } catch (e) { toast(e.message, true); }
  });
  $('#pmClone')?.addEventListener('click', async () => {
    $('#dlg').close();
    const next = await promptBox('복제할 새 프로젝트 이름', `${curName}-copy`);
    if (!next?.trim()) return;
    try {
      await api('POST', '/api/projects/clone', { newName: next.trim() });
      location.reload();
    } catch (e) { toast(e.message, true); }
  });
  $('#pmDelete')?.addEventListener('click', async () => {
    $('#dlg').close();
    if (!(await confirmBox(`"${curName}" 프로젝트를 삭제할까요?\n폴더는 영구 삭제되지 않고 projects/.trash 로 옮겨집니다.`, '삭제'))) return;
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(curName)}`);
      location.reload();
    } catch (e) { toast(e.message, true); }
  });
  await pending;
});

$('#btnNewProject').addEventListener('click', async () => {
  let pickedTpl = APP_TEMPLATES[0].id;
  let pickedTheme = THEME_PRESETS[0].id;
  const pending = dialog('새 프로젝트 만들기', `
    <label>프로젝트 이름
      <input type="text" id="newProjName" placeholder="예: my-dashboard" autocomplete="off">
    </label>
    <div>
      <div class="muted small-note" style="margin-bottom:6px">시작 레이아웃 템플릿</div>
      <div class="tpl-grid" id="tplGrid">${APP_TEMPLATES.map((t) => `<button type="button" class="tpl-card ${t.id === pickedTpl ? 'on' : ''}" data-tpl="${esc(t.id)}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`).join('')}</div>
    </div>
    <div>
      <div class="muted small-note" style="margin-bottom:6px">기본 디자인 토큰 테마</div>
      <div class="theme-row" id="newProjThemes">${THEME_PRESETS.map((th) => `<button type="button" class="theme-pill ${th.id === pickedTheme ? 'on' : ''}" data-theme="${esc(th.id)}"><span class="swatches">${th.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${esc(th.name)}</button>`).join('')}</div>
    </div>`, '만들기');
  $('#dlg').classList.add('wide');
  setTimeout(() => $('#newProjName')?.focus(), 20);
  $('#tplGrid').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tpl]');
    if (!b) return;
    pickedTpl = b.dataset.tpl;
    $('#tplGrid').querySelectorAll('[data-tpl]').forEach((x) => x.classList.toggle('on', x.dataset.tpl === pickedTpl));
  });
  $('#newProjThemes').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-theme]');
    if (!b) return;
    pickedTheme = b.dataset.theme;
    $('#newProjThemes').querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('on', x.dataset.theme === pickedTheme));
  });
  const ok = await pending;
  $('#dlg').classList.remove('wide');
  if (!ok) return;
  const name = ($('#newProjName')?.value || '').trim();
  if (!name) return toast('프로젝트 이름을 입력하세요', true);
  const tpl = APP_TEMPLATES.find((t) => t.id === pickedTpl);
  const theme = THEME_PRESETS.find((th) => th.id === pickedTheme);
  const payload = tpl && tpl.id !== 'blank'
    ? { name, template: { layout: tpl.layout, files: tpl.files, sharedCss: buildThemeBaseCss(theme) } }
    : { name, template: { layout: APP_TEMPLATES[0].layout, files: {}, sharedCss: buildThemeBaseCss(theme) } };
  try {
    await api('POST', '/api/projects', payload);
    location.reload();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const base = file.name.replace(/\.html?$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 50) || '가져온 앱';
  const name = await promptBox('가져올 프로젝트 이름', base);
  if (!name?.trim()) return;
  try {
    const html = await file.text();
    const { regions } = await api('POST', '/api/import', { name: name.trim(), fileName: file.name, html });
    try { localStorage.setItem('ide-view', 'preview'); } catch {}
    toast(`${regions}개 영역으로 가져왔습니다`);
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnExport').addEventListener('click', async () => {
  let savedDir = '';
  let savedName = '';
  try {
    savedDir = localStorage.getItem('ide-export-dir') || '';
    savedName = localStorage.getItem('ide-export-filename') || '';
  } catch {}
  const defaultName = savedName || state.layout?.name || $('#projectSel')?.value || 'webapp';
  const pending = dialog('📦 내보내기 · 로컬 실행 호환성 점검', `
    <div id="expLocalBox" class="wf-fold" style="margin-bottom:8px">
      <span class="muted small-note">🔍 로컬 단독 실행(HTML 1개) 호환성을 분석하는 중…</span>
    </div>
    <div style="display:grid;gap:8px;margin-bottom:10px">
      <label style="display:grid;gap:4px">
        <span><b>📂 저장 폴더</b> <span class="muted small-note">(비우면 프로젝트 기본 dist 폴더에 저장)</span></span>
        <span style="display:flex;gap:6px">
          <input type="text" id="expOutputDir" class="mono" style="flex:1" value="${esc(savedDir)}" placeholder="예: C:\\Users\\user\\Desktop\\my-webapp (비우면 기본 dist)">
          <button type="button" class="btn small" id="btnExpPickDir">📁 폴더 찾아보기</button>
          <button type="button" class="btn small ghost" id="btnExpResetDir" title="기본 dist 폴더로 되돌리기">기본값</button>
        </span>
      </label>
      <label style="display:grid;gap:4px">
        <span><b>📄 파일 이름</b> <span class="muted small-note">(확장자 제외 — HTML은 <code>이름.html</code>, Electron 빌드는 <code>이름.exe</code>로 저장)</span></span>
        <input type="text" id="expFileName" value="${esc(defaultName)}" placeholder="예: 수행평가-관리프로그램">
      </label>
    </div>
    <label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="expMode" value="electron" checked>
      <span><b>🖥️ 일렉트론 데스크톱 앱 (Electron · Windows .exe 지원)</b><br><span class="muted small-note">dist/electron/ — 내장 로컬 서버로 감싼 독립 데스크톱 앱을 만듭니다. <code>file://</code> 제약 없이 localStorage·IndexedDB가 안정적으로 동작하며, 바로 Windows <code>.exe</code>로 빌드할 수 있습니다.</span>
        <label style="display:flex;gap:6px;align-items:center;margin-top:4px;font-size:12px"><input type="checkbox" id="expElectronOffline" checked> CDN·폰트도 함께 내장 (인터넷 없는 교실 PC용)</label>
      </span></label>
    <label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="expMode" value="online">
      <span><b>기본 (HTML 1개)</b><br><span class="muted small-note">dist/index.html — 라이브러리는 인터넷(CDN)에서 불러옵니다. 파일이 작습니다.</span></span></label>
    <label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="expMode" value="offline">
      <span><b>오프라인 (HTML 1개, 모든 것 포함)</b><br><span class="muted small-note">dist/index-offline.html — pdf.js·xlsx·KaTeX·폰트까지 내려받아 파일 하나에 넣습니다.
        인터넷 없는 교실 PC 에서도 열립니다. 만들 때만 인터넷이 필요하고, 파일이 수 MB 로 커집니다.</span></span></label>
    <div class="actions" style="margin-top:8px;flex-wrap:wrap">
      <button type="button" class="btn primary" id="btnExportNow">📦 지금 내보내기 생성</button>
      <button type="button" class="btn small" id="btnExportVerify">✅ 내보내기 전 앱 검증 실행</button>
      <span id="expResult" class="small-note"></span>
    </div>
    <div id="expDoneBox" style="margin-top:8px"></div>`, '닫기');
  $('#dlg').classList.add('wide');

  const renderLocalCheck = async () => {
    const box = $('#expLocalBox');
    if (!box) return;
    try {
      const lc = await api('GET', '/api/export/check');
      const icon = lc.status === 'local-ready' ? '🟢' : lc.status === 'internet-needed' ? '🟡' : '🔴';
      const border = lc.status === 'local-ready' ? 'var(--ok)' : lc.status === 'internet-needed' ? 'var(--accent)' : 'var(--danger)';
      box.style.borderColor = `color-mix(in srgb, ${border} 55%, var(--line))`;
      box.innerHTML = `
        <div class="actions" style="justify-content:space-between;flex-wrap:wrap">
          <b>${icon} 로컬 실행 판정: ${esc(lc.label)}</b>
          ${!lc.canRunLocally ? `<button type="button" class="btn small primary" id="btnExpFixLocal">🩺 로컬 저장소(localStorage)로 AI 자동 전환</button>` : ''}
        </div>
        ${lc.issues?.length ? `<ul class="reorg-list" style="max-height:150px;overflow:auto;margin-top:6px">${lc.issues.map((i) => `
          <li><span class="badge-soft" style="color:${i.level === 'error' ? 'var(--danger)' : 'inherit'}">${i.level === 'error' ? '로컬 불가' : '인터넷 필요'}</span>
            <span class="mono">${esc(i.region)}</span> — <b>${esc(i.detail)}</b> <span class="muted">(${esc(i.fix)})</span></li>`).join('')}</ul>`
          : '<p class="muted small-note" style="margin:4px 0 0">서버 API(/api/...)나 file:// CORS 차단 코드가 없습니다. 내보낸 HTML 파일을 더블클릭해 바로 실행할 수 있습니다.</p>'}`;
      $('#btnExpFixLocal')?.addEventListener('click', async (ev) => {
        const b = ev.currentTarget;
        const targets = [...new Set(lc.issues.filter((i) => i.level === 'error' && region(i.region)).map((i) => i.region))];
        if (!targets.length) return toast('자동 수정 가능한 영역이 없습니다', true);
        b.disabled = true;
        b.textContent = `🩺 ${targets.length}개 영역 로컬 전환 중…`;
        for (const rid of targets) {
          const myIssues = lc.issues.filter((i) => i.level === 'error' && i.region === rid);
          const req = `이 앱은 서버 없이 로컬 HTML 파일 1개로 단독 실행되어야 합니다. 다음 서버/CORS 의존 코드를 모두 제거하고 브라우저 localStorage 또는 IndexedDB로 동작하도록 수정하세요:\n${myIssues.map((x) => `- ${x.detail}: ${x.fix}`).join('\n')}`;
          await generateRegion(rid, req, '로컬 단독 실행 호환성 자동 전환', { review: false });
        }
        toast('로컬 저장소 전환 수정을 완료했습니다. 호환성을 다시 점검합니다.');
        await renderLocalCheck();
      });
    } catch (e) {
      box.innerHTML = `<span class="err small-note">로컬 호환성 점검 실패: ${esc(e.message)}</span>`;
    }
  };
  renderLocalCheck();

  $('#btnExportVerify')?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    $('#expResult').textContent = '검증 중…';
    try {
      const vr = await api('POST', '/api/verify', { runBrowser: true });
      const vc = countVerifyIssues(vr);
      $('#expResult').innerHTML = vc.totalErrors === 0
        ? `<span class="ok">✅ 문법·연결·로컬호환·런타임 오류 0건, 테스트 ${vc.testPass}/${vc.testsTotal} 통과</span>`
        : `<span class="err">⚠ 문제 ${vc.totalErrors}건 발견 (상단 "🤖 AI 검증 봇"에서 자동 수정 가능)</span>`;
    } catch (e) {
      $('#expResult').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    }
    b.disabled = false;
  });

  $('#expOutputDir')?.addEventListener('input', () => {
    try { localStorage.setItem('ide-export-dir', ($('#expOutputDir')?.value || '').trim()); } catch {}
  });
  $('#expFileName')?.addEventListener('input', () => {
    try { localStorage.setItem('ide-export-filename', ($('#expFileName')?.value || '').trim()); } catch {}
  });
  $('#btnExpResetDir')?.addEventListener('click', () => {
    if ($('#expOutputDir')) $('#expOutputDir').value = '';
    try { localStorage.removeItem('ide-export-dir'); } catch {}
  });
  $('#btnExpPickDir')?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = '선택 중…';
    try {
      const r = await api('POST', '/api/export/pick-folder', { initial: ($('#expOutputDir')?.value || '').trim() });
      if (r.path && $('#expOutputDir')) {
        $('#expOutputDir').value = r.path;
        try { localStorage.setItem('ide-export-dir', r.path); } catch {}
      }
    } catch (e) {
      toast(e.message, true);
    }
    b.disabled = false;
    b.textContent = '📁 폴더 찾아보기';
  });

  $('#btnExportNow')?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    const mode = document.querySelector('input[name="expMode"]:checked')?.value || 'electron';
    const offline = mode === 'offline' || (mode === 'electron' && Boolean($('#expElectronOffline')?.checked));
    const outputDir = ($('#expOutputDir')?.value || '').trim();
    const fileName = ($('#expFileName')?.value || '').trim();
    try {
      localStorage.setItem('ide-export-dir', outputDir);
      localStorage.setItem('ide-export-filename', fileName);
    } catch {}
    b.disabled = true;
    b.textContent = mode === 'electron' ? '⏳ 일렉트론 앱 생성 중…' : offline ? '⏳ 오프라인 번들 생성 중…' : '⏳ HTML 생성 중…';
    try {
      const r = await api('POST', '/api/export', { mode, offline, outputDir, fileName });
      const sizeText = r.bytes >= 1024 * 1024 ? `${(r.bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(r.bytes / 1024))} KB`;
      const failed = r.report?.failed?.length ? ` · ⚠ 못 받은 리소스 ${r.report.failed.length}개` : '';
      const doneBox = $('#expDoneBox');
      if (doneBox) {
        if (r.mode === 'electron') {
          doneBox.innerHTML = `<div class="wf-fold" style="border-color:color-mix(in srgb, var(--ok) 55%, var(--line))">
            <b class="ok">✅ 일렉트론 데스크톱 앱 패키지 생성 완료 (앱 크기 ${sizeText}${r.report ? `, 오프라인 리소스 ${r.report.downloaded.length}개` : ''}${failed})</b>
            <div class="mono muted small-note" style="margin:4px 0 6px;word-break:break-all">${esc(r.path)}</div>
            <p class="muted small-note" style="margin:0 0 8px">폴더 안의 <b>실행하기.bat</b>으로 바로 실행하거나, 아래 버튼으로 <b>Windows 단일 .exe</b>를 바로 빌드할 수 있습니다.</p>
            <div class="actions" style="flex-wrap:wrap">
              <button type="button" class="btn small primary" id="btnExpBuildExe">🔨 Windows 단일 .exe 지금 빌드</button>
              <button type="button" class="btn small" id="btnExpOpenElectron">📂 저장 폴더 열기</button>
            </div>
            <div id="expExeResult" class="small-note" style="margin-top:8px"></div>
          </div>`;
          $('#btnExpOpenElectron')?.addEventListener('click', () => api('POST', '/api/open-folder', { target: 'electron', dir: r.path }).catch((e) => toast(e.message, true)));
          $('#btnExpBuildExe')?.addEventListener('click', async (ev2) => {
            const eb = ev2.currentTarget;
            const resBox = $('#expExeResult');
            eb.disabled = true;
            eb.textContent = '⏳ Electron 설치 및 .exe 빌드 중… (최초 1~3분 소요)';
            if (resBox) resBox.innerHTML = '<span class="muted">npm install 및 electron-builder 실행 중입니다. 창을 닫지 말고 잠시만 기다려 주세요…</span>';
            try {
              const built = await api('POST', '/api/export/electron/build-exe', { outputDir: r.outputDir || outputDir });
              const exeMb = (built.bytes / 1024 / 1024).toFixed(1);
              if (resBox) {
                resBox.innerHTML = `<b class="ok">✅ Windows .exe 빌드 완료: ${esc(built.exeName)} (${exeMb} MB)</b>
                  <div class="mono muted small-note" style="margin:4px 0;word-break:break-all">${esc(built.exePath)}</div>
                  <div class="actions" style="margin-top:6px;flex-wrap:wrap">
                    <a class="btn small primary" href="${esc(built.downloadUrl)}" download>⬇ .exe 파일 바로 다운로드</a>
                    <button type="button" class="btn small" id="btnExpOpenExeDir">📂 .exe 폴더 열기</button>
                  </div>`;
                $('#btnExpOpenExeDir')?.addEventListener('click', () => api('POST', '/api/open-folder', { target: 'electron-dist', dir: built.outDir }).catch((e) => toast(e.message, true)));
              }
              toast(`Windows .exe 빌드 완료: ${built.exeName}`);
            } catch (e) {
              if (resBox) resBox.innerHTML = `<span class="err">✗ .exe 빌드 실패: ${esc(e.message)}</span>`;
              toast(e.message, true);
            }
            eb.disabled = false;
            eb.textContent = '🔨 Windows 단일 .exe 다시 빌드';
          });
        } else {
          doneBox.innerHTML = `<div class="wf-fold" style="border-color:color-mix(in srgb, var(--ok) 55%, var(--line))">
            <b class="ok">✅ 내보내기 완료 (${sizeText}${r.report ? `, 포함 리소스 ${r.report.downloaded.length}개` : ''}${failed})</b>
            <div class="mono muted small-note" style="margin:4px 0 8px;word-break:break-all">${esc(r.path)}</div>
            <div class="actions" style="flex-wrap:wrap">
              <a class="btn small primary" href="${esc(r.downloadUrl || '/api/export/download?file=index.html')}" download>⬇ HTML 파일 바로 다운로드</a>
              <button type="button" class="btn small" id="btnExpOpenFolder">📂 저장 폴더 열기</button>
              <a class="btn small" href="/preview" target="_blank" rel="noopener">🌐 새 탭에서 실행</a>
            </div>
          </div>`;
          $('#btnExpOpenFolder')?.addEventListener('click', () => api('POST', '/api/open-folder', { target: 'dist', dir: r.outputDir }).catch((e) => toast(e.message, true)));
        }
      }
      toast(`내보내기 완료 (${sizeText}): ${r.file}`);
    } catch (e) {
      toast(e.message, true);
    }
    b.disabled = false;
    b.textContent = '📦 지금 내보내기 생성';
  });

  await pending;
  $('#dlg').classList.remove('wide');
});

const keyNote = (src, env) => (src === 'env' ? `환경변수 ${env} 사용 중` : src === 'settings' ? '저장된 키 사용 중' : '키 없음');

$('#btnSettings').addEventListener('click', async () => {
  const s = await api('GET', '/api/settings');
  const pending = dialog('설정', `
    <label>AI 제공자
      <select id="setProvider">
        <option value="gemini" ${s.provider === 'gemini' ? 'selected' : ''}>Google Gemini</option>
        <option value="claude" ${s.provider === 'claude' ? 'selected' : ''}>Anthropic Claude</option>
        <option value="local" ${s.provider === 'local' ? 'selected' : ''}>OpenAI 호환 / 로컬 LLM (OpenAI · OpenRouter · Groq · LM Studio · Ollama)</option>
        ${window.__WEB_STANDALONE__ ? '' : `<option value="cli" ${s.provider === 'cli' ? 'selected' : ''}>💻 로컬 구독 CLI (Claude Code · Codex · Gemini CLI · Antigravity)</option>`}
      </select>
    </label>
    <div id="secCli" style="display:grid;gap:10px">
      <div id="cliDetectList" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center"><span class="muted small-note">설치된 CLI 확인 중…</span></div>
      <label>CLI 프리셋
        <select id="setCliPreset">${(Object.values(s.cliPresets || {}).length ? Object.values(s.cliPresets) : [
          { id: 'codex', label: 'OpenAI Codex CLI (codex)' },
          { id: 'claude', label: 'Claude Code (claude)' },
          { id: 'gemini', label: 'Gemini CLI (gemini)' },
          { id: 'agy', label: 'Antigravity CLI (agy)' },
          { id: 'custom', label: '커스텀 CLI 명령' },
        ]).map((p) => `<option value="${esc(p.id)}" ${p.id === (s.cliPreset || 'codex') ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
      </label>
      <label>모델 이름 <span class="muted">(선택 — 비우면 해당 CLI 기본 구독 모델 사용)</span>
        <input type="text" id="setCliModel" class="mono" value="${esc(s.cliModel || '')}" placeholder="예: gpt-5-codex, claude-sonnet-4-5">
      </label>
      <details><summary class="muted small-note" style="cursor:pointer">고급: 실행 명령 · 인자 직접 지정</summary>
        <div style="display:grid;gap:6px;margin-top:6px">
          <label>명령어 <input type="text" id="setCliCommand" class="mono" value="${esc(s.cliCommand || '')}" placeholder="비우면 프리셋 기본 명령 사용"></label>
          <label>인자 <input type="text" id="setCliArgs" class="mono" value="${esc(s.cliArgs || '')}" placeholder="비우면 프리셋 기본 인자 사용 (stdin 파이프)"></label>
        </div>
      </details>
      <p class="muted small-note" style="margin:0">이미 구독 중인 CLI 계정을 사용해 별도 API 비용 없이 로컬에서 바이브 코딩합니다. (병렬 실행은 자동으로 순차 모드로 제한됩니다)</p>
    </div>
    <div id="secLocal" style="display:grid;gap:12px">
      <label>서버 주소 (OpenAI 호환)
        <span style="display:flex;gap:6px;flex-wrap:wrap">
          <input type="text" id="setLocalUrl" class="mono" style="flex:1;min-width:180px" value="${esc(s.localUrl)}">
          <button type="button" class="btn small" data-preset="${esc(s.localPresets.openai)}">OpenAI</button>
          <button type="button" class="btn small" data-preset="${esc(s.localPresets.openrouter)}">OpenRouter</button>
          <button type="button" class="btn small" data-preset="${esc(s.localPresets.groq)}">Groq(무료)</button>
          <button type="button" class="btn small" data-preset="${esc(s.localPresets.lmstudio)}">LM Studio</button>
          <button type="button" class="btn small" data-preset="${esc(s.localPresets.ollama)}">Ollama</button>
        </span>
      </label>
      <label>API 키 <span class="muted">(OpenAI·OpenRouter·Groq 등 클라우드용, 로컬은 비워 둠 · ${keyNote(s.localKeySource, 'OPENAI_API_KEY')})</span>
        <input type="password" id="setLocalKey" placeholder="바꾸려면 입력 (비우면 그대로)" autocomplete="off">
      </label>
      <label>모델
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select id="setLocalModel" style="flex:1;min-width:180px">${s.localModel ? `<option>${esc(s.localModel)}</option>` : '<option value="">← 먼저 모델을 불러오세요</option>'}</select>
          <label class="muted small-note" style="display:flex;gap:4px;align-items:center" title="OpenRouter 에서 :free 무료 모델만 골라 불러옵니다"><input type="checkbox" id="chkFreeModelsOnly"> :free 만</label>
          <button type="button" class="btn" id="btnLoadLocal">모델 불러오기</button>
        </span>
      </label>
      <p class="muted" style="margin:0">OpenRouter(<span class="mono">:free</span> 모델 무료) · Groq(카드 없이 무료 티어) · OpenAI · LM Studio · Ollama 모두 지원합니다.</p>
    </div>
    <div id="secGemini" style="display:grid;gap:12px">
      <label>Gemini API 키 <span class="muted">(${keyNote(s.geminiKeySource, 'GEMINI_API_KEY')})</span>
        <input type="password" id="setGeminiKey" placeholder="바꾸려면 입력 (비우면 그대로)" autocomplete="off">
      </label>
      <label>Gemini 모델
        <span style="display:flex;gap:6px">
          <select id="setGeminiModel" style="flex:1">${s.geminiModel ? `<option>${esc(s.geminiModel)}</option>` : '<option value="">← 먼저 모델을 불러오세요</option>'}</select>
          <button type="button" class="btn" id="btnLoadModels">모델 불러오기</button>
        </span>
      </label>
      <p class="muted" style="margin:0">키는 Google AI Studio(aistudio.google.com) → Get API key 에서 발급합니다.</p>
    </div>
    <div id="secClaude" style="display:grid;gap:12px">
      <label>Claude 모델
        <select id="setModel">${s.models.map((m) => `<option ${m === s.model ? 'selected' : ''}>${m}</option>`).join('')}</select>
      </label>
      <label>Anthropic API 키 <span class="muted">(${keyNote(s.keySource, 'ANTHROPIC_API_KEY')})</span>
        <input type="password" id="setKey" placeholder="바꾸려면 입력 (비우면 그대로)" autocomplete="off">
      </label>
    </div>
    <div class="free-box">
      <label style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="setFreeEnabled" ${s.freeMode?.enabled ? 'checked' : ''}>
        <b>🍃 무료 API 한도 절약 모드</b>
        <span class="muted small-note">(RPM 쿨다운 · 토큰 다이어트 · 병렬 호출 자동 억제)</span>
      </label>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:12px">
        <label style="display:flex;gap:4px;align-items:center">호출 간격 <input type="number" id="setFreeInterval" min="0" max="60" value="${s.freeMode?.minIntervalSec ?? 4}" style="width:54px">초</label>
        <label style="display:flex;gap:4px;align-items:center">일일 상한 <input type="number" id="setFreeDaily" min="0" max="10000" value="${s.freeMode?.dailyLimit ?? 50}" style="width:68px">회 <span class="muted">(0=무제한)</span></label>
        <label style="display:flex;gap:4px;align-items:center" title="429(한도 초과) 또는 503(서버 혼잡) 시 키가 등록된 다른 제공자로 자동 전환합니다"><input type="checkbox" id="setFreeFallback" ${s.freeMode?.autoFallback !== false ? 'checked' : ''}> 429/503 시 다른 제공자 자동 전환</label>
      </div>
    </div>
    <details class="light-model" ${Object.values(s.sessionModels || {}).some((m) => m?.model) ? 'open' : ''}><summary><b>🧭🧩🧪 3대 세션별 전용 모델</b> <span class="muted">(통합 · 영역 · 검증 세션마다 모델 다르게 지정)</span></summary>
      <div class="sess-model-grid">
        <span class="muted small-note">비워 두면 위 주 모델(또는 아래 가벼운 모델)을 사용합니다.</span>
        ${[['integrated', '🧭 통합 세션'], ['region', '🧩 영역 세션'], ['verify', '🧪 검증 세션']].map(([k, label]) => {
          const sm = s.sessionModels?.[k] || {};
          return `<div class="sess-model-row">
            <b>${label}</b>
            <select id="setSess_${k}_prov"><option value="">(주 모델)</option>${['gemini', 'claude', 'local', ...(window.__WEB_STANDALONE__ ? [] : ['cli'])].map((p) => `<option value="${p}" ${sm.provider === p ? 'selected' : ''}>${{ gemini: 'Gemini', claude: 'Claude', local: 'OpenAI/로컬', cli: '로컬 CLI' }[p]}</option>`).join('')}</select>
            <input id="setSess_${k}_model" class="mono" placeholder="모델 이름 (비우면 기본)" value="${esc(sm.model || '')}">
          </div>`;
        }).join('')}
      </div></details>
    <details class="light-model" ${s.light?.model ? 'open' : ''}><summary><b>가벼운 작업용 모델</b> <span class="muted">(작업마다 다른 모델 쓰기)</span></summary>
      <div style="display:grid;gap:8px;margin-top:6px">
        <span class="muted small-note">어려운 일(계획 등)은 위의 주 모델로, 가벼운 일은 아래 모델로 보냅니다. 키·서버 주소는 위에서 정한 것을 함께 씁니다.</span>
        <span style="display:flex;gap:6px"><select id="setLightProv"><option value="">(쓰지 않음)</option>${['gemini', 'claude', 'local', ...(window.__WEB_STANDALONE__ ? [] : ['cli'])].map((p) => `<option value="${p}" ${s.light?.provider === p ? 'selected' : ''}>${{ gemini: 'Gemini', claude: 'Claude', local: 'OpenAI/로컬', cli: '로컬 CLI' }[p]}</option>`).join('')}</select>
          <input id="setLightModel" class="mono" style="flex:1" placeholder="모델 이름 (예: gemini-…-flash, claude-haiku-5-5, qwen3-8b)" value="${esc(s.light?.model || '')}"></span>
        <span style="display:flex;flex-wrap:wrap;gap:10px">${[['describe', '기능 설명'], ['fix', '자동 고치기(재시도)'], ['css', '공통 CSS'], ['region', '영역 구현'], ['plan', '프로젝트 계획']].map(([k, l]) => `<label><input type="checkbox" data-route="${k}" ${s.routes?.[k] ? 'checked' : ''}> ${l}</label>`).join('')}</span>
      </div></details>
    <label style="display:flex;gap:8px;align-items:center" title="미리보기를 다른 주소(127.0.0.1 ↔ localhost)로 열어 미리보기 속 앱의 데이터가 IDE 와 섞이지 않게 합니다. 끄면 예전처럼 같은 주소로 열려 그때 저장한 데이터가 다시 보입니다"><input type="checkbox" id="setPreviewIso" ${s.previewIsolation === true ? 'checked' : ''}>
      미리보기 저장소 분리 <span class="muted">(미리보기 속 앱의 IndexedDB·localStorage 를 IDE 와 따로)</span></label>
    <label style="display:flex;gap:8px;align-items:center;flex-wrap:wrap" title="칸 크기·넘침 같은 측정값은 늘 글로 보냅니다(토큰 적음). 그림은 영역 하나를 찍어 보내며 한 장에 수백~천 토큰이 듭니다">📷 영역 화면 그림을 AI 에게
      <select id="setVisual">${[['off', '보내지 않음 (측정값 글만)'], ['auto', '필요할 때만 (모양·배치 요청, 칸 문제 발견 시)'], ['always', '항상']].map(([v, l]) => `<option value="${v}" ${(s.visualMode || 'off') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${s.browserFound ? '' : '<span class="err small-note">화면을 찍을 Edge/Chrome 을 찾지 못했습니다</span>'}</label>
    <label style="display:flex;gap:8px;align-items:center" title="영역마다 저장된 요청 기록(prompt-log.md) 중 최근 것들을 짧게 줄여 함께 보냅니다. 0 이면 보내지 않습니다">🕑 최근 요청 기록을 AI 에게
      <input type="number" id="setHistory" min="0" max="20" value="${s.historyCount ?? 8}" style="width:60px"><span class="muted">개까지 함께 보냄 (0 = 안 보냄)</span></label>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="setLogging" ${s.logging !== false ? 'checked' : ''}>
      작업·AI 로그 남기기 <span class="muted">(📜 로그, 보관</span><input type="number" id="setLogDays" min="1" max="365" value="${s.logKeepDays || 30}" style="width:60px"><span class="muted">일)</span></label>
    <p class="muted">키는 이 컴퓨터의 webapp-ide/settings.json 에만 저장되고 로그에는 남지 않습니다.<br>프로젝트 폴더: <span class="mono">${esc(s.projectDir)}</span></p>`);

  const showSection = () => {
    const p = $('#setProvider').value;
    $('#secGemini').style.display = p === 'gemini' ? 'grid' : 'none';
    $('#secClaude').style.display = p === 'claude' ? 'grid' : 'none';
    $('#secLocal').style.display = p === 'local' ? 'grid' : 'none';
    if ($('#secCli')) $('#secCli').style.display = p === 'cli' ? 'grid' : 'none';
  };
  showSection();
  $('#setProvider').addEventListener('change', showSection);
  if (!window.__WEB_STANDALONE__ && $('#cliDetectList')) {
    const loadCliDetect = (force = false) => {
      const box = $('#cliDetectList');
      if (!box) return;
      box.innerHTML = '<span class="muted small-note">설치된 CLI 확인 중…</span>';
      api('GET', `/api/cli/detect${force ? '?force=1' : ''}`).then(({ clis }) => {
        if (!$('#cliDetectList')) return;
        box.innerHTML = (clis || []).filter((c) => c.id !== 'custom').map((c) =>
          `<button type="button" class="btn small ${c.installed ? '' : 'ghost'}" data-cli-pick="${esc(c.id)}" title="${esc(c.path || c.note)}">${c.installed ? '✅' : '○'} ${esc(c.bin)} ${c.installed ? '(설치됨)' : '(미설치)'}</button>`,
        ).join('') + '<button type="button" class="btn small ghost" id="btnCliRedetect" title="설치 여부 다시 확인">↻</button>';
      }).catch((e) => {
        if (!$('#cliDetectList')) return;
        box.innerHTML = `<span class="err small-note">⚠ 자동 감지 실패 (${esc(e.message)}) — 웹앱제작기 서버를 재시작한 뒤 다시 열어 주세요.</span>`;
      });
    };
    $('#cliDetectList').addEventListener('click', (ev) => {
      if (ev.target.closest('#btnCliRedetect')) return loadCliDetect(true);
      const b = ev.target.closest('[data-cli-pick]');
      if (b && $('#setCliPreset')) $('#setCliPreset').value = b.dataset.cliPick;
    });
    loadCliDetect(false);
  }

  // 모델 목록을 불러와 select 를 채우는 공용 처리
  const loadInto = (btnSel, selectSel, url, payload, pick) =>
    $(btnSel).addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = '불러오는 중…';
      try {
        const { models } = await api('POST', url, payload());
        if (!models.length) throw new Error('쓸 수 있는 모델이 없습니다');
        const current = $(selectSel).value || pick(models);
        $(selectSel).innerHTML = models
          .map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label === m.id ? m.id : `${m.label} (${m.id})`)}</option>`)
          .join('');
      } catch (e) {
        toast(e.message, true);
      }
      btn.disabled = false;
      btn.textContent = '모델 불러오기';
    });
  loadInto('#btnLoadModels', '#setGeminiModel', '/api/gemini/models', () => ({ apiKey: $('#setGeminiKey').value }), pickGeminiModel);
  loadInto('#btnLoadLocal', '#setLocalModel', '/api/local/models', () => ({ baseUrl: $('#setLocalUrl').value, apiKey: $('#setLocalKey').value, freeOnly: $('#chkFreeModelsOnly')?.checked }), pickOpenAiModel);
  $('#secLocal').addEventListener('click', (ev) => {
    if (ev.target.dataset.preset) $('#setLocalUrl').value = ev.target.dataset.preset;
  });

  if (!(await pending)) return;
  const body = {
    provider: $('#setProvider').value,
    model: $('#setModel').value,
    geminiModel: $('#setGeminiModel').value,
    localUrl: $('#setLocalUrl').value,
    localModel: $('#setLocalModel').value,
    cliPreset: $('#setCliPreset')?.value || 'codex',
    cliCommand: $('#setCliCommand')?.value || '',
    cliArgs: $('#setCliArgs')?.value || '',
    cliModel: $('#setCliModel')?.value || '',
    logging: $('#setLogging').checked,
    previewIsolation: $('#setPreviewIso').checked,
    visualMode: $('#setVisual').value,
    historyCount: Number($('#setHistory').value),
    light: { provider: $('#setLightProv').value, model: $('#setLightModel').value },
    sessionModels: Object.fromEntries(['integrated', 'region', 'verify'].map((k) => [k, { provider: $(`#setSess_${k}_prov`)?.value || '', model: ($(`#setSess_${k}_model`)?.value || '').trim() }])),
    freeMode: {
      enabled: Boolean($('#setFreeEnabled')?.checked),
      minIntervalSec: Number($('#setFreeInterval')?.value) || 0,
      dailyLimit: Number($('#setFreeDaily')?.value) || 0,
      autoFallback: Boolean($('#setFreeFallback')?.checked),
    },
    routes: Object.fromEntries([...document.querySelectorAll('[data-route]')].map((c) => [c.dataset.route, c.checked])),
    logKeepDays: Number($('#setLogDays').value) || 30,
  };
  if ($('#setKey').value.trim()) body.apiKey = $('#setKey').value.trim();
  if ($('#setGeminiKey').value.trim()) body.geminiKey = $('#setGeminiKey').value.trim();
  if ($('#setLocalKey').value.trim()) body.localKey = $('#setLocalKey').value.trim();
  await api('PUT', '/api/settings', body);
  if (body.freeMode?.enabled || body.provider === 'cli') state.parallelMode = false;
  refreshQuotaBadge();
  setPreviewBase(body.previewIsolation);
  reloadPreview();
  toast('설정을 저장했습니다');
});

async function refreshQuotaBadge() {
  const el = $('#quotaBadge');
  if (!el) return;
  try {
    const q = await api('GET', '/api/quota');
    const fm = q.freeMode || {};
    const ai = q.aiStatus;
    const cap = fm.enabled && fm.dailyLimit > 0 ? `/${fm.dailyLimit}` : '';
    if (ai && !ai.ready) {
      el.textContent = '🟠 AI 연결 필요';
      el.classList.add('ai-warn');
      el.classList.remove('ai-ready', 'free-on', 'near-cap');
    } else {
      const name = ai?.label ? `${ai.label} · ` : '';
      el.textContent = fm.enabled ? `🟢 ${name}무료 ${q.calls}${cap}회` : `🟢 ${name}${q.calls}회`;
      el.classList.add('ai-ready');
      el.classList.remove('ai-warn');
      el.classList.toggle('free-on', Boolean(fm.enabled));
      el.classList.toggle('near-cap', Boolean(fm.enabled && fm.dailyLimit > 0 && q.calls >= fm.dailyLimit * 0.8));
    }
    const tk = q.tokens ? ` · 토큰 약 ${(q.tokens / 1000).toFixed(1)}K` : '';
    el.title = `현재 AI: ${ai?.label || '-'} · 오늘(${q.day}) ${q.calls}회${tk} (클릭해서 AI 설정)`;
  } catch {}
}
$('#quotaBadge')?.addEventListener('click', () => $('#btnSettings')?.click());

// ───────────── 시작 ─────────────
function syncPreviewBusy() {
  preview.contentWindow?.postMessage({ type: 'busy-regions', regions: [...state.busy] }, '*');
}
preview?.addEventListener('load', syncPreviewBusy);

function renderAll() {
  renderTopbar();
  renderDeviceSeg();
  renderCanvas();
  renderList();
  renderInspector();
  syncPreviewBusy();
}

// ───────────── 내장 AI 검증 봇 (실시간 진행 로그 · 빠른 검증 · 2회 자가치유 · 에이전트용 리포트 복사) ─────────────
$('#btnAiQaBot')?.addEventListener('click', async () => {
  const pending = dialog('🤖 내장 AI 검증 봇', `<div id="qaBotBody"></div>`, '닫기');
  $('#dlg').classList.add('wide');

  const box = () => $('#qaBotBody');
  let qaBusy = false;
  let qaAborted = false;
  let qaLogs = [];
  let qaStartAt = 0;
  let qaTimer = null;
  let qaStatus = '';
  let qaRanRounds = 0;

  const pushLog = (line) => {
    const sec = qaStartAt ? Math.floor((Date.now() - qaStartAt) / 1000) : 0;
    const stamp = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    qaLogs.push(`[${stamp}] ${line}`);
    const pre = $('#qaLiveLog');
    if (pre) {
      pre.textContent = qaLogs.join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
  };
  const stopQaTimer = () => { clearInterval(qaTimer); qaTimer = null; };
  const startQaTimer = (label) => {
    qaStatus = label;
    if (!qaStartAt) qaStartAt = Date.now();
    stopQaTimer();
    qaTimer = setInterval(() => {
      const el = $('#qaElapsed');
      if (el) el.textContent = `${Math.floor((Date.now() - qaStartAt) / 1000)}초 경과`;
    }, 500);
  };

  const renderBot = () => {
    const r = state.verify.report;
    const c = r ? countVerifyIssues(r) : null;
    const briefing = r && !r.ok ? buildVerifyFailureBriefing(r, proj.wf?.checklist || [], qaRanRounds || 1) : null;
    const mode = proj.verifyDataMode || 'mock';
    const elapsed = qaStartAt ? Math.floor((Date.now() - qaStartAt) / 1000) : 0;
    box().innerHTML = `
      <div class="wf-examples" style="margin-bottom:6px">
        <span class="muted small-note">📦 검증용 추가 자료:</span>
        <button type="button" class="wf-ex-chip ${mode === 'mock' ? 'on' : ''}" data-qa-data="mock" ${qaBusy ? 'disabled' : ''}>🧪 가상 자료 자동 생성</button>
        <button type="button" class="wf-ex-chip ${mode === 'upload' ? 'on' : ''}" data-qa-data="upload" ${qaBusy ? 'disabled' : ''}>📎 내 자료 직접 업로드${proj.verifyUpload ? ` (${esc(proj.verifyUpload.name)})` : ''}</button>
        <input type="file" id="qaDataInput" accept=".txt,.json,.csv,.md,.html,.pdf,.png,.jpg,.jpeg,.webp" hidden>
      </div>
      <div class="actions" style="flex-wrap:wrap;margin-bottom:8px">
        <button type="button" class="btn primary" id="qaRun2" ${qaBusy ? 'disabled' : ''}>${qaBusy ? '🔍 2단 검증 · 자동 수정 진행 중…' : `🤖 2단 검증 시작 (빠른 검증 → 심층 시나리오 최대 ${VERIFY_MAX_ROUNDS}회)`}</button>
        ${qaBusy ? `<button type="button" class="btn danger" id="qaAbort">⏹ 중단</button>` : ''}
        ${!qaBusy && r?.ok ? `<button type="button" class="btn primary" id="qaExportNow">📦 지금 바로 내보내기</button><button type="button" class="btn" id="qaRunMore">🔬 새 심층 시나리오로 더 검증</button>` : ''}
      </div>
      ${qaBusy ? `<div class="wf-progress" style="margin-bottom:8px"><div class="wf-prog-head"><b>⏳ ${esc(qaStatus)}</b><span class="muted" id="qaElapsed">${elapsed}초 경과</span></div></div>` : qaStatus ? `<p class="small-note" style="margin:4px 0 8px"><b>${esc(qaStatus)}</b></p>` : ''}
      ${qaLogs.length ? `<pre class="log" id="qaLiveLog" style="max-height:130px;margin:0 0 8px">${esc(qaLogs.join('\n'))}</pre>` : ''}
      ${c ? `<div class="wf-kpi-row" style="margin-bottom:8px">
        <div class="wf-kpi"><b style="color:${c.totalErrors ? 'var(--danger)' : 'var(--ok)'}">${c.totalErrors}건</b><span>발견된 오류</span></div>
        <div class="wf-kpi"><b>${c.testPass}/${c.testsTotal}</b><span>가상 시나리오 통과</span></div>
        <div class="wf-kpi"><b style="color:${r.ok ? 'var(--ok)' : 'var(--danger)'}">${r.ok ? '배포 가능' : '수정 필요'}</b><span>최종 판정</span></div>
      </div>` : ''}
      ${!qaBusy && r?.ok ? `<div class="wf-fold" style="border-color:color-mix(in srgb, var(--ok) 55%, var(--line))"><b class="ok">✅ 가상 AI 검증을 모두 통과했습니다!</b><p class="muted small-note">지금 바로 내보내기하거나, 새 시나리오로 한 번 더 검증할 수 있습니다.</p></div>` : ''}
      ${!qaBusy && briefing ? `<div class="wf-fold" style="border-color:color-mix(in srgb, var(--danger) 55%, var(--line))">
        <b class="err">📋 검증 미통과 원인 브리핑 (${briefing.reasons.length}건)</b>
        <p class="muted small-note" style="margin:4px 0">${esc(briefing.summary)}</p>
        <ul class="reorg-list" style="max-height:20vh;overflow:auto">${briefing.reasons.map((x) => `<li><span class="badge-soft">${esc(x.kind)}</span> <span>${esc(x.text)}</span></li>`).join('')}</ul>
      </div>` : ''}
    `;
    const pre = $('#qaLiveLog');
    if (pre) pre.scrollTop = pre.scrollHeight;
  };

  const runBot = async ({ autoHeal = true, forceRegen = false } = {}) => {
    if (qaBusy) return;
    qaBusy = true;
    qaAborted = false;
    qaLogs = [];
    qaStartAt = Date.now();
    qaRanRounds = 0;
    const leafIds = allRegions().filter((x) => !isContainer(x)).map((x) => x.id);
    const dataNote = verifyDataContextNote();
    let vr = null;
    let ranRounds = 0;

    try {
      // ── 1단계: 빠른 검증 (문법 · 중복 ID · 영역 연결 · 로컬 호환성 · 기본 스모크) ──
      if (!forceRegen) {
        startQaTimer('1단계/2 ⚡ 빠른 검증 (문법 · 연결 · 로컬호환 · 기본 스모크) 중…');
        renderBot();
        pushLog('⚡ [1단계: 빠른 검증] 기본 스모크 테스트 준비 및 정적·로컬 호환성 점검 시작…');
        await api('POST', '/api/tests/auto', { append: false }).catch(() => {});
        for (let q = 1; q <= 2; q++) {
          if (qaAborted) throw new Error('사용자가 검증을 중단했습니다');
          vr = await api('POST', '/api/workflow/verify-features', { runBrowser: true });
          state.verify.report = vr.report;
          proj.wf = vr.workflow;
          const qc = countVerifyIssues(vr.report);
          pushLog(`✓ [1단계 ${q}/2차] 빠른 검증 완료 — 오류 ${qc.totalErrors}건 (로컬불가 ${qc.localErr}건), 스모크 ${qc.testPass}/${qc.testsTotal} 통과`);
          if (vr.report.ok || !autoHeal || q >= 2 || qaAborted) break;
          const qFail = extractFailingRegions(vr.report, leafIds, state.files);
          if (!qFail.size) break;
          let qi = 0;
          for (const [rid, issues] of qFail.entries()) {
            if (qaAborted) break;
            qi++;
            const title = region(rid)?.title || rid;
            startQaTimer(`🩺 [1단계 빠른 수정] ${qi}/${qFail.size} · ${title}`);
            renderBot();
            pushLog(`🩺 [1단계 수정 ${qi}/${qFail.size}] ${title}(#${rid}) 기본 오류 ${issues.length}건 수정 중…`);
            const fixReq = `1단계 빠른 검증에서 이 영역(${rid})에 문제가 발견되었습니다. 로컬 단독 실행이 가능하도록 수정하세요:\n${issues.map((x) => `- ${x}`).join('\n')}${dataNote}`;
            const fr = await generateRegion(rid, fixReq, '1단계 빠른 검증 자동 수정', { review: false });
            pushLog(fr.ok ? `✓ [1단계] ${title} 수정 완료` : `✗ [1단계] ${title} 수정 실패: ${fr.error}`);
          }
        }
      }
      if (qaAborted) throw new Error('사용자가 검증을 중단했습니다');

      // ── 2단계: 심층 시나리오 검증 (요구사항 기반 AI 시나리오 6~10개 + 최대 5회 자동 수정) ──
      startQaTimer('2단계/2 🔬 심층 사용자 시나리오 생성 중…');
      renderBot();
      pushLog('🔬 [2단계: 심층 시나리오 검증] 내장 AI에게 화면별 심층 사용자 시나리오 생성을 요청했습니다…');
      try {
        const gen = await api('POST', '/api/tests/generate', { depth: 'deep' });
        pushLog(`✓ 심층 AI 시나리오 ${gen.tests?.length || 0}개 생성 완료`);
      } catch (e) {
        pushLog(`⚠ 심층 시나리오 생성 실패(${e.message}) → 기본 스모크 테스트 유지`);
      }
      if (qaAborted) throw new Error('사용자가 검증을 중단했습니다');

      for (let round = 1; round <= VERIFY_MAX_ROUNDS; round++) {
        if (qaAborted) throw new Error('사용자가 검증을 중단했습니다');
        ranRounds = round;
        qaRanRounds = round;
        startQaTimer(`2단계/2 🔬 [${round}/${VERIFY_MAX_ROUNDS}차] 심층 시나리오 브라우저 검증 중…`);
        renderBot();
        pushLog(`🔬 [2단계 ${round}/${VERIFY_MAX_ROUNDS}차] 심층 시나리오 · 로컬 호환성 · 런타임 검증 실행 중…`);
        vr = await api('POST', '/api/workflow/verify-features', { runBrowser: true });
        state.verify.report = vr.report;
        proj.wf = vr.workflow;
        const c = countVerifyIssues(vr.report);
        pushLog(`✓ [2단계 ${round}/${VERIFY_MAX_ROUNDS}차] 검증 완료 — 오류 ${c.totalErrors}건, 심층 시나리오 ${c.testPass}/${c.testsTotal} 통과`);
        if (vr.report.ok || !autoHeal || round >= VERIFY_MAX_ROUNDS || qaAborted) break;

        const failing = extractFailingRegions(vr.report, leafIds, state.files);
        if (!failing.size) {
          pushLog('⚠ 자동 매핑 가능한 실패 영역이 없어 반복 수정을 종료합니다.');
          break;
        }
        let idx = 0;
        const total = failing.size;
        for (const [rid, issues] of failing.entries()) {
          if (qaAborted) break;
          idx++;
          const title = region(rid)?.title || rid;
          startQaTimer(`🩺 [2단계 ${round}차 수정] ${idx}/${total} · ${title}`);
          renderBot();
          pushLog(`🩺 [2단계 ${round}차 ${idx}/${total}] ${title}(#${rid}) 수정 요청 (${issues.length}건)…`);
          const fixReq = `2단계 심층 검증(${round}/${VERIFY_MAX_ROUNDS}차)에서 이 영역(${rid})에 문제가 발견되었습니다. 기존 기능을 유지하며 수정하세요:\n${issues.map((x) => `- ${x}`).join('\n')}${dataNote}`;
          const fr = await generateRegion(rid, fixReq, `심층 검증 ${round}차 자가치유`, { review: false });
          pushLog(fr.ok ? `✓ [2단계 ${round}차 ${idx}/${total}] ${title} 수정 완료` : `✗ [2단계 ${round}차 ${idx}/${total}] ${title} 수정 실패: ${fr.error}`);
        }
      }
      reloadPreview();
      qaStatus = vr?.report?.ok
        ? `✅ 1단계 빠른 검증 + 2단계 심층 검증(${ranRounds}차) 모두 통과! 바로 내보내거나 새 시나리오로 더 검증할 수 있습니다.`
        : `⚠ 2단 검증(${ranRounds}회) 후에도 남은 원인을 브리핑했습니다. 확인 후 다시 실행하거나 아래 프롬프트로 수정하세요.`;
    } catch (e) {
      pushLog(`❌ ${e.message}`);
      qaStatus = `❌ ${e.message}`;
    }
    stopQaTimer();
    qaBusy = false;
    renderBot();
  };

  box().addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.qaData) {
      proj.verifyDataMode = b.dataset.qaData;
      if (proj.verifyDataMode === 'upload') $('#qaDataInput')?.click();
      return renderBot();
    }
    if (b.id === 'qaAbort') {
      qaAborted = true;
      pushLog('⏹ 중단 요청됨 — 현재 진행 중인 단계가 끝나면 멈춥니다.');
      return;
    }
    if (b.id === 'qaRun2') return runBot({ autoHeal: true, forceRegen: false });
    if (b.id === 'qaRunMore') return runBot({ autoHeal: true, forceRegen: true });
    if (b.id === 'qaExportNow') { $('#dlg').close(); setTimeout(() => $('#btnExport')?.click(), 30); return; }
  });
  box().addEventListener('change', async (ev) => {
    if (ev.target.id !== 'qaDataInput') return;
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    const previewText = /^(text\/|application\/(json|xml|csv))|\.(txt|json|csv|md|html)$/i.test(file.type || file.name)
      ? (await file.text()).slice(0, 3500)
      : `(${file.type || '파일'}, ${Math.round(file.size / 1024)}KB)`;
    proj.verifyDataMode = 'upload';
    proj.verifyUpload = { name: file.name, size: file.size, preview: previewText };
    qaStatus = `📎 검증용 자료 "${file.name}" 첨부됨`;
    renderBot();
  });

  renderBot();
  await pending;
  stopQaTimer();
  qaAborted = true;
  $('#dlg').classList.remove('wide');
});

// ───────────── 미리보기 하단 수정·질문 프롬프트 & 오른쪽 실시간 진행·AI 대화 패널 (PR 영구 저장) ─────────────
let liveActivities = [];
let prSummaries = [];
let chatHistory = [];
let previewPromptMode = 'auto';

function fmtTime(ts) {
  if (!ts) return '';
  if (/^\d{2}:\d{2}:\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(11, 19);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function applyChatMemory(mem) {
  if (!mem) return;
  prSummaries = Array.isArray(mem.prs) ? mem.prs : [];
  liveActivities = (Array.isArray(mem.items) ? mem.items : []).map((it) => ({ ...it, ts: fmtTime(it.ts) }));
  chatHistory = liveActivities
    .filter((a) => a.kind === 'user' || a.kind === 'ai')
    .slice(-10)
    .map((a) => ({ role: a.kind === 'user' ? 'user' : 'assistant', text: a.text }));
  renderLivePanel();
}
async function loadChatMemory() {
  if (window.__WEB_STANDALONE__) return;
  try {
    const mem = await api('GET', '/api/chat/memory');
    applyChatMemory(mem);
  } catch {}
}
function setLiveState(text, active = false) {
  const b = $('#plStateBadge');
  if (!b) return;
  b.textContent = text;
  b.style.background = active ? 'var(--accent)' : '';
  b.style.color = active ? '#fff' : '';
}
function renderLivePanel() {
  const box = $('#plLiveLog');
  if (!box) return;
  const actionLabel = { edit: '✨ 수정', layout: '📐 배치', verify: '🤖 검증', export: '📦 내보내기', ask: '💬 질문', 'run-plan': '✅ 계획 실행', 'cancel-plan': '✕ 취소', 'focus-input': '💬 의견 입력' };
  const prHtml = prSummaries.map((pr) => `
    <details class="pl-pr-card">
      <summary><span>📌 ${esc(pr.title)}</span><span class="spacer"></span><span class="muted">${pr.itemCount || 0}건</span></summary>
      <ul>${(pr.changes || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="pl-pr-meta">
        ${(pr.regions || []).slice(0, 4).map((r) => `<span class="badge-soft">${esc(r)}</span>`).join('')}
        <span class="spacer"></span>
        <button type="button" class="btn tiny ghost" data-pr-archive="${esc(pr.id)}">📜 원본 로그 보기</button>
      </div>
    </details>`).join('');
  const itemsHtml = liveActivities.map((a, idx) => {
    if (a.kind === 'ai') {
      const opts = (a.options || []).map((o, oi) => `
        <button type="button" class="pl-opt-btn" data-pl-opt="${idx}:${oi}">
          <b><span class="badge-soft">${actionLabel[o.action] || '▶ 선택'}</span> ${esc(o.title)}</b>
          ${o.desc ? `<span>${esc(o.desc)}</span>` : ''}
        </button>`).join('');
      const aiHead = a.replyType === 'clarify' ? '🤔 AI가 의견을 묻습니다' : a.replyType === 'plan' ? '🧭 수정 계획 방향성 브리핑' : a.replyType === 'execute' ? '⚡ AI 실행 확인' : '🤖 AI 응답';
      return `<div class="pl-item ai ${a.replyType === 'clarify' || a.replyType === 'plan' ? 'clarify' : ''}">
        <div><time>${esc(fmtTime(a.ts))}</time><b>${aiHead}</b></div>
        <div class="pl-ai-text">${esc(a.text)}</div>
        ${opts ? `<div class="pl-opts"><span class="muted" style="font-size:11px">${a.replyType === 'plan' ? '이 방향으로 진행할까요?' : a.replyType === 'clarify' ? '원하는 방향을 고르거나 아래에 직접 답하세요:' : '진행방향을 선택하세요:'}</span>${opts}</div>` : ''}
      </div>`;
    }
    return `<div class="pl-item ${esc(a.kind)}"><time>${esc(fmtTime(a.ts))}</time>${esc(a.text)}</div>`;
  }).join('');
  box.innerHTML = (prHtml + itemsHtml) || '<span class="muted">아래 입력창에 <b>수정 요청</b>이나 <b>질문</b>을 적으면 변경 진행 상황과 AI 답변·진행방향 선택지가 여기에 표시됩니다.</span>';
  box.scrollTop = box.scrollHeight;
}
function pushLiveActivity(kind, text, extra = {}) {
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  liveActivities.push({ kind, ts, text, ...extra });
  if (liveActivities.length > 50) liveActivities.shift();
  renderLivePanel();
  if (!extra.skipPersist && !window.__WEB_STANDALONE__) {
    const screen = state.activeScreenId || '';
    api('POST', '/api/chat/memory', {
      kind,
      session: extra.session || 'integrated',
      screen,
      region: extra.region || '',
      text,
      options: extra.options,
    }).then((res) => {
      if (res?.compactedPr && res?.state) {
        applyChatMemory(res.state);
        toast(`📦 대화가 상한선을 넘어 ${res.compactedPr.id}로 요약·아카이브되었습니다`);
      }
    }).catch(() => {});
  }
}
function renderPreviewTarget() {
  const chipEl = $('#ppTargetChip');
  const boxEl = $('#plTargetBox');
  const info = state.inspected;
  if (!info) {
    if (chipEl) chipEl.hidden = true;
    if (boxEl) boxEl.hidden = true;
    return;
  }
  const title = region(info.region)?.title || info.region;
  if (chipEl) {
    chipEl.hidden = false;
    chipEl.innerHTML = `🎯 ${esc(title)} · ${esc(info.selector)} <button type="button" id="ppClearTarget" style="border:0;background:transparent;cursor:pointer;padding:0 2px">✕</button>`;
  }
  if (boxEl) {
    boxEl.hidden = false;
    boxEl.innerHTML = `<span><b>🎯 선택 요소</b>: ${esc(title)} <code class="mono">${esc(info.selector)}</code></span><button type="button" class="btn tiny ghost" id="plClearTarget">해제</button>`;
  }
}
document.addEventListener('click', (ev) => {
  if (ev.target.id === 'ppClearTarget' || ev.target.id === 'plClearTarget') {
    state.inspected = null;
    renderPreviewTarget();
  }
  const modeBtn = ev.target.closest?.('[data-pp-mode]');
  if (modeBtn) {
    previewPromptMode = modeBtn.dataset.ppMode || 'auto';
    document.querySelectorAll('[data-pp-mode]').forEach((b) => b.classList.toggle('on', b.dataset.ppMode === previewPromptMode));
    const btn = $('#btnPreviewPromptRun');
    if (btn) btn.textContent = previewPromptMode === 'question' ? '💬 질문하기' : previewPromptMode === 'edit' ? '✨ 수정 실행' : '✨ 전송';
  }
  const optBtn = ev.target.closest?.('[data-pl-opt]');
  if (optBtn) {
    const [aiIdx, optIdx] = optBtn.dataset.plOpt.split(':').map(Number);
    const opt = liveActivities[aiIdx]?.options?.[optIdx];
    if (!opt) return;
    if (opt.action === 'verify') return $('#btnAiQaBot')?.click();
    if (opt.action === 'export') return $('#btnExport')?.click();
    if (opt.action === 'run-plan') {
      if (!proj.plan?.steps?.length) return toast('실행할 대기 중인 계획이 없습니다', true);
      setLiveState('계획 실행 중…', true);
      pushLiveActivity('run', `⚡ 승인됨 — ${proj.plan.steps.length}개 단계 수정 실행 중…`, { session: 'integrated' });
      runPlan().then(() => {
        pushLiveActivity('ok', '✓ 승인된 수정 계획 실행 완료 — 미리보기를 갱신했습니다', { session: 'integrated' });
        reloadPreview();
        renderAll();
      }).catch((e) => {
        pushLiveActivity('err', `✗ 계획 실행 오류: ${e.message}`);
        toast(e.message, true);
      }).finally(() => setLiveState('대기 중', false));
      return;
    }
    if (opt.action === 'cancel-plan') {
      proj.plan = null;
      pushLiveActivity('ok', '✕ 수정 계획을 취소했습니다.', { session: 'integrated' });
      return;
    }
    if (opt.action === 'focus-input') {
      const inp = $('#previewPromptInput');
      if (inp) { inp.value = ''; inp.focus(); inp.placeholder = '💬 수정 계획의 방향을 어떻게 바꿀지 적어 주세요…'; }
      return;
    }
    runPreviewPrompt({ overrideText: opt.prompt || opt.title, overrideMode: opt.action === 'ask' ? 'question' : 'edit' });
  }
  const prArcBtn = ev.target.closest?.('[data-pr-archive]');
  if (prArcBtn) {
    const prId = prArcBtn.dataset.prArchive;
    api('GET', `/api/chat/memory/archive?pr=${encodeURIComponent(prId)}`).then(({ entries }) => {
      const body = (entries || []).map((e) => `<div class="pl-item ${esc(e.kind || 'ok')}"><time>${esc(fmtTime(e.ts))}</time><b>[${esc(e.session || 'chat')}${e.region ? '/' + esc(e.region) : ''}]</b> <span style="white-space:pre-wrap">${esc(e.text || '')}</span></div>`).join('') || '<p class="muted">저장된 원본 로그가 없습니다.</p>';
      const p = dialog(`📜 ${prId} 원본 아카이브 (${entries?.length || 0}건)`, `<div style="display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow:auto">${body}</div>`, '닫기');
      $('#dlg').classList.add('wide');
      p.then(() => $('#dlg').classList.remove('wide'));
    }).catch((e) => toast(e.message, true));
  }
});
$('#btnCompactPr')?.addEventListener('click', async (ev) => {
  const b = ev.currentTarget;
  b.disabled = true;
  b.textContent = '요약 중…';
  try {
    const res = await api('POST', '/api/chat/memory/compact', { keepRecent: 4 });
    if (res.compactedPr) {
      applyChatMemory(res.state);
      toast(`📦 ${res.compactedPr.title} 로 요약하고 원본을 로그에 보관했습니다`);
    } else {
      toast('요약할 이전 기록이 충분하지 않습니다 (5건 이상일 때 요약 가능)');
    }
  } catch (e) {
    toast(e.message, true);
  }
  b.disabled = false;
  b.textContent = '📦 PR 요약';
});

async function runPreviewPrompt({ overrideText = '', overrideMode = '' } = {}) {
  const inp = $('#previewPromptInput');
  const btn = $('#btnPreviewPromptRun');
  const text = (overrideText || inp?.value || '').trim();
  if (!text) return toast('질문하거나 수정할 내용을 아래 입력창에 적어 주세요', true);
  const forceMode = overrideMode || previewPromptMode;
  const route = classifySmartRequest(text, { hasInspected: Boolean(state.inspected), forceMode });
  const screenId = activeScreenOf(state.layout, state.activeScreenId).id;
  btn.disabled = true;

  const executeEdit = async (execKind, execText) => {
    setLiveState('수정 중…', true);
    if (execKind === 'inspect' && state.inspected?.region) {
      const rid = state.inspected.region;
      const fullReq = buildElementPrompt(state.inspected, execText);
      const res = await generateRegion(rid, fullReq, '', { review: false });
      pushLiveActivity(res.ok ? 'ok' : 'err', res.ok ? `✓ ${region(rid)?.title || rid} 요소 수정 완료` : `✗ 수정 실패: ${res.error}`, { session: `region:${rid}`, region: rid });
      state.inspected = null;
      renderPreviewTarget();
    } else if (execKind === 'layout') {
      const r = await api('POST', '/api/layout/ai-adjust', { instruction: execText, screenId });
      state.layout = r.layout;
      pushLiveActivity('ok', `✓ 배치 조정 완료: ${r.summary}`, { session: 'layout' });
    } else {
      proj.request = execText;
      pushLiveActivity('run', '🧭 통합 세션에서 수정 계획 방향성을 정리하는 중…', { session: 'integrated' });
      proj.plan = await api('POST', '/api/project/plan', { request: execText, images: toPayloadImages(proj.images) });
      const steps = proj.plan?.steps || [];
      const cleanDesc = (st) => {
        const raw = String(st.why || st.summary || st.prompt || '').split('\n')[0].trim();
        return raw.replace(/^(?:script\.js|style\.css|view\.html)(?:와|과|\s|,|만|\s*수정하세요\.?)+/i, '').trim().slice(0, 80) || '화면 동작·스타일 보완';
      };
      const lines = [
        proj.plan?.summary ? `요약: ${proj.plan.summary}` : '다음 순서로 수정을 진행할 계획입니다:',
        ...steps.map((st, i) => {
          const rid = st.target || st.region || st.id || st.regionId || '';
          const label = rid === 'shared:css' ? '공통 스타일' : rid ? (region(rid)?.title || rid) : '전체 화면';
          return `${i + 1}. [${label}] ${cleanDesc(st)}`;
        }),
      ];
      if (!steps.length) lines.push('(변경할 세부 단계가 비어 있습니다. 요청을 조금 더 구체적으로 적어 주세요.)');
      pushLiveActivity('ai', lines.join('\n'), {
        session: 'integrated',
        replyType: 'plan',
        options: steps.length ? [
          { title: `이 계획대로 실행 (${steps.length}개 단계)`, desc: '안내된 영역들을 순서대로 수정하고 미리보기에 반영합니다.', action: 'run-plan', prompt: '' },
          { title: '방향 수정 의견 보내기', desc: '계획을 실행하지 않고 아래 입력창에 원하는 방향을 추가로 알려줍니다.', action: 'focus-input', prompt: '' },
          { title: '계획 취소', desc: '이번 수정 계획을 취소합니다.', action: 'cancel-plan', prompt: '' },
        ] : [],
      });
      return;
    }
    reloadPreview();
    renderAll();
  };

  try {
    // '자동' 모드(요소 직접 찍기 제외) 또는 '질문' 모드: 양방향 소통 (AI가 답하거나, 모호하면 먼저 의견을 묻고, 명확하면 바로 실행)
    const useTwoWay = forceMode === 'question' || (forceMode === 'auto' && !state.inspected);
    if (inp) inp.value = '';
    if (useTwoWay) {
      setLiveState('소통 중…', true);
      pushLiveActivity('user', `💬 ${text}`, { skipPersist: true });
      chatHistory.push({ role: 'user', text });
      const r = await api('POST', '/api/chat/ask', {
        question: text,
        screenId,
        inspected: state.inspected,
        allowExecute: forceMode === 'auto',
        history: chatHistory.slice(-8),
      });
      chatHistory.push({ role: 'assistant', text: r.answer });
      if (r.memory) applyChatMemory(r.memory);
      else pushLiveActivity('ai', r.answer, { replyType: r.replyType, options: r.options || [], skipPersist: true });
      if (r.compactedPr) toast(`📦 대화가 상한선을 넘어 ${r.compactedPr.id}로 요약·아카이브되었습니다`);
      if (r.replyType === 'execute' && forceMode === 'auto') {
        await executeEdit(r.executeAction === 'layout' ? 'layout' : 'feature', r.executePrompt || text);
      }
    } else {
      pushLiveActivity('run', `▶ [${route.label}] ${text}`);
      await executeEdit(route.kind, text);
    }
  } catch (e) {
    pushLiveActivity('err', `✗ 오류: ${e.message}`);
    toast(e.message, true);
  }
  setLiveState('대기 중', false);
  btn.disabled = false;
}
$('#btnPreviewPromptRun')?.addEventListener('click', runPreviewPrompt);
$('#previewPromptInput')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); runPreviewPrompt(); }
});
$('#btnPreviewPromptCopy')?.addEventListener('click', async () => {
  const curProj = $('#projectSel')?.value || 'my-app';
  const sc = activeScreenOf(state.layout, state.activeScreenId);
  const info = state.inspected;
  const req = ($('#previewPromptInput')?.value || '').trim();
  const lines = [
    '[웹앱제작기 수정 요청]',
    `- 프로젝트: projects/${curProj}`,
    `- 화면: ${sc.title || sc.id} (#${sc.id})`,
  ];
  if (info) {
    lines.push(`- 영역: ${region(info.region)?.title || info.region} (projects/${curProj}/regions/${info.region}/)`);
    lines.push(`- 선택 요소: ${info.selector} (<${info.tag}>${info.text ? `, 텍스트: "${info.text.slice(0, 60)}"` : ''})`);
  }
  lines.push(`- 요청 내용: ${req || '(여기에 수정 요청을 입력하세요)'}`);
  await navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
  pushLiveActivity('ok', '📋 Claude Code / Antigravity용 수정 지시 복사 완료');
  toast('📋 클립보드에 복사했습니다! Claude Code / Antigravity에 바로 붙여넣으세요');
});

// ───────────── 파일 변경 자동 감지 (Live Reload) ─────────────
let liveWatchSrc = null;
function startLiveWatch() {
  if (window.__WEB_STANDALONE__ || typeof EventSource === 'undefined') return;
  try { liveWatchSrc?.close(); } catch {}
  liveWatchSrc = new EventSource('/api/watch');
  liveWatchSrc.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'change') return;
    const badge = $('#liveReloadBadge');
    if (badge) {
      badge.textContent = `● 갱신됨 (${msg.file.split('/').pop()})`;
      badge.classList.add('pulse');
      setTimeout(() => { badge.textContent = '● 자동 갱신'; badge.classList.remove('pulse'); }, 1800);
    }
    pushLiveActivity('ok', `↻ 파일 변경 감지: ${msg.file}`);
    if (msg.file === 'layout.json') {
      state.layout = await api('GET', '/api/layout').catch(() => state.layout);
      renderAll();
      fitCanvas();
    }
    reloadPreview();
  };
}

function setProMode(on) {
  const flag = Boolean(on);
  document.body.classList.toggle('pro-mode', flag);
  $('#btnProMode')?.classList.toggle('on', flag);
  try { localStorage.setItem('ide-pro-mode', flag ? '1' : '0'); } catch {}
  if (!flag && !['design', 'preview'].includes($('#workspace')?.dataset.mode)) setView('preview');
  fitCanvas();
}
$('#btnProMode')?.addEventListener('click', () => setProMode(!document.body.classList.contains('pro-mode')));

async function boot() {
  setToastContext(() => ({ selected: state.selected }));
  initHistoryPanels();
  initFieldErrorsPanel({
    // 실사용 오류 → 검증 세션에서 다시 검증(오류 목록 포함) → 실패 영역 자동 수정 루프
    heal: async () => {
      await switchSessionMode('verify');
      await runVerifySession();
      await runAutoHealLoop();
      refreshFieldErrorBadge();
    },
  });
  initSkillsPanel({
    reloadPreview: () => reloadPreview(),
    appendAppPrompt: (text) => {
      // 같은 양식을 다시 넣으면 앞에 넣은 것을 새 분석으로 바꾼다 (설명에 같은 표가 여러 번 쌓이지 않게)
      const head = text.split('\n')[0];
      const blocks = (state.layout.appPrompt || '').split(/\n{2,}(?=# )/).filter((b) => b.split('\n')[0] !== head);
      state.layout.appPrompt = `${blocks.join('\n\n').trim()}\n\n${text}`.trim();
      saveLayout(true);
      renderAll();
    },
  });
  try { setProMode(localStorage.getItem('ide-pro-mode') === '1'); } catch { setProMode(false); }
  renderProjects().catch((e) => toast(e.message, true));
  refreshQuotaBadge();
  const s = await api('GET', '/api/settings');
  if (s.freeMode?.enabled || s.provider === 'cli') state.parallelMode = false;
  setPreviewBase(s.previewIsolation === true);
  state.layout = await api('GET', '/api/layout');
  state.activeScreenId = activeScreenOf(state.layout).id;
  await Promise.all([...allRegions().map((r) => loadRegion(r.id)), refreshSessions(), loadChatMemory()]);
  let view = 'preview';
  try { view = localStorage.getItem('ide-view') || 'preview'; } catch {}
  if (!document.body.classList.contains('pro-mode') && !['design', 'preview'].includes(view)) view = 'preview';
  setView(view);
  renderAll();
  fitCanvas();
  startLiveWatch();
}

// ───────────── 개발 단계 전체 행동·오류 자동 로깅 ─────────────
window.addEventListener('error', (ev) => {
  clientLog('window-error', { message: ev.message, file: ev.filename, line: ev.lineno });
});
window.addEventListener('unhandledrejection', (ev) => {
  clientLog('unhandled-rejection', { message: ev.reason?.message || String(ev.reason || '') });
});
document.addEventListener('click', (ev) => {
  const b = ev.target.closest?.('button, [data-screen-id], [data-preview-screen]');
  if (!b || b.closest('#logBody')) return;
  const target = b.id || b.dataset.wfStep && `wf-step:${b.dataset.wfStep}` || b.dataset.view && `view:${b.dataset.view}` ||
    b.dataset.layoutPreset && `preset:${b.dataset.layoutPreset}` || b.dataset.styleKit && `style:${b.dataset.styleKit}` ||
    b.dataset.previewScreen && `preview-screen:${b.dataset.previewScreen}` || b.dataset.screenId && `screen:${b.dataset.screenId}` ||
    b.dataset.rcmd && `region-cmd:${b.dataset.rcmd}` || b.dataset.verifyData && `verify-data:${b.dataset.verifyData}`;
  if (!target) return;
  clientLog('ui-action', { target, label: (b.textContent || '').trim().slice(0, 40), view: $('#workspace')?.dataset.mode || '', step: proj.wf?.step || 1, screen: state.activeScreenId || '' });
}, true);

boot().catch((e) => toast(e.message, true));
