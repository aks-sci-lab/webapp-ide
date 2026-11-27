import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { RUNTIME } from '../lib/build.js';
import { normalizeSkills, recommendSkills, skillsRuntime, skillsCss, skillsPromptSection, skillsProvides } from '../public/skills.js';

const plain = (x) => JSON.parse(JSON.stringify(x));

function sandbox(enabled, extra = {}) {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const win = { document: { title: '테스트앱', body: null, addEventListener() {} }, localStorage, console, TextDecoder, TextEncoder, Blob, location: {}, navigator: {}, addEventListener() {}, ...extra };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(`${RUNTIME}\n${skillsRuntime({ enabled, options: extra.__options || {} })}`, win);
  return { win, app: win.__ideApp, store };
}

test('grades: totals, tie ranks, weighted scores, 9-grade and letter grades', () => {
  const { app } = sandbox(['grades']);
  const got = [];
  app.on('grades:computed', (r) => got.push(r.count));
  const r = app.grades.compute(
    [['번호', '이름', '국어', '수학'], ['1', '가', '90', '80'], ['2', '나', '85', '85'], ['3', '다', '100', '60'], ['4', '라', '', '50']],
    { grade: 'five' },
  );
  assert.deepEqual(plain(r.items), ['국어', '수학'], '번호는 점수 열이 아님');
  const by = Object.fromEntries(r.rows.map((x) => [x.이름, x]));
  assert.equal(by.가.total, 170);
  assert.equal(by.나.rank, 1, '170 동점이 둘 → 둘 다 1등');
  assert.equal(by.가.rank, 1);
  assert.equal(by.다.rank, 3, '동점 다음은 3등');
  assert.equal(by.라.total, 50, '빈 칸은 빼고 계산');
  assert.equal(by.라.average, 50);
  assert.equal(by.가.grade, 'B', '여러 과목 합계일 때 등급은 평균으로');
  assert.equal(r.summary.국어.count, 3);
  assert.equal(r.summary.국어.max, 100);
  assert.deepEqual(got, [4]);
  assert.equal(app.get('grades').count, 4);

  const w = app.grades.compute([{ name: 'A', 중간: 80, 기말: 90, 수행: 18 }, { name: 'B', 중간: 100, 기말: 70, 수행: 20 }], {
    items: [{ key: '중간', weight: 30 }, { key: '기말', weight: 40 }, { key: '수행', weight: 30, max: 20 }],
  });
  assert.equal(w.by, 'weighted');
  assert.equal(w.rows.find((x) => x.name === 'A').weighted, 24 + 36 + 27);
  assert.equal(w.rows.find((x) => x.name === 'B').weighted, 30 + 28 + 30);
  assert.equal(w.rows[0].name, 'B');

  const many = Array.from({ length: 100 }, (_, i) => ({ name: 's' + i, 점수: 100 - i }));
  const nine = app.grades.compute(many, { grade: 'nine' });
  const g = (name) => nine.rows.find((x) => x.name === name).grade;
  assert.equal(g('s0'), 1);
  assert.equal(g('s3'), 1, '4등까지 1등급 (4%)');
  assert.equal(g('s4'), 2);
  assert.equal(g('s99'), 9);
  assert.deepEqual(plain(app.grades.rank([10, 20, 20, null], { order: 'asc' })), [1, 2, 2, null]);
  assert.equal(app.grades.num('1,234점'), 1234);
  assert.equal(app.grades.toCsv(w)[0][0], '석차');
});

