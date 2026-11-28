// 시뮬레이션 #3용 가상 학교 앱 "우리반 운영판" — 탭 3개(수업·성적·설정), 영역 10개, 스킬 여러 개를 함께 쓰는 앱.
// 보안·상태·경계값처럼 찾기 어려운 실수를 일부러 심었다 (test/sim-class-hub.test.js).
// BUGS[].caught(report) 는 "점검 결과의 어느 항목이 이 버그를 가리키면 잡은 것으로 치는지" 를 미리 정해 둔 것.
const ex = (r, id) => r.explore?.regions?.find((x) => x.id === id) || { errors: [], reloadReverted: [], reloadWarnings: [], deadButtons: [], warnings: [], security: [] };
const has = (list, re) => (list || []).some((e) => re.test(typeof e === 'string' ? e : `${e.when || ''} ${e.message || ''} ${e.kind || ''}`));

export const BUGS = [
  { id: 'H1', region: 'roster-setup', kind: '보안(XSS)', desc: '학생 이름을 innerHTML 로 그대로 넣음 → 이름에 <img onerror> 같은 글자가 있으면 스크립트가 실행됨',
    caught: (r) => has(ex(r, 'roster-setup').security, /태그|HTML/) },
  { id: 'H2', region: 'score-board', kind: '상태(탭 간)', desc: '명단을 시작할 때 한 번만 읽음 → 설정 탭에서 명단을 넣어도 성적 탭은 새로고침 전까지 "명단 없음"',
    // 직접 조작 점검이 잡은 것만 센다 (AI 테스트도 "요소를 찾지 못함" 으로 실패하지만 원인은 알려 주지 못함)
    caught: (r) => has(ex(r, 'score-board').reloadReverted, /새로고침해야/) },
  { id: 'H3', region: 'stats', kind: '경계값(0명)', desc: '점수가 하나도 없을 때 평균 = 0/0 → 화면에 "평균 NaN점", 그대로 기록하면 null 이 저장돼 다음 실행 때 오류',
    caught: (r) => has(ex(r, 'stats').errors, /NaN|toFixed/) || has(ex(r, 'stats').warnings, /NaN/) },
  { id: 'H4', region: 'seat', kind: '경계값(0·음수)', desc: '"한 줄 자리 수"에 0 을 넣으면 new Array(Infinity) → RangeError',
    caught: (r) => has(ex(r, 'seat').errors, /Invalid array length|RangeError/) },
  { id: 'H5', region: 'lesson-timer', kind: '상태(타이머 누수)', desc: '시작을 누를 때마다 setInterval 이 하나씩 더 생김 → 두 번 누르면 2배속, "다시"로도 하나만 멈춤',
    caught: (r) => has(ex(r, 'lesson-timer').warnings, /반복 타이머|setInterval/) || has(ex(r, 'lesson-timer').errors, /반복 타이머|setInterval/) },
  { id: 'H6', region: 'seat', kind: '상태(처리기 누수)', desc: '자리를 그릴 때마다 같은 칸에 click 처리기를 또 붙임 → 섞을수록 한 번 클릭이 여러 번 처리됨',
    caught: (r) => has(ex(r, 'seat').warnings, /처리기/) || has(ex(r, 'seat').errors, /처리기/) },
  { id: 'H7', region: 'qr-share', kind: '보안(javascript: 링크)', desc: '사용자가 넣은 주소를 검사 없이 <a href> 에 넣음 → javascript: 주소가 그대로 링크가 됨',
    caught: (r) => has(ex(r, 'qr-share').security, /javascript/) },
  { id: 'H8', region: 'sync', kind: '보안(키 노출)', desc: '구글 API 키를 코드에 그대로 적음 → 내보낸 HTML 을 받은 누구나 키를 볼 수 있음',
    caught: (r) => (r.securityIssues || []).some((i) => i.region === 'sync' && /키/.test(i.detail)) },
  { id: 'H9', region: 'seat/memo', kind: '상태(저장 키 충돌)', desc: '자리 영역과 메모 영역이 같은 저장 키 "data" 를 씀 → 메모를 쓰면 다음 실행 때 자리 영역이 오류로 멈춤',
    caught: (r) => (r.storeKeyIssues || []).some((i) => i.key === 'data' && i.regions.includes('seat') && i.regions.includes('memo')) || has(ex(r, 'seat').errors, /map is not a function/) },
  { id: 'H10', region: 'stats', kind: '상태(저장값 모양)', desc: '저장된 기록이 배열이라고 믿고 바로 .slice → 예전 버전·다른 백업 파일을 불러오면 시작하자마자 오류',
    caught: (r) => has(ex(r, 'stats').warnings, /저장값|저장된 값/) },
  { id: 'H11', region: 'stats', kind: '탭(숨은 화면)', desc: '숨은 탭에서 시작할 때 canvas 크기를 clientWidth 로 정함 → 0×0 그림판이라 성적 탭에서 그래프가 안 보임',
    caught: (r) => has(ex(r, 'stats').errors, /그림판|canvas/) },
  { id: 'H12', region: 'score-board', kind: '탭(전환 시 입력 사라짐)', desc: '성적 탭으로 돌아올 때마다 처음 불러온 점수로 표를 다시 그림 → 방금 입력한 점수가 탭을 바꾸면 사라짐',
    caught: (r) => has(ex(r, 'score-board').errors, /탭|화면을 바꾸/) },
  { id: 'H13', region: 'score-board', kind: '검증(범위)', desc: '100점 만점인데 150, -5 같은 점수도 그대로 받음 (앱 규칙을 알아야 함)',
    caught: () => false },
  { id: 'H14', region: 'sync', kind: '오류 숨김', desc: '시트로 보내기가 실패해도 오류를 삼키고 "보냈습니다" 라고 표시',
    caught: () => false },
  { id: 'H15', region: 'nav-grade/nav-setup', kind: '중복 id', desc: '탭 버튼 id 가 세 화면에서 같고 document.getElementById 로 찾음 → 성적·설정 화면의 탭 버튼은 눌러도 반응 없음',
    caught: (r) => (r.duplicateIds || []).some((d) => d.id === 'goClass') && (ex(r, 'nav-grade').deadButtons.length > 0 || ex(r, 'nav-setup').deadButtons.length > 0) },
];

