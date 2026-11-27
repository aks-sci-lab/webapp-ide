// 7단계 가이드 웹앱 제작 워크플로우 엔진 (로컬 CLI · 모든 AI 제공자 공용)
// ① 워크로드 작성 → ② 레이아웃 추천 → ③ 시각적 편집 → ④ 편집된 레이아웃 기반 영역별 프롬프트 분배
// → ⑤ 앱 제작 & 기능 목록 → ⑥ 기능 목록 기반 전수 검증 → ⑦ 이상 없으면 배포
import fs from 'node:fs/promises';
import path from 'node:path';
import { flatten, isContainer } from '../public/tree.js';
import { layoutFromRows } from './planner.js';
import { memoSection } from './ai.js';

const COLORS = ['#5b5bd6', '#12a594', '#8e4ec6', '#f76b15', '#0090ff', '#e5484d', '#46a758', '#d6409f'];

export const DEFAULT_WORKFLOW = {
  step: 1, // 1..7
  workload: '',
  proposed: null, // { summary, regions: [{id, title, purpose, color}], layout, features: [{id, region, name, desc}] }
  distributed: [], // [{ region, prompt }]
  checklist: [], // [{ id, region, name, desc, implemented, verified, note }]
  lastVerifiedAt: null,
  lastVerifyOk: false,
  deployReady: false,
};

export class WorkflowStore {
  constructor(project) {
    this.project = project;
    this.filePath = path.join(project.root, 'workflow.json');
  }

  async read() {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return { ...DEFAULT_WORKFLOW, ...raw };
    } catch {
      return { ...DEFAULT_WORKFLOW };
    }
  }

  async write(patch) {
    const cur = await this.read();
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }
}

export const REFINE_WORKLOAD_SYSTEM = `당신은 친절한 웹앱 기획 도우미입니다.
사용자가 짧게 적은 아이디어를 바탕으로, 바로 웹앱을 제작할 수 있을 만큼 구체적이고 쉬운 한국어 요구사항 목록으로 정리해 주세요.
포함할 내용:
- 앱 목적과 주요 사용자(역할이 여러 개면 화면 분리 제안: 예) 학생 화면 / 교사 화면)
- 필요한 화면 구성과 핵심 기능(번호/글머리표로 깔끔하게)
- 예외 처리·편의 기능(저장, 모바일 최적화, 되돌리기 등)
마크다운 코드블록 없이 바로 복사해 쓸 수 있는 일반 텍스트로만 답하세요.`;

export function buildRefineWorkloadPrompt(rough) {
  return `다음 간단한 아이디어를 웹앱 제작용 요구사항으로 구체화해 주세요:\n\n${rough}`;
}

// ── ② 워크로드 → 멀티 화면 레이아웃 & 초기 기능 목록 추천 프롬프트 ──
export const PROPOSE_LAYOUT_SYSTEM = `당신은 웹앱 아키텍트입니다. 사용자의 워크로드(요구사항)를 분석해 12열 그리드 기반의 화면별 레이아웃 구조와 초기 기능 목록을 설계합니다.
규칙:
- 역할이나 단계가 다른 화면 전환이 필요한 앱(예: 학생 화면 / 교사 화면 / 로그인 화면 / 채점·결과 화면 등)은 반드시 screens 배열에 2~4개의 독립 화면으로 나누어 각 화면마다 별도의 regions 와 layout 을 설계하세요! (단일 화면 앱이면 screens 에 1개만 작성)
- 화면 ID 와 영역 ID 는 영문 소문자·숫자·하이픈만 사용하며, 영역 ID 는 모든 화면 통틀어 중복되지 않게 접두사를 붙이세요 (예: stu-header, stu-main, tea-header, tea-grading).
- 각 화면의 영역은 2~5개 사이로 역할을 명확히 나누세요.
- 각 화면의 layout 은 행(rows) 형식으로 작성: 각 행은 height(행 수)와 cells([{ id, width }] 또는 [{ width, stack: [{ id, height }] }]).
- 해당 화면의 모든 영역을 그 화면의 layout 에 정확히 한 번씩 포함하세요.
- features 에 이 앱이 갖춰야 할 핵심 기능 목록(6~14개)을 각 담당 영역(region)과 함께 작성하세요.
반드시 JSON 만 출력하세요.`;

