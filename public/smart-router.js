// 통합 수정창 스마트 라우터: 사용자의 한 줄 요청이 질문/상담인지, 레이아웃 조정인지, 요소 수정인지, 기능 추가/수정인지 자동 판별

const LAYOUT_RE = /배치|레이아웃|사이드바|넓게|좁게|넓히|좁히|키워|줄여|크기|위치|옮겨|왼쪽|오른쪽|상단|하단|위쪽|아래쪽|높이|너비|칸|그리드|나눠|합쳐|자리/;
const STYLE_ONLY_RE = /색|컬러|글꼴|폰트|배경|테두리|둥글|여백|패딩|간격/;
const QUESTION_RE = /[?？]\s*$|^(?:왜|어떻게|뭐|무엇|어디|언제|누가|혹시)\b|(?:알려\s*줘|설명해\s*줘|설명해|가능해|가능한가|될까|할까|어때|어떨까|좋을까|추천해|추천|비교해|차이|상태야|맞아|인가요|할까요|되나요|있나요|없나요|궁금|방법|어느\s*게)/;
const DIRECT_EDIT_RE = /(?:바꿔|고쳐|수정해|추가해|삭제해|지워|넣어|빼줘|만들어|적용해|변경해|키워|줄여|옮겨)\s*(?:줘|주세요|라)?$/;

export function classifySmartRequest(text, { hasInspected = false, forceMode = 'auto' } = {}) {
  const s = String(text || '').trim();
  if (!s) return { kind: 'empty', label: '' };
  if (forceMode === 'question') return { kind: 'question', label: 'AI 질문 · 진행방향 상담' };
  if (forceMode === 'auto' && QUESTION_RE.test(s) && !DIRECT_EDIT_RE.test(s)) {
    return { kind: 'question', label: 'AI 질문 · 진행방향 상담' };
  }
  if (hasInspected) return { kind: 'inspect', label: '선택한 요소 수정' };
  if (LAYOUT_RE.test(s) && !STYLE_ONLY_RE.test(s) && !/기능|버튼|추가|삭제|팝업|모달|검색|저장|채점|세특|로그인/.test(s)) {
    return { kind: 'layout', label: '화면 배치 자동 조정' };
  }
  return { kind: 'feature', label: '전체 기능·화면 자동 수정' };
}
