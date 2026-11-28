// 시뮬레이션 #3 "우리반 운영판" (탭 3개 · 영역 10개 · 스킬 6개): 보안·상태·경계값 버그를 점검이 잡는지,
// 그리고 같은 앱을 고친 판에서는 아무것도 오류로 몰지 않는지 확인한다. 실제 브라우저 검사는 Edge/Chrome 이 있을 때만.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { verifyProject, scanSecrets, scanStoreKeys } from '../lib/app-verify.js';
import { summarizeExplore } from '../lib/explore.js';
import { findBrowser } from '../lib/shot.js';
import { countVerifyIssues, buildVerifyFixPrompt } from '../public/app-verifier.js';
import { extractFailingRegions } from '../public/session-panel.js';
import { makeClassHub, score } from '../scripts/sim-class-hub.js';
import { checkViewports } from '../lib/viewport-check.js';
import { Project } from '../lib/project.js';
import os from 'node:os';
import path from 'node:path';

test('secret scan: API keys and tokens written in app code are security errors (masked in the report)', () => {
  const issues = scanSecrets({
    sync: "const KEY = 'AIzaSyB7x1Qe8sK2vLmN4pQrStUvWxYz0123456';",
    ai: "headers: { 'x-api-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }",
    ok: "const placeholder = 'AIza...'; // 설명용",
  });
  assert.deepEqual(issues.map((i) => i.region), ['sync', 'ai']);
  assert.ok(issues.every((i) => i.level === 'error'));
  assert.match(issues[0].detail, /구글 API 키/);
  assert.doesNotMatch(issues[0].detail, /0123456/, '키 전체를 보고서에 다시 적지 않는다');
  assert.match(issues[1].detail, /Anthropic/);
});

