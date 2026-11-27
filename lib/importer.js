// 기존 단일 HTML 웹앱 → IDE 프로젝트 (AI 없이 구조만 분해)
// - <head> 의 CDN·폰트 링크 → shared/head.html
// - 모든 <style> → shared/global.css (스코프 없이 그대로)
// - 인라인 <script> → shared/app.js (전역 그대로, 영역 마크업 뒤에 실행)
// - <body> 의 최상위 블록 → 영역 (연속된 <dialog> 는 한 영역으로 묶음)
// 원본 텍스트를 위치 정보로 잘라 쓰므로 마크업이 한 글자도 바뀌지 않는다.
import { parse } from 'parse5';

const TAG_LABEL = {
  header: '헤더', nav: '내비게이션', main: '메인', aside: '사이드', footer: '푸터',
  section: '섹션', details: '패널', form: '폼', dialog: '대화상자', div: '블록', template: '템플릿',
};

export function importHtml(src) {
  const doc = parse(src, { sourceCodeLocationInfo: true });
  const html = doc.childNodes.find((n) => n.nodeName === 'html');
  const head = html.childNodes.find((n) => n.nodeName === 'head');
  const body = html.childNodes.find((n) => n.nodeName === 'body');
  const slice = (n) => src.slice(n.sourceCodeLocation.startOffset, endOf(n));

  const out = { name: '', lang: attr(html, 'lang') || 'ko', css: [], js: [], head: [], module: false, blocks: [] };

  for (const n of head.childNodes) {
    if (!n.sourceCodeLocation) continue;
    if (n.nodeName === 'title') out.name = textOf(n).trim();
    else if (n.nodeName === 'meta' && (attr(n, 'charset') || attr(n, 'name') === 'viewport')) continue;
    else if (n.nodeName === 'style') out.css.push(textOf(n));
    else if (n.nodeName === '#text' && !n.value.trim()) continue;
    else out.head.push(slice(n));
  }

  let dialogs = null;
  for (const n of body.childNodes) {
    if (!n.sourceCodeLocation) continue;
    if (n.nodeName === '#text' && !n.value.trim()) continue;
    if (n.nodeName === '#comment') continue;
    if (n.nodeName === 'style') {
      out.css.push(textOf(n));
      continue;
    }
    if (n.nodeName === 'script') {
      if (attr(n, 'src')) out.head.push(slice(n));
      else if (isJs(n)) {
        out.js.push(textOf(n));
        if (attr(n, 'type') === 'module') out.module = true;
      } else out.blocks.push({ nodes: [n], html: slice(n) }); // JSON 데이터 등
      continue;
    }
    if (n.nodeName === 'dialog') {
      if (!dialogs) out.blocks.push((dialogs = { nodes: [], html: '' }));
      dialogs.nodes.push(n);
      dialogs.html += (dialogs.html ? '\n' : '') + slice(n);
      continue;
    }
    dialogs = null;
    out.blocks.push({ nodes: [n], html: slice(n) });
  }

  const used = new Set();
  let y = 0;
  const regions = out.blocks.map((b, i) => {
    const first = b.nodes[0];
    const many = b.nodes.length > 1;
    const id = uniqueId(many ? 'dialogs' : baseId(first, i), used);
    const lines = b.html.split('\n').length;
    const h = Math.max(1, Math.min(4, Math.ceil(lines / 40)));
    const region = { id, title: titleOf(first, many ? b.nodes.length : 0), color: '', x: 0, y, w: 12, h, html: b.html.trim() + '\n' };
    y += h;
    return region;
  });

  return {
    layout: {
      name: out.name || '가져온 앱',
      appPrompt: '',
      mode: 'flow',
      lang: out.lang,
      appJsModule: out.module,
      bodyAttrs: body.sourceCodeLocation ? body.attrs.map((a) => [a.name, a.value]) : [],
      grid: { cols: 12, rows: Math.max(y, 1), gap: 0, fill: false, rowHeight: 60 },
    },
    regions,
    shared: {
      css: out.css.join('\n').trim() + '\n',
      js: out.js.join('\n;\n').trim() + '\n',
      head: out.head.join('\n') + (out.head.length ? '\n' : ''),
    },
  };
}

// 끝 태그가 생략된 요소도 마지막 자손까지 포함하도록 끝 위치를 계산
function endOf(n) {
  const loc = n.sourceCodeLocation;
  let end = loc.endTag?.endOffset ?? loc.endOffset ?? loc.startOffset;
  for (const c of n.childNodes || []) if (c.sourceCodeLocation) end = Math.max(end, endOf(c));
  if (n.content) for (const c of n.content.childNodes || []) if (c.sourceCodeLocation) end = Math.max(end, endOf(c));
  return end;
}

function attr(n, name) {
  return n.attrs?.find((a) => a.name === name)?.value;
}

function textOf(n) {
  return (n.childNodes || []).map((c) => (c.nodeName === '#text' ? c.value : textOf(c))).join('');
}

function isJs(n) {
  const type = (attr(n, 'type') || '').toLowerCase();
  return !type || type === 'module' || type.includes('javascript') || type.includes('ecmascript');
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30);
}

function baseId(n, i) {
  if (n.nodeName === '#text') return 'text';
  const cls = (attr(n, 'class') || '').split(/\s+/)[0];
  return slug(attr(n, 'id')) || slug(`${n.nodeName}-${cls}`) || slug(n.nodeName) || `block-${i + 1}`;
}

function uniqueId(base, used) {
  let id = base.slice(0, 36) || 'block';
  for (let k = 2; used.has(id); k++) id = `${base.slice(0, 33)}-${k}`;
  used.add(id);
  return id;
}

function titleOf(n, dialogCount) {
  if (dialogCount) return `대화상자 ${dialogCount}개`;
  if (n.nodeName === '#text') return '텍스트';
  const label = TAG_LABEL[n.nodeName] || n.nodeName;
  const summary = n.nodeName === 'details' && n.childNodes.find((c) => c.nodeName === 'summary');
  const heading = findFirst(n, (c) => /^h[1-3]$/.test(c.nodeName));
  const text = textOf(summary || heading || { childNodes: [] }).replace(/\s+/g, ' ').trim().slice(0, 20);
  const id = attr(n, 'id');
  return [label, text || (id ? `#${id}` : '')].filter(Boolean).join(' · ');
}

function findFirst(n, pred, depth = 0) {
  if (depth > 4) return null;
  for (const c of n.childNodes || []) {
    if (pred(c)) return c;
    const f = findFirst(c, pred, depth + 1);
    if (f) return f;
  }
  return null;
}
