import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanConnections } from '../lib/analysis.js';
import { reconcileChecklist } from '../lib/workflow.js';
import { summarizeExplore } from '../lib/explore.js';
import { extractFailingRegions } from '../public/session-panel.js';
import { countVerifyIssues } from '../public/app-verifier.js';
import { skillsProvides } from '../public/skills.js';
import { Project } from '../lib/project.js';

test('connections: built-in skill events are not errors, and issues name the region to fix', () => {
  const src = {
    list: 'app.on("state:roster", draw); app.on("roster:loaded", draw); app.on("roster:update", f);',
    form: 'app.emit("roster:updated", x);',
  };
  const none = scanConnections(src);
  assert.ok(none.issues.some((i) => i.text.includes('"roster:loaded"')));
  const res = scanConnections(src, skillsProvides({ enabled: ['roster'] }));
  assert.ok(!res.issues.some((i) => /roster:loaded|공유 상태 "roster"/.test(i.text)));
  const err = res.issues.find((i) => i.level === 'error');
  assert.deepEqual(err.regions, ['list']);
  assert.deepEqual(res.issues.find((i) => i.level === 'warn').regions, ['form']);
});

test('auto-heal blames only the region an issue names, not regions whose id is a substring', () => {
  const report = { connectionIssues: [{ level: 'error', text: '"roster:update" 이벤트를 order 이(가) 기다리지만 아무도 보내지 않습니다', regions: ['order'] }] };
  const m = extractFailingRegions(report, ['order', 'roster']);
  assert.deepEqual([...m.keys()], ['order']);
  // 예전 보고서(regions 없음)도 이름 일부가 겹친 영역은 고르지 않는다
  const old = { connectionIssues: [{ level: 'error', text: '"roster:update" 이벤트를 order 이(가) 기다리지만 아무도 보내지 않습니다' }] };
  assert.deepEqual([...extractFailingRegions(old, ['order', 'roster']).keys()], ['order']);
});

test('checklist: a feature fails only for problems in its own region, including hands-on explore results', () => {
  const checklist = [
    { region: 'roster', name: '명단 입력' },
    { region: 'order', name: '순서 뽑기' },
    { region: 'header', name: '다음 발표자' },
  ];
  const files = { roster: { html: '<textarea></textarea>' }, order: { html: '<button></button>' }, header: { html: '<h1></h1>' } };
  const explore = summarizeExplore({
    clicks: 3,
    pageErrors: [],
    regions: {
      roster: { id: 'roster', filled: 1, clicks: [], errors: [], reload: [] },
      order: { id: 'order', filled: 0, clicks: [{ label: '#noop', reacted: false, effects: [], errors: [] }], errors: [], reload: [{ when: '입력', message: '처음 화면으로 돌아감' }] },
      header: { id: 'header', filled: 0, clicks: [], errors: [], reload: [{ when: '클릭', message: '처음 화면으로 돌아감' }] },
    },
  });
  assert.equal(explore.errorCount, 1);
  assert.equal(explore.warnCount, 2);
  const report = {
    ok: false,
    syntaxErrors: [],
    connectionIssues: [{ level: 'error', text: '"roster:update" 이벤트를 order 이(가) 기다리지만…', regions: ['order'] }],
    browser: { runtimeErrors: [], testResults: [{ name: 'x', ok: false, steps: [{ ok: false, region: 'order' }] }, { name: 'y', ok: true, steps: [{ ok: true, region: 'roster' }] }] },
    explore,
  };
  const { checklist: out, deployReady } = reconcileChecklist(checklist, report, files);
  const by = Object.fromEntries(out.map((f) => [f.region, f]));
  assert.equal(by.roster.verified, true, '다른 영역 문제로 roster 가 떨어지면 안 됨');
  assert.equal(by.header.verified, true, '버튼 결과가 새로고침에 사라지는 것은 경고일 뿐');
  assert.equal(by.order.verified, false);
  assert.match(by.order.note, /연결 오류/);
  assert.match(by.order.note, /새로고침/);
  assert.match(by.order.note, /반응 없는 버튼/);
  assert.equal(deployReady, false);

  const counts = countVerifyIssues({ ...report, fieldErrors: [{ message: 'x' }] });
  assert.equal(counts.exploreErr, 1);
  assert.equal(counts.fieldErr, 1);
});

test('field errors: import report and backup files, dedupe, and reopen after a fix only if they happen again', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-fe-'));
  try {
    const p = new Project(tmp);
    await fs.mkdir(tmp, { recursive: true });
    const err = { region: 'order', message: 'boom', count: 2, first: '2026-11-27T01:00:00Z', last: '2026-11-27T01:05:00Z', recent: ['클릭 [order] button#boom'] };
    const r1 = await p.importFieldErrors({ kind: 'webapp-error-report', errors: [err, { region: '../x', message: 'bad region' }] });
    assert.equal(r1.added, 2);
    const list = await p.readFieldErrors();
    assert.equal(list.find((e) => e.message === 'bad region').region, null);
    // 같은 기록을 다시 가져와도 늘지 않는다
    assert.equal((await p.importFieldErrors({ kind: 'webapp-error-report', errors: [err] })).added, 0);
    assert.equal((await p.readFieldErrors()).find((e) => e.message === 'boom').count, 2);
    // 백업 파일 안의 오류 기록도 읽는다
    const backup = { kind: 'webapp-backup', localStorage: { '__ideErrors:앱': JSON.stringify([{ region: 'roster', message: 'other', last: '2026-11-27T02:00:00Z' }]), other: '1' } };
    assert.equal((await p.importFieldErrors(backup)).added, 1);
    await assert.rejects(p.importFieldErrors({ hello: 1 }), /오류 기록 파일이 아닙니다/);

    assert.equal((await p.activeFieldErrors()).length, 3);
    assert.equal(await p.markFieldErrorsFixed('order'), 1);
    assert.ok(!(await p.activeFieldErrors()).some((e) => e.region === 'order'));
    // 고친 뒤 다시 난 기록을 가져오면 다시 열린다
    await p.importFieldErrors({ kind: 'webapp-error-report', errors: [{ ...err, last: '2999-01-01T00:00:00Z' }] });
    assert.ok((await p.activeFieldErrors()).some((e) => e.region === 'order'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
