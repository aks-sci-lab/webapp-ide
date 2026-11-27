// IDE 로 만든 웹앱 자체를 검증하는 실행기 (정적 검사 + 연결 지도 + 실제 헤드리스 브라우저 시나리오 테스트)
// 외부 패키지 없이 시스템 Edge/Chrome(--headless=new --dump-dom)으로 실제 DOM·CSS·JS 동작을 검증한다.
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from './project.js';
import { buildApp } from './build.js';
import { jsSyntaxError, cssBraceError } from './validate.js';
import { scanConnections } from './analysis.js';
import { findBrowser } from './shot.js';
import { flatten, isContainer, getScreens } from '../public/tree.js';
import { parseFragment } from 'parse5';

// AI 없이 영역 HTML 구조를 분석해 즉시 실행 가능한 기본 동작 테스트(스모크 테스트)를 자동 생성한다
export async function generateAutoTests(project) {
  const layout = await project.getLayout();
  const screens = getScreens(layout);
  const multiScreen = Array.isArray(layout.screens) && layout.screens.length > 1;
  const tests = [];

  for (const sc of screens) {
    const leaves = flatten(sc).filter((e) => !isContainer(e.region)).map((e) => e.region);
    for (const r of leaves) {
      const f = await project.readRegion(r.id);
      if (!f.html.trim()) continue;
      const frag = parseFragment(f.html);
      const steps = [];
      if (multiScreen) steps.push({ action: 'navigate', selector: '', value: sc.id });
      steps.push({ action: 'expectVisible', selector: `section[data-region="${r.id}"]`, value: '' });

      // 첫 제목(h1~h4) 또는 id 가 있는 주요 요소의 텍스트/표시 확인 (초기 hidden 요소는 제외)
      const hasHidden = (n) => (n.attrs || []).some((a) => a.name === 'hidden' || (a.name === 'style' && /display\s*:\s*none/i.test(a.value || '')));
      const walk = (n, cb, hiddenParent = false) => {
        const isHid = hiddenParent || hasHidden(n);
        if (isHid) return;
        cb(n);
        for (const c of n.childNodes || []) walk(c, cb, isHid);
      };
      const attr = (n, k) => n.attrs?.find((a) => a.name === k)?.value || '';
      const textOf = (n) => (n.nodeName === '#text' ? n.value : (n.childNodes || []).map(textOf).join(' '));

      let headingChecked = false;
      let firstBtnId = '';
      walk(frag, (n) => {
        if (!n.tagName) return;
        const id = attr(n, 'id');
        if (!headingChecked && /^h[1-4]$/.test(n.tagName)) {
          const txt = textOf(n).replace(/\s+/g, ' ').trim().slice(0, 20);
          if (txt) {
            const sel = id ? `#${id}` : `section[data-region="${r.id}"] ${n.tagName}`;
            steps.push({ action: 'expectText', selector: sel, value: txt });
            headingChecked = true;
          }
        }
        if (!firstBtnId && n.tagName === 'button' && id) {
          firstBtnId = id;
        }
      });
      if (firstBtnId) {
        steps.push({ action: 'expectVisible', selector: `#${firstBtnId}`, value: '' });
      }
      tests.push({
        name: `${multiScreen ? `[${sc.title || sc.id}] ` : ''}${r.title || r.id} 화면 렌더링 확인`,
        steps,
      });
    }
  }
  return tests;
}

