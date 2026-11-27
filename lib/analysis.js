// 코드 분석: (1) 영역 사이 이벤트·공유 상태 연결 지도  (2) 가져온 앱의 전역 app.js 를 영역으로 나누기
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { flatten, isContainer } from '../public/tree.js';

// ── 1. 연결 지도 ─────────────────────────────────────────────
// app.emit('x') / app.on('x') / app.set('k') / app.get('k') / app.on('state:k') 를 문자열 그대로 찾는다
const CALL_RE = /\b(?:app|__ideApp|window\.app)\s*\.\s*(emit|on|off|set|get)\s*\(\s*(['"`])([^'"`]+)\2/g;

// provided: 앱 런타임·스킬이 직접 보내는 이벤트·공유 상태 { events: [], states: [] } — 영역 코드에 보내는 곳이 없어도 오류가 아니다
export function scanConnections(sources, provided = {}) {
  const regions = {};
  for (const [id, js] of Object.entries(sources)) {
    const r = { emits: new Set(), listens: new Set(), sets: new Set(), gets: new Set() };
    for (const m of (js || '').matchAll(CALL_RE)) {
      const [, fn, , name] = m;
      if (fn === 'emit') r.emits.add(name);
      else if (fn === 'on' || fn === 'off') {
        if (name.startsWith('state:')) r.gets.add(name.slice(6));
        else r.listens.add(name);
      } else if (fn === 'set') r.sets.add(name);
      else if (fn === 'get') r.gets.add(name);
    }
    regions[id] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v].sort()]));
  }

  const collect = (key) => {
    const map = new Map();
    for (const [id, r] of Object.entries(regions)) for (const n of r[key]) map.set(n, [...(map.get(n) || []), id]);
    return map;
  };
  const emits = collect('emits');
  const listens = collect('listens');
  const sets = collect('sets');
  const gets = collect('gets');

  const events = [...new Set([...emits.keys(), ...listens.keys()])].sort().map((name) => ({
    name, from: emits.get(name) || [], to: listens.get(name) || [],
  }));
  const states = [...new Set([...sets.keys(), ...gets.keys()])].sort().map((name) => ({
    name, from: sets.get(name) || [], to: gets.get(name) || [],
  }));

  const builtinEvents = new Set(provided.events || []);
  const builtinStates = new Set(provided.states || []);
  const names = [...events.map((e) => e.name), ...states.map((s) => `state:${s.name}`), ...builtinEvents, ...[...builtinStates].map((k) => `state:${k}`)];
  // regions: 이 문제를 고쳐야 할 영역 (오류는 기다리는 쪽, 경고는 보내는 쪽)
  const issues = [];
  for (const e of events) {
    if (builtinEvents.has(e.name)) continue;
    if (e.to.length && !e.from.length) issues.push({ level: 'error', text: `"${e.name}" 이벤트를 ${e.to.join(', ')} 이(가) 기다리지만 아무도 보내지 않습니다`, similar: similar(e.name, names), regions: e.to });
    if (e.from.length && !e.to.length) issues.push({ level: 'warn', text: `"${e.name}" 이벤트를 ${e.from.join(', ')} 이(가) 보내지만 받는 곳이 없습니다`, similar: similar(e.name, names), regions: e.from });
  }
  for (const s of states) {
    if (builtinStates.has(s.name)) continue;
    if (s.to.length && !s.from.length) issues.push({ level: 'error', text: `공유 상태 "${s.name}" 을(를) ${s.to.join(', ')} 이(가) 읽지만 아무도 값을 넣지 않습니다`, similar: similar(`state:${s.name}`, names), regions: s.to });
  }
  return { regions, events, states, issues };
}

