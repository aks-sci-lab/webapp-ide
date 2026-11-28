// 기능 탐색 점검: AI 가 쓴 테스트와 상관없이, 실제 브라우저에서 영역마다 입력칸을 채우고 버튼을 눌러 보고
// 새로고침까지 해 본다. 찾는 것: 누르면 오류가 나는 버튼(아무것도 넣지 않은 처음 상태·두 번째 클릭 포함),
// 눌러도 아무 반응이 없는 버튼, 자기가 저장한 데이터가 있는데 새로고침하면 처음 화면으로 돌아가거나 입력칸이 비는 영역.
//
// 방식: 작은 서버가 "/" 에 탐색기 페이지, "/app" 에 만든 앱을 준다. 탐색기는 앱을 같은 출처의 iframe 으로 열어
// 조작하고(새로고침해도 localStorage 가 남음), 결과를 DOM 에 적는다. 브라우저는 --dump-dom 으로 그 결과를 읽어 온다.
import { execFile } from 'node:child_process';
import http from 'node:http';
import { buildApp } from './build.js';
import { SANDBOX_ARGS } from './shot.js';

// 앱 안에 넣는 훅: 오류 모으기, 대화상자·인쇄·파일 고르기·내려받기·페이지 이동이 탐색을 멈추지 않게 막기
const APP_HOOK = `<script>
(() => {
  const errs = window.__exploreErrors = [];
  const fx = window.__exploreEffects = [];
  window.__ideRegionError = (id, e) => {
    if (e && typeof e === 'object') { if (e.__ideRecorded) return; try { e.__ideRecorded = true; } catch {} }
    errs.push({ region: id, message: (e && e.message) || String(e) });
  };
  window.addEventListener('error', (e) => { if (e.error && e.error.__ideRecorded) return; if (!/ResizeObserver loop/.test(e.message)) errs.push({ region: null, message: e.message }); });
  window.addEventListener('unhandledrejection', (e) => errs.push({ region: null, message: String((e.reason && e.reason.message) || e.reason || 'Promise rejected') }));
  window.alert = (m) => fx.push('알림창: ' + String(m).slice(0, 60));
  window.confirm = (m) => { fx.push('확인창: ' + String(m).slice(0, 60)); return true; };
  window.prompt = (m, d) => { fx.push('입력창: ' + String(m).slice(0, 60)); return d == null ? '테스트' : d; };
  window.print = () => fx.push('인쇄');
  window.open = () => { fx.push('새 창'); return null; };
  const inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') { fx.push('파일 고르기'); return; } return inputClick.call(this); };
  const aClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download || /^blob:|^data:/.test(this.href)) { fx.push('내려받기'); return; } return aClick.call(this); };
  document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a && !a.getAttribute('href').startsWith('#')) { e.preventDefault(); fx.push('링크 이동'); } }, true);
  document.addEventListener('submit', (e) => { e.preventDefault(); fx.push('폼 제출'); }, true);

  // 점검이 선생님의 실제 구글 시트·외부 서버로 시험 데이터를 보내지 않게 다른 출처로 나가는 요청은 막는다
  // (막은 것도 버튼의 "반응" 으로 친다). 같은 출처 요청은 그대로 둔다
  const external = (u) => { try { return new URL(String(u), location.href).origin !== location.origin; } catch { return false; } };
  const blocked = () => new TypeError('Failed to fetch (점검 중에는 외부로 보내지 않음)');
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (external(u)) { fx.push('외부 전송 막음'); return Promise.reject(blocked()); }
    return origFetch.apply(this, arguments);
  };
  const xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__ideExt = external(u); return xOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (!this.__ideExt) return xSend.apply(this, arguments);
    fx.push('외부 전송 막음');
    setTimeout(() => { try { this.dispatchEvent(new ProgressEvent('error')); if (this.onerror) this.onerror(new ProgressEvent('error')); } catch {} }, 0);
  };
  if (navigator.sendBeacon) { const sB = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (u, d) => { if (external(u)) { fx.push('외부 전송 막음'); return false; } return sB(u, d); }; }

  // 반복 타이머(setInterval)와 이벤트 처리기를 센다: 누를 때마다 하나씩 더 생기는지 보려고
  const ivs = window.__exploreIntervals = new Set();
  window.__exploreTimers = 0;
  const sI = window.setInterval, cI = window.clearInterval, sT = window.setTimeout, cT = window.clearTimeout;
  window.setInterval = function () { const id = sI.apply(window, arguments); ivs.add(id); window.__exploreTimers++; return id; };
  window.clearInterval = function (id) { if (ivs.delete(id)) window.__exploreTimers++; return cI.call(window, id); };
  window.setTimeout = function (fn, ms) { if (Number(ms) >= 300) window.__exploreTimers++; return sT.apply(window, arguments); };
  window.clearTimeout = function (id) { ivs.delete(id); return cT.call(window, id); };
  window.__exploreStopIntervals = (keep) => { for (const id of [...ivs]) if (!keep || !keep.has(id)) { ivs.delete(id); cI.call(window, id); } };
  const reg = new WeakMap();
  window.__exploreDup = { count: 0, region: '' };
  const aEL = EventTarget.prototype.addEventListener, rEL = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opt) {
    try {
      if (fn && !(opt && typeof opt === 'object' && opt.once)) {
        let m = reg.get(this); if (!m) reg.set(this, (m = new Map()));
        const s = m.get(type) || new Set();
        if (!s.has(fn)) {
          if (s.size >= 1) { window.__exploreDup.count++; window.__exploreDup.region = (this.closest && this.closest('section[data-region]')?.dataset.region) || ''; }
          s.add(fn); m.set(type, s);
        }
      }
    } catch {}
    return aEL.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function (type, fn) {
    try { reg.get(this)?.get(type)?.delete(fn); } catch {}
    return rEL.apply(this, arguments);
  };
})();
</script>`;