const NAV_HTML = String.raw`<nav class="tabs"><button id="goClass">수업</button><button id="goGrade">성적</button><button id="goSetup">설정</button></nav>`;
const NAV_CSS = String.raw`:scope { display:flex; align-items:center; padding:0 12px; }
.tabs { display:flex; gap:8px; }`;
// H15: 세 화면에 같은 id, document.getElementById 는 첫 화면 버튼만 찾는다
const NAV_JS = String.raw`const go = (id, s) => document.getElementById(id).addEventListener('click', () => app.navigate(s));
go('goClass', 'class'); go('goGrade', 'grade'); go('goSetup', 'setup');`;

export const REGION_CODE = {
  'nav-class': { html: NAV_HTML, css: NAV_CSS, js: NAV_JS },
  'nav-grade': { html: NAV_HTML, css: NAV_CSS, js: NAV_JS },
  'nav-setup': { html: NAV_HTML, css: NAV_CSS, js: NAV_JS },

  seat: {
    html: String.raw`<h2>자리 배치</h2>
<label>한 줄 자리 수 <input id="seatCols" type="number" value="6"></label>
<button id="shuffleSeats">자리 섞기</button>
<div id="seatGrid"></div>
<p id="seatInfo"></p>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
.row { display:flex; gap:4px; margin:4px 0; }
.seat { display:inline-block; min-width:56px; height:32px; border:1px solid #ccc; border-radius:6px; text-align:center; line-height:32px; }
.seat.on { background:#fde68a; }`,
    js: String.raw`const grid = root.querySelector('#seatGrid');
const info = root.querySelector('#seatInfo');
const colsIn = root.querySelector('#seatCols');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function render(names) {
  const cols = Number(colsIn.value);
  const n = Math.max(names.length, 24);
  const rows = new Array(Math.ceil(n / cols)).fill(0); // H4: 0 이면 Infinity
  grid.innerHTML = rows.map((_, y) => '<div class="row">' + Array.from({ length: cols }, (_, x) => '<span class="seat" data-i="' + (y * cols + x) + '">' + esc(names[y * cols + x] || '') + '</span>').join('') + '</div>').join('');
  grid.addEventListener('click', (e) => { const s = e.target.closest('.seat'); if (s) s.classList.toggle('on'); }); // H6: 그릴 때마다 또 붙임
  info.textContent = names.length + '명 배치';
}
root.querySelector('#shuffleSeats').addEventListener('click', () => {
  const names = app.groups.shuffle(app.roster.names());
  app.store.set('data', names); // H9: 메모 영역도 'data'
  render(names);
});
const saved = app.store.get('data', null);
render(saved ? saved.map(String) : []);`,
  },

  'lesson-timer': {
    html: String.raw`<h2>발표 타이머</h2>
<label>발표 시간(분) <input id="talkMin" type="number" min="1" value="3"></label>
<div id="talkClock" class="big">03:00</div>
<button id="talkStart">시작</button> <button id="talkReset">다시</button>`,
    css: String.raw`:scope { padding:12px; }
.big { font-size:40px; font-variant-numeric:tabular-nums; margin:8px 0; }`,
    js: String.raw`let left = 180, iv = null;
const clock = root.querySelector('#talkClock');
const minIn = root.querySelector('#talkMin');
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
minIn.addEventListener('change', () => { left = Number(minIn.value) * 60; clock.textContent = fmt(left); });
root.querySelector('#talkStart').addEventListener('click', () => {
  iv = setInterval(() => { left--; clock.textContent = fmt(left); if (left <= 0) { clearInterval(iv); app.emit('talk:end'); } }, 1000); // H5
});
root.querySelector('#talkReset').addEventListener('click', () => { clearInterval(iv); left = Number(minIn.value) * 60; clock.textContent = fmt(left); });`,
  },

  'qr-share': {
    html: String.raw`<h2>자료 링크 · QR</h2>
<input id="linkUrl" type="url" placeholder="자료 주소">
<button id="makeLinkQr">QR 만들기</button>
<div id="linkQr"></div>
<a id="openLink" target="_blank" hidden>링크 열기</a>`,
    css: String.raw`:scope { padding:12px; }
#linkUrl { width:100%; }`,
    js: String.raw`root.querySelector('#makeLinkQr').addEventListener('click', () => {
  const u = root.querySelector('#linkUrl').value.trim();
  if (!u) return;
  app.qr.render(root.querySelector('#linkQr'), u, { size: 140 });
  const a = root.querySelector('#openLink');
  a.href = u; // H7: javascript: 주소도 그대로
  a.hidden = false;
});`,
  },

  'score-board': {
    html: String.raw`<h2>수행평가 점수</h2>
<p id="sbEmpty">명단이 없습니다. 설정 탭에서 넣으세요.</p>
<table id="sbTable"><thead><tr><th>이름</th><th>점수(100점)</th></tr></thead><tbody></tbody></table>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
table { border-collapse:collapse; width:100%; }
td, th { border:1px solid #ddd; padding:4px; }`,
    js: String.raw`const students = app.roster.get(); // H2: 한 번만 읽음
const tbody = root.querySelector('tbody');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let scores = app.store.get('scores', {});
const startScores = { ...scores };
function draw(src) {
  root.querySelector('#sbEmpty').hidden = students.length > 0;
  tbody.innerHTML = students.map((s) => '<tr><td>' + esc(s.name) + '</td><td><input class="sc" type="number" data-n="' + esc(s.name) + '" value="' + esc(src[s.name] ?? '') + '"></td></tr>').join('');
}
tbody.addEventListener('input', (e) => {
  scores[e.target.dataset.n] = e.target.value === '' ? '' : Number(e.target.value); // H13: 0~100 검사 없음
  app.store.set('scores', scores);
  app.set('scores', scores);
});
app.on('screen:change', (s) => { if (s === 'grade') draw(startScores); }); // H12: 처음 값으로 다시 그림
draw(scores);
app.set('scores', scores);`,
  },

  stats: {
    html: String.raw`<h2>반 통계</h2>
<p id="avgText"></p>
<canvas id="chart" style="width:100%;height:160px;display:block"></canvas>
<button id="saveHist">오늘 평균 기록</button>
<ol id="histList"></ol>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }`,
    js: String.raw`const cv = root.querySelector('#chart');
cv.width = cv.clientWidth; cv.height = cv.clientHeight; // H11: 숨은 탭이면 0
function update(sc) {
  const vals = Object.values(sc || {}).filter((v) => v !== '');
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length; // H3: 0명이면 NaN
  root.querySelector('#avgText').textContent = '평균 ' + avg.toFixed(1) + '점 (' + vals.length + '명)';
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  vals.forEach((v, i) => { g.fillStyle = '#4f46e5'; g.fillRect(i * 22, cv.height - v * 1.5, 18, v * 1.5); });
  return avg;
}
let hist = app.store.get('history', []);
function drawHist() { root.querySelector('#histList').innerHTML = hist.slice(-5).map((h) => '<li>' + h.day + ' ' + h.avg.toFixed(1) + '점</li>').join(''); } // H10
app.on('state:scores', update);
root.querySelector('#saveHist').addEventListener('click', () => {
  const avg = update(app.get('scores'));
  hist.push({ day: '11-28', avg });
  app.store.set('history', hist);
  drawHist();
});
drawHist();`,
  },

  'roster-setup': {
    html: String.raw`<h2>학생 명단</h2>
<textarea id="rosterInput" rows="8" placeholder="이름을 한 줄에 한 명씩"></textarea>
<button id="saveRoster">명단 저장</button>
<div id="rosterChips"></div>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
textarea { width:100%; }
.chip { display:inline-block; padding:2px 8px; margin:2px; border-radius:12px; background:#eef; }`,
    js: String.raw`const chips = root.querySelector('#rosterChips');
const show = (list) => { chips.innerHTML = list.map((s) => '<span class="chip">' + s.name + '</span>').join(''); }; // H1
root.querySelector('#saveRoster').addEventListener('click', () => show(app.roster.fromText(root.querySelector('#rosterInput').value)));
show(app.roster.get());`,
  },

  sync: {
    html: String.raw`<h2>구글 시트 동기화</h2>
<button id="pullSheet">시트에서 명단 받기</button>
<button id="pushSheet">점수 보내기</button>
<p id="syncMsg"></p>`,
    css: String.raw`:scope { padding:12px; }`,
    js: String.raw`const KEY = 'AIzaSyB7x1Qe8sK2vLmN4pQrStUvWxYz0123456'; // H8
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const msg = root.querySelector('#syncMsg');
root.querySelector('#pullSheet').addEventListener('click', async () => {
  try {
    const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET + '/values/A:A?key=' + KEY);
    const j = await r.json();
    app.roster.set((j.values || []).map(([name]) => ({ name })));
    msg.textContent = '받았습니다';
  } catch (e) { msg.textContent = '받지 못했습니다: ' + e.message; }
});
root.querySelector('#pushSheet').addEventListener('click', async () => {
  msg.textContent = '보내는 중…';
  await app.sheets.append(Object.entries(app.get('scores') || {}).map(([name, score]) => ({ name, score }))).catch(() => {}); // H14
  msg.textContent = '보냈습니다';
});`,
  },

  memo: {
    html: String.raw`<h2>수업 메모</h2>
<textarea id="memoText" rows="6" placeholder="오늘 수업 메모"></textarea>
<p id="memoSaved"></p>`,
    css: String.raw`:scope { padding:12px; }
textarea { width:100%; }`,
    js: String.raw`const t = root.querySelector('#memoText');
t.value = app.store.get('data', ''); // H9: 자리 영역과 같은 키
t.addEventListener('input', () => { app.store.set('data', t.value); root.querySelector('#memoSaved').textContent = '저장됨'; });`,
  },
};

