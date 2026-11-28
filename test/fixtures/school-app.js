// 시뮬레이션용 가상 학교 앱 "우리반 수행평가 도우미" — AI 가 자주 내는 실수를 일부러 심은 영역 코드.
// 점검 도구가 무엇을 잡고 놓치는지 확인할 때 씀 (test/sim-school-app.test.js). 심은 버그 목록은 BUGS.
export const BUGS = [
  { id: 'B1', region: 'scores', kind: 'reload', desc: '점수를 store "scores" 에 저장하고 "score" 에서 읽음 → 새로고침하면 점수칸이 비어 보임 (명단은 그대로 복원)' },
  { id: 'B2', region: 'scores', kind: 'logic', desc: '합계를 문자열로 더함 → 80 + 90 = "8090"' },
  { id: 'B3', region: 'scores', kind: 'empty-state', desc: '명단이 비었을 때 석차 계산 → null.toFixed TypeError' },
  { id: 'B4', region: 'scores', kind: 'dead', desc: 'CSV 내보내기 버튼에 처리기가 없음' },
  { id: 'B5', region: 'groups', kind: 'connection', desc: '"roster:update" 를 듣지만 명단 영역은 "roster:updated" 를 보냄 → 인원 수가 늘 0명' },
  { id: 'B6', region: 'groups', kind: 'second-click', desc: '모둠 만들기 두 번째 클릭에서 customElements.define 중복 오류' },
  { id: 'B7', region: 'groups', kind: 'reload-result', desc: '모둠 결과를 저장만 하고 다시 그리지 않음 → 새로고침하면 사라짐' },
  { id: 'B8', region: 'share', kind: 'async', desc: '시트 주소가 없을 때 app.sheets.append 실패를 try/catch 안 함 (async 처리기)' },
  { id: 'B9', region: 'roster/scores', kind: 'dup-id', desc: '두 영역이 같은 id="emptyMsg" 사용, roster 는 document.getElementById 로 찾음 → 엉뚱한 영역 문구를 숨김' },
  { id: 'B10', region: 'roster', kind: 'xss', desc: '학생 이름을 innerHTML 로 그대로 넣음 (<b> 같은 글자가 태그가 됨)' },
];