export function buildProposeLayoutPrompt({ workload, appName = '내 웹앱', decisions = '', feedback = '', currentProposed = null }) {
  const prevScreens = currentProposed?.screens?.length
    ? currentProposed.screens.map((sc) => `  [화면 ${sc.id}: ${sc.title}]\n` + (sc.regions || []).map((r) => `    - ${r.id} (${r.title}): ${r.purpose}`).join('\n')).join('\n')
    : (currentProposed?.regions || []).map((r) => `  - ${r.id} (${r.title}): ${r.purpose}`).join('\n');
  const reviseBlock = feedback && currentProposed
    ? `\n# 이전 AI 추천안\n- 요약: ${currentProposed.summary || ''}\n- 화면 및 영역:\n${prevScreens}\n- 기능:\n${(currentProposed.features || []).map((f) => `  - [${f.region}] ${f.name}: ${f.desc}`).join('\n')}\n\n# 사용자 수정 요청 (반드시 이 피드백을 반영해 수정된 화면·레이아웃·기능 목록을 제시하세요)\n${feedback}\n`
    : feedback
      ? `\n# 사용자 추가 수정 요청\n${feedback}\n`
      : '';
  return `# 앱 이름: ${appName}
${memoSection(decisions)}
# 사용자 워크로드 (요구사항)
${workload}
${reviseBlock}
# 출력 형식 (다른 말 없이 JSON 만)
{
  "summary": "전체 화면 구성과 화면 전환 흐름 설명 한두 문장",
  "screens": [
    {
      "id": "main",
      "title": "메인(학생) 화면",
      "regions": [
        { "id": "main-header", "title": "상단 헤더", "purpose": "앱 제목과 화면 전환·제어 버튼" },
        { "id": "main-body", "title": "메인 작업공간", "purpose": "핵심 인터랙션 및 결과 표시" }
      ],
      "layout": {
        "fill": true,
        "rows": [
          { "height": 1, "cells": [{ "id": "main-header", "width": 12 }] },
          { "height": 11, "cells": [{ "id": "main-body", "width": 12 }] }
        ]
      }
    },
    {
      "id": "admin",
      "title": "관리자(교사) 화면",
      "regions": [
        { "id": "admin-header", "title": "관리 헤더", "purpose": "설정 및 학생 화면 전환" },
        { "id": "admin-panel", "title": "관리 패널", "purpose": "관리·채점·내보내기 기능" }
      ],
      "layout": {
        "fill": true,
        "rows": [
          { "height": 1, "cells": [{ "id": "admin-header", "width": 12 }] },
          { "height": 11, "cells": [{ "id": "admin-panel", "width": 12 }] }
        ]
      }
    }
  ],
  "features": [
    { "region": "main-header", "name": "기능 이름", "desc": "사용자가 무엇을 누르면 어떻게 동작하는지 한 줄" }
  ]
}`;
}

function slugId(raw, taken) {
  let id = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 32) || 'region';
  if (taken.has(id)) {
    let k = 2;
    while (taken.has(`${id}-${k}`)) k++;
    id = `${id}-${k}`;
  }
  taken.add(id);
  return id;
}

