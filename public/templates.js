// 새 프로젝트 레이아웃 템플릿 & 디자인 토큰 테마 프리셋 + 무료 오픈소스 CSS 스타일 킷
import { setToken } from './tokens.js';

export const FREE_STYLE_KITS = [
  {
    id: 'builtin',
    name: '기본 깔끔',
    desc: '외부 CDN 없이 가벼운 자체 스타일',
    head: '',
    decision: '외부 CSS 프레임워크 없이 가볍고 깔끔한 기본 CSS 변수(--primary, --surface 등)로 스타일링',
  },
  {
    id: 'pico',
    name: 'Pico CSS',
    desc: '클래스 없이도 폼·표·버튼이 예뻐짐 (MIT)',
    head: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">\n<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">',
    decision: 'Pico CSS v2 및 Pretendard 한글 폰트가 head.html에 로드되어 있으므로 시맨틱 HTML과 Pico 스타일을 활용해 깔끔하게 구성',
  },
  {
    id: 'tailwind',
    name: 'Tailwind CSS',
    desc: '모던 SaaS 유틸리티 스타일 (MIT)',
    head: '<script src="https://cdn.tailwindcss.com"></script>\n<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">',
    decision: 'Tailwind CSS Play CDN과 Pretendard 폰트가 head.html에 로드되어 있으므로 Tailwind 유틸리티 클래스로 모던하게 스타일링',
  },
  {
    id: 'daisyui',
    name: 'DaisyUI',
    desc: '카드·모달·배지 컴포넌트 즉시 사용 (MIT)',
    head: '<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">\n<script src="https://cdn.tailwindcss.com"></script>\n<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">',
    decision: 'DaisyUI 4 + Tailwind CSS + Pretendard 폰트가 head.html에 로드되어 있으므로 DaisyUI 컴포넌트 클래스(btn, card, badge, modal 등)를 적극 활용',
  },
  {
    id: 'bootstrap',
    name: 'Bootstrap 5',
    desc: '익숙하고 안정적인 대시보드 UI (MIT)',
    head: '<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">\n<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">',
    decision: 'Bootstrap 5.3 + Pretendard 폰트가 head.html에 로드되어 있으므로 Bootstrap 클래스(btn, card, form-control, table 등)를 활용',
  },
];

// head.html 안의 무료 CSS 스타일 킷 블록을 중복 없이 교체
export function upsertStyleKitHead(headHtml, kitId) {
  const kit = FREE_STYLE_KITS.find((k) => k.id === kitId) || FREE_STYLE_KITS[0];
  const cleaned = String(headHtml || '')
    .replace(/\n?<!-- @style-kit:start[^>]*-->[\s\S]*?<!-- @style-kit:end -->\n?/g, '\n')
    .trim();
  if (!kit.head) return cleaned ? `${cleaned}\n` : '';
  const block = `<!-- @style-kit:start:${kit.id} -->\n${kit.head}\n<!-- @style-kit:end -->`;
  return cleaned ? `${cleaned}\n${block}\n` : `${block}\n`;
}

export function detectStyleKit(headHtml) {
  const m = String(headHtml || '').match(/<!-- @style-kit:start:([a-z0-9-]+) -->/);
  return m ? m[1] : 'builtin';
}

