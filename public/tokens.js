// 디자인 토큰: global.css 의 :root { --이름: 값 } (라이트)과 @media (prefers-color-scheme: dark) { :root { … } } (다크)를
// 읽고 고친다. 나머지 CSS 는 한 글자도 건드리지 않는다.

// 주석·문자열을 같은 길이의 공백으로 가려 중괄호 위치를 정확히 센다
function mask(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => ' '.repeat(m.length));
}

function closing(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

// :root 블록들의 위치. kind: 'light'(최상위) | 'dark'(prefers-color-scheme: dark 안)
function rootBlocks(css) {
  const masked = mask(css);
  const out = [];
  for (const m of masked.matchAll(/:root\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    // 이 위치를 감싸는 at-rule 찾기
    let depth = 0;
    let parentOpen = -1;
    for (let i = 0; i < m.index; i++) {
      if (masked[i] === '{') {
        depth++;
        if (depth === 1) parentOpen = i;
      } else if (masked[i] === '}') depth--;
    }
    const close = closing(masked, open);
    if (close < 0) continue;
    let kind = null;
    if (depth === 0) kind = 'light';
    else if (depth === 1) {
      const head = masked.slice(masked.lastIndexOf('}', parentOpen) + 1, parentOpen);
      if (/prefers-color-scheme\s*:\s*dark/.test(head)) kind = 'dark';
    }
    if (kind && !out.some((b) => b.kind === kind)) out.push({ kind, start: open + 1, end: close });
  }
  return out;
}

const DECL = /(--[\w-]+)\s*:\s*([^;}]+?)\s*(;|(?=\}|$))/g;

export function readTokens(css) {
  const tokens = new Map();
  for (const b of rootBlocks(css)) {
    for (const m of css.slice(b.start, b.end).matchAll(DECL)) {
      const t = tokens.get(m[1]) || { name: m[1], light: '', dark: '' };
      t[b.kind] = m[2].trim();
      tokens.set(m[1], t);
    }
  }
  return { tokens: [...tokens.values()], hasDark: rootBlocks(css).some((b) => b.kind === 'dark') };
}

// 토큰 하나의 값을 바꾼다 (없으면 그 블록 끝에 추가, 블록이 없으면 만든다). value 가 '' 면 지운다
export function setToken(css, kind, name, value) {
  let blocks = rootBlocks(css);
  let b = blocks.find((x) => x.kind === kind);
  if (!b) {
    if (!value) return css;
    css = kind === 'light'
      ? `:root {\n}\n${css}`
      : `${css.trimEnd()}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n  }\n}\n`;
    blocks = rootBlocks(css);
    b = blocks.find((x) => x.kind === kind);
  }
  const body = css.slice(b.start, b.end);
  const re = new RegExp(`(^|[\\s;{])(${name.replace(/[-]/g, '\\-')})\\s*:\\s*([^;}]+?)\\s*(;|(?=\\}|$))`);
  const m = body.match(re);
  let next;
  if (m) {
    const at = m.index + m[1].length;
    next = value
      ? body.slice(0, at) + `${name}: ${value};` + body.slice(at + m[0].length - m[1].length)
      : body.slice(0, at) + body.slice(at + m[0].length - m[1].length).replace(/^\s*\n/, '');
  } else {
    if (!value) return css;
    const indent = kind === 'dark' ? '    ' : '  ';
    const trimmed = body.replace(/\s*$/, '');
    // 마지막 선언에 ; 이 없으면 붙여 준다 (아니면 새 줄이 앞 값에 이어져 버린다)
    const sep = !trimmed.trim() || /;$/.test(trimmed) ? '' : ';';
    next = `${trimmed}${sep}\n${indent}${name}: ${value};\n${kind === 'dark' ? '  ' : ''}`;
  }
  return css.slice(0, b.start) + next + css.slice(b.end);
}

// 다크 모드 블록을 라이트 값으로 채워 만든다 (색만 나중에 바꾸면 되게)
export function addDarkFromLight(css) {
  const { tokens } = readTokens(css);
  for (const t of tokens) if (!t.dark && t.light) css = setToken(css, 'dark', t.name, t.light);
  return css;
}

export const isColor = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v).trim());
export const toHex6 = (v) => {
  const s = String(v).trim();
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
};
