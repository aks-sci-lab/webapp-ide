// 학교 업무용 스킬 5개의 앱 런타임 코드: 성적 합계·순위, 모둠·자리 배치, 타이머, 구글 시트 연동, QR 코드.
// skills.js 가 켜 둔 것만 골라 앱(window.app)에 붙인다. 모두 외부 라이브러리 없이 브라우저에서 돈다.

// ── 📊 성적 합계·순위: app.grades ──
export const GRADES_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  const num = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[,\s점]/g, '');
    if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
    return Number(s);
  };
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  // 9등급 누적 비율(%) — 상대평가
  const NINE = [4, 11, 23, 40, 60, 77, 89, 96, 100];
  // 성취도 A~E (절대평가, 100점 기준)
  const FIVE = [{ grade: 'A', min: 90 }, { grade: 'B', min: 80 }, { grade: 'C', min: 70 }, { grade: 'D', min: 60 }, { grade: 'E', min: 0 }];
  const stats = (values) => {
    const v = (values || []).map(num).filter((x) => x != null).sort((a, b) => a - b);
    const n = v.length;
    if (!n) return { count: 0, sum: 0, mean: null, median: null, min: null, max: null, sd: null };
    const sum = v.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return { count: n, sum: round(sum, 4), mean: round(mean, 2), median: n % 2 ? v[(n - 1) / 2] : round((v[n / 2 - 1] + v[n / 2]) / 2, 2), min: v[0], max: v[n - 1], sd: round(sd, 2) };
  };
  // 같은 점수는 같은 등수, 다음 등수는 건너뛴다 (1, 2, 2, 4)
  const rank = (values, opts = {}) => {
    const asc = opts.order === 'asc';
    const v = (values || []).map(num);
    return v.map((x) => (x == null ? null : 1 + v.filter((y) => y != null && (asc ? y < x : y > x)).length));
  };
  const nineGrade = (r, n) => {
    if (r == null || !n) return null;
    // 동점자는 중간 등수로 보는 게 원칙이지만, 학교 현장 계산기처럼 석차 / 인원 누적 비율로 자른다
    const p = (r / n) * 100;
    return NINE.findIndex((c) => p <= c + 1e-9) + 1;
  };
  const letter = (score, cut) => {
    if (score == null) return null;
    const list = (Array.isArray(cut) ? cut : FIVE).slice().sort((a, b) => b.min - a.min);
    const hit = list.find((c) => score >= c.min);
    return hit ? hit.grade : list[list.length - 1]?.grade ?? null;
  };
  // rows: [{ name, 국어: 90, ... }] 또는 [[...]] (첫 줄 머리글)
  const toObjects = (rows) => {
    if (!Array.isArray(rows) || !rows.length) return [];
    if (Array.isArray(rows[0])) {
      const [head, ...body] = rows;
      return body.filter((r) => r.some((c) => String(c ?? '').trim())).map((r) => Object.fromEntries(head.map((h, i) => [String(h ?? '').trim() || '열' + (i + 1), r[i]])));
    }
    return rows.map((r) => (typeof r === 'object' && r ? { ...r } : { name: String(r) }));
  };
  const SKIP = /^(이름|성명|번호|번|학번|반|학년|성별|name|number|studentId|class|grade|gender|비고|메모)$/i;
  const guessItems = (objs) => {
    const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))].filter((k) => !SKIP.test(k) && typeof objs[0]?.[k] !== 'object');
    return keys.filter((k) => { const vals = objs.map((o) => o[k]).filter((x) => String(x ?? '').trim()); return vals.length && vals.every((x) => num(x) != null); }).map((key) => ({ key }));
  };
  const compute = (rows, opts = {}) => {
    const objs = toObjects(rows);
    const items = (opts.items || guessItems(objs)).map((it) => (typeof it === 'string' ? { key: it } : it));
    const anyWeight = items.some((it) => it.weight != null);
    const by = opts.by || (anyWeight ? 'weighted' : 'total');
    const blank = opts.blank === 'zero' ? 'zero' : 'skip';
    const out = objs.map((o) => {
      const r = { ...o };
      let total = 0, got = 0, wsum = 0;
      for (const it of items) {
        let v = num(o[it.key]);
        if (v == null && blank === 'zero') v = 0;
        if (v == null) continue;
        got++;
        total += v;
        // 반영 비율: (점수 / 만점) × 반영비율 — 비율 합이 100 이면 100점 만점 환산 점수
        if (it.weight != null) wsum += (v / (Number(it.max) || 100)) * Number(it.weight);
      }
      r.total = got ? round(total, 4) : null;
      r.average = got ? round(total / got, 2) : null;
      r.weighted = got ? (anyWeight ? round(wsum, 2) : r.average) : null;
      return r;
    });
    const key = by === 'average' ? 'average' : by === 'weighted' ? 'weighted' : 'total';
    const ranks = rank(out.map((r) => r[key]), opts);
    const n = out.filter((r) => r[key] != null).length;
    out.forEach((r, i) => {
      r.rank = ranks[i];
      r.percentile = r.rank == null ? null : round((r.rank / n) * 100, 1);
      if (opts.grade === 'nine') r.grade = nineGrade(r.rank, n);
      else if (opts.grade === 'five' || Array.isArray(opts.grade)) r.grade = letter(key === 'total' && items.length > 1 && !opts.gradeOn ? r.average : r[opts.gradeOn || key], Array.isArray(opts.grade) ? opts.grade : FIVE);
    });
    if (opts.sort !== false) out.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    const summary = Object.fromEntries(items.map((it) => [it.key, stats(objs.map((o) => o[it.key]))]));
    summary[key] = stats(out.map((r) => r[key]));
    const result = { items: items.map((it) => it.key), by: key, rows: out, summary, count: n };
    A.set('grades', result);
    A.emit('grades:computed', result);
    return result;
  };
  A.grades = {
    num, stats, rank, compute, nineGrade, letter, NINE, FIVE,
    async upload(opts) {
      if (!A.files) throw new Error('파일 읽기 기능이 없습니다');
      const f = await A.files.pick('.xlsx,.csv,.tsv,.txt');
      if (!f) return null;
      const t = await A.files.readTable(f);
      const sheet = t.sheets.find((s) => s.rows.length > 1) || t.sheets[0];
      return compute(sheet ? sheet.rows : [], opts);
    },
    toCsv(result) {
      const cols = ['rank', ...Object.keys(result.rows[0] || {}).filter((k) => k !== 'rank')];
      const label = { rank: '석차', total: '합계', average: '평균', weighted: '환산점수', percentile: '백분위', grade: '등급' };
      return [cols.map((c) => label[c] || c), ...result.rows.map((r) => cols.map((c) => r[c] ?? ''))];
    },
  };
})();`;

// ── 🎲 모둠·자리 배치: app.groups ──
export const GROUPS_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  const rng = (seed) => {
    if (seed == null) return Math.random;
    let a = typeof seed === 'number' ? seed >>> 0 : [...String(seed)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };
  const nameOf = (m) => (m && typeof m === 'object' ? m.name : String(m));
  const shuffle = (list, seed) => {
    const r = rng(seed), a = (list || []).slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const members = (list) => (list == null ? (A.roster ? A.roster.get() : A.get('roster') || []) : list).filter((m) => nameOf(m) && !(m && m.absent));
  // 떨어뜨릴 짝이 같은 모둠에 있으면 다른 모둠 사람과 바꿔 본다
  const conflicts = (g, apart) => apart.filter(([a, b]) => g.some((n) => nameOf(n) === a) && g.some((n) => nameOf(n) === b)).length;
  const fixApart = (groups, apart, r, locked = new Set()) => {
    if (!apart.length) return groups;
    for (let round = 0; round < 200; round++) {
      const gi = groups.findIndex((g) => conflicts(g, apart));
      if (gi < 0) break;
      const g = groups[gi];
      const pair = apart.find(([a, b]) => g.some((n) => nameOf(n) === a) && g.some((n) => nameOf(n) === b));
      // 함께 묶인 사람은 옮기지 않는다
      const mover = locked.has(pair[1]) ? pair[0] : pair[1];
      if (locked.has(mover)) break;
      const mi = g.findIndex((n) => nameOf(n) === mover);
      let done = false;
      const order = shuffle(groups.map((_, i) => i).filter((i) => i !== gi), Math.floor(r() * 1e9));
      for (const oj of order) {
        for (let k = 0; k < groups[oj].length && !done; k++) {
          if (locked.has(nameOf(groups[oj][k]))) continue;
          const a = g.slice(), b = groups[oj].slice();
          [a[mi], b[k]] = [b[k], a[mi]];
          if (conflicts(a, apart) < conflicts(g, apart) && conflicts(b, apart) <= conflicts(groups[oj], apart)) { groups[gi] = a; groups[oj] = b; done = true; }
        }
        if (done) break;
      }
      if (!done) break;
    }
    return groups;
  };
  const make = (list, opts = {}) => {
    if (typeof opts === 'number') opts = { count: opts };
    const r = rng(opts.seed);
    const people = members(list);
    const n = people.length;
    if (!n) { const empty = { groups: [], names: [] }; A.set('groups', empty); A.emit('groups:made', empty); return empty; }
    const count = Math.max(1, Math.min(n, opts.count ? Math.round(opts.count) : Math.ceil(n / Math.max(1, Math.round(opts.size || 4)))));
    let pool = shuffle(people, Math.floor(r() * 1e9));
    // balance: 'gender' 처럼 같은 값을 가진 사람이 모둠마다 고르게 퍼지도록 값별로 모아 차례로 나눈다
    if (opts.balance) {
      const key = opts.balance;
      const buckets = {};
      for (const p of pool) (buckets[p && typeof p === 'object' ? p[key] ?? '' : ''] ||= []).push(p);
      pool = Object.values(buckets).sort((a, b) => b.length - a.length).flat();
    }
    let groups = Array.from({ length: count }, () => []);
    // 지그재그로 나눠 인원 차이를 1명 이내로
    pool.forEach((p, i) => { const round = Math.floor(i / count), k = i % count; groups[round % 2 ? count - 1 - k : k].push(p); });
    // together: 같은 모둠에 넣을 사람들 — 첫 사람 모둠으로 옮기고 그 모둠의 다른 사람과 자리를 바꾼다
    for (const set of opts.together || []) {
      const home = groups.findIndex((g) => g.some((m) => nameOf(m) === set[0]));
      if (home < 0) continue;
      for (const nm of set.slice(1)) {
        const gi = groups.findIndex((g) => g.some((m) => nameOf(m) === nm));
        if (gi < 0 || gi === home) continue;
        const swapIdx = groups[home].findIndex((m) => !set.includes(nameOf(m)));
        const mi = groups[gi].findIndex((m) => nameOf(m) === nm);
        if (swapIdx < 0) { groups[home].push(groups[gi].splice(mi, 1)[0]); continue; }
        [groups[home][swapIdx], groups[gi][mi]] = [groups[gi][mi], groups[home][swapIdx]];
      }
    }
    groups = fixApart(groups, (opts.apart || []).filter((p) => Array.isArray(p) && p.length >= 2).flatMap((p) => p.slice(1).map((b) => [p[0], b])), r, new Set((opts.together || []).flat()));
    const result = { groups, names: groups.map((g) => g.map(nameOf)), count, conflicts: groups.reduce((a, g) => a + conflicts(g, (opts.apart || []).flatMap((p) => p.slice(1).map((b) => [p[0], b]))), 0) };
    A.set('groups', result);
    A.emit('groups:made', result);
    return result;
  };
  // 자리표: rows × cols 칸, fixed: { 이름: [행, 열] } (0부터), front: 앞줄 우선 이름들, empty: [[행,열], ...] 비울 칸
  const seats = (list, opts = {}) => {
    const r = rng(opts.seed);
    const people = members(list);
    const cols = Math.max(1, Math.round(opts.cols || 6));
    const empty = new Set((opts.empty || []).map(([y, x]) => y + ',' + x));
    const fixed = opts.fixed || {};
    const capacityRows = (n) => { let rows = 0, cap = 0; while (cap < n) { for (let x = 0; x < cols; x++) if (!empty.has(rows + ',' + x)) cap++; rows++; if (rows > 200) break; } return rows; };
    const rows = Math.max(1, Math.round(opts.rows || capacityRows(people.length)));
    const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
    const placed = new Set();
    for (const [nm, pos] of Object.entries(fixed)) {
      const p = people.find((m) => nameOf(m) === nm);
      const [y, x] = pos || [];
      if (p && grid[y] && x >= 0 && x < cols && grid[y][x] == null) { grid[y][x] = p; placed.add(p); }
    }
    const open = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (grid[y][x] == null && !empty.has(y + ',' + x)) open.push([y, x]);
    const front = new Set(opts.front || []);
    const rest = shuffle(people.filter((p) => !placed.has(p)), Math.floor(r() * 1e9));
    const ordered = [...rest.filter((p) => front.has(nameOf(p))), ...rest.filter((p) => !front.has(nameOf(p)))];
    // 사람을 섞은 뒤 앞줄부터 채운다 (앞자리 우선인 사람이 먼저, 남는 빈자리는 뒤쪽)
    ordered.forEach((p, i) => { const s = open[i]; if (s) grid[s[0]][s[1]] = p; });
    const overflow = ordered.slice(open.length);
    const result = { rows, cols, grid, names: grid.map((row) => row.map((m) => (m == null ? null : nameOf(m)))), overflow: overflow.map(nameOf) };
    A.set('seats', result);
    A.emit('seats:made', result);
    return result;
  };
  // 자리표를 표(<table>)로 그린다. teacherAtTop: 교탁을 위에 둘지 (기본: 아래 = 학생 시점이 아닌 교사 시점)
  const renderSeats = (el, result = A.get('seats'), opts = {}) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el || !result) return;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = result.names.map((row) => '<tr>' + row.map((n) => '<td class="ide-seat' + (n ? '' : ' ide-seat-empty') + '">' + esc(n || '') + '</td>').join('') + '</tr>');
    const desk = '<tr><td class="ide-seat-desk" colspan="' + result.cols + '">교탁</td></tr>';
    el.innerHTML = '<table class="ide-seats">' + (opts.teacherAtTop === false ? rows.join('') + desk : desk + rows.join('')) + '</table>';
  };
  A.groups = { shuffle, make, seats, renderSeats, pick(list, k = 1, seed) { return shuffle(members(list), seed).slice(0, k); } };
})();`;

