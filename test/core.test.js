import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { flatten, find, ancestors, fits, unionRect, splitSizes, uniqueId } from '../public/tree.js';
import { readTokens, setToken, addDarkFromLight, isColor, toHex6 } from '../public/tokens.js';
import { jsSyntaxError, cssBraceError, rootLayoutProblems, checkRegionOutput } from '../lib/validate.js';
import { parseFiles, parseMemo, normalizeFiles, relatedCss, relatedCode } from '../lib/ai.js';
import { scopeCss, buildApp } from '../lib/build.js';
import { layoutFromRows, validateLayoutPlan, parsePlan, addsLayoutCss, fitLayoutTo } from '../lib/planner.js';
import { analyze, withFeatureIds, removeBlock, insertBlock, isOverlayHtml, lostIds } from '../lib/features.js';
import { classifyCss, classifyJs, planMove } from '../lib/feature-deps.js';
import { Project } from '../lib/project.js';
import { redact, lineDelta } from '../lib/logger.js';
import { PRESETS, buildHeaders, filterModels } from '../lib/local.js';
import { QuotaGuard, normalizeFreeMode, isRateOrOverloadError, buildFallbackOrder } from '../lib/quota-guard.js';
import { buildCliInvocation, stripAnsi, splitArgs, generate as cliGenerate } from '../lib/cli.js';
import { pickGeminiModel, pickOpenAiModel } from '../public/model-picker.js';
import { APP_TEMPLATES, THEME_PRESETS, applyThemeTokens, buildThemeBaseCss } from '../public/templates.js';
import { rgbToHex, pxNumber, buildElementPrompt, upsertElementStyleRule } from '../public/inspect-edit.js';
import { countVerifyIssues, buildVerifyFixPrompt, buildVerifyFailureBriefing } from '../public/app-verifier.js';
import { generateAutoTests, verifyProject, checkLocalCompatibility } from '../lib/app-verify.js';
import { SessionStore } from '../lib/sessions.js';
import { extractFailingRegions, renderSessionBar } from '../public/session-panel.js';
import { WorkflowStore, parseProposeResponse, parseDistributeResponse, reconcileChecklist } from '../lib/workflow.js';
import { renderProjectHub } from '../public/project-hub.js';
import { applyLayoutPreset, findSwapTarget, swapRegionGeometry, findSplitters, applySplitterMove } from '../public/layout-magic.js';
import { classifySmartRequest } from '../public/smart-router.js';
import { exportElectronProject } from '../lib/electron-export.js';
import { ChatMemoryStore } from '../lib/chat-memory.js';

test('tree: flatten, find, ancestors, fits, unionRect, splitSizes, uniqueId', () => {
  const layout = {
    grid: { cols: 12, rows: 12 },
    regions: [
      { id: 'header', x: 0, y: 0, w: 12, h: 2 },
      {
        id: 'body', x: 0, y: 2, w: 12, h: 10,
        grid: { cols: 12, rows: 12 },
        regions: [
          { id: 'nav', x: 0, y: 0, w: 3, h: 12 },
          { id: 'main', x: 3, y: 0, w: 9, h: 12 },
        ],
      },
    ],
  };
  assert.deepEqual(flatten(layout).map((e) => e.region.id), ['header', 'body', 'nav', 'main']);
  assert.equal(find(layout, 'main')?.parent.id, 'body');
  assert.deepEqual(ancestors(layout, 'main'), ['body']);
  assert.equal(fits(layout, { x: 0, y: 0, w: 2, h: 2 }), false);
  assert.equal(fits(layout, { x: 0, y: 0, w: 2, h: 2 }, ['header']), true);
  assert.deepEqual(unionRect([
    { x: 0, y: 0, w: 3, h: 12 },
    { x: 3, y: 0, w: 9, h: 12 },
  ]), { x: 0, y: 0, w: 12, h: 12 });
  assert.equal(unionRect([
    { x: 0, y: 0, w: 3, h: 6 },
    { x: 3, y: 0, w: 9, h: 12 },
  ]), null);
  assert.deepEqual(splitSizes(10, 3), [4, 3, 3]);
  assert.equal(uniqueId(layout, 'nav'), 'nav-2');
});

