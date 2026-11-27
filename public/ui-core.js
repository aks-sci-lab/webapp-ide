// 편집기 공용 UI 도구: 서버 호출, 알림(toast), 대화상자, 로그 전송.
// editor.js 와 분리된 패널 모듈(history-panels.js, skills-panel.js 등)이 함께 쓴다.

export const $ = (sel) => document.querySelector(sel);

// ───────────── 서버 통신 ─────────────
export function friendlyError(msg) {
  const s = String(msg || '');
  if (/429|rate limit|quota|한도/i.test(s)) return 'AI 요청 한도에 잠시 도달했습니다. 몇 초 후 다시 시도하거나 ⚙️ 설정에서 다른 AI로 전환해 보세요.';
  if (/503|overloaded|high demand|혼잡/i.test(s)) return 'AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.';
  if (/Failed to fetch|NetworkError/i.test(s)) return '로컬 서버와 연결이 끊어졌습니다. 웹앱제작기를 다시 실행해 주세요.';
  return s;
}

export async function api(method, url, body, signal) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(data.error || res.statusText));
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// toast 오류를 로그에 남길 때 함께 적을 편집기 상태 (editor.js 가 setToastContext 로 연결)
let toastContext = () => ({});
export function setToastContext(fn) {
  toastContext = fn;
}

export function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = 'toast'), 2600);
  if (isErr) clientLog('ui-error', { message: msg, ...toastContext() });
}

// 브라우저 쪽에서 난 일을 서버 로그(logs/<날짜>/events.jsonl)에 남긴다. 같은 내용은 10초에 한 번만
const recentLogs = new Map();
export function clientLog(kind, data = {}) {
  const key = kind + JSON.stringify(data);
  if (Date.now() - (recentLogs.get(key) || 0) < 10000) return;
  recentLogs.set(key, Date.now());
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, ...data }) }).catch(() => {});
}
window.addEventListener('error', (e) => clientLog('editor-error', { message: e.message, at: `${e.filename?.split('/').pop()}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => clientLog('editor-error', { message: String(e.reason?.message || e.reason) }));

// 대화상자 공용 (이전 모달의 close 이벤트가 새 모달을 즉시 닫지 않도록 AbortController 로 리스너 정리)
export function dialog(title, html, okLabel = '저장') {
  const dlg = $('#dlg');
  dlg._abort?.abort();
  if (dlg.open) dlg.close();
  const ac = new AbortController();
  dlg._abort = ac;
  $('#dlgTitle').textContent = title;
  $('#dlgContent').innerHTML = html;
  $('#dlgOk').textContent = okLabel;
  dlg.showModal();
  dlg.returnValue = '';
  // 버튼 제출(submit)로 바로 알고, 그 밖의 닫힘(Esc 등)은 close 이벤트로 안다.
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ac.abort();
      resolve(value === 'ok' ? dlg : null);
    };
    dlg.querySelector('form').addEventListener('submit', (ev) => finish(ev.submitter?.value), { once: true, signal: ac.signal });
    dlg.addEventListener('close', () => finish(dlg.returnValue), { once: true, signal: ac.signal });
  });
}

// 브라우저 기본 confirm()/prompt() 는 일부 환경(앱 내장 브라우저 등)에서 뜨지 않고 바로 취소되므로 페이지 안 대화상자를 쓴다
export async function confirmBox(message, okLabel = '확인') {
  return Boolean(await dialog('확인', `<p class="confirm-msg">${esc(message).replaceAll('\n', '<br>')}</p>`, okLabel));
}

export async function promptBox(title, value = '') {
  const pending = dialog(title, `<input type="text" id="promptBoxInput" value="${esc(value)}" style="width:100%" autocomplete="off">`, '확인');
  const input = $('#promptBoxInput');
  input.focus();
  input.select();
  // 폼 안에서 Enter 를 누르면 첫 버튼(취소)이 눌리므로 직접 확인으로 닫는다
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $('#dlg form').requestSubmit($('#dlgOk'));
    }
  });
  return (await pending) ? input.value : null;
}
