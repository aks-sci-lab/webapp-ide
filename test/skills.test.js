import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { RUNTIME } from '../lib/build.js';
import { normalizeSkills, recommendSkills, skillsRuntime, skillsCss, skillsPromptSection } from '../public/skills.js';

const plain = (x) => JSON.parse(JSON.stringify(x));

// 브라우저 없이 런타임 + 스킬 코드를 돌려 볼 작은 창
function sandbox(skills) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  Object.defineProperty(localStorage, Symbol.iterator, { value: undefined });
  const win = { document: { title: '테스트앱', body: null, addEventListener() {} }, localStorage, console, TextDecoder, Blob, location: {} };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(`${RUNTIME}\n${skills ? skillsRuntime(skills) : ''}`, win);
  return { win, app: win.__ideApp, store };
}

test('runtime: events sent while the app starts reach regions that listen later', () => {
  const { app } = sandbox();
  app.set('students', ['a', 'b']);
  app.emit('roster:updated', ['a', 'b']);
  const got = [];
  app.on('roster:updated', (v) => got.push(['evt', v.length]));
  app.on('state:students', (v) => got.push(['state', v.length]));
  assert.deepEqual(got, [['evt', 2], ['state', 2]]);

  let ready = 0;
  app.on('app:ready', () => ready++);
  app.__markReady();
  app.__markReady();
  assert.equal(ready, 1);
  assert.equal(app.ready, true);

  // 시작이 끝난 뒤에는 예전처럼 새 이벤트만 받는다
  const late = [];
  app.on('roster:updated', (v) => late.push(v));
  app.on('state:students', (v) => late.push(v));
  assert.deepEqual(late, []);
  app.emit('roster:updated', 'x');
  assert.deepEqual(late, ['x']);
});

test('skills: normalize, recommend, prompt guide and print css', () => {
  assert.deepEqual(normalizeSkills(null).enabled, ['print']);
  assert.deepEqual(normalizeSkills({ enabled: ['roster', 'nope', 'roster'] }).enabled, ['roster']);
  assert.equal(normalizeSkills({ options: { backupButton: false } }).options.backupButton, false);

  const rec = recommendSkills('학생 명단을 엑셀로 올리고 결과를 인쇄하고 새로고침해도 저장');
  for (const id of ['roster', 'print', 'backup']) assert.ok(rec.includes(id), id);
  assert.deepEqual(recommendSkills(''), []);

  assert.match(skillsCss({ enabled: ['print'] }), /@media print/);
  assert.equal(skillsCss({ enabled: [] }), '');
  const guide = skillsPromptSection({ enabled: ['roster', 'formScan', 'backup', 'print'] });
  assert.match(guide, /app\.roster\.upload/);
  assert.match(guide, /app\.form\.download/);
  assert.match(guide, /app\.persist/);
  assert.match(guide, /app\.print/);
  assert.equal(skillsPromptSection({ enabled: [] }), '');
});

test('skills runtime: roster from pasted text and CSV with quotes', () => {
  const { app } = sandbox({ enabled: ['backup', 'roster'], options: { backupButton: false } });
  const list = app.roster.fromText('번호,이름,학번\n1,김민수,30301\n2,"정, 우진",30302\n');
  assert.deepEqual(plain(list.map((s) => [s.number, s.name, s.studentId])), [['1', '김민수', '30301'], ['2', '정, 우진', '30302']]);
  assert.equal(app.get('roster').length, 2);
  assert.deepEqual(plain(app.store.get('roster').map((s) => s.name)), ['김민수', '정, 우진']);

  // 머리글 없는 붙여넣기: 숫자 열은 번호, 글자 열은 이름
  assert.deepEqual(plain(app.roster.fromRows([['1', '가나'], ['2', '다라']]).map((s) => s.number + s.name)), ['1가나', '2다라']);
  // 이름만 있으면 번호를 매긴다
  assert.deepEqual(plain(app.roster.fromRows([['가나'], ['다라']]).map((s) => s.number)), ['1', '2']);
});

test('skills runtime: persist restores shared state after reload', () => {
  const first = sandbox({ enabled: ['backup'], options: { backupButton: false } });
  first.app.persist('scores', []);
  first.app.set('scores', [90, 80]);
  const saved = [...first.store.entries()];

  // 새로고침: 같은 저장소로 새 창
  const again = sandbox({ enabled: ['backup'], options: { backupButton: false } });
  for (const [k, v] of saved) again.store.set(k, v);
  const seen = [];
  again.app.persist('scores', []);
  again.app.on('state:scores', (v) => seen.push(v));
  assert.deepEqual(plain(again.app.get('scores')), [90, 80]);
  assert.deepEqual(plain(seen), [[90, 80]]);
});

test('skills runtime: form analysis finds title, header and column types, and fills in form order', () => {
  const { app } = sandbox({ enabled: ['formScan'] });
  const a = app.form.analyzeTable(app.files.parseText('수행평가 결과,,,\n학번,이름,점수,제출일\n30301,김민수,95,2026.11.20\n,,,\n,,,\n'));
  const s = a.sheets[0];
  assert.equal(s.title, '수행평가 결과');
  assert.equal(s.headerRow, 2);
  assert.deepEqual(plain(s.columns.map((c) => `${c.letter}:${c.name}:${c.type}`)), ['A:학번:number', 'B:이름:name', 'C:점수:number', 'D:제출일:date']);
  assert.equal(s.emptyRows, 2);
  const rows = app.form.fill(a, [{ 이름: '박하준', ' 점수 ': 88 }]);
  assert.deepEqual(plain(rows.at(-1)), ['', '박하준', 88, '']);
  assert.match(app.files.toCsv([['a', 'b,c']]), /^﻿a,"b,c"$/);
});
