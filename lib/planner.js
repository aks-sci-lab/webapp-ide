// 프로젝트 전체 프롬프트 → 영역별 작업 계획
// AI 가 앱 구조(영역 트리, 영역마다의 기능·프롬프트)를 보고 요청을 영역 단위 지시로 쪼갠다.
import { flatten, isContainer } from '../public/tree.js';
import { memoSection } from './ai.js';

export const PLAN_SYSTEM = `당신은 여러 영역(region)으로 나뉜 웹앱을 총괄하는 리드 개발자입니다.
사용자의 프로젝트 전체 요청을 받아, 어떤 영역을 어떻게 고칠지 영역별 작업 지시로 나눕니다.
- 각 영역은 별도 개발자가 자기 파일(view.html/style.css/script.js)만 고칩니다. 지시는 그 개발자가 혼자 이해할 수 있게 구체적으로 쓰세요.
- 영역 사이에 주고받을 이벤트(app.emit/app.on, 이름은 "영역ID:동작")나 공유 상태(app.set/get)가 필요하면 양쪽 지시에 같은 이름을 적으세요.
- 앱 전체에 걸친 색상·글꼴·변수는 "shared:css"(공통 CSS) 단계로 따로 지시하세요.
- 꼭 필요한 영역만 고르세요. 안쪽 레이아웃이 있는 영역(컨테이너)은 대상이 될 수 없습니다.

## 기능 옮기기·새 영역 (화면 구성을 바꿀 때)
- 영역마다 기능 목록이 [기능ID] 이름 으로 주어집니다. 화면 구성을 바꾸면서 기능을 다른 영역으로 보내야 하면 featureMoves 에 적으세요.
  IDE 가 그 기능의 HTML·CSS·JS 를 AI 없이 그대로 옮기므로, 옮기는 것만을 위해 steps 를 만들 필요는 없습니다. 옮긴 뒤 모양·동작을 고칠 때만 steps 를 쓰세요.
- 새 영역이 필요하면 newRegions 에 id(영문 소문자·숫자·-), title, purpose 를 주세요. IDE 가 최상위에 만들고, layout 과 featureMoves·steps 에서 그 id 를 쓸 수 있습니다.
- 기능을 모두 내보내 비게 되는 영역은 removeRegions 에 넣으면 지워집니다 (남은 스크립트가 있으면 IDE 가 지우지 않습니다).
- 기존 기능을 다시 만들라는 steps 는 쓰지 마세요. 옮기면 됩니다.

## 배치(레이아웃) 변경
- 영역의 위치·크기·좌우/상하 배치는 IDE 의 레이아웃 그리드가 정합니다. 배치를 바꾸려면 반드시 "layout" 필드로 새 좌표를 주세요.
- 배치를 CSS 로 바꾸는 지시(body, html, #app, section, 영역 바깥에 grid/flex/position/width/height 를 주는 것)는 절대 하지 마세요.
- layout 은 "행(rows)" 목록으로 씁니다. 각 행은 height(행 높이, 칸 수)와 cells(왼쪽→오른쪽 칸들)를 가지고,
  칸은 { "id": 영역ID, "width": 너비비율 } 이거나, 한 칸 안에 영역 여러 개를 위아래로 쌓을 때 { "width": 너비비율, "stack": [ { "id", "height" } ] } 입니다.
  너비는 비율이라 합이 12 가 아니어도 IDE 가 맞춰 줍니다. 오버레이 영역을 뺀 최상위 영역을 모두 한 번씩 넣으세요.
  fill=true 이면 앱이 화면 높이를 채우고 영역마다 자기 칸 안에서 스크롤됩니다.
- 배치 변경이 필요 없으면 layout 은 null.

## 기존 코드 보존
- 가져온 앱(전역 shared/app.js 가 있는 앱)은 영역 HTML 의 id·class·name·onclick 을 전역 스크립트가 사용합니다.
  영역 HTML 을 새로 쓰거나 요소를 지우라는 지시는 하지 마세요. 모양은 style.css, 동작 추가는 script.js 로 지시하세요.
반드시 JSON 만 출력합니다.`;

