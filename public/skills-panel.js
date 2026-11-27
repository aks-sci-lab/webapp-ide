// 🧩 스킬 창: 앱에 끼워 넣을 재사용 기능을 켜고 끄며, 학교 양식 파일을 미리 분석해 앱 설명에 넣는다.
import { $, api, esc, toast, dialog } from './ui-core.js';

let deps = { reloadPreview: () => {}, appendAppPrompt: () => {} };

// 앱에 들어가는 것과 같은 스킬 코드를 편집기 안의 작은 가짜 app 에 실행해 양식 분석기를 얻는다
let formTool = null;
async function loadFormTool() {
  if (formTool) return formTool;
  const code = await (await fetch('/api/skills/runtime.js?ids=formScan')).text();
  const state = {};
  const fakeApp = { set: (k, v) => (state[k] = v), get: (k) => state[k], emit: () => {}, on: () => () => {} };
  // eslint-disable-next-line no-new-func
  new Function('window', code)({ __ideApp: fakeApp });
  formTool = fakeApp;
  return formTool;
}

function formAnalysisText(a, fileName) {
  const lines = [`# 참고 양식: ${fileName}`, '이 앱은 아래 학교 양식과 같은 열 구성으로 데이터를 다루고, 양식 순서대로 내보낼 수 있어야 합니다.'];
  for (const s of a.sheets) {
    if (!s.columns.length) continue;
    lines.push(`- 시트 "${s.name}"${s.title ? ` (제목: ${s.title})` : ''}: ${s.headerRow}행이 머리글, 채울 빈 줄 ${s.emptyRows}개`);
    lines.push(`  열: ${s.columns.map((c) => `${c.letter} ${c.name}(${c.type})`).join(', ')}`);
  }
  return lines.join('\n');
}

const TYPE_LABEL = { number: '숫자', date: '날짜', name: '이름', text: '글', empty: '빈 칸' };

async function openSkills() {
  let st = await api('GET', '/api/skills');
  const pending = dialog('🧩 스킬 — 앱에 끼워 넣는 기능', '<div id="skillsBody"></div>', '닫기');
  $('#dlg').classList.add('wide');
  const draw = () => {
    $('#skillsBody').innerHTML = `
      <p class="muted small-note">켜 둔 스킬은 만든 앱(미리보기·내보내기)에 들어가고, 영역을 만드는 AI 에게 사용법이 함께 전달됩니다. 요구사항에 맞는 스킬에는 <b>추천</b> 표시가 붙습니다.</p>
      <div class="skill-list">${st.catalog.map((k) => `
        <label class="skill-card${st.enabled.includes(k.id) ? ' on' : ''}">
          <input type="checkbox" data-skill="${k.id}" ${st.enabled.includes(k.id) ? 'checked' : ''}>
          <span class="skill-icon">${k.icon}</span>
          <span class="skill-text"><b>${esc(k.title)}</b>${st.recommended.includes(k.id) && !st.enabled.includes(k.id) ? ' <span class="badge-soft">추천</span>' : ''}<br><span class="muted">${esc(k.desc)}</span>
          ${k.id === 'backup' ? `<br><span class="skill-opt"><input type="checkbox" data-opt="backupButton" ${st.options.backupButton ? 'checked' : ''}> 화면 오른쪽 아래에 💾 백업 버튼 보이기</span>` : ''}
          ${k.id === 'formScan' ? '<br><button type="button" class="btn small" data-form-analyze>📋 양식 파일 미리 분석하기</button>' : ''}
          </span>
        </label>`).join('')}</div>
      <div id="formResult"></div>`;
  };
  const save = async (patch) => {
    try {
      st = await api('PUT', '/api/skills', patch);
      draw();
      deps.reloadPreview();
      toast('스킬 설정을 저장했습니다');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#skillsBody').addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.skill) {
      const enabled = new Set(st.enabled);
      if (t.checked) enabled.add(t.dataset.skill);
      else enabled.delete(t.dataset.skill);
      save({ enabled: [...enabled] });
    } else if (t.dataset.opt) {
      save({ options: { [t.dataset.opt]: t.checked } });
    }
  });
  $('#skillsBody').addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-form-analyze]')) {
      ev.preventDefault();
      try {
        const tool = await loadFormTool();
        const file = await tool.files.pick('.xlsx,.csv,.tsv,.txt');
        if (!file) return;
        const a = await tool.form.analyze(file);
        const text = formAnalysisText(a, file.name);
        $('#formResult').innerHTML = `<div class="form-analysis">
          <b>📋 ${esc(file.name)} 분석 결과</b>
          ${a.sheets.filter((s) => s.columns.length).map((s) => `<p class="muted">시트 "${esc(s.name)}"${s.title ? ` · 제목 "${esc(s.title)}"` : ''} · ${s.headerRow}행 머리글 · 내용 ${s.dataRows}줄 · 빈 줄 ${s.emptyRows}개</p>
            <table class="mini-table"><tr><th>열</th><th>이름</th><th>종류</th><th>예시</th></tr>${s.columns.map((c) => `<tr><td>${c.letter}</td><td>${esc(c.name)}</td><td>${TYPE_LABEL[c.type] || c.type}</td><td class="muted">${esc(c.samples.join(', '))}</td></tr>`).join('')}</table>`).join('') || '<p class="muted">머리글 행을 찾지 못했습니다.</p>'}
          <button type="button" class="btn primary small" data-form-append>앱 설명에 이 양식 넣기</button>
        </div>`;
        $('#formResult').querySelector('[data-form-append]').addEventListener('click', () => {
          deps.appendAppPrompt(text);
          if (!st.enabled.includes('formScan')) save({ enabled: [...st.enabled, 'formScan'] });
          toast('앱 설명에 양식 구조를 넣었습니다. 이제 AI 가 이 열 구성에 맞춰 만듭니다');
        });
      } catch (e) {
        toast(e.message, true);
      }
    }
  });
  draw();
  await pending;
  $('#dlg').classList.remove('wide');
}

export function initSkillsPanel(options = {}) {
  deps = { ...deps, ...options };
  $('#btnSkills')?.addEventListener('click', () => openSkills().catch((e) => toast(e.message, true)));
}
