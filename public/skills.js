// 스킬: 만든 웹앱에 끼워 넣는 재사용 기능 묶음.
// 켜 둔 스킬은 빌드할 때 앱 런타임(window.app)에 붙고, 영역을 만드는 AI 에게 사용법이 함께 전달된다.
// 저장 위치: projects/<이름>/skills.json  { enabled: ['print', ...], options: { backupButton: true, sheetsUrl, sheetsScript } }
import { GRADES_RUNTIME, GROUPS_RUNTIME, GROUPS_CSS, TIMER_RUNTIME, TIMER_CSS, SHEETS_RUNTIME, SHEETS_CSS, SHEETS_SCRIPT, QR_RUNTIME, QR_CSS } from './skills-more.js';

export { SHEETS_SCRIPT };

export const SKILLS = [
  {
    id: 'print',
    icon: '🖨',
    title: '인쇄 스타일 자동',
    desc: '인쇄(Ctrl+P)할 때 버튼·입력 도구를 숨기고, 화면 높이 고정을 풀어 내용이 잘리지 않게 A4 에 맞춰 찍습니다. app.print() 로 원하는 영역만 인쇄할 수 있습니다.',
    keywords: ['인쇄', '출력', '프린트', 'print', 'a4', '종이'],
    default: true,
  },
  {
    id: 'backup',
    icon: '💾',
    title: '데이터 저장·백업',
    desc: '앱 데이터를 브라우저에 자동 저장(app.store, app.persist)하고, 💾 버튼으로 백업 파일(.json)을 내려받거나 다시 불러옵니다. 다른 PC 로 옮길 때 씁니다.',
    keywords: ['저장', '백업', '기록', '누적', '불러오기', '새로고침', '유지', 'localstorage'],
    default: false,
  },
  {
    id: 'roster',
    icon: '👥',
    title: '명단 업로드',
    desc: '엑셀(.xlsx)·CSV·붙여넣은 표에서 이름·번호·학번·반 열을 찾아 학생 명단으로 바꿉니다. 한글 CSV(EUC-KR)도 읽습니다.',
    keywords: ['명단', '학생', '이름', '출석', '번호', '학번', '엑셀', 'csv', '반'],
    default: false,
  },
  {
    id: 'formScan',
    icon: '📋',
    title: '양식 분석하기',
    desc: '학교 양식 엑셀·CSV 를 읽어 제목, 머리글 행, 열 이름과 종류(숫자·날짜·이름·글), 채울 빈 줄 수를 알아내고, 앱 데이터를 같은 열 순서로 채워 CSV 로 내보냅니다.',
    keywords: ['양식', '서식', '템플릿', '제출', '보고', '나이스', '엑셀', '표'],
    default: false,
  },
  {
    id: 'grades',
    icon: '📊',
    title: '성적 합계·순위',
    desc: '과목·영역 점수로 합계·평균·반영비율 환산 점수를 내고, 동점을 같은 등수로 매긴 석차·백분위·등급(9등급 또는 A~E)을 붙입니다. 과목별 평균·최고·최저·표준편차도 줍니다.',
    keywords: ['성적', '점수', '채점', '석차', '순위', '등수', '등급', '평균', '합계', '수행평가', '반영비율', '환산'],
    default: false,
  },
  {
    id: 'groups',
    icon: '🎲',
    title: '모둠·자리 배치',
    desc: '명단을 무작위 모둠(모둠 수 또는 인원수)으로 나누고, 성별 고르게·함께·떨어뜨리기 조건을 지킵니다. 교실 자리표(앞자리 우선, 고정석, 빈 칸)도 만들어 표로 그립니다.',
    keywords: ['모둠', '조 편성', '조편성', '자리', '좌석', '짝꿍', '짝 바꾸', '팀 나누', '팀 편성', '랜덤', '무작위', '뽑기'],
    default: false,
  },
  {
    id: 'timer',
    icon: '⏱',
    title: '타이머·카운트다운',
    desc: '수업·발표·시험용 카운트다운과 초시계입니다. 큰 숫자 화면, 시작·멈춤·처음으로, 1·3·5·10분 버튼, 끝날 때 소리·깜빡임이 들어 있습니다. 탭을 오래 비워도 시간이 밀리지 않습니다.',
    keywords: ['타이머', '카운트다운', '초시계', '스톱워치', '제한 시간', '제한시간', '남은 시간', '발표 시간', '시간 재'],
    default: false,
  },
  {
    id: 'sheets',
    icon: '🟩',
    title: '구글 시트 연동',
    desc: '공유한 구글 시트를 표로 불러오고, 시트에 붙인 Apps Script 웹 앱으로 결과를 한 줄씩 저장합니다. 인터넷이 끊기면 모아 두었다가 다시 연결될 때 보냅니다.',
    keywords: ['구글 시트', '구글시트', '스프레드시트', 'google sheet', '공유 시트', '시트에 저장', '시트에서 불러', '설문 결과', '구글 폼'],
    default: false,
  },
  {
    id: 'qr',
    icon: '🔳',
    title: 'QR 코드 만들기',
    desc: '주소나 글을 QR 코드(SVG·PNG)로 바로 그립니다. 인터넷 없이 앱 안에서 만들고, 한글 주소도 됩니다. 수업 자료 링크, 설문 주소, 자리 안내에 씁니다.',
    keywords: ['qr', '큐알', 'qr코드', '링크 공유', '접속 주소', '바코드'],
    default: false,
  },
];

