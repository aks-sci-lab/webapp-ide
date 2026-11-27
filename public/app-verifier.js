// 통합 웹앱 검증 모달 & 발견된 문제 AI 수정 연결 모듈

export function buildVerifyFixPrompt(report) {
  const lines = ['앱 통합 검증에서 다음 문제가 발견되었습니다. 각 영역을 수정해 해결해 주세요:'];
  for (const s of report.syntaxErrors || []) {
    lines.push(`- [${s.region} / ${s.file}] 문법 오류: ${s.error}`);
  }
  for (const d of report.duplicateIds || []) {
    lines.push(`- [중복 id] #${d.id} 가 여러 곳(${d.regions.join(', ')})에 중복 사용됨`);
  }
  for (const c of report.connectionIssues || []) {
    lines.push(`- [영역 연결 ${c.level === 'error' ? '오류' : '경고'}] ${c.text}${c.similar?.length ? ` (후보: ${c.similar.join(', ')})` : ''}`);
  }
  for (const l of (report.localCompatibility?.issues || []).filter((i) => i.level === 'error')) {
    lines.push(`- [${l.region} / 로컬 실행 불가] ${l.detail} — ${l.fix}`);
  }
  for (const e of report.browser?.runtimeErrors || []) {
    lines.push(`- [${e.region || '런타임'} 스크립트 오류] ${e.message}`);
  }
  for (const b of report.browser?.blankScreens || []) {
    lines.push(`- [빈 화면 렌더링 오류: ${b.title || b.screen}] ${b.reason} (영역: ${(b.regions || []).join(', ')})`);
  }
  for (const t of (report.browser?.testResults || []).filter((x) => !x.ok)) {
    const failedStep = (t.steps || []).find((s) => !s.ok);
    lines.push(`- [동작 테스트 실패: "${t.name}"] ${failedStep ? `${failedStep.action}(${failedStep.selector}) — ${failedStep.msg}` : '실패'}`);
  }
  return lines.join('\n');
}

export function countVerifyIssues(report) {
  const syntax = (report.syntaxErrors || []).length + (report.duplicateIds || []).length;
  const connErr = (report.connectionIssues || []).filter((i) => i.level === 'error').length;
  const connWarn = (report.connectionIssues || []).filter((i) => i.level === 'warn').length;
  const localErr = (report.localCompatibility?.issues || []).filter((i) => i.level === 'error').length;
  const localWarn = (report.localCompatibility?.issues || []).filter((i) => i.level === 'warn').length;
  const runtime = (report.browser?.runtimeErrors || []).length;
  const blankScreens = (report.browser?.blankScreens || []).length;
  const tests = report.browser?.testResults || [];
  const testFail = tests.filter((t) => !t.ok).length;
  const testPass = tests.filter((t) => t.ok).length;
  const totalErrors = syntax + connErr + localErr + runtime + blankScreens + testFail;
  return { syntax, connErr, connWarn, localErr, localWarn, runtime, blankScreens, testsTotal: tests.length, testPass, testFail, totalErrors };
}

