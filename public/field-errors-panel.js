// 🐞 실사용 오류 창: 내보낸 앱을 학생·동료가 쓰다가 난 오류 기록을 가져와 보고, 해당 영역 자동 수정(Auto-Heal)으로 보낸다.
import { $, api, esc, toast, dialog, confirmBox } from './ui-core.js';

let deps = { heal: async () => {} };

const when = (iso) => {
  try {
    return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

export async function refreshFieldErrorBadge() {
  const btn = $('#btnFieldErrors');
  if (!btn) return;
  try {
    const { active } = await api('GET', '/api/field-errors');
    btn.textContent = active.length ? `🐞 오류 ${active.length}` : '🐞 오류';
    btn.classList.toggle('has-errors', active.length > 0);
  } catch {}
}

async function openFieldErrors() {
  let data = await api('GET', '/api/field-errors');
  const pending = dialog('🐞 실사용 오류 — 내보낸 앱에서 모은 오류', '<div id="feBody"></div>', '닫기');
  $('#dlg').classList.add('wide');
  const draw = () => {
    const fixed = data.all.filter((e) => !data.active.some((a) => a.region === e.region && a.message === e.message));
    $('#feBody').innerHTML = `
      <p class="muted small-note">내보낸 앱은 쓰는 동안 난 오류를 그 컴퓨터의 브라우저에 몰래 적어 둡니다 (학생 화면에는 보이지 않음).
        앱을 연 화면에서 <b>Ctrl+Shift+E</b> 를 누르거나 💾 백업 메뉴의 <b>오류 기록 저장</b>으로 받은 파일, 또는 💾 백업 파일을 여기서 가져오세요.</p>
      <div class="place-ctrl">
        <button type="button" class="btn primary small" data-fe="import">📥 오류 기록 파일 가져오기</button>
        ${data.active.length ? '<button type="button" class="btn small" data-fe="heal">🩺 이 오류들 자동 수정</button>' : ''}
        <span class="spacer"></span>
        ${data.all.length ? '<button type="button" class="btn small danger" data-fe="clear">모두 지우기</button>' : ''}
      </div>
      <input type="file" id="feFile" accept=".json,application/json" hidden>
      <div class="log-list">${data.active.map((e) => `
        <div class="log-row fe-row">
          <span class="chip">${esc(e.region || '앱 전체')}</span>
          <span class="log-text"><span class="err mono">${esc(e.message)}</span><br>
            <span class="muted">${e.count || 1}회 · 처음 ${esc(when(e.first))} · 마지막 ${esc(when(e.last))}${e.screen ? ` · 화면 ${esc(e.screen)}` : ''}${e.recent?.length ? `<br>직전 동작: ${e.recent.map(esc).join(' → ')}` : ''}</span></span>
          <span class="snap-actions"><button type="button" class="btn small" data-fe-del="${esc(e.message)}" data-fe-region="${esc(e.region || '')}">지우기</button></span>
        </div>`).join('') || '<p class="muted" style="padding:8px">열린 오류가 없습니다.</p>'}</div>
      ${fixed.length ? `<details><summary class="muted">고친 오류 ${fixed.length}건 (다시 나면 위로 올라옵니다)</summary>${fixed.map((e) => `<div class="q-item"><span class="chip">${esc(e.region || '앱 전체')}</span><span class="muted mono">${esc(e.message)}</span></div>`).join('')}</details>` : ''}`;
  };
  $('#feBody').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.fe === 'import') return $('#feFile').click();
      if (b.dataset.fe === 'clear') {
        $('#dlg').close();
        if (await confirmBox('가져온 오류 기록을 모두 지울까요?', '지우기')) {
          await api('POST', '/api/field-errors/clear', {});
          toast('오류 기록을 지웠습니다');
        }
        return refreshFieldErrorBadge();
      }
      if (b.dataset.fe === 'heal') {
        $('#dlg').close();
        return deps.heal();
      }
      if (b.dataset.feDel !== undefined) {
        data = await api('POST', '/api/field-errors/clear', { message: b.dataset.feDel, region: b.dataset.feRegion || null });
        draw();
        refreshFieldErrorBadge();
      }
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('#feBody').addEventListener('change', async (ev) => {
    if (ev.target.id !== 'feFile' || !ev.target.files[0]) return;
    try {
      const parsed = JSON.parse(await ev.target.files[0].text());
      data = await api('POST', '/api/field-errors/import', { data: parsed });
      toast(data.added ? `새 오류 ${data.added}종을 가져왔습니다` : '새 오류는 없었습니다 (이미 가져온 기록)');
      draw();
      refreshFieldErrorBadge();
    } catch (e) {
      toast(e instanceof SyntaxError ? 'JSON 파일을 읽지 못했습니다' : e.message, true);
    }
  });
  draw();
  await pending;
  $('#dlg').classList.remove('wide');
}

export function initFieldErrorsPanel(options = {}) {
  deps = { ...deps, ...options };
  $('#btnFieldErrors')?.addEventListener('click', () => openFieldErrors().catch((e) => toast(e.message, true)));
  refreshFieldErrorBadge();
}