// 탐색기 페이지 (부모). limits: 영역당 누를 요소 수, 전체 누를 수
function explorerPage({ perRegion = 12, total = 80 } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="f" src="/app" style="width:1366px;height:768px;border:0"></iframe>
<script>
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const f = document.getElementById('f');
  const loaded = () => new Promise((r) => f.addEventListener('load', () => r(), { once: true }));
  const W = () => f.contentWindow;
  const D = () => f.contentDocument;
  const out = { regions: {}, pageErrors: [], notes: [] };
  const R = (id) => (out.regions[id] ||= { id, filled: 0, clicks: [], errors: [], reload: [], warnings: [], security: [] });
  const pushOnce = (list, item) => { if (!list.some((x) => x.message === item.message)) list.push(item); };
  const takeErrors = () => { const e = W().__exploreErrors || []; return e.splice(0, e.length); };
  const takeEffects = () => { const e = W().__exploreEffects || []; return e.splice(0, e.length); };
  const visible = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight));
  const regionOf = (el) => el.closest('section[data-region]')?.dataset.region || '';
  const leafSections = () => [...D().querySelectorAll('#app section[data-region]')].filter((s) => !s.querySelector('section[data-region]'));
  // 글자 조각을 띄어 쓰며 모은다. innerText 는 숨은 탭에서 비어 버리고, textContent 는 표 칸 글자를 붙여 버린다
  const fullText = (el) => {
    const w = D().createTreeWalker(el, 4);
    const parts = [];
    while (w.nextNode()) { const t = w.currentNode.nodeValue.trim(); if (t) parts.push(t); }
    return parts.join(' ').replace(/\\s+/g, ' ');
  };
  const textOf = (sec) => {
    const vals = [...sec.querySelectorAll('input,textarea,select')].map((i) => i.type === 'checkbox' || i.type === 'radio' ? (i.checked ? '1' : '0') : i.value).join('|');
    return fullText(sec) + '#' + vals;
  };
  const snapshotRegions = () => Object.fromEntries(leafSections().map((s) => [s.dataset.region, textOf(s)]));
  // 글을 적는 칸의 값 (새로고침 뒤 "명단은 돌아왔는데 점수칸만 비어 있음" 을 찾을 때 씀)
  const TEXTY = (i) => !['checkbox', 'radio', 'file', 'hidden', 'button', 'submit', 'reset', 'image'].includes((i.type || '').toLowerCase());
  const valuesOf = (sec) => [...sec.querySelectorAll('input,textarea')].filter(TEXTY).map((i) => i.value);
  const snapshotValues = () => Object.fromEntries(leafSections().map((s) => [s.dataset.region, valuesOf(s)]));
  // 오류 수집기가 쓰는 기록(__ideErrors:)은 앱 데이터가 아니므로 뺀다
  const storage = () => { try { const ls = W().localStorage; return Object.keys(ls).filter((k) => !k.startsWith('__ideErrors:')).sort().map((k) => k + '=' + ls.getItem(k)).join('\\n'); } catch { return ''; } };
  const storageItems = () => { try { const ls = W().localStorage; return Object.keys(ls).map((k) => [k, ls.getItem(k)]); } catch { return []; } };
  const restoreStorage = (items) => { try { const ls = W().localStorage; ls.clear(); for (const [k, v] of items) ls.setItem(k, v); } catch {} };
  const appState = () => (D().querySelector('#app')?.innerText || '') + '|' + D().querySelectorAll('#app *').length + '|' + [...D().querySelectorAll('#app input,#app textarea,#app select')].map((i) => i.value + (i.checked ? '1' : '')).join(',') + '|' + [...D().querySelectorAll('#app [class]')].map((e) => e.className).join(' ').length + '|' + storage().length;
  const labelOf = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    return (el.id ? '#' + el.id + ' ' : '') + (t ? '"' + t + '"' : el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : ''));
  };
  const nearLabel = (el) => {
    const id = el.id && D().querySelector('label[for="' + el.id + '"]');
    return ((id && id.innerText) || el.closest('label')?.innerText || el.placeholder || el.name || el.id || '').toLowerCase();
  };
  // mode: 없음(보통 값) · 'alt'(탭 전환 점검용 다른 값) · 'xss'(태그·javascript: 글자) · { edge: '0' }(숫자 칸 경계값)
  // null 을 돌려주면 그 칸은 건드리지 않는다
  const XSS_TEXT = '"\\'><b data-ide-xss="1">테스트</b>';
  const XSS_AREA = '김민수\\n<b data-ide-xss="1">이지영</b>\\n박하준';
  const XSS_URL = "javascript:void('ide-xss')";
  const sample = (el, mode) => {
    const hint = nearLabel(el);
    const t = (el.type || '').toLowerCase();
    if (mode === 'xss') {
      if (t === 'url') return XSS_URL;
      if (el.tagName === 'TEXTAREA') return XSS_AREA;
      return ['', 'text', 'search'].includes(t) ? XSS_TEXT : null;
    }
    if (mode && mode.edge != null) return t === 'number' || t === 'range' ? mode.edge : null;
    if (mode === 'alt') {
      if (t === 'number' || t === 'range') return el.min && Number(el.min) > 7 ? el.min : '7';
      if (el.tagName === 'TEXTAREA' || ['', 'text', 'search'].includes(t)) return el.tagName === 'TEXTAREA' && (/이름|명단|학생|name/.test(hint) || !hint) ? '최유진\\n정서연' : '탭전환확인';
    }
    if (el.tagName === 'TEXTAREA') return /이름|명단|학생|name/.test(hint) || !hint ? '김민수\\n이지영\\n박하준' : '테스트 내용입니다';
    if (t === 'number' || t === 'range') return el.min && Number(el.min) > 3 ? el.min : '3';
    if (t === 'date') return '2026-11-20';
    if (t === 'time') return '09:30';
    if (t === 'email') return 'test@example.com';
    if (t === 'tel') return '010-1234-5678';
    if (t === 'url') return 'https://example.com';
    if (t === 'color') return '#3366ff';
    if (/이름|name|학생/.test(hint)) return '김민수';
    if (/점수|숫자|개수|수량|score|count|번호/.test(hint)) return '3';
    return '테스트';
  };
  const fire = (el, type) => el.dispatchEvent(new (W().Event)(type, { bubbles: true }));
  const fillRegion = (sec, mode) => {
    let n = 0;
    for (const el of sec.querySelectorAll('input,textarea,select')) {
      if (!visible(el) || el.disabled || el.readOnly) continue;
      const t = (el.type || '').toLowerCase();
      if (['button', 'submit', 'reset', 'file', 'hidden', 'checkbox', 'radio', 'image'].includes(t)) continue;
      if (el.tagName === 'SELECT') { if (mode || el.options.length < 2) continue; el.selectedIndex = 1; }
      else { const v = sample(el, mode); if (v == null) continue; el.value = v; }
      fire(el, 'input'); fire(el, 'change');
      n++;
    }
    return n;
  };
  const clickables = (sec) => [...sec.querySelectorAll('button, input[type=button], input[type=submit], input[type=checkbox], input[type=radio], [role=button], [onclick]')]
    .filter((el) => visible(el) && !el.disabled && !el.closest('.no-print[id^="__ide"], #__ideBackupFab'));

  const onScreen = async (sec) => {
    const sc = sec.closest('.ide-screen[data-screen]');
    if (sc && sc.hidden && W().__ideApp?.navigate) { W().__ideApp.navigate(sc.dataset.screen, { silentHash: true }); await sleep(60); }
  };

  const reloadFrame = async () => {
    f.contentWindow.location.reload();
    await loaded();
    await sleep(250);
  };
  const closeDialogs = () => D().querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} });
  const errorsTo = (when, fallback, list = 'errors') => {
    for (const e of takeErrors()) { const id = e.region || fallback; (id ? R(id)[list] : out.pageErrors).push({ when, message: e.message }); }
  };

  // 화면에 NaN · undefined · [object Object] · Infinity 가 그대로 보이면 거의 항상 버그다
  const BAD = /\\bNaN\\b|\\bundefined\\b|\\[object Object\\]|\\bInfinity\\b/;
  const scanBadText = (when) => {
    for (const sec of leafSections()) {
      const t = fullText(sec);
      const m = t.match(BAD);
      if (!m) continue;
      const r = R(sec.dataset.region);
      if (r.errors.some((e) => e.kind === 'bad-text' && e.token === m[0])) continue;
      const near = t.slice(Math.max(0, m.index - 14), m.index + m[0].length + 14).trim();
      r.errors.push({ when, kind: 'bad-text', token: m[0], message: '화면에 "' + m[0] + '" 이(가) 그대로 보입니다: "…' + near + '…" (빈 값, 0으로 나누기, 없는 속성을 그대로 보여 주는지 확인)' });
    }
  };
  // 그림판이 화면에서는 자리를 차지하는데 실제 크기가 0 이면 아무것도 안 그려진다 (숨은 탭에서 clientWidth 로 크기를 잰 경우)
  const checkCanvas = (when) => {
    for (const cv of D().querySelectorAll('#app canvas')) {
      if (!visible(cv) || cv.clientWidth < 4 || cv.clientHeight < 4 || (cv.width > 0 && cv.height > 0)) continue;
      const id = regionOf(cv);
      if (!id || R(id).errors.some((e) => e.kind === 'canvas')) continue;
      R(id).errors.push({ when, kind: 'canvas', message: '그림판(canvas)이 화면에서는 ' + cv.clientWidth + '×' + cv.clientHeight + ' 인데 실제 크기가 ' + cv.width + '×' + cv.height + ' 이라 아무것도 그려지지 않습니다 (숨은 탭에서 시작할 때 clientWidth 로 크기를 정하면 0 이 됨 → 탭이 보일 때 크기를 다시 재기)' });
    }
  };
  const screensList = () => W().__ideApp?.screens || [];
  const go = async (sid) => { W().__ideApp.navigate(sid, { silentHash: true }); await sleep(80); };
  // 모든 탭을 한 번씩 열어 보며 그림판·이상한 글자를 확인한다
  const tour = async (when) => {
    const scs = screensList();
    if (scs.length > 1) {
      const cur = W().__ideApp.getScreen?.();
      for (const sc of scs) {
        await go(sc.id);
        errorsTo('"' + (sc.title || sc.id) + '" 탭 열기');
        checkCanvas(when + ' ("' + (sc.title || sc.id) + '" 탭)');
      }
      if (cur) await go(cur);
      errorsTo('탭 이동');
    } else checkCanvas(when);
    scanBadText(when);
    takeEffects();
  };
  const sectionOf = (id) => D().querySelector('section[data-region="' + id + '"]');

  // 0) 처음 화면
  await loaded();
  await sleep(250);
  for (const e of takeErrors()) (e.region ? R(e.region).errors : out.pageErrors).push({ when: '앱 시작', message: e.message });
  takeEffects();
  const items0 = storageItems();
  await tour('앱 시작');

  // 0-b) 아무것도 넣지 않은 처음 상태에서 버튼 눌러 보기 (명단이 비었을 때 계산 버튼 등).
  // 여기서는 오류만 본다. 끝나면 저장소를 처음대로 돌리고 새로고침해서 다음 점검에 영향이 없게 한다
  let emptyClicks = 0;
  for (const id of leafSections().map((s) => s.dataset.region)) {
    const seen = new Set();
    for (let i = 0; i < ${Math.max(1, Math.round(perRegion / 2))} && emptyClicks < ${Math.round(total / 2)}; i++) {
      const sec = D().querySelector('section[data-region="' + id + '"]');
      if (!sec) break;
      await onScreen(sec);
      const el = clickables(sec).find((x) => !seen.has(labelOf(x)));
      if (!el) break;
      const label = labelOf(el);
      seen.add(label);
      try { el.click(); } catch (e) { W().__exploreErrors.push({ region: id, message: e.message }); }
      await sleep(120);
      emptyClicks++;
      for (const e of takeErrors()) R(e.region || id).errors.push({ when: '빈 상태에서 ' + label + ' 클릭', message: e.message });
      takeEffects();
      closeDialogs();
    }
  }
  W().__exploreStopIntervals();
  scanBadText('빈 상태에서 버튼 클릭 뒤');

  // 0-c) 숫자 칸에 0 · 음수 · 빈 값을 넣고 버튼 눌러 보기 (0으로 나누기, new Array(-1), 빈 칸 → NaN 등)
  // 앞 단계에서 이미 한 번 누른 상태가 섞이지 않게 처음 상태로 다시 연다
  restoreStorage(items0);
  await reloadFrame();
  takeErrors(); takeEffects();
  let edgeClicks = 0;
  for (const id of leafSections().map((s) => s.dataset.region)) {
    let sec = sectionOf(id);
    if (!sec) continue;
    await onScreen(sec);
    if (![...sec.querySelectorAll('input[type=number],input[type=range]')].some(visible)) continue;
    for (const v of ['0', '-1', '']) {
      const vt = v === '' ? '빈 값' : v;
      sec = sectionOf(id);
      if (!sec) break;
      await onScreen(sec);
      fillRegion(sec, { edge: v });
      await sleep(40);
      for (const e of takeErrors()) pushOnce(R(e.region || id).errors, { when: '숫자 칸에 ' + vt + ' 입력', message: e.message });
      const seen = new Set();
      for (let i = 0; i < ${Math.max(1, Math.round(perRegion / 2))} && edgeClicks < ${Math.round(total / 2)}; i++) {
        sec = sectionOf(id);
        if (!sec) break;
        await onScreen(sec);
        const el = clickables(sec).find((x) => !seen.has(labelOf(x)));
        if (!el) break;
        const label = labelOf(el);
        seen.add(label);
        try { el.click(); } catch (e) { W().__exploreErrors.push({ region: id, message: e.message }); }
        await sleep(100);
        edgeClicks++;
        for (const e of takeErrors()) pushOnce(R(e.region || id).errors, { when: '숫자 칸에 ' + vt + ' 넣고 ' + label + ' 클릭', message: e.message });
        takeEffects();
        closeDialogs();
      }
      W().__exploreStopIntervals();
    }
  }
  restoreStorage(items0);
  await reloadFrame();
  takeErrors(); takeEffects();
  const pristine = snapshotRegions();
  const storage0 = storage();

  // 새로고침해서 화면이 처음으로 돌아간 영역 찾기. 그 영역이 직접 저장한 데이터가 있을 때만 본다
  // (다른 영역만 저장했는데 이 영역 입력칸이 비는 것은 저장하지 않는 칸일 수 있으므로 오류가 아니다)
  const reloadCheck = async (when, savedBy) => {
    const before = snapshotRegions();
    const beforeVals = snapshotValues();
    const storageBefore = storage();
    if (storageBefore === storage0) return; // 저장하는 데이터가 없으면 새로고침 뒤 처음 화면이 맞다
    await reloadFrame();
    for (const e of takeErrors()) (e.region ? R(e.region).errors : out.pageErrors).push({ when: when + ' 뒤 새로고침', message: e.message });
    takeEffects();
    const after = snapshotRegions();
    const afterVals = snapshotValues();
    for (const [id, txt] of Object.entries(after)) {
      if (!savedBy[id] || before[id] === undefined || before[id] === pristine[id]) continue;
      if (txt === pristine[id]) {
        R(id).reload.push({ when, message: '데이터가 저장돼 있는데 새로고침하면 이 영역이 처음 화면으로 돌아갑니다' });
        continue;
      }
      // 화면 틀은 돌아왔는데(예: 명단) 저장된 입력값이 칸에 다시 채워지지 않은 경우
      const bv = beforeVals[id] || [], av = afterVals[id] || [];
      const lost = bv.filter((v, i) => v.trim() && !(av[i] || '').trim() && (storageBefore.includes(v) || storageBefore.includes(JSON.stringify(v).slice(1, -1))));
      if (lost.length) R(id).reload.push({ when, kind: 'input', message: '입력한 값 ' + lost.length + '개가 저장되는데 새로고침하면 칸이 비어 있습니다 (저장한 키와 다시 읽는 키가 같은지 확인)' });
    }
    // 새로고침하고 나서야 저장된 데이터가 보이는 영역: 다른 영역(탭)이 바꾼 값을 시작할 때 한 번만 읽고 바뀔 때 다시 그리지 않음
    const words = (txt) => new Set(String(txt).split('#')[0].match(/[A-Za-z가-힣][A-Za-z가-힣0-9_]+/g) || []);
    for (const [id, txt] of Object.entries(after)) {
      if (before[id] === undefined || txt === before[id]) continue;
      const had = words(before[id]);
      const fresh = [...words(txt)].filter((w) => !had.has(w) && storageBefore.includes(w));
      if (fresh.length) R(id).reload.push({ when, kind: 'stale', message: '새로고침해야 저장된 데이터(' + fresh.slice(0, 3).join(', ') + ')가 이 영역에 보입니다. 다른 영역·다른 탭이 바꾼 값을 시작할 때 한 번만 읽지 말고 app.on(\\'state:…\\') 로 받아 바로 다시 그리세요' });
    }
    scanBadText(when + ' 뒤 새로고침');
  };

  // 1) 모든 영역 입력칸 채우기 → 새로고침
  const savedByFill = {};
  for (const sec of leafSections()) {
    await onScreen(sec);
    const s0 = storage();
    const n = fillRegion(sec);
    R(sec.dataset.region).filled = n;
    await sleep(60);
    if (storage() !== s0) savedByFill[sec.dataset.region] = true;
    for (const e of takeErrors()) R(e.region || sec.dataset.region).errors.push({ when: '입력', message: e.message });
  }
  await reloadCheck('입력', savedByFill);

  // 2) 영역마다 누를 수 있는 것 눌러 보기
  let clicks = 0;
  const savedByClick = {};
  const ids = leafSections().map((s) => s.dataset.region);
  for (const id of ids) {
    let sec = D().querySelector('section[data-region="' + id + '"]');
    if (!sec) continue;
    await onScreen(sec);
    const s0 = storage();
    const keepIv = new Set(W().__exploreIntervals);
    fillRegion(sec);
    await sleep(40);
    takeErrors(); takeEffects();
    const seen = new Set();
    const counters = () => ({ iv: W().__exploreIntervals.size, dup: W().__exploreDup.count, tm: W().__exploreTimers });
    for (let i = 0; i < ${perRegion} && clicks < ${total}; i++) {
      sec = D().querySelector('section[data-region="' + id + '"]');
      if (!sec) break;
      const el = clickables(sec).find((x) => !seen.has(labelOf(x)));
      if (!el) break;
      const label = labelOf(el);
      seen.add(label);
      const before = appState();
      const c0 = counters();
      let emitted = 0;
      const app = W().__ideApp;
      const origEmit = app && app.emit;
      if (app) app.emit = function (...a) { emitted++; return origEmit.apply(this, a); };
      try { el.click(); } catch (e) { W().__exploreErrors.push({ region: id, message: e.message }); }
      await sleep(180);
      if (app) app.emit = origEmit;
      clicks++;
      const errs = takeErrors();
      const effects = takeEffects();
      // 버튼이 연 대화상자(스킬 설정 창 등)도 반응으로 보고, 다음 클릭을 막지 않게 닫는다
      const dialogs = [...D().querySelectorAll('dialog[open]')];
      if (dialogs.length) { effects.push('대화상자 열림'); dialogs.forEach((d) => { try { d.close(); } catch {} }); await sleep(30); }
      const changed = appState() !== before;
      const c1 = counters();
      // 누르고 나서 타이머를 건 것도 반응이다 (1초 뒤에 바뀌는 발표 타이머 등)
      if (c1.tm > c0.tm) effects.push('타이머 시작');
      R(id).clicks.push({ label, reacted: changed || emitted > 0 || effects.length > 0, effects, errors: errs.map((e) => e.message) });
      for (const e of errs) R(e.region || id).errors.push({ when: label + ' 클릭', message: e.message });
      // 처음엔 되는데 두 번째에 오류가 나는 버튼 (다시 섞기, 두 번 만들기 등)
      if (!errs.length && clicks < ${total}) {
        const secNow = D().querySelector('section[data-region="' + id + '"]');
        const again = secNow && clickables(secNow).find((x) => labelOf(x) === label);
        if (again) {
          try { again.click(); } catch (e) { W().__exploreErrors.push({ region: id, message: e.message }); }
          await sleep(150);
          clicks++;
          for (const e of takeErrors()) R(e.region || id).errors.push({ when: label + ' 두 번째 클릭', message: e.message });
          takeEffects();
          closeDialogs();
          const c2 = counters();
          if (c1.iv > c0.iv && c2.iv > c1.iv) pushOnce(R(id).warnings, { when: label + ' 두 번 클릭', kind: 'interval', message: '누를 때마다 반복 타이머(setInterval)가 하나씩 더 생깁니다 → 두 번 누르면 두 배로 빨라지고 멈춤 버튼으로 다 멈추지 않습니다 (새로 만들기 전에 clearInterval 하거나 이미 돌고 있으면 무시)' });
          if (c2.dup > c1.dup) pushOnce(R(W().__exploreDup.region || id).warnings, { when: label + ' 두 번 클릭', kind: 'listener', message: '누를 때마다 같은 요소에 이벤트 처리기가 하나씩 더 붙습니다 → 여러 번 누른 뒤에는 한 번 클릭이 여러 번 처리됩니다 (처리기는 처음에 한 번만 붙이기)' });
        }
      }
    }
    if (storage() !== s0) savedByClick[id] = true;
    // 이 영역에서 켠 반복 타이머는 끈다 (계속 돌면 다음 영역의 "반응 없음" 판단을 흐림)
    W().__exploreStopIntervals(keepIv);
    scanBadText(id + ' 버튼 클릭 뒤');
  }
  out.clicks = clicks;
  await reloadCheck('클릭', savedByClick);

  // 3) 탭(화면)을 바꿨다 돌아와도 입력한 값이 남아 있는지
  const scs = screensList();
  if (scs.length > 1) {
    for (const sc of scs) {
      await go(sc.id);
      errorsTo('"' + (sc.title || sc.id) + '" 탭 열기');
      const before = {};
      for (const sec of leafSections().filter((s) => s.closest('.ide-screen[data-screen]')?.dataset.screen === sc.id)) {
        if (fillRegion(sec, 'alt')) before[sec.dataset.region] = valuesOf(sec);
      }
      await sleep(60);
      errorsTo('탭 전환 점검 중 입력');
      takeEffects();
      if (!Object.keys(before).length) continue;
      const other = scs.find((x) => x.id !== sc.id);
      await go(other.id);
      await go(sc.id);
      errorsTo('탭 전환');
      takeEffects();
      for (const [id, bv] of Object.entries(before)) {
        const sec = sectionOf(id);
        if (!sec) continue;
        const av = valuesOf(sec);
        const lost = bv.filter((v, i) => v.trim() && av[i] !== v);
        if (lost.length) R(id).errors.push({ when: '"' + (other.title || other.id) + '" 탭에 갔다 돌아옴', kind: 'tab', message: '다른 탭에 갔다 돌아오면 입력한 값 ' + lost.length + '개가 사라지거나 바뀝니다 (탭을 바꿀 때 화면을 다시 그린다면 방금 입력한 최신 값으로 그리세요)' });
      }
    }
    scanBadText('탭 전환 뒤');
  }

  // 4) 저장된 값의 모양이 다를 때(예전 버전 앱, 다른 백업 파일) 시작하다 멈추는지 — 확인 필요(경고)
  const itemsC = storageItems();
  let corrupted = 0;
  try {
    const ls = W().localStorage;
    for (const [k, v] of itemsC) {
      if (k.startsWith('__ide') && !k.startsWith('__ideStore:')) continue;
      let j;
      try { j = JSON.parse(v); } catch { continue; }
      if (Array.isArray(j)) { ls.setItem(k, '{"__ideBroken":true}'); corrupted++; }
      else if (j && typeof j === 'object') { ls.setItem(k, '[]'); corrupted++; }
    }
  } catch {}
  if (corrupted) {
    await reloadFrame();
    for (const e of takeErrors()) {
      const id = e.region;
      if (!id) continue;
      if (R(id).errors.some((x) => x.message === e.message)) continue;
      pushOnce(R(id).warnings, { when: '저장값 모양을 바꾸고 시작', kind: 'corrupt', message: '저장된 값의 모양이 예상과 다르면(예전 버전, 다른 백업 파일) 시작하다 멈춥니다: ' + e.message + ' (불러온 값이 배열·객체인지 확인하고 아니면 기본값 쓰기)' });
    }
    takeEffects();
    restoreStorage(itemsC);
    await reloadFrame();
    takeErrors(); takeEffects();
  }

  // 5) 보안: 입력한 글자가 HTML 태그나 javascript: 링크로 들어가는지 (실행되는 코드는 넣지 않고 <b data-ide-xss> 표시만 찾는다)
  const checkInjected = (when) => {
    for (const el of D().querySelectorAll('#app [data-ide-xss]')) {
      const id = regionOf(el);
      if (id) pushOnce(R(id).security, { when, kind: 'html', message: '입력한 글자 속 <b> 가 진짜 HTML 태그로 들어갑니다 → 이름·메모에 <img onerror=…> 를 넣으면 스크립트가 실행됩니다 (innerHTML 에 넣기 전에 글자를 escape 하거나 textContent 쓰기)' });
    }
    for (const el of D().querySelectorAll('#app [href*="ide-xss"], #app [src*="ide-xss"], #app [action*="ide-xss"]')) {
      const id = regionOf(el);
      if (id) pushOnce(R(id).security, { when, kind: 'url', message: '입력한 javascript: 주소가 그대로 ' + el.tagName.toLowerCase() + ' 의 주소가 됩니다 → 누르면 스크립트가 실행됩니다 (http:// · https:// 로 시작하는 주소만 받기)' });
    }
  };
  let xssClicks = 0;
  for (const id of ids) {
    let sec = sectionOf(id);
    if (!sec) continue;
    await onScreen(sec);
    if (!fillRegion(sec, 'xss')) continue;
    await sleep(40);
    checkInjected('글자 입력');
    const seen = new Set();
    for (let i = 0; i < ${perRegion} && xssClicks < ${total}; i++) {
      sec = sectionOf(id);
      if (!sec) break;
      await onScreen(sec);
      const el = clickables(sec).find((x) => !seen.has(labelOf(x)));
      if (!el) break;
      seen.add(labelOf(el));
      try { el.click(); } catch {}
      await sleep(100);
      xssClicks++;
      closeDialogs();
    }
    takeErrors(); takeEffects();
    W().__exploreStopIntervals();
    checkInjected('글자 입력 뒤 버튼 클릭');
  }
  if (xssClicks) {
    await reloadFrame();
    takeErrors(); takeEffects();
    checkInjected('저장된 글자로 다시 열기');
  }

  const node = document.createElement('script');
  node.id = '__ideExploreResult';
  node.type = 'application/json';
  node.textContent = JSON.stringify(out);
  document.body.appendChild(node);
})();
</script></body></html>`;
}

// 결과 요약: 영역별로 "오류" (검증 실패) 와 "확인 필요" (경고) 로 나눈다
export function summarizeExplore(raw) {
  if (!raw) return null;
  const regions = Object.values(raw.regions || {}).map((r) => {
    const dead = r.clicks.filter((c) => !c.reacted && !c.errors.length).map((c) => c.label);
    // 숫자 칸 경계값 점검에서 난 오류가 보통 값으로 눌러도 나는 오류면 경계값 문제가 아니므로 하나만 남긴다
    const plain = new Set(r.errors.filter((e) => !/^숫자 칸에/.test(e.when || '')).map((e) => e.message));
    r = { ...r, errors: r.errors.filter((e) => !/^숫자 칸에/.test(e.when || '') || !plain.has(e.message)) };
    return {
      id: r.id,
      filled: r.filled,
      clicked: r.clicks.length,
      errors: r.errors,
      deadButtons: dead,
      // 입력한 내용은 저장되는데 새로고침하면 화면이 처음으로 돌아가면 오류.
      // 버튼으로 만든 결과(뽑기 결과 등)는 일부러 저장하지 않는 앱이 많아 "확인 필요"로만 둔다
      // 저장된 입력값이 새로고침 뒤 칸에 다시 채워지지 않는 것(kind: 'input')도 오류
      // 새로고침해야 다른 영역이 바꾼 데이터가 보이는 것(kind: 'stale')도 오류
      reloadReverted: r.reload.filter((x) => x.when === '입력' || x.kind === 'input' || x.kind === 'stale'),
      reloadWarnings: r.reload.filter((x) => x.when !== '입력' && x.kind !== 'input' && x.kind !== 'stale'),
      // 확인 필요: 반복 타이머·처리기 누수, 저장값 모양이 다를 때 멈춤
      warnings: r.warnings || [],
      // 보안: 입력 글자가 HTML 태그·javascript: 링크로 들어감 (오류)
      security: r.security || [],
      clicks: r.clicks,
    };
  });
  const errorCount = regions.reduce((n, r) => n + r.errors.length + r.reloadReverted.length + r.security.length, 0) + (raw.pageErrors || []).length;
  const warnCount = regions.reduce((n, r) => n + r.deadButtons.length + r.reloadWarnings.length + r.warnings.length, 0);
  return { regions, pageErrors: raw.pageErrors || [], clicks: raw.clicks || 0, errorCount, warnCount, ok: errorCount === 0 };
}

export async function exploreProject(project, browser, { timeoutMs = 90000 } = {}) {
  const appHtml = await buildApp(project, { preview: false, inject: APP_HOOK });
  const page = explorerPage();
  const srv = http.createServer((req, res) => {
    const isApp = req.url.startsWith('/app');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isApp ? appHtml : page);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const dom = await new Promise((resolve, reject) => {
      execFile(browser, [
        '--headless=new', ...SANDBOX_ARGS, '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--window-size=1400,900',
        '--virtual-time-budget=60000',
        '--dump-dom',
        `http://127.0.0.1:${port}/`,
      ], { timeout: timeoutMs, maxBuffer: 15 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(String(stdout || ''));
      });
    });
    const m = dom.match(/<script id="__ideExploreResult" type="application\/json">([\s\S]*?)<\/script>/);
    return m ? summarizeExplore(JSON.parse(m[1])) : { error: '탐색 점검 결과를 받지 못했습니다 (시간 초과)' };
  } finally {
    srv.close();
  }
}