export function renderVerifyReport(report, esc, chip) {
  const c = countVerifyIssues(report);
  const badge = c.totalErrors === 0
    ? `<span class="verify-badge ok">✅ 모든 핵심 검증 통과</span>`
    : `<span class="verify-badge err">❌ 해결할 문제 ${c.totalErrors}건 발견</span>`;

  const mounted = report.browser?.regionsMounted || [];
  return `
    <div class="verify-top">
      ${badge}
      <span class="muted">대상: <b>${esc(report.project || '')}</b> (${report.regions}개 영역)</span>
      <span class="spacer"></span>
      <button type="button" class="btn small" id="btnVerifyRerun">↻ 다시 검증</button>
      <button type="button" class="btn small" id="btnVerifyAutoTests" title="AI 없이 현재 HTML 요소를 분석해 영역별 기본 스모크 테스트를 생성합니다">⚡ 기본 테스트 자동 생성</button>
      <button type="button" class="btn small" id="btnVerifyAiTests" title="AI 가 앱 코드를 분석해 클릭·입력·모달 시나리오 테스트를 생성합니다">🤖 AI 테스트 생성</button>
      ${c.totalErrors > 0 || c.connWarn > 0 ? `<button type="button" class="btn small primary" id="btnVerifyFix">🔧 발견된 문제 AI 수정으로 보내기</button>` : ''}
    </div>

    <div class="usage-total">
      <div><b class="${c.syntax ? 'err' : 'ok'}">${c.syntax}</b><span>문법 · 중복 ID</span></div>
      <div><b class="${c.connErr ? 'err' : c.connWarn ? '' : 'ok'}">${c.connErr}${c.connWarn ? ` (+경고 ${c.connWarn})` : ''}</b><span>영역 연결 오류</span></div>
      <div><b class="${c.runtime ? 'err' : 'ok'}">${c.runtime}</b><span>런타임 JS 오류</span></div>
      <div><b class="${c.testFail ? 'err' : c.testsTotal ? 'ok' : ''}">${c.testPass} / ${c.testsTotal}</b><span>시나리오 테스트</span></div>
      <div><b class="ok">${mounted.filter((m) => m.width > 0 && m.height > 0).length} / ${mounted.length || report.regions}</b><span>렌더링된 영역</span></div>
    </div>

    ${(report.syntaxErrors?.length || report.duplicateIds?.length) ? `
      <div class="q-group error">
        <b>❌ 문법 및 중복 ID (${c.syntax}건)</b>
        ${(report.syntaxErrors || []).map((s) => `<div class="q-item">${chip(s.region)}<span class="mono">${esc(s.file)}</span><span class="err">${esc(s.error)}</span></div>`).join('')}
        ${(report.duplicateIds || []).map((d) => `<div class="q-item"><span class="mono">#${esc(d.id)}</span><span class="err">중복 영역: ${d.regions.map(esc).join(', ')}</span></div>`).join('')}
      </div>` : ''}

    ${report.connectionIssues?.length ? `
      <div class="q-group ${c.connErr ? 'error' : ''}">
        <b>🔗 영역 간 이벤트 · 공유 상태 연결 (${report.connectionIssues.length}건)</b>
        ${report.connectionIssues.map((i) => `<div class="q-item"><span class="${i.level === 'error' ? 'err' : ''}">${i.level === 'error' ? '❌' : '⚠'} ${esc(i.text)}</span>${i.similar?.length ? `<span class="muted">후보: ${i.similar.map(esc).join(', ')}</span>` : ''}</div>`).join('')}
      </div>` : ''}

    ${report.localCompatibility ? `
      <div class="q-group ${report.localCompatibility.canRunLocally ? '' : 'error'}">
        <b>💻 로컬 단독 실행 판정: ${report.localCompatibility.status === 'local-ready' ? '🟢' : report.localCompatibility.status === 'internet-needed' ? '🟡' : '🔴'} ${esc(report.localCompatibility.label)}</b>
        ${(report.localCompatibility.issues || []).map((i) => `<div class="q-item">${chip(i.region)}<span class="${i.level === 'error' ? 'err' : ''}">${i.level === 'error' ? '❌' : '⚠'} ${esc(i.detail)}</span><span class="muted">${esc(i.fix)}</span></div>`).join('') || '<div class="q-item"><span class="ok">✓ 서버 API 의존성 없이 HTML 파일 하나로 로컬에서 바로 실행됩니다.</span></div>'}
      </div>` : ''}

    ${report.browser?.runtimeErrors?.length ? `
      <div class="q-group error">
        <b>💥 브라우저 실행 중 스크립트 오류 (${report.browser.runtimeErrors.length}건)</b>
        ${report.browser.runtimeErrors.map((e) => `<div class="q-item">${e.region ? chip(e.region) : ''}<span class="err mono">${esc(e.message)}</span></div>`).join('')}
      </div>` : ''}

    <div class="q-group">
      <b>🧪 시나리오 동작 테스트 (${c.testPass}/${c.testsTotal} 통과)</b>
      ${(report.browser?.testResults || []).map((t) => `
        <div class="q-item" style="flex-wrap:wrap">
          <b class="${t.ok ? 'ok' : 'err'}">${t.ok ? '✓' : '✗'} ${esc(t.name)}</b>
          <span class="muted">${(t.steps || []).map((s) => `${s.ok ? '✓' : '✗'} ${esc(s.msg)}`).join(' · ')}</span>
        </div>`).join('') || '<p class="muted small-note" style="margin:4px 0">등록된 동작 테스트가 없습니다. 상단 "⚡ 기본 테스트 자동 생성" 또는 "🤖 AI 테스트 생성"을 눌러 추가하세요.</p>'}
    </div>

    ${mounted.length ? `
      <div class="q-group">
        <b>📐 실제 브라우저 영역 렌더링 (${mounted.length}개 영역)</b>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
          ${mounted.map((m) => `<span class="chip">${esc(m.id)}: ${m.width}×${m.height}px</span>`).join('')}
        </div>
      </div>` : ''}
  `;
}

