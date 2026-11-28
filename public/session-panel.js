// 3대 세션(통합 개발 세션 · 레이아웃 영역별 세션 · 검증 세션) UI 및 자동 수정 루프 헬퍼
import { countVerifyIssues, renderVerifyReport } from './app-verifier.js';

// 실패한 테스트 단계의 선택자에서 소유 영역 ID 를 역추적한다 (DOM 매핑 → data-region → HTML id/class 검색 → 영역 ID 접두사)
function resolveRegionFromStep(step, knownRegionIds = [], regionFiles = null) {
  if (step?.region && knownRegionIds.includes(step.region)) return step.region;
  const sel = String(step?.selector || '');
  if (!sel) return '';
  const dataReg = sel.match(/data-region=["']?([^"'\]]+)["']?/);
  if (dataReg && knownRegionIds.includes(dataReg[1])) return dataReg[1];

  const idMatch = sel.match(/#([A-Za-z0-9_-]+)/);
  const clsMatch = sel.match(/\.([A-Za-z0-9_-]+)/);
  if (regionFiles && typeof regionFiles === 'object') {
    if (idMatch) {
      const idEsc = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\bid\\s*=\\s*["']${idEsc}["']`);
      for (const rid of knownRegionIds) {
        if (re.test(regionFiles[rid]?.html || '')) return rid;
      }
    }
    if (clsMatch) {
      const clsEsc = clsMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${clsEsc}\\b`);
      for (const rid of knownRegionIds) {
        if (re.test(regionFiles[rid]?.html || '')) return rid;
      }
    }
  }
  if (idMatch) {
    const rawId = idMatch[1];
    const sorted = [...knownRegionIds].sort((a, b) => b.length - a.length);
    for (const rid of sorted) {
      if (rawId === rid || rawId.startsWith(`${rid}-`) || rawId.startsWith(`${rid}_`)) return rid;
    }
  }
  return '';
}

// 검증 리포트에서 수리가 필요한 영역별 오류 목록을 추출한다 (Auto-Heal 병렬 수정용)
export function extractFailingRegions(report, knownRegionIds = [], regionFiles = null) {
  const byRegion = new Map();
  const add = (id, msg) => {
    if (!id || !knownRegionIds.includes(id)) return;
    if (!byRegion.has(id)) byRegion.set(id, []);
    const list = byRegion.get(id);
    if (!list.includes(msg)) list.push(msg);
  };

  for (const s of report?.syntaxErrors || []) {
    add(s.region, `${s.file} 문법 오류: ${s.error}`);
  }
  for (const d of report?.duplicateIds || []) {
    for (const rid of d.regions || []) add(rid, `중복 id #${d.id} 를 고유하게 정리하세요`);
  }
  for (const e of report?.browser?.runtimeErrors || []) {
    if (e.region) add(e.region, `브라우저 런타임 오류: ${e.message}`);
  }
  for (const b of report?.browser?.blankScreens || []) {
    for (const rid of b.regions || []) add(rid, `화면 "${b.title || b.screen}"이 빈 화면으로 표시됩니다 (${b.reason}). CSS display/visibility/높이를 확인해 화면에 정상 표시되도록 수정하세요`);
  }
  for (const c of report?.connectionIssues || []) {
    if (c.level !== 'error') continue;
    // 분석기가 고칠 영역을 알려 주면 그 영역만, 예전 보고서면 이름이 정확히 들어 있는 영역만
    const targets = Array.isArray(c.regions) ? c.regions : knownRegionIds.filter((rid) => new RegExp(`(^|[\\s,(])${rid}(?=[\\s,)]|$| 이)`).test(c.text));
    for (const rid of targets) add(rid, `영역 연결 오류: ${c.text}${c.similar?.length ? ` (유사 이름: ${c.similar.join(', ')})` : ''}`);
  }
  for (const l of report?.localCompatibility?.issues || []) {
    if (l.level !== 'error') continue;
    add(l.region, `로컬 단독 실행 불가(${l.detail}): ${l.fix}`);
  }
  for (const t of (report?.browser?.testResults || []).filter((x) => !x.ok && !x.suspect)) {
    const failed = (t.steps || []).find((s) => !s.ok);
    if (!failed) continue;
    const rid = resolveRegionFromStep(failed, knownRegionIds, regionFiles);
    if (rid) add(rid, `동작 테스트 "${t.name}" 실패: ${failed.action}(${failed.selector || ''}) — ${failed.msg}`);
  }
  // 직접 조작(탐색 점검)에서 나온 문제
  const ex = report?.explore && !report.explore.error ? report.explore : null;
  for (const r of ex?.regions || []) {
    for (const e of r.errors || []) add(r.id, `실제로 ${e.when} 했을 때 오류: ${e.message}`);
    for (const v of r.reloadReverted || []) add(r.id, `${v.message} (${v.when} 뒤). 앱 시작 때 저장된 값을 읽어 화면을 다시 그리세요 (공유 상태는 app.on('state:키') 로 받기)`);
    for (const v of r.security || []) add(r.id, `보안 문제: ${v.message}`);
  }
  for (const i of report?.securityIssues || []) add(i.region, `보안 문제: ${i.detail}. ${i.fix}`);
  for (const v of (report?.viewport && !report.viewport.error ? report.viewport.issues : []).filter((x) => x.level === 'error')) add(v.region, `화면 크기 ${v.size}${v.screen ? ` · ${v.screen} 탭` : ''}: ${v.message}`);
  // 내보낸 앱을 실제로 쓰다가 난 오류 (📥 실사용 오류)
  for (const e of report?.fieldErrors || []) {
    add(e.region, `실제 사용 중 오류 ${e.count || 1}회: ${e.message}${e.recent?.length ? ` (직전 동작: ${e.recent.join(' → ')})` : ''}`);
  }
  return byRegion;
}

// 인스펙터 최상단 3대 세션 스위처 바 (다중 영역 세션 지원)
export function renderSessionBar({ mode, selectedRegion, activeSessionKey = '', regionSessions = [], regions = [], busySet = new Set(), verifyRunning = false, verifyReport = null, esc }) {
  const busyCount = busySet.size;
  const totalRegionSessions = regionSessions.length || regions.length;
  const vc = verifyReport ? countVerifyIssues(verifyReport) : null;
  const verifyBadge = verifyRunning
    ? '<span class="sess-badge run">…</span>'
    : vc
      ? vc.totalErrors === 0
        ? '<span class="sess-badge ok">✓</span>'
        : `<span class="sess-badge err">${vc.totalErrors}</span>`
      : '';

  const colorOf = (rid) => regions.find((r) => r.id === rid)?.color || '#888';
  const titleOf = (rid) => regions.find((r) => r.id === rid)?.title || rid;
  const list = regionSessions.length
    ? regionSessions
    : regions.map((r) => ({ key: `region:${r.id}`, regionId: r.id, title: '', isExtra: false, count: 0 }));

  const regionPills = mode === 'region'
    ? `<div class="sess-pills">${list
        .map((s) => {
          const isBusy = busySet.has(s.regionId);
          const curKey = activeSessionKey || (selectedRegion ? `region:${selectedRegion}` : '');
          const on = curKey === s.key;
          const label = s.isExtra ? `${titleOf(s.regionId)} · ${s.title || '세션'}` : titleOf(s.regionId);
          return `<span class="sess-pill-wrap"><button type="button" class="sess-pill ${on ? 'on' : ''} ${isBusy ? 'busy' : ''}" data-pick-session="${esc(s.key)}" data-pick-region="${esc(s.regionId)}" title="${esc(label)}">
            <span class="dot" style="background:${colorOf(s.regionId)}"></span>
            <span>${esc(label)}</span>
            ${s.count ? `<span class="sess-cnt">${s.count}</span>` : ''}
            ${isBusy ? '<span class="sess-spin">⚡</span>' : ''}
          </button>${s.isExtra ? `<button type="button" class="sess-del" data-del-session="${esc(s.key)}" title="이 추가 세션 삭제">✕</button>` : ''}</span>`;
        })
        .join('')}${selectedRegion ? `<button type="button" class="sess-pill sess-add" id="btnAddRegionSession" title="현재 영역에 새 독립 세션 추가">＋ 세션</button>` : ''}</div>`
    : '';

  return `<div class="sess-bar" id="sessionBar">
    <div class="sess-tabs">
      <button type="button" class="sess-tab ${mode === 'integrated' ? 'on' : ''}" data-session-mode="integrated" title="앱 전체 구조·레이아웃·영역 병렬 작업 지시">🧭 통합 세션</button>
      <button type="button" class="sess-tab ${mode === 'region' ? 'on' : ''}" data-session-mode="region" title="개별 레이아웃 영역 전담 개발 세션 (여러 개 생성·전환 가능)">🧩 영역 (${totalRegionSessions})${busyCount ? `<span class="sess-badge run">⚡${busyCount}</span>` : ''}</button>
      <button type="button" class="sess-tab ${mode === 'verify' ? 'on' : ''}" data-session-mode="verify" title="문법·연결·브라우저 런타임·테스트 통합 검증 및 자동 수정">🧪 검증 세션${verifyBadge}</button>
    </div>
    ${regionPills}
  </div>`;
}

// 검증 세션 전용 인스펙터 패널
export function renderVerifySessionPanel({ report, running, healing, healLog, history = [], esc, chip }) {
  const vc = report ? countVerifyIssues(report) : null;
  const hasErrors = Boolean(vc && (vc.totalErrors > 0 || vc.connWarn > 0));
  return `<div class="insp-head proj-head">
      <div class="actions"><b>🧪 검증 세션</b><span class="muted">독립 QA · 자동 복구 루프</span><span class="spacer"></span>
        <button type="button" class="btn small primary" id="btnSessVerifyRun" ${running || healing ? 'disabled' : ''}>${running ? '검증 중…' : '▶ 전체 검증'}</button>
      </div>
      <div class="actions">
        <button type="button" class="btn small" id="btnSessAutoTests" ${running || healing ? 'disabled' : ''}>⚡ 기본 테스트 생성</button>
        <button type="button" class="btn small" id="btnSessAiTests" ${running || healing ? 'disabled' : ''}>🤖 AI 테스트 생성</button>
        <button type="button" class="btn small" id="btnSessQuality" ${running || healing ? 'disabled' : ''}>♿ 접근성 점검</button>
        ${hasErrors ? `<button type="button" class="btn small primary" id="btnSessAutoHeal" ${healing || running ? 'disabled' : ''}>${healing ? '🩺 수정 중…' : '🩺 실패 영역 자동 수정'}</button>` : ''}
      </div>
    </div>
    <div class="tab-body verify-sess-body">
      ${report ? renderVerifyReport(report, esc, chip) : '<p class="muted">상단 <b>▶ 전체 검증</b>을 누르면 문법·중복 ID·영역 간 이벤트 연결·실제 브라우저 런타임·시나리오 테스트를 한 번에 검사합니다.</p>'}
      ${healLog ? `<pre class="log" id="verifyHealLog">${healLog}</pre>` : ''}
      ${history.length ? `<details class="verify-hist"><summary><b>세션 검증 기록</b> <span class="muted">(${history.length}건)</span></summary>
        <ul class="reorg-list">${history.slice(-10).reverse().map((h) => `<li><span class="${h.status === 'ok' ? 'ok' : 'err'}">${h.status === 'ok' ? '✓' : '✗'}</span> <span class="muted mono">${esc((h.ts || '').slice(11, 19))}</span> ${esc(h.summary)}</li>`).join('')}</ul>
      </details>` : ''}
    </div>`;
}