export const SKILL_IDS = SKILLS.map((s) => s.id);
export const DEFAULT_SKILLS = { enabled: SKILLS.filter((s) => s.default).map((s) => s.id), options: { backupButton: true } };

// 구글 시트 주소는 구글 주소만 받는다 (다른 곳으로 데이터를 보내는 앱이 되지 않게)
const SHEET_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/[\w\-./?=&#%]*$/;
const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
export function normalizeSkills(raw) {
  const enabled = Array.isArray(raw?.enabled) ? raw.enabled.filter((id) => SKILL_IDS.includes(id)) : DEFAULT_SKILLS.enabled;
  const options = { ...DEFAULT_SKILLS.options, ...(raw?.options && typeof raw.options === 'object' ? raw.options : {}) };
  const out = { backupButton: options.backupButton !== false };
  const url = (v, re) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : '');
  if (url(options.sheetsUrl, SHEET_URL_RE)) out.sheetsUrl = url(options.sheetsUrl, SHEET_URL_RE);
  if (url(options.sheetsScript, SCRIPT_URL_RE)) out.sheetsScript = url(options.sheetsScript, SCRIPT_URL_RE);
  return { enabled: [...new Set(enabled)], options: out };
}
export function validSheetsOption(key, value) {
  if (!value) return true;
  return (key === 'sheetsUrl' ? SHEET_URL_RE : SCRIPT_URL_RE).test(String(value).trim());
}

// 요구사항 글에 나온 낱말로 켜면 좋을 스킬을 고른다
export function recommendSkills(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return [];
  return SKILLS.filter((k) => k.keywords.some((w) => s.includes(w))).map((k) => k.id);
}

// ── 앱 런타임에 붙는 코드 (브라우저에서 실행, 외부 라이브러리 없음) ──

