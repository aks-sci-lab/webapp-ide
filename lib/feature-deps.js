// 기능 하나가 영역 코드의 어느 부분에 기대고 있는지 분석하고, 다른 영역으로 옮긴다.
//  - CSS: 그 기능의 id·class 만 가리키는 규칙 → 함께 옮김 / 다른 기능과 같이 쓰는 규칙 → 복사 / 영역 자신(:scope) → 남김
//  - JS : 그 기능의 요소만 다루는 문장 → 함께 옮김 / 다른 기능과 얽힌 문장 → 남기고 "다리"(다중 root)로 새 영역 요소도 찾게 함
// AI 를 쓰지 않는 결정적인 방식이라 토큰이 들지 않고, 옮긴 직후에도 그대로 동작한다.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { analyze, removeBlock, insertBlock } from './features.js';

// ── CSS ──────────────────────────────────────────────
// 주석·문자열을 같은 길이의 공백으로 가려 괄호 위치를 정확히 센다
function mask(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
}

// 최상위 단위(규칙 하나, 또는 @media 같은 묶음 하나)로 나눈다: [{ start, end, prelude, inner: [selector...] }]
export function cssUnits(css) {
  const m = mask(css);
  const units = [];
  let i = 0;
  while (i < m.length) {
    const open = m.indexOf('{', i);
    if (open < 0) break;
    let depth = 0;
    let close = -1;
    for (let k = open; k < m.length; k++) {
      if (m[k] === '{') depth++;
      else if (m[k] === '}' && --depth === 0) {
        close = k;
        break;
      }
    }
    if (close < 0) break;
    // 단위의 시작: 앞 단위 끝 다음 (앞의 주석 포함)
    const start = i;
    const prelude = m.slice(i, open).replace(/\s+/g, ' ').trim();
    const body = m.slice(open + 1, close);
    const inner = prelude.startsWith('@')
      ? [...body.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((x) => x[1].trim())
      : [prelude];
    units.push({ start, end: close + 1, prelude, inner, atRule: prelude.startsWith('@') ? prelude.split(/\s/)[0] : '' });
    i = close + 1;
  }
  return units;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (sel, t) => new RegExp(`${t.kind === 'id' ? '#' : '\\.'}${esc(t.name)}(?![\\w-])`).test(sel);

// 선택자 하나가 가리키는 기능들 (id·class·data-feature 로 판단)
function selectorFeatures(sel, features) {
  const out = new Set();
  for (const f of features) {
    if (sel.includes(`data-feature="${f.fid}"`) || f.tokens.some((t) => hasToken(sel, t))) out.add(f.fid);
  }
  return out;
}

// 기능 F 기준으로 CSS 단위를 분류: move | copy | stay
export function classifyCss(css, fid, features) {
  return cssUnits(css).map((u) => {
    if (u.atRule === '@keyframes' || u.atRule === '@font-face' || u.atRule === '@import') {
      // 애니메이션은 옮긴 기능이 쓸 수도 있으니 이름이 쓰이면 복사
      return { ...u, kind: 'stay' };
    }
    const sels = u.inner.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    const sets = sels.map((s) => selectorFeatures(s, features));
    const touchesF = sets.some((s) => s.has(fid));
    const others = sets.some((s) => [...s].some((x) => x !== fid));
    const scopeOnly = sels.every((s) => /^:scope\b/.test(s) && !sets.find((x) => x.size));
    const plainTags = sels.length && sels.every((s) => !/[#.[:]/.test(s.replace(/::?[\w-]+(\([^)]*\))?/g, '')) && !/^:scope\b/.test(s));
    let kind = 'stay';
    if (touchesF && !others && !sels.some((s) => /^:scope\b/.test(s))) kind = 'move';
    else if (touchesF) kind = 'copy';
    else if (plainTags && !scopeOnly) kind = 'copy'; // h2{…} 같은 태그 규칙은 옮긴 기능에도 필요할 수 있어 복사
    return { ...u, kind, selectors: sels };
  });
}

// keyframes 이름이 옮겨 가는 CSS 에서 쓰이면 그 @keyframes 도 복사
function keyframesNeeded(css, units, movedText) {
  return units.filter((u) => u.atRule === '@keyframes' && new RegExp(`\\b${esc(u.prelude.split(/\s+/)[1] || '_')}\\b`).test(movedText)).map((u) => css.slice(u.start, u.end).trim());
}

// ── JS ───────────────────────────────────────────────
const PREFIX = '(function (root, app) {\n';

// 영역 script.js 의 최상위 문장들: [{ start, end, declares:Set, uses:Set, features:Set, events }]
export function jsStatements(js, features) {
  if (!js?.trim()) return [];
  const ast = acorn.parse(`${PREFIX}${js}\n})`, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  const fn = ast.body[0].expression;
  const ids = new Map(); // id 이름 → fid
  const classes = new Map(); // class 이름 → Set(fid)
  for (const f of features) {
    for (const t of f.tokens) {
      if (t.kind === 'id') ids.set(t.name, f.fid);
      else classes.set(t.name, new Set([...(classes.get(t.name) || []), f.fid]));
    }
  }
  const stmts = fn.body.body.map((node) => {
    const st = { start: node.start - PREFIX.length, end: node.end - PREFIX.length, declares: new Set(), uses: new Set(), direct: new Set(), emits: new Set(), listens: new Set() };
    if (node.type === 'FunctionDeclaration' && node.id) st.declares.add(node.id.name);
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) walk.simple(d.id, { Identifier: (n) => st.declares.add(n.name) }, walk.base);
    }
    walk.full(node, (n) => {
      if (n.type === 'Identifier') st.uses.add(n.name);
      if (n.type === 'Literal' && typeof n.value === 'string') {
        const v = n.value;
        for (const m of v.matchAll(/#([\w-]+)/g)) if (ids.has(m[1])) st.direct.add(ids.get(m[1]));
        for (const m of v.matchAll(/\.([\w-]+)/g)) for (const f of classes.get(m[1]) || []) st.direct.add(f);
        for (const m of v.matchAll(/data-feature="?([\w-]+)/g)) st.direct.add(m[1]);
        if (ids.has(v)) st.direct.add(ids.get(v)); // getElementById('x')
        for (const f of classes.get(v) || []) st.direct.add(f); // classList.contains('x')
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.arguments[0]?.type === 'Literal') {
        const name = n.callee.property.name;
        if (name === 'emit') st.emits.add(n.arguments[0].value);
        if (name === 'on') st.listens.add(n.arguments[0].value);
      }
    });
    for (const d of st.declares) st.uses.delete(d);
    return st;
  });
  // 변수를 통해 이어지는 기능: const el = root.querySelector('#a'); el.onclick = … → 두 문장 다 #a 기능
  const declaredBy = new Map();
  stmts.forEach((s, i) => s.declares.forEach((d) => declaredBy.set(d, i)));
  stmts.forEach((s) => (s.features = new Set(s.direct)));
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const s of stmts) {
      for (const u of s.uses) {
        const j = declaredBy.get(u);
        if (j === undefined) continue;
        for (const f of stmts[j].features) if (!s.features.has(f)) (s.features.add(f), (changed = true));
      }
    }
    if (!changed) break;
  }
  return stmts;
}

// 기능 F 를 옮길 때 문장 분류: move(같이 옮김) | bridge(남지만 F 요소를 다룸 → 다중 root 필요) | stay
export function classifyJs(js, fid, features) {
  const stmts = jsStatements(js, features);
  const move = new Set(stmts.map((s, i) => (s.features.size === 1 && s.features.has(fid) ? i : -1)).filter((i) => i >= 0));
  // 옮기는 문장과 남는 문장이 서로의 변수를 쓰면 함께 남긴다 (끊기지 않게)
  const declaredBy = new Map();
  stmts.forEach((s, i) => s.declares.forEach((d) => declaredBy.set(d, i)));
  // 어느 기능도 직접 다루지 않는 변수·함수(let n = 0 등)가 옮기는 문장에서만 쓰이면 같이 옮긴다
  const usersOf = (i) => stmts.map((s, j) => j).filter((j) => j !== i && [...stmts[i].declares].some((d) => stmts[j].uses.has(d)));
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    stmts.forEach((s, i) => {
      if (move.has(i) || s.features.size || !s.declares.size) return;
      const users = usersOf(i);
      if (users.length && users.every((j) => move.has(j))) (move.add(i), (changed = true));
    });
    if (!changed) break;
  }
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const i of [...move]) {
      const usesStaying = [...stmts[i].uses].some((u) => declaredBy.has(u) && !move.has(declaredBy.get(u)));
      const usedByStaying = stmts.some((s, j) => !move.has(j) && [...stmts[i].declares].some((d) => s.uses.has(d)));
      if (usesStaying || usedByStaying) (move.delete(i), (changed = true));
    }
    if (!changed) break;
  }
  return stmts.map((s, i) => ({ ...s, kind: move.has(i) ? 'move' : s.features.has(fid) ? 'bridge' : 'stay' }));
}

// ── 분석·이동 ─────────────────────────────────────────
// 영역의 기능 목록 + 각 기능의 id·class 토큰
export function regionFeatureTokens(html) {
  return analyze(html).blocks.filter((b) => b.fid).map((b) => ({
    fid: b.fid,
    label: b.label,
    tokens: [...b.tokens.ids.map((name) => ({ kind: 'id', name })), ...b.tokens.classes.map((name) => ({ kind: 'class', name }))],
  }));
}

// 기능 하나의 의존 관계 요약 (기능 탭에 보여 주는 것)
export function featureDeps(files, fid) {
  const features = regionFeatureTokens(files.html);
  if (!features.find((f) => f.fid === fid)) return null;
  let css = [];
  let js = [];
  let jsError = '';
  try {
    css = classifyCss(files.css || '', fid, features);
  } catch {}
  try {
    js = classifyJs(files.js || '', fid, features);
  } catch (e) {
    jsError = e.message;
  }
  const pick = (list, kind) => list.filter((x) => x.kind === kind);
  const snippet = (src, x) => src.slice(x.start, x.end).replace(/\s+/g, ' ').trim().slice(0, 90);
  return {
    css: { move: pick(css, 'move').map((u) => u.prelude), copy: pick(css, 'copy').map((u) => u.prelude) },
    js: { move: pick(js, 'move').map((s) => snippet(files.js, s)), bridge: pick(js, 'bridge').map((s) => snippet(files.js, s)), error: jsError },
    events: {
      emits: [...new Set(js.filter((s) => s.features.has(fid)).flatMap((s) => [...s.emits]))],
      listens: [...new Set(js.filter((s) => s.features.has(fid)).flatMap((s) => [...s.listens]))],
    },
  };
}

// 기능을 source 영역에서 target 영역으로 옮긴 결과 파일들을 계산한다 (저장은 호출한 쪽에서)
// linked: 원래 영역 스크립트가 함께 다루던 다른 영역들 { 영역ID: html } (jsRoots). 옮겨 가는 문장이 그 요소를 쓰면 새 영역도 연결해야 한다
export function planMove({ source, target, fid, sourceId, targetId, label, position = 'end', linked = {} }) {
  const features = regionFeatureTokens(source.html);
  const feature = features.find((f) => f.fid === fid);
  if (!feature) throw new Error('옮길 기능을 찾지 못했습니다');
  const { html: srcHtml, block } = removeBlock(source.html, fid);
  const tgtHtml = insertBlock(target.html, block.html, position);
  const name = label || feature.label || fid;

  // CSS
  const units = classifyCss(source.css || '', fid, features);
  const moveUnits = units.filter((u) => u.kind === 'move');
  const copyUnits = units.filter((u) => u.kind === 'copy');
  let srcCss = source.css || '';
  for (const u of [...moveUnits].sort((a, b) => b.start - a.start)) srcCss = srcCss.slice(0, u.start) + srcCss.slice(u.end);
  srcCss = srcCss.replace(/\n{3,}/g, '\n\n');
  const movedCssText = [...moveUnits, ...copyUnits].map((u) => (source.css || '').slice(u.start, u.end).trim()).join('\n');
  const kf = keyframesNeeded(source.css || '', units, movedCssText);
  const addCss = [...moveUnits.map((u) => (source.css || '').slice(u.start, u.end).trim()), ...copyUnits.map((u) => (source.css || '').slice(u.start, u.end).trim()), ...kf];
  const tgtCss = addCss.length
    ? `${(target.css || '').trimEnd()}${target.css?.trim() ? '\n\n' : ''}/* ── 기능 "${name}" (${sourceId} 에서 옮김) ── */\n${addCss.join('\n')}\n`
    : target.css || '';

  // JS
  const stmts = classifyJs(source.js || '', fid, features);
  const moveSt = stmts.filter((s) => s.kind === 'move');
  const bridge = stmts.filter((s) => s.kind === 'bridge');
  let srcJs = source.js || '';
  for (const s of [...moveSt].sort((a, b) => b.start - a.start)) {
    let e = s.end;
    if (srcJs[e] === '\n') e++;
    srcJs = srcJs.slice(0, s.start) + srcJs.slice(e);
  }
  srcJs = srcJs.replace(/\n{3,}/g, '\n\n');
  const movedJs = moveSt.map((s) => (source.js || '').slice(s.start, s.end)).join('\n');
  const tgtJs = movedJs
    ? `${(target.js || '').trimEnd()}${target.js?.trim() ? '\n\n' : ''}/* ── 기능 "${name}" (${sourceId} 에서 옮김) ── */\n${movedJs}\n`
    : target.js || '';

  // 옮겨 가는 문장이 연결된 다른 영역의 요소를 쓰는지 (그 영역 전체를 기능 하나로 보고 찾는다)
  const others = Object.entries(linked)
    .filter(([rid]) => rid !== targetId && rid !== sourceId)
    .map(([rid, html]) => ({
      fid: rid,
      tokens: analyze(html).blocks.filter((b) => b.tokens).flatMap((b) => [...b.tokens.ids.map((name) => ({ kind: 'id', name })), ...b.tokens.classes.map((name) => ({ kind: 'class', name }))]),
    }));
  let targetLinks = [];
  if (movedJs && others.length) {
    try {
      targetLinks = [...new Set(jsStatements(movedJs, others).flatMap((s) => [...s.features]))];
    } catch {}
  }

  return {
    files: { source: { html: srcHtml, css: srcCss, js: srcJs }, target: { html: tgtHtml, css: tgtCss, js: tgtJs } },
    needsBridge: bridge.length > 0,
    targetLinks,
    summary: {
      feature: name,
      css: { move: moveUnits.map((u) => u.prelude), copy: copyUnits.map((u) => u.prelude), keyframes: kf.length },
      js: { move: moveSt.length, bridge: bridge.length },
      events: [...new Set(stmts.filter((s) => s.features.has(fid)).flatMap((s) => [...s.emits, ...s.listens]))],
      sourceEmpty: !analyze(srcHtml).blocks.length,
    },
    targetId,
  };
}
