// OpenAI 호환 API (OpenAI, OpenRouter, LM Studio, Ollama 등) 로 영역 구현
import { SYSTEM } from './ai.js';

export const PRESETS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  lmstudio: 'http://localhost:1234/v1',
  ollama: 'http://localhost:11434/v1',
};

const trimBase = (url) => String(url || '').trim().replace(/\/+$/, '');
const isLocalHost = (base) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(base);

export function buildHeaders(apiKey = '', extra = {}) {
  const headers = { ...extra };
  const key = String(apiKey || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function call(baseUrl, pathname, init = {}, apiKey = '') {
  const base = trimBase(baseUrl);
  if (!/^https?:\/\//.test(base)) throw new Error('OpenAI 호환 서버 주소가 올바르지 않습니다 (예: https://api.openai.com/v1 또는 http://localhost:1234/v1)');
  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await fetch(base + pathname, { ...init, headers: buildHeaders(apiKey, init.headers) });
    } catch {
      throw new Error(
        isLocalHost(base)
          ? `로컬 LLM 서버(${base})에 연결하지 못했습니다. LM Studio/Ollama 서버가 켜져 있는지 확인하세요.`
          : `OpenAI 호환 API 서버(${base})에 연결하지 못했습니다. 주소와 네트워크를 확인하세요.`,
      );
    }
    if (res.status === 429 && attempt === 1) {
      const retrySec = Math.min(8, Math.max(1, Number(res.headers.get('retry-after')) || 2));
      await new Promise((r) => setTimeout(r, retrySec * 1000));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('API 키가 올바르지 않거나 없습니다. ⚙️ 설정에서 OpenAI 호환 API 키를 확인하세요.');
    if (res.status === 429) throw new Error('요청 한도(429)를 넘었습니다. 잠시 후 다시 시도하세요.');
    throw new Error(`OpenAI 호환 API 오류 (${res.status}): ${body.slice(0, 300) || res.statusText}`);
  }
  return res;
}

const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|moderation|transcribe|audio|realtime|babbage|davinci/i;

export function filterModels(ids, { freeOnly = false } = {}) {
  return (ids || [])
    .filter((id) => id && !NON_CHAT_MODEL.test(id))
    .filter((id) => !freeOnly || /:free\b/i.test(id))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((id) => ({ id, label: id }));
}

export async function listModels(baseUrl, apiKey = '', { freeOnly = false } = {}) {
  const data = await (await call(baseUrl, '/models', {}, apiKey)).json();
  return filterModels((data.data || []).map((m) => m.id), { freeOnly });
}

export async function* generate({ baseUrl, apiKey = '', model, prompt, system = SYSTEM, images = [] }) {
  if (!model) throw new Error('모델이 선택되지 않았습니다. ⚙️ 설정에서 고르세요.');
  const res = await call(baseUrl, '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true }, // 마지막 청크에 토큰 사용량 (로그용)
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        // 그림은 비전 모델만 이해한다 (그 외 모델은 서버가 오류를 낼 수 있어 설정에서 켠 경우에만 보냄)
        { role: 'user', content: images.length ? [...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } })), { type: 'text', text: prompt }] : prompt },
      ],
    }),
  }, apiKey);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = '';
  let usage = null;
  let thinking = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const chunk = JSON.parse(payload);
      if (chunk.error) throw new Error(`OpenAI 호환 API 오류: ${chunk.error.message || JSON.stringify(chunk.error)}`);
      const choice = chunk.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content || choice?.delta?.reasoning;
      // 추론(생각) 과정은 로그에만 보여주고 파일 파싱에는 쓰지 않는다
      if (reasoning) {
        if (!thinking) yield { type: 'delta', text: '💭 ' };
        thinking = true;
        yield { type: 'delta', text: reasoning };
      }
      const content = choice?.delta?.content;
      if (content) {
        if (thinking) yield { type: 'delta', text: '\n\n' };
        thinking = false;
        text += content;
        yield { type: 'delta', text: content };
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  }
  if (finish === 'length') throw new Error('출력이 모델의 최대 길이에서 잘렸습니다. 컨텍스트/최대 토큰을 늘리거나 요청을 나눠 보세요.');
  yield {
    type: 'final',
    text: text.replace(/<think>[\s\S]*?<\/think>/g, ''),
    usage: usage && { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
}