// 파일 읽기 공용: 파일 고르기, CSV/TSV(UTF-8·EUC-KR), 엑셀 xlsx(압축 해제 + XML), 내려받기
const FILES_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  if (A.files) return;
  const pick = (accept = '') => new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.style.display = 'none';
    i.addEventListener('change', () => { resolve(i.files[0] || null); i.remove(); });
    document.body.appendChild(i);
    i.click();
  });
  const decode = (buf) => {
    const u = new Uint8Array(buf);
    const start = u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf ? 3 : 0;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u.subarray(start)); }
    catch { return new TextDecoder('euc-kr').decode(u); }
  };
  const parseDelimited = (text) => {
    text = String(text || '').replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((v) => v.trim()));
  };
  const unzip = (buf) => {
    const v = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('엑셀(xlsx) 파일을 읽지 못했습니다. 엑셀에서 "다른 이름으로 저장 → CSV" 로 저장해 다시 올려 보세요.');
    const n = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const td = new TextDecoder();
    const entries = {};
    for (let k = 0; k < n; k++) {
      const method = v.getUint16(p + 10, true);
      const size = v.getUint32(p + 20, true);
      const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
      const off = v.getUint32(p + 42, true);
      const name = td.decode(new Uint8Array(buf, p + 46, nl));
      const lnl = v.getUint16(off + 26, true), lel = v.getUint16(off + 28, true);
      entries[name] = { method, data: new Uint8Array(buf, off + 30 + lnl + lel, size) };
      p += 46 + nl + el + cl;
    }
    return async (name) => {
      const e = entries[name];
      if (!e) return null;
      if (e.method === 0) return td.decode(e.data);
      const stream = new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    };
  };
  const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (node, tag) => [...node.getElementsByTagName(tag)];
  const readXlsx = async (buf) => {
    const read = unzip(buf);
    const wb = xml(await read('xl/workbook.xml') || '<x/>');
    const rels = xml(await read('xl/_rels/workbook.xml.rels') || '<x/>');
    const relMap = {};
    byTag(rels, 'Relationship').forEach((r) => { relMap[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const ssXml = await read('xl/sharedStrings.xml');
    const shared = ssXml ? byTag(xml(ssXml), 'si').map((si) => byTag(si, 't').map((t) => t.textContent).join('')) : [];
    const sheets = [];
    for (const s of byTag(wb, 'sheet')) {
      const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let target = relMap[rid] || '';
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const sx = await read(target);
      if (!sx) continue;
      const doc = xml(sx);
      const rows = [];
      for (const r of byTag(doc, 'row')) {
        const ri = Number(r.getAttribute('r') || rows.length + 1) - 1;
        const row = rows[ri] = rows[ri] || [];
        for (const c of byTag(r, 'c')) {
          const ci = colIndex(c.getAttribute('r') || 'A');
          const t = c.getAttribute('t');
          const vEl = byTag(c, 'v')[0];
          let val = vEl ? vEl.textContent : '';
          if (t === 's') val = shared[Number(val)] ?? '';
          else if (t === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent).join('');
          else if (t === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
          row[ci] = String(val).trim();
        }
      }
      const width = Math.max(0, ...rows.filter(Boolean).map((r) => r.length));
      const dense = Array.from({ length: rows.length }, (_, i) => Array.from({ length: width }, (_, j) => (rows[i] && rows[i][j]) || ''));
      const merges = byTag(doc, 'mergeCell').map((m) => m.getAttribute('ref'));
      sheets.push({ name: s.getAttribute('name') || 'Sheet' + (sheets.length + 1), rows: dense, merges });
    }
    return { sheets };
  };
  A.files = {
    pick,
    parseText(text) { return { sheets: [{ name: 'Sheet1', rows: parseDelimited(text), merges: [] }] }; },
    async readTable(file) {
      if (!file) throw new Error('파일이 없습니다');
      const buf = await file.arrayBuffer();
      const u = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (u[0] === 0x50 && u[1] === 0x4b) return readXlsx(buf); // PK.. = 압축(xlsx)
      if (/\.xls$/i.test(file.name || '')) throw new Error('옛 엑셀(.xls)은 읽지 못합니다. 엑셀에서 .xlsx 또는 CSV 로 저장해 주세요.');
      return this.parseText(decode(buf));
    },
    download(name, content, mime = 'text/plain;charset=utf-8') {
      const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
    toCsv(rows) {
      const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'); // BOM: 엑셀에서 한글이 깨지지 않게
    },
  };
})();`;

const ROSTER_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  const HEAD = {
    name: /^(이름|성명|학생\s*이름|학생명|성\s*명|name)$/i,
    number: /^(번호|번|출석\s*번호|no\.?|num(ber)?)$/i,
    studentId: /^(학번|학생\s*번호|id)$/i,
    grade: /^(학년|grade)$/i,
    class: /^(반|학급|class)$/i,
    gender: /^(성별|gender)$/i,
  };
  const isNum = (s) => /^\d+$/.test(String(s || '').trim());
  const fromRows = (rows) => {
    rows = (rows || []).filter((r) => r && r.some((c) => String(c || '').trim()));
    if (!rows.length) return [];
    let hi = -1, map = {};
    for (let i = 0; i < Math.min(rows.length, 8) && hi < 0; i++) {
      const m = {};
      rows[i].forEach((c, j) => { for (const [k, re] of Object.entries(HEAD)) if (m[k] == null && re.test(String(c || '').trim())) m[k] = j; });
      if (m.name != null) { hi = i; map = m; }
    }
    const header = hi >= 0 ? rows[hi] : null;
    const body = hi >= 0 ? rows.slice(hi + 1) : rows;
    if (hi < 0) {
      // 머리글이 없으면: 글자가 든 첫 열을 이름, 그 앞의 숫자 열을 번호로 본다
      const sample = body[0];
      const nameCol = sample.findIndex((c) => String(c || '').trim() && !isNum(c));
      map.name = nameCol < 0 ? 0 : nameCol;
      if (nameCol > 0 && isNum(sample[nameCol - 1])) map.number = nameCol - 1;
    }
    const list = [];
    for (const r of body) {
      const name = String(r[map.name] || '').trim();
      if (!name || HEAD.name.test(name)) continue;
      const item = { name };
      for (const k of ['number', 'studentId', 'grade', 'class', 'gender']) if (map[k] != null && String(r[map[k]] || '').trim()) item[k] = String(r[map[k]]).trim();
      if (header) header.forEach((h, j) => { const key = String(h || '').trim(); if (key && !Object.values(map).includes(j) && String(r[j] || '').trim()) (item.extra ||= {})[key] = String(r[j]).trim(); });
      if (item.number == null && !header) item.number = String(list.length + 1);
      list.push(item);
    }
    return list;
  };
  const save = (list) => {
    A.set('roster', list);
    if (A.store) A.store.set('roster', list);
    A.emit('roster:loaded', list);
    return list;
  };
  A.roster = {
    fromRows,
    fromText(text) { return save(fromRows(A.files.parseText(text).sheets[0].rows)); },
    async fromFile(file) {
      const t = await A.files.readTable(file);
      const sheet = t.sheets.find((s) => fromRows(s.rows).length) || t.sheets[0];
      return save(fromRows(sheet ? sheet.rows : []));
    },
    async upload() {
      const f = await A.files.pick('.xlsx,.csv,.tsv,.txt');
      return f ? this.fromFile(f) : null;
    },
    get() { return A.get('roster') || []; },
    set(list) { return save(Array.isArray(list) ? list : []); },
    names() { return this.get().map((s) => s.name); },
  };
  if (A.store) { const saved = A.store.get('roster'); if (Array.isArray(saved) && saved.length) A.set('roster', saved); }
})();`;

const FORM_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  const typeOf = (vals, head = '') => {
    if (/이름|성명|학생명|name/i.test(head)) return 'name';
    const v = vals.filter((x) => String(x || '').trim());
    if (!v.length) return /일자|날짜|일시|date/i.test(head) ? 'date' : 'empty';
    const all = (re) => v.every((x) => re.test(String(x).trim()));
    if (all(/^-?\d+(\.\d+)?%?$/)) return 'number';
    if (all(/^\d{4}[-./]\s?\d{1,2}[-./]\s?\d{1,2}\.?$/) || all(/^\d{5}$/)) return 'date';
    return 'text';
  };
  const letter = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const analyzeSheet = (sheet) => {
    const rows = sheet.rows || [];
    const filled = (r) => (r || []).filter((c) => String(c || '').trim()).length;
    // 머리글 행: 앞쪽 15줄 중 글자 칸이 가장 많고(2칸 이상) 숫자만 있는 칸이 적은 줄
    let headerRow = -1, best = 1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i] || [];
      const texts = r.filter((c) => String(c || '').trim() && !/^-?\d+(\.\d+)?$/.test(String(c).trim())).length;
      if (texts > best) { best = texts; headerRow = i; }
    }
    const title = rows.slice(0, Math.max(0, headerRow)).map((r) => r.filter((c) => String(c || '').trim()).join(' ')).filter(Boolean).join(' / ');
    const header = headerRow >= 0 ? rows[headerRow] : [];
    const body = rows.slice(headerRow + 1);
    let lastData = -1;
    body.forEach((r, i) => { if (filled(r)) lastData = i; });
    const columns = header.map((h, j) => ({ index: j, letter: letter(j), name: String(h || '').trim(), type: typeOf(body.map((r) => r && r[j]), String(h || '')), samples: body.map((r) => r && r[j]).filter((x) => String(x || '').trim()).slice(0, 3) }))
      .filter((c) => c.name);
    const emptyRows = body.filter((r) => !filled(r)).length;
    return { name: sheet.name, title, headerRow: headerRow + 1, columns, dataRows: body.filter(filled).length, emptyRows, lastDataRow: headerRow + 2 + lastData, merges: sheet.merges || [], rows };
  };
  const summary = (a) => a.sheets.map((s) => '[' + s.name + '] ' + (s.title ? '제목 "' + s.title + '", ' : '') + s.headerRow + '행 머리글, 열 ' + s.columns.length + '개 (' + s.columns.map((c) => c.letter + ':' + c.name + '(' + c.type + ')').join(', ') + '), 내용 ' + s.dataRows + '줄, 빈 줄 ' + s.emptyRows + '개').join('\n');
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  A.form = {
    analyzeTable(table) { const res = { sheets: (table.sheets || []).map(analyzeSheet) }; res.summary = summary(res); A.set('form', res); A.emit('form:analyzed', res); return res; },
    async analyze(file) { return this.analyzeTable(await A.files.readTable(file)); },
    async upload() { const f = await A.files.pick('.xlsx,.csv,.tsv,.txt'); return f ? this.analyze(f) : null; },
    // records: [{열이름: 값}] → 양식의 열 순서대로 채운 표 (머리글 위 제목 줄 포함)
    fill(analysis, records, sheetIndex = 0) {
      const s = analysis.sheets[sheetIndex];
      if (!s) throw new Error('양식 시트가 없습니다');
      const top = s.rows.slice(0, s.headerRow);
      const width = Math.max(...top.map((r) => r.length), 1);
      const body = (records || []).map((rec) => {
        const keys = Object.keys(rec || {});
        const row = Array(width).fill('');
        for (const c of s.columns) { const k = keys.find((x) => norm(x) === norm(c.name)); if (k != null) row[c.index] = rec[k]; }
        return row;
      });
      return [...top, ...body];
    },
    download(analysis, records, fileName = '작성한_양식.csv', sheetIndex = 0) { A.files.download(fileName, A.files.toCsv(this.fill(analysis, records, sheetIndex)), 'text/csv;charset=utf-8'); },
  };
})();`;

const BACKUP_RUNTIME = (showButton) => String.raw`(() => {
  const A = window.__ideApp;
  const APP = (document.title || 'app').trim();
  const NS = '__ideStore:' + APP + ':';
  const ls = (() => { try { const k = '__ide_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } catch { return null; } })();
  const mem = {};
  A.store = {
    get(key, fallback) {
      try { const raw = ls ? ls.getItem(NS + key) : mem[key]; return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
    },
    set(key, value) {
      const raw = JSON.stringify(value === undefined ? null : value);
      try { if (ls) ls.setItem(NS + key, raw); else mem[key] = raw; } catch (e) { console.warn('저장 공간이 부족합니다', e); A.emit('store:error', e); }
      A.emit('store:saved', key);
    },
    remove(key) { try { if (ls) ls.removeItem(NS + key); else delete mem[key]; } catch {} },
    keys() { return ls ? Object.keys(ls).filter((k) => k.startsWith(NS)).map((k) => k.slice(NS.length)) : Object.keys(mem); },
  };
  // 공유 상태 키를 브라우저에 자동 저장하고, 다음에 열 때 되살린다
  A.persist = (key, fallback) => {
    const saved = A.store.get(key);
    if (saved !== undefined) A.set(key, saved);
    else if (fallback !== undefined) A.set(key, fallback);
    A.on('state:' + key, (v) => A.store.set(key, v));
    return A.get(key);
  };
  const otherApp = (k) => k.startsWith('__ideStore:') && !k.startsWith(NS);
  A.backup = {
    snapshot() {
      const data = {};
      if (ls) {
        for (const k of Object.keys(ls)) if (!otherApp(k) && k !== '__ide_probe') data[k] = ls.getItem(k);
      } else {
        Object.assign(data, Object.fromEntries(Object.entries(mem).map(([k, v]) => [NS + k, v])));
      }
      return { kind: 'webapp-backup', version: 1, app: APP, savedAt: new Date().toISOString(), localStorage: data };
    },
    download() {
      const d = new Date();
      const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      const name = APP.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '-백업-' + stamp + '.json';
      const blob = new Blob([JSON.stringify(this.snapshot(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      A.store.set('__lastBackup', d.toISOString());
      A.emit('backup:saved', name);
      return name;
    },
    async restore(file, { reload = true } = {}) {
      if (!file) file = await new Promise((resolve) => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json'; i.style.display = 'none'; i.onchange = () => { resolve(i.files[0] || null); i.remove(); }; document.body.appendChild(i); i.click(); });
      if (!file) return false;
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('백업 파일(.json)을 읽지 못했습니다'); }
      if (data?.kind !== 'webapp-backup' || !data.localStorage) throw new Error('이 앱의 백업 파일이 아닙니다');
      if (ls) for (const [k, v] of Object.entries(data.localStorage)) { try { ls.setItem(k, v); } catch {} }
      A.emit('backup:restored', data);
      if (reload) location.reload();
      return true;
    },
    lastBackupAt() { return A.store.get('__lastBackup') || null; },
  };
  if (${showButton ? 'true' : 'false'}) {
    const mount = () => {
      if (document.getElementById('__ideBackupFab')) return;
      const wrap = document.createElement('div');
      wrap.id = '__ideBackupFab';
      wrap.className = 'no-print';
      wrap.innerHTML = '<button type="button" data-b="toggle" title="데이터 백업">💾</button><div data-b="menu" hidden><button type="button" data-b="save">백업 파일 저장</button><button type="button" data-b="load">백업 불러오기</button><button type="button" data-b="errors" hidden>오류 기록 저장</button><small data-b="last"></small></div>';
      const css = document.createElement('style');
      css.textContent = '#__ideBackupFab{position:fixed;right:14px;bottom:14px;z-index:2147483000;font:13px system-ui,"Malgun Gothic",sans-serif}#__ideBackupFab>button{width:40px;height:40px;border-radius:50%;border:1px solid #ccd;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer;font-size:18px}#__ideBackupFab [data-b=menu]{position:absolute;right:0;bottom:48px;background:#fff;border:1px solid #ccd;border-radius:10px;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:150px;box-shadow:0 4px 16px rgba(0,0,0,.16);color:#222}#__ideBackupFab [data-b=menu][hidden]{display:none}#__ideBackupFab [data-b=menu] button{border:0;background:#f3f4f8;border-radius:6px;padding:7px 10px;text-align:left;cursor:pointer}#__ideBackupFab small{color:#777;padding:2px 4px}';
      document.head.appendChild(css);
      document.body.appendChild(wrap);
      const menu = wrap.querySelector('[data-b=menu]');
      wrap.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-b]')?.dataset.b;
        if (b === 'toggle') {
          menu.hidden = !menu.hidden;
          const last = A.backup.lastBackupAt();
          wrap.querySelector('[data-b=last]').textContent = last ? '마지막 백업: ' + new Date(last).toLocaleString('ko-KR') : '아직 백업한 적 없음';
          const fe = window.__ideFieldErrors;
          const n = fe ? fe.count() : 0;
          const eb = wrap.querySelector('[data-b=errors]');
          eb.hidden = !n;
          eb.textContent = '오류 기록 저장 (' + n + '건)';
        } else if (b === 'save') { A.backup.download(); menu.hidden = true; }
        else if (b === 'errors') { if (window.__ideFieldErrors) window.__ideFieldErrors.download(); menu.hidden = true; }
        else if (b === 'load') { try { await A.backup.restore(); } catch (err) { alert(err.message); } menu.hidden = true; }
      });
    };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  }
})();`;

const PRINT_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  // app.print() 는 전체, app.print(['영역ID', ...]) 는 고른 영역만 인쇄
  A.print = (regionIds) => {
    const ids = Array.isArray(regionIds) ? regionIds : regionIds ? [regionIds] : null;
    const hidden = [];
    if (ids) document.querySelectorAll('section[data-region]').forEach((el) => {
      if (!ids.includes(el.dataset.region) && !ids.some((id) => el.querySelector('section[data-region="' + id + '"]'))) { el.classList.add('ide-print-hide'); hidden.push(el); }
    });
    const done = () => { hidden.forEach((el) => el.classList.remove('ide-print-hide')); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    A.emit('print:start', ids);
    window.print();
    setTimeout(done, 1500);
  };
})();`;

// 인쇄할 때: 화면 높이 고정·스크롤을 풀어 내용이 다 나오게, 조작용 요소는 숨기고, 표·그림이 쪽 사이에서 끊기지 않게
export const PRINT_CSS = `@media print {
  @page { size: A4; margin: 12mm; }
  html, body { height: auto !important; background: #fff !important; }
  #app, #app .ide-grid, .ide-screen:not([hidden]) { display: block !important; height: auto !important; min-height: 0 !important; padding: 0 !important; overflow: visible !important; }
  #app section[data-region] { overflow: visible !important; height: auto !important; max-height: none !important; margin: 0 0 6mm !important; break-inside: auto; }
  #app section[data-region].ide-print-hide, .ide-screen[hidden] { display: none !important; }
  button, input[type="button"], input[type="submit"], input[type="reset"], input[type="file"], select:not([data-print]), .no-print, [data-no-print], #__ideBackupFab, dialog:not([open]) { display: none !important; }
  input, textarea { border: 1px solid #999 !important; background: #fff !important; }
  textarea { height: auto !important; min-height: 2em; overflow: visible !important; resize: none; }
  table { border-collapse: collapse; width: 100%; }
  thead { display: table-header-group; }
  tr, img, svg, canvas, figure, li { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  * { box-shadow: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-only { display: block !important; }
}
.print-only { display: none; }`;

// 빌드할 때 런타임 뒤에 붙일 코드 (켜 둔 스킬만)
export function skillsRuntime(skills) {
  const s = normalizeSkills(skills);
  const on = new Set(s.enabled);
  const parts = [];
  if (on.has('backup')) parts.push(BACKUP_RUNTIME(s.options.backupButton));
  if (on.has('roster') || on.has('formScan') || on.has('grades') || on.has('sheets')) parts.push(FILES_RUNTIME);
  if (on.has('roster')) parts.push(ROSTER_RUNTIME);
  if (on.has('formScan')) parts.push(FORM_RUNTIME);
  if (on.has('grades')) parts.push(GRADES_RUNTIME);
  if (on.has('groups')) parts.push(GROUPS_RUNTIME);
  if (on.has('timer')) parts.push(TIMER_RUNTIME);
  if (on.has('sheets')) parts.push(SHEETS_RUNTIME(s.options));
  if (on.has('qr')) parts.push(QR_RUNTIME);
  if (on.has('print')) parts.push(PRINT_RUNTIME);
  return parts.join('\n');
}

// 앱 런타임과 켜 둔 스킬이 스스로 보내는 이벤트·공유 상태 (연결 분석에서 "보내는 곳 없음" 오류로 보지 않게)
export function skillsProvides(skills) {
  const on = new Set(normalizeSkills(skills).enabled);
  const events = ['app:ready', 'screen:change'];
  const states = ['screen'];
  if (on.has('roster')) { events.push('roster:loaded'); states.push('roster'); }
  if (on.has('formScan')) { events.push('form:analyzed'); states.push('form'); }
  if (on.has('backup')) events.push('store:saved', 'store:error', 'backup:saved', 'backup:restored');
  if (on.has('grades')) { events.push('grades:computed'); states.push('grades'); }
  if (on.has('groups')) { events.push('groups:made', 'seats:made'); states.push('groups', 'seats'); }
  if (on.has('timer')) events.push('timer:start', 'timer:pause', 'timer:tick', 'timer:end', 'timer:reset');
  if (on.has('sheets')) { events.push('sheets:loaded', 'sheets:saved', 'sheets:error', 'sheets:queued'); states.push('sheet'); }
  if (on.has('print')) events.push('print:start');
  return { events, states };
}

export function skillsCss(skills) {
  const on = new Set(normalizeSkills(skills).enabled);
  return [on.has('groups') && GROUPS_CSS, on.has('timer') && TIMER_CSS, on.has('sheets') && SHEETS_CSS, on.has('qr') && QR_CSS, on.has('print') && PRINT_CSS].filter(Boolean).join('\n');
}

// 영역을 만드는 AI 에게 줄 사용법 (켜 둔 스킬만)
const GUIDE = {
  print: `- 🖨 인쇄: 인쇄용 CSS 가 자동으로 들어갑니다(버튼·파일 입력 숨김, 높이 고정 해제). 인쇄 버튼이 필요하면 app.print() (전체) 또는 app.print(['영역ID']) (그 영역만). 인쇄에서 빼고 싶은 요소는 class="no-print", 인쇄에만 보일 요소는 class="print-only".`,
  backup: `- 💾 저장·백업: 데이터를 localStorage 에 직접 쓰지 말고 app.store.get(키, 기본값) / app.store.set(키, 값) 을 쓰세요(자동 저장, JSON 변환 포함). 공유 상태를 저장하려면 앱 시작 때 app.persist('키', 기본값) 한 번 → 이후 app.set('키', 값) 할 때마다 저장되고 새로고침해도 되살아납니다. 화면 오른쪽 아래 💾 버튼이 백업 파일 저장·불러오기를 이미 제공하므로 같은 버튼을 또 만들지 마세요. 필요하면 app.backup.download() / app.backup.restore() 를 호출하세요.`,
  roster: `- 👥 명단 업로드: 파일을 직접 파싱하지 말고 await app.roster.upload() (파일 고르기 창 → 엑셀 xlsx·CSV·TSV 읽기) 또는 app.roster.fromText(붙여넣은 글) 을 쓰세요. 결과는 [{ name, number?, studentId?, grade?, class?, gender?, extra? }] 이고 app.set('roster', 목록) + app.emit('roster:loaded', 목록) 이 자동으로 됩니다. 다른 영역은 app.on('state:roster', fn) 으로 받으세요. 현재 명단: app.roster.get(), 이름만: app.roster.names().`,
  formScan: `- 📋 양식 분석: 사용자가 올린 학교 양식 파일을 const a = await app.form.upload() 로 분석하세요. a.sheets[0] = { title, headerRow, columns: [{ letter, name, type('number'|'date'|'name'|'text'|'empty'), samples }], dataRows, emptyRows }, a.summary = 한 줄 요약. 결과는 app.set('form', a) + app.emit('form:analyzed', a). 앱 데이터를 양식 열 순서대로 내보낼 때는 app.form.download(a, [{ 열이름: 값, ... }], '파일이름.csv'). 표 파일 읽기만 필요하면 await app.files.readTable(file) → { sheets: [{ name, rows: [[...]] }] }.`,
  grades: `- 📊 성적 합계·순위: 계산을 직접 짜지 말고 const r = app.grades.compute(행들, { items: ['국어','수학'] 또는 [{ key: '중간', weight: 30, max: 100 }, ...], grade: 'nine'(9등급) | 'five'(A~E) | [{ grade: 'A', min: 90 }, ...], by: 'total'|'average'|'weighted', blank: 'skip'|'zero' }) 를 쓰세요. 행들은 [{ name, 국어: 90, ... }] 또는 첫 줄이 머리글인 [[...]] (명단·표 파일에서 읽은 그대로). items 를 빼면 숫자 열을 스스로 찾습니다. r.rows 의 각 줄에 total, average, weighted(반영비율 환산), rank(동점 같은 등수), percentile, grade 가 붙고 석차순으로 정렬됩니다. r.summary[과목] = { count, mean, median, min, max, sd }. 결과는 app.set('grades', r) + app.emit('grades:computed', r) 가 자동. 파일에서 바로: await app.grades.upload(옵션). 내보내기용 표: app.grades.toCsv(r) → app.files.download('성적.csv', app.files.toCsv(표)).`,
  groups: `- 🎲 모둠·자리 배치: 섞기를 직접 짜지 말고 app.groups.make(명단, { count: 모둠수 } 또는 { size: 모둠당인원 }, + 선택 balance: 'gender', together: [['가','나']], apart: [['가','다']], seed) 를 쓰세요. 명단을 빼면 app.roster 명단을 씁니다(absent: true 인 학생 제외). 결과 { groups: [[학생...]], names: [['이름'...]], conflicts } 는 app.set('groups') + app.emit('groups:made') 가 자동. 자리표: const s = app.groups.seats(명단, { rows, cols, front: ['앞자리 이름'], fixed: { 이름: [행, 열] }, empty: [[행, 열]] }) → s.names (2차원, 빈 칸 null), app.groups.renderSeats('#자리표', s) 로 교탁이 있는 표를 그립니다. 한 명 뽑기: app.groups.pick(명단, 1).`,
  timer: `- ⏱ 타이머: setInterval 로 직접 세지 말고 app.timer.mount('#칸', { seconds: 300 }) 한 줄이면 큰 숫자·시작/멈춤·처음으로·1/3/5/10분 버튼·끝 소리가 다 그려집니다(초시계는 { mode: 'stopwatch' }). 직접 그릴 때는 const t = app.timer.create({ seconds: 60, id: '발표' }); t.start(), t.pause(), t.reset(초), t.add(초), t.text() → '04:59', t.on((종류, 정보) => …). 다른 영역은 app.on('timer:end', i => …) / 'timer:tick' / 'timer:start' 로 받습니다(i.id, i.remaining, i.text). 시간 글자만: app.timer.format(초).`,
  sheets: `- 🟩 구글 시트: 시트 주소를 코드에 적지 말고 app.sheets 를 쓰세요. 불러오기: const d = await app.sheets.read() → { rows: [[...]], objects: [{열: 값}] } (app.set('sheet', d) + 'sheets:loaded' 자동). 저장: await app.sheets.append([{ 이름, 점수 }, ...]) (실패하면 오류를 던지고 자동으로 모아 두었다가 다시 보냄, app.sheets.pending() 건수). 시트 주소가 아직 없으면(app.sheets.configured.read/.write 가 false) 교사용 '⚙ 시트 연결' 버튼을 두고 app.sheets.setup() 을 부르세요(주소 입력·Apps Script 코드 복사 창). 오류는 try/catch 로 받아 화면에 알려 주세요(인터넷이 없을 수 있음).`,
  qr: `- 🔳 QR 코드: 외부 QR 라이브러리·API 를 쓰지 말고 app.qr.render('#칸', 주소, { size: 200, caption: true }) 로 그리세요. SVG 글자: app.qr.svg(글, { size }), 캔버스: app.qr.canvas(글, { size }), PNG 저장 버튼: app.qr.download(글, '파일이름.png'). 오류 정정 { ecc: 'L'|'M'|'Q'|'H' } (기본 M). 인터넷 없이 됩니다.`,
};

export function skillsPromptSection(skills) {
  const s = normalizeSkills(skills);
  if (!s.enabled.length) return '';
  return `\n# 이 앱에 켜진 스킬 (window.app 에 이미 들어 있는 기능 — 직접 다시 만들지 말고 이것을 쓰세요)\n${s.enabled.map((id) => GUIDE[id]).join('\n')}\n`;
}