test('groups: even sizes, seeded, balance, together/apart, seat chart', () => {
  const { app } = sandbox(['roster', 'groups']);
  const kids = Array.from({ length: 22 }, (_, i) => ({ name: '학생' + (i + 1), gender: i % 3 ? '남' : '여' }));
  const r = app.groups.make(kids, { count: 5, seed: 7 });
  const sizes = r.groups.map((g) => g.length).sort();
  assert.deepEqual(plain(sizes), [4, 4, 4, 5, 5]);
  assert.equal(new Set(r.names.flat()).size, 22);
  assert.deepEqual(plain(app.groups.make(kids, { count: 5, seed: 7 }).names), plain(r.names), '같은 seed → 같은 결과');
  assert.equal(app.groups.make(kids, { size: 4 }).groups.length, 6);

  const bal = app.groups.make(kids, { count: 4, balance: 'gender', seed: 3 });
  const girls = bal.groups.map((g) => g.filter((m) => m.gender === '여').length);
  assert.ok(Math.max(...girls) - Math.min(...girls) <= 1, `성별 고르게: ${girls}`);

  for (let seed = 0; seed < 20; seed++) {
    const c = app.groups.make(kids, { count: 5, seed, together: [['학생1', '학생2']], apart: [['학생3', '학생4', '학생5']] });
    const home = (n) => c.names.findIndex((g) => g.includes(n));
    assert.equal(home('학생1'), home('학생2'), `together seed ${seed}`);
    assert.notEqual(home('학생3'), home('학생4'), `apart seed ${seed}`);
    assert.notEqual(home('학생3'), home('학생5'), `apart seed ${seed}`);
    assert.equal(c.conflicts, 0);
    assert.equal(new Set(c.names.flat()).size, 22);
  }

  // 명단 스킬과 함께: 명단을 안 주면 올린 명단을 쓰고, 결석은 빼고
  app.roster.set([{ name: '가' }, { name: '나', absent: true }, { name: '다' }]);
  assert.deepEqual(plain(app.groups.make(null, { count: 1 }).names.flat().sort()), ['가', '다']);

  const s = app.groups.seats(kids, { cols: 6, front: ['학생9'], fixed: { 학생1: [3, 5] }, empty: [[0, 0]], seed: 1 });
  assert.equal(s.rows, 4);
  assert.equal(s.names[3][5], '학생1');
  assert.equal(s.names[0][0], null);
  assert.equal(s.names[0][1], '학생9', '앞자리 우선');
  assert.equal(s.names.flat().filter(Boolean).length, 22);
  assert.deepEqual(plain(s.overflow), []);
  assert.equal(app.get('seats').cols, 6);
});

test('timer: countdown ends once, pause keeps time, events reach other regions', () => {
  let now = 1_000_000;
  const queue = [];
  const FakeDate = class extends Date {};
  FakeDate.now = () => now;
  const { app } = sandbox(['timer'], { Date: FakeDate, setTimeout: (fn, ms) => { queue.push({ fn, at: now + ms }); return queue.length; }, clearTimeout: () => {} });
  const run = (ms) => {
    const end = now + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      if (!queue.length || queue[0].at > end) break;
      const job = queue.shift();
      now = job.at;
      job.fn();
    }
    now = end;
  };
  const ends = [];
  app.on('timer:end', (i) => ends.push(i.id));
  const t = app.timer.create({ seconds: 3, id: '발표', sound: false });
  assert.equal(t.text(), '00:03');
  t.start();
  run(1500);
  assert.equal(t.text(), '00:02');
  t.pause();
  run(10_000);
  assert.equal(t.text(), '00:02', '멈춘 동안 시간이 흐르지 않음');
  t.start();
  run(5000);
  assert.deepEqual(ends, ['발표']);
  assert.equal(t.running, false);
  assert.equal(t.ended, true);
  t.start();
  assert.equal(t.running, true, '끝난 뒤 시작하면 처음부터');
  t.reset(90);
  assert.equal(t.text(), '01:30');
  const sw = app.timer.create({ mode: 'stopwatch' }).start();
  run(65_000);
  assert.equal(sw.text(), '01:05');
  assert.equal(app.timer.format(3725), '1:02:05');
});

