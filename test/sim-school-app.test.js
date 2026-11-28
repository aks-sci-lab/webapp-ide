// 가상 학교 앱(버그를 심은 "우리반 수행평가 도우미")으로 점검 파이프라인이 무엇을 잡는지 확인한다.
// 실제 브라우저 검사는 Edge/Chrome 이 있을 때만 (IDE_BROWSER 로 지정 가능).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Project } from '../lib/project.js';
import { verifyProject } from '../lib/app-verify.js';
import { summarizeExplore } from '../lib/explore.js';
import { findBrowser } from '../lib/shot.js';
import { recommendSkills } from '../public/skills.js';
import { countVerifyIssues, buildVerifyFixPrompt } from '../public/app-verifier.js';
import { extractFailingRegions } from '../public/session-panel.js';
import { REGION_CODE, AI_TESTS } from './fixtures/school-app.js';

const LAYOUT = {
  name: '우리반 수행평가 도우미',
  mode: 'grid',
  grid: { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
  regions: [
    { id: 'header', title: '상단', x: 0, y: 0, w: 12, h: 2 },
    { id: 'roster', title: '명단', x: 0, y: 2, w: 3, h: 10 },
    { id: 'scores', title: '점수', x: 3, y: 2, w: 5, h: 10 },
    { id: 'groups', title: '모둠', x: 8, y: 2, w: 4, h: 5 },
    { id: 'share', title: '공유', x: 8, y: 7, w: 4, h: 5 },
  ],
};

async function makeProject() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-sim-'));
  const p = new Project(tmp);
  await p.init(LAYOUT);
  await p.saveLayout({ ...(await p.getLayout()), ...LAYOUT });
  for (const [id, f] of Object.entries(REGION_CODE)) await p.writeRegion(id, f, { backup: false });
  await p.writeSkills({ enabled: ['print', 'backup', 'roster', 'grades', 'groups', 'timer', 'sheets', 'qr'] });
  await p.writeTests(AI_TESTS);
  return { p, tmp };
}

test('skills auto-enable: one-letter words like 표·반 inside 발표·반영 do not switch on unrelated skills', () => {
  const rec = recommendSkills('발표·보고서 점수를 반영비율로 합계 내고 석차를 낸다');
  assert.ok(rec.includes('grades'));
  assert.ok(!rec.includes('formScan'), '발표/보고서 → 양식 분석 아님');
  assert.ok(!rec.includes('roster'), '반영 → 명단 아님');
  assert.ok(recommendSkills('나이스 양식에 맞춰 내보내기').includes('formScan'));
  assert.ok(recommendSkills('우리 반 학생 명단').includes('roster'));
});

test('explore summary: saved input values that do not come back after reload are errors', () => {
  const s = summarizeExplore({
    clicks: 1,
    regions: {
      scores: { id: 'scores', filled: 2, clicks: [], errors: [], reload: [{ when: '클릭', kind: 'input', message: '입력한 값 2개가…' }] },
      groups: { id: 'groups', filled: 1, clicks: [], errors: [], reload: [{ when: '클릭', message: '처음 화면' }] },
    },
  });
  const by = Object.fromEntries(s.regions.map((r) => [r.id, r]));
  assert.equal(by.scores.reloadReverted.length, 1);
  assert.equal(by.groups.reloadReverted.length, 0);
  assert.equal(by.groups.reloadWarnings.length, 1);
  assert.equal(s.errorCount, 1);
});

test('a test that looks for an element the app never had is flagged as a test problem, not sent to auto-heal', () => {
  const report = {
    browser: {
      runtimeErrors: [],
      testResults: [
        { name: '없는 버튼', ok: false, suspect: '테스트가 앱 코드 어디에도 없는 #saveScores 를 찾습니다', steps: [{ ok: false, action: 'click', selector: '#saveScores', region: '', msg: '요소를 찾지 못함: #saveScores' }] },
        { name: '합계', ok: false, steps: [{ ok: false, action: 'expectText', selector: '.total', region: 'scores', msg: '"170" 가 없음' }] },
      ],
    },
  };
  const c = countVerifyIssues(report);
  assert.equal(c.testFail, 1);
  assert.equal(c.testSuspect, 1);
  assert.doesNotMatch(buildVerifyFixPrompt(report), /saveScores/);
  assert.deepEqual([...extractFailingRegions(report, ['scores', 'share']).keys()], ['scores']);
});

test('school app simulation: real browser verify catches planted bugs without blaming healthy regions', { timeout: 120000 }, async (t) => {
  if (!(await findBrowser())) return t.skip('Edge/Chrome 이 없어 실제 브라우저 검사를 건너뜀');
  const { p, tmp } = await makeProject();
  try {
    const r = await verifyProject(p);
    assert.equal(r.browserError, '');
    assert.equal(r.ok, false);
    // B5 이벤트 이름 어긋남
    assert.ok(r.connectionIssues.some((i) => i.level === 'error' && i.regions?.includes('groups')));
    // B2 문자열 덧셈 → AI 테스트 실패
    assert.ok(r.browser.testResults.some((x) => !x.ok && !x.suspect && /8090/.test(x.steps.at(-1).msg)));
    // 앱에 없는 #saveScores 를 찾는 테스트 → 테스트 문제
    assert.ok(r.browser.testResults.some((x) => x.suspect && /saveScores/.test(x.suspect)));

    const ex = Object.fromEntries(r.explore.regions.map((x) => [x.id, x]));
    // B3 빈 명단에서 석차 계산
    assert.ok(ex.scores.errors.some((e) => /^빈 상태에서/.test(e.when) && /toFixed/.test(e.message)), JSON.stringify(ex.scores.errors));
    // B1 점수는 저장되는데 새로고침하면 칸이 빔
    assert.ok(ex.scores.reloadReverted.some((v) => v.kind === 'input'), JSON.stringify(ex.scores.reloadReverted));
    // B4 처리기 없는 버튼
    assert.ok(ex.scores.deadButtons.some((b) => /exportBtn/.test(b)));
    // B6 두 번째 클릭에서 오류
    assert.ok(ex.groups.errors.some((e) => /두 번째 클릭/.test(e.when) && /define/.test(e.message)), JSON.stringify(ex.groups.errors));
    // B7 모둠 결과가 새로고침에 사라짐 → 경고
    assert.ok(ex.groups.reloadWarnings.length >= 1);
    // B8 async 처리기 실패 → 그 영역 오류
    assert.ok(ex.share.errors.some((e) => /Apps Script/.test(e.message)));
    // 저장하지 않는 입력칸(학급 외 다른 영역)은 다른 영역이 저장했다고 오류가 되면 안 된다
    for (const id of ['header', 'roster']) {
      assert.deepEqual(ex[id].errors, [], id);
      assert.deepEqual(ex[id].reloadReverted, [], id);
    }
    assert.deepEqual(ex.share.reloadReverted, []);
    assert.deepEqual(ex.groups.reloadReverted, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