// 모든 동작 테스트(tests.json)와 초기 런타임·레이아웃 상태를 한 번에 검사해 DOM(#__ideVerifyResult)에 기록하는 주입 스크립트
export function verifyRunnerScript(tests = []) {
  return `<script>
(() => {
  const tests = ${JSON.stringify(tests).replace(/</g, '\\u003c')};
  const runtimeErrors = [];
  const prevHook = window.__ideRegionError;
  window.__ideRegionError = (id, e) => {
    runtimeErrors.push({ region: id, message: e?.message || String(e) });
    if (prevHook) prevHook(id, e);
  };
  window.addEventListener('error', (e) => {
    if (/ResizeObserver loop/.test(e.message)) return;
    runtimeErrors.push({ region: null, message: e.message });
  });
  window.addEventListener('unhandledrejection', (e) => {
    runtimeErrors.push({ region: null, message: String(e.reason?.message || e.reason || 'Promise rejected') });
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ensureScreen = async (el) => {
    const sc = el?.closest?.('.ide-screen[data-screen]');
    if (sc && sc.hidden && window.__ideApp?.navigate) {
      window.__ideApp.navigate(sc.dataset.screen, { silentHash: true });
      await sleep(80);
    }
  };
  const ownerRegion = (sel) => {
    if (!sel) return '';
    try {
      const el = document.querySelector(sel);
      return el?.closest?.('section[data-region]')?.dataset?.region || '';
    } catch { return ''; }
  };
  const find = async (sel) => {
    for (let i = 0; i < 20; i++) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(50);
    }
    throw new Error('요소를 찾지 못함: ' + sel);
  };
  const visible = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  const runStep = async (s) => {
    const v = s.value ?? '';
    switch (s.action) {
      case 'navigate': {
        if (!window.__ideApp?.navigate) throw new Error('화면 전환 런타임이 없습니다');
        window.__ideApp.navigate(v, { silentHash: true });
        await sleep(100);
        return '화면 이동: ' + v;
      }
      case 'click': {
        const el = await find(s.selector);
        await ensureScreen(el);
        el.click();
        await sleep(80);
        return '클릭: ' + s.selector;
      }
      case 'type': {
        const el = await find(s.selector);
        await ensureScreen(el);
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(60);
        return '입력: ' + s.selector;
      }
      case 'wait': await sleep(Math.min(1000, Number(v) || 100)); return (Number(v) || 100) + 'ms 대기';
      case 'expectText': {
        const el = await find(s.selector);
        await ensureScreen(el);
        let t = '';
        for (let i = 0; i < 15; i++) {
          t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (t.includes(v)) return '텍스트 확인 ("' + v + '")';
          await sleep(50);
        }
        throw new Error('"' + v + '" 가 없음 (실제: "' + t.slice(0, 80) + '")');
      }
      case 'expectValue': {
        const el = await find(s.selector);
        await ensureScreen(el);
        if (String(el.value) === v) return '값 확인 ("' + v + '")';
        throw new Error('값이 "' + v + '" 이 아님 (실제: "' + el.value + '")');
      }
      case 'expectVisible': {
        const el = await find(s.selector);
        await ensureScreen(el);
        for (let i = 0; i < 15; i++) {
          if (visible(el)) return '표시 확인: ' + s.selector;
          await sleep(50);
        }
        throw new Error('요소가 보이지 않음: ' + s.selector);
      }
      case 'expectCount': {
        const n = document.querySelectorAll(s.selector).length;
        if (n === Number(v)) return '개수 확인 (' + n + '개)';
        throw new Error(v + '개가 아니라 ' + n + '개');
      }
      default: throw new Error('알 수 없는 동작: ' + s.action);
    }
  };

  window.addEventListener('load', async () => {
    await sleep(120);
    const regionsMounted = [...document.querySelectorAll('#app section[data-region]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.region, children: el.children.length, width: Math.round(r.width), height: Math.round(r.height) };
    });
    const firstScreen = window.__ideApp?.screens?.[0]?.id || '';
    // 모든 화면을 실제로 전환하며 빈 화면(렌더링 안 됨) 여부를 시각적으로 검사한다
    const blankScreens = [];
    const screenList = window.__ideApp?.screens?.length ? window.__ideApp.screens : [{ id: 'main', title: '메인 화면' }];
    for (const sc of screenList) {
      if (window.__ideApp?.screens?.length && window.__ideApp?.navigate) {
        window.__ideApp.navigate(sc.id, { silentHash: true });
        await sleep(20);
      }
      const container = window.__ideApp?.screens?.length
        ? document.querySelector('#app > .ide-screen[data-screen="' + sc.id + '"]')
        : document.querySelector('#app');
      if (!container) continue;
      const regs = [...container.querySelectorAll('section[data-region]')];
      const nonEmptyRegs = regs.filter((el) => el.children.length > 0 && getComputedStyle(el).display !== 'contents');
      if (!nonEmptyRegs.length) continue;
      const visibleRegs = nonEmptyRegs.filter((el) => {
        const r = el.getBoundingClientRect();
        return visible(el) && r.width > 10 && r.height > 10;
      });
      const textLen = visibleRegs.reduce((sum, el) => sum + (el.innerText || '').trim().length, 0);
      const hasVisual = visibleRegs.some((el) => el.querySelector('input,textarea,button,canvas,svg,img,table,select'));
      if (!visibleRegs.length || (textLen === 0 && !hasVisual)) {
        blankScreens.push({
          screen: sc.id,
          title: sc.title || sc.id,
          regions: nonEmptyRegs.map((el) => el.dataset.region),
          reason: !visibleRegs.length ? '영역 크기가 0이거나 화면에 보이지 않습니다' : '표시되는 텍스트나 UI 요소가 없습니다(빈 화면)',
        });
      }
    }
    const testResults = [];
    for (const t of tests) {
      if (firstScreen && window.__ideApp?.navigate) {
        window.__ideApp.navigate(firstScreen, { silentHash: true });
        await sleep(40);
      }
      const steps = [];
      let ok = true;
      for (const s of t.steps || []) {
        try {
          steps.push({ ok: true, action: s.action, selector: s.selector, region: ownerRegion(s.selector), msg: await runStep(s) });
        } catch (e) {
          ok = false;
          steps.push({ ok: false, action: s.action, selector: s.selector, region: ownerRegion(s.selector), msg: e.message });
          break;
        }
      }
      testResults.push({ name: t.name, ok, steps });
    }
    const out = document.createElement('script');
    out.id = '__ideVerifyResult';
    out.type = 'application/json';
    out.textContent = JSON.stringify({ runtimeErrors, regionsMounted, blankScreens, testResults });
    document.body.appendChild(out);
  });
})();
</script>`;
}

