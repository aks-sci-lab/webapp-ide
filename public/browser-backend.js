// 웹앱제작기 브라우저 단독 실행 백엔드 (Firebase Hosting 정적 배포용)
// Node.js 서버 없이 브라우저(localStorage)에서 프로젝트·영역·세션·스냅샷·미리보기·AI API 직접 호출을 처리한다.
// API 키는 오직 사용자의 브라우저 localStorage 에만 저장되며 외부 서버로 전송되지 않는다.
import { flatten, find, ancestors, isContainer, sorted, unionRect, splitSizes, uniqueId, DEFAULT_INNER_GRID } from './tree.js';
import { APP_TEMPLATES, THEME_PRESETS, buildThemeBaseCss } from './templates.js';

const STORE_KEY = 'webapp-builder-standalone-v1';
const SETTINGS_KEY = 'webapp-builder-settings-v1';
const USAGE_KEY = 'webapp-builder-usage-v1';
const COLORS = ['#5b5bd6', '#e5484d', '#12a594', '#f76b15', '#8e4ec6', '#0090ff', '#d6409f', '#46a758'];

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const LOCAL_PRESETS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  lmstudio: 'http://localhost:1234/v1',
  ollama: 'http://localhost:11434/v1',
};

const DEFAULT_SETTINGS = {
  provider: 'gemini',
  model: MODELS[0],
  apiKey: '',
  geminiModel: 'gemini-3.8-flash',
  geminiKey: '',
  localUrl: LOCAL_PRESETS.openrouter,
  localModel: '',
  localKey: '',
  logging: true,
  logKeepDays: 30,
  previewIsolation: false,
  visualMode: 'off',
  historyCount: 8,
  light: { provider: '', model: '' },
  routes: { describe: true },
  sessionModels: {
    integrated: { provider: '', model: '' },
    region: { provider: '', model: '' },
    verify: { provider: '', model: '' },
  },
  freeMode: { enabled: true, minIntervalSec: 4, dailyLimit: 50, autoFallback: true },
  prices: {},
  currentProject: 'my-app',
};

const SYSTEM_PROMPT = `당신은 웹앱의 "영역(region)" 하나를 구현하는 프런트엔드 개발자입니다.
웹앱은 CSS 그리드 레이아웃으로 나뉘어 있고, 각 영역은 독립된 파일 3개로 관리됩니다.
- view.html: 영역 내부 마크업만 작성. <html>, <head>, <body>, <script>, <style> 태그 금지.
- style.css: 빌드 시 @scope ([data-region="ID"]) { ... } 로 자동 감싸집니다. 영역 자신은 :scope.
- script.js: 빌드 시 (function (root, app) { ... }) 로 자동 감싸집니다. DOM 은 root.querySelector(...) 로 찾으세요.
- 영역 간 통신: app.emit('영역ID:동작', data) / app.on(...) / app.set('키', 값) / app.get('키').
설명 1~2줄 후 반드시 \`\`\`html, \`\`\`css, \`\`\`js 코드 블록 세 개에 각 파일 전체 내용을 출력하세요.`;

const PLAN_SYSTEM = `당신은 여러 영역(region)으로 나뉜 웹앱을 총괄하는 리드 개발자입니다.
사용자 요청을 받아 JSON 만 출력하세요:
{
  "summary": "요약",
  "steps": [{ "target": "영역ID 또는 shared:css", "prompt": "구체적 지시" }],
  "newRegions": [],
  "featureMoves": [],
  "removeRegions": [],
  "layout": null
}`;

const SHARED_CSS_SYSTEM = `당신은 웹앱의 공통 스타일시트(shared/global.css)를 관리합니다. :root 변수와 전역 스타일만 다루고 설명 1~2줄 후 \`\`\`css 블록 하나에 파일 전체를 출력하세요.`;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function defaultProjectData(name = '내 웹앱', tpl = null) {
  const dash = tpl || APP_TEMPLATES.find((t) => t.id === 'dashboard');
  const layout = tpl?.layout
    ? JSON.parse(JSON.stringify({ ...tpl.layout, name }))
    : JSON.parse(JSON.stringify({ ...dash.layout, name }));
  const regions = {};
  for (const { region: r } of flatten(layout)) {
    const f = tpl?.files?.[r.id] || (!tpl && dash.files?.[r.id]) || {};
    regions[r.id] = {
      html: f.html || `<div style="padding:12px"><h3>${r.title || r.id}</h3><p style="color:var(--muted,#64748b);margin:4px 0 0">오른쪽 프롬프트에서 AI 로 구현하세요.</p></div>\n`,
      css: f.css || `:scope { background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: var(--radius, 10px); }\n`,
      js: f.js || '',
      prompt: f.prompt || '',
      history: {},
      pending: null,
      featureNotes: {},
    };
  }
  return {
    layout,
    shared: {
      css: tpl?.sharedCss || buildThemeBaseCss(THEME_PRESETS[0]),
      js: '',
      head: '',
    },
    regions,
    projectPrompt: { request: '', plan: null, log: '' },
    decisions: '',
    tests: [],
    snapshots: [],
    layoutBackups: [],
    sessions: { integrated: { key: 'integrated', entries: [] }, verify: { key: 'verify', entries: [] } },
  };
}

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw && raw.projects && Object.keys(raw.projects).length) return raw;
  } catch {}
  const init = {
    current: 'my-app',
    projects: { 'my-app': defaultProjectData('내 웹앱') },
  };
  saveStore(init);
  return init;
}
function saveStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}
function curProj(store) {
  if (!store.projects[store.current]) store.current = Object.keys(store.projects)[0];
  return store.projects[store.current];
}

