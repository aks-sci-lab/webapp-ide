// 기능 탐색 점검: AI 가 쓴 테스트와 상관없이, 실제 브라우저에서 영역마다 입력칸을 채우고 버튼을 눌러 보고
// 새로고침까지 해 본다. 찾는 것: 누르면 오류가 나는 버튼, 눌러도 아무 반응이 없는 버튼,
// 저장된 데이터가 있는데 새로고침하면 처음 화면으로 돌아가는 영역.
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
  const R = (id) => (out.regions[id] ||= { id, filled: 0, clicks: [], errors: [], reload: [] });
  const takeErrors = () => { const e = W().__exploreErrors || []; return e.splice(0, e.length); };
  const takeEffects = () => { const e = W().__exploreEffects || []; return e.splice(0, e.length); };
  const visible = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight));
  const regionOf = (el) => el.closest('section[data-region]')?.dataset.region || '';
  const leafSections = () => [...D().querySelectorAll('#app section[data-region]')].filter((s) => !s.querySelector('section[data-region]'));
  const textOf = (sec) => {
    const vals = [...sec.querySelectorAll('input,textarea,select')].map((i) => i.type === 'checkbox' || i.type === 'radio' ? (i.checked ? '1' : '0') : i.value).join('|');
    return (sec.innerText || '').replace(/\\s+/g, ' ').trim() + '#' + vals;
  };
  const snapshotRegions = () => Object.fromEntries(leafSections().map((s) => [s.dataset.region, textOf(s)]));
  const storage = () => { try { const ls = W().localStorage; return Object.keys(ls).sort().map((k) => k + '=' + ls.getItem(k)).join('\\n'); } catch { return ''; } };
  const appState = () => (D().querySelector('#app')?.innerText || '') + '|' + D().querySelectorAll('#app *').length + '|' + [...D().querySelectorAll('#app input,#app textarea,#app select')].map((i) => i.value + (i.checked ? '1' : '')).join(',') + '|' + [...D().querySelectorAll('#app [class]')].map((e) => e.className).join(' ').length + '|' + storage().length;
  const labelOf = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    return (el.id ? '#' + el.id + ' ' : '') + (t ? '"' + t + '"' : el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : ''));
  };
  const nearLabel = (el) => {
    const id = el.id && D().querySelector('label[for="' + el.id + '"]');
    return ((id && id.innerText) || el.closest('label')?.innerText || el.placeholder || el.name || el.id || '').toLowerCase();
  };
  const sample = (el) => {
    const hint = nearLabel(el);
    const t = (el.type || '').toLowerCase();
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
  const fillRegion = (sec) => {
    let n = 0;
    for (const el of sec.querySelectorAll('input,textarea,select')) {
      if (!visible(el) || el.disabled || el.readOnly) continue;
      const t = (el.type || '').toLowerCase();
      if (['button', 'submit', 'reset', 'file', 'hidden', 'checkbox', 'radio', 'image'].includes(t)) continue;
      if (el.tagName === 'SELECT') { if (el.options.length > 1) el.selectedIndex = 1; else continue; }
      else el.value = sample(el);
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

  // 0) 처음 화면
  await loaded();
  await sleep(250);
  for (const e of takeErrors()) (e.region ? R(e.region).errors : out.pageErrors).push({ when: '앱 시작', message: e.message });
  takeEffects();
  const pristine = snapshotRegions();
  const storage0 = storage();

  // 새로고침해서 처음 화면으로 돌아간 영역 찾기 (저장된 데이터가 바뀌었을 때만)
  const reloadCheck = async (when) => {
    const before = snapshotRegions();
    const storageBefore = storage();
    if (storageBefore === storage0) return; // 저장하는 데이터가 없으면 새로고침 뒤 처음 화면이 맞다
    f.contentWindow.location.reload();
    await loaded();
    await sleep(250);
    for (const e of takeErrors()) (e.region ? R(e.region).errors : out.pageErrors).push({ when: when + ' 뒤 새로고침', message: e.message });
    takeEffects();
    const after = snapshotRegions();
    for (const [id, txt] of Object.entries(after)) {
      if (before[id] !== undefined && before[id] !== pristine[id] && txt === pristine[id]) {
        R(id).reload.push({ when, message: '데이터가 저장돼 있는데 새로고침하면 이 영역이 처음 화면으로 돌아갑니다' });
      }
    }
  };

  // 1) 모든 영역 입력칸 채우기 → 새로고침
  for (const sec of leafSections()) {
    await onScreen(sec);
    const n = fillRegion(sec);
    R(sec.dataset.region).filled = n;
    await sleep(60);
    for (const e of takeErrors()) R(e.region || sec.dataset.region).errors.push({ when: '입력', message: e.message });
  }
  await reloadCheck('입력');

  // 2) 영역마다 누를 수 있는 것 눌러 보기
  let clicks = 0;
  const ids = leafSections().map((s) => s.dataset.region);
  for (const id of ids) {
    let sec = D().querySelector('section[data-region="' + id + '"]');
    if (!sec) continue;
    await onScreen(sec);
    fillRegion(sec);
    await sleep(40);
    takeErrors(); takeEffects();
    const seen = new Set();
    for (let i = 0; i < ${perRegion} && clicks < ${total}; i++) {
      sec = D().querySelector('section[data-region="' + id + '"]');
      if (!sec) break;
      const el = clickables(sec).find((x) => !seen.has(labelOf(x)));
      if (!el) break;
      const label = labelOf(el);
      seen.add(label);
      const before = appState();
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
      const changed = appState() !== before;
      R(id).clicks.push({ label, reacted: changed || emitted > 0 || effects.length > 0, effects, errors: errs.map((e) => e.message) });
      for (const e of errs) R(e.region || id).errors.push({ when: label + ' 클릭', message: e.message });
    }
  }
  out.clicks = clicks;
  await reloadCheck('클릭');

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
    return {
      id: r.id,
      filled: r.filled,
      clicked: r.clicks.length,
      errors: r.errors,
      deadButtons: dead,
      // 입력한 내용은 저장되는데 새로고침하면 화면이 처음으로 돌아가면 오류.
      // 버튼으로 만든 결과(뽑기 결과 등)는 일부러 저장하지 않는 앱이 많아 "확인 필요"로만 둔다
      reloadReverted: r.reload.filter((x) => x.when === '입력'),
      reloadWarnings: r.reload.filter((x) => x.when !== '입력'),
      clicks: r.clicks,
    };
  });
  const errorCount = regions.reduce((n, r) => n + r.errors.length + r.reloadReverted.length, 0) + (raw.pageErrors || []).length;
  const warnCount = regions.reduce((n, r) => n + r.deadButtons.length + r.reloadWarnings.length, 0);
  return { regions, pageErrors: raw.pageErrors || [], clicks: raw.clicks || 0, errorCount, warnCount, ok: errorCount === 0 };
}

export async function exploreProject(project, browser, { timeoutMs = 40000 } = {}) {
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
        '--virtual-time-budget=30000',
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
