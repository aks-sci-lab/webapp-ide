// 7단계 가이드 워크플로우 UI (프롬프트 중심 · 초보자 친화)
// ① 앱 설명 → ② 레이아웃 추천 → ③ 화면 배치 → ④ 영역별 지시 → ⑤ 앱 제작 → ⑥ 자동 점검 → ⑦ 저장·배포
import { FREE_STYLE_KITS } from './templates.js';

export const WF_STEPS = [
  { n: 1, short: '① 앱 설명', title: '만들고 싶은 앱 설명 작성' },
  { n: 2, short: '② 추천', title: 'AI 레이아웃 · 기능 목록 추천 (수정·거절 가능)' },
  { n: 3, short: '③ 화면 배치', title: '레이아웃 캔버스에서 시각 편집' },
  { n: 4, short: '④ 지시 분배', title: '각 영역별 구현 지시(프롬프트) 분배' },
  { n: 5, short: '⑤ 앱 제작', title: '영역별 앱 제작 & 기능 목록' },
  { n: 6, short: '⑥ 자동 점검', title: '기능 목록 전수 검증' },
  { n: 7, short: '⑦ 저장·배포', title: '파일 저장 및 웹 공유' },
];

export const WORKLOAD_EXAMPLES = [
  {
    id: 'eval',
    label: '📝 수행평가 앱',
    text: '교사용·학생용 AI 수행평가 웹앱.\n- 학생 화면: 평가 계획서 팝업, 단계별 답안 작성, AI 도우미 팝업, 이미지 생성 제한\n- 교사 화면: PIN 인증, 학생 접속 QR 생성, 활동지 업로드 분석, AI 채점 및 PDF 내보내기\n- 모바일 화면에서도 보기 편하게 반응형 지원',
  },
  {
    id: 'poll',
    label: '📊 실시간 설문·투표',
    text: '학급·모임용 간단 설문 및 투표 웹앱.\n- 질문과 보기(최대 6개)를 만들고 바로 투표 진행\n- 결과를 막대 그래프와 비율(%)로 실시간 표시\n- 결과를 JSON/CSV로 저장하거나 초기화 가능',
  },
  {
    id: 'todo',
    label: '📅 일정·할일 관리',
    text: '깔끔한 개인 일정 및 할 일 관리 웹앱.\n- 왼쪽에 카테고리(업무·학습·개인) 필터와 오늘 완료율 표시\n- 메인에 할 일 추가, 우선순위(높음/보통/낮음), 마감일, 체크 완료 기능\n- 브라우저(localStorage)에 자동 저장',
  },
  {
    id: 'quiz',
    label: '🎮 퀴즈 학습 앱',
    text: '객관식·단답형 퀴즈 학습 웹앱.\n- 문제 풀이 화면: 진행률 바, 타이머, 정답/해설 즉시 표시\n- 결과 화면: 총점, 오답 노트 모아보기, 다시 풀기 버튼\n- 문제 편집기에서 새 문제를 추가·수정 가능',
  },
];

