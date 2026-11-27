// 직관적 레이아웃 편집 엔진: 자리 바꾸기(Swap) · 경계선 드래그(Splitter) · 원클릭 프리셋

export const LAYOUT_PRESETS = [
  { id: 'top-main', label: '상단+본문', title: '상단 헤더 + 아래 메인' },
  { id: 'sidebar-main', label: '사이드+본문', title: '상단 헤더 + 좌측 사이드바 + 메인' },
  { id: 'three-col', label: '3단 분할', title: '상단 헤더 + 좌/중/우 3단' },
  { id: 'top-main-bottom', label: '상·중·하', title: '상단 + 메인 + 하단 패널' },
  { id: 'grid-2x2', label: '2×2 격자', title: '균등 카드 격자 배치' },
];

// 현재 화면의 기존 영역들을 하나도 잃지 않고 선택한 프리셋 골격으로 재배치
export function applyLayoutPreset(regions, presetId, cols = 12, rows = 12) {
  const list = [...(regions || [])];
  const n = list.length;
  if (!n) return [];
  const next = list.map((r) => ({ ...r }));

  if (n === 1) {
    Object.assign(next[0], { x: 0, y: 0, w: cols, h: rows });
    return next;
  }

  const placeRow = (items, y, h) => {
    if (!items.length) return;
    const base = Math.floor(cols / items.length);
    let x = 0;
    items.forEach((r, i) => {
      const w = i === items.length - 1 ? cols - x : base;
      Object.assign(r, { x, y, w: Math.max(1, w), h: Math.max(1, h) });
      x += w;
    });
  };

  if (presetId === 'top-main') {
    const topH = Math.max(1, Math.min(2, Math.floor(rows / 6)));
    Object.assign(next[0], { x: 0, y: 0, w: cols, h: topH });
    placeRow(next.slice(1), topH, rows - topH);
    return next;
  }

  if (presetId === 'sidebar-main') {
    if (n === 2) {
      const sw = Math.max(2, Math.round(cols * 0.25));
      Object.assign(next[0], { x: 0, y: 0, w: sw, h: rows });
      Object.assign(next[1], { x: sw, y: 0, w: cols - sw, h: rows });
      return next;
    }
    const topH = Math.max(1, Math.min(2, Math.floor(rows / 6)));
    const sw = Math.max(2, Math.round(cols * 0.25));
    Object.assign(next[0], { x: 0, y: 0, w: cols, h: topH });
    Object.assign(next[1], { x: 0, y: topH, w: sw, h: rows - topH });
    const rest = next.slice(2);
    const baseH = Math.floor((rows - topH) / rest.length);
    let y = topH;
    rest.forEach((r, i) => {
      const h = i === rest.length - 1 ? rows - y : Math.max(1, baseH);
      Object.assign(r, { x: sw, y, w: cols - sw, h });
      y += h;
    });
    return next;
  }

  if (presetId === 'three-col') {
    const hasHeader = n >= 4;
    const topH = hasHeader ? Math.max(1, Math.min(2, Math.floor(rows / 6))) : 0;
    let start = 0;
    if (hasHeader) {
      Object.assign(next[0], { x: 0, y: 0, w: cols, h: topH });
      start = 1;
    }
    const mid = next.slice(start, start + 3);
    const tail = next.slice(start + 3);
    const tailH = tail.length ? Math.max(2, Math.floor((rows - topH) * 0.32)) : 0;
    const midH = rows - topH - tailH;
    if (mid.length === 3) {
      const w1 = Math.max(2, Math.round(cols * 0.22));
      const w3 = Math.max(2, Math.round(cols * 0.25));
      Object.assign(mid[0], { x: 0, y: topH, w: w1, h: midH });
      Object.assign(mid[1], { x: w1, y: topH, w: cols - w1 - w3, h: midH });
      Object.assign(mid[2], { x: cols - w3, y: topH, w: w3, h: midH });
    } else {
      placeRow(mid, topH, midH);
    }
    if (tail.length) placeRow(tail, topH + midH, tailH);
    return next;
  }

  if (presetId === 'top-main-bottom') {
    const topH = Math.max(1, Math.min(2, Math.floor(rows / 6)));
    const botH = n >= 3 ? Math.max(2, Math.floor(rows * 0.28)) : 0;
    const midH = rows - topH - botH;
    Object.assign(next[0], { x: 0, y: 0, w: cols, h: topH });
    if (n === 2) {
      Object.assign(next[1], { x: 0, y: topH, w: cols, h: rows - topH });
    } else {
      const midItems = n > 3 ? next.slice(1, n - 1) : [next[1]];
      placeRow(midItems, topH, midH);
      Object.assign(next[n - 1], { x: 0, y: topH + midH, w: cols, h: botH });
    }
    return next;
  }

  // grid-2x2 (또는 균등 2열 격자)
  const rowCount = Math.ceil(n / 2);
  const baseH = Math.floor(rows / rowCount);
  let y = 0;
  for (let row = 0; row < rowCount; row++) {
    const slice = next.slice(row * 2, row * 2 + 2);
    const h = row === rowCount - 1 ? rows - y : Math.max(1, baseH);
    placeRow(slice, y, h);
    y += h;
  }
  return next;
}