function ensureRegionObj(proj, id) {
  if (!proj.regions[id]) {
    proj.regions[id] = { html: '', css: '', js: '', prompt: '', history: {}, pending: null, featureNotes: {} };
  }
  return proj.regions[id];
}

function recordUsage(provider, model, usage) {
  let db = {};
  try { db = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch {}
  const day = todayStr();
  const d = (db[day] ||= { calls: 0, tokens: 0, byProvider: {}, events: [] });
  d.calls++;
  const inp = Number(usage?.input_tokens) || 0;
  const out = Number(usage?.output_tokens) || 0;
  d.tokens += inp + out;
  d.byProvider[provider] = (d.byProvider[provider] || 0) + 1;
  d.events.push({ ts: new Date().toISOString(), type: 'ai', provider, model, usage: { input_tokens: inp, output_tokens: out } });
  if (d.events.length > 200) d.events = d.events.slice(-200);
  localStorage.setItem(USAGE_KEY, JSON.stringify(db));
}
function getTodayUsage() {
  try {
    const db = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    const day = todayStr();
    const d = db[day] || { calls: 0, tokens: 0, byProvider: {} };
    return { day, calls: d.calls || 0, tokens: d.tokens || 0, byProvider: d.byProvider || {} };
  } catch {
    return { day: todayStr(), calls: 0, tokens: 0, byProvider: {} };
  }
}

// ── HTML 조립기 (브라우저 버전) ──
const RUNTIME = `window.__ideApp = (() => {
  const handlers = {}; const state = {};
  return {
    state, regions: {},
    on(e, fn) { (handlers[e] ||= []).push(fn); return () => this.off(e, fn); },
    off(e, fn) { handlers[e] = (handlers[e] || []).filter((f) => f !== fn); },
    emit(e, d) { (handlers[e] || []).forEach((fn) => { try { fn(d); } catch (err) { console.error(err); } }); },
    set(k, v) { state[k] = v; this.emit('state:' + k, v); },
    get(k) { return state[k]; },
    multiRoot(ids) {
      const els = () => ids.map((id) => this.regions[id]).filter(Boolean);
      return {
        querySelector(s) { for (const e of els()) { const m = e.querySelector(s); if (m) return m; } return null; },
        querySelectorAll(s) { return els().flatMap((e) => [...e.querySelectorAll(s)]); },
        addEventListener(...a) { els().forEach((e) => e.addEventListener(...a)); },
        removeEventListener(...a) { els().forEach((e) => e.removeEventListener(...a)); },
      };
    },
  };
})();
if (!window.app || window.app instanceof Element) window.app = window.__ideApp;`;

const PREVIEW_HELPER = `<style>
body.show-regions [data-region] { outline: 1px dashed rgba(99,102,241,.6); outline-offset: -1px; }
body.ide-inspect-on, body.ide-inspect-on * { cursor: crosshair !important; }
#__ideInspectBox { position: fixed; pointer-events: none; z-index: 2147483646; display: none; border: 2px solid #5b5bd6; background: rgba(91,91,214,.14); border-radius: 3px; }
#__ideInspectTip { position: fixed; pointer-events: none; z-index: 2147483647; display: none; background: #1f2430; color: #fff; font: 11px/1.4 ui-monospace, Consolas, monospace; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
</style>
<script>
window.addEventListener('error', (e) => { if (!/ResizeObserver loop/.test(e.message)) parent.postMessage({ type: 'preview-error', message: e.message, line: e.lineno }, '*'); });
window.__ideRegionError = (id, e) => { console.error('[' + id + ']', e); parent.postMessage({ type: 'preview-error', region: id, message: e.message }, '*'); };
window.addEventListener('message', (e) => { if (e.data?.type === 'toggle-regions') document.body.classList.toggle('show-regions', e.data.on); });
(() => {
  let active = false, box, tip;
  const ensure = () => { if (!box) { box = document.createElement('div'); box.id = '__ideInspectBox'; tip = document.createElement('div'); tip.id = '__ideInspectTip'; document.body.append(box, tip); } };
  const hide = () => { if (box) box.style.display = 'none'; if (tip) tip.style.display = 'none'; };
  const escSel = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s));
  const selectorIn = (el, root) => {
    if (el === root) return ':scope';
    if (el.id) return '#' + escSel(el.id);
    const cls = [...el.classList].filter((c) => c && !c.startsWith('__ide')).slice(0, 2);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(escSel).join('.') : '');
  };
  const regionOf = (el) => el?.closest?.('section[data-region]') || null;
  document.addEventListener('mousemove', (ev) => {
    if (!active) return;
    const reg = regionOf(ev.target);
    if (!reg) return hide();
    ensure();
    const r = ev.target.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tip.textContent = reg.dataset.region + ' · ' + selectorIn(ev.target, reg);
    Object.assign(tip.style, { display: 'block', left: Math.max(4, r.left) + 'px', top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px' });
  }, true);
  document.addEventListener('click', (ev) => {
    if (!active) return;
    const reg = regionOf(ev.target);
    if (!reg) return;
    ev.preventDefault(); ev.stopPropagation();
    const t = ev.target, cs = getComputedStyle(t), r = t.getBoundingClientRect();
    parent.postMessage({ type: 'inspect-pick', info: {
      region: reg.dataset.region, selector: selectorIn(t, reg), tag: t.tagName.toLowerCase(), id: t.id || '',
      classes: [...t.classList].slice(0, 5), text: (t.innerText || t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      html: (t.outerHTML || '').slice(0, 500), rect: { w: Math.round(r.width), h: Math.round(r.height) },
      styles: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight, padding: cs.padding, borderRadius: cs.borderRadius },
    }}, '*');
  }, true);
  window.addEventListener('keydown', (ev) => { if (active && ev.key === 'Escape') { active = false; document.body.classList.remove('ide-inspect-on'); hide(); parent.postMessage({ type: 'inspect-cancel' }, '*'); } });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d?.type === 'toggle-inspect') { active = Boolean(d.on); document.body.classList.toggle('ide-inspect-on', active); if (!active) hide(); }
    else if (d?.type === 'inspect-live-style') {
      const reg = document.querySelector('section[data-region="' + escSel(d.region) + '"]');
      const target = reg && (d.selector === ':scope' ? reg : reg.querySelector(d.selector));
      if (target) for (const [k, v] of Object.entries(d.styles || {})) if (v !== '' && v != null) target.style.setProperty(k, String(v));
    }
  });
})();
</script>`;

function testRunnerScript(test, index) {
  return `<script>(() => {
    const test = ${JSON.stringify(test).replace(/</g, '\\u003c')};
    const errors = [];
    window.addEventListener('error', (e) => errors.push(e.message));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const find = async (sel) => { for (let i = 0; i < 20; i++) { const el = document.querySelector(sel); if (el) return el; await sleep(80); } throw new Error('요소를 찾지 못함: ' + sel); };
    const vis = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight));
    const run = async (s) => {
      const v = s.value ?? '';
      if (s.action === 'click') { (await find(s.selector)).click(); await sleep(100); return '클릭'; }
      if (s.action === 'type') { const el = await find(s.selector); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); return '입력'; }
      if (s.action === 'wait') { await sleep(Number(v) || 200); return '대기'; }
      if (s.action === 'expectText') { const el = await find(s.selector); if (el.textContent.includes(v)) return '글자 확인'; throw new Error('"' + v + '" 없음'); }
      if (s.action === 'expectValue') { const el = await find(s.selector); if (String(el.value) === v) return '값 확인'; throw new Error('값 불일치'); }
      if (s.action === 'expectVisible') { const el = await find(s.selector); if (vis(el)) return '보임'; throw new Error('보이지 않음'); }
      if (s.action === 'expectCount') { const n = document.querySelectorAll(s.selector).length; if (n === Number(v)) return n + '개'; throw new Error(n + '개'); }
      return 'OK';
    };
    window.addEventListener('load', async () => {
      await sleep(200);
      const results = [];
      for (const s of test.steps || []) { try { results.push({ ok: true, msg: await run(s) }); } catch (e) { results.push({ ok: false, msg: e.message }); break; } }
      parent.postMessage({ type: 'test-result', index: ${index}, results, errors }, '*');
    });
  })();</script>`;
}

function buildHtml(proj, { preview = false, candidate = '', testIndex = null } = {}) {
  const layout = proj.layout;
  const g = layout.grid || { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 };
  const all = flatten(layout);
  const files = {};
  for (const { region: r } of all) {
    const f = ensureRegionObj(proj, r.id);
    files[r.id] = candidate === r.id && f.pending?.files ? { ...f, ...f.pending.files } : f;
  }
  const placement = [];
  const render = (container) => sorted(container.regions || []).map((r) => {
    const area = `${r.y + 1} / ${r.x + 1} / span ${r.h} / span ${r.w}`;
    placement.push(`section[data-region="${r.id}"] { grid-area: ${area} !important; }`);
    const body = isContainer(r)
      ? `<div class="ide-grid" style="display:grid;grid-template-columns:repeat(${r.grid.cols},minmax(0,1fr));grid-template-rows:repeat(${r.grid.rows},minmax(0,1fr));gap:${r.grid.gap ?? 8}px;height:100%">${render(r)}</div>`
      : (files[r.id]?.html || '');
    return `<section data-region="${r.id}" style="grid-area:${area}">\n${body}\n</section>`;
  }).join('\n');

  const rows = g.fill ? `repeat(${g.rows}, minmax(0, 1fr))` : `repeat(${g.rows}, minmax(${g.rowHeight || 60}px, auto))`;
  const baseCss = `*,*::before,*::after{box-sizing:border-box}html,body{margin:0;${g.fill ? 'height:100%;' : ''}}body{font-family:system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif}#app{display:grid;grid-template-columns:repeat(${g.cols},minmax(0,1fr));grid-template-rows:${rows};gap:${g.gap ?? 8}px;${g.fill ? 'height:100vh;' : 'min-height:100vh;'}padding:${g.gap ?? 8}px}#app section[data-region]{min-width:0;min-height:0;overflow:auto;position:relative}\n${placement.join('\n')}`;
  const regionCss = all.map(({ region: r }) => (files[r.id]?.css?.trim() ? `@scope ([data-region="${r.id}"]) {\n${files[r.id].css}\n}` : '')).join('\n');
  const scripts = all.filter(({ region: r }) => files[r.id]?.js?.trim()).map(({ region: r }) =>
    `<script>(function(root,app){try{\n${files[r.id].js}\n}catch(e){(window.__ideRegionError||console.error)(${JSON.stringify(r.id)},e);}})(__ideApp.regions[${JSON.stringify(r.id)}],__ideApp);</script>`,
  ).join('\n');
  const testInject = testIndex !== null && proj.tests[testIndex] ? testRunnerScript(proj.tests[testIndex], testIndex) : '';

  return `<!doctype html><html lang="${layout.lang || 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${layout.name || '내 웹앱'}</title>${proj.shared.head || ''}<style>${baseCss}</style><style>${proj.shared.css || ''}</style><style>${regionCss}</style>${preview ? PREVIEW_HELPER : ''}${testInject}</head><body><div id="app">${render(layout)}</div><script>${RUNTIME}\ndocument.querySelectorAll('#app section[data-region]').forEach(el=>{__ideApp.regions[el.dataset.region]=el;});</script>${proj.shared.js?.trim() ? `<script>${proj.shared.js}</script>` : ''}${scripts}</body></html>`;
}

// ── 브라우저 직접 AI API 호출 (Gemini / Claude / OpenAI 호환) ──
const rawFetch = window.fetch.bind(window);

async function* callGeminiDirect(settings, { prompt, system, images = [] }) {
  const key = settings.geminiKey;
  const model = settings.geminiModel || 'gemini-3.8-flash';
  if (!key) throw new Error('Gemini API 키가 없습니다. ⚙️ 설정에서 입력하세요.');
  const res = await rawFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })), { text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini API 오류 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const chunk = JSON.parse(line.slice(5));
      for (const p of chunk.candidates?.[0]?.content?.parts || []) {
        if (p.text && !p.thought) { text += p.text; yield { type: 'delta', text: p.text }; }
      }
      if (chunk.usageMetadata) usage = { input_tokens: chunk.usageMetadata.promptTokenCount, output_tokens: chunk.usageMetadata.candidatesTokenCount };
    }
  }
  yield { type: 'final', text, usage };
}