export const LAYOUT = {
  name: '우리반 운영판',
  activeScreen: 'class',
  regions: [],
  screens: [
    { id: 'class', title: '수업', grid: { cols: 12, rows: 12, gap: 8, fill: true }, regions: [
      { id: 'nav-class', title: '탭(수업)', x: 0, y: 0, w: 12, h: 1 },
      { id: 'seat', title: '자리 배치', x: 0, y: 1, w: 7, h: 11 },
      { id: 'lesson-timer', title: '발표 타이머', x: 7, y: 1, w: 5, h: 5 },
      { id: 'qr-share', title: '링크 QR', x: 7, y: 6, w: 5, h: 6 },
    ] },
    { id: 'grade', title: '성적', grid: { cols: 12, rows: 12, gap: 8, fill: true }, regions: [
      { id: 'nav-grade', title: '탭(성적)', x: 0, y: 0, w: 12, h: 1 },
      { id: 'score-board', title: '점수 입력', x: 0, y: 1, w: 7, h: 11 },
      { id: 'stats', title: '통계', x: 7, y: 1, w: 5, h: 11 },
    ] },
    { id: 'setup', title: '설정', grid: { cols: 12, rows: 12, gap: 8, fill: true }, regions: [
      { id: 'nav-setup', title: '탭(설정)', x: 0, y: 0, w: 12, h: 1 },
      { id: 'roster-setup', title: '명단', x: 0, y: 1, w: 4, h: 11 },
      { id: 'sync', title: '시트 동기화', x: 4, y: 1, w: 4, h: 11 },
      { id: 'memo', title: '메모', x: 8, y: 1, w: 4, h: 11 },
    ] },
  ],
};