export function buildPlanPrompt({ layout, regions, request, sharedCss, hasAppJs, overlays = new Set(), decisions = '' }) {
  const flow = layout.mode === 'flow';
  const tree = flatten(layout)
    .map(({ region: r, depth }) => {
      const info = regions[r.id] || {};
      const where = depth === 0 && flow ? `${r.y + 1}번째 블록` : `x${r.x} y${r.y} w${r.w} h${r.h}`;
      const head = `${'  '.repeat(depth)}- ${r.id} "${r.title || ''}" (${where})${overlays.has(r.id) ? ' [오버레이: 대화상자만 있어 화면 칸이 필요 없음]' : ''}`;
      if (isContainer(r)) return `${head} [컨테이너: 안쪽 레이아웃]`;
      const feats = info.features?.length ? `\n${'  '.repeat(depth)}  기능: ${info.features.map((f) => (typeof f === 'string' ? f : f.fid ? `[${f.fid}] ${f.name}` : f.name)).join(' / ')}` : '';
      const prompt = info.prompt ? `\n${'  '.repeat(depth)}  마지막 프롬프트: ${info.prompt.replace(/\s+/g, ' ').slice(0, 200)}` : '';
      return `${head}${info.hasCode ? '' : ' (아직 비어 있음)'}${feats}${prompt}`;
    })
    .join('\n');

  return `# 앱
이름: ${layout.name}
${layout.appPrompt ? `설명:\n${layout.appPrompt}\n` : ''}${memoSection(decisions)}레이아웃:${flow ? '가져온 앱 — 지금은 영역이 위에서 아래로만 이어지는 문서 흐름 (layout 을 주면 그리드 배치로 바뀝니다). 기존 로직은 전역 shared/app.js — 직접 수정 불가, 영역 script.js 에서 window.함수명 = ... 로 덮어쓸 수 있음' : `그리드 ${layout.grid.cols}열×${layout.grid.rows}행${layout.grid.fill ? ' (화면 채우기)' : ''}`}
${hasAppJs && !flow ? '전역 스크립트 shared/app.js 가 있습니다 (직접 수정 불가).\n' : ''}
# 영역 구조
${tree || '(영역 없음)'}

# 공통 CSS (shared/global.css) 앞부분
\`\`\`css
${(sharedCss || '').slice(0, 2500) || '/* 비어 있음 */'}
\`\`\`

# 프로젝트 전체 요청
${request}

# 출력 형식 (JSON 만)
{
  "summary": "어떻게 나눠 처리할지 한두 문장",
  "steps": [
    { "target": "영역ID 또는 shared:css", "prompt": "그 영역 개발자에게 줄 구체적 지시" }
  ],
  "newRegions": [ { "id": "new-panel", "title": "새 영역 이름", "purpose": "무엇을 담을지" } ],
  "featureMoves": [ { "feature": "f-1a2b3c", "to": "영역ID 또는 새 영역 id" } ],
  "removeRegions": [ "기능을 모두 내보내 비게 되는 영역ID" ],
  "layout": null 또는 {
    "fill": true,
    "rows": [
      { "height": 1, "cells": [ { "id": "상단영역", "width": 8 }, { "id": "도구영역", "width": 4 } ] },
      { "height": 11, "cells": [ { "id": "왼쪽영역", "width": 3 }, { "width": 9, "stack": [ { "id": "본문영역", "height": 8 }, { "id": "아래영역", "height": 3 } ] } ] }
    ]
  }
}
(위 layout 은 형식 예시입니다. 실제 영역 ID 로 쓰세요.)
실행 순서: newRegions 생성 → featureMoves → removeRegions → layout → steps (공통 CSS 가 필요하면 steps 맨 앞).
layout 에는 removeRegions 를 빼고 newRegions 를 넣은 최상위 영역을 모두 넣으세요. 필요 없는 항목은 빈 배열.`;
}