export const THEME_PRESETS = [
  {
    id: 'indigo',
    name: '인디고 모던',
    swatches: ['#5b5bd6', '#f6f7fb', '#171923'],
    light: {
      '--bg': '#f6f7fb',
      '--surface': '#ffffff',
      '--text': '#171923',
      '--muted': '#64748b',
      '--primary': '#5b5bd6',
      '--border': '#e2e8f0',
      '--radius': '10px',
    },
    dark: {
      '--bg': '#11131a',
      '--surface': '#1a1d27',
      '--text': '#edf2f7',
      '--muted': '#94a3b8',
      '--primary': '#818cf8',
      '--border': '#2d3345',
      '--radius': '10px',
    },
  },
  {
    id: 'emerald',
    name: '에메랄드 클린',
    swatches: ['#0d9488', '#f4faf8', '#132a27'],
    light: {
      '--bg': '#f4faf8',
      '--surface': '#ffffff',
      '--text': '#132a27',
      '--muted': '#5c7672',
      '--primary': '#0d9488',
      '--border': '#d8ebe7',
      '--radius': '12px',
    },
    dark: {
      '--bg': '#0e1716',
      '--surface': '#152220',
      '--text': '#e6f4f1',
      '--muted': '#8baea9',
      '--primary': '#2dd4bf',
      '--border': '#243a37',
      '--radius': '12px',
    },
  },
  {
    id: 'sunset',
    name: '웜 선셋',
    swatches: ['#ea580c', '#fdf8f4', '#291c14'],
    light: {
      '--bg': '#fdf8f4',
      '--surface': '#ffffff',
      '--text': '#291c14',
      '--muted': '#7c6558',
      '--primary': '#ea580c',
      '--border': '#f0dfd2',
      '--radius': '12px',
    },
    dark: {
      '--bg': '#191310',
      '--surface': '#241b16',
      '--text': '#faf0e8',
      '--muted': '#b29b8d',
      '--primary': '#fb923c',
      '--border': '#3b2c24',
      '--radius': '12px',
    },
  },
  {
    id: 'slate',
    name: '미니멀 슬레이트',
    swatches: ['#2563eb', '#f8fafc', '#0f172a'],
    light: {
      '--bg': '#f8fafc',
      '--surface': '#ffffff',
      '--text': '#0f172a',
      '--muted': '#64748b',
      '--primary': '#2563eb',
      '--border': '#e2e8f0',
      '--radius': '8px',
    },
    dark: {
      '--bg': '#0f172a',
      '--surface': '#1e293b',
      '--text': '#f1f5f9',
      '--muted': '#94a3b8',
      '--primary': '#60a5fa',
      '--border': '#334155',
      '--radius': '8px',
    },
  },
];

export function applyThemeTokens(css, theme) {
  if (!theme) return css;
  let next = css || '';
  for (const [k, v] of Object.entries(theme.light || {})) next = setToken(next, 'light', k, v);
  for (const [k, v] of Object.entries(theme.dark || {})) next = setToken(next, 'dark', k, v);
  return next;
}

export function buildThemeBaseCss(theme) {
  const base = `/* 모든 영역에 공통으로 적용되는 디자인 토큰과 기본 스타일 */
body {
  background: var(--bg);
  color: var(--text);
}
`;
  return applyThemeTokens(base, theme || THEME_PRESETS[0]);
}