export const REGION_CODE = {
  header: {
    html: String.raw`<header class="hd">
  <h1 id="appTitle">우리반 수행평가 도우미</h1>
  <label class="cls">학급 <input id="className" placeholder="예: 2학년 3반"></label>
  <div id="hdTimer"></div>
</header>`,
    css: String.raw`:scope { display:flex; align-items:center; }
.hd { display:flex; gap:16px; align-items:center; width:100%; padding:0 12px; }
#appTitle { font-size:20px; margin:0; color: var(--primary, #4f46e5); }
#hdTimer { margin-left:auto; }`,
    js: String.raw`const cls = root.querySelector('#className');
cls.value = app.store.get('className', '');
cls.addEventListener('input', () => app.store.set('className', cls.value));
app.timer.mount(root.querySelector('#hdTimer'), { seconds: 300 });`,
  },
  roster: {
    html: String.raw`<h2>학생 명단</h2>
<textarea id="rosterText" rows="6" placeholder="이름을 한 줄에 한 명씩 붙여넣기"></textarea>
<div class="btns"><button id="applyRoster">명단 반영</button> <button id="uploadRoster">파일에서 불러오기</button></div>
<p id="emptyMsg">아직 명단이 없습니다</p>
<ol id="rosterList"></ol>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
textarea { width:100%; }`,
    js: String.raw`const list = root.querySelector('#rosterList');
function render(r) {
  r = r || [];
  document.getElementById('emptyMsg').hidden = r.length > 0; // B9: 다른 영역의 같은 id 를 잡을 수 있음
  list.innerHTML = r.map((s) => '<li>' + s.name + '</li>').join(''); // B10
  app.emit('roster:updated', r);
}
root.querySelector('#applyRoster').addEventListener('click', () => {
  const r = app.roster.fromText(root.querySelector('#rosterText').value);
  render(r);
});
root.querySelector('#uploadRoster').addEventListener('click', async () => {
  const r = await app.roster.upload();
  if (r) render(r);
});
render(app.roster.get());`,
  },
  scores: {
    html: String.raw`<h2>수행평가 점수</h2>
<p id="emptyMsg">명단을 먼저 넣으세요</p>
<table id="scoreTable">
  <thead><tr><th>이름</th><th>발표</th><th>보고서</th><th>합계</th><th>석차</th></tr></thead>
  <tbody></tbody>
</table>
<div class="btns"><button id="rankBtn">석차 계산</button> <button id="exportBtn">CSV 내보내기</button></div>
<p id="avgLine"></p>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
table { border-collapse:collapse; width:100%; }
td, th { border:1px solid #ddd; padding:4px; }
input.sc { width:64px; }`,
    js: String.raw`const tbody = root.querySelector('tbody');
const empty = root.querySelector('#emptyMsg');
let scores = app.store.get('score', {}); // B1: 저장은 'scores'
let students = [];
function draw() {
  empty.hidden = students.length > 0;
  tbody.innerHTML = students.map((s) => {
    const v = scores[s.name] || {};
    return '<tr data-name="' + s.name + '"><td>' + s.name + '</td>' +
      '<td><input type="number" class="sc" data-k="발표" value="' + (v.발표 ?? '') + '"></td>' +
      '<td><input type="number" class="sc" data-k="보고서" value="' + (v.보고서 ?? '') + '"></td>' +
      '<td class="total"></td><td class="rank"></td></tr>';
  }).join('');
}
tbody.addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  const n = tr.dataset.name;
  scores[n] = { ...scores[n], [e.target.dataset.k]: e.target.value };
  app.store.set('scores', scores);
  tr.querySelector('.total').textContent = (scores[n].발표 || 0) + (scores[n].보고서 || 0); // B2
});
root.querySelector('#rankBtn').addEventListener('click', () => {
  const rows = students.map((s) => ({ name: s.name, 발표: Number(scores[s.name]?.발표), 보고서: Number(scores[s.name]?.보고서) }));
  const r = app.grades.compute(rows, { items: ['발표', '보고서'] });
  r.rows.forEach((x) => {
    const tr = tbody.querySelector('tr[data-name="' + x.name + '"]');
    if (tr) tr.querySelector('.rank').textContent = x.rank + '등';
  });
  root.querySelector('#avgLine').textContent = '발표 평균 ' + r.summary.발표.mean.toFixed(1) + '점'; // B3
});
// B4: exportBtn 처리기 없음
app.on('state:roster', (r) => { students = r || []; draw(); });
students = app.roster.get() || [];
draw();`,
  },
  groups: {
    html: String.raw`<h2>모둠 편성</h2>
<p id="rosterCount">명단 0명</p>
<label>모둠 수 <input id="groupCount" type="number" min="2" value="4"></label>
<button id="makeGroups">모둠 만들기</button>
<div id="groupOut"></div>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
group-card { display:block; border:1px solid #ccc; border-radius:8px; padding:4px 8px; margin:4px 0; }`,
    js: String.raw`const out = root.querySelector('#groupOut');
app.on('roster:update', (r) => { root.querySelector('#rosterCount').textContent = '명단 ' + r.length + '명'; }); // B5
root.querySelector('#makeGroups').addEventListener('click', () => {
  const g = app.groups.make(null, { count: Number(root.querySelector('#groupCount').value) });
  customElements.define('group-card', class extends HTMLElement {}); // B6: 두 번째 클릭에서 오류
  out.innerHTML = g.names.map((n, i) => '<group-card><b>' + (i + 1) + '모둠</b> ' + n.join(', ') + '</group-card>').join('');
  app.store.set('groups', g.names); // B7: 저장만 하고 시작 때 다시 그리지 않음
});`,
  },
  share: {
    html: String.raw`<h2>설문 QR · 구글 시트</h2>
<input id="surveyUrl" type="url" placeholder="설문 주소 (https://...)">
<button id="makeQr">QR 만들기</button>
<div id="qrBox"></div>
<button id="sendSheet">점수를 구글 시트로 보내기</button>
<p id="sheetMsg"></p>`,
    css: String.raw`:scope { padding:12px; overflow:auto; }
#surveyUrl { width:100%; }`,
    js: String.raw`const url = root.querySelector('#surveyUrl');
const msg = root.querySelector('#sheetMsg');
root.querySelector('#makeQr').addEventListener('click', () => {
  app.qr.render(root.querySelector('#qrBox'), url.value, { size: 160, caption: true });
});
root.querySelector('#sendSheet').addEventListener('click', async () => {
  const rows = Object.entries(app.store.get('scores', {})).map(([name, v]) => ({ name, ...v }));
  await app.sheets.append(rows); // B8: 실패하면 화면에 아무 말도 없음
  msg.textContent = rows.length + '명 보냈습니다';
});`,
  },
};

// AI 가 만든 시나리오 테스트 (실제 AI 처럼 좋은 것·틀린 것이 섞임)
export const AI_TESTS = [
  { name: '명단 붙여넣기 → 목록 표시', steps: [
    { action: 'type', selector: '#rosterText', value: '김민수\n이지영\n박하준' },
    { action: 'click', selector: '#applyRoster', value: '' },
    { action: 'expectCount', selector: '#rosterList li', value: '3' },
  ] },
  { name: '점수 입력 → 합계 계산', steps: [
    { action: 'type', selector: '#scoreTable tbody tr:first-child input[data-k="발표"]', value: '80' },
    { action: 'type', selector: '#scoreTable tbody tr:first-child input[data-k="보고서"]', value: '90' },
    { action: 'expectText', selector: '#scoreTable tbody tr:first-child .total', value: '170' },
  ] },
  { name: '석차 계산', steps: [
    { action: 'click', selector: '#rankBtn', value: '' },
    { action: 'expectText', selector: '#scoreTable tbody tr:first-child .rank', value: '등' },
  ] },
  { name: '빈 명단에서 석차 계산 (예외 흐름)', steps: [
    { action: 'click', selector: '#rankBtn', value: '' },
    { action: 'expectVisible', selector: '#scoreTable', value: '' },
  ] },
  { name: '모둠 만들기', steps: [
    { action: 'type', selector: '#groupCount', value: '2' },
    { action: 'click', selector: '#makeGroups', value: '' },
    { action: 'expectCount', selector: '#groupOut group-card', value: '2' },
  ] },
  // 환각: 앱에 없는 저장 버튼
  { name: '점수 저장 버튼', steps: [
    { action: 'click', selector: '#saveScores', value: '' },
    { action: 'expectText', selector: '#avgLine', value: '저장' },
  ] },
];
