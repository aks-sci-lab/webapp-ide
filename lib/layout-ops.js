// 영역 분할 / 합치기 / 안쪽 레이아웃 풀기 — 레이아웃과 영역 파일을 함께 바꾼다
import { find, flatten, isContainer, unionRect, splitSizes, uniqueId, sorted, DEFAULT_INNER_GRID } from '../public/tree.js';
import { retarget } from './project.js';
import { analyze, assemble } from './features.js';

const DIRS = { h: '좌우', v: '상하' };

// dir: 'h' = 좌우(열 방향)로, 'v' = 상하(행 방향)로 count 개
// inner: false = 같은 레벨 형제로 나눔, true = 영역 안에 레이아웃을 만들고 그 안에서 나눔
// assign: 기능(최상위 블록)마다 몇 번째 조각으로 보낼지 [0..count-1]. 없으면 전부 첫 조각
// titles: 조각 이름
export async function splitRegion(project, id, { dir, count, inner, assign, titles = [] }) {
  if (!DIRS[dir]) throw new Error('분할 방향이 올바르지 않습니다');
  count = Number(count);
  if (!(count >= 2 && count <= 12)) throw new Error('2~12 개로만 나눌 수 있습니다');
  const layout = await project.getLayout();
  const hit = find(layout, id);
  if (!hit) throw new Error('없는 영역입니다');
  const { region, parent } = hit;
  if (isContainer(region)) throw new Error('이미 안쪽 레이아웃이 있습니다. 안쪽에 들어가서 나누세요');
  const files = await project.readRegion(id);
  const notes = await project.readFeatureNotes(id);
  const flowRoot = parent === layout && layout.mode === 'flow';
  const htmls = distribute(files.html, count, assign);
  const title = (i) => String(titles[i] || '').trim() || `${region.title || id} ${i + 1}`;

  if (inner) {
    const grid = { ...DEFAULT_INNER_GRID };
    const along = dir === 'h' ? grid.cols : grid.rows;
    if (count > along) throw new Error(`안쪽 그리드보다 많이 나눌 수 없습니다 (최대 ${along})`);
    let pos = 0;
    region.grid = grid;
    region.regions = splitSizes(along, count).map((size, i) => {
      const r = {
        id: uniqueId(layout, `${id}-${i + 1}`),
        title: title(i),
        color: region.color,
        ...(dir === 'h' ? { x: pos, y: 0, w: size, h: grid.rows } : { x: 0, y: pos, w: grid.cols, h: size }),
      };
      pos += size;
      return r;
    });
    await project.saveLayout(layout);
    // 마크업은 기능별로 안쪽 조각에 나눠 담고, CSS·JS 는 바깥 영역에 그대로 둔다.
    // 바깥 영역의 스코프·root 가 안쪽 조각을 모두 감싸므로 기존 스타일과 스크립트가 그대로 동작한다.
    for (const [i, r] of region.regions.entries()) {
      await project.writeRegion(r.id, { html: htmls[i], prompt: i === 0 ? files.prompt : '' }, { backup: false });
      await project.writeFeatureNotes(r.id, notes); // 블록 해시 기준이라 그대로 써도 맞는 것만 쓰인다
    }
    await project.writeRegion(id, { html: '' });
    return { layout, focus: region.regions[0].id };
  }

  if (flowRoot && dir === 'h') throw new Error('가져온 앱(문서 흐름)의 최상위는 좌우로 나눌 수 없습니다. "안쪽으로 나누기"를 쓰세요');
  const sizeKey = dir === 'h' ? 'w' : 'h';
  const posKey = dir === 'h' ? 'x' : 'y';
  if (region[sizeKey] < count) {
    if (!flowRoot) throw new Error(`${DIRS[dir]}로 ${count}칸이 안 됩니다 (현재 ${region[sizeKey]}칸). 먼저 크기를 키우세요`);
    // 문서 흐름에서는 아래 영역들을 밀어내고 높이를 늘린다
    const grow = count - region.h;
    for (const r of parent.regions) if (r !== region && r.y >= region.y + region.h) r.y += grow;
    region.h = count;
    parent.grid.rows += grow;
  }
  let pos = region[posKey];
  const sizes = splitSizes(region[sizeKey], count);
  const pieces = sizes.map((size, i) => {
    const r = i === 0 ? region : { id: uniqueId(layout, `${id}-${i + 1}`), color: region.color, x: region.x, y: region.y, w: region.w, h: region.h };
    r.title = i === 0 && !titles[0] ? region.title : title(i);
    r[posKey] = pos;
    r[sizeKey] = size;
    pos += size;
    return r;
  });
  parent.regions.push(...pieces.slice(1));
  // 형제로 나누면 공통 부모가 없으므로: CSS 는 내용을 받은 조각마다 복사하고,
  // JS 는 원래 영역에 두되 root 가 내용을 받은 조각들을 함께 가리키게 한다 (jsRoots)
  const filled = pieces.filter((_, i) => htmls[i].trim()).map((r) => r.id);
  if (files.js.trim() && filled.some((rid) => rid !== id)) region.jsRoots = [...new Set([id, ...filled])];
  await project.saveLayout(layout);
  for (const [i, r] of pieces.entries()) {
    const copyCss = files.css.trim() && htmls[i].trim();
    if (i === 0) await project.writeRegion(id, { html: htmls[0] });
    else await project.writeRegion(r.id, { html: htmls[i], css: copyCss ? files.css : '' }, { backup: false });
    if (i > 0) await project.writeFeatureNotes(r.id, notes);
  }
  return { layout, focus: id };
}

