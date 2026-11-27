// Gemini API (REST) 로 영역 구현 — 프롬프트/출력 형식은 ai.js 와 동일
import { SYSTEM } from './ai.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function check(res) {
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const msg = body.error?.message || res.statusText;
  if (res.status === 400 && /API key/i.test(msg)) throw new Error('Gemini API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.');
  if (res.status === 429) throw new Error('Gemini 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.');
  throw new Error(`Gemini API 오류 (${res.status}): ${msg}`);
}

// 키로 쓸 수 있는 텍스트 생성 모델 목록
export async function listModels(apiKey) {
  if (!apiKey) throw new Error('Gemini API 키가 없습니다');
  const models = [];
  let pageToken = '';
  do {
    const url = `${BASE}/models?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = await (await check(await fetch(url, { headers: { 'x-goog-api-key': apiKey } }))).json();
    for (const m of data.models || []) {
      if (!m.name.includes('gemini') || !m.supportedGenerationMethods?.includes('generateContent')) continue;
      if (/embedding|image|tts|audio|live|transcribe|customtools/i.test(m.name)) continue;
      models.push({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return models;
}

// 503(일시적 트래픽 과부하) 시 짧은 재시도 및 하위 호환 모델 폴백 후보
function fallbackCandidates(model) {
  const list = [model];
  if (/^gemini-3\.\d+-flash$/i.test(model)) {
    for (const alt of ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']) {
      if (alt !== model) list.push(alt);
    }
  }
  return list;
}

export async function* generate({ apiKey, model, prompt, system = SYSTEM, images = [] }) {
  if (!apiKey) throw new Error('Gemini API 키가 없습니다. ⚙️ 설정에서 입력하세요.');
  if (!model) throw new Error('Gemini 모델이 선택되지 않았습니다. ⚙️ 설정에서 고르세요.');
  const candidates = fallbackCandidates(model);
  let res = null;
  let usedModel = model;
  let lastErr = null;
  for (const candModel of candidates) {
    for (let attempt = 1; attempt <= (candModel === model ? 2 : 1); attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('HEADERS_TIMEOUT')), 20000);
      let r;
      try {
        r = await fetch(`${BASE}/models/${encodeURIComponent(candModel)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          signal: ac.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })), { text: prompt }] }],
          }),
        });
      } catch (e) {
        if (ac.signal.aborted || /timeout|fetch failed/i.test(e?.message || '')) {
          lastErr = new Error(`Gemini(${candModel}) 응답 대기 시간 초과(서버 혼잡). 잠시 후 다시 시도하거나 다른 모델을 선택하세요.`);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (r.ok) {
        res = r;
        usedModel = candModel;
        break;
      }
      if (r.status === 503) {
        lastErr = new Error('Gemini 서버가 일시적으로 혼잡합니다(503). 잠시 후 다시 시도하세요.');
        await new Promise((ok) => setTimeout(ok, 800 * attempt));
        continue;
      }
      await check(r);
    }
    if (res) break;
  }
  if (!res) throw lastErr || new Error('Gemini 응답을 받지 못했습니다');
  if (usedModel !== model) {
    yield { type: 'delta', text: `ℹ️ (${model} 일시 혼잡(503)으로 ${usedModel} 모델로 자동 전환해 응답합니다)\n\n` };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = '';
  let usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const chunk = JSON.parse(line.slice(5));
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        if (part.text && !part.thought) {
          text += part.text;
          yield { type: 'delta', text: part.text };
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini 가 요청을 차단했습니다 (${chunk.promptFeedback.blockReason})`);
    }
  }
  if (finish === 'MAX_TOKENS') throw new Error('출력이 너무 길어 중간에 잘렸습니다. 요청을 나눠 보세요.');
  if (finish && finish !== 'STOP') throw new Error(`Gemini 응답이 중단되었습니다 (${finish})`);
  yield {
    type: 'final',
    text,
    usage: usage && { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount },
  };
}