async function* callOpenAiDirect(settings, { prompt, system, images = [] }) {
  const base = String(settings.localUrl || '').replace(/\/+$/, '');
  const model = settings.localModel;
  if (!base || !model) throw new Error('OpenAI 호환 서버 주소와 모델을 ⚙️ 설정에서 지정하세요.');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.localKey) headers.Authorization = `Bearer ${settings.localKey}`;
  const res = await rawFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model, stream: true, temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: images.length ? [...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } })), { type: 'text', text: prompt }] : prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`API 오류 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const chunk = JSON.parse(payload);
      const c = chunk.choices?.[0]?.delta?.content;
      if (c) { text += c; yield { type: 'delta', text: c }; }
      if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens };
    }
  }
  yield { type: 'final', text: text.replace(/<think>[\s\S]*?<\/think>/g, ''), usage };
}

async function* callClaudeDirect(settings, { prompt, system, images = [] }) {
  if (!settings.apiKey) throw new Error('Anthropic API 키가 없습니다. ⚙️ 설정에서 입력하세요.');
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })), { type: 'text', text: prompt }]
    : prompt;
  const res = await rawFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: settings.model || MODELS[0], max_tokens: 8192, system, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`Claude API 오류 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  yield { type: 'delta', text };
  yield { type: 'final', text, usage: data.usage };
}

