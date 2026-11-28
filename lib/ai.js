// 영역 하나를 Claude 로 구현(바이브 코딩)
import { flatten, isContainer } from '../public/tree.js';
import Anthropic, { APIError, APIConnectionError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk';

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export const SYSTEM = `당신은 웹앱의 "영역(region)" 하나를 구현하는 프런트엔드 개발자입니다.
웹앱은 CSS 그리드 레이아웃으로 나뉘어 있고, 각 영역은 독립된 파일 3개로 관리됩니다.

## 파일 규칙
- view.html: 영역 내부 마크업만 작성. <html>, <head>, <body>, <script>, <style> 태그 금지.
  바깥 <section data-region="ID"> 래퍼는 빌드 시 자동으로 붙습니다.
- style.css: 빌드 시 @scope ([data-region="ID"]) { ... } 로 자동 감싸집니다.
  영역 자체(래퍼)는 :scope 로 지정하세요. 다른 영역이나 body 를 건드리지 마세요.
  @keyframes 이름에는 영역 ID 를 접두어로 붙이세요.
- script.js: 빌드 시 (function (root, app) { ... })(영역요소, window.app) 으로 자동 감싸집니다.
  DOM 은 반드시 root.querySelector(...) 로 찾으세요 (document.querySelector 금지).
  외부 라이브러리 없이 바닐라 JS 로 작성하세요. import/export 금지.

## 영역 간 통신 (공용 런타임 window.app)
- app.emit('이벤트명', data) / app.on('이벤트명', fn) : 이벤트 주고받기
- app.set('키', 값) / app.get('키') / app.on('state:키', fn) : 공유 상태
- app.regions['영역ID'] : 다른 영역의 루트 요소 (직접 조작은 지양, 이벤트를 우선 사용)
다른 영역과 연동이 필요하면 이벤트명을 "영역ID:동작" 형식으로 짓고, 응답 끝에 어떤 이벤트를 내보내고 듣는지 한 줄로 적으세요.

## 자주 나는 실수 막기 (검증 때 실제 브라우저로 확인합니다)
- 사용자가 넣은 글자(이름·메모 등)를 innerHTML 에 넣을 때는 & < > " 를 바꿔(escape) 넣거나 textContent 를 쓰세요. 링크 주소는 http:// · https:// 로 시작할 때만 href 에 넣으세요.
- API 키·토큰을 코드에 적지 마세요 (내보낸 HTML 을 받은 누구나 봅니다).
- 다른 영역이 바꾸는 공유 상태는 시작할 때 한 번만 읽지 말고 app.on('state:키', fn) 으로 받아 다시 그리세요. 탭을 바꿀 때 다시 그린다면 최신 값으로 그리세요.
- 저장 키(app.store)는 영역 ID 를 앞에 붙여(예: "seat:names") 다른 영역과 겹치지 않게 하고, 불러온 값이 기대한 모양(배열·객체)인지 확인한 뒤 쓰세요.
- 숫자 칸이 0·음수·빈 값일 때도 오류나 NaN 이 나지 않게 하세요 (0 으로 나누기, new Array(음수) 등).
- 같은 버튼을 여러 번 눌러도 setInterval·addEventListener 가 쌓이지 않게 하세요 (이미 돌고 있으면 무시, 처리기는 처음에 한 번만).
- 숨은 탭에서 시작하는 canvas 는 크기가 0 이므로 탭이 보일 때(app.on('screen:change')) 크기를 다시 재세요.

## 디자인
영역 크기에 맞게 꽉 차고(:scope 에 height:100% 등) 깔끔하며 반응형으로 만드세요. 기존 코드가 있으면 요청된 부분만 고치고 나머지는 유지하세요.

## 칸 (프레임) 규칙
- 영역의 위치와 크기(그리드 칸)는 IDE 레이아웃이 정합니다. 영역 자신(root, :scope)에 grid-column·grid-row·grid-area·position:fixed/absolute 를 쓰거나
  root.style 로 바꾸지 마세요 (저장 전 검사에서 거부됩니다). 다른 영역과 겹치거나 칸을 넓히는 동작이 필요하면 클래스만 토글하고 요청자에게 알려 주세요.
- 칸보다 내용이 크면 영역 안에서 스크롤되거나 잘립니다. 칸 크기에 맞게 내용을 압축하고, 길어지는 목록만 overflow:auto 로 스크롤되게 하세요.

## 출력 형식 (엄격)
설명은 1~3줄로 짧게 쓰고, 다음 세 개의 코드 블록을 이 순서로 각각 파일 전체 내용으로 출력하세요.
\`\`\`html
...view.html 전체...
\`\`\`
\`\`\`css
...style.css 전체...
\`\`\`
\`\`\`js
...script.js 전체...
\`\`\`
변경이 필요 없는 파일도 전체 내용을 그대로 다시 출력하세요.

## 결정 메모
- "결정 메모"는 사용자가 앱 전체에서 늘 지키기로 한 규칙입니다. 반드시 지키세요. 이번 요청과 충돌하면 이번 요청을 따르고 설명에 한 줄로 알리세요.
- 이번 요청에서 사용자가 앞으로도 계속 지킬 규칙을 새로 정했다면(예: "항상 …", "앞으로 …", "…는 하지 마"), 코드 블록들 뒤에
  \`\`\`memo 블록을 두고 한 줄에 하나씩 짧게 적으세요. 이번 작업에만 해당하는 내용이나 이미 메모에 있는 내용은 적지 말고, 없으면 블록을 생략하세요.`;

// 응답의 ```memo 블록 → 결정 메모에 추가할 후보 줄들
export function parseMemo(text) {
  const m = String(text || '').match(/```memo[^\n]*\n([\s\S]*?)```/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter((l) => l && l.length <= 200).slice(0, 5);
}

// 결정 메모와 최근 요청을 프롬프트 조각으로
export function memoSection(decisions) {
  return decisions?.trim() ? `\n# 결정 메모 (사용자가 정한 규칙 — 반드시 지킬 것)\n${decisions.trim()}\n` : '';
}

function historySection(history) {
  if (!history?.length) return '';
  const clip = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 240);
  return `\n# 이 영역에 대한 최근 요청 (오래된 것 → 최근. 이미 코드에 반영됨 — 흐름 참고용, 다시 하지 마세요)\n${history.map((h) => `- [${h.when}] ${clip(h.text)}`).join('\n')}\n`;
}

// 가져온 앱은 전역 CSS/JS 위에서 돌아가므로 규칙을 바꿔 알려 준다 (그리드로 재배치한 뒤에도)
const FLOW_RULES = `# 가져온 앱 안내 (위 규칙보다 우선)
이 앱은 기존 단일 HTML 앱을 가져온 것입니다.
- 전역 스타일은 shared/global.css, 기존 로직은 shared/app.js(전역 스크립트, 영역 마크업 뒤에 실행)에 있습니다.
- 마크업의 id, class, onclick 등은 app.js 가 참조하므로 꼭 필요한 경우가 아니면 바꾸지 마세요.
- 이 영역에 새로 넣는 스타일은 style.css 에 쓰되 전역 클래스와 충돌하지 않게 하세요.
- 기존 전역 함수의 동작을 바꿔야 하면 script.js 에서 window.함수명 = function (...) { ... } 처럼 다시 정의하세요
  (app.js 의 함수 선언은 전역이므로 onclick 과 다른 함수 호출 모두 새 정의를 따릅니다).
- shared/head.html 에 로드된 라이브러리는 그대로 써도 됩니다.
- 전역 CSS 는 원래 한 페이지(위→아래 문서)를 기준으로 쓰여 있어, 그리드 칸에 넣으면 position: sticky/fixed, top, 100vh 기준 높이,
  바깥 margin 이 칸과 어긋날 수 있습니다. 아래 "관련 전역 CSS" 에 그런 규칙이 있으면 style.css 에서 같은 선택자(#id 면 #id)로 덮으세요.
  클래스 선택자는 전역 #id 규칙을 이기지 못합니다.`;

// 영역 마크업의 id·class 를 쓰는 전역 CSS 규칙만 골라 낸다 (전체를 보내기엔 큼)
export function relatedCss(html, css, limit = 4000) {
  if (!css?.trim()) return '';
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const classes = new Set([...html.matchAll(/\sclass\s*=\s*["']([^"']+)["']/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  const tokens = [...[...ids].map((x) => `#${x}`), ...[...classes].map((x) => `.${x}`)];
  const hit = (sel) => tokens.some((t) => new RegExp(`${t.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}(?![\\w-])`).test(sel));
  let out = '';
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!hit(sel)) continue;
    const rule = `${sel}{${m[2].trim()}}\n`;
    if (out.length + rule.length > limit) {
      out += '/* … 생략 */\n';
      break;
    }
    out += rule;
  }
  return out;
}

// 칸의 대략적인 크기 (1366×768 화면, 화면 채우기 기준) — AI 가 내용 밀도를 정할 수 있게
function cellSize(layout, region) {
  const g = layout.grid;
  if (layout.mode === 'flow' || !g.fill) return '';
  const colW = (1366 - g.gap * (g.cols + 1)) / g.cols;
  const rowH = (768 - g.gap * (g.rows + 1)) / g.rows;
  return ` (1366×768 화면에서 약 ${Math.round(colW * region.w + g.gap * (region.w - 1))}×${Math.round(rowH * region.h + g.gap * (region.h - 1))}px)`;
}

export function buildPrompt({ layout, region, files, request, shared = {}, inherited = [], projectRequest = '', measured = '', decisions = '', history = [] }) {
  const projectText = projectRequest.trim()
    ? `\n# 프로젝트 전체 요청 (이 영역 작업은 그 일부입니다. 이 영역에 해당하는 부분만 구현하세요)\n${projectRequest.trim()}\n`
    : '';
  const inheritedText = inherited.length
    ? `\n## 이 영역에도 적용되는 다른 영역의 코드 (수정 대상 아님, 참고용)\n${inherited
        .map((x) => `### ${x.id} — ${x.why}\n${x.css.trim() ? `\`\`\`css\n${x.css.trim()}\n\`\`\`\n` : ''}${x.js.trim() ? `\`\`\`js\n${x.js.trim()}\n\`\`\`\n` : ''}`)
        .join('')}`
    : '';
  const flow = layout.mode === 'flow';
  const pos = (r, parent) =>
    flow && parent === layout ? '' : ` : 열 ${r.x + 1}~${r.x + r.w}/${parent.grid.cols}, 행 ${r.y + 1}~${r.y + r.h}/${parent.grid.rows}`;
  const all = flatten(layout);
  const others = all
    .filter((e) => e.region.id !== region.id)
    .map(({ region: r, parent, depth }) =>
      `${'  '.repeat(depth)}- ${r.id} (${r.title || '이름 없음'})${pos(r, parent)}${isContainer(r) ? ' [안쪽 레이아웃]' : ''}${r.summary ? ` — ${r.summary}` : ''}`)
    .join('\n');
  const self = all.find((e) => e.region.id === region.id);
  const parentInfo = self && self.parent !== layout ? `\n상위 영역: ${self.parent.id} (${self.parent.title || ''}) 의 안쪽 레이아웃 ${self.parent.grid.cols}열 × ${self.parent.grid.rows}행` : '';
  // 가져온 앱(전역 app.js 가 있음)은 그리드로 재배치한 뒤에도 같은 맥락이 필요하다
  const imported = flow || Boolean(shared.js?.trim());
  const flowContext = imported
    ? `
${FLOW_RULES}

## 로드된 라이브러리 (shared/head.html)
${(shared.head || '').trim() || '(없음)'}

## 이 영역과 관련된 app.js 코드 (발췌)
\`\`\`js
${relatedCode(files.html, shared.js || '') || '// (관련 코드를 찾지 못함)'}
\`\`\`

## 이 영역 요소에 적용되는 전역 CSS (shared/global.css 발췌)
\`\`\`css
${relatedCss(files.html, shared.css || '') || '/* (없음) */'}
\`\`\`
`
    : '';

  return `# 앱
이름: ${layout.name}
${layout.appPrompt ? `설명:\n${layout.appPrompt}\n` : ''}${memoSection(decisions)}
${flow ? '레이아웃: 가져온 앱 (문서 흐름)' : `그리드: ${layout.grid.cols}열 × ${layout.grid.rows}행`}
${flowContext}
# 다른 영역
${others || '(없음)'}

# 구현할 영역
ID: ${region.id}
이름: ${region.title || region.id}
위치: 열 ${region.x + 1}~${region.x + region.w} (${region.w}칸), 행 ${region.y + 1}~${region.y + region.h} (${region.h}칸)${self?.parent === layout ? cellSize(layout, region) : ''}${parentInfo}
${inheritedText}
## 현재 view.html
\`\`\`html
${files.html}
\`\`\`
## 현재 style.css
\`\`\`css
${files.css}
\`\`\`
## 현재 script.js
\`\`\`js
${files.js}
\`\`\`
${measured.trim() ? `\n## 지금 화면에서 잰 이 영역 (IDE 가 미리보기에서 측정한 값)\n${measured.trim()}\n` : ''}${historySection(history)}${projectText}
# 요청
${request}`;
}

// images: [{ mime, data(base64) }] — 영역 화면 캡처 (설정에서 켰을 때만)
export async function* generate({ apiKey, model, prompt, system = SYSTEM, images = [] }) {
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })), { type: 'text', text: prompt }]
    : prompt;
  const params = {
    model,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content }],
  };
  // 정책 거절 시 서버 측에서 다른 모델로 이어서 처리 (Haiku 는 미지원)
  if (!model.startsWith('claude-haiku')) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = params.betas ? client.beta.messages.stream(params) : client.messages.stream(params);

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'delta', text: event.delta.text };
    }
  }
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('모델이 요청을 거절했습니다. 프롬프트를 바꿔 보세요.');
  if (message.stop_reason === 'max_tokens') throw new Error('출력이 너무 길어 중간에 잘렸습니다. 요청을 나눠 보세요.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  yield { type: 'final', text, usage: message.usage };
}

// 응답 텍스트에서 html/css/js 코드 블록 추출 (없는 블록은 결과에서 빠짐)
export function parseFiles(text) {
  const out = {};
  const re = /```(html|css|js|javascript)[^\n]*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1] === 'javascript' ? 'js' : m[1];
    out[key] = m[2] + '\n';
  }
  return out;
}