test('store key scan: two regions writing the same app.store key are flagged, app.persist shared state is not', () => {
  const issues = scanStoreKeys({
    seat: "app.store.set('data', names); app.persist('roster', [])",
    memo: "app.store.set('data', t.value); app.persist('roster', [])",
    stats: "app.store.set('history', h)",
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'data');
  assert.deepEqual(issues[0].regions.sort(), ['memo', 'seat']);
});

test('explore summary: security findings are errors, leak/corrupt findings are warnings, boundary duplicates collapse', () => {
  const s = summarizeExplore({
    clicks: 2,
    regions: {
      a: { id: 'a', filled: 1, clicks: [], reload: [{ when: '클릭', kind: 'stale', message: '새로고침해야…' }], warnings: [{ when: 'x', kind: 'interval', message: '반복 타이머' }],
        security: [{ when: '글자 입력', kind: 'html', message: '태그' }],
        errors: [{ when: '숫자 칸에 0 넣고 #b 클릭', message: 'boom' }, { when: '#b 클릭', message: 'boom' }, { when: '숫자 칸에 0 넣고 #c 클릭', message: 'Invalid array length' }] },
    },
  });
  const a = s.regions[0];
  assert.equal(a.errors.length, 2, '보통 클릭에서도 나는 오류는 경계값 오류로 또 세지 않음');
  assert.equal(a.reloadReverted.length, 1);
  assert.equal(s.errorCount, 4);
  assert.equal(s.warnCount, 1);
  const report = { explore: s, securityIssues: [{ level: 'error', region: 'a', detail: '키', fix: '지우기' }] };
  assert.equal(countVerifyIssues(report).security, 1);
  assert.match(buildVerifyFixPrompt(report), /\[a \/ 보안\] 키/);
  assert.ok(extractFailingRegions(report, ['a']).get('a').some((m) => /보안 문제/.test(m)));
});

test('class hub simulation: catches the hard planted bugs (security, cross-tab state, boundaries, leaks)', { timeout: 180000 }, async (t) => {
  if (!(await findBrowser())) return t.skip('Edge/Chrome 이 없어 실제 브라우저 검사를 건너뜀');
  const { p, tmp } = await makeClassHub();
  try {
    const r = await verifyProject(p, { viewportShots: false });
    assert.equal(r.browserError, '');
    assert.ok(!r.explore.error, r.explore.error);
    assert.equal(r.ok, false);
    const s = Object.fromEntries(score(r).map((x) => [x.id, x.caught]));
    // H13(점수 범위)·H14(실패를 숨김)는 앱 규칙을 알아야 해서 자동 점검으로는 못 잡는다고 보고 뺀다
    for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', 'H12', 'H15']) assert.ok(s[id], `${id} 를 놓침`);
    const ex = Object.fromEntries(r.explore.regions.map((x) => [x.id, x]));
    // 오탐 없음: 버그가 없는 탭 버튼(수업 화면)은 깨끗해야 하고, 1초 뒤에 바뀌는 타이머 버튼을 "반응 없음"으로 보지 않는다
    assert.deepEqual(ex['nav-class'].errors, []);
    assert.deepEqual(ex['nav-class'].deadButtons, []);
    assert.deepEqual(ex['lesson-timer'].deadButtons, []);
    // 보안 표시는 실제로 이름을 태그로 넣는 영역에만 (이름을 escape 하는 자리·점수 영역은 아님)
    assert.deepEqual(r.explore.regions.filter((x) => x.security.some((v) => v.kind === 'html')).map((x) => x.id), ['roster-setup']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('class hub simulation: the fixed version of the same app passes with no false errors', { timeout: 180000 }, async (t) => {
  if (!(await findBrowser())) return t.skip('Edge/Chrome 이 없어 실제 브라우저 검사를 건너뜀');
  const { p, tmp } = await makeClassHub({ clean: true });
  try {
    const r = await verifyProject(p, { viewportShots: false });
    assert.equal(r.browserError, '');
    assert.ok(!r.explore.error, r.explore.error);
    assert.deepEqual(r.securityIssues, []);
    assert.deepEqual(r.storeKeyIssues, []);
    assert.deepEqual(r.duplicateIds, []);
    for (const x of r.explore.regions) {
      assert.deepEqual([...x.errors, ...x.reloadReverted, ...x.security], [], x.id);
      assert.deepEqual(x.warnings, [], x.id);
      assert.deepEqual(x.deadButtons, [], x.id);
    }
    assert.equal(r.ok, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('viewport check: laptop/desktop/tablet sizes on every tab find layout problems in the buggy app', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Edge/Chrome 이 없어 실제 브라우저 검사를 건너뜀');
  const { p, tmp } = await makeClassHub();
  try {
    const r = await checkViewports(p, browser);
    assert.ok(!r.error, r.error);
    assert.deepEqual(r.sizes.map((v) => v.id), ['laptop', 'desktop', 'tablet-portrait', 'tablet-landscape']);
    const kinds = (k) => r.issues.filter((i) => i.kind === k);
    assert.ok(kinds('canvas').some((i) => i.region === 'stats' && i.level === 'error'), '숨은 탭 그래프');
    assert.equal(kinds('active-tab').length, 3, '탭 3개 모두 지금 탭 표시 없음');
    assert.equal(kinds('boundary').length, 3, '탭마다 영역 경계 없음');
    assert.ok(kinds('small-control').every((i) => /태블릿/.test(i.size)), '작은 버튼은 터치 화면에서만');
    assert.ok(kinds('small-control').length > 0);
    assert.ok(kinds('empty').every((i) => /데스크톱/.test(i.size)) && kinds('empty').length === 3, '큰 화면 빈 칸은 탭마다 한 줄');
    assert.equal(r.ok, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('viewport check: horizontal scroll and clipped content are errors; fixed app is clean and gets screenshots', { timeout: 180000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Edge/Chrome 이 없어 실제 브라우저 검사를 건너뜀');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-vp-'));
  try {
    const p = new Project(dir);
    const layout = { name: '넘침 시험', mode: 'grid', grid: { cols: 12, rows: 12, gap: 8, fill: true }, regions: [
      { id: 'wide', title: '넓은 표', x: 0, y: 0, w: 6, h: 12 },
      { id: 'tall', title: '긴 목록', x: 6, y: 0, w: 6, h: 12 },
    ] };
    await p.init(layout);
    await p.saveLayout({ ...(await p.getLayout()), ...layout });
    await p.writeRegion('wide', { html: '<h2>넓은 표</h2><div style="width:1500px">아주 넓은 내용</div>', css: ':scope { padding:12px; border:1px solid #ccc; overflow:visible !important; }' }, { backup: false });
    await p.writeRegion('tall', { html: '<h2>긴 목록</h2>' + '<p>줄</p>'.repeat(80), css: ':scope { padding:12px; border:1px solid #ccc; overflow:hidden !important; }' }, { backup: false });
    const r = await checkViewports(p, browser);
    assert.ok(r.issues.some((i) => i.kind === 'hscroll' && i.level === 'error'), JSON.stringify(r.issues));
    assert.ok(r.issues.some((i) => i.kind === 'clip-y' && i.region === 'tall' && i.level === 'error'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  const { p, tmp } = await makeClassHub({ clean: true });
  try {
    const shotsDir = path.join(tmp, 'verify-shots');
    const r = await checkViewports(p, browser, { shotsDir });
    assert.deepEqual(r.issues, []);
    assert.equal(r.shots.length, 12, '크기 4 × 탭 3');
    for (const s of r.shots) assert.ok((await fs.stat(path.join(shotsDir, s.file))).size > 1000, s.file);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