// 이름이 비슷한 것 (오타·이름 불일치 추정)
function similar(name, all) {
  const base = name.toLowerCase().replace(/^state:/, '');
  return all
    .filter((n) => n !== name)
    .map((n) => ({ n, d: distance(base, n.toLowerCase().replace(/^state:/, '')) }))
    .filter(({ n, d }) => d <= Math.max(2, Math.floor(base.length / 3)) || n.toLowerCase().includes(base.split(':').pop()) || base.includes(n.toLowerCase().split(':').pop()))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ n }) => n);
}

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ── 2. app.js 나누기 ─────────────────────────────────────────
// 최상위 함수마다: 어느 영역이 쓰는지(onclick 등 마크업, 그 영역 요소의 id), 초기화 때 바로 쓰이는지(옮기면 안 됨)
export function analyzeAppJs(appJs, layout, regionHtml) {
  let ast;
  try {
    ast = acorn.parse(appJs, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
  } catch (e) {
    throw new Error(`app.js 를 해석하지 못했습니다: ${e.message}`);
  }
  const fns = new Map();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      fns.set(node.id.name, { name: node.id.name, start: node.start, end: node.end, lines: appJs.slice(node.start, node.end).split('\n').length, async: node.async, generator: node.generator });
    }
  }

  // 초기화(최상위에서 바로 실행되는 코드)에서 이름이 쓰이는 함수 → 옮기면 실행 순서 때문에 깨진다
  const atInit = new Set();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') continue;
    walk.recursive(node, null, {
      Function() {}, // 함수 안쪽은 나중에 실행되므로 보지 않는다
      // 단, 바로 실행되는 함수 (async () => { ... })() 의 본문은 시작할 때 실행된다
      CallExpression(n, st, c) {
        const callee = n.callee;
        if (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression') c(callee.body, st);
        else c(callee, st, 'Expression');
        for (const a of n.arguments) c(a, st, 'Expression');
      },
      Identifier(n) {
        if (fns.has(n.name)) atInit.add(n.name);
      },
    }, walk.base);
  }

  // 함수끼리 서로 부르는 관계
  const calledBy = new Map();
  const calls = new Map();
  for (const f of fns.values()) {
    const body = ast.body.find((n) => n.start === f.start);
    const out = new Set();
    walk.simple(body, {
      Identifier(n) {
        if (n.name !== f.name && fns.has(n.name)) {
          out.add(n.name);
          calledBy.set(n.name, [...(calledBy.get(n.name) || []), f.name]);
        }
      },
    });
    calls.set(f.name, out);
  }
  // 시작할 때 쓰이는 함수가 부르는 함수도 시작할 때 필요하다 (그 함수가 다시 부르는 것까지)
  const queue = [...atInit];
  while (queue.length) {
    for (const g of calls.get(queue.pop()) || []) {
      if (!atInit.has(g)) {
        atInit.add(g);
        queue.push(g);
      }
    }
  }

  // 영역 마크업이 부르는 함수(onclick 등)와 영역의 id
  const leaves = flatten(layout).filter((e) => !isContainer(e.region)).map((e) => e.region.id);
  const usedBy = new Map();
  const idsOf = {};
  for (const id of leaves) {
    const html = regionHtml[id] || '';
    idsOf[id] = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
    for (const m of html.matchAll(/\son\w+\s*=\s*"([^"]*)"/g)) {
      for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (fns.has(c[1])) usedBy.set(c[1], new Set([...(usedBy.get(c[1]) || []), id]));
    }
  }
  // 함수 본문이 다루는 요소 id 로도 어느 영역 것인지 추정
  const touches = (src, id) => [...idsOf[id]].some((x) => new RegExp(`['"\`#]${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(src));

  return [...fns.values()].map((f) => {
    const src = appJs.slice(f.start, f.end);
    const byMarkup = [...(usedBy.get(f.name) || [])];
    const byIds = leaves.filter((id) => touches(src, id));
    const regions = [...new Set([...byMarkup, ...byIds])];
    let status;
    if (atInit.has(f.name)) status = { ok: false, why: '앱이 시작할 때 바로 쓰여서 옮기면 실행 순서가 깨집니다' };
    else if (!regions.length) status = { ok: false, why: '어느 영역과도 직접 연결되지 않은 공용 함수입니다' };
    else if (regions.length > 1) status = { ok: false, why: `여러 영역이 씁니다 (${regions.join(', ')})` };
    else status = { ok: true, why: `${regions[0]} 영역 전용입니다` };
    return { name: f.name, lines: f.lines, regions, byMarkup, calledBy: [...new Set(calledBy.get(f.name) || [])].slice(0, 8), status, target: status.ok ? regions[0] : null };
  });
}

// 함수 하나를 app.js 에서 떼어 내 영역 script.js 로: 전역 이름은 그대로 유지(window.이름 = function 이름 ...)
export function extractFunction(appJs, name) {
  const ast = acorn.parse(appJs, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
  const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id?.name === name);
  if (!node) throw new Error(`app.js 에 ${name} 함수가 없습니다`);
  const src = appJs.slice(node.start, node.end);
  // "function 이름(" / "async function 이름(" → 함수 표현식으로
  const expr = src.replace(/^(async\s+)?function(\s*\*)?\s+/, (m, a = '', g = '') => `${a || ''}function${g || ''} `);
  // 앞뒤 빈 줄까지 함께 지운다
  let s = node.start;
  let e = node.end;
  while (s > 0 && /[ \t]/.test(appJs[s - 1])) s--;
  if (appJs[e] === '\n') e++;
  return {
    appJs: appJs.slice(0, s) + appJs.slice(e),
    snippet: `/* app.js 에서 옮김: ${name} — 전역 이름은 그대로 (다른 코드·onclick 이 계속 부를 수 있게) */\nwindow.${name} = ${expr};\n`,
  };
}