export function parseProposeResponse(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('AI 응답에서 레이아웃 추천 JSON 을 찾지 못했습니다');
  const raw = JSON.parse(s.slice(i, j + 1));

  const takenRegs = new Set();
  const takenScrs = new Set();
  const rename = new Map();
  let colorIdx = 0;

  const rawScreens = Array.isArray(raw.screens) && raw.screens.length
    ? raw.screens.slice(0, 6)
    : [{ id: 'main', title: '메인 화면', regions: raw.regions, layout: raw.layout }];

  const screens = [];
  const allRegions = [];
  for (let si = 0; si < rawScreens.length; si++) {
    const sc = rawScreens[si] || {};
    const sid = slugId(sc.id || `screen-${si + 1}`, takenScrs);
    const stitle = String(sc.title || sid).slice(0, 40);
    const scRegs = (Array.isArray(sc.regions) ? sc.regions : []).slice(0, 10).map((r, idx) => {
      const id = slugId(r?.id || `${sid}-region-${idx + 1}`, takenRegs);
      if (r?.id && r.id !== id) rename.set(String(r.id), id);
      const reg = {
        id,
        screen: sid,
        title: String(r?.title || id).slice(0, 40),
        purpose: String(r?.purpose || '').slice(0, 300),
        color: COLORS[colorIdx++ % COLORS.length],
        enabled: true,
      };
      allRegions.push(reg);
      return reg;
    });
    if (!scRegs.length) continue;

    const fixId = (id) => rename.get(String(id || '')) || String(id || '');
    const fixCell = (c) => (c && typeof c === 'object' ? { ...c, ...(c.id ? { id: fixId(c.id) } : {}), ...(Array.isArray(c.stack) ? { stack: c.stack.map(fixCell) } : {}) } : c);
    const rawLayout = sc.layout && typeof sc.layout === 'object'
      ? { ...sc.layout, rows: Array.isArray(sc.layout.rows) ? sc.layout.rows.map((row) => ({ ...row, cells: (row?.cells || []).map(fixCell) })) : [] }
      : { fill: true, rows: scRegs.map((r) => ({ height: Math.max(1, Math.floor(12 / scRegs.length)), cells: [{ id: r.id, width: 12 }] })) };

    const layout = layoutFromRows(rawLayout, scRegs.map((r) => r.id));
    screens.push({ id: sid, title: stitle, enabled: true, layout });
  }
  if (!allRegions.length) throw new Error('추천된 영역이 없습니다');

  const fixId = (id) => rename.get(String(id || '')) || String(id || '');
  const validIds = new Set(allRegions.map((r) => r.id));
  const features = (Array.isArray(raw.features) ? raw.features : [])
    .map((f, idx) => ({
      id: `feat-${idx + 1}`,
      region: validIds.has(fixId(f?.region)) ? fixId(f?.region) : allRegions[0].id,
      name: String(f?.name || `기능 ${idx + 1}`).slice(0, 60),
      desc: String(f?.desc || '').slice(0, 240),
      enabled: true,
      implemented: false,
      verified: false,
      note: '',
    }))
    .filter((f) => f.name);

  return {
    summary: String(raw.summary || '').slice(0, 400),
    screens,
    regions: allRegions,
    layout: screens[0].layout,
    features,
  };
}

// ── ④ 사용자가 편집한 레이아웃 기준 → 영역별 프롬프트 + 기능 목록 분배 ──
export const DISTRIBUTE_PROMPTS_SYSTEM = `당신은 웹앱 리드 개발자입니다.
사용자가 캔버스에서 최종 확정·편집한 레이아웃(각 영역의 ID, 이름, 위치, 크기)과 원래 워크로드를 보고:
1) 각 영역 개발자가 독립적으로 구현할 수 있도록 구체적인 구현 프롬프트(view.html/style.css/script.js 내용, 요소 id, 영역 간 app.emit/on 및 app.set/get 이벤트 이름 통일)를 작성합니다.
2) 검증 단계에서 전수 점검할 최종 기능 체크리스트(checklist)를 영역별로 정리합니다.
반드시 JSON 만 출력하세요.`;

export function buildDistributePrompt({ workload, layout, existingChecklist = [], decisions = '' }) {
  const leaves = flatten(layout).filter((e) => !isContainer(e.region));
  const screensNote = Array.isArray(layout.screens) && layout.screens.length > 1
    ? `\n# 멀티 화면 구성 (화면 전환은 반드시 app.navigate('화면ID') 사용)\n${layout.screens.map((s) => `- ${s.id}: ${s.title || s.id}`).join('\n')}\n`
    : '';
  const regionList = leaves
    .map(({ region: r, screen }) => `- ${r.id}${screen ? ` [화면:${screen}]` : ''} ("${r.title || r.id}", 위치 x=${r.x}, y=${r.y}, 크기 ${r.w}×${r.h}칸)${r.summary ? ` — 메모: ${r.summary}` : ''}`)
    .join('\n');
  const prevFeats = existingChecklist.length
    ? `\n# 참고: 이전 초안 기능 목록\n${existingChecklist.map((f) => `- [${f.region}] ${f.name}: ${f.desc}`).join('\n')}\n`
    : '';
  return `# 앱 이름: ${layout.name}
${memoSection(decisions)}
# 원래 워크로드
${workload}
${screensNote}
# 사용자가 최종 편집·확정한 레이아웃 (${layout.grid.cols}열 × ${layout.grid.rows}행, ${layout.grid.fill ? '화면 채우기' : '스크롤 페이지'})
${regionList}
${prevFeats}
# 출력 형식 (다른 말 없이 JSON 만)
{
  "summary": "영역 간 이벤트 규약 및 분배 요약",
  "prompts": [
    { "region": "실제영역ID", "prompt": "이 영역에 구현할 구체적 요구사항, 주요 요소 id, 주고받을 app.emit/app.on/app.set/app.get 이름" }
  ],
  "checklist": [
    { "region": "실제영역ID", "name": "기능 이름", "desc": "검증할 핵심 동작 한 줄" }
  ]
}`;
}