// 행/칸 형식의 배치 → 12열 그리드 좌표. 빠진 영역은 맨 아래에 한 줄씩 붙인다
const COLS = 12;
export function layoutFromRows(raw, need) {
  const used = new Set();
  const placed = [];
  let y = 0;
  for (const row of Array.isArray(raw.rows) ? raw.rows : []) {
    const cells = (Array.isArray(row?.cells) ? row.cells : [])
      .map((c) => ({
        width: Math.max(0.1, Number(c?.width) || 1),
        items: (Array.isArray(c?.stack) ? c.stack : [c])
          .map((s) => ({ id: String(s?.id || ''), height: Math.max(0.1, Number(s?.height) || 1) }))
          .filter((s) => need.includes(s.id) && !used.has(s.id) && used.add(s.id)),
      }))
      .filter((c) => c.items.length)
      .slice(0, COLS);
    if (!cells.length) continue;
    const h = Math.max(Math.round(Number(row.height)) || 1, ...cells.map((c) => c.items.length));
    const widths = apportion(cells.map((c) => c.width), COLS);
    let x = 0;
    cells.forEach((c, i) => {
      const heights = apportion(c.items.map((s) => s.height), h);
      let yy = y;
      c.items.forEach((s, k) => {
        placed.push({ id: s.id, x, y: yy, w: widths[i], h: heights[k] });
        yy += heights[k];
      });
      x += widths[i];
    });
    y += h;
  }
  const autoAdded = need.filter((id) => !used.has(id));
  for (const id of autoAdded) placed.push({ id, x: 0, y: y++, w: COLS, h: 1 });
  return { cols: COLS, rows: Math.min(Math.max(y, 1), 48), fill: raw.fill !== false, regions: placed, autoAdded };
}

// 비율 → 합이 total 인 정수들 (각 1 이상)
function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map((v) => Math.max(1, Math.floor(v)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; diff > 0; k = (k + 1) % out.length, diff--) out[order[k]]++;
  for (let k = 0; diff < 0 && k < out.length * total; k++) {
    const i = out.indexOf(Math.max(...out));
    if (out[i] > 1) {
      out[i]--;
      diff++;
    }
  }
  return out;
}

// 다중 화면에서 raw layout 이 어느 화면을 대상으로 하는지 판별하고, 다른 화면에서 옮겨온 영역도 허용한다
function extractRawLayoutIds(raw) {
  const ids = [];
  if (Array.isArray(raw?.rows)) {
    for (const row of raw.rows) {
      for (const c of Array.isArray(row?.cells) ? row.cells : []) {
        const list = Array.isArray(c?.stack) ? c.stack : [c];
        for (const s of list) if (s?.id) ids.push(String(s.id));
      }
    }
  } else if (Array.isArray(raw?.regions)) {
    for (const p of raw.regions) if (p?.id) ids.push(String(p.id));
  }
  return [...new Set(ids)];
}