// 로컬 단독 실행(file:// HTML 1개) 호환성 검사:
// 백엔드 서버 API(/api/...) 호출, file:// CORS 차단 상대 fetch/import, 절대경로 pushState, 외부 CDN/API 의존성을 판정한다.
export async function checkLocalCompatibility(project) {
  const layout = await project.getLayout();
  const leaves = flatten(layout).filter((e) => !isContainer(e.region)).map((e) => e.region);
  const issues = [];
  const add = (level, region, kind, detail, fix) => {
    const key = `${level}|${region}|${kind}|${detail}`;
    if (issues.some((i) => `${i.level}|${i.region}|${i.kind}|${i.detail}` === key)) return;
    issues.push({ level, region, kind, detail, fix });
  };

  const scanJs = (region, src) => {
    if (!src || !src.trim()) return;
    // 주석만 있는 오탐 최소화를 위해 한 줄 주석 제거(문자열 속 // 는 유지)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    for (const m of code.matchAll(/\b(?:fetch|axios(?:\.(?:get|post|put|delete|patch))?)\s*\(\s*(['"`])(\/api\/[^'"`\s?]*)/g)) {
      add('error', region, 'server-api', `백엔드 API 호출: ${m[2]}`, '로컬 HTML에서는 /api/* 서버가 없으므로 localStorage 또는 IndexedDB로 저장·조회하도록 변경하세요');
    }
    for (const m of code.matchAll(/\bnew\s+(?:EventSource|WebSocket)\s*\(\s*(['"`])(\/[^'"`\s]*)/g)) {
      add('error', region, 'server-socket', `서버 실시간 연결: ${m[2]}`, '로컬 단독 HTML에서는 서버 소켓/SSE가 동작하지 않으므로 브라우저 내 이벤트(app.emit)로 대체하세요');
    }
    for (const m of code.matchAll(/\bfetch\s*\(\s*(['"`])(\.\.?\/[^'"`\s]*)/g)) {
      add('error', region, 'relative-fetch', `상대 파일 fetch: ${m[2]}`, 'file:// 로컬 실행 시 브라우저 CORS로 차단됩니다. 데이터를 JS 코드나 파일 업로드(FileReader)로 처리하세요');
    }
    for (const m of code.matchAll(/\bhistory\.(?:pushState|replaceState)\s*\([^)]*,\s*(['"`])(\/[^'"`]*)\1/g)) {
      add('error', region, 'history-path', `절대경로 history 이동: ${m[2]}`, 'file:// 에서 SecurityError가 발생합니다. 해시(#화면ID) 또는 app.navigate()를 사용하세요');
    }
    for (const m of code.matchAll(/\bimport\s+[^;\n]*?from\s*(['"`])(\.\.?\/[^'"`\s]*)\1/g)) {
      add('error', region, 'relative-import', `상대 경로 ES 모듈 import: ${m[2]}`, 'file:// 로컬 실행 시 브라우저 CORS로 차단됩니다');
    }
    for (const m of code.matchAll(/\bfetch\s*\(\s*(['"`])(https?:\/\/[^'"`\s)]+)/g)) {
      const host = (() => { try { return new URL(m[2]).host; } catch { return m[2].slice(0, 40); } })();
      add('warn', region, 'external-api', `외부 API 호출 (${host})`, '로컬 HTML에서 실행되지만 인터넷 연결과 API 키/CORS 허용이 필요합니다');
    }
  };

  const scanHtml = (region, html) => {
    if (!html || !html.trim()) return;
    for (const m of html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const host = (() => { try { return new URL(m[1]).host; } catch { return m[1].slice(0, 40); } })();
      add('warn', region, 'external-cdn', `외부 CDN 리소스 (${host})`, '인터넷 없는 PC에서도 쓰려면 "오프라인 내보내기"를 선택하세요');
    }
  };

  for (const r of leaves) {
    const f = await project.readRegion(r.id);
    scanJs(r.id, f.js);
    scanHtml(r.id, f.html);
  }
  scanJs('app.js', await project.readShared('js'));
  scanHtml('head.html', await project.readShared('head'));

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warnCount = issues.filter((i) => i.level === 'warn').length;
  const status = errorCount > 0 ? 'server-required' : warnCount > 0 ? 'internet-needed' : 'local-ready';
  const label = status === 'local-ready'
    ? '로컬 단독 실행 가능 (HTML 1개 · 오프라인 OK)'
    : status === 'internet-needed'
      ? '로컬 HTML 실행 가능 (외부 CDN/API에 인터넷 필요)'
      : `로컬 단독 실행 불가 (${errorCount}건의 서버/CORS 의존 코드 감지)`;

  return { status, label, canRunLocally: errorCount === 0, errorCount, warnCount, issues };
}

export async function verifyProject(project, { runBrowser = true } = {}) {
  const layout = await project.getLayout();
  const leaves = flatten(layout).filter((e) => !isContainer(e.region)).map((e) => e.region);
  const syntaxErrors = [];
  const jsSources = {};
  const idOwners = new Map();
  const duplicateIds = [];

  for (const r of leaves) {
    const f = await project.readRegion(r.id);
    jsSources[r.id] = f.js;
    const je = jsSyntaxError(f.js);
    const ce = cssBraceError(f.css);
    if (je) syntaxErrors.push({ region: r.id, file: 'script.js', error: je });
    if (ce) syntaxErrors.push({ region: r.id, file: 'style.css', error: ce });
    for (const m of f.html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) {
      const id = m[1];
      const prev = idOwners.get(id);
      if (prev) duplicateIds.push({ id, regions: [prev, r.id] });
      else idOwners.set(id, r.id);
    }
  }
  const appJs = await project.readShared('js');
  if (appJs.trim()) jsSources['app.js'] = appJs;
  const connections = scanConnections(jsSources);
  const localCompatibility = await checkLocalCompatibility(project);
  const tests = await project.readTests();

  let browserResult = null;
  const browser = runBrowser ? await findBrowser() : null;
  if (browser) {
    const html = await buildApp(project, { preview: true, inject: verifyRunnerScript(tests) });
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    try {
      const dom = await new Promise((resolve, reject) => {
        execFile(browser, [
          '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
          '--window-size=1366,768',
          '--virtual-time-budget=12000',
          '--dump-dom',
          `http://127.0.0.1:${port}/`,
        ], { timeout: 25000, maxBuffer: 15 * 1024 * 1024 }, (err, stdout) => {
          if (err && !stdout) return reject(err);
          resolve(String(stdout || ''));
        });
      });
      const m = dom.match(/<script id="__ideVerifyResult" type="application\/json">([\s\S]*?)<\/script>/);
      if (m) browserResult = JSON.parse(m[1]);
    } finally {
      srv.close();
    }
  }

  const ok =
    syntaxErrors.length === 0 &&
    connections.issues.filter((i) => i.level === 'error').length === 0 &&
    localCompatibility.canRunLocally &&
    (!browserResult || (
      browserResult.runtimeErrors.length === 0 &&
      (browserResult.blankScreens || []).length === 0 &&
      browserResult.testResults.every((t) => t.ok)
    ));

  return {
    ok,
    project: layout.name,
    regions: leaves.length,
    syntaxErrors,
    duplicateIds,
    connectionIssues: connections.issues,
    localCompatibility,
    browser: browserResult,
  };
}

// CLI 로 직접 실행: node lib/app-verify.js [프로젝트이름]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const name = process.argv[2] || 'my-app';
  const proj = new Project(path.join(here, 'projects', name));
  const res = await verifyProject(proj);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
