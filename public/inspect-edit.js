// 미리보기 요소 직접 선택(Inspect-to-Edit) 유틸:
// - 선택한 요소 전용 AI 프롬프트 조립
// - AI 없이 style.css 에 안전하게 시각 스타일 규칙 추가/갱신
// - 인스펙터 상단 "🎯 선택된 요소" 카드 렌더링

export function rgbToHex(val, fallback = '#000000') {
  const s = String(val || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return fallback;
  const hex = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

export function pxNumber(val) {
  const m = String(val || '').match(/-?\d+(?:\.\d+)?/);
  return m ? Math.round(Number(m[0])) : '';
}

export function buildElementPrompt(info, request) {
  const req = String(request || '').trim();
  const s = info.styles || {};
  const styleLine = [
    s.color && `color:${s.color}`,
    s.backgroundColor && `background:${s.backgroundColor}`,
    s.fontSize && `font-size:${s.fontSize}`,
    s.padding && `padding:${s.padding}`,
    s.borderRadius && `border-radius:${s.borderRadius}`,
  ].filter(Boolean).join(', ');
  return `[미리보기에서 직접 선택한 요소 수정]
대상 선택자: ${info.selector}
태그/크기: <${info.tag}> (${info.rect?.w || 0}×${info.rect?.h || 0}px)${info.text ? `\n현재 텍스트: "${info.text}"` : ''}
현재 스타일: ${styleLine || '(기본값)'}
현재 마크업 발췌:
\`\`\`html
${info.html || ''}
\`\`\`

요청 사항:
${req}

주의: 이 요소(${info.selector})와 직접 관련된 부분만 자연스럽게 수정하고, 영역의 나머지 기능·레이아웃·id 는 그대로 유지하세요.`;
}

// style.css 끝에 해당 선택자용 마커 블록을 추가하거나 기존 블록을 갱신한다
export function upsertElementStyleRule(css, selector, decls) {
  const entries = Object.entries(decls || {}).filter(([, v]) => String(v ?? '').trim() !== '');
  if (!entries.length) return css || '';
  const body = entries.map(([k, v]) => `  ${k}: ${String(v).trim()};`).join('\n');
  const startMark = `/* @inspect:${selector} */`;
  const endMark = `/* /@inspect:${selector} */`;
  const block = `${startMark}\n${selector} {\n${body}\n}\n${endMark}`;
  const src = String(css || '');
  const sIdx = src.indexOf(startMark);
  const eIdx = sIdx >= 0 ? src.indexOf(endMark, sIdx) : -1;
  if (sIdx >= 0 && eIdx >= 0) {
    return `${src.slice(0, sIdx)}${block}${src.slice(eIdx + endMark.length)}`;
  }
  return `${src.trimEnd()}${src.trim() ? '\n\n' : ''}${block}\n`;
}

export function renderInspectCard(info, busy, esc) {
  if (!info) return '';
  const st = info.styles || {};
  const colorHex = rgbToHex(st.color, '#1f2430');
  const bgHex = rgbToHex(st.backgroundColor, '#ffffff');
  const fontSize = pxNumber(st.fontSize);
  const radius = pxNumber(st.borderRadius);
  const pad = st.padding || '';
  return `<div class="inspect-card" id="inspectCard">
    <div class="inspect-head">
      <span>🎯 <b>선택된 요소</b> <code class="mono">${esc(info.selector)}</code></span>
      <span class="muted">${info.rect?.w || 0}×${info.rect?.h || 0}px</span>
      <span class="spacer"></span>
      <button type="button" class="btn tiny ghost" id="btnClearInspect">해제 ✕</button>
    </div>
    ${info.text ? `<div class="inspect-text muted">"${esc(info.text.slice(0, 80))}"</div>` : ''}
    <div class="inspect-ai-row">
      <input type="text" id="inspectPrompt" placeholder="이 요소만 어떻게 바꿀까요? (예: 더 둥글고 강조색 버튼으로)" autocomplete="off">
      <button type="button" class="btn primary small" id="btnInspectAi" ${busy ? 'disabled' : ''}>⚡ 이 요소 수정</button>
    </div>
    <details class="inspect-quick">
      <summary>🎨 AI 없이 스타일 즉시 조정 <span class="muted">(style.css 반영)</span></summary>
      <div class="inspect-quick-grid">
        <label>글자색 <input type="color" id="iqColor" value="${esc(colorHex)}"></label>
        <label>배경색 <input type="color" id="iqBg" value="${esc(bgHex)}"></label>
        <label>글자(px) <input type="number" id="iqSize" min="8" max="96" value="${esc(fontSize)}"></label>
        <label>둥글기(px) <input type="number" id="iqRadius" min="0" max="999" value="${esc(radius)}"></label>
        <label style="grid-column:1 / -1">여백(padding) <input type="text" id="iqPad" class="mono" value="${esc(pad)}" placeholder="예: 8px 14px"></label>
      </div>
      <div class="actions" style="margin-top:6px">
        <button type="button" class="btn small primary" id="btnApplyQuickStyle">CSS에 즉시 적용</button>
        <span class="muted small-note">변경 시 미리보기에 실시간 반영됩니다</span>
      </div>
    </details>
  </div>`;
}