// 영역 마크업이 참조하는 id·함수를 app.js 에서 찾아 관련 부분만 발췌 (전체를 보내기엔 너무 큼)
export function relatedCode(html, js, limit = 16000) {
  if (!js.trim()) return '';
  const lines = js.split('\n');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const fns = new Set();
  for (const m of html.matchAll(/\son\w+="([^"]*)"/g)) {
    for (const f of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) fns.add(f[1]);
  }
  const picked = new Set();
  // 함수 정의는 본문 전체(최대 60줄)
  for (const fn of fns) {
    const re = new RegExp(`(function\\s+${escapeRe(fn)}\\s*\\(|\\b(const|let|var)\\s+${escapeRe(fn)}\\s*=)`);
    const start = lines.findIndex((l) => re.test(l));
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < lines.length && i < start + 60; i++) {
      picked.add(i);
      depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (depth <= 0 && i > start) break;
    }
  }
  // id 를 쓰는 줄
  for (const id of ids) {
    const re = new RegExp(`['"\`]#?${escapeRe(id)}['"\`]`);
    lines.forEach((l, i) => re.test(l) && picked.add(i));
  }
  let out = '';
  let prev = -2;
  for (const i of [...picked].sort((a, b) => a - b)) {
    const line = `${String(i + 1).padStart(5)}: ${lines[i].slice(0, 400)}\n`;
    if (out.length + line.length > limit) {
      out += '// ... (생략)\n';
      break;
    }
    if (i !== prev + 1 && out) out += '// ...\n';
    out += line;
    prev = i;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 모델이 규칙을 어기고 빌드 래퍼까지 직접 써 넣은 경우 벗겨낸다 (작은 로컬 모델에서 흔함)
export function normalizeFiles(files) {
  const out = { ...files };
  if (out.html) {
    const m = out.html.match(/^\s*<section[^>]*data-region[^>]*>([\s\S]*)<\/section>\s*$/i);
    if (m) out.html = dedent(m[1]);
    out.html = out.html.replace(/\s+data-region=(["'])[^"']*\1/g, '');
  }
  if (out.css) {
    const m = out.css.match(/^\s*@scope\s*\(\s*\[data-region[^\]]*\]\s*\)\s*\{([\s\S]*)\}\s*$/);
    if (m) out.css = dedent(m[1]);
  }
  if (out.js) {
    const m = out.js.match(/^\s*\(\s*function\s*\(\s*root\s*,\s*app\s*\)\s*\{([\s\S]*)\}\s*\)\s*\(.*\)\s*;?\s*$/);
    if (m) out.js = dedent(m[1]);
  }
  return out;
}

function dedent(src) {
  const lines = src.replace(/^\n+|\s+$/g, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n') + '\n';
}

export function errorMessage(err) {
  if (err instanceof AuthenticationError) return 'API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.';
  if (err instanceof RateLimitError) return '요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.';
  if (err instanceof APIConnectionError) return 'API 서버에 연결하지 못했습니다. 네트워크를 확인하세요.';
  if (err instanceof APIError && err.status) return `API 오류 (${err.status}): ${err.message}`;
  if (/apiKey|authToken|API key/i.test(err?.message || '')) return 'API 키가 없습니다. ⚙️ 설정에서 Anthropic API 키를 입력하세요.';
  return err?.message || String(err);
}