export const GROUPS_CSS = `.ide-seats { border-collapse: separate; border-spacing: 6px; margin: 0 auto; }
.ide-seats td { min-width: 64px; height: 44px; text-align: center; border: 1px solid #c8ccd4; border-radius: 6px; background: #fff; color: #222; font-weight: 600; padding: 4px 6px; }
.ide-seats td.ide-seat-empty { background: transparent; border-style: dashed; }
.ide-seats td.ide-seat-desk { background: #eef1f6; font-weight: 400; color: #555; border-style: solid; }`;

// ── ⏱ 타이머·카운트다운: app.timer ──
export const TIMER_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  const pad = (n) => String(n).padStart(2, '0');
  const format = (sec) => {
    sec = Math.max(0, Math.ceil(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  };
  let audio = null;
  const beep = (times = 3) => {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        const t = audio.currentTime + i * 0.45;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.start(t); o.stop(t + 0.4);
      }
    } catch {}
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
  };
  const timers = {};
  let seq = 0;
  // create({ seconds: 300 }) 카운트다운, create({ mode: 'stopwatch' }) 초시계
  const create = (opts = {}) => {
    if (typeof opts === 'number') opts = { seconds: opts };
    const id = opts.id || 'timer' + (++seq);
    const mode = opts.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
    let total = Math.max(0, Number(opts.seconds) || 0);
    let acc = 0, startedAt = 0, running = false, handle = null, ended = false;
    const listeners = [];
    const elapsed = () => acc + (running ? (Date.now() - startedAt) / 1000 : 0);
    const remaining = () => Math.max(0, total - elapsed());
    const info = () => ({ id, mode, running, elapsed: elapsed(), remaining: mode === 'countdown' ? remaining() : null, total, text: t.text() });
    const fire = (type) => { const i = info(); listeners.forEach((fn) => { try { fn(type, i); } catch (e) { console.error(e); } }); A.emit('timer:' + type, i); };
    const loop = () => {
      handle = null;
      if (!running) return;
      if (mode === 'countdown' && remaining() <= 0) {
        acc = total; running = false; ended = true;
        fire('tick'); fire('end');
        if (opts.sound !== false) beep();
        return;
      }
      fire('tick');
      handle = setTimeout(loop, 250);
    };
    const t = {
      id, mode,
      get running() { return running; },
      get remaining() { return mode === 'countdown' ? remaining() : null; },
      get elapsed() { return elapsed(); },
      get total() { return total; },
      text() { return format(mode === 'countdown' ? remaining() : elapsed()); },
      start() { if (running) return t; if (mode === 'countdown' && remaining() <= 0) { acc = 0; ended = false; } startedAt = Date.now(); running = true; fire('start'); loop(); return t; },
      pause() { if (!running) return t; acc = elapsed(); running = false; if (handle) clearTimeout(handle); handle = null; fire('pause'); return t; },
      toggle() { return running ? t.pause() : t.start(); },
      reset(seconds) { if (handle) clearTimeout(handle); handle = null; running = false; acc = 0; ended = false; if (seconds != null) total = Math.max(0, Number(seconds) || 0); fire('reset'); return t; },
      add(seconds) { total = Math.max(0, total + Number(seconds || 0)); fire('tick'); return t; },
      on(fn) { listeners.push(fn); return t; },
      get ended() { return ended; },
    };
    timers[id] = t;
    if (opts.autostart) t.start();
    return t;
  };
  // 큰 숫자 + 시작/멈춤/처음으로 + 빠른 시간 버튼이 달린 타이머를 el 안에 그린다
  const mount = (el, opts = {}) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return null;
    const t = create(opts);
    const presets = opts.presets || (t.mode === 'countdown' ? [60, 180, 300, 600] : []);
    el.innerHTML = '<div class="ide-timer' + (t.mode === 'countdown' ? '' : ' ide-stopwatch') + '"><div class="ide-timer-face" aria-live="polite"></div>' +
      '<div class="ide-timer-btns"><button type="button" data-t="toggle">시작</button><button type="button" data-t="reset">처음으로</button>' +
      presets.map((s) => '<button type="button" data-t="preset" data-s="' + s + '">' + (s % 60 ? s + '초' : s / 60 + '분') + '</button>').join('') + '</div></div>';
    const face = el.querySelector('.ide-timer-face'), box = el.querySelector('.ide-timer'), tog = el.querySelector('[data-t="toggle"]');
    const draw = () => {
      face.textContent = t.text();
      tog.textContent = t.running ? '멈춤' : '시작';
      box.classList.toggle('ide-timer-warn', t.mode === 'countdown' && t.running && t.remaining <= (opts.warnAt ?? 10));
      box.classList.toggle('ide-timer-end', t.ended);
    };
    t.on(draw);
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'toggle') t.toggle();
      else if (b.dataset.t === 'reset') t.reset();
      else if (b.dataset.t === 'preset') { t.reset(Number(b.dataset.s)); }
    });
    draw();
    return t;
  };
  A.timer = { create, mount, format, beep, get: (id) => timers[id] || null, all: () => Object.values(timers) };
})();`;

export const TIMER_CSS = `.ide-timer { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px; container-type: inline-size; }
.ide-timer-face { font: 700 clamp(28px, 24cqi, 160px)/1 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; letter-spacing: 2px; }
.ide-timer-btns { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
.ide-timer-btns button { font-size: 16px; padding: 6px 14px; }
.ide-timer-warn .ide-timer-face { color: #d9480f; }
.ide-timer-end .ide-timer-face { color: #c92a2a; animation: ide-timer-blink 1s steps(2) infinite; }
@keyframes ide-timer-blink { 50% { opacity: .25; } }`;

// ── 🟩 구글 시트 연동: app.sheets ──
// 읽기: "링크가 있는 모든 사용자 보기" 시트 주소 → CSV 로 받아 표로.
// 쓰기: 교사가 시트에 붙여 넣은 Apps Script 웹 앱 주소로 줄 추가 (실패하면 브라우저에 쌓아 두었다가 다시 보냄).
export const SHEETS_SCRIPT = `// 구글 시트 > 확장 프로그램 > Apps Script 에 붙여 넣고
// 배포 > 새 배포 > 유형: 웹 앱, 실행: 나, 액세스: 모든 사용자 → 웹 앱 URL 을 복사해 앱에 넣으세요.
function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(body.sheet || '') || ss.getSheets()[0];
  var rows = body.rows || [];
  if (body.header && sh.getLastRow() === 0) sh.appendRow(body.header);
  if (body.mode === 'replace') { sh.clearContents(); if (body.header) sh.appendRow(body.header); }
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  return ContentService.createTextOutput(JSON.stringify({ ok: true, added: rows.length })).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName((e.parameter && e.parameter.sheet) || '') || ss.getSheets()[0];
  return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: sh.getDataRange().getDisplayValues() })).setMimeType(ContentService.MimeType.JSON);
}`;

export const SHEETS_RUNTIME = (cfg) => String.raw`(() => {
  const A = window.__ideApp;
  const CFG = ${JSON.stringify({ readUrl: cfg.sheetsUrl || '', writeUrl: cfg.sheetsScript || '' })};
  const KEY = '__ideSheets:' + (document.title || 'app').trim();
  const ls = (() => { try { return window.localStorage; } catch { return null; } })();
  const load = () => { try { return JSON.parse((ls && ls.getItem(KEY)) || '{}'); } catch { return {}; } };
  const saveCfg = (v) => { try { ls && ls.setItem(KEY, JSON.stringify(v)); } catch {} };
  const conf = () => ({ ...CFG, ...Object.fromEntries(Object.entries(load()).filter(([k, v]) => v && k !== 'queue')) });
  // 일반 시트 주소(…/edit#gid=0)를 CSV 받기 주소로 바꾼다
  const csvUrl = (url, sheet) => {
    url = String(url || '').trim();
    if (!url) throw new Error('구글 시트 주소가 없습니다');
    if (/output=csv|tqx=out:csv/.test(url)) return url;
    const m = url.match(/\/spreadsheets\/d\/(e\/)?([\w-]+)/);
    if (!m) throw new Error('구글 시트 주소가 아닙니다: ' + url.slice(0, 60));
    if (m[1]) return 'https://docs.google.com/spreadsheets/d/e/' + m[2] + '/pub?output=csv' + ((url.match(/gid=(\d+)/) || [])[1] ? '&gid=' + url.match(/gid=(\d+)/)[1] : '');
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    return 'https://docs.google.com/spreadsheets/d/' + m[2] + '/gviz/tq?tqx=out:csv' + (sheet ? '&sheet=' + encodeURIComponent(sheet) : gid ? '&gid=' + gid : '');
  };
  const parseCsv = (text) => {
    if (A.files) return A.files.parseText(text).sheets[0].rows;
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };
  const objects = (rows) => {
    const [head = [], ...body] = rows;
    return body.filter((r) => r.some((c) => String(c ?? '').trim())).map((r) => Object.fromEntries(head.map((h, i) => [String(h || '열' + (i + 1)).trim(), r[i] ?? ''])));
  };
  const fail = (e, what) => {
    const err = new Error(what + ': ' + (e && e.message ? e.message : e) + (navigator.onLine === false ? ' (인터넷 연결 없음)' : ''));
    A.emit('sheets:error', { what, message: err.message });
    return err;
  };
  const queue = () => load().queue || [];
  const setQueue = (q) => { const v = load(); v.queue = q; saveCfg(v); };
  const post = async (payload, url) => {
    // text/plain 으로 보내면 브라우저가 사전 확인(CORS preflight)을 하지 않아 Apps Script 가 받는다
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let data = null;
    try { data = await res.json(); } catch {}
    if (data && data.ok === false) throw new Error(data.error || '시트가 거부했습니다');
    return data || { ok: true };
  };
  const S = {
    config(v) { if (v) { const cur = load(); saveCfg({ ...cur, ...v }); } return conf(); },
    csvUrl,
    get configured() { const c = conf(); return { read: !!c.readUrl, write: !!c.writeUrl }; },
    async read(url, opts = {}) {
      const c = conf();
      try {
        let rows;
        if (!url && !c.readUrl && c.writeUrl) {
          const res = await fetch(c.writeUrl + (opts.sheet ? (c.writeUrl.includes('?') ? '&' : '?') + 'sheet=' + encodeURIComponent(opts.sheet) : ''));
          rows = (await res.json()).rows || [];
        } else {
          const res = await fetch(csvUrl(url || c.readUrl, opts.sheet), { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status + ' — 시트 공유를 "링크가 있는 모든 사용자: 뷰어"로 바꿨는지 확인하세요');
          const text = await res.text();
          if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('시트가 공개되어 있지 않습니다 (공유 > 링크가 있는 모든 사용자)');
          rows = parseCsv(text.replace(/^﻿/, ''));
        }
        const out = { rows, objects: objects(rows), at: new Date().toISOString() };
        A.set('sheet', out);
        A.emit('sheets:loaded', out);
        return out;
      } catch (e) { throw fail(e, '시트 불러오기'); }
    },
    // rows: [[...], ...] 또는 [{열: 값}] — header 를 주면 빈 시트에 머리글을 먼저 쓴다
    async append(rows, opts = {}) {
      const c = conf();
      const url = opts.url || c.writeUrl;
      if (!url) throw fail(new Error('Apps Script 웹 앱 주소가 없습니다. app.sheets.setup() 으로 넣으세요'), '시트에 저장');
      let header = opts.header || null;
      if (rows.length && !Array.isArray(rows[0])) { header ||= Object.keys(rows[0]); rows = rows.map((r) => header.map((h) => r[h] ?? '')); }
      const payload = { sheet: opts.sheet || '', mode: opts.mode === 'replace' ? 'replace' : 'append', header, rows };
      try {
        await S.flush(url);
        const data = await post(payload, url);
        A.emit('sheets:saved', { added: rows.length, sheet: payload.sheet });
        return data;
      } catch (e) {
        if (opts.queue !== false && payload.mode === 'append') { setQueue([...queue(), payload]); A.emit('sheets:queued', { pending: queue().length }); }
        throw fail(e, '시트에 저장');
      }
    },
    pending() { return queue().length; },
    async flush(url) {
      const q = queue();
      url ||= conf().writeUrl;
      if (!q.length || !url) return 0;
      let sent = 0;
      for (const p of q) { await post(p, url); sent++; setQueue(q.slice(sent)); }
      if (sent) A.emit('sheets:saved', { added: sent, flushed: true });
      return sent;
    },
    scriptCode() { return ${JSON.stringify(SHEETS_SCRIPT)}; },
    // 교사가 앱 화면에서 시트 주소를 넣는 작은 창
    setup() {
      return new Promise((resolve) => {
        const c = conf();
        const d = document.createElement('dialog');
        d.className = 'ide-sheets-dlg';
        d.innerHTML = '<form method="dialog"><h3>🟩 구글 시트 연결</h3>' +
          '<label>불러올 시트 주소 (공유: 링크가 있는 모든 사용자)<input name="readUrl" placeholder="https://docs.google.com/spreadsheets/d/…"></label>' +
          '<label>저장할 Apps Script 웹 앱 주소 (선택)<input name="writeUrl" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
          '<details><summary>Apps Script 코드 보기</summary><textarea readonly rows="8"></textarea><button type="button" data-copy>코드 복사</button></details>' +
          '<menu><button value="cancel">취소</button><button value="ok">저장</button></menu></form>';
        document.body.appendChild(d);
        d.querySelector('[name=readUrl]').value = c.readUrl || '';
        d.querySelector('[name=writeUrl]').value = c.writeUrl || '';
        d.querySelector('textarea').value = S.scriptCode();
        d.querySelector('[data-copy]').onclick = () => { try { navigator.clipboard.writeText(S.scriptCode()); } catch {} };
        d.addEventListener('close', () => {
          if (d.returnValue === 'ok') S.config({ readUrl: d.querySelector('[name=readUrl]').value.trim(), writeUrl: d.querySelector('[name=writeUrl]').value.trim() });
          d.remove();
          resolve(conf());
        });
        d.showModal();
      });
    },
  };
  A.sheets = S;
  window.addEventListener('online', () => { S.flush().catch(() => {}); });
})();`;

export const SHEETS_CSS = `.ide-sheets-dlg { max-width: 520px; width: calc(100% - 32px); border: 1px solid #ccd; border-radius: 10px; padding: 16px; }
.ide-sheets-dlg label { display: block; margin: 10px 0; font-size: 14px; }
.ide-sheets-dlg input, .ide-sheets-dlg textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px; font: 13px ui-monospace, monospace; }
.ide-sheets-dlg menu { display: flex; justify-content: flex-end; gap: 8px; padding: 0; margin: 12px 0 0; }`;

// ── 🔳 QR 코드: app.qr (바이트 모드, 버전 1~40, 오류 정정 L/M/Q/H) ──
export const QR_RUNTIME = String.raw`(() => {
  const A = window.__ideApp;
  const ECC = {
    L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const BLOCKS = {
    L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  const FORMAT = { L: 1, M: 0, Q: 3, H: 2 };
  const rawModules = (v) => {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  };
  const dataCodewords = (v, e) => Math.floor(rawModules(v) / 8) - ECC[e][v - 1] * BLOCKS[e][v - 1];
  const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; };
  const divisor = (deg) => {
    const r = Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
    for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = mul(root, 2); }
    return r;
  };
  const remainder = (data, div) => {
    const r = div.map(() => 0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }
    return r;
  };
  const alignPos = (v, size) => {
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2;
    const step = Math.floor((v * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const r = [6];
    for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p);
    return r;
  };
  const encode = (text, opts = {}) => {
    const ecl = FORMAT[opts.ecc] != null ? opts.ecc : 'M';
    const bytes = Array.from(new TextEncoder().encode(String(text ?? '')));
    let ver = 0;
    for (let v = opts.minVersion || 1; v <= 40; v++) {
      const bits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
      if (bits <= dataCodewords(v, ecl) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('QR 코드에 넣기에는 글이 너무 깁니다 (' + bytes.length + '바이트)');
    const cap = dataCodewords(ver, ecl) * 8;
    const bb = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap - bb.length));
    put(0, (8 - (bb.length % 8)) % 8);
    for (let pad = 0xec; bb.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bb.length; i += 8) data.push(parseInt(bb.slice(i, i + 8).join(''), 2));
    // 블록마다 오류 정정 코드를 붙이고 섞는다
    const nb = BLOCKS[ecl][ver - 1], el = ECC[ecl][ver - 1], raw = Math.floor(rawModules(ver) / 8);
    const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb), div = divisor(el);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const d = data.slice(k, k + shortLen - el + (i < nShort ? 0 : 1)); k += d.length;
      const e = remainder(d, div);
      if (i < nShort) d.push(0);
      blocks.push(d.concat(e));
    }
    const cw = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - el || j >= nShort) cw.push(b[i]); });
    // 판 그리기
    const size = ver * 4 + 17;
    const m = Array.from({ length: size }, () => Array(size).fill(false));
    const fn = Array.from({ length: size }, () => Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
    const ap = alignPos(ver, size);
    ap.forEach((ax, i) => ap.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = (mask) => {
      const d = (FORMAT[ecl] << 3) | mask;
      let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const bits = ((d << 10) | r) ^ 0x5412;
      const g = (i) => ((bits >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, g(i));
      set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, g(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, g(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const bits = (ver << 12) | r;
      for (let i = 0; i < 18; i++) { const b = ((bits >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
    }
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < cw.length * 8) { m[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
      }
    }
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      const line = (get) => {
        let s = '';
        for (let i = 0; i < size; i++) s += get(i) ? '1' : '0';
        for (const run of s.match(/0+|1+/g)) if (run.length >= 5) p += run.length - 2;
        const pat = /(?=(00001011101|10111010000))/g;
        p += (s.match(pat) || []).length * 40;
      };
      for (let y = 0; y < size; y++) line((x) => m[y][x]);
      for (let x = 0; x < size; x++) line((y) => m[y][x]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
      for (const row of m) for (const c of row) if (c) dark++;
      const total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    };
    let best = opts.mask != null ? opts.mask : -1;
    if (best < 0) {
      let min = Infinity;
      for (let k = 0; k < 8; k++) { applyMask(k); drawFormat(k); const p = penalty(); if (p < min) { min = p; best = k; } applyMask(k); }
    }
    applyMask(best); drawFormat(best);
    return { version: ver, size, ecc: ecl, mask: best, modules: m };
  };
  const svg = (text, opts = {}) => {
    const q = encode(text, opts), margin = opts.margin ?? 4, n = q.size + margin * 2;
    let d = '';
    q.modules.forEach((row, y) => row.forEach((c, x) => { if (c) d += 'M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z'; }));
    const px = opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '"' + px + ' shape-rendering="crispEdges" role="img" aria-label="QR 코드"><rect width="100%" height="100%" fill="' + (opts.light || '#fff') + '"/><path d="' + d + '" fill="' + (opts.dark || '#000') + '"/></svg>';
  };
  const canvas = (text, opts = {}) => {
    const q = encode(text, opts), margin = opts.margin ?? 4, n = q.size + margin * 2;
    const scale = Math.max(1, Math.floor((opts.size || 256) / n));
    const c = document.createElement('canvas');
    c.width = c.height = n * scale;
    const g = c.getContext('2d');
    g.fillStyle = opts.light || '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = opts.dark || '#000';
    q.modules.forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale); }));
    return c;
  };
  A.qr = {
    encode, svg, canvas,
    render(el, text, opts = {}) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) return null;
      el.innerHTML = '<figure class="ide-qr">' + svg(text, { size: opts.size || 200, ...opts }) + '</figure>';
      const fig = el.firstChild;
      if (opts.caption) { const cap = document.createElement('figcaption'); cap.className = 'ide-qr-caption'; cap.textContent = opts.caption === true ? String(text) : opts.caption; fig.appendChild(cap); }
      return fig.firstChild;
    },
    download(text, filename = 'qr.png', opts = {}) {
      const c = canvas(text, { size: 600, ...opts });
      const a = document.createElement('a');
      a.download = /\.png$/i.test(filename) ? filename : filename + '.png';
      a.href = c.toDataURL('image/png');
      document.body.appendChild(a); a.click(); a.remove();
    },
  };
})();`;

export const QR_CSS = `.ide-qr { display: inline-flex; flex-direction: column; align-items: center; margin: 4px 0; max-width: 100%; }
.ide-qr svg { max-width: 100%; height: auto; }
.ide-qr-caption { margin-top: 4px; max-width: 220px; font-size: 12px; color: #555; word-break: break-all; text-align: center; }`;