// 드래그 중인 포인터 아래에 있는 다른 영역(자리 바꾸기 대상) 찾기
export function findSwapTarget(regions, dragId, cell) {
  if (!cell) return null;
  return (regions || []).find((r) =>
    r.id !== dragId &&
    cell.col >= r.x && cell.col < r.x + r.w &&
    cell.row >= r.y && cell.row < r.y + r.h,
  ) || null;
}

export function swapRegionGeometry(a, b) {
  const tmp = { x: a.x, y: a.y, w: a.w, h: a.h };
  Object.assign(a, { x: b.x, y: b.y, w: b.w, h: b.h });
  Object.assign(b, tmp);
}

// 맞닿아 있는 영역들 사이의 공유 경계선(세로/가로 스플리터) 탐지
export function findSplitters(regions) {
  const list = regions || [];
  const out = [];

  // 세로 경계선 (좌우 크기 동시 조절)
  const vLines = new Set();
  for (const r of list) {
    if (r.x > 0) vLines.add(r.x);
  }
  for (const line of vLines) {
    const left = list.filter((r) => r.x + r.w === line);
    const right = list.filter((r) => r.x === line);
    if (!left.length || !right.length) continue;
    // 실제로 세로 구간이 겹치는 쌍만
    const touches = left.some((a) => right.some((b) => a.y < b.y + b.h && b.y < a.y + a.h));
    if (!touches) continue;
    const minY = Math.min(...left.map((r) => r.y), ...right.map((r) => r.y));
    const maxY = Math.max(...left.map((r) => r.y + r.h), ...right.map((r) => r.y + r.h));
    // 이동 가능한 최소/최대 선 위치 (각 영역 최소 1칸 보장)
    const minLine = Math.max(...left.map((r) => r.x + 1));
    const maxLine = Math.min(...right.map((r) => r.x + r.w - 1));
    if (minLine <= maxLine) {
      out.push({
        axis: 'v',
        line,
        start: minY,
        end: maxY,
        minLine,
        maxLine,
        beforeIds: left.map((r) => r.id),
        afterIds: right.map((r) => r.id),
      });
    }
  }

  // 가로 경계선 (상하 크기 동시 조절)
  const hLines = new Set();
  for (const r of list) {
    if (r.y > 0) hLines.add(r.y);
  }
  for (const line of hLines) {
    const top = list.filter((r) => r.y + r.h === line);
    const bottom = list.filter((r) => r.y === line);
    if (!top.length || !bottom.length) continue;
    const touches = top.some((a) => bottom.some((b) => a.x < b.x + b.w && b.x < a.x + a.w));
    if (!touches) continue;
    const minX = Math.min(...top.map((r) => r.x), ...bottom.map((r) => r.x));
    const maxX = Math.max(...top.map((r) => r.x + r.w), ...bottom.map((r) => r.x + r.w));
    const minLine = Math.max(...top.map((r) => r.y + 1));
    const maxLine = Math.min(...bottom.map((r) => r.y + r.h - 1));
    if (minLine <= maxLine) {
      out.push({
        axis: 'h',
        line,
        start: minX,
        end: maxX,
        minLine,
        maxLine,
        beforeIds: top.map((r) => r.id),
        afterIds: bottom.map((r) => r.id),
      });
    }
  }
  return out;
}

// 경계선을 targetLine 으로 이동 (양쪽 영역 크기 동시 조정)
export function applySplitterMove(regions, splitter, targetLine) {
  const clamped = Math.max(splitter.minLine, Math.min(splitter.maxLine, Math.round(targetLine)));
  if (clamped === splitter.line) return false;
  const byId = new Map((regions || []).map((r) => [r.id, r]));
  if (splitter.axis === 'v') {
    for (const id of splitter.beforeIds) {
      const r = byId.get(id);
      if (r) r.w = clamped - r.x;
    }
    for (const id of splitter.afterIds) {
      const r = byId.get(id);
      if (r) {
        const rightEnd = r.x + r.w;
        r.x = clamped;
        r.w = rightEnd - clamped;
      }
    }
  } else {
    for (const id of splitter.beforeIds) {
      const r = byId.get(id);
      if (r) r.h = clamped - r.y;
    }
    for (const id of splitter.afterIds) {
      const r = byId.get(id);
      if (r) {
        const bottomEnd = r.y + r.h;
        r.y = clamped;
        r.h = bottomEnd - clamped;
      }
    }
  }
  splitter.line = clamped;
  return true;
}