export function parseDistributeResponse(text, validRegionIds) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('AI 응답에서 프롬프트 분배 JSON 을 찾지 못했습니다');
  const raw = JSON.parse(s.slice(i, j + 1));
  const valid = new Set(validRegionIds);
  const prompts = (Array.isArray(raw.prompts) ? raw.prompts : [])
    .map((p) => ({ region: String(p?.region || '').trim(), prompt: String(p?.prompt || '').trim() }))
    .filter((p) => valid.has(p.region) && p.prompt);
  const checklist = (Array.isArray(raw.checklist) ? raw.checklist : [])
    .map((f, idx) => ({
      id: `feat-${idx + 1}`,
      region: valid.has(String(f?.region || '').trim()) ? String(f.region).trim() : validRegionIds[0] || '',
      name: String(f?.name || `기능 ${idx + 1}`).slice(0, 60),
      desc: String(f?.desc || '').slice(0, 240),
      implemented: false,
      verified: false,
      note: '',
    }))
    .filter((f) => f.region && f.name);
  return { summary: String(raw.summary || ''), prompts, checklist };
}

// ── ⑥ 기능 목록 점검: 실제 영역 코드 + 통합 검증 리포트 + 직접 조작(탐색 점검) 결과와 대조 ──
// 판정은 그 기능이 속한 영역의 문제만 본다 (다른 영역의 실패로 이 기능을 떨어뜨리지 않는다)
export function reconcileChecklist(checklist = [], verifyReport = null, regionFiles = {}) {
  const syntaxByRegion = new Set((verifyReport?.syntaxErrors || []).map((e) => e.region));
  const runtimeByRegion = new Set((verifyReport?.browser?.runtimeErrors || []).map((e) => e.region).filter(Boolean));
  const connErrors = (verifyReport?.connectionIssues || []).filter((c) => c.level === 'error');
  const connRegions = (c) => (Array.isArray(c.regions) ? c.regions : []);
  const tests = verifyReport?.browser?.testResults || [];
  const testRegions = (t) => new Set((t.steps || []).map((st) => st.region).filter(Boolean));
  const explore = verifyReport?.explore && !verifyReport.explore.error ? verifyReport.explore : null;
  const exploreOf = (id) => explore?.regions?.find((r) => r.id === id) || null;

  const next = checklist.map((f) => {
    const files = regionFiles[f.region] || {};
    const implemented = Boolean((files.html || '').trim());
    const hasSyntaxErr = syntaxByRegion.has(f.region);
    const hasRuntimeErr = runtimeByRegion.has(f.region);
    const hasConnErr = connErrors.some((c) => connRegions(c).includes(f.region));
    const myTests = tests.filter((t) => testRegions(t).has(f.region));
    const failedTests = myTests.filter((t) => !t.ok);
    const ex = exploreOf(f.region);
    const exErrors = ex ? ex.errors.length : 0;
    const exReverted = ex ? ex.reloadReverted.length : 0;
    const notes = [];
    if (!implemented) notes.push('마크업 미구현');
    if (hasSyntaxErr) notes.push('문법 오류');
    if (hasRuntimeErr) notes.push('런타임 오류');
    if (hasConnErr) notes.push('이벤트/상태 연결 오류');
    if (failedTests.length) notes.push(`이 영역 시나리오 테스트 실패 ${failedTests.length}건`);
    if (exErrors) notes.push(`직접 조작 중 오류 ${exErrors}건`);
    if (exReverted) notes.push('새로고침하면 처음 화면으로 돌아감');
    if (ex?.deadButtons?.length) notes.push(`눌러도 반응 없는 버튼: ${ex.deadButtons.slice(0, 3).join(', ')}`);
    const verified = Boolean(verifyReport) && implemented && !hasSyntaxErr && !hasRuntimeErr && !hasConnErr && !failedTests.length && !exErrors && !exReverted;
    return { ...f, implemented, verified, note: notes.join(' · ') };
  });

  const deployReady = Boolean(verifyReport?.ok) && (next.length === 0 || next.every((f) => f.implemented && f.verified));
  return { checklist: next, deployReady };
}
