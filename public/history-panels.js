// 상단 🛠 도구의 🕘 스냅샷(백업·복원 목록)과 📜 로그·사용량 창 (editor.js 에서 분리)
import { $, api, esc, toast, dialog, confirmBox } from './ui-core.js';

export function initHistoryPanels() {
  // ───────────── 스냅샷 ─────────────
  $('#btnSnapshots').addEventListener('click', async () => {
    const pending = dialog('🕘 스냅샷 — 프로젝트 전체 저장·되돌리기', `<div id="snapBody"></div>`, '닫기');
    $('#dlg').classList.add('wide');
    const draw = async () => {
      const { list } = await api('GET', '/api/snapshots');
      $('#snapBody').innerHTML = `
        <p class="muted small-note">레이아웃·모든 영역 파일·공통 파일·프로젝트 프롬프트를 통째로 저장합니다. 계획 실행·나누기·합치기·배치 변경 전에는 자동으로 저장됩니다(최근 40개).
          되돌릴 때는 지금 상태도 먼저 자동 저장되므로 되돌리기를 다시 되돌릴 수 있습니다.</p>
        <div class="place-ctrl"><input id="snapLabel" placeholder="이름 (예: 발표 전 안정 버전)" style="flex:1"><button type="button" class="btn primary small" id="snapSave">지금 저장</button></div>
        <div class="log-list">${list.map((m) => `<div class="log-row snap-row">
            <span class="mono muted">${esc(new Date(m.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>
            <span class="log-type">${m.auto ? '자동' : '직접'}</span>
            <span class="log-text">${esc(m.label)} <span class="muted">· 영역 ${m.regions}개</span></span>
            <span class="snap-actions"><button type="button" class="btn small" data-snap-restore="${m.id}">되돌리기</button>${m.auto ? '' : `<button type="button" class="btn small danger" data-snap-del="${m.id}">삭제</button>`}</span>
          </div>`).join('') || '<p class="muted" style="padding:8px">아직 스냅샷이 없습니다.</p>'}</div>`;
    };
    $('#snapBody').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      try {
        if (b.id === 'snapSave') {
          await api('POST', '/api/snapshots', { label: $('#snapLabel').value || '직접 저장' });
          toast('스냅샷을 저장했습니다');
          return draw();
        }
        if (b.dataset.snapDel) {
          await api('DELETE', `/api/snapshots/${b.dataset.snapDel}`);
          return draw();
        }
        if (b.dataset.snapRestore) {
          $('#dlg').close();
          if (!(await confirmBox('이 스냅샷으로 프로젝트 전체를 되돌릴까요?\n지금 상태는 먼저 자동 저장됩니다.', '되돌리기'))) return;
          const res = await api('POST', `/api/snapshots/${b.dataset.snapRestore}/restore`);
          toast(`"${res.restored.label}" 상태로 되돌렸습니다`);
          setTimeout(() => location.reload(), 700);
        }
      } catch (e) {
        toast(e.message, true);
      }
    });
    await draw();
    await pending;
    $('#dlg').classList.remove('wide');
  });

  // ───────────── 로그 보기 ─────────────
  const LOG_TYPES = {
    '': '전체',
    change: '변경',
    ai: 'AI 호출',
    plan: '계획',
    request: '요청',
    problem: '오류·거부',
    client: '브라우저',
  };

  function logSummary(e) {
    const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);
    switch (e.type) {
      case 'change': {
        if (e.kind === 'region-file' || e.kind === 'shared-file') {
          const target = e.kind === 'region-file' ? `${e.region}/${e.file}` : e.file;
          return `${target}  ${kb(e.bytes[0])} → ${kb(e.bytes[1])}  (+${e.lines.added} −${e.lines.removed}줄)${e.backup ? `  백업: ${e.backup}` : ''}`;
        }
        if (e.kind === 'layout') {
          return ['레이아웃', e.mode && `모드 ${e.mode}`, e.added?.length && `추가 ${e.added.join(', ')}`, e.removed?.length && `삭제 ${e.removed.join(', ')}`,
            e.moved?.length && `이동 ${e.moved.length}개`, e.grid && `그리드 ${e.grid.from?.cols}×${e.grid.from?.rows} → ${e.grid.to?.cols}×${e.grid.to?.rows}`, e.changed && `변경 ${e.changed.join(', ')}`]
            .filter(Boolean).join(' · ');
        }
        if (e.kind === 'region-trash') return `영역 삭제 ${e.region} → ${e.to}`;
        if (e.kind === 'region-rename') return `이름 변경 ${e.from} → ${e.to}`;
        if (e.kind === 'region-restore') return `되돌리기 ${e.region} ← ${e.version}`;
        if (e.kind === 'layout-undo') return `레이아웃 되돌리기 ← ${e.backup}`;
        return e.kind;
      }
      case 'ai':
        return `${e.purpose}${e.region ? ` (${e.region})` : ''} · ${e.provider}/${e.model || '-'} · ${(e.ms / 1000).toFixed(1)}초 · 보냄 ${e.promptChars}자 / 받음 ${e.responseChars}자${e.error ? ` · ❌ ${e.error}` : ''}`;
      case 'plan':
        return `"${(e.request || '').slice(0, 40)}" → ${e.steps?.length || 0}단계${e.layout ? ` · 배치 ${e.layout.valid ? '✓' : `✗ ${e.layout.error}`}` : ''}`;
      case 'request':
        return `${e.via} → ${e.status} (${e.ms}ms)${e.error ? ` · ${e.error}` : ''}`;
      case 'ai-saved':
        return `${e.region} 저장: ${e.files.join(', ')}${e.fromPlan ? ' (계획 실행)' : ''}`;
      case 'ai-rejected':
        return `${e.region} 저장 거부: ${e.reason}${e.lostIds ? ` (${e.lostIds.length}개 id: ${e.lostIds.slice(0, 6).join(', ')}…)` : ''}`;
      case 'error':
        return `${e.where || ''} ${e.region || ''} · ${e.message}`;
      case 'client':
        return `${e.kind}${e.region ? ` [${e.region}]` : ''} · ${e.message || (e.steps ? e.steps.map((s) => `${s.target}:${s.result}`).join(', ') : '')}`;
      default:
        return e.project ? `${e.project}` : '';
    }
  }

  const logGroup = (e) =>
    ['ai-rejected', 'error'].includes(e.type) || (e.type === 'request' && e.status >= 400) || (e.type === 'ai' && e.error) || (e.type === 'client' && /error/.test(e.kind))
      ? 'problem'
      : e.type === 'ai-saved' ? 'ai' : e.type;

  $('#btnLogs').addEventListener('click', async () => {
    let info;
    try {
      info = await api('GET', '/api/logs');
    } catch (e) {
      return toast(e.message, true);
    }
    const view = { day: info.days[0] || '', type: '', events: [] };
    const pending = dialog('📜 로그', `<div id="logBody"></div>`, '닫기');
    $('#dlg').classList.add('wide');
    const load = async () => {
      view.events = view.day ? (await api('GET', `/api/logs/day/${view.day}?limit=1000`)).events : [];
      draw();
    };
    const draw = () => {
      const list = view.events.filter((e) => !view.type || logGroup(e) === view.type).reverse();
      $('#logBody').innerHTML = `
        <p class="muted small-note">${info.enabled ? '기록 중' : '⚠ 기록이 꺼져 있습니다 (⚙️ 설정에서 켜기)'} · 보관 ${info.keepDays || 30}일 · 폴더: <span class="mono">${esc(info.dir)}</span><br>
          문제를 분석할 때 이 폴더(날짜별 events.jsonl 과 ai/ 아래 원문 파일)를 그대로 전달하면 됩니다. API 키는 기록되지 않습니다.</p>
        <div class="place-ctrl">
          <label>날짜 <select id="logDay">${info.days.map((d) => `<option ${d === view.day ? 'selected' : ''}>${d}</option>`).join('') || '<option value="">(기록 없음)</option>'}</select></label>
          <label>종류 <select id="logType">${Object.entries(LOG_TYPES).map(([k, v]) => `<option value="${k}" ${k === view.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <span class="spacer"></span><span class="muted">${list.length}건 (최근 순)</span>
          <button type="button" class="btn small" id="logAnalyze">🔎 분석 요약</button>
          <button type="button" class="btn small" id="logUsage">📊 사용량</button>
          <a class="btn small" id="logExport" href="/api/logs/export/${encodeURIComponent(view.day)}" download>📥 내보내기</a>
          <button type="button" class="btn small" id="logRefresh">↻</button>
        </div>
        <div class="log-list">${list.map((e) => `<div class="log-row ${logGroup(e)}">
            <span class="mono muted">${esc(new Date(e.ts).toLocaleTimeString('ko-KR'))}</span>
            <span class="log-type">${esc(e.type === 'change' ? '변경' : e.type)}</span>
            <span class="log-text">${esc(logSummary(e))}${e.project && e.type !== 'project-open' ? ` <span class="muted">· ${esc(e.project)}</span>` : ''}</span>
            ${e.type === 'ai' && e.file ? `<button type="button" class="btn small" data-ai-file="${esc(e.file)}">원문</button>` : ''}
          </div>`).join('') || '<p class="muted">기록이 없습니다.</p>'}</div>`;
    };
    $('#logBody').addEventListener('change', (ev) => {
      if (ev.target.id === 'logDay') {
        view.day = ev.target.value;
        load();
      }
      if (ev.target.id === 'logType') {
        view.type = ev.target.value;
        draw();
      }
    });
    $('#logBody').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.id === 'logRefresh') return load();
      if (b.id === 'logBack') return draw();
      if (b.id === 'logUsage' || b.dataset.usageDays) return drawUsage(Number(b.dataset.usageDays) || 30);
      if (b.id === 'logAnalyze' && view.day) {
        const s = await api('GET', `/api/logs/summary/${encodeURIComponent(view.day)}`);
        $('#logBody').innerHTML = `
          <div class="place-ctrl"><button type="button" class="btn small" id="logBack">← 로그 목록</button><b>🔎 ${esc(s.day)} 개발 로그 분석 요약</b><span class="spacer"></span><a class="btn small" href="/api/logs/export/${encodeURIComponent(s.day)}" download>📥 JSONL 내보내기</a></div>
          <div class="wf-kpi-row" style="margin:8px 0">
            <div class="wf-kpi"><b>${s.total}건</b><span>전체 기록</span></div>
            <div class="wf-kpi"><b style="color:${s.errorCount ? 'var(--danger)' : 'var(--ok)'}">${s.errorCount}건</b><span>오류 · 거부</span></div>
            <div class="wf-kpi"><b>${s.byType.ai || 0}회</b><span>AI 호출</span></div>
          </div>
          <h4>종류별 이벤트</h4>
          <div class="chips" style="margin-bottom:8px">${Object.entries(s.byType).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join('')}</div>
          <h4>최근 오류 · 실패 (${s.recentErrors.length}건)</h4>
          <div class="log-list" style="max-height:18vh">${s.recentErrors.map((e) => `<div class="log-row problem"><span class="mono muted">${esc(new Date(e.ts).toLocaleTimeString('ko-KR'))}</span><span class="log-type">${esc(e.via || e.type)}</span><span class="log-text">${esc(e.message)}</span></div>`).join('') || '<p class="ok small-note">✓ 기록된 오류가 없습니다</p>'}</div>
          <h4>가장 오래 걸린 작업 TOP 10</h4>
          <div class="log-list" style="max-height:18vh">${s.slowest.map((x) => `<div class="log-row"><span class="mono">${(x.ms / 1000).toFixed(2)}초</span><span class="log-type">${esc(x.type)}</span><span class="log-text mono">${esc(x.label)}</span></div>`).join('') || '<p class="muted small-note">기록 없음</p>'}</div>
          <h4>자주 쓴 UI 기능 TOP 15</h4>
          <div class="chips">${s.topActions.map((a) => `<span class="chip">${esc(a.action)} (${a.count})</span>`).join('') || '<span class="muted small-note">기록 없음</span>'}</div>`;
        return;
      }
      if (b.id === 'savePrices') {
        const prices = {};
        document.querySelectorAll('[data-price-model]').forEach((el) => {
          const p = (prices[el.dataset.priceModel] ||= { in: 0, out: 0 });
          p[el.dataset.priceKind] = Number(el.value) || 0;
        });
        await api('PUT', '/api/settings', { prices });
        toast('가격을 저장했습니다');
        return drawUsage(Number(b.dataset.days) || 30);
      }
      if (b.dataset.aiFile) {
        try {
          const { text } = await api('GET', `/api/logs/ai?file=${encodeURIComponent(b.dataset.aiFile)}`);
          $('#logBody').innerHTML = `<div class="place-ctrl"><button type="button" class="btn small" id="logBack">← 목록</button><span class="mono muted">${esc(b.dataset.aiFile)}</span></div>
            <pre class="log md ai-raw">${esc(text)}</pre>`;
        } catch (e) {
          toast(e.message, true);
        }
      }
    });
    // 사용량: 로그의 AI 호출을 모아 날짜·모델·용도·프로젝트별로 (가격을 넣으면 비용 추정)
    const drawUsage = async (days) => {
      const u = await api('GET', `/api/usage?days=${days}`);
      const s = await api('GET', '/api/settings');
      const fmt = (n) => Math.round(n).toLocaleString('ko-KR');
      const money = (n) => (u.hasPrices ? `$${n.toFixed(n < 1 ? 4 : 2)}` : '-');
      const table = (title, g, sortByKey) => {
        const rows = Object.entries(g).sort((a, b) => (sortByKey ? b[0].localeCompare(a[0]) : b[1].input + b[1].output - (a[1].input + a[1].output)));
        const max = Math.max(1, ...rows.map(([, v]) => v.input + v.output));
        return `<h4>${title}</h4><div class="usage-table">${rows.map(([k, v]) => `<div class="usage-row">
            <span class="mono">${esc(k)}</span>
            <span class="usage-bar"><i style="width:${((v.input + v.output) / max) * 100}%"></i></span>
            <span>${fmt(v.calls)}회${v.errors ? ` <span class="err">(오류 ${v.errors})</span>` : ''}</span>
            <span class="mono">입력 ${fmt(v.input)} · 출력 ${fmt(v.output)}</span>
            <span class="mono">${(v.ms / 1000).toFixed(0)}초</span>
            <span class="mono">${money(v.cost)}</span>
          </div>`).join('') || '<p class="muted">기록 없음</p>'}</div>`;
      };
      const models = Object.keys(u.group.model).map((k) => k.split('/').slice(1).join('/').replace(' (가벼운)', ''));
      $('#logBody').innerHTML = `
        <div class="place-ctrl"><button type="button" class="btn small" id="logBack">← 로그</button>
          <b>📊 AI 사용량</b>${[7, 30, 90].map((d) => `<button type="button" class="btn small ${d === days ? 'primary' : ''}" data-usage-days="${d}">${d}일</button>`).join('')}</div>
        <div class="usage-total">
          <div><b>${fmt(u.total.calls)}</b><span>호출</span></div>
          <div><b>${fmt(u.total.input)}</b><span>입력 토큰</span></div>
          <div><b>${fmt(u.total.output)}</b><span>출력 토큰</span></div>
          <div><b>${(u.total.ms / 60000).toFixed(1)}분</b><span>AI 대기 시간</span></div>
          <div><b>${money(u.total.cost)}</b><span>추정 비용</span></div>
        </div>
        ${table('날짜별', u.group.day, true)}${table('모델별', u.group.model)}${table('용도별', u.group.purpose)}${table('프로젝트별', u.group.project)}
        <details ${u.hasPrices ? '' : 'open'}><summary><b>모델 가격</b> <span class="muted">(1백만 토큰당 달러 — 넣으면 비용을 추정합니다. 로컬 모델은 0)</span></summary>
          ${[...new Set(models)].map((m) => `<div class="price-row"><span class="mono">${esc(m)}</span>
            입력 <input type="number" step="any" min="0" data-price-model="${esc(m)}" data-price-kind="in" value="${s.prices?.[m]?.in ?? ''}">
            출력 <input type="number" step="any" min="0" data-price-model="${esc(m)}" data-price-kind="out" value="${s.prices?.[m]?.out ?? ''}"></div>`).join('') || '<p class="muted">아직 AI 호출 기록이 없습니다.</p>'}
          <button type="button" class="btn small" id="savePrices" data-days="${days}">가격 저장</button></details>`;
    };
    await load();
    await pending;
    $('#dlg').classList.remove('wide');
  });
}