async function* runAi(settings, ctx) {
  const fm = settings.freeMode || {};
  if (fm.enabled && fm.dailyLimit > 0 && getTodayUsage().calls >= fm.dailyLimit) {
    throw new Error(`🍃 무료 한도 절약 모드: 오늘 호출 상한(${fm.dailyLimit}회)에 도달했습니다.`);
  }
  const gen = settings.provider === 'claude' ? callClaudeDirect : settings.provider === 'local' ? callOpenAiDirect : callGeminiDirect;
  const model = { gemini: settings.geminiModel, local: settings.localModel, claude: settings.model }[settings.provider];
  for await (const ev of gen(settings, ctx)) {
    if (ev.type === 'final') recordUsage(settings.provider, model, ev.usage);
    yield ev;
  }
}

function parseCodeBlocks(text) {
  const out = {};
  const re = /```(html|css|js|javascript)[^\n]*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(text))) out[m[1] === 'javascript' ? 'js' : m[1]] = m[2] + '\n';
  return out;
}

function scanConnectionsSimple(proj) {
  const CALL_RE = /\b(?:app|__ideApp|window\.app)\s*\.\s*(emit|on|off|set|get)\s*\(\s*(['"`])([^'"`]+)\2/g;
  const regions = {};
  for (const { region: r } of flatten(proj.layout)) {
    if (isContainer(r)) continue;
    const js = ensureRegionObj(proj, r.id).js || '';
    const d = { emits: new Set(), listens: new Set(), sets: new Set(), gets: new Set() };
    for (const m of js.matchAll(CALL_RE)) {
      const [, fn, , name] = m;
      if (fn === 'emit') d.emits.add(name);
      else if (fn === 'on' || fn === 'off') (name.startsWith('state:') ? d.gets.add(name.slice(6)) : d.listens.add(name));
      else if (fn === 'set') d.sets.add(name);
      else if (fn === 'get') d.gets.add(name);
    }
    regions[r.id] = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, [...v]]));
  }
  const collect = (k) => {
    const map = new Map();
    for (const [id, r] of Object.entries(regions)) for (const n of r[k]) map.set(n, [...(map.get(n) || []), id]);
    return map;
  };
  const em = collect('emits'), li = collect('listens'), se = collect('sets'), ge = collect('gets');
  const events = [...new Set([...em.keys(), ...li.keys()])].sort().map((name) => ({ name, from: em.get(name) || [], to: li.get(name) || [] }));
  const states = [...new Set([...se.keys(), ...ge.keys()])].sort().map((name) => ({ name, from: se.get(name) || [], to: ge.get(name) || [] }));
  const issues = [];
  for (const e of events) {
    if (e.to.length && !e.from.length) issues.push({ level: 'error', text: `"${e.name}" 이벤트를 ${e.to.join(', ')} 이(가) 기다리지만 아무도 보내지 않습니다`, similar: [] });
    if (e.from.length && !e.to.length) issues.push({ level: 'warn', text: `"${e.name}" 이벤트를 ${e.from.join(', ')} 이(가) 보내지만 받는 곳이 없습니다`, similar: [] });
  }
  for (const s of states) {
    if (s.to.length && !s.from.length) issues.push({ level: 'error', text: `공유 상태 "${s.name}" 을(를) ${s.to.join(', ')} 이(가) 읽지만 아무도 값을 넣지 않습니다`, similar: [] });
  }
  return { regions, events, states, issues };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Preview Blob URL 리졸버 (editor.js 가 iframe.src 설정 시 호출)
