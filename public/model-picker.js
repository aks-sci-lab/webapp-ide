// 모델 목록에서 기본으로 고를 모델 선택 (서버/편집기 공용 테스트 가능)

function geminiVersion(id) {
  const m = String(id || '').match(/gemini-(\d+)(?:\.(\d+))?/i);
  if (!m) return { major: 0, minor: 0 };
  return { major: Number(m[1]) || 0, minor: Number(m[2]) || 0 };
}

// Gemini 모델 목록에서 기본 모델 선택:
// 1) 최신 세대(major) 우선 (3.x > 2.5)
// 2) exp / lite 는 주 모델 기본값에서 후순위
// 3) 같은 세대 안에서는 정식(비 preview) 우선, 버전 높을수록 우선, flash/pro 우선
export function pickGeminiModel(models) {
  const rank = (id) => {
    const s = String(id || '').toLowerCase();
    const { major, minor } = geminiVersion(s);
    const isExp = /\bexp\b|-exp\b/.test(s);
    const isPreview = /preview/.test(s);
    const isLite = /lite/.test(s);
    const tier = /pro/.test(s) ? 3 : /flash/.test(s) ? 2 : 1;
    return [
      major,
      isExp ? 0 : 1,
      isLite ? 0 : 1,
      isPreview ? 0 : 1,
      minor,
      tier,
    ];
  };
  const cmp = (a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return b.id.localeCompare(a.id, 'en', { numeric: true });
  };
  return [...(models || [])].sort(cmp)[0]?.id || '';
}

// OpenAI 호환 목록에서 코드/UI 작업에 무난한 기본 모델 선택
export function pickOpenAiModel(models) {
  const pref = [/^gpt-5/, /^gpt-4\.1\b/, /^gpt-4o\b/, /claude-.*sonnet/, /gemini-.*flash/, /qwen.*coder/i];
  for (const re of pref) {
    const hit = (models || []).find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return models?.[0]?.id || '';
}