export function renderWorkflowPanel({ wf, regions = [], screens = [], styleKit = 'builtin', verifyDataMode = 'mock', verifyUpload = null, busy = false, progress = null, buildLog = '', verifyBriefing = null, layoutPreviewFn, esc }) {
  const step = Number(wf?.step) || 1;
  const checklist = wf?.checklist || [];
  const distributed = wf?.distributed || [];
  const prop = wf?.proposed;

  const macroIdx = step <= 3 ? 1 : step <= 6 ? 2 : 3;
  const macroStepper = `<div class="wf-macro">
    <button type="button" class="wf-macro-btn ${macroIdx === 1 ? 'on' : macroIdx > 1 ? 'done' : ''}" data-wf-step="${prop ? 2 : 1}"><b>①</b> 기획 · 배치</button>
    <span class="wf-macro-arr">→</span>
    <button type="button" class="wf-macro-btn ${macroIdx === 2 ? 'on' : macroIdx > 2 ? 'done' : ''}" data-wf-step="${step >= 4 && step <= 6 ? step : 5}"><b>②</b> 자동 제작 · 수정</button>
    <span class="wf-macro-arr">→</span>
    <button type="button" class="wf-macro-btn ${macroIdx === 3 ? 'on' : ''}" data-wf-step="7"><b>③</b> 저장 · 배포</button>
  </div>`;

  const stepper = `${macroStepper}<div class="wf-stepper pro-only">${WF_STEPS.map((s) =>
    `<button type="button" class="wf-step ${s.n === step ? 'on' : s.n < step ? 'done' : ''}" data-wf-step="${s.n}" title="${esc(s.title)}">${esc(s.short)}</button>`,
  ).join('')}</div>`;

  const progressBox = progress ? `
    <div class="wf-progress">
      <div class="wf-prog-head">
        <b>⏳ ${esc(progress.label || 'AI 작업 중…')}</b>
        <span class="muted">${progress.total ? `${progress.current}/${progress.total}` : ''} · ${progress.elapsedSec || 0}초 경과</span>
        <span class="spacer"></span>
        <button type="button" class="btn tiny danger" id="btnWfAbort">⏹ 작업 중단</button>
      </div>
      ${progress.total ? `<div class="wf-prog-bar"><i style="width:${Math.min(100, Math.round((progress.current / progress.total) * 100))}%"></i></div>` : ''}
    </div>` : '';

  let body = '';
  if (step === 1) {
    body = `
      <div class="wf-card">
        <b>① 만들고 싶은 웹앱을 편하게 설명해 주세요</b>
        <p class="muted small-note">짧게 한두 줄만 적고 <b>🪄 AI로 설명 구체화</b>를 눌러도 되고, 아래 예시를 눌러 바로 시작할 수도 있습니다.</p>
        <div class="wf-examples">
          <span class="muted small-note">💡 예시:</span>
          ${WORKLOAD_EXAMPLES.map((ex) => `<button type="button" class="wf-ex-chip" data-wf-example="${ex.id}" ${busy ? 'disabled' : ''}>${esc(ex.label)}</button>`).join('')}
        </div>
        <div class="wf-examples">
          <span class="muted small-note">🎨 무료 스타일:</span>
          ${FREE_STYLE_KITS.map((k) => `<button type="button" class="wf-ex-chip ${k.id === styleKit ? 'on' : ''}" data-style-kit="${k.id}" title="${esc(k.desc)}" ${busy ? 'disabled' : ''}>${esc(k.name)}</button>`).join('')}
        </div>
        <textarea class="prompt" id="wfWorkload" placeholder="예) 학생들이 퀴즈를 풀고 바로 점수와 오답 노트를 보는 웹앱을 만들고 싶어.&#10;- 학생 화면과 교사 화면을 나눠서 전환할 수 있게 해 줘.">${esc(wf.workload || '')}</textarea>
        ${progressBox}
        <div class="actions" style="flex-wrap:wrap">
          <button type="button" class="btn primary" id="btnWfPropose" ${busy ? 'disabled' : ''}>${busy ? '✨ AI 분석 중…' : '✨ ② AI 레이아웃 추천받기'}</button>
          <button type="button" class="btn" id="btnWfRefine" ${busy ? 'disabled' : ''} title="짧게 적은 아이디어를 AI가 구체적인 앱 기획서로 다듬어 줍니다">🪄 AI로 설명 구체화</button>
          <span class="spacer"></span>
          <span class="muted small-note" id="wfSaveStatus"></span>
        </div>
      </div>`;
  } else if (step === 2) {
    const propScreens = prop
      ? (Array.isArray(prop.screens) && prop.screens.length ? prop.screens : [{ id: 'main', title: '메인 화면', enabled: true, layout: prop.layout }])
      : [];
    const activeScrs = propScreens.filter((sc) => sc.enabled !== false);
    const activeScrIds = new Set(activeScrs.map((sc) => sc.id));
    const activeRegs = (prop?.regions || []).filter((r) => r.enabled !== false && (!r.screen || activeScrIds.has(r.screen)));
    const activeFeats = (prop?.features || []).filter((f) => f.enabled !== false).length;

    const screenPreviewsHtml = propScreens.map((sc, si) => {
      const scRegs = (prop?.regions || []).filter((r) => (r.screen ? r.screen === sc.id : si === 0));
      const scActiveRegs = scRegs.filter((r) => r.enabled !== false);
      const scActiveIds = new Set(scActiveRegs.map((r) => r.id));
      const scPreview = sc.layout
        ? { ...sc.layout, regions: (sc.layout.regions || []).filter((p) => scActiveIds.has(p.id)) }
        : null;
      return `<div class="wf-scr-card ${sc.enabled === false ? 'off' : ''}">
        <div class="wf-scr-head">
          <input type="checkbox" data-wf-scr-on="${si}" ${sc.enabled !== false ? 'checked' : ''} ${busy ? 'disabled' : ''} title="이 화면 포함 여부">
          <span>📄 화면 ${si + 1}:</span>
          <input type="text" class="wf-in-title" style="flex:1;min-width:120px" data-wf-scr-title="${si}" value="${esc(sc.title || sc.id)}" ${busy ? 'disabled' : ''}>
          <span class="muted small-note">영역 ${scActiveRegs.length}개</span>
        </div>
        ${sc.enabled !== false && scPreview && layoutPreviewFn ? layoutPreviewFn(scPreview, scActiveRegs) : ''}
      </div>`;
    }).join('');

    body = `
      <div class="wf-card">
        <b>② AI 추천 화면별 레이아웃 (${activeScrs.length}개 화면) 및 기능 목록</b>
        ${progressBox}
        ${prop ? `
          <p class="plan-summary">${esc(prop.summary || '추천 레이아웃입니다.')}</p>
          <div class="wf-kpi-row">
            <div class="wf-kpi"><b>${activeScrs.length}개</b><span>추천 화면</span></div>
            <div class="wf-kpi"><b>${activeRegs.length}개</b><span>선택된 영역</span></div>
            <div class="wf-kpi"><b>${activeFeats}개</b><span>핵심 기능</span></div>
          </div>
          <div class="wf-scr-grid">${screenPreviewsHtml}</div>
          <details class="wf-fold">
            <summary><b>⚙️ 세부 영역 (${activeRegs.length}/${(prop.regions || []).length}) 직접 수정 · 제외하기</b></summary>
            <ul class="reorg-list wf-edit-list">${(prop.regions || []).map((r, i) => `
              <li class="wf-edit-row ${r.enabled === false ? 'off' : ''}">
                <input type="checkbox" data-wf-reg-on="${i}" ${r.enabled !== false ? 'checked' : ''} ${busy ? 'disabled' : ''} title="이 영역 포함 여부">
                <span class="dot" style="background:${r.color || '#888'}"></span>
                ${propScreens.length > 1 ? `<select class="wf-in-reg" data-wf-reg-scr="${i}" ${busy ? 'disabled' : ''}>${propScreens.map((sc) => `<option value="${esc(sc.id)}" ${(r.screen || propScreens[0].id) === sc.id ? 'selected' : ''}>${esc(sc.title || sc.id)}</option>`).join('')}</select>` : ''}
                <input type="text" class="wf-in-title" data-wf-reg-title="${i}" value="${esc(r.title || '')}" placeholder="영역 이름" ${busy ? 'disabled' : ''}>
                <input type="text" class="wf-in-desc" data-wf-reg-purpose="${i}" value="${esc(r.purpose || '')}" placeholder="영역 역할 설명" ${busy ? 'disabled' : ''}>
              </li>`).join('')}
            </ul>
            <div class="actions">
              <button type="button" class="btn tiny ghost" id="btnWfAddReg" ${busy ? 'disabled' : ''}>+ 영역 추가</button>
              <button type="button" class="btn tiny ghost" id="btnWfAddPropScreen" ${busy ? 'disabled' : ''}>+ 화면 추가</button>
            </div>
          </details>
          <details class="wf-fold">
            <summary><b>📋 추천 기능 목록 (${activeFeats}/${(prop.features || []).length}) 보기 · 편집하기</b></summary>
            <ul class="reorg-list wf-edit-list">${(prop.features || []).map((f, i) => `
              <li class="wf-edit-row ${f.enabled === false ? 'off' : ''}">
                <input type="checkbox" data-wf-feat-on="${i}" ${f.enabled !== false ? 'checked' : ''} ${busy ? 'disabled' : ''} title="이 기능 포함 여부">
                <select class="wf-in-reg" data-wf-feat-reg="${i}" ${busy ? 'disabled' : ''}>${(prop.regions || []).map((r) => `<option value="${esc(r.id)}" ${r.id === f.region ? 'selected' : ''}>${esc(r.title || r.id)}</option>`).join('')}</select>
                <input type="text" class="wf-in-title" data-wf-feat-name="${i}" value="${esc(f.name || '')}" placeholder="기능 이름" ${busy ? 'disabled' : ''}>
                <input type="text" class="wf-in-desc" data-wf-feat-desc="${i}" value="${esc(f.desc || '')}" placeholder="기능 설명" ${busy ? 'disabled' : ''}>
                <button type="button" class="btn tiny ghost" data-wf-prop-fdel="${i}" ${busy ? 'disabled' : ''} title="기능 삭제">✕</button>
              </li>`).join('')}
            </ul>
            <div class="actions"><button type="button" class="btn tiny ghost" id="btnWfAddPropFeat" ${busy ? 'disabled' : ''}>+ 기능 추가</button></div>
          </details>
          <div class="wf-revise-box">
            <input type="text" id="wfReviseFeedback" placeholder="AI에게 수정 요청 (예: 학생용 화면과 교사용 화면을 별도 화면으로 나눠 줘)" ${busy ? 'disabled' : ''}>
            <button type="button" class="btn small" id="btnWfRevise" ${busy ? 'disabled' : ''}>${busy ? '수정 추천 중…' : '💬 수정 반영해 다시 추천'}</button>
          </div>
          <div class="actions" style="flex-wrap:wrap">
            <button type="button" class="btn primary" id="btnWfApplyAndAuto" ${busy || !activeRegs.length ? 'disabled' : ''}>🚀 이대로 끝까지 자동 제작 (반영 → 제작 → 검증)</button>
            <button type="button" class="btn" id="btnWfApplyLayout" ${busy || !activeRegs.length ? 'disabled' : ''}>📐 배치 먼저 직접 편집</button>
            <button type="button" class="btn ghost" id="btnWfSkipProposal" ${busy ? 'disabled' : ''} title="AI 추천을 적용하지 않고 지금 캔버스 배치 그대로 ③ 화면 배치로 이동합니다">⏭ 현재 레이아웃 유지</button>
            <button type="button" class="btn ghost danger" id="btnWfDiscardProposal" ${busy ? 'disabled' : ''}>✕ 버리기</button>
          </div>` : `<p class="muted">아직 추천된 레이아웃이 없습니다. ① 앱 설명에서 추천을 받거나, 바로 ③ 화면 배치에서 직접 그릴 수 있습니다.</p>
          <div class="actions">
            <button type="button" class="btn" data-wf-step="1">← ① 앱 설명으로</button>
            <button type="button" class="btn primary" data-wf-step="3">⏭ 추천 없이 ③ 직접 배치하기</button>
          </div>`}
      </div>`;
  } else if (step === 3) {
    body = `
      <div class="wf-card">
        <b>③ 화면(페이지)별 레이아웃을 시각적으로 편집하세요</b>
        <p class="muted small-note">화면 전환이 필요하면 왼쪽 <b>＋ 화면</b>으로 화면을 추가하고, 각 화면마다 원하는 배치를 편집할 수 있습니다. (현재 화면 ${screens.length || 1}개 · 영역 <b>${regions.length}개</b>)</p>
        <div class="chips">${regions.map((r) => `<span class="chip" style="--c:${r.color || '#888'}">${esc(r.title || r.id)} (${r.w}×${r.h})</span>`).join('') || '<span class="muted">영역 없음</span>'}</div>
        ${progressBox}
        <div class="actions" style="flex-wrap:wrap;margin-top:6px">
          <button type="button" class="btn primary" id="btnWfAutopilot" ${busy || !regions.length ? 'disabled' : ''}>${busy ? '🚀 자동 제작 진행 중…' : '🚀 여기서부터 끝까지 자동 제작 (분배 → 제작 → 검증 → 자동수정)'}</button>
          <button type="button" class="btn" id="btnWfOpenLayout">📐 레이아웃 캔버스 펼치기</button>
          <button type="button" class="btn ghost pro-only" id="btnWfDistribute" ${busy || !regions.length ? 'disabled' : ''}>④ 지시 분배만 먼저</button>
        </div>
      </div>`;
  } else if (step === 4) {
    body = `
      <div class="wf-card">
        <b>④ 각 영역에 분배된 구현 지시(프롬프트)</b>
        <p class="muted small-note">모든 지시는 자동 저장됩니다. 바꾸고 싶은 내용이 있으면 바로 고친 뒤 ⑤ 앱 제작을 시작하세요.</p>
        ${progressBox}
        ${distributed.length ? `<div class="wf-dist-list">${distributed.map((d, i) => `
          <div class="step">
            <div class="step-head"><b>${esc(regions.find((r) => r.id === d.region)?.title || d.region)}</b> <span class="mono muted">#${esc(d.region)}</span></div>
            <textarea rows="3" data-wf-dist="${i}" ${busy ? 'disabled' : ''}>${esc(d.prompt)}</textarea>
          </div>`).join('')}</div>
          <div class="actions" style="flex-wrap:wrap">
            <button type="button" class="btn primary" id="btnWfAutopilotFrom4" ${busy ? 'disabled' : ''}>${busy ? '🚀 자동 제작 중…' : `🚀 끝까지 자동 제작 (${distributed.length}개 영역 제작 → 검증 → 자동수정)`}</button>
            <button type="button" class="btn ghost pro-only" id="btnWfBuildAll" ${busy ? 'disabled' : ''}>⑤ 제작만 실행</button>
            <button type="button" class="btn ghost" id="btnWfDistribute" ${busy ? 'disabled' : ''}>↻ 다시 분배</button>
          </div>` : `<p class="muted">아직 분배된 지시가 없습니다.</p>
          <div class="actions"><button type="button" class="btn primary" id="btnWfDistribute" ${busy ? 'disabled' : ''}>④ 영역별 지시 분배 실행</button></div>`}
      </div>`;
  } else if (step === 5) {
    const implCount = checklist.filter((f) => f.implemented).length;
    const verCount = checklist.filter((f) => f.verified).length;
    body = `
      <div class="wf-card">
        <b>② 앱 제작 현황</b>
        <div class="wf-kpi-row">
          <div class="wf-kpi"><b>${screens.length || 1}개</b><span>화면</span></div>
          <div class="wf-kpi"><b>${implCount}/${checklist.length}</b><span>기능 제작</span></div>
          <div class="wf-kpi"><b>${verCount}/${checklist.length}</b><span>점검 통과</span></div>
        </div>
        ${progressBox}
        ${buildLog ? `<details class="wf-fold" ${busy ? 'open' : ''}><summary>📋 상세 제작 로그 ${busy ? '(진행 중)' : '펼치기'}</summary><pre class="log" id="wfBuildLog" style="margin-top:6px">${buildLog}</pre></details>` : ''}
        <details class="wf-fold">
          <summary><b>기능 목록 (${implCount}/${checklist.length} 제작 완료)</b></summary>
          <ul class="reorg-list" style="margin-top:6px">${checklist.map((f, i) => `
            <li>
              <span>${f.implemented ? '🟢' : '⚪'}</span>
              <span class="badge-soft">${esc(f.region)}</span>
              <b>${esc(f.name)}</b> <span class="muted">${esc(f.desc)}</span>
              <button type="button" class="btn tiny ghost" data-wf-fdel="${i}" title="기능 삭제">✕</button>
            </li>`).join('') || '<li class="muted">기능 목록이 비어 있습니다.</li>'}</ul>
        </details>
        <div class="actions" style="flex-wrap:wrap">
          <button type="button" class="btn small" id="btnWfResumeBuild" ${busy ? 'disabled' : ''} title="중간에 멈췄거나 실패한 영역만 골라 이어서 제작합니다">▶ 멈춘 곳부터 이어서 제작</button>
          <button type="button" class="btn small" id="btnWfOpenPreview">👁 미리보기 열기</button>
          <button type="button" class="btn small ghost" id="btnWfQuickUndo">↩ 방금 전으로 되돌리기</button>
          <button type="button" class="btn small ghost pro-only" id="btnWfAddFeat">+ 기능 추가</button>
          <span class="spacer"></span>
          <button type="button" class="btn primary" id="btnWfVerify" ${busy ? 'disabled' : ''}>${busy ? '🔍 점검 중…' : '🧪 자동 전수 점검 실행'}</button>
        </div>
      </div>`;
  } else if (step === 6) {
    const passed = checklist.filter((f) => f.verified).length;
    const failed = checklist.filter((f) => !f.verified);
    body = `
      <div class="wf-card">
        <b>② 자동 점검 결과 (${passed}/${checklist.length} 통과)</b>
        <div class="wf-kpi-row">
          <div class="wf-kpi"><b style="color:var(--ok)">${passed}개</b><span>정상 통과</span></div>
          <div class="wf-kpi"><b style="color:${failed.length ? 'var(--danger)' : 'var(--ok)'}">${failed.length}개</b><span>확인 필요</span></div>
          <div class="wf-kpi"><b>${wf.deployReady ? '가능' : '대기'}</b><span>배포 준비</span></div>
        </div>
        <div class="wf-examples">
          <span class="muted small-note">📦 검증용 추가 자료:</span>
          <button type="button" class="wf-ex-chip ${verifyDataMode === 'mock' ? 'on' : ''}" data-verify-data="mock" ${busy ? 'disabled' : ''}>🧪 가상 자료 자동 생성</button>
          <button type="button" class="wf-ex-chip ${verifyDataMode === 'upload' ? 'on' : ''}" data-verify-data="upload" ${busy ? 'disabled' : ''}>📎 내 자료 직접 업로드${verifyUpload ? ` (${esc(verifyUpload.name)})` : ''}</button>
          <input type="file" id="verifyDataInput" accept=".txt,.json,.csv,.md,.html,.pdf,.png,.jpg,.jpeg,.webp" hidden>
        </div>
        ${progressBox}
        ${verifyBriefing && !wf.deployReady ? `
          <div class="wf-fold" style="border-color:color-mix(in srgb, var(--danger) 55%, var(--line));background:color-mix(in srgb, var(--danger) 5%, var(--panel))">
            <b class="err">📋 최대 5회 자동 검증 미통과 원인 브리핑</b>
            <p class="small-note muted" style="margin:4px 0">${esc(verifyBriefing.summary)}</p>
            <ul class="reorg-list" style="max-height:20vh;overflow:auto">${(verifyBriefing.reasons || []).map((r) => `
              <li><span class="badge-soft">${esc(r.kind)}</span> <span>${esc(r.text)}</span></li>`).join('')}</ul>
            <div class="actions" style="margin-top:6px">
              <button type="button" class="btn small primary" id="btnWfBriefToSmart" ${busy ? 'disabled' : ''}>💬 이 원인 그대로 AI에게 수정 지시</button>
            </div>
          </div>` : ''}
        <div class="actions" style="flex-wrap:wrap">
          <button type="button" class="btn primary small" id="btnWfVerify" ${busy ? 'disabled' : ''}>${busy ? '🔍 점검 중…' : '🔍 전체 다시 점검'}</button>
          <button type="button" class="btn small" id="btnWfOpenPreview">👁 미리보기 · 화면 찍어 수정</button>
          ${!wf.deployReady ? `<button type="button" class="btn small" id="btnWfAutoHeal" ${busy ? 'disabled' : ''}>🩺 실패 부분 자동 수정</button>` : ''}
          <button type="button" class="btn small ghost pro-only" id="btnWfOpenVerifySess">상세 리포트</button>
        </div>
        ${failed.length ? `<ul class="reorg-list">${failed.map((f) => `
          <li>
            <span class="err">❌</span>
            <span class="badge-soft">${esc(f.region)}</span>
            <b>${esc(f.name)}</b>
            ${f.note ? `<span class="err small-note">(${esc(f.note)})</span>` : `<span class="muted">${esc(f.desc)}</span>`}
          </li>`).join('')}</ul>` : ''}
        ${passed ? `<details class="wf-fold"><summary>✅ 통과한 기능 (${passed}개) 보기</summary>
          <ul class="reorg-list" style="margin-top:6px">${checklist.filter((f) => f.verified).map((f) => `
            <li><span class="ok">✅</span> <span class="badge-soft">${esc(f.region)}</span> <b>${esc(f.name)}</b></li>`).join('')}</ul>
        </details>` : ''}
        ${wf.deployReady ? `
          <div class="wf-fold" style="border-color:color-mix(in srgb, var(--ok) 55%, var(--line));background:color-mix(in srgb, var(--ok) 6%, var(--panel))">
            <b class="ok">✅ 가상 AI 검증을 모두 통과했습니다! 다음 단계를 선택하세요</b>
            <p class="small-note muted" style="margin:4px 0">지금 바로 저장·배포하거나, 새로운 가상 AI 시나리오로 한 번 더 꼼꼼히 검증할 수 있습니다.</p>
            <div class="actions" style="flex-wrap:wrap;margin-top:6px">
              <button type="button" class="btn primary" data-wf-step="7">🚀 지금 바로 저장 · 배포하기</button>
              <button type="button" class="btn" id="btnWfVerifyMore" ${busy ? 'disabled' : ''}>🔍 AI 시나리오 새로 만들어 더 검증하기</button>
              <button type="button" class="btn ghost" id="btnWfOpenPreview">👁 미리보기 확인</button>
            </div>
          </div>` : ''}
      </div>`;
  } else {
    body = `
      <div class="wf-card">
        <b>⑦ 완성된 웹앱 저장 및 공유</b>
        <p class="${wf.deployReady ? 'ok' : 'err'} small-note">${wf.deployReady
          ? '✅ 모든 자동 점검을 통과했습니다. 지금 바로 저장하거나 웹에 공유할 수 있습니다!'
          : '⚠ 아직 ⑥ 자동 점검을 통과하지 않았습니다. 점검 후 저장하는 것을 권장합니다.'}</p>
        <div class="actions" style="flex-wrap:wrap">
          <button type="button" class="btn primary" id="btnWfExportHtml">📦 웹앱 파일로 저장 (index.html)</button>
          <button type="button" class="btn" id="btnWfExportOffline">📦 인터넷 없이 열리는 파일로 저장</button>
          <button type="button" class="btn ghost" id="btnWfOpenFolder">📂 저장된 폴더 열기</button>
        </div>
        <details open><summary><b>🌐 무료 웹 링크로 공유하는 가장 쉬운 방법 (설치·명령어 없음)</b></summary>
          <ol class="small-note muted" style="margin:6px 0 0;padding-left:18px;display:grid;gap:4px">
            <li>위 <b>📦 웹앱 파일로 저장</b>을 누른 뒤 <b>📂 저장된 폴더 열기</b>를 클릭합니다.</li>
            <li>브라우저에서 <a href="https://app.netlify.com/drop" target="_blank" rel="noopener">Netlify Drop (app.netlify.com/drop)</a> 을 엽니다.</li>
            <li>열린 <b>dist 폴더</b>를 통째로 끌어다 놓으면 10초 만에 무료 웹 주소(URL)가 만들어집니다!</li>
          </ol>
        </details>
      </div>`;
  }

  const smartEditBar = step >= 5 ? `
    <div class="wf-smart-box">
      <b>💬 말로 바로 고치기 (레이아웃 · 디자인 · 기능 자동 판별)</b>
      <div class="wf-revise-box" style="border-style:solid">
        <input type="text" id="smartEditInput" placeholder="예) 왼쪽 사이드바 좁혀줘 / 상단 버튼 파란색으로 / 검색창 추가해줘" ${busy ? 'disabled' : ''}>
        <button type="button" class="btn primary small" id="btnSmartEdit" ${busy ? 'disabled' : ''}>${busy ? '처리 중…' : '✨ 자동 적용'}</button>
      </div>
    </div>` : '';

  return `${stepper}${body}${smartEditBar}`;
}