export const SKILLS = ['print', 'backup', 'roster', 'groups', 'sheets', 'qr'];

// AI 가 만든 시나리오 테스트 (좋은 것·틀린 것 섞임)
export const AI_TESTS = [
  { name: '명단 저장 → 이름 표시', steps: [
    { action: 'navigate', selector: '', value: 'setup' },
    { action: 'type', selector: '#rosterInput', value: '김민수\n이지영\n박하준' },
    { action: 'click', selector: '#saveRoster', value: '' },
    { action: 'expectCount', selector: '#rosterChips .chip', value: '3' },
  ] },
  { name: '성적 탭에서 점수 입력', steps: [
    { action: 'navigate', selector: '', value: 'grade' },
    { action: 'type', selector: '#sbTable tbody input', value: '90' },
    { action: 'expectText', selector: '#avgText', value: '90.0' },
  ] },
  { name: '링크 QR 만들기', steps: [
    { action: 'type', selector: '#linkUrl', value: 'https://example.com' },
    { action: 'click', selector: '#makeLinkQr', value: '' },
    { action: 'expectVisible', selector: '#openLink', value: '' },
  ] },
  // 환각: 앱에 없는 버튼
  { name: 'PDF 내보내기', steps: [
    { action: 'click', selector: '#exportPdf', value: '' },
    { action: 'expectText', selector: '#syncMsg', value: '완료' },
  ] },
];