export const APP_TEMPLATES = [
  {
    id: 'blank',
    name: '빈 캔버스',
    desc: '아무 영역도 없는 빈 12×12 그리드로 시작합니다.',
    layout: {
      mode: 'grid',
      appPrompt: '',
      grid: { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
      regions: [],
    },
    files: {},
  },
  {
    id: 'dashboard',
    name: '📊 대시보드 앱',
    desc: '상단 헤더 + 좌측 메뉴 + 상단 요약 지표 + 메인 콘텐츠 + 우측 알림 패널',
    layout: {
      mode: 'grid',
      appPrompt: '깔끔한 현대적 대시보드 웹앱. 공통 디자인 토큰(--bg, --surface, --primary, --border, --radius)을 사용해 일관된 카드형 UI로 구성합니다.',
      grid: { cols: 12, rows: 12, gap: 10, fill: true, rowHeight: 60 },
      regions: [
        { id: 'header', title: '상단 헤더', color: '#5b5bd6', x: 0, y: 0, w: 12, h: 1 },
        { id: 'sidebar', title: '사이드 메뉴', color: '#12a594', x: 0, y: 1, w: 2, h: 11 },
        { id: 'kpi', title: '핵심 지표', color: '#0090ff', x: 2, y: 1, w: 10, h: 2 },
        { id: 'main', title: '메인 분석', color: '#8e4ec6', x: 2, y: 3, w: 7, h: 9 },
        { id: 'activity', title: '최근 활동', color: '#f76b15', x: 9, y: 3, w: 3, h: 9 },
      ],
    },
    files: {
      header: { prompt: '앱 로고, 검색 입력창, 테마/알림 버튼이 있는 상단 헤더. 검색어 입력 시 "header:search" 이벤트를 보냅니다.' },
      sidebar: { prompt: '대시보드 메뉴 목록(개요, 통계, 항목, 설정). 메뉴 클릭 시 "sidebar:navigate" 이벤트를 보냅니다.' },
      kpi: { prompt: '핵심 지표 카드 4개(총 건수, 진행률, 성장률, 활성 사용자)를 가로로 깔끔하게 배치합니다.' },
      main: { prompt: '메인 데이터 차트와 필터 가능한 목록 테이블을 구성합니다.' },
      activity: { prompt: '최근 업데이트 및 알림 피드 목록을 보여 줍니다.' },
    },
  },
  {
    id: 'workspace',
    name: '📝 2단 워크스페이스',
    desc: '상단 툴바 + 좌측 항목 목록 + 메인 편집/상세 작업공간',
    layout: {
      mode: 'grid',
      appPrompt: '생산성 중심 2단 워크스페이스 웹앱. 공통 CSS 변수(--bg, --surface, --primary, --border)를 활용합니다.',
      grid: { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
      regions: [
        { id: 'toolbar', title: '상단 툴바', color: '#5b5bd6', x: 0, y: 0, w: 12, h: 1 },
        { id: 'list', title: '항목 목록', color: '#12a594', x: 0, y: 1, w: 3, h: 11 },
        { id: 'editor', title: '작업 공간', color: '#8e4ec6', x: 3, y: 1, w: 9, h: 11 },
      ],
    },
    files: {
      toolbar: { prompt: '앱 제목, 새 항목 추가 버튼, 저장 상태 표시를 배치합니다.' },
      list: { prompt: '검색 필터와 선택 가능한 항목 리스트. 항목 클릭 시 "list:select" 이벤트를 보냅니다.' },
      editor: { prompt: '"list:select" 이벤트를 받아 선택한 항목을 편집하고 저장하는 메인 작업 공간.' },
    },
  },
  {
    id: 'form-tool',
    name: '⚡ 입력 · 결과 도구',
    desc: '상단 헤더 + 좌측 조건/입력 폼 + 우측 실시간 결과 미리보기',
    layout: {
      mode: 'grid',
      appPrompt: '입력 조건을 바꾸면 우측에 결과가 즉시 반영되는 인터랙티브 웹 도구. 공통 토큰 변수를 사용합니다.',
      grid: { cols: 12, rows: 12, gap: 10, fill: true, rowHeight: 60 },
      regions: [
        { id: 'header', title: '상단 헤더', color: '#5b5bd6', x: 0, y: 0, w: 12, h: 1 },
        { id: 'controls', title: '입력 · 설정', color: '#0090ff', x: 0, y: 1, w: 4, h: 11 },
        { id: 'result', title: '실시간 결과', color: '#46a758', x: 4, y: 1, w: 8, h: 11 },
      ],
    },
    files: {
      header: { prompt: '도구 이름과 간단한 설명, 초기화/내보내기 버튼을 배치합니다.' },
      controls: { prompt: '입력 폼과 옵션을 제공하고 값이 바뀔 때마다 app.set("input", ...) 으로 공유합니다.' },
      result: { prompt: 'app.on("state:input", ...) 를 받아 결과를 시각적으로 렌더링하고 복사/다운로드 버튼을 제공합니다.' },
    },
  },
  {
    id: 'landing',
    name: '🚀 랜딩 페이지',
    desc: '스크롤형 페이지(화면 채우기 끔): 네비게이션 + 히어로 + 기능 소개 + 문의/CTA',
    layout: {
      mode: 'grid',
      appPrompt: '세련된 제품 소개 랜딩 페이지. 여백과 타이포그래피 계층을 강조하고 공통 CSS 변수를 사용합니다.',
      grid: { cols: 12, rows: 12, gap: 12, fill: false, rowHeight: 68 },
      regions: [
        { id: 'nav', title: '상단 네비게이션', color: '#5b5bd6', x: 0, y: 0, w: 12, h: 1 },
        { id: 'hero', title: '히어로 배너', color: '#8e4ec6', x: 0, y: 1, w: 12, h: 4 },
        { id: 'features', title: '주요 기능', color: '#12a594', x: 0, y: 5, w: 12, h: 4 },
        { id: 'cta', title: '시작하기 / 문의', color: '#f76b15', x: 0, y: 9, w: 12, h: 3 },
      ],
    },
    files: {
      nav: { prompt: '브랜드 로고, 섹션 이동 링크, 주요 CTA 버튼을 배치합니다.' },
      hero: { prompt: '강렬한 헤드라인, 부제목, 시작하기 버튼과 시각적 목업 카드를 배치합니다.' },
      features: { prompt: '핵심 기능 3가지를 아이콘과 함께 3열 반응형 카드로 배치합니다.' },
      cta: { prompt: '이메일 신청/문의 폼과 간결한 푸터를 배치합니다.' },
    },
  },
];
