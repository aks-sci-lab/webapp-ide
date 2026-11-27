// 레이아웃 트리 (서버·편집기 공용)
// 앱(layout) 과 "안쪽 레이아웃"을 가진 영역은 둘 다 { grid, regions } 를 가진 컨테이너.
// 영역 ID 는 트리 전체에서 유일하고, 파일은 regions/<id>/ 에 평평하게 저장된다.

export const DEFAULT_INNER_GRID = { cols: 12, rows: 12, gap: 8 };

export const isContainer = (r) => Array.isArray(r?.regions) && r.regions.length > 0;

export function getScreens(layout) {
  if (Array.isArray(layout?.screens) && layout.screens.length) return layout.screens;
  return [{
    id: 'main',
    title: '메인 화면',
    grid: layout?.grid || { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
    regions: layout?.regions || [],
  }];
}

export function activeScreenOf(layout, screenId) {
  const list = getScreens(layout);
  return list.find((s) => s.id === (screenId || layout?.activeScreen)) || list[0];
}

// 트리를 깊이 우선으로 펼친 목록 [{ region, parent, depth, screen }]
export function flatten(container, depth = 0, out = [], screen = null) {
  if (depth === 0 && Array.isArray(container?.screens) && container.screens.length) {
    for (const sc of container.screens) {
      flatten(sc, 0, out, sc.id);
    }
    return out;
  }
  for (const region of sorted(container?.regions || [])) {
    out.push({ region, parent: container, depth, screen });
    if (isContainer(region)) flatten(region, depth + 1, out, screen);
  }
  return out;
}

export function find(root, id) {
  return flatten(root).find((e) => e.region.id === id) || null;
}

// 루트에서 id 영역까지 거치는 컨테이너 영역 id 목록 (자기 자신 제외)
export function ancestors(root, id) {
  const walk = (c, trail) => {
    for (const r of c?.regions || []) {
      if (r.id === id) return trail;
      if (isContainer(r)) {
        const t = walk(r, [...trail, r.id]);
        if (t) return t;
      }
    }
    return null;
  };
  if (Array.isArray(root?.screens) && root.screens.length) {
    for (const sc of root.screens) {
      const t = walk(sc, []);
      if (t) return t;
    }
    return [];
  }
  return walk(root, []) || [];
}

export function containerAt(root, path) {
  let c = root;
  for (const id of path) {
    const next = (c.regions || []).find((r) => r.id === id);
    if (!next) break;
    c = next;
  }
  return c;
}

export function sorted(regions) {
  return [...regions].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function fits(container, rect, ignore = []) {
  const { cols, rows } = container.grid;
  if (rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1) return false;
  if (rect.x + rect.w > cols || rect.y + rect.h > rows) return false;
  return !container.regions.some((r) => !ignore.includes(r.id) && overlaps(r, rect));
}

// 여러 영역이 빈틈없이 하나의 직사각형을 이루는지 (합치기 조건)
export function unionRect(regions) {
  const x = Math.min(...regions.map((r) => r.x));
  const y = Math.min(...regions.map((r) => r.y));
  const w = Math.max(...regions.map((r) => r.x + r.w)) - x;
  const h = Math.max(...regions.map((r) => r.y + r.h)) - y;
  const area = regions.reduce((s, r) => s + r.w * r.h, 0);
  return area === w * h ? { x, y, w, h } : null;
}

// size 칸을 n 조각으로 (앞쪽 조각이 나머지를 하나씩 더 가짐)
export function splitSizes(size, n) {
  const base = Math.floor(size / n);
  return Array.from({ length: n }, (_, i) => base + (i < size % n ? 1 : 0));
}

export function uniqueId(root, base) {
  const ids = new Set(flatten(root).map((e) => e.region.id));
  let id = base.slice(0, 36);
  for (let k = 2; ids.has(id); k++) id = `${base.slice(0, 33)}-${k}`;
  return id;
}