// 같은 앱에서 심은 버그를 고친 판. 점검이 멀쩡한 코드를 오류로 몰지 않는지(오탐) 볼 때 쓴다.
// H13(점수 범위)·H14(오류 숨김)도 고쳐 두었다.
const CLEAN_NAV = {
  html: String.raw`<nav class="tabs"><button data-go="class">수업</button><button data-go="grade">성적</button><button data-go="setup">설정</button></nav>`,
  css: NAV_CSS,
  js: String.raw`const tabs = [...root.querySelectorAll('[data-go]')];
tabs.forEach((b) => b.addEventListener('click', () => app.navigate(b.dataset.go)));
const mark = (s) => tabs.forEach((b) => b.classList.toggle('on', b.dataset.go === s));
app.on('screen:change', mark);
mark(app.getScreen());`,
};
// 고친 판의 공통 모양 (global.css): 영역을 카드로 나누고, 지금 탭을 표시하고, 버튼·입력칸을 키운다
export const CLEAN_GLOBAL_CSS = String.raw`body { background:#f3f4f8; color:#1f2937; }
section[data-region] { background:#fff; border:1px solid #e5e7eb; border-radius:12px; box-shadow:0 1px 2px rgba(0,0,0,.05); }
section[data-region^="nav-"] { background:transparent; border:0; box-shadow:none; }
h2 { font-size:18px; margin:0 0 12px; }
button { font:inherit; font-size:14px; padding:6px 14px; border-radius:8px; border:1px solid #c7cbe0; background:#fff; color:inherit; cursor:pointer; }
button:hover { background:#eef0ff; }
input, textarea { font:inherit; font-size:14px; padding:6px 8px; border:1px solid #cbd0dc; border-radius:8px; box-sizing:border-box; }
.tabs button { font-weight:600; }
.tabs button.on { background:#4f46e5; color:#fff; border-color:#4f46e5; }
#seatCols, #talkMin { width:72px; }
#seatGrid { margin-top:12px; }
#saveHist { margin-top:12px; }
#rosterChips { margin-top:8px; }
#syncMsg, #linkMsg { color:#4b5563; }`;
export const CLEAN_CODE = {
  'nav-class': CLEAN_NAV,
  'nav-grade': CLEAN_NAV,
  'nav-setup': CLEAN_NAV,
  seat: {
    html: REGION_CODE.seat.html,
    css: REGION_CODE.seat.css,
    js: String.raw`const grid = root.querySelector('#seatGrid');
const info = root.querySelector('#seatInfo');
const colsIn = root.querySelector('#seatCols');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function render(names) {
  const cols = Math.min(12, Math.max(1, Math.round(Number(colsIn.value)) || 6));
  const n = Math.max(names.length, 24);
  const rows = new Array(Math.ceil(n / cols)).fill(0);
  grid.innerHTML = rows.map((_, y) => '<div class="row">' + Array.from({ length: cols }, (_, x) => '<span class="seat">' + esc(names[y * cols + x] || '') + '</span>').join('') + '</div>').join('');
  info.textContent = names.length + '명 배치';
}
grid.addEventListener('click', (e) => { const s = e.target.closest('.seat'); if (s) s.classList.toggle('on'); });
root.querySelector('#shuffleSeats').addEventListener('click', () => {
  const names = app.groups.shuffle(app.roster.names());
  app.store.set('seat:names', names);
  render(names);
});
const saved = app.store.get('seat:names', []);
render(Array.isArray(saved) ? saved.map(String) : []);`,
  },
  'lesson-timer': {
    html: REGION_CODE['lesson-timer'].html,
    css: REGION_CODE['lesson-timer'].css,
    js: String.raw`let left = 180, iv = null;
const clock = root.querySelector('#talkClock');
const minIn = root.querySelector('#talkMin');
const minutes = () => Math.max(1, Math.round(Number(minIn.value)) || 3);
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const stop = () => { clearInterval(iv); iv = null; };
minIn.addEventListener('change', () => { stop(); left = minutes() * 60; clock.textContent = fmt(left); });
root.querySelector('#talkStart').addEventListener('click', () => {
  if (iv) return;
  iv = setInterval(() => { left = Math.max(0, left - 1); clock.textContent = fmt(left); if (left === 0) { stop(); app.emit('talk:end'); } }, 1000);
});
root.querySelector('#talkReset').addEventListener('click', () => { stop(); left = minutes() * 60; clock.textContent = fmt(left); });`,
  },
  'qr-share': {
    html: REGION_CODE['qr-share'].html + '\n<p id="linkMsg"></p>',
    css: REGION_CODE['qr-share'].css,
    js: String.raw`root.querySelector('#makeLinkQr').addEventListener('click', () => {
  const u = root.querySelector('#linkUrl').value.trim();
  const msg = root.querySelector('#linkMsg');
  if (!/^https?:\/\//i.test(u)) { msg.textContent = 'http:// 또는 https:// 로 시작하는 주소를 넣으세요'; return; }
  msg.textContent = '';
  app.qr.render(root.querySelector('#linkQr'), u, { size: 140 });
  const a = root.querySelector('#openLink');
  a.href = u;
  a.hidden = false;
});`,
  },
  'score-board': {
    html: REGION_CODE['score-board'].html,
    css: REGION_CODE['score-board'].css,
    js: String.raw`let students = app.roster.get();
const tbody = root.querySelector('tbody');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let scores = app.store.get('scores', {});
if (!scores || typeof scores !== 'object' || Array.isArray(scores)) scores = {};
function draw() {
  root.querySelector('#sbEmpty').hidden = students.length > 0;
  tbody.innerHTML = students.map((s) => '<tr><td>' + esc(s.name) + '</td><td><input class="sc" type="number" min="0" max="100" data-n="' + esc(s.name) + '" value="' + esc(scores[s.name] ?? '') + '"></td></tr>').join('');
}
tbody.addEventListener('input', (e) => {
  const v = e.target.value === '' ? '' : Math.min(100, Math.max(0, Number(e.target.value)));
  scores[e.target.dataset.n] = v;
  app.store.set('scores', scores);
  app.set('scores', scores);
});
app.on('state:roster', (r) => { students = r || []; draw(); });
app.on('screen:change', (s) => { if (s === 'grade') draw(); });
draw();
app.set('scores', scores);`,
  },
  stats: {
    html: REGION_CODE.stats.html,
    css: REGION_CODE.stats.css,
    js: String.raw`const cv = root.querySelector('#chart');
let last = {};
function size() { if (cv.clientWidth) { cv.width = cv.clientWidth; cv.height = cv.clientHeight; } }
function update(sc) {
  last = sc || {};
  const vals = Object.values(last).filter((v) => typeof v === 'number');
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  root.querySelector('#avgText').textContent = avg == null ? '아직 점수가 없습니다' : '평균 ' + avg.toFixed(1) + '점 (' + vals.length + '명)';
  if (!cv.width) return avg;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  vals.forEach((v, i) => { g.fillStyle = '#4f46e5'; g.fillRect(i * 22, cv.height - v * 1.5, 18, v * 1.5); });
  return avg;
}
let hist = app.store.get('history', []);
if (!Array.isArray(hist)) hist = [];
function drawHist() { root.querySelector('#histList').innerHTML = hist.filter((h) => h && typeof h.avg === 'number').slice(-5).map((h) => '<li>' + h.day + ' ' + h.avg.toFixed(1) + '점</li>').join(''); }
app.on('state:scores', update);
app.on('screen:change', (s) => { if (s === 'grade') { size(); update(last); } });
size();
root.querySelector('#saveHist').addEventListener('click', () => {
  const avg = update(app.get('scores'));
  if (avg == null) { root.querySelector('#avgText').textContent = '점수를 먼저 넣으세요'; return; }
  hist.push({ day: '11-28', avg });
  app.store.set('history', hist);
  drawHist();
});
drawHist();`,
  },
  'roster-setup': {
    html: REGION_CODE['roster-setup'].html,
    css: REGION_CODE['roster-setup'].css,
    js: String.raw`const chips = root.querySelector('#rosterChips');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const show = (list) => { chips.innerHTML = list.map((s) => '<span class="chip">' + esc(s.name) + '</span>').join(''); };
root.querySelector('#saveRoster').addEventListener('click', () => app.roster.fromText(root.querySelector('#rosterInput').value));
app.on('state:roster', (r) => show(r || []));`,
  },
  sync: {
    html: REGION_CODE.sync.html,
    css: REGION_CODE.sync.css,
    js: String.raw`const msg = root.querySelector('#syncMsg');
root.querySelector('#pullSheet').addEventListener('click', async () => {
  try {
    const t = await app.sheets.read();
    app.roster.set(t.rows.map((r) => ({ name: String(r[0] || '').trim() })).filter((s) => s.name));
    msg.textContent = '받았습니다';
  } catch (e) { msg.textContent = '받지 못했습니다: ' + e.message; }
});
const pushBtn = root.querySelector('#pushSheet');
pushBtn.addEventListener('click', async () => {
  pushBtn.disabled = true;
  msg.textContent = '보내는 중…';
  try {
    await app.sheets.append(Object.entries(app.get('scores') || {}).map(([name, score]) => ({ name, score })));
    msg.textContent = '보냈습니다';
  } catch (e) { msg.textContent = '보내지 못했습니다: ' + e.message; }
  finally { pushBtn.disabled = false; }
});`,
  },
  memo: {
    html: REGION_CODE.memo.html,
    css: REGION_CODE.memo.css,
    js: String.raw`const t = root.querySelector('#memoText');
const v = app.store.get('memo:text', '');
t.value = typeof v === 'string' ? v : '';
t.addEventListener('input', () => { app.store.set('memo:text', t.value); root.querySelector('#memoSaved').textContent = '저장됨'; });`,
  },
};