const previewBlobs = [];
window.__resolvePreviewUrl = async (pathAndQuery) => {
  const u = new URL(pathAndQuery, location.origin);
  const store = loadStore();
  const proj = curProj(store);
  const candidate = u.searchParams.get('candidate') || '';
  const testParam = u.searchParams.get('test');
  const html = buildHtml(proj, { preview: true, candidate, testIndex: testParam !== null ? Number(testParam) : null });
  const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  previewBlobs.push(blobUrl);
  if (previewBlobs.length > 8) URL.revokeObjectURL(previewBlobs.shift());
  return blobUrl;
};

// /api/* fetch 인터셉터 설치
export function installBrowserBackend() {
  if (!window.__WEB_STANDALONE__) return;
  window.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input?.url || '';
    const u = new URL(urlStr, location.origin);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) {
      return rawFetch(input, init);
    }
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const p = u.pathname;
    const store = loadStore();
    const proj = curProj(store);
    const settings = loadSettings();

    try {
      // 설정 & 쿼터
      if (p === '/api/settings' && method === 'GET') {
        const hasKey = { gemini: Boolean(settings.geminiKey && settings.geminiModel), claude: Boolean(settings.apiKey), local: Boolean(settings.localModel) }[settings.provider];
        return jsonResp({
          ...settings,
          models: MODELS,
          localPresets: LOCAL_PRESETS,
          hasKey,
          keySource: settings.apiKey ? 'settings' : null,
          geminiKeySource: settings.geminiKey ? 'settings' : null,
          localKeySource: settings.localKey ? 'settings' : null,
          projectDir: '브라우저 로컬 저장소 (localStorage)',
          browserFound: false,
        });
      }
      if (p === '/api/settings' && method === 'PUT') {
        Object.assign(settings, body);
        saveSettings(settings);
        return jsonResp({ ok: true });
      }
      if (p === '/api/quota') return jsonResp({ ...getTodayUsage(), freeMode: settings.freeMode || DEFAULT_SETTINGS.freeMode });

      // 모델 목록 조회
      if (p === '/api/gemini/models') {
        const key = (body.apiKey || '').trim() || settings.geminiKey;
        if (!key) throw new Error('Gemini API 키를 입력하세요');
        const r = await rawFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': key } });
        if (!r.ok) throw new Error(`Gemini 모델 목록 오류 (${r.status})`);
        const data = await r.json();
        const models = (data.models || [])
          .filter((m) => m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent') && !/embedding|image|tts|audio|live|transcribe|customtools/i.test(m.name))
          .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
        return jsonResp({ models });
      }
      if (p === '/api/local/models') {
        const base = (body.baseUrl || settings.localUrl || '').replace(/\/+$/, '');
        const key = (body.apiKey || '').trim() || settings.localKey;
        const headers = key ? { Authorization: `Bearer ${key}` } : {};
        const r = await rawFetch(`${base}/models`, { headers });
        if (!r.ok) throw new Error(`모델 목록 오류 (${r.status})`);
        const data = await r.json();
        const models = (data.data || []).map((m) => m.id).filter((id) => id && !/embed|whisper|tts|dall-e|audio/i.test(id)).filter((id) => !body.freeOnly || /:free\b/i.test(id)).map((id) => ({ id, label: id }));
        return jsonResp({ models });
      }

      // 프로젝트 CRUD
      if (p === '/api/projects' && method === 'GET') {
        const list = Object.keys(store.projects).sort();
        const details = list.map((name) => {
          const pr = store.projects[name];
          const leaves = flatten(pr.layout).filter((e) => !isContainer(e.region));
          return {
            name,
            title: pr.layout.name || name,
            mode: pr.layout.mode || 'grid',
            regionsCount: leaves.length,
            grid: pr.layout.grid,
            regions: (pr.layout.regions || []).map((r) => ({ id: r.id, title: r.title, color: r.color, x: r.x, y: r.y, w: r.w, h: r.h })),
            workflowStep: 1,
            checklistTotal: 0,
            checklistVerified: 0,
            deployReady: false,
            updatedAt: null,
          };
        });
        return jsonResp({ current: store.current, list, details });
      }
      if (p === '/api/projects' && method === 'POST') {
        const name = String(body.name || '').trim();
        if (!name || store.projects[name]) throw new Error('사용할 수 없거나 이미 있는 프로젝트 이름입니다');
        store.projects[name] = defaultProjectData(name, body.template);
        store.current = name;
        saveStore(store);
        return jsonResp({ ok: true });
      }
      if (p === '/api/projects/open') { store.current = body.name; saveStore(store); return jsonResp({ ok: true }); }
      if (p === '/api/projects/rename') {
        const oldName = store.current, newName = String(body.newName || '').trim();
        if (!newName || store.projects[newName]) throw new Error('사용할 수 없는 이름입니다');
        store.projects[newName] = store.projects[oldName];
        delete store.projects[oldName];
        store.projects[newName].layout.name = newName;
        store.current = newName;
        saveStore(store);
        return jsonResp({ ok: true, name: newName });
      }
      if (p === '/api/projects/clone') {
        const newName = String(body.newName || '').trim();
        if (!newName || store.projects[newName]) throw new Error('사용할 수 없는 이름입니다');
        store.projects[newName] = JSON.parse(JSON.stringify(proj));
        store.projects[newName].layout.name = newName;
        store.current = newName;
        saveStore(store);
        return jsonResp({ ok: true, name: newName });
      }
      if (p.startsWith('/api/projects/') && method === 'DELETE') {
        const name = decodeURIComponent(p.slice('/api/projects/'.length));
        delete store.projects[name];
        if (!Object.keys(store.projects).length) store.projects['my-app'] = defaultProjectData('내 웹앱');
        store.current = Object.keys(store.projects)[0];
        saveStore(store);
        return jsonResp({ ok: true, current: store.current });
      }

      // 레이아웃 & 프로젝트 프롬프트
      if (p === '/api/layout' && method === 'GET') return jsonResp(proj.layout);
      if (p === '/api/layout' && method === 'PUT') {
        proj.layout = body;
        for (const { region: r } of flatten(proj.layout)) ensureRegionObj(proj, r.id);
        saveStore(store);
        return jsonResp(proj.layout);
      }
      if (p === '/api/layout/backups') return jsonResp({ list: proj.layoutBackups || [] });
      if (p === '/api/project' && method === 'GET') return jsonResp({ appPrompt: proj.layout.appPrompt || '', decisions: proj.decisions || '', ...proj.projectPrompt });
      if (p === '/api/project' && method === 'PUT') {
        if (typeof body.decisions === 'string') proj.decisions = body.decisions;
        if (typeof body.appPrompt === 'string') proj.layout.appPrompt = body.appPrompt;
        if (typeof body.request === 'string') proj.projectPrompt.request = body.request;
        if (body.plan !== undefined) proj.projectPrompt.plan = body.plan;
        saveStore(store);
        return jsonResp({ ok: true });
      }

      // 공통 파일
      if (p.startsWith('/api/shared/')) {
        const key = p.split('/')[3];
        if (p.endsWith('/generate')) {
          let text = '';
          for await (const ev of runAi(settings, { system: SHARED_CSS_SYSTEM, prompt: `현재 CSS:\n\`\`\`css\n${proj.shared.css}\n\`\`\`\n요청:\n${body.request}` })) {
            if (ev.type === 'final') text = ev.text;
          }
          const css = parseCodeBlocks(text).css;
          if (!css) throw new Error('CSS 블록을 찾지 못했습니다');
          proj.shared.css = css;
          saveStore(store);
          return jsonResp({ ok: true, size: css.length });
        }
        if (method === 'GET') return jsonResp({ text: proj.shared[key] || '' });
        if (method === 'PUT') { proj.shared[key] = String(body.text ?? ''); saveStore(store); return jsonResp({ ok: true }); }
      }

      // 세션
      if (p === '/api/sessions' && method === 'GET') {
        const ids = flatten(proj.layout).filter((e) => !isContainer(e.region)).map((e) => e.region.id);
        const out = {};
        for (const k of ['integrated', 'verify', ...ids.map((id) => `region:${id}`), ...Object.keys(proj.sessions || {})]) {
          const s = proj.sessions[k] || { key: k, entries: [] };
          out[k] = { key: k, title: s.title || '', regionId: s.regionId || (k.startsWith('region:') ? k.split(':')[1] : null), isExtra: k.split(':').length > 2, count: (s.entries || []).length, updatedAt: s.updatedAt || null };
        }
        return jsonResp({ sessions: out });
      }
      if (p === '/api/sessions/region' && method === 'POST') {
        const key = `region:${body.regionId}:s${Date.now().toString(36).slice(-4)}`;
        const created = { key, regionId: body.regionId, title: String(body.title || '새 세션').slice(0, 40), updatedAt: new Date().toISOString(), entries: [] };
        proj.sessions[key] = created;
        saveStore(store);
        return jsonResp(created);
      }
      if (p.startsWith('/api/sessions/')) {
        const key = decodeURIComponent(p.slice('/api/sessions/'.length).replace(/\/clear$/, ''));
        if (method === 'DELETE') { delete proj.sessions[key]; saveStore(store); return jsonResp({ ok: true }); }
        if (p.endsWith('/clear')) { if (proj.sessions[key]) proj.sessions[key].entries = []; saveStore(store); return jsonResp({ key, entries: [] }); }
        return jsonResp(proj.sessions[key] || { key, entries: [] });
      }

      // 영역 파일 & 생성 스트리밍
      const regMatch = p.match(/^\/api\/regions\/([^/]+)(?:\/(.+))?$/);
      if (regMatch) {
        const id = decodeURIComponent(regMatch[1]);
        const sub = regMatch[2] || '';
        const f = ensureRegionObj(proj, id);
        if (!sub && method === 'GET') {
          return jsonResp({ files: { html: f.html, css: f.css, js: f.js, prompt: f.prompt }, history: Object.keys(f.history || {}).sort().reverse() });
        }
        if (!sub && method === 'PUT') {
          const ver = stamp();
          f.history[ver] = { html: f.html, css: f.css, js: f.js };
          for (const k of ['html', 'css', 'js', 'prompt']) if (typeof body[k] === 'string') f[k] = body[k];
          saveStore(store);
          return jsonResp({ ok: true });
        }
        if (sub === 'features') return jsonResp({ wrappers: [], blocks: [], hasJs: Boolean(f.js.trim()), hasCss: Boolean(f.css.trim()) });
        if (sub === 'pending' && method === 'GET') return jsonResp({ pending: f.pending || null });
        if (sub === 'pending/apply') {
          if (f.pending?.files) {
            f.history[stamp()] = { html: f.html, css: f.css, js: f.js };
            Object.assign(f, f.pending.files);
            f.pending = null;
            saveStore(store);
          }
          return jsonResp({ files: { html: f.html, css: f.css, js: f.js, prompt: f.prompt } });
        }
        if (sub === 'pending/discard') { f.pending = null; saveStore(store); return jsonResp({ ok: true }); }
        if (sub === 'restore') {
          const h = f.history[body.version];
          if (h) Object.assign(f, h);
          saveStore(store);
          return jsonResp({ files: { html: f.html, css: f.css, js: f.js, prompt: f.prompt } });
        }
        if (sub === 'generate') {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            async start(ctrl) {
              const send = (obj) => ctrl.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
              try {
                const reqPrompt = `# 앱: ${proj.layout.name}\n${proj.layout.appPrompt ? `설명: ${proj.layout.appPrompt}\n` : ''}# 영역: ${id}\n## 현재 view.html\n\`\`\`html\n${f.html}\n\`\`\`\n## 현재 style.css\n\`\`\`css\n${f.css}\n\`\`\`\n## 현재 script.js\n\`\`\`js\n${f.js}\n\`\`\`\n# 요청\n${body.request}`;
                let text = '', usage = null;
                for await (const ev of runAi(settings, { system: SYSTEM_PROMPT, prompt: reqPrompt, images: body.images || [] })) {
                  if (ev.type === 'delta') send(ev);
                  else ({ text, usage } = ev);
                }
                const parsed = parseCodeBlocks(text);
                if (!Object.keys(parsed).length) throw new Error('응답에서 코드 블록을 찾지 못했습니다');
                const candidate = { html: parsed.html ?? f.html, css: parsed.css ?? f.css, js: parsed.js ?? f.js };
                const changed = ['html', 'css', 'js'].filter((k) => candidate[k] !== f[k]);
                f.prompt = body.request;
                if (body.review) {
                  f.pending = { files: candidate, meta: { request: body.request } };
                  saveStore(store);
                  send({ type: 'done', pending: true, files: candidate, current: { html: f.html, css: f.css, js: f.js }, updated: changed, usage, attempt: 1, memo: [] });
                } else {
                  f.history[stamp()] = { html: f.html, css: f.css, js: f.js };
                  Object.assign(f, candidate);
                  f.pending = null;
                  saveStore(store);
                  send({ type: 'done', files: { html: f.html, css: f.css, js: f.js, prompt: f.prompt }, updated: changed, usage, attempt: 1, memo: [] });
                }
              } catch (e) {
                send({ type: 'error', message: e.message });
              }
              ctrl.close();
            },
          });
          return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
        }
      }

      // 프로젝트 계획
      if (p === '/api/project/plan') {
        const list = flatten(proj.layout).filter((e) => !isContainer(e.region)).map(({ region: r }) => `- ${r.id} (${r.title || r.id})`).join('\n');
        let text = '';
        for await (const ev of runAi(settings, { system: PLAN_SYSTEM, prompt: `# 앱: ${proj.layout.name}\n# 영역:\n${list}\n# 요청:\n${body.request}`, images: body.images || [] })) {
          if (ev.type === 'final') text = ev.text;
        }
        const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        const validIds = new Set(['shared:css', ...flatten(proj.layout).map((e) => e.region.id)]);
        const plan = {
          request: body.request,
          summary: raw.summary || '',
          steps: (raw.steps || []).map((s) => ({ target: s.target, prompt: s.prompt, valid: validIds.has(s.target), enabled: validIds.has(s.target), warn: '' })),
          newRegions: [], featureMoves: [], removeRegions: [], layout: null,
        };
        proj.projectPrompt = { ...proj.projectPrompt, request: body.request, plan };
        saveStore(store);
        return jsonResp(plan);
      }

      // 테스트 · 분석 · 검증 · 스냅샷 · 내보내기
      if (p === '/api/workflow' && method === 'GET') {
        const wf = proj.workflow || { step: 1, workload: '', proposed: null, distributed: [], checklist: [], deployReady: false };
        if (!wf.workload && proj.projectPrompt?.request) wf.workload = proj.projectPrompt.request;
        return jsonResp(wf);
      }
      if (p === '/api/workflow' && method === 'PUT') {
        proj.workflow = { ...(proj.workflow || { step: 1, workload: '', proposed: null, distributed: [], checklist: [], deployReady: false }), ...body };
        saveStore(store);
        return jsonResp(proj.workflow);
      }
      if (p === '/api/tests' && method === 'GET') return jsonResp({ tests: proj.tests || [] });
      if (p === '/api/tests' && method === 'PUT') { proj.tests = body.tests || []; saveStore(store); return jsonResp({ tests: proj.tests }); }
      if (p === '/api/tests/auto') {
        const auto = flatten(proj.layout).filter((e) => !isContainer(e.region)).map(({ region: r }) => ({
          name: `${r.title || r.id} 화면 렌더링 확인`,
          steps: [{ action: 'expectVisible', selector: `section[data-region="${r.id}"]`, value: '' }],
        }));
        proj.tests = [...(body.append ? proj.tests : []), ...auto];
        saveStore(store);
        return jsonResp({ tests: proj.tests, added: auto.length });
      }
      if (p === '/api/analysis/connections') return jsonResp(scanConnectionsSimple(proj));
      if (p === '/api/analysis/appjs') return jsonResp({ functions: [], empty: true });
      if (p === '/api/verify') {
        const conn = scanConnectionsSimple(proj);
        const leaves = flatten(proj.layout).filter((e) => !isContainer(e.region));
        const report = {
          ok: conn.issues.filter((i) => i.level === 'error').length === 0,
          project: proj.layout.name,
          regions: leaves.length,
          syntaxErrors: [],
          duplicateIds: [],
          connectionIssues: conn.issues,
          browser: { runtimeErrors: [], regionsMounted: leaves.map(({ region: r }) => ({ id: r.id, width: r.w * 100, height: r.h * 60 })), testResults: [] },
        };
        return jsonResp(report);
      }
      if (p === '/api/snapshots' && method === 'GET') return jsonResp({ list: (proj.snapshots || []).map(({ data, ...m }) => m) });
      if (p === '/api/snapshots' && method === 'POST') {
        const id = stamp();
        const meta = { id, label: body.label || '직접 저장', auto: Boolean(body.auto), createdAt: new Date().toISOString(), regions: flatten(proj.layout).length };
        proj.snapshots = [{ ...meta, data: JSON.stringify({ layout: proj.layout, regions: proj.regions, shared: proj.shared }) }, ...(proj.snapshots || [])].slice(0, 15);
        saveStore(store);
        return jsonResp(meta);
      }
      if (p.endsWith('/restore') && p.startsWith('/api/snapshots/')) {
        const id = p.split('/')[3];
        const snap = (proj.snapshots || []).find((s) => s.id === id);
        if (snap?.data) Object.assign(proj, JSON.parse(snap.data));
        saveStore(store);
        return jsonResp({ restored: snap });
      }
      if (p === '/api/export') {
        const html = buildHtml(proj, { preview: false });
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(proj.layout.name || 'webapp').replace(/[^\p{L}\p{N}_-]+/gu, '-')}.html`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        return jsonResp({ path: `${a.download} (브라우저 다운로드)`, bytes: blob.size });
      }
      if (p === '/api/logs') return jsonResp({ dir: 'localStorage', enabled: true, keepDays: 30, days: [todayStr()] });
      if (p.startsWith('/api/logs/day/')) {
        let db = {}; try { db = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch {}
        return jsonResp({ events: db[todayStr()]?.events || [] });
      }
      if (p === '/api/usage') {
        const u = getTodayUsage();
        return jsonResp({ days: 30, total: { calls: u.calls, errors: 0, input: u.tokens, output: 0, ms: 0, cost: 0 }, group: { day: {}, model: {}, purpose: {}, project: {} }, hasPrices: false });
      }
      if (p === '/api/log') return jsonResp({ ok: true });
      return jsonResp({ ok: true });
    } catch (err) {
      return jsonResp({ error: err.message || String(err) }, 400);
    }
  };
}