test('sheets: share links become CSV links, reads parse, writes queue offline and flush later', async () => {
  const calls = [];
  let online = true;
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (!online) throw new TypeError('Failed to fetch');
    if (init.method === 'POST') return { ok: true, json: async () => ({ ok: true, added: JSON.parse(init.body).rows.length }) };
    return { ok: true, text: async () => '﻿이름,점수\n가,90\n"나, 다",80\n' };
  };
  const options = { sheetsUrl: 'https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42', sheetsScript: 'https://script.google.com/macros/s/XYZ-1/exec' };
  const { app } = sandbox(['sheets'], { fetch, __options: options });
  assert.equal(app.sheets.csvUrl('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42'), 'https://docs.google.com/spreadsheets/d/abc_123/gviz/tq?tqx=out:csv&gid=42');
  assert.match(app.sheets.csvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-x/pubhtml'), /\/d\/e\/2PACX-x\/pub\?output=csv/);
  assert.throws(() => app.sheets.csvUrl('https://example.com/x'), /구글 시트 주소가 아닙니다/);
  assert.deepEqual(plain(app.sheets.configured), { read: true, write: true });

  const d = await app.sheets.read();
  assert.deepEqual(plain(d.objects), [{ 이름: '가', 점수: '90' }, { 이름: '나, 다', 점수: '80' }]);
  assert.equal(app.get('sheet').rows.length, 3);

  online = false;
  const errs = [];
  app.on('sheets:error', (e) => errs.push(e.what));
  await assert.rejects(app.sheets.append([{ 이름: '라', 점수: 70 }]), /시트에 저장/);
  assert.equal(app.sheets.pending(), 1);
  assert.deepEqual(errs, ['시트에 저장']);
  online = true;
  await app.sheets.append([{ 이름: '마', 점수: 60 }]);
  assert.equal(app.sheets.pending(), 0, '다시 연결되면 모아 둔 것부터 보냄');
  const posts = calls.filter((c) => c.init.method === 'POST' && c.url === options.sheetsScript).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(posts.slice(-2).map((p) => p.rows), [[['라', 70]], [['마', 60]]]);
  assert.equal(calls.at(-1).init.headers['Content-Type'], 'text/plain;charset=utf-8', 'CORS 사전 확인 없이 보냄');
});

test('new skills: catalog, recommend, options, guide, css and provided events', () => {
  assert.deepEqual(normalizeSkills({ enabled: ['grades', 'qr'], options: { sheetsUrl: 'https://evil.example/x', sheetsScript: 'https://script.google.com/macros/s/AB_c-1/exec' } }).options, {
    backupButton: true,
    sheetsScript: 'https://script.google.com/macros/s/AB_c-1/exec',
  });
  const rec = recommendSkills('수행평가 점수 합계와 석차를 내고, 모둠을 랜덤으로 나누고, 발표 타이머, 구글 시트에 저장, 설문 QR 코드');
  for (const id of ['grades', 'groups', 'timer', 'sheets', 'qr']) assert.ok(rec.includes(id), id);
  const guide = skillsPromptSection({ enabled: ['grades', 'groups', 'timer', 'sheets', 'qr'] });
  for (const api of ['app.grades.compute', 'app.groups.make', 'app.timer.mount', 'app.sheets.read', 'app.qr.render']) assert.ok(guide.includes(api), api);
  const css = skillsCss({ enabled: ['groups', 'timer'] });
  assert.match(css, /\.ide-seats/);
  assert.match(css, /\.ide-timer/);
  assert.doesNotMatch(css, /@media print/);
  const p = skillsProvides({ enabled: ['grades', 'groups', 'timer', 'sheets'] });
  for (const e of ['grades:computed', 'groups:made', 'seats:made', 'timer:end', 'sheets:loaded']) assert.ok(p.events.includes(e), e);
  for (const s of ['grades', 'groups', 'seats', 'sheet']) assert.ok(p.states.includes(s), s);
});

test('qr: picks the smallest version, draws finder patterns, handles Korean and refuses too-long text', () => {
  const { app } = sandbox(['qr']);
  const q = app.qr.encode('https://example.com');
  assert.equal(q.version, 2, '19바이트, 오류 정정 M → 버전 2');
  assert.equal(q.size, 25);
  const finder = (x0, y0) => [0, 1, 2, 3, 4, 5, 6].map((y) => [0, 1, 2, 3, 4, 5, 6].map((x) => (q.modules[y0 + y][x0 + x] ? 1 : 0)).join('')).join('/');
  const F = '1111111/1000001/1011101/1011101/1011101/1000001/1111111';
  assert.equal(finder(0, 0), F);
  assert.equal(finder(18, 0), F);
  assert.equal(finder(0, 18), F);
  assert.equal(app.qr.encode('가'.repeat(100), { ecc: 'H' }).version >= 7, true, '한글 300바이트 → 버전 정보가 들어가는 큰 판');
  assert.match(app.qr.svg('hi', { size: 120 }), /^<svg[^>]+width="120"[\s\S]*<path d="M/);
  assert.throws(() => app.qr.encode('x'.repeat(3000)), /너무 깁니다/);
});
