// 무료 API 한도 보호기 (RPM 쿨다운 · RPD 일일 상한 · 429/503 감지 · 멀티 제공자 자동 폴백)

export const DEFAULT_FREE_MODE = {
  enabled: false,
  minIntervalSec: 4, // 호출 간 최소 간격 (초) — 무료 RPM 보호
  dailyLimit: 50, // 일일 최대 호출 수 (0 이면 무제한) — 무료 RPD 보호
  autoFallback: true, // 429/503 시 키가 설정된 다른 제공자로 자동 전환
};

export function normalizeFreeMode(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: Boolean(f.enabled),
    minIntervalSec: Math.max(0, Math.min(60, Math.round(Number(f.minIntervalSec ?? DEFAULT_FREE_MODE.minIntervalSec) || 0))),
    dailyLimit: Math.max(0, Math.min(10000, Math.round(Number(f.dailyLimit ?? DEFAULT_FREE_MODE.dailyLimit) || 0))),
    autoFallback: f.autoFallback !== false,
  };
}

export function isRateOrOverloadError(err) {
  const msg = String(err?.message || err || '');
  return /\b(429|503)\b|rate.?limit|resource.?exhausted|too many requests|한도|혼잡|과부하|overloaded|high demand/i.test(msg);
}

// 설정된 키·모델이 있는 다른 제공자 폴백 순서를 계산한다 (주 제공자 제외)
export function buildFallbackOrder(settings, primaryProvider, keyCheckers) {
  const order = ['gemini', 'local', 'cli', 'claude'];
  const out = [];
  for (const p of order) {
    if (p === primaryProvider) continue;
    if (keyCheckers[p]?.(settings)) out.push(p);
  }
  return out;
}

export class QuotaGuard {
  constructor() {
    this.lastCallAt = new Map(); // provider → timestamp(ms)
  }

  // 무료 모드 RPM 보호: 같은 제공자 호출 사이 최소 minIntervalMs 간격을 보장
  async waitCooldown(provider, minIntervalMs) {
    const ms = Number(minIntervalMs) || 0;
    if (ms <= 0) return 0;
    const now = Date.now();
    const last = this.lastCallAt.get(provider) || 0;
    const wait = Math.max(0, last + ms - now);
    this.lastCallAt.set(provider, now + wait);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return wait;
  }

  // 무료 모드 RPD 보호: 오늘 호출 수가 일일 상한에 도달하면 차단
  checkDailyCap(todayCalls, dailyLimit) {
    const cap = Number(dailyLimit) || 0;
    if (cap > 0 && todayCalls >= cap) {
      throw new Error(`🍃 무료 한도 절약 모드: 오늘 일일 호출 상한(${todayCalls}/${cap}회)에 도달했습니다. ⚙️ 설정에서 상한을 조정하거나 내일 다시 시도하세요.`);
    }
  }
}