test('tokens: readTokens, setToken, addDarkFromLight, color helpers', () => {
  const css = `:root {\n  --brand: #5b5bd6;\n  --gap: 8px;\n}\nbody { color: var(--brand); }\n`;
  const r1 = readTokens(css);
  assert.equal(r1.hasDark, false);
  assert.equal(r1.tokens.length, 2);
  assert.equal(r1.tokens[0].light, '#5b5bd6');

  const updated = setToken(css, 'light', '--brand', '#ff00aa');
  assert.match(updated, /--brand: #ff00aa;/);
  assert.match(updated, /body \{ color: var\(--brand\); \}/);

  const withDark = addDarkFromLight(updated);
  const r2 = readTokens(withDark);
  assert.equal(r2.hasDark, true);
  assert.equal(r2.tokens.find((t) => t.name === '--brand')?.dark, '#ff00aa');

  assert.equal(isColor('#abc'), true);
  assert.equal(toHex6('#abc'), '#aabbcc');
  assert.equal(isColor('rgb(0,0,0)'), false);
});

test('validate: syntax, brace matching, root layout restrictions, lostIds', () => {
  assert.equal(jsSyntaxError('const x = 1; root.querySelector("div");'), null);
  assert.ok(jsSyntaxError('const x = (;'));
  assert.equal(cssBraceError('.a { color: red; /* } */ }'), null);
  assert.ok(cssBraceError('.a { color: red;'));

  const layoutProbs = rootLayoutProblems({
    css: ':scope { grid-column: 1 / 4; }',
    js: 'root.style.position = "fixed";',
  });
  assert.equal(layoutProbs.length, 2);

  const out = checkRegionOutput({
    before: { html: '<button id="saveBtn">저장</button>' },
    parsed: { html: '<button>저장</button>', css: '.a { color: red; }', js: 'const a = 1;' },
    appJs: 'document.getElementById("saveBtn").onclick = () => {};',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'lost-ids');
  assert.deepEqual(out[0].ids, ['saveBtn']);
});

test('ai: parseFiles, parseMemo, normalizeFiles, relatedCss/Code', () => {
  const raw = [
    '짧은 설명입니다.',
    '```html',
    '<section data-region="hdr">',
    '  <h1 id="title" class="hero">Hello</h1>',
    '</section>',
    '```',
    '```css',
    '@scope ([data-region="hdr"]) {',
    '  .hero { color: blue; }',
    '}',
    '```',
    '```js',
    '(function (root, app) {',
    '  console.log(root);',
    '})(el, app);',
    '```',
    '```memo',
    '- 버튼은 항상 둥근 모서리',
    '```',
  ].join('\n');

  const parsed = normalizeFiles(parseFiles(raw));
  assert.equal(parsed.html.trim(), '<h1 id="title" class="hero">Hello</h1>');
  assert.equal(parsed.css.trim(), '.hero { color: blue; }');
  assert.equal(parsed.js.trim(), 'console.log(root);');
  assert.deepEqual(parseMemo(raw), ['버튼은 항상 둥근 모서리']);

  const rc = relatedCss('<div id="box" class="card"></div>', '.card{padding:8px} .other{color:red}');
  assert.match(rc, /\.card\{padding:8px\}/);
  assert.doesNotMatch(rc, /\.other/);

  const code = relatedCode('<button id="go" onclick="runTask()">Go</button>', 'function runTask() {\n  return 1;\n}\nfunction unused() {}');
  assert.match(code, /function runTask/);
  assert.doesNotMatch(code, /unused/);
});

test('build: scopeCss hoisting and buildApp assembly', async () => {
  const scoped = scopeCss('hero', '@keyframes hero-pop { from { opacity: 0; } to { opacity: 1; } }\n:scope { display: grid; }\n.btn { color: red; }');
  assert.match(scoped, /@keyframes hero-pop[\s\S]*@scope \(\[data-region="hero"\]\)/);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-test-'));
  try {
    const project = new Project(tmp);
    await project.init({
      name: '테스트 앱',
      regions: [{ id: 'top', title: '상단', x: 0, y: 0, w: 12, h: 2, color: '#5b5bd6' }],
    });
    await project.writeRegion('top', {
      html: '<h1 id="t">안녕</h1>',
      css: ':scope { padding: 8px; }',
      js: 'root.querySelector("#t").dataset.ok = "1";',
    }, { backup: false });
    const html = await buildApp(project, { preview: true });
    assert.match(html, /<title>테스트 앱<\/title>/);
    assert.match(html, /@scope \(\[data-region="top"\]\)/);
    assert.match(html, /window\.__ideApp/);
    assert.match(html, /toggle-regions/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('planner: layoutFromRows, parsePlan, addsLayoutCss, fitLayoutTo', () => {
  const layout = {
    name: '앱',
    mode: 'grid',
    grid: { cols: 12, rows: 12, gap: 8, fill: true },
    regions: [
      { id: 'header', title: '헤더', x: 0, y: 0, w: 12, h: 2 },
      { id: 'main', title: '메인', x: 0, y: 2, w: 12, h: 10 },
    ],
  };
  const conv = layoutFromRows({
    fill: true,
    rows: [
      { height: 2, cells: [{ id: 'header', width: 12 }] },
      { height: 10, cells: [{ id: 'main', width: 8 }, { id: 'side', width: 4 }] },
    ],
  }, ['header', 'main', 'side']);
  assert.equal(conv.cols, 12);
  assert.equal(conv.rows, 12);
  assert.equal(conv.regions.find((r) => r.id === 'side')?.w, 4);

  const planText = JSON.stringify({
    summary: '사이드바 추가 및 재배치',
    newRegions: [{ id: 'Side Panel', title: '사이드', purpose: '필터' }],
    featureMoves: [],
    removeRegions: [],
    steps: [
      { target: 'Side Panel', prompt: '필터 목록 구현' },
      { target: 'shared:css', prompt: 'body { display: grid; } 로 2단 배치' },
    ],
    layout: {
      fill: true,
      rows: [
        { height: 2, cells: [{ id: 'header', width: 12 }] },
        { height: 10, cells: [{ id: 'main', width: 9 }, { id: 'Side Panel', width: 3 }] },
      ],
    },
  });
  const parsed = parsePlan(planText, new Set(['shared:css', 'header', 'main']), { layout });
  assert.equal(parsed.newRegions[0].id, 'side-panel');
  assert.equal(parsed.steps[0].target, 'side-panel');
  assert.equal(parsed.steps[0].enabled, true);
  assert.equal(parsed.steps[1].enabled, false); // CSS layout guard
  assert.equal(parsed.layout.valid, true);

  assert.equal(addsLayoutCss('body { color: #111; }', 'body { color: #111; display: grid; }'), true);
  assert.equal(addsLayoutCss('body { display: grid; }', 'body { display: grid; color: #222; }'), false);

  const fitted = fitLayoutTo(parsed.layout, ['header', 'main', 'extra']);
  assert.ok(fitted.regions.some((r) => r.id === 'extra'));
  assert.ok(!fitted.regions.some((r) => r.id === 'side-panel'));
});

test('features & feature-deps: deterministic feature move without AI', () => {
  const rawHtml = '<div class="box"><button id="btnA" class="a-btn">A</button></div>\n<div class="box"><button id="btnB" class="b-btn">B</button></div>\n';
  const { html } = withFeatureIds(rawHtml, new Set());
  const a = analyze(html);
  assert.equal(a.blocks.length, 2);
  const fidA = a.blocks[0].fid;

  assert.equal(isOverlayHtml('<dialog id="d1">hi</dialog>'), true);
  assert.deepEqual(lostIds('<div id="keep"></div>', '<div></div>', 'document.querySelector("#keep")'), ['keep']);

  const css = '.a-btn { color: red; }\n.b-btn { color: blue; }\n.box { padding: 8px; }\n';
  const js = 'const btnA = root.querySelector("#btnA");\nbtnA.addEventListener("click", () => app.emit("a:click"));\nconst btnB = root.querySelector("#btnB");\n';

  const plan = planMove({
    source: { html, css, js },
    target: { html: '', css: '', js: '' },
    fid: fidA,
    sourceId: 'src',
    targetId: 'dst',
  });
  assert.doesNotMatch(plan.files.source.html, /btnA/);
  assert.match(plan.files.target.html, /btnA/);
  assert.match(plan.files.target.css, /\.a-btn/);
  assert.doesNotMatch(plan.files.source.css, /\.a-btn/);
  assert.match(plan.files.target.css, /\.box/); // shared class copied
  assert.match(plan.files.target.js, /btnA/);
  assert.doesNotMatch(plan.files.source.js, /btnA/);
  assert.equal(plan.needsBridge, false);

  const removed = removeBlock(html, fidA);
  const reinserted = insertBlock(removed.html, removed.block.html, 'start');
  assert.match(reinserted, new RegExp(fidA));
});

test('logger: redact hides secret keys and preserves numbers', () => {
  const out = redact({ apiKey: 'sk-secret', localKey: 'or-123', input_tokens: 42, nested: { authorization: 'Bearer x' } });
  assert.equal(out.apiKey, '[숨김]');
  assert.equal(out.localKey, '[숨김]');
  assert.equal(out.input_tokens, 42);
  assert.equal(out.nested.authorization, '[숨김]');
  assert.deepEqual(lineDelta('a\nb\n', 'a\nc\nd\n'), { added: 2, removed: 1 });
});

test('local/openai-compatible: presets, Groq, Bearer auth header, and :free filter', () => {
  assert.equal(PRESETS.openai, 'https://api.openai.com/v1');
  assert.equal(PRESETS.openrouter, 'https://openrouter.ai/api/v1');
  assert.equal(PRESETS.groq, 'https://api.groq.com/openai/v1');
  assert.deepEqual(buildHeaders('', { 'Content-Type': 'application/json' }), { 'Content-Type': 'application/json' });
  assert.deepEqual(buildHeaders('sk-test', { 'Content-Type': 'application/json' }), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer sk-test',
  });
  const free = filterModels(['openai/gpt-5', 'google/gemma-3-27b-it:free', 'meta-llama/llama-4:free', 'text-embedding-3-small'], { freeOnly: true });
  assert.deepEqual(free.map((m) => m.id), ['google/gemma-3-27b-it:free', 'meta-llama/llama-4:free']);
});

test('quota-guard: freeMode normalization, daily cap, 429/503 detection, and fallback order', () => {
  const fm = normalizeFreeMode({ enabled: true, minIntervalSec: 5, dailyLimit: 30, autoFallback: true });
  assert.deepEqual(fm, { enabled: true, minIntervalSec: 5, dailyLimit: 30, autoFallback: true });

  const qg = new QuotaGuard();
  assert.doesNotThrow(() => qg.checkDailyCap(29, 30));
  assert.throws(() => qg.checkDailyCap(30, 30), /일일 호출 상한/);

  assert.equal(isRateOrOverloadError(new Error('Gemini API 오류 (429): RESOURCE_EXHAUSTED')), true);
  assert.equal(isRateOrOverloadError(new Error('서버가 일시적으로 혼잡합니다(503)')), true);
  assert.equal(isRateOrOverloadError(new Error('Invalid JSON')), false);

  const order = buildFallbackOrder(
    { geminiKey: 'g', geminiModel: 'm', localUrl: 'http://localhost:1234/v1', localModel: 'qwen', apiKey: '' },
    'gemini',
    { gemini: (s) => Boolean(s.geminiKey && s.geminiModel), local: (s) => Boolean(s.localUrl && s.localModel), claude: (s) => Boolean(s.apiKey) },
  );
  assert.deepEqual(order, ['local']);
});

test('cli provider: invocation builder, ANSI stripping, and live stdin→stdout streaming', async () => {
  assert.equal(stripAnsi('\x1b[32mhello\x1b[0m'), 'hello');
  assert.deepEqual(splitArgs('-p "hello world" --fast'), ['-p', 'hello world', '--fast']);

  const codexInv = buildCliInvocation({ preset: 'codex', model: 'gpt-5-codex' });
  assert.equal(codexInv.command, 'codex');
  assert.deepEqual(codexInv.args, ['exec', '--skip-git-repo-check', '-m', 'gpt-5-codex', '-']);

  const claudeInv = buildCliInvocation({ preset: 'claude', model: 'claude-sonnet-4-5' });
  assert.equal(claudeInv.command, 'claude');
  assert.deepEqual(claudeInv.args, ['-p', '--output-format', 'text', '--model', 'claude-sonnet-4-5']);

  // 실제 node 프로세스를 커스텀 CLI 로 실행해 stdin → stdout 스트리밍 검증
  const chunks = [];
  let finalText = '';
  for await (const ev of cliGenerate({
    preset: 'custom',
    command: process.execPath,
    args: '-e "let s=\'\'; process.stdin.on(\'data\',d=>s+=d); process.stdin.on(\'end\',()=>process.stdout.write(\'CLI_OK:\'+s.trim().slice(-5)));"',
    system: '',
    prompt: 'HELLO',
  })) {
    if (ev.type === 'delta') chunks.push(ev.text);
    if (ev.type === 'final') finalText = ev.text;
  }
  assert.equal(finalText, 'CLI_OK:HELLO');
  assert.equal(chunks.join(''), 'CLI_OK:HELLO');
});

test('model-picker: prefers newest generation over deprecated 2.5 and picks sensible OpenAI default', () => {
  const models = [
    { id: 'gemini-2.5-pro' },
    { id: 'gemini-3.5-flash-lite' },
    { id: 'gemini-3.1-pro-preview' },
    { id: 'gemini-3.8-flash' },
  ];
  assert.equal(pickGeminiModel(models), 'gemini-3.8-flash');
  assert.equal(pickGeminiModel([{ id: 'gemini-2.5-pro' }, { id: 'gemini-3.1-pro-preview' }]), 'gemini-3.1-pro-preview');
  assert.equal(pickOpenAiModel([{ id: 'misc-model' }, { id: 'gpt-4o' }, { id: 'gpt-5-mini' }]), 'gpt-5-mini');
});

test('templates & theme presets: valid layout definitions and light/dark token application', () => {
  assert.ok(APP_TEMPLATES.length >= 4);
  for (const tpl of APP_TEMPLATES) {
    assert.ok(tpl.id && tpl.name);
    assert.ok(Array.isArray(tpl.layout.regions));
  }
  const css = buildThemeBaseCss(THEME_PRESETS[1]);
  const parsed = readTokens(css);
  assert.equal(parsed.hasDark, true);
  assert.equal(parsed.tokens.find((t) => t.name === '--primary')?.light, THEME_PRESETS[1].light['--primary']);
  const updated = applyThemeTokens(css, THEME_PRESETS[2]);
  assert.equal(readTokens(updated).tokens.find((t) => t.name === '--primary')?.light, THEME_PRESETS[2].light['--primary']);
});

test('inspect-edit: color conversion, targeted prompt, and idempotent CSS rule upsert', () => {
  assert.equal(rgbToHex('rgb(91, 91, 214)'), '#5b5bd6');
  assert.equal(pxNumber('14.6px'), 15);
  const prompt = buildElementPrompt({
    region: 'header',
    selector: '#saveBtn',
    tag: 'button',
    text: '저장',
    html: '<button id="saveBtn">저장</button>',
    rect: { w: 100, h: 36 },
    styles: { color: 'rgb(255, 255, 255)', borderRadius: '6px' },
  }, '더 둥글게 만들어 줘');
  assert.match(prompt, /#saveBtn/);
  assert.match(prompt, /더 둥글게 만들어 줘/);

  const css1 = upsertElementStyleRule('.a { color: red; }\n', '#saveBtn', { 'border-radius': '20px', color: '#ffffff' });
  assert.match(css1, /\/\* @inspect:#saveBtn \*\//);
  assert.match(css1, /border-radius: 20px;/);
  const css2 = upsertElementStyleRule(css1, '#saveBtn', { 'border-radius': '999px' });
  assert.equal((css2.match(/@inspect:#saveBtn/g) || []).length, 2); // start + end only (replaced, not duplicated)
  assert.match(css2, /border-radius: 999px;/);
  assert.doesNotMatch(css2, /border-radius: 20px;/);
});

test('build: preview output includes Inspect-to-Edit picker protocol', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-inspect-'));
  try {
    const project = new Project(tmp);
    await project.init({ name: 'Inspect Test', regions: [{ id: 'hero', title: '히어로', x: 0, y: 0, w: 12, h: 4, color: '#5b5bd6' }] });
    const html = await buildApp(project, { preview: true });
    assert.match(html, /toggle-inspect/);
    assert.match(html, /inspect-pick/);
    assert.match(html, /inspect-live-style/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('app-verify & app-verifier: auto smoke test generation, static verify, and AI fix prompt builder', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-verify-'));
  try {
    const project = new Project(tmp);
    await project.init({
      name: 'Verify Test App',
      regions: [{ id: 'hero', title: '히어로', x: 0, y: 0, w: 12, h: 4, color: '#5b5bd6' }],
    });
    await project.writeRegion('hero', {
      html: '<h1 id="mainTitle">환영합니다</h1><button id="hiddenBtn" hidden>숨김</button><button id="goBtn">시작</button>',
      css: ':scope { padding: 12px; }',
      js: 'root.querySelector("#goBtn").addEventListener("click", () => {});',
    }, { backup: false });

    const autoTests = await generateAutoTests(project);
    assert.equal(autoTests.length, 1);
    assert.ok(autoTests[0].steps.some((s) => s.action === 'expectText' && s.value === '환영합니다'));
    assert.ok(autoTests[0].steps.some((s) => s.action === 'expectVisible' && s.selector === '#goBtn'));
    assert.ok(!autoTests[0].steps.some((s) => s.selector === '#hiddenBtn'));

    // 다중 화면 레이아웃에서는 각 화면으로 이동(navigate) 단계가 자동 포함되어야 한다
    await project.saveLayout({
      name: 'MultiScreen Verify',
      grid: { cols: 12, rows: 12, gap: 8, rowHeight: 60, fill: true },
      screens: [
        { id: 'home', title: '홈', grid: { cols: 12, rows: 12, gap: 8, rowHeight: 60, fill: true }, regions: [{ id: 'hero', title: '히어로', x: 0, y: 0, w: 12, h: 12, color: '#5b5bd6' }] },
        { id: 'admin', title: '관리자', grid: { cols: 12, rows: 12, gap: 8, rowHeight: 60, fill: true }, regions: [{ id: 'login', title: '로그인', x: 0, y: 0, w: 12, h: 12, color: '#0ea5e9' }] },
      ],
    });
    await project.writeRegion('login', { html: '<h2>관리자 로그인</h2><button id="loginBtn">로그인</button>', css: '', js: '' }, { backup: false });
    const multiAutoTests = await generateAutoTests(project);
    assert.equal(multiAutoTests.length, 2);
    assert.deepEqual(multiAutoTests[1].steps[0], { action: 'navigate', selector: '', value: 'admin' });
    assert.ok(multiAutoTests[1].steps.some((s) => s.action === 'expectVisible' && s.selector === '#loginBtn'));

    // 로컬 단독 실행 호환성 판정: 순수 로컬 → local-ready, CDN → internet-needed, /api/* 호출 → server-required
    const lcPure = await checkLocalCompatibility(project);
    assert.equal(lcPure.status, 'local-ready');
    assert.equal(lcPure.canRunLocally, true);

    await project.writeRegion('login', {
      html: '<h2>관리자</h2>',
      css: '',
      js: 'fetch("/api/teacher/session").then((r) => r.json());',
    }, { backup: false });
    const lcServer = await checkLocalCompatibility(project);
    assert.equal(lcServer.status, 'server-required');
    assert.equal(lcServer.canRunLocally, false);
    assert.ok(lcServer.issues.some((i) => i.region === 'login' && i.kind === 'server-api'));

    const repWithLocal = await verifyProject(project, { runBrowser: false });
    assert.equal(repWithLocal.ok, false);
    assert.ok(countVerifyIssues(repWithLocal).localErr >= 1);
    const localFailMap = extractFailingRegions(repWithLocal, ['hero', 'login']);
    assert.ok(localFailMap.has('login'));

    // 원복해 아래 static verify 통과 검증 유지
    await project.writeRegion('login', { html: '<h2>관리자 로그인</h2><button id="loginBtn">로그인</button>', css: '', js: '' }, { backup: false });

    // 일렉트론 데스크톱 앱 패키지 내보내기 검증
    const elOut = await exportElectronProject({
      distDir: path.join(tmp, 'dist'),
      projectName: 'my-app',
      productName: '수행평가 앱',
      html: '<!doctype html><html><body><h1>OK</h1></body></html>',
    });
    assert.ok(elOut.files.includes('app/index.html'));
    assert.ok(elOut.files.includes('main.cjs'));
    assert.ok(elOut.files.includes('package.json'));
    const pkg = JSON.parse(await fs.readFile(path.join(elOut.electronDir, 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'main.cjs');
    assert.equal(pkg.productName, '수행평가 앱');
    const mainSrc = await fs.readFile(path.join(elOut.electronDir, 'main.cjs'), 'utf8');
    assert.match(mainSrc, /http\.createServer/);

    // PR 방식 대화·세션 메모리 자동 압축 및 원본 JSONL 아카이브 검증
    const mem = new ChatMemoryStore(project, { maxItems: 5, maxChars: 5000, keepRecent: 2 });
    for (let i = 1; i <= 6; i++) {
      await mem.append({
        kind: i % 2 ? 'user' : 'handoff',
        session: i % 2 ? 'chat' : 'region:hero',
        region: i % 2 ? '' : 'hero',
        screen: 'home',
        text: `기록 ${i}번 내용`,
      });
    }
    const stateAfter = await mem.read();
    assert.equal(stateAfter.prs.length, 1);
    assert.equal(stateAfter.prs[0].id, 'PR #1');
    assert.equal(stateAfter.prs[0].itemCount, 4);
    assert.equal(stateAfter.items.length, 2);
    const archived = await mem.readArchive('PR #1');
    assert.equal(archived.length, 4);
    const prCtx = await mem.buildPrContext(3);
    assert.match(prCtx, /PR #1/);
    assert.match(prCtx, /hero/);
    // 이모지 중간이 잘려도 깨진 서로게이트가 남지 않아야 함
    await mem.append({ kind: 'user', session: 'chat', text: 'a'.repeat(59) + '🤖' });
    const ctxClean = await mem.buildPrContext(5);
    assert.ok(!/[\uD800-\uDFFF]/.test(ctxClean));

    const report = await verifyProject(project, { runBrowser: false });
    assert.equal(report.ok, true);
    assert.equal(countVerifyIssues(report).totalErrors, 0);

    const fixPrompt = buildVerifyFixPrompt({
      syntaxErrors: [{ region: 'hero', file: 'script.js', error: 'Unexpected token' }],
      connectionIssues: [{ level: 'error', text: '"a:b" 이벤트 미발행', similar: ['a:c'] }],
      browser: { runtimeErrors: [{ region: 'hero', message: 'ReferenceError: x is not defined' }], testResults: [] },
    });
    assert.match(fixPrompt, /Unexpected token/);
    assert.match(fixPrompt, /ReferenceError/);

    const briefing = buildVerifyFailureBriefing({
      syntaxErrors: [{ region: 'hero', file: 'script.js', error: 'Unexpected token' }],
      duplicateIds: [{ id: 'btn-save', regions: ['a', 'b'] }],
      connectionIssues: [{ level: 'error', text: '"x:y" 미발행' }],
      browser: { runtimeErrors: [], testResults: [] },
    });
    assert.equal(briefing.reasons.length, 3);
    assert.match(briefing.summary, /5회/);
    assert.match(briefing.fixText, /#btn-save/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sessions & session-panel: isolated integrated/region/verify stores and Auto-Heal region extraction', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-sess-'));
  try {
    const project = new Project(tmp);
    await project.init({ name: 'SessApp' });
    const store = new SessionStore(project);

    await store.append('integrated', { role: 'assistant', status: 'ok', summary: '2단계 계획 수립' });
    await store.append('region:header', { role: 'assistant', status: 'ok', summary: '헤더 구현 완료' });
    const extra = await store.createRegionSession('header', '스타일 다듬기');
    await store.append(extra.key, { role: 'assistant', status: 'ok', summary: '버튼 둥글기 수정' });
    await store.append('verify', { role: 'verify', status: 'error', summary: '1건 오류 발견' });

    const sum = await store.summary(['header', 'main']);
    assert.equal(sum.integrated.count, 1);
    assert.equal(sum['region:header'].count, 1);
    assert.equal(sum[extra.key].isExtra, true);
    assert.equal(sum[extra.key].title, '스타일 다듬기');
    assert.equal(sum[extra.key].count, 1);
    assert.equal(sum['region:main'].count, 0);
    assert.equal(sum.verify.last.status, 'error');

    await store.remove(extra.key);
    assert.equal((await store.summary(['header', 'main']))[extra.key], undefined);

    await store.clear('verify');
    assert.equal((await store.read('verify')).entries.length, 0);

    const failing = extractFailingRegions({
      syntaxErrors: [{ region: 'header', file: 'script.js', error: 'Unexpected }' }],
      connectionIssues: [{ level: 'error', text: '"header:go" 이벤트를 main 이(가) 기다리지만 아무도 보내지 않습니다', similar: [] }],
      browser: {
        runtimeErrors: [{ region: 'main', message: 'TypeError' }],
        testResults: [
          {
            name: '로그인 확인',
            ok: false,
            steps: [{ ok: false, action: 'expectVisible', selector: '#login-box', region: 'tea-login', msg: '요소가 보이지 않음' }],
          },
          {
            name: '헤더 타이머',
            ok: false,
            steps: [{ ok: false, action: 'expectVisible', selector: '#stu-enter-header-time', msg: '요소가 보이지 않음' }],
          },
          {
            name: '탭 전환',
            ok: false,
            steps: [{ ok: false, action: 'click', selector: '#tab-chat', msg: '요소를 찾지 못함' }],
          },
        ],
      },
    }, ['header', 'main', 'tea-login', 'stu-enter-header', 'stu-ai-panel'], {
      'stu-ai-panel': { html: '<button id="tab-chat">AI 도우미</button>' },
    });
    assert.equal(failing.size, 5);
    assert.ok(failing.get('header').some((m) => m.includes('문법 오류')));
    assert.ok(failing.get('main').some((m) => m.includes('런타임 오류')));
    assert.ok(failing.get('tea-login').some((m) => m.includes('로그인 확인')));
    assert.ok(failing.get('stu-enter-header').some((m) => m.includes('헤더 타이머')));
    assert.ok(failing.get('stu-ai-panel').some((m) => m.includes('탭 전환')));

    const barHtml = renderSessionBar({
      mode: 'region',
      selectedRegion: 'header',
      regions: [{ id: 'header', title: '헤더', color: '#1976d2' }],
      busySet: new Set(['header']),
      esc: (s) => String(s),
    });
    assert.match(barHtml, /🧭 통합 세션/);
    assert.match(barHtml, /⚡1/);
    assert.match(barHtml, /🧪 검증 세션/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('workflow: 7-step propose, distribute, reconcileChecklist, and WorkflowStore persistence', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-wf-'));
  try {
    const project = new Project(tmp);
    await project.init({ name: 'WfApp' });
    const store = new WorkflowStore(project);

    const proposed = parseProposeResponse(JSON.stringify({
      summary: '2단 대시보드 구성',
      regions: [
        { id: 'Header', title: '헤더', purpose: '제목과 버튼' },
        { id: 'Main Area', title: '메인', purpose: '핵심 작업' },
      ],
      layout: {
        fill: true,
        rows: [
          { height: 2, cells: [{ id: 'Header', width: 12 }] },
          { height: 10, cells: [{ id: 'Main Area', width: 12 }] },
        ],
      },
      features: [
        { region: 'Header', name: '모달 열기', desc: '버튼 클릭 시 모달 표시' },
        { region: 'Main Area', name: '목록 필터', desc: '검색어 입력 시 필터링' },
      ],
    }));
    assert.equal(proposed.regions[0].id, 'header');
    assert.equal(proposed.regions[1].id, 'main-area');
    assert.equal(proposed.layout.cols, 12);
    assert.equal(proposed.features.length, 2);

    const dist = parseDistributeResponse(JSON.stringify({
      summary: '이벤트 통일',
      prompts: [
        { region: 'header', prompt: '헤더 구현' },
        { region: 'main-area', prompt: '메인 구현' },
      ],
      checklist: [
        { region: 'header', name: '모달 열기', desc: '모달 표시' },
        { region: 'main-area', name: '목록 필터', desc: '필터링' },
      ],
    }), ['header', 'main-area']);
    assert.equal(dist.prompts.length, 2);
    assert.equal(dist.checklist.length, 2);

    const rec = reconcileChecklist(
      dist.checklist,
      { ok: true, syntaxErrors: [], connectionIssues: [], browser: { runtimeErrors: [], testResults: [{ name: 't1', ok: true }] } },
      { header: { html: '<header></header>' }, 'main-area': { html: '<main></main>' } },
    );
    assert.equal(rec.deployReady, true);
    assert.equal(rec.checklist.every((f) => f.implemented && f.verified), true);

    await store.write({ step: 7, workload: '테스트 앱', checklist: rec.checklist, deployReady: true });
    const saved = await store.read();
    assert.equal(saved.step, 7);
    assert.equal(saved.deployReady, true);

    const hubHtml = renderProjectHub({
      current: 'my-app',
      details: [
        { name: 'my-app', title: '수행평가 앱', regionsCount: 4, grid: { cols: 12, rows: 12 }, regions: [{ id: 'r1', title: '헤더', x: 0, y: 0, w: 12, h: 2 }], workflowStep: 7, checklistTotal: 2, checklistVerified: 2, deployReady: true },
        { name: 'quiz-app', title: '퀴즈 앱', regionsCount: 2, grid: { cols: 12, rows: 12 }, regions: [], workflowStep: 2, checklistTotal: 0, checklistVerified: 0, deployReady: false },
      ],
      query: '수행',
      esc: (s) => String(s),
    });
    assert.match(hubHtml, /수행평가 앱/);
    assert.doesNotMatch(hubHtml, /퀴즈 앱/);
    assert.match(hubHtml, /\/preview\?project=my-app/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('multi-screen layouts: flatten across screens and buildApp emits ide-screen + app.navigate', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-screens-'));
  try {
    const project = new Project(tmp);
    const multiLayout = {
      name: 'MultiScreen App',
      activeScreen: 'student',
      screens: [
        { id: 'student', title: '학생 화면', grid: { cols: 12, rows: 12, gap: 8, fill: true }, regions: [{ id: 'stu-main', title: '학생 메인', x: 0, y: 0, w: 12, h: 12, color: '#5b5bd6' }] },
        { id: 'teacher', title: '교사 화면', grid: { cols: 12, rows: 12, gap: 8, fill: true }, regions: [{ id: 'tea-panel', title: '교사 패널', x: 0, y: 0, w: 12, h: 12, color: '#f76b15' }] },
      ],
      regions: [],
    };
    await project.init(multiLayout);
    await project.saveLayout(multiLayout);
    await project.writeRegion('stu-main', { html: '<h1>학생용</h1>' }, { backup: false });
    await project.writeRegion('tea-panel', { html: '<h1>교사용</h1>' }, { backup: false });

    const flat = flatten(multiLayout);
    assert.equal(flat.length, 2);
    assert.equal(flat[0].screen, 'student');
    assert.equal(flat[1].screen, 'teacher');

    const html = await buildApp(project, { preview: true });
    assert.match(html, /class="ide-screen active" data-screen="student"/);
    assert.match(html, /class="ide-screen" data-screen="teacher" hidden/);
    assert.match(html, /navigate\(screenId/);
    assert.match(html, /switch-screen/);

    const multiProp = parseProposeResponse(JSON.stringify({
      summary: '학생/교사 2화면 구성',
      screens: [
        { id: 'student', title: '학생 화면', regions: [{ id: 'stu-main', title: '학생 메인', purpose: '답안 작성' }], layout: { fill: true, rows: [{ height: 12, cells: [{ id: 'stu-main', width: 12 }] }] } },
        { id: 'teacher', title: '교사 화면', regions: [{ id: 'tea-panel', title: '교사 채점', purpose: '채점' }], layout: { fill: true, rows: [{ height: 12, cells: [{ id: 'tea-panel', width: 12 }] }] } },
      ],
      features: [{ region: 'stu-main', name: '답안 작성', desc: '입력' }, { region: 'tea-panel', name: 'AI 채점', desc: '채점' }],
    }));
    assert.equal(multiProp.screens.length, 2);
    assert.equal(multiProp.regions.length, 2);
    assert.equal(multiProp.regions[1].screen, 'teacher');

    // 다중 화면에서 다른 화면의 영역을 합치는 layout 계획이 정상 검증(valid: true)되어야 함
    const mergedPlan = parsePlan(JSON.stringify({
      summary: '교사 패널을 학생 화면 오른쪽으로 병합',
      layout: {
        fill: true,
        rows: [{ height: 12, cells: [{ id: 'stu-main', width: 8 }, { id: 'tea-panel', width: 4 }] }],
      },
      steps: [{ target: 'stu-main', prompt: '연결 버튼 추가' }],
    }), new Set(['stu-main', 'tea-panel']), { layout: multiLayout });
    assert.equal(mergedPlan.layout?.valid, true);
    assert.equal(mergedPlan.layout?.targetScreen, 'student');
    assert.deepEqual(mergedPlan.layout?.movedRegions, ['tea-panel']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('layout-magic: presets, swap, and adjacent splitter drag', () => {
  const regs = [
    { id: 'r1', x: 0, y: 0, w: 12, h: 2 },
    { id: 'r2', x: 0, y: 2, w: 4, h: 10 },
    { id: 'r3', x: 4, y: 2, w: 8, h: 10 },
  ];
  const splitters = findSplitters(regs);
  const vSplit = splitters.find((s) => s.axis === 'v' && s.line === 4);
  assert.ok(vSplit, '세로 공유 경계선을 찾아야 함');
  assert.equal(applySplitterMove(regs, vSplit, 6), true);
  assert.equal(regs[1].w, 6);
  assert.equal(regs[2].x, 6);
  assert.equal(regs[2].w, 6);

  const target = findSwapTarget(regs, 'r2', { col: 7, row: 5 });
  assert.equal(target?.id, 'r3');
  swapRegionGeometry(regs[1], regs[2]);
  assert.equal(regs[1].x, 6);
  assert.equal(regs[2].x, 0);

  const grid = applyLayoutPreset(regs, 'grid-2x2', 12, 12);
  assert.equal(grid.length, 3);
  assert.equal(grid[0].w, 6);
  assert.equal(grid[1].w, 6);
  assert.equal(grid[2].w, 12);

  assert.equal(classifySmartRequest('왼쪽 사이드바 좀 더 좁게').kind, 'layout');
  assert.equal(classifySmartRequest('검색창 기능 추가해줘').kind, 'feature');
  assert.equal(classifySmartRequest('파란색으로 바꿔줘', { hasInspected: true }).kind, 'inspect');
  assert.equal(classifySmartRequest('이 화면은 어떻게 동작해?').kind, 'question');
  assert.equal(classifySmartRequest('어떤 기능을 먼저 넣는 게 좋을까').kind, 'question');
  assert.equal(classifySmartRequest('버튼 색 바꿔줘', { forceMode: 'question' }).kind, 'question');
});