export function resolveMultiScreenTarget(layout, raw) {
  if (!Array.isArray(layout?.screens) || layout.screens.length <= 1) return null;
  const mentioned = extractRawLayoutIds(raw);
  const allKnown = new Set();
  const ownerOf = new Map();
  for (const sc of layout.screens) {
    for (const r of sc.regions || []) {
      allKnown.add(r.id);
      ownerOf.set(r.id, sc.id);
    }
  }
  const counts = new Map();
  for (const id of mentioned) {
    const scId = ownerOf.get(id);
    if (scId) counts.set(scId, (counts.get(scId) || 0) + 1);
  }
  let targetId = raw?.screen && layout.screens.some((s) => s.id === raw.screen) ? raw.screen : '';
  if (!targetId && counts.size) {
    targetId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  if (!targetId) targetId = layout.activeScreen || layout.screens[0].id;
  const targetSc = layout.screens.find((s) => s.id === targetId) || layout.screens[0];
  const existingIds = (targetSc.regions || []).map((r) => r.id);
  const movedIn = mentioned.filter((id) => allKnown.has(id) && !existingIds.includes(id));
  return {
    targetScreen: targetSc.id,
    movedRegions: movedIn,
    virtualLayout: {
      ...layout,
      grid: targetSc.grid || layout.grid,
      regions: [...(targetSc.regions || []), ...movedIn.map((id) => ({ id }))],
    },
  };
}

// AI 가 준 배치(행/칸 형식 또는 좌표 형식)를 검사된 좌표 배치로
export function normalizeLayoutPlan(layout, raw, overlays = new Set()) {
  if (!raw || typeof raw !== 'object') return null;
  const ms = resolveMultiScreenTarget(layout, raw);
  const targetLayout = ms ? ms.virtualLayout : layout;
  const extra = ms ? { targetScreen: ms.targetScreen, movedRegions: ms.movedRegions } : {};
  if (Array.isArray(raw.rows)) {
    const need = targetLayout.regions.filter((r) => !overlays.has(r.id)).map((r) => r.id);
    const conv = layoutFromRows(raw, need);
    const checked = validateLayoutPlan(targetLayout, conv, overlays);
    return checked && { ...checked, ...extra, autoAdded: conv.autoAdded };
  }
  const checked = validateLayoutPlan(targetLayout, raw, overlays);
  return checked && { ...checked, ...extra };
}

// AI 가 준 새 배치가 쓸 수 있는지 검사: 최상위(오버레이 제외) 영역을 모두 한 번씩, 그리드 안, 겹침 없음
export function validateLayoutPlan(layout, raw, overlays = new Set()) {
  if (!raw || typeof raw !== 'object') return null;
  const cols = Math.round(Number(raw.cols));
  const rows = Math.round(Number(raw.rows));
  const out = { cols, rows, fill: raw.fill !== false, regions: [] };
  const fail = (error) => ({ ...out, valid: false, error });
  if (!(cols >= 1 && cols <= 24 && rows >= 1 && rows <= 48)) return fail('그리드 크기가 올바르지 않습니다');
  const need = layout.regions.filter((r) => !overlays.has(r.id)).map((r) => r.id);
  const seen = new Set();
  for (const p of Array.isArray(raw.regions) ? raw.regions : []) {
    const id = String(p.id || '');
    if (overlays.has(id) || !need.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const r = { id, x: Math.round(+p.x), y: Math.round(+p.y), w: Math.round(+p.w), h: Math.round(+p.h) };
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > cols || r.y + r.h > rows) {
      return fail(`${id} 의 좌표가 그리드를 벗어납니다`);
    }
    const hit = out.regions.find((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
    if (hit) return fail(`${id} 와 ${hit.id} 가 겹칩니다`);
    out.regions.push(r);
  }
  const missing = need.filter((id) => !seen.has(id));
  if (missing.length) return fail(`배치에서 빠진 영역: ${missing.join(', ')}`);
  const covered = out.regions.reduce((s, r) => s + r.w * r.h, 0);
  out.emptyCells = cols * rows - covered;
  return { ...out, valid: true };
}

// 쓸 수 없는 배치를 AI 에게 한 번 더 고치게 하는 프롬프트
export function buildLayoutFixPrompt({ layout, bad, overlays, request }) {
  const need = layout.regions.filter((r) => !overlays.has(r.id)).map((r) => `- ${r.id} "${r.title || ''}"`).join('\n');
  return `프로젝트 요청: ${request}

방금 제안한 배치를 쓸 수 없습니다. 이유: ${bad.error}
제안했던 배치: ${JSON.stringify({ cols: bad.cols, rows: bad.rows, fill: bad.fill, regions: bad.regions?.length ? bad.regions : undefined })}

반드시 아래 영역을 모두 정확히 한 번씩 포함하세요 (오버레이 영역은 넣지 마세요):
${need}

고친 배치만 행/칸 형식 JSON 으로 출력:
{ "fill": true, "rows": [ { "height": 1, "cells": [ { "id": "...", "width": 12 } ] }, { "height": 11, "cells": [ { "id": "...", "width": 3 }, { "width": 9, "stack": [ { "id": "...", "height": 8 }, { "id": "...", "height": 3 } ] } ] } ] }`;
}

export function parseLayoutJson(text) {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

// 재구성 후의 최상위 영역 목록 (배치 검사용): 지울 영역은 빼고 새 영역은 넣는다
export function plannedLayout(layout, { newRegions = [], removeRegions = [] } = {}) {
  const gone = new Set(removeRegions);
  return { ...layout, regions: [...layout.regions.filter((r) => !gone.has(r.id)), ...newRegions.map((n) => ({ id: n.id, title: n.title }))] };
}

const asList = (v) => (Array.isArray(v) ? v : []);

// features: Map(기능ID → { region, name }) — 지금 영역들에 있는 기능
export function parsePlan(text, validTargets, { layout, overlays, features = new Map() } = {}) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let plan;
  try {
    plan = JSON.parse(json);
  } catch {
    throw new Error('AI 계획을 해석하지 못했습니다. 다시 시도하세요');
  }
  const steps = (Array.isArray(plan.steps) ? plan.steps : [])
    .map((s) => ({ target: String(s.target || '').trim(), prompt: String(s.prompt || '').trim() }))
    .filter((s) => s.prompt);

  // 새 영역: id 를 규칙에 맞게 다듬고 겹치지 않게
  const taken = new Set(layout ? flatten(layout).map((e) => e.region.id) : []);
  const newRegions = [];
  for (const n of asList(plan.newRegions)) {
    const title = String(n?.title || '').slice(0, 40);
    const purpose = String(n?.purpose || '').slice(0, 300);
    if (!title && !purpose) continue;
    let id = String(n?.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 32) || 'new-region';
    if (taken.has(id)) {
      let k = 2;
      while (taken.has(`${id}-${k}`)) k++;
      id = `${id}-${k}`;
    }
    taken.add(id);
    newRegions.push({ id, from: String(n?.id || ''), title: title || id, purpose, enabled: true });
  }
  // 표기만 다듬은 id(Side Panel → side-panel)는 다른 항목의 참조도 바꾼다. 기존 영역과 겹쳐 바꾼 id 는 참조가 기존 영역을 뜻하므로 그대로
  const existing = new Set(layout ? flatten(layout).map((e) => e.region.id) : []);
  const renamed = new Map(newRegions.filter((n) => n.from && n.from !== n.id && !existing.has(n.from)).map((n) => [n.from, n.id]));
  const newIds = new Set(newRegions.map((n) => n.id));
  const leaves = new Set(layout ? flatten(layout).filter((e) => !isContainer(e.region)).map((e) => e.region.id) : []);
  const fixId = (id) => renamed.get(id) || id;

  // 기능 옮기기
  const seen = new Set();
  const featureMoves = asList(plan.featureMoves).map((m) => {
    const fid = String(m?.feature || m?.fid || '').trim();
    const to = fixId(String(m?.to || '').trim());
    const f = features.get(fid);
    let warn = '';
    if (!f) warn = '없는 기능입니다';
    else if (seen.has(fid)) warn = '같은 기능을 두 번 옮기려 합니다';
    else if (!leaves.has(to) && !newIds.has(to)) warn = '옮겨 갈 영역이 없거나 안쪽 레이아웃이 있는 영역입니다';
    else if (f.region === to) warn = '이미 그 영역에 있습니다';
    seen.add(fid);
    return { feature: fid, from: f?.region || '', to, name: f?.name || fid, valid: !warn, enabled: !warn, warn };
  }).filter((m) => m.feature);

  // 지울 영역: 최상위의 비게 되는 영역만
  const leaving = (id) => [...features.values()].filter((f) => f.region === id);
  const moved = new Set(featureMoves.filter((m) => m.valid).map((m) => m.feature));
  const removeRegions = asList(plan.removeRegions).map((x) => String(x?.id || x || '').trim()).filter(Boolean).map((id) => {
    let warn = '';
    if (!layout?.regions.some((r) => r.id === id)) warn = '최상위 영역만 지울 수 있습니다';
    else if (isContainer(layout.regions.find((r) => r.id === id))) warn = '안쪽 레이아웃이 있는 영역입니다';
    else if (leaving(id).some((f) => !moved.has(f.fid))) warn = '아직 남는 기능이 있어 지우지 않습니다';
    return { id, valid: !warn, enabled: !warn, warn };
  });

  const base = layout && plannedLayout(layout, { newRegions, removeRegions: removeRegions.filter((r) => r.valid).map((r) => r.id) });
  const rawLayout = plan.layout && typeof plan.layout === 'object' ? renameInLayout(plan.layout, fixId) : plan.layout;
  return {
    summary: String(plan.summary || ''),
    steps: steps.map((s0) => {
      const s = { ...s0, target: fixId(s0.target) };
      const valid = validTargets.has(s.target) || newIds.has(s.target);
      // 배치를 CSS 로 바꾸려는 단계는 기본으로 끈다 (배치는 layout 이 담당)
      const warn = LAYOUT_CSS_RE.test(s.prompt) ? '배치를 CSS 로 바꾸려는 지시라 기본으로 껐습니다. 배치는 📐 레이아웃 재배치가 담당합니다' : '';
      return { ...s, valid, enabled: valid && !warn, warn };
    }),
    newRegions: newRegions.map(({ from, ...n }) => n),
    featureMoves,
    removeRegions,
    layout: base ? normalizeLayoutPlan(base, rawLayout, overlays) : null,
    rawLayout: rawLayout || null,
  };
}

// AI 가 쓴 새 영역 id 를 다듬은 id 로 (layout 안의 id 들)
function renameInLayout(raw, fixId) {
  const fix = (c) => (c && typeof c === 'object' ? { ...c, ...(c.id ? { id: fixId(String(c.id)) } : {}), ...(Array.isArray(c.stack) ? { stack: c.stack.map(fix) } : {}) } : c);
  return {
    ...raw,
    ...(Array.isArray(raw.rows) ? { rows: raw.rows.map((r) => ({ ...r, cells: asList(r?.cells).map(fix) })) } : {}),
    ...(Array.isArray(raw.regions) ? { regions: raw.regions.map(fix) } : {}),
  };
}

// 실행할 때 고른 항목에 맞춰 배치를 맞춘다: 빠진 영역은 맨 아래 한 줄씩, 없어진 영역은 뺀다
export function fitLayoutTo(lp, need) {
  const regions = lp.regions.filter((r) => need.includes(r.id));
  let rows = Math.max(1, ...regions.map((r) => r.y + r.h));
  for (const id of need) if (!regions.some((r) => r.id === id)) regions.push({ id, x: 0, y: rows++, w: lp.cols, h: 1 });
  return { ...lp, rows: Math.min(rows, 48), regions };
}

// html/body/#app 에 grid·flex·고정 위치 같은 배치 속성을 주는지
export const LAYOUT_CSS_RE = /(\bbody\b|\bhtml\b|#app\b)[^.;\n]{0,60}(grid-template|display\s*:\s*(grid|flex)|\bgrid\b|position\s*:\s*fixed|좌우|2단|컬럼)/i;

// 새 CSS 가 html/body/#app 에 배치 속성을 새로 넣었는지 (원래 있던 것은 허용)
export function addsLayoutCss(oldCss, newCss) {
  const rules = (css) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<=^|})\s*([^{}]*?)\{([^{}]*)\}/g)]
      .filter((m) => /(^|[\s,])(html|body|#app)(?=[\s,:{]|$)/.test(m[1].trim()))
      .map((m) => m[2])
      .join(';');
  const bad = /grid-template|display\s*:\s*(grid|flex)|position\s*:\s*fixed/i;
  return bad.test(rules(newCss)) && !bad.test(rules(oldCss));
}

export const SHARED_CSS_SYSTEM =`당신은 웹앱의 공통 스타일시트(shared/global.css)를 관리합니다.
이 파일은 모든 영역에 스코프 없이 적용됩니다. 색상·글꼴·간격 같은 CSS 변수(:root)와 전역 기본 스타일 위주로 다루고,
특정 영역 내부 요소는 건드리지 마세요. 요청된 부분만 바꾸고 나머지는 유지하세요.
영역 배치는 IDE 레이아웃이 담당하므로 html, body, #app, section 에 display:grid/flex, grid-template, position, width, height 를 새로 주지 마세요.
설명은 한두 줄, 그 다음 \`\`\`css 코드 블록 하나에 파일 전체를 출력하세요.`;

export function buildSharedCssPrompt({ layout, css, request, projectRequest, decisions = '' }) {
  return `# 앱
이름: ${layout.name}
${layout.appPrompt ? `설명:\n${layout.appPrompt}\n` : ''}${memoSection(decisions)}
# 현재 shared/global.css
\`\`\`css
${css}
\`\`\`
${projectRequest ? `\n# 프로젝트 전체 요청\n${projectRequest}\n` : ''}
# 요청
${request}`;
}
