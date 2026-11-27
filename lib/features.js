// 영역 마크업 → "기능" 목록. 기능 하나 = 최상위 블록 하나.
// 감싸는 요소가 하나뿐이면(<header> 안에 메뉴·버튼…) 그 안쪽 자식들을 기능으로 본다.
// 원본 텍스트를 위치로 잘라 쓰므로 블록을 다른 영역으로 옮겨도 마크업이 바뀌지 않는다.
import { parseFragment } from 'parse5';
import crypto from 'node:crypto';

const MAX_WRAP_DEPTH = 2;

export function analyze(html) {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const wrappers = [];
  let parent = frag;
  for (let d = 0; d < MAX_WRAP_DEPTH; d++) {
    const sig = significant(parent);
    const only = sig.length === 1 && sig[0].tagName ? sig[0] : null;
    // 이미 기능 ID 가 붙은 요소는 그 자체가 기능 (빈 영역으로 옮겨 온 블록이 쪼개지지 않게)
    if (!only || attr(only, 'data-feature') || significant(only).filter((n) => n.tagName).length < 2) break;
    wrappers.push(only);
    parent = only;
  }

  const blocks = [];
  let pendingStart = null; // 블록 앞의 주석은 그 블록에 붙인다
  let elementIndex = 0;
  for (const n of parent.childNodes || []) {
    if (!n.sourceCodeLocation) continue;
    if (n.nodeName === '#comment') {
      pendingStart ??= n.sourceCodeLocation.startOffset;
      continue;
    }
    if (n.nodeName === '#text' && !n.value.trim()) continue;
    const start = pendingStart ?? n.sourceCodeLocation.startOffset;
    pendingStart = null;
    const end = endOf(n);
    const block = { html: html.slice(start, end), start, end, ...describe(n) };
    if (n.tagName) {
      block.elementIndex = elementIndex++;
      block.fid = attr(n, 'data-feature') || '';
      // data-feature 를 넣을 자리: 시작 태그의 '>' (또는 '/>') 바로 앞
      const tagEnd = n.sourceCodeLocation.startTag.endOffset;
      block.attrAt = html[tagEnd - 2] === '/' ? tagEnd - 2 : tagEnd - 1;
      block.tokens = tokensOf(n);
    }
    blocks.push(block);
  }
  blocks.forEach((b, i) => {
    b.index = i;
    b.hash = crypto.createHash('sha1').update(b.html).digest('hex').slice(0, 12);
  });

  const inner = wrappers.at(-1);
  return {
    wrappers: wrappers.map((w) => ({
      tag: w.tagName,
      id: attr(w, 'id') || '',
      start: html.slice(w.sourceCodeLocation.startTag.startOffset, w.sourceCodeLocation.startTag.endOffset),
      end: w.sourceCodeLocation.endTag ? html.slice(w.sourceCodeLocation.endTag.startOffset, w.sourceCodeLocation.endTag.endOffset) : `</${w.tagName}>`,
    })),
    // 새 블록을 넣을 자리: 가장 안쪽 감싸는 요소의 닫는 태그 앞, 없으면 맨 끝
    insertAt: inner?.sourceCodeLocation.endTag ? inner.sourceCodeLocation.endTag.startOffset : html.length,
    blocks,
  };
}

// 블록 안의 id·class (CSS·JS 가 이 기능을 가리키는지 판단할 때 씀)
function tokensOf(n) {
  const ids = new Set();
  const classes = new Set();
  walk(n, (c) => {
    if (!c.tagName) return;
    const id = attr(c, 'id');
    if (id) ids.add(id);
    for (const k of (attr(c, 'class') || '').split(/\s+/)) if (k) classes.add(k);
  });
  return { ids: [...ids], classes: [...classes] };
}

// ── 안정적인 기능 ID ──
// 최상위 블록(요소)에 data-feature="f-xxxxxx" 를 붙인다. 옮기거나 내용을 고쳐도 같은 기능으로 추적하려고.
export function newFeatureId(taken) {
  let id;
  do id = `f-${crypto.randomBytes(3).toString('hex')}`;
  while (taken.has(id));
  taken.add(id);
  return id;
}

export function withFeatureIds(html, taken) {
  const a = analyze(html);
  const missing = a.blocks.filter((b) => b.tag !== '#text' && !b.fid);
  if (!missing.length) return { html, added: [] };
  let out = html;
  const added = [];
  for (const b of [...missing].sort((x, y) => y.attrAt - x.attrAt)) {
    const fid = newFeatureId(taken);
    out = `${out.slice(0, b.attrAt)} data-feature="${fid}"${out.slice(b.attrAt)}`;
    added.push({ fid, label: b.label });
  }
  return { html: out, added };
}

export function featureIdsIn(html) {
  return [...html.matchAll(/\sdata-feature="([^"]+)"/g)].map((m) => m[1]);
}

// 기능 블록 하나를 떼어 낸다 (앞뒤 빈 줄 정리)
export function removeBlock(html, fid) {
  const a = analyze(html);
  const b = a.blocks.find((x) => x.fid === fid);
  if (!b) throw new Error(`이 영역에 없는 기능입니다: ${fid}`);
  let s = b.start;
  let e = b.end;
  while (s > 0 && /[ \t]/.test(html[s - 1])) s--;
  if (html[e] === '\r') e++;
  if (html[e] === '\n') e++;
  return { html: html.slice(0, s) + html.slice(e), block: b };
}

