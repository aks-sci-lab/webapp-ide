// 작업 로그: 문제가 생겼을 때 무엇이 바뀌었고 AI 와 무엇을 주고받았는지 나중에 분석할 수 있게 남긴다.
//   logs/<날짜>/events.jsonl      — 한 줄에 하나씩: 파일·레이아웃 변경, AI 호출 요약, 요청, 오류
//   logs/<날짜>/ai/<시각>-<용도>.md — AI 에게 보낸 system/prompt 와 받은 응답 원문 전체
// API 키 같은 비밀값은 남기지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// 요청마다의 맥락(어느 API 요청에서 일어난 변경인지)을 하위 함수까지 전달
export const requestContext = new AsyncLocalStorage();

// apiKey, geminiKey, x-goog-api-key, accessToken … 처럼 이름이 key 로 끝나거나 비밀을 뜻하는 필드
const SECRET_KEY = /(key$|api[-_]?key|token|secret|password|authorization|credential)/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    // 비밀값은 문자열이다 — input_tokens 같은 숫자는 그대로 둔다
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === 'string' ? (v ? '[숨김]' : v) : redact(v)]));
  }
  return value;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d = new Date()) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
const slug = (s) => String(s || '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);

export class Logger {
  constructor(dir) {
    this.dir = dir;
    this.enabled = true;
    this.queue = Promise.resolve(); // 쓰기 순서를 지키고 동시에 같은 파일을 쓰지 않게
  }

  dayDir(d = new Date()) {
    return path.join(this.dir, day(d));
  }

  write(fn) {
    this.queue = this.queue.then(fn).catch((e) => console.error('[log]', e.message));
    return this.queue;
  }

  // 이벤트 한 줄 기록. 맥락(요청 경로, 프로젝트)을 자동으로 붙인다
  event(type, data = {}) {
    if (!this.enabled) return;
    const ctx = requestContext.getStore() || {};
    const line = JSON.stringify(redact({ ts: new Date().toISOString(), type, via: ctx.via, project: ctx.project, ...data })) + '\n';
    return this.write(async () => {
      await fs.mkdir(this.dayDir(), { recursive: true });
      await fs.appendFile(path.join(this.dayDir(), 'events.jsonl'), line, 'utf8');
    });
  }

  // AI 호출 하나를 감싸 기록: 시작 시 정보, 끝날 때 응답 원문·토큰·소요 시간·오류
  startAi({ purpose, provider, model, region, system, prompt, tier }) {
    const started = new Date();
    const file = `${clock(started)}-${slug(purpose)}${region ? '-' + slug(region) : ''}.md`;
    const rel = `${day(started)}/ai/${file}`;
    let partial = '';
    return {
      file: rel,
      delta: (t) => {
        partial += t;
      },
      finish: ({ text, usage, error } = {}) => {
        if (!this.enabled) return;
        const ms = Date.now() - started.getTime();
        const response = text ?? partial;
        const ctx = requestContext.getStore() || {};
        const md = `# AI 호출 — ${purpose}${region ? ` (${region})` : ''}

- 시각: ${started.toLocaleString('ko-KR')}
- 프로젝트: ${ctx.project || '-'}
- 요청 경로: ${ctx.via || '-'}
- 제공자 / 모델: ${provider} / ${model || '-'}${tier === 'light' ? ' (가벼운 모델)' : ''}
- 소요: ${(ms / 1000).toFixed(1)}초
- 토큰: ${usage ? `입력 ${usage.input_tokens ?? '?'} / 출력 ${usage.output_tokens ?? '?'}` : '-'}
- 결과: ${error ? `❌ 오류 — ${error}` : '✅ 응답 받음'}
- 크기: system ${system?.length ?? 0}자, prompt ${prompt.length}자, 응답 ${response.length}자

## System

\`\`\`\`text
${system || ''}
\`\`\`\`

## Prompt (보낸 내용)

\`\`\`\`text
${prompt}
\`\`\`\`

## Response (받은 원문${error ? ', 오류 전까지' : ''})

\`\`\`\`text
${response}
\`\`\`\`
`;
        this.event('ai', {
          purpose, provider, model, tier, region, ms, usage, error: error || undefined,
          promptChars: prompt.length, responseChars: response.length, file: rel,
        });
        return this.write(async () => {
          await fs.mkdir(path.join(this.dayDir(started), 'ai'), { recursive: true });
          await fs.writeFile(path.join(this.dayDir(started), 'ai', file), md, 'utf8');
        });
      },
    };
  }

  // 오래된 날짜 폴더 정리
  async prune(keepDays = 30) {
    const cutoff = day(new Date(Date.now() - keepDays * 86400000));
    try {
      for (const d of await fs.readdir(this.dir)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) await fs.rm(path.join(this.dir, d), { recursive: true, force: true });
      }
    } catch {}
  }

  async days() {
    try {
      return (await fs.readdir(this.dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    } catch {
      return [];
    }
  }

  async readEvents(d, limit = 500) {
    try {
      const lines = (await fs.readFile(path.join(this.dir, d, 'events.jsonl'), 'utf8')).trim().split('\n');
      return lines.slice(-limit).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: 'broken', raw: l };
        }
      });
    } catch {
      return [];
    }
  }

  async readAiFile(rel) {
    if (!/^\d{4}-\d{2}-\d{2}\/ai\/[^/\\]+\.md$/.test(rel)) throw new Error('잘못된 로그 경로');
    return fs.readFile(path.join(this.dir, rel), 'utf8');
  }
}

// 두 텍스트의 줄 단위 변화량 (정확한 diff 는 .history 백업과 비교)
export function lineDelta(before = '', after = '') {
  const count = (s) => {
    const m = new Map();
    for (const l of s.split('\n')) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0));
  return { added, removed };
}
