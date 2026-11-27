// AI 가 만든 영역 코드를 저장하기 전에 검사한다. 문제가 있으면 그 내용을 AI 에게 돌려줘 다시 고치게 한다.
import vm from 'node:vm';
import { lostIds } from './features.js';

// script.js 문법 검사 (실행하지 않고 해석만): 빌드 때와 같은 함수 래퍼로 감싸서
export function jsSyntaxError(js) {
  if (!js?.trim()) return null;
  try {
    new vm.Script(`(function (root, app) {\n${js}\n})`);
    return null;
  } catch (e) {
    return e.message;
  }
}

// CSS 중괄호 짝 (주석·문자열 제외)
export function cssBraceError(css) {
  if (!css?.trim()) return null;
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let depth = 0;
  for (const c of src) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return '닫는 } 가 여는 { 보다 많습니다';
  }
  return depth ? `여는 { 가 ${depth}개 닫히지 않았습니다` : null;
}

// 영역 자신(root / :scope)의 칸 위치·크기를 코드가 바꾸려 하는지 — 칸은 IDE 레이아웃이 정한다
const ROOT_STYLE_JS = /\broot\s*\.\s*(style\s*\.\s*(gridArea|gridColumn|gridRow|gridColumnStart|gridColumnEnd|gridRowStart|gridRowEnd|position|cssText)\b|style\s*\.\s*setProperty\s*\(\s*['"](grid-|position)|setAttribute\s*\(\s*['"]style['"])/;
const SCOPE_LAYOUT_PROPS = /(^|[;{\s])(grid-area|grid-column|grid-row|grid-column-start|grid-column-end|grid-row-start|grid-row-end)\s*:|position\s*:\s*(fixed|absolute)/;

export function rootLayoutProblems(parsed) {
  const out = [];
  const m = parsed.js?.match(ROOT_STYLE_JS);
  if (m) out.push(`script.js 가 영역 자신의 배치를 바꿉니다 (${m[0].trim()}). 칸 위치·크기는 IDE 레이아웃이 정하므로 root.style 의 grid·position 을 바꾸지 말고, 필요하면 클래스만 토글하세요`);
  const css = (parsed.css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const r of css.matchAll(/(?<=^|\})\s*([^{}]*:scope[^{}]*)\{([^{}]*)\}/g)) {
    const hit = r[2].match(SCOPE_LAYOUT_PROPS);
    if (hit) {
      out.push(`style.css 의 "${r[1].trim()}" 가 영역 자신의 배치(${hit[0].replace(/[;{\s]/g, '').replace(/:$/, '')})를 바꿉니다. :scope 에는 grid-column·grid-row·position:fixed/absolute 를 쓰지 마세요 (칸은 IDE 레이아웃이 정함)`);
      break;
    }
  }
  return out;
}

// 문제 목록 (사람과 AI 가 함께 읽을 수 있는 문장). 없으면 빈 배열
export function checkRegionOutput({ before, parsed, appJs }) {
  const problems = [];
  if (!Object.keys(parsed).length) {
    problems.push({ kind: 'format', text: '응답에서 코드 블록을 찾지 못했습니다. ```html, ```css, ```js 코드 블록 세 개로 각 파일 전체를 출력하세요.' });
    return problems;
  }
  const lost = parsed.html !== undefined && appJs?.trim() ? lostIds(before.html, parsed.html, appJs) : [];
  if (lost.length) {
    problems.push({ kind: 'lost-ids', ids: lost, text: `기존 전역 스크립트가 쓰는 요소가 사라졌습니다. 다음 id 를 가진 요소를 그대로 유지하세요: ${lost.map((x) => '#' + x).join(', ')}` });
  }
  const js = jsSyntaxError(parsed.js);
  if (js) problems.push({ kind: 'js-syntax', text: `script.js 문법 오류: ${js}` });
  const css = cssBraceError(parsed.css);
  if (css) problems.push({ kind: 'css-syntax', text: `style.css 문법 오류: ${css}` });
  for (const text of rootLayoutProblems(parsed)) problems.push({ kind: 'root-layout-syntax', text }); // 방금 코드를 고치게 (…syntax 로 끝나야 그 코드를 바탕으로 재시도)
  return problems;
}