// 기능 블록을 넣는다: 감싸는 요소가 있으면 그 안 끝(또는 처음)에, 없으면 맨 끝(또는 처음)에
export function insertBlock(html, blockHtml, position = 'end') {
  const a = analyze(html);
  const piece = blockHtml.trim();
  if (position === 'start') {
    const at = a.blocks[0]?.start ?? a.insertAt;
    return `${html.slice(0, at)}${piece}\n${html.slice(at)}`;
  }
  const at = a.insertAt;
  const before = html.slice(0, at).replace(/\s*$/, '');
  return `${before}${before ? '\n' : ''}${piece}\n${html.slice(at)}`;
}

// 대화상자(<dialog>)만 담은 영역: 화면 칸을 차지하지 않으므로 그리드에 배치하지 않는다
export function isOverlayHtml(html) {
  const { blocks } = analyze(html);
  return blocks.length > 0 && blocks.every((b) => b.tag === 'dialog');
}

// 영역 마크업에서 사라진 id 중 전역 스크립트가 쓰는 것 (가져온 앱이 깨지는지 검사)
export function lostIds(oldHtml, newHtml, js) {
  const ids = (h) => new Set([...h.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const after = ids(newHtml);
  return [...ids(oldHtml)].filter((id) => !after.has(id) && new RegExp(`['"\`#]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`\\s.:\\[]`).test(js));
}

// 블록들을 조각별로 다시 조립. 감싸는 요소는 조각마다 복제하되 id 는 첫 조각에만 둔다(중복 id 방지)
export function assemble(analysis, blockIndexes, first) {
  const inner = blockIndexes.map((i) => analysis.blocks[i].html.trim()).join('\n');
  if (!inner) return '';
  let out = inner;
  for (const w of [...analysis.wrappers].reverse()) {
    const start = first ? w.start : w.start.replace(/\s+id=("[^"]*"|'[^']*'|[^\s>]+)/i, '');
    out = `${start}\n${out}\n${w.end}`;
  }
  return out + '\n';
}

function describe(n) {
  if (!n.tagName) {
    const text = n.value.replace(/\s+/g, ' ').trim();
    return { tag: '#text', id: '', cls: '', label: text.slice(0, 30), text: text.slice(0, 80), counts: {}, fns: [] };
  }
  const id = attr(n, 'id') || '';
  const cls = (attr(n, 'class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  const counts = { 버튼: 0, 입력: 0, 링크: 0, 이미지: 0, 대화상자: 0 };
  const fns = new Set();
  walk(n, (c) => {
    if (!c.tagName) return;
    const type = (attr(c, 'type') || '').toLowerCase();
    if (c.tagName === 'button' || (c.tagName === 'input' && ['button', 'submit'].includes(type)) || (attr(c, 'onclick') && c.tagName !== 'a')) counts.버튼++;
    else if (['input', 'select', 'textarea'].includes(c.tagName)) counts.입력++;
    if (c.tagName === 'a') counts.링크++;
    if (['img', 'canvas', 'svg', 'video'].includes(c.tagName)) counts.이미지++;
    if (c.tagName === 'dialog') counts.대화상자++;
    for (const a of c.attrs || []) {
      if (!a.name.startsWith('on')) continue;
      for (const m of a.value.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (!/^(if|for|while|return|function)$/.test(m[1])) fns.add(m[1]);
    }
  });
  const text = textOf(n).replace(/\s+/g, ' ').trim();
  return {
    tag: n.tagName,
    id,
    cls,
    label: labelOf(n) || (id ? `#${id}` : cls ? `.${cls}` : n.tagName),
    text: text.slice(0, 80),
    counts: Object.fromEntries(Object.entries(counts).filter(([, v]) => v)),
    fns: [...fns].slice(0, 8),
  };
}

// 사람이 읽을 이름: aria-label/title → 제목 → summary/legend/label → 첫 버튼 → 첫 글자들
function labelOf(n) {
  const own = attr(n, 'aria-label') || attr(n, 'title');
  if (own) return clip(own);
  const pick = (pred) => {
    let hit = null;
    walk(n, (c) => {
      if (!hit && c.tagName && pred(c)) hit = c;
    });
    return hit && clip(textOf(hit));
  };
  return (
    pick((c) => /^h[1-6]$/.test(c.tagName)) ||
    pick((c) => ['summary', 'legend', 'caption'].includes(c.tagName)) ||
    (n.tagName === 'dialog' ? '' : pick((c) => c.tagName === 'label')) ||
    pick((c) => c.tagName === 'button') ||
    clip(directText(n))
  );
}

const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);

function significant(n) {
  return (n.childNodes || []).filter((c) => c.tagName || (c.nodeName === '#text' && c.value.trim()));
}

function walk(n, fn) {
  fn(n);
  for (const c of n.childNodes || []) walk(c, fn);
  if (n.content) walk(n.content, fn);
}

function textOf(n) {
  if (n.nodeName === '#text') return n.value;
  if (['script', 'style'].includes(n.tagName)) return '';
  return (n.childNodes || []).map(textOf).join(' ');
}

function directText(n) {
  return (n.childNodes || []).filter((c) => c.nodeName === '#text').map((c) => c.value).join(' ');
}

function attr(n, name) {
  return n.attrs?.find((a) => a.name === name)?.value;
}

function endOf(n) {
  const loc = n.sourceCodeLocation;
  let end = loc.endTag?.endOffset ?? loc.endOffset ?? loc.startOffset;
  for (const c of n.childNodes || []) if (c.sourceCodeLocation) end = Math.max(end, endOf(c));
  return end;
}