// 최대 N회 자동 검증 후에도 통과하지 못했을 때 사용자에게 쉬운 한국어로 원인을 브리핑
export function buildVerifyFailureBriefing(report, checklist = [], rounds = 5) {
  const reasons = [];
  if (report) {
    for (const s of report.syntaxErrors || []) {
      reasons.push({ kind: '문법 오류', text: `[${s.region}] ${s.file}: ${s.error}` });
    }
    for (const d of report.duplicateIds || []) {
      reasons.push({ kind: '중복 ID', text: `#${d.id} 요소 ID가 여러 영역(${d.regions.join(', ')})에 겹쳐 동작이 충돌합니다.` });
    }
    for (const c of (report.connectionIssues || []).filter((i) => i.level === 'error')) {
      reasons.push({ kind: '영역 연결 불일치', text: c.text });
    }
    for (const l of (report.localCompatibility?.issues || []).filter((i) => i.level === 'error')) {
      reasons.push({ kind: '로컬 실행 불가', text: `[${l.region}] ${l.detail} — ${l.fix}` });
    }
    for (const e of report.browser?.runtimeErrors || []) {
      reasons.push({ kind: '실행 오류', text: `${e.region ? `[${e.region}] ` : ''}${e.message}` });
    }
    for (const b of report.browser?.blankScreens || []) {
      reasons.push({ kind: '빈 화면 오류', text: `"${b.title || b.screen}" 화면이 비어 있습니다 — ${b.reason}` });
    }
    for (const t of (report.browser?.testResults || []).filter((x) => !x.ok)) {
      const fail = (t.steps || []).find((st) => !st.ok);
      reasons.push({ kind: '동작 테스트 실패', text: `"${t.name}" — ${fail ? `${fail.action}(${fail.selector}): ${fail.msg}` : '기대 동작과 다름'}` });
    }
  }
  const unverified = (checklist || []).filter((f) => !f.verified);
  if (!reasons.length && unverified.length) {
    for (const f of unverified.slice(0, 6)) {
      reasons.push({ kind: '미확인 기능', text: `[${f.region}] ${f.name}${f.note ? ` — ${f.note}` : ' (해당 영역 코드 미구현 또는 점검 미통과)'}` });
    }
  }
  if (!reasons.length) {
    reasons.push({ kind: '점검 보류', text: '자동 점검 결과 상세 원인을 특정하지 못했습니다. 미리보기에서 직접 동작을 확인해 주세요.' });
  }
  const summary = `자동 검증·수정을 ${rounds}회 진행했으나 ${reasons.length}건의 원인으로 최종 통과하지 못했습니다.`;
  const fixText = `다음 검증 미통과 원인을 모두 해결해 줘:\n${reasons.slice(0, 8).map((r) => `- [${r.kind}] ${r.text}`).join('\n')}`;
  return { summary, reasons, fixText };
}
