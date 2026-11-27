// 멀티 프로젝트 선택 & 시각 대시보드 (Project Hub)
import { WF_STEPS } from './workflow-panel.js';

function miniGridHtml(p, esc) {
  const cols = Math.max(1, Number(p.grid?.cols) || 12);
  const rows = Math.max(1, Number(p.grid?.rows) || 12);
  const boxes = (p.regions || []).map((r) => {
    const left = (r.x / cols) * 100;
    const top = (r.y / rows) * 100;
    const width = (r.w / cols) * 100;
    const height = (r.h / rows) * 100;
    return `<div class="mini" style="--c:${r.color || '#5b5bd6'};left:${left}%;top:${top}%;width:${width}%;height:${height}%"><span>${esc(r.title || r.id)}</span></div>`;
  }).join('');
  return `<div class="proj-thumb"><div class="minis">${boxes || '<span class="muted small-note" style="padding:8px;display:block">빈 캔버스</span>'}</div></div>`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function renderProjectHub({ current, details = [], query = '', esc }) {
  const q = String(query || '').trim().toLowerCase();
  const list = details.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q));
  const stepLabel = (n) => WF_STEPS.find((s) => s.n === n)?.short || '① 워크로드';

  return `
    <div class="actions" style="margin-bottom:8px">
      <input type="text" id="hubSearch" value="${esc(query)}" placeholder="프로젝트 이름·제목 검색…" style="flex:1;min-width:180px" autocomplete="off">
      <button type="button" class="btn primary small" id="hubNewProj">＋ 새 프로젝트</button>
    </div>
    <div class="proj-grid">
      ${list.map((p) => {
        const isCur = p.name === current;
        return `<div class="proj-card ${isCur ? 'current' : ''}">
          ${miniGridHtml(p, esc)}
          <div class="proj-meta">
            <div class="proj-title-row">
              <b>${esc(p.title || p.name)}</b>
              ${isCur ? '<span class="badge-soft">현재 열림</span>' : ''}
              ${p.deployReady ? '<span class="badge-soft" style="color:var(--ok)">✅ 검증 통과</span>' : ''}
            </div>
            <div class="muted small-note mono">#${esc(p.name)} · 영역 ${p.regionsCount}개 · ${esc(stepLabel(p.workflowStep))}${p.checklistTotal ? ` (${p.checklistVerified}/${p.checklistTotal})` : ''}</div>
            ${p.updatedAt ? `<div class="muted" style="font-size:11px">수정: ${esc(fmtDate(p.updatedAt))}</div>` : ''}
          </div>
          <div class="actions">
            <button type="button" class="btn small ${isCur ? 'ghost' : 'primary'}" data-hub-open="${esc(p.name)}" ${isCur ? 'disabled' : ''}>${isCur ? '열려 있음' : '열기'}</button>
            <a href="/preview?project=${encodeURIComponent(p.name)}" target="_blank" class="btn small ghost" title="현재 작업을 바꾸지 않고 새 창에서 이 프로젝트 미리보기">👁 미리보기 ↗</a>
            <span class="spacer"></span>
            <button type="button" class="btn small ghost" data-hub-clone="${esc(p.name)}" title="이 프로젝트 복제">복제</button>
            <button type="button" class="btn small ghost danger" data-hub-del="${esc(p.name)}" title="이 프로젝트 삭제 (.trash 이동)">삭제</button>
          </div>
        </div>`;
      }).join('') || '<p class="muted">조건에 맞는 프로젝트가 없습니다.</p>'}
    </div>`;
}