// 마크업을 기능(최상위 블록) 단위로 count 개 조각에 나눈다
function distribute(html, count, assign) {
  const a = analyze(html);
  const out = Array(count).fill('');
  if (!a.blocks.length || !Array.isArray(assign) || assign.length !== a.blocks.length) {
    out[0] = html;
    return out;
  }
  const groups = Array.from({ length: count }, (_, k) => a.blocks.filter((b) => Number(assign[b.index]) === k).map((b) => b.index));
  const firstFilled = groups.findIndex((g) => g.length);
  groups.forEach((g, k) => (out[k] = assemble(a, g, k === firstFilled)));
  return out;
}

// 같은 컨테이너 안의 영역들을 하나로. 첫 영역(위→아래, 왼→오른쪽 순)의 ID 가 남는다
export async function mergeRegions(project, ids) {
  if (!Array.isArray(ids) || ids.length < 2) throw new Error('합칠 영역을 2개 이상 고르세요');
  const layout = await project.getLayout();
  const hits = ids.map((id) => find(layout, id));
  if (hits.some((h) => !h)) throw new Error('없는 영역이 있습니다');
  const parent = hits[0].parent;
  if (hits.some((h) => h.parent !== parent)) throw new Error('같은 레이아웃 안의 영역끼리만 합칠 수 있습니다');
  const regions = sorted(hits.map((h) => h.region));
  if (regions.some(isContainer)) throw new Error('안쪽 레이아웃이 있는 영역은 먼저 "안쪽 레이아웃 풀기"를 하세요');
  const rect = unionRect(regions);
  if (!rect) throw new Error('합치면 빈틈없는 직사각형이 되는 영역들만 합칠 수 있습니다');

  const [target, ...rest] = regions;
  const merged = await mergeFiles(project, target.id, regions.map((r) => r.id));
  Object.assign(target, rect);
  parent.regions = parent.regions.filter((r) => !rest.includes(r));
  remapJsRoots(layout, rest.map((r) => r.id), target.id);
  await project.writeRegion(target.id, merged);
  await project.saveLayout(layout); // 빠진 영역 폴더는 .trash 로
  return { layout, focus: target.id };
}

// 안쪽 레이아웃의 영역들을 모두 바깥 영역 하나로 다시 합친다
export async function unwrapRegion(project, id) {
  const layout = await project.getLayout();
  const hit = find(layout, id);
  if (!hit) throw new Error('없는 영역입니다');
  const { region } = hit;
  if (!isContainer(region)) {
    delete region.regions;
    delete region.grid;
    await project.saveLayout(layout);
    return { layout, focus: id };
  }
  if (region.regions.some(isContainer)) throw new Error('더 안쪽에 레이아웃이 있습니다. 안쪽부터 풀어 주세요');
  const children = sorted(region.regions).map((r) => r.id);
  const merged = await mergeFiles(project, id, [id, ...children]);
  delete region.regions;
  delete region.grid;
  remapJsRoots(layout, children, id);
  await project.writeRegion(id, merged);
  await project.saveLayout(layout);
  return { layout, focus: id };
}

// 합쳐져 사라진 영역을 가리키던 jsRoots 를 남는 영역으로 바꾼다 (하나만 남으면 일반 root 로)
function remapJsRoots(layout, removed, targetId) {
  for (const { region } of flatten(layout)) {
    if (!region.jsRoots) continue;
    const ids = [...new Set(region.jsRoots.map((r) => (removed.includes(r) ? targetId : r)))];
    if (ids.length > 1) region.jsRoots = ids;
    else delete region.jsRoots;
  }
}

function moveFiles(files, fromId, toId) {
  return {
    html: retarget(files.html, fromId, toId),
    css: retarget(files.css, fromId, toId),
    js: retarget(files.js, fromId, toId),
    prompt: files.prompt,
  };
}

// 여러 영역의 파일을 이어 붙인다. JS 는 블록으로 감싸 변수 이름 충돌을 막는다
async function mergeFiles(project, targetId, ids) {
  const parts = [];
  const notes = {};
  for (const id of ids) {
    parts.push({ id, ...moveFiles(await project.readRegion(id), id, targetId) });
    Object.assign(notes, await project.readFeatureNotes(id));
  }
  await project.writeFeatureNotes(targetId, notes);
  // 내용이 있는 조각이 하나뿐이면 감싸지 않고 그대로 둔다. 같은 내용(나눌 때 복사된 CSS 등)은 한 번만
  const join = (key, wrap) => {
    const seen = new Set();
    const filled = parts.filter((p) => p[key].trim() && !seen.has(p[key].trim()) && seen.add(p[key].trim()));
    return filled.length === 1 ? filled[0][key].trim() : filled.map(wrap).join('\n');
  };
  return {
    html: join('html', (p) => (p.id === targetId ? p.html.trim() : `<!-- ${p.id} 에서 합침 -->\n${p.html.trim()}`)) + '\n',
    css: join('css', (p) => `/* ── ${p.id} ── */\n${p.css.trim()}`) + '\n',
    js: join('js', (p) => `/* ── ${p.id} ── */\n{\n${p.js.trim()}\n}`) + '\n',
    prompt: join('prompt', (p) => (ids.length > 1 ? `[${p.id}]\n${p.prompt.trim()}` : p.prompt.trim())),
  };
}
